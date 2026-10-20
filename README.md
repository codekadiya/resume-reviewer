# Resume Reviewer

Upload a resume PDF, get structured feedback: overall score, strengths, gaps (by severity), drop-in rewrite suggestions, missing keywords and quick fixes. Optional target role / job description sharpens the review.

Node.js + Express. Text is pulled from the PDF in memory (unpdf) and sent to a model on Roar AI. The original PDF is saved to Roar file storage (S3-compatible) for 24 hours, then purged by a scheduled job.

## Run locally

```bash
npm install
ROAR_API_KEY=roar_live_... npm start
# http://localhost:3000
```

## Environment

| Variable | Required | Default |
| --- | --- | --- |
| `ROAR_API_KEY` | yes | |
| `REVIEW_MODELS` | no | `claude-haiku-5-5,gpt-6-luna` (tried in order) |
| `RATE_LIMIT_PER_HOUR` | no | `10` reviews per IP |
| `ROAR_BASE_URL` | no | `https://api.roar-ai.com/v1` (Roar injects it) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | for storage | injected by Roar file storage; storage is skipped if missing |
| `RETENTION_HOURS` | no | `24` |
| `CRON_SECRET` | for purge | injected by Roar scheduled jobs |

## Endpoints

- `GET /` web UI
- `POST /api/review` multipart: `resume` (PDF, max 5 MB), `target` (optional text)
- `GET /healthz`, `GET /api/config`
- `GET|POST /api/cron/purge-expired` deletes stored PDFs older than the retention window. Needs `Authorization: Bearer $CRON_SECRET` (Roar job runs it every 15 min). Also runs once on startup.

## Storage layout

`resumes/<uploadEpochMs>_<uuid>.pdf`, private. The review response includes a presigned link that expires with the file.
