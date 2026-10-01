# OrderFlow free Render demo

This setup uses one free Render web service and an existing free Render PostgreSQL database. The API also processes CSV jobs when `EMBEDDED_WORKER=true`, so there is no separate paid worker. It is for a small demonstration: the API sleeps after inactivity, a sleeping API cannot process jobs, and a large CSV can slow down normal requests. The free database expires after 30 days and has no managed backups. Use the paid-service plan in [deployment.md](deployment.md) before relying on OrderFlow for real inventory.

Do **not** create a Blueprint from the repository's `render.yaml` for this demo. That file specifies paid API, worker, and database plans. Create a **Web Service** manually and connect it to the database you already created.

## Render web service

First publish the reviewed application code to the Git repository that Render can access. In Render, choose **New > Web Service**, select the repository, and use these settings:

| Setting | Value |
| --- | --- |
| Name | `orderflow-api-demo` (or another available name) |
| Region | The same region as the Render database; Singapore for this demo |
| Language/runtime | Docker |
| Root Directory | `server` |
| Dockerfile Path | `./Dockerfile` |
| Docker Build Context | `.` |
| Compute | Free |
| Health Check Path | `/health/ready` |
| Docker Command | Leave blank; the Dockerfile runs migrations before starting the API |

The Dockerfile's default startup command runs the idempotent migrations before the API starts. Free web services cannot use Render's pre-deploy command or dashboard shell. Migration checks also run on cold starts; this can increase the first response time. The migration script uses a database advisory lock so concurrent starts do not apply the same migration twice.

Set these environment variables on the web service. Enter credentials in Render's Environment page, not in Git or Vercel:

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `10000` |
| `DATA_DIR` | `/app/data` |
| `STORAGE_DRIVER` | `s3` |
| `EMBEDDED_WORKER` | `true` |
| `DATABASE_URL` | Render database **internal** URL; available in its Connect menu |
| `APP_ORIGIN` | Exact production Vercel URL, such as `https://your-project.vercel.app`, without a trailing slash |
| `S3_BUCKET` | Private bucket name |
| `AWS_REGION` | Bucket region code, for example `ap-southeast-2` for Sydney |
| `AWS_ACCESS_KEY_ID` | Access key for the restricted OrderFlow IAM user |
| `AWS_SECRET_ACCESS_KEY` | Matching secret access key |

`APP_ORIGIN` must match the final Vercel URL. If it changes, update the Render variable and redeploy. The S3 bucket can be in a different region from Render for this demo; use its actual region code. Do not configure public bucket access or browser-side AWS credentials.

After Render reports a successful deployment, check `https://YOUR-RENDER-HOST/health/ready`. It should report ready. Set the API HTTPS origin in `frontend/vercel.json` before deploying Vercel; this demo currently uses `https://order-flow-dz0k.onrender.com`. Configure Vercel as described in [deployment.md](deployment.md#vercel-frontend).

## Initial manager without a Render shell

The free web service has no interactive shell. On your own computer, create an ignored temporary file `server/.env.render-demo` with only this line, using the **external** Render database URL from its Connect menu:

```text
DATABASE_URL=postgresql://...external-render-url...?sslmode=require
```

Keep the real URL private. From `server/`, with dependencies installed, run:

```sh
node --env-file=.env.render-demo scripts/db.mjs status
node --env-file=.env.render-demo scripts/setup-admin.mjs manager@example.com "Initial manager"
```

The second command prompts for a password without printing it. Replace the email and name with your own. After the manager is created, delete `.env.render-demo`; it is ignored by Git but still contains a live database password while on disk. Do not use the local database URL in this file. If external access is restricted, temporarily allow only your current IP in Render's database settings, then remove that access after setup.

## What to expect

The free API may take about a minute to wake after 15 minutes without inbound traffic. CSV imports and exports can process while the API is awake. A shutdown during processing leaves a job lease; it can be retried after the API next wakes and the lease expires. Keep demo CSVs small. The S3 bucket stores files durably across API sleeps; `/app/data` is temporary scratch space.

Monitor the Render database's 30-day expiration and AWS credit expiration. Back up data you care about before either free plan ends.
