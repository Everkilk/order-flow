# OrderFlow

OrderFlow keeps its deployable parts separate:

| Path | Purpose |
| --- | --- |
| `frontend/` | React/Vite warehouse UI; deploy this directory to Vercel |
| `server/` | Express API, background worker, PostgreSQL migrations, and tests; deploy the API and worker to Render |
| `docs/` | System design, ERDs, database notes, and [deployment guide](docs/deployment.md) |
| `render.yaml` | Paid production Blueprint for the API, worker, and PostgreSQL; do not use it for the free demo |

For local setup and production steps, see [deployment guide](docs/deployment.md). The API and worker share a database and S3 bucket in production; the frontend calls the API through Vercel's `/api` rewrite.

For a short, low-cost test using a free Render API and database, see [free demo deployment](docs/free-demo-deployment.md).

# User stories
- As an administrator, i want to manage the account so that i can know the action is done by who

- As an administrator, i want the app can withstand a large amount of product and transaction, up to 1 million product and millions of transaction so that every action perform in the system won't be affect ( load slower or collapse)

- As an administrator, I want to fulfill a reserved order so that the inventory quantity is reduced and the action is recorded.

- As a staff memeber, i want the product management can store different product that have different type of information so that it when a new product came in we don't need to discuss to cut off any information of those product

- As a staff memeber, i want the whole app can load each action under 3 seconds so that it won't make me feel uncomfortable

- As a staff member, i want the UI of the app is easy to understand the intention / its uses, not too much things on one page and the color is comfortable to look even uder poor lighting condition so that i won't be confused and work with smoothly without asking the dev or administrator too much

- As a staff member, I want to sign in so that I can use the inventory system securely.

- As a staff member, I want to view products and their available stock so that I can decide what to reserve.

- As a staff member, I want to reserve a product quantity so that stock is held for an order.

- As a staff member, I want to cancel my reserved order so that the stock becomes available again.
