# OrderFlow frontend

React, TypeScript, Vite, React Router, and TanStack Query power the warehouse UI. The app lives entirely in `frontend/`; the API, worker, and database code live in `../server/`.

## Run locally

Start the backend API on `http://127.0.0.1:3000`, then from this directory run:

```sh
npm ci
npm run dev
```

Vite proxies `/api` to the local backend. Sign in with an account created by the backend setup command. The UI shows actions according to manager, staff, and viewer roles; the backend still enforces access.

## Check changes

```sh
npm run build
npm run lint
npm run test:e2e
```

The Playwright suite uses mocked API responses to check key browser flows and does not replace the backend's PostgreSQL integration tests. Run `npm test` in `../server/` as well. The English/Vietnamese selector stores a browser preference; data entered by users and messages returned by the API are shown as provided.

## Deploy to Vercel

Set the Vercel project root directory to `frontend` and output directory to `dist`. `vercel.json` proxies `/api` to the demo Render API and handles direct SPA links. Update its API destination if the Render URL changes. Read [the deployment guide](../docs/deployment.md) for cookie, preview, storage, and release checks.
