// Roar AI file storage (S3-compatible). Uploaded resumes are kept for RETENTION_HOURS, then purged.
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

export const RETENTION_HOURS = Number(process.env.RETENTION_HOURS) || 24;
const RETENTION_MS = RETENTION_HOURS * 3600_000;
const PREFIX = "resumes/";
const BUCKET = process.env.S3_BUCKET;

export const storageEnabled = Boolean(BUCKET && process.env.S3_ENDPOINT);

const s3 = storageEnabled
  ? new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || "auto",
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    })
  : null;

// Key embeds the upload time so purge can work from the name alone if LastModified is ever missing.
export async function saveResume(buffer, originalName) {
  if (!s3) return null;
  const uploadedAt = new Date();
  const id = randomUUID();
  const key = `${PREFIX}${uploadedAt.getTime()}_${id}.pdf`;
  const safeName = String(originalName || "resume.pdf").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "application/pdf",
    ContentDisposition: `inline; filename="${safeName}"`,
    Metadata: { "original-name": safeName, "uploaded-at": uploadedAt.toISOString() },
  }));
  const expiresAt = new Date(uploadedAt.getTime() + RETENTION_MS);
  // Presigned link lives exactly as long as the file does.
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: Math.floor(RETENTION_MS / 1000) });
  return { id, key, uploadedAt: uploadedAt.toISOString(), expiresAt: expiresAt.toISOString(), url };
}

function uploadTime(obj) {
  const fromName = Number(obj.Key.slice(PREFIX.length).split("_")[0]);
  if (Number.isFinite(fromName) && fromName > 0) return fromName;
  return obj.LastModified ? new Date(obj.LastModified).getTime() : Date.now();
}

// Deletes every stored resume older than the retention window. Returns counts for logging.
export async function purgeExpired() {
  if (!s3) return { enabled: false, scanned: 0, deleted: 0 };
  const cutoff = Date.now() - RETENTION_MS;
  let token, scanned = 0, deleted = 0, kept = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    const items = page.Contents || [];
    scanned += items.length;
    const expired = items.filter((o) => uploadTime(o) < cutoff).map((o) => ({ Key: o.Key }));
    kept += items.length - expired.length;
    for (let i = 0; i < expired.length; i += 1000) {
      const batch = expired.slice(i, i + 1000);
      const res = await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: batch, Quiet: true } }));
      deleted += batch.length - (res.Errors?.length || 0);
      for (const e of res.Errors || []) console.error(`purge failed for ${e.Key}: ${e.Message}`);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { enabled: true, scanned, deleted, kept };
}
