# Resume Reviewer

Upload a resume PDF, get structured feedback: overall score, strengths, gaps (by severity), drop-in rewrite suggestions, missing keywords and quick fixes. Optional target role / job description sharpens the review.

Node.js + Express. Text is pulled from the PDF in memory (unpdf) and sent to a model on Roar AI. Nothing is stored.

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
| `ROAR_BASE_URL` | no | `https://api.roar-ai.com/v1` |

## Endpoints

- `GET /` web UI
- `POST /api/review` multipart: `resume` (PDF, max 5 MB), `target` (optional text)
- `GET /healthz`
