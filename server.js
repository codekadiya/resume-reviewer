// Resume Reviewer: upload a PDF resume, get structured feedback from a model on Roar AI.
// Needs ROAR_API_KEY. Uploaded PDFs go to Roar file storage (S3_*) and are purged after RETENTION_HOURS (default 24).
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { extractText, getDocumentProxy } from "unpdf";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { saveResume, purgeExpired, storageEnabled, RETENTION_HOURS } from "./storage.js";

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.ROAR_BASE_URL || "https://api.roar-ai.com/v1";
// Primary model first; if it errors or times out, fall back to the next one.
const MODELS = (process.env.REVIEW_MODELS || "claude-haiku-5-5,gpt-6-luna").split(",").map((s) => s.trim());
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_RESUME_CHARS = 30000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR) || 10;

const client = new OpenAI({ baseURL: BASE_URL, apiKey: process.env.ROAR_API_KEY || "missing", timeout: 90000, maxRetries: 0 });
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES, files: 1 } });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.set("trust proxy", true);
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.json({ ok: true, storage: storageEnabled, retentionHours: RETENTION_HOURS }));
app.get("/api/config", (_req, res) => res.json({ storage: storageEnabled, retentionHours: RETENTION_HOURS }));

// Called by the Roar scheduled job. Roar sends the secret as a Bearer token and in x-roar-cron-secret.
function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || process.env.ROAR_CRON_SECRET;
  if (!secret) return false;
  const sent = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || req.get("x-roar-cron-secret") || "";
  const a = Buffer.from(sent), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function runPurge(source) {
  const result = await purgeExpired();
  console.log(`purge (${source}): ${JSON.stringify(result)}`);
  return result;
}
app.all("/api/cron/purge-expired", async (req, res) => {
  if (!cronAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    res.json(await runPurge("cron"));
  } catch (err) {
    console.error("purge failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Simple in-memory per-IP limit so a single visitor can't drain the budget.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= RATE_LIMIT) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of hits) if (!ts.some((t) => now - t < 3600_000)) hits.delete(ip);
}, 600_000).unref();

const SYSTEM_PROMPT = `You are a senior recruiter and resume coach who has screened thousands of resumes.
Review the resume you are given and return ONLY a JSON object (no markdown, no commentary) with exactly this shape:
{
  "candidate_headline": string,          // one line: who this person appears to be, e.g. "Mid-level backend engineer, 5 yrs, fintech"
  "overall_score": integer 0-100,        // how ready this resume is to send out
  "verdict": string,                     // 2-3 sentences, blunt and specific
  "score_breakdown": { "impact": 0-10, "clarity": 0-10, "structure": 0-10, "ats_readiness": 0-10, "relevance": 0-10 },
  "strengths": [ { "title": string, "detail": string } ],              // 3-5 items, cite concrete evidence from the resume
  "gaps": [ { "title": string, "detail": string, "severity": "high" | "medium" | "low" } ],  // 3-6 items, most important first
  "rewrite_suggestions": [ { "section": string, "original": string, "rewrite": string, "why": string } ],  // 3-6 items
  "missing_keywords": [ string ],        // 5-10 terms a recruiter or ATS would expect for the target role
  "quick_wins": [ string ]               // 3-5 short fixes doable in under 10 minutes
}
Rules:
- "original" must be quoted verbatim (or near-verbatim) from the resume. "rewrite" must be a drop-in replacement.
- Rewrites should lead with strong verbs and quantify impact. Where the resume lacks numbers, use clear placeholders like [X%] rather than inventing figures.
- If a target role or job description is provided, judge relevance against it. Otherwise infer the most likely target role.
- Be specific to THIS resume. No generic advice that would apply to anyone.
- Never invent experience, employers, or credentials the resume does not contain.`;

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Model did not return JSON");
  }
}

async function review(resumeText, target) {
  const user = [
    target ? `TARGET ROLE / JOB DESCRIPTION:\n${target}\n` : "TARGET ROLE: not provided, infer it.\n",
    `RESUME:\n${resumeText}`,
  ].join("\n");
  let lastErr;
  for (const model of MODELS) {
    try {
      const resp = await client.chat.completions.create({
        model,
        max_tokens: 4000,
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      });
      const text = resp.choices?.[0]?.message?.content || "";
      if (!text) throw new Error(`${model} returned nothing`);
      return { model, feedback: parseJson(text) };
    } catch (err) {
      lastErr = err;
      console.error(`${model} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

app.post("/api/review", (req, res) => {
  upload.single("resume")(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === "LIMIT_FILE_SIZE" ? "That PDF is over 5 MB. Try a smaller file." : "Upload failed.";
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: "Attach a resume PDF." });
    const buf = req.file.buffer;
    if (buf.subarray(0, 5).toString() !== "%PDF-") return res.status(400).json({ error: "That file isn't a PDF." });
    if (rateLimited(req.ip)) return res.status(429).json({ error: "You've hit the hourly review limit. Try again later." });

    let text;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const out = await extractText(pdf, { mergePages: true });
      text = String(out.text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    } catch (err) {
      console.error("PDF parse failed:", err.message);
      return res.status(400).json({ error: "Couldn't read that PDF. It may be corrupted or password-protected." });
    }
    if (text.length < 200) {
      return res.status(400).json({ error: "This PDF has almost no selectable text (probably a scanned image). Export your resume as a text-based PDF and try again." });
    }

    // Keep the original PDF for the retention window. A storage hiccup must not block the review.
    let stored = null;
    try {
      stored = await saveResume(buf, req.file.originalname);
      if (stored) console.log(`stored ${stored.key} (${buf.length} bytes), expires ${stored.expiresAt}`);
    } catch (err) {
      console.error("storage save failed:", err.message);
    }

    const target = String(req.body?.target || "").slice(0, 4000).trim();
    try {
      const { model, feedback } = await review(text.slice(0, MAX_RESUME_CHARS), target);
      res.json({ model, feedback, stored: stored && { id: stored.id, uploadedAt: stored.uploadedAt, expiresAt: stored.expiresAt, url: stored.url } });
    } catch (err) {
      console.error("Review failed:", err.message);
      res.status(502).json({ error: "The reviewer is busy right now. Give it another try in a minute." });
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`resume-reviewer listening on ${PORT} (storage: ${storageEnabled ? "on" : "off"}, retention ${RETENTION_HOURS}h)`);
  // Catch anything that expired while the app was down; the scheduled job handles the rest.
  if (storageEnabled) runPurge("startup").catch((err) => console.error("startup purge failed:", err.message));
});
