# OrderFlow API walkthrough

Run `npm run db:migrate` and `npm run setup:admin`, then start the API with
`npm run dev`. The examples use `curl.exe` from PowerShell. Replace the email
and password with the manager account. If `APP_ORIGIN` is set, send that exact
origin for write requests.

```powershell
$base = 'http://127.0.0.1:3000'
$origin = 'http://localhost:3000'
curl.exe -c cookies.txt -H 'Content-Type: application/json' -H "Origin: $origin" `
  -d '{"email":"manager@example.com","password":"your-password"}' `
  "$base/api/auth/login"
```

The response includes the manager's ID, role, and password-change flag.
`cookies.txt` holds the session cookie. If `mustChangePassword` is true,
call `POST /api/auth/change-password` and sign in again.

Create a category and unit, then use their returned IDs to create a product:

```powershell
curl.exe -b cookies.txt -H 'Content-Type: application/json' -H "Origin: $origin" `
  -d '{"name":"Hand tools"}' "$base/api/categories"

curl.exe -b cookies.txt -H 'Content-Type: application/json' -H "Origin: $origin" `
  -d '{"code":"EA","name":"Each","decimalPlaces":0}' "$base/api/units"

# Replace categoryId and unitId with the returned values.
curl.exe -b cookies.txt -H 'Content-Type: application/json' -H "Origin: $origin" `
  -d '{"sku":"HAMMER-001","name":"Claw hammer","categoryId":"1","unitId":"1","attributes":{},"sellingPrice":"12.5000","sellingCurrency":"USD"}' `
  "$base/api/products"
```

Product creation returns HTTP 201 with a string ID and exact price string.
A duplicate SKU returns HTTP 409 with `error.code: "DUPLICATE_VALUE"`.
An invalid category, unit, attribute, or price pair returns a 4xx JSON error.
Read the product with `GET /api/products/:id` or search with
`GET /api/products?q=HAMMER-001&limit=50`. Keep decimal amounts and bigint
IDs as strings in clients.

The request enters `catalogRoutes` in `src/catalog.ts`. The route validates
the JSON, checks the manager session, and opens a database transaction. It
checks the category and unit, loads the category's attribute definitions,
validates the values, inserts the product with parameterized SQL, and records
an audit event. PostgreSQL checks uniqueness, foreign keys, money
constraints, and attribute rules before commit. A failure rolls back both
inserts. `src/errors.ts` turns expected failures into stable JSON errors.

For inventory actions, create a draft document, save its lines with
`expectedRevision`, then send the action with a new UUID in the
`Idempotency-Key` header. Retry a lost response with the same key.
`POST /api/orders/:id/confirm` reserves all lines in one transaction.
`GET /api/stock` shows on-hand, reserved, and available quantities;
`GET /api/movements` shows append-only history. See [README.md](README.md)
for document, import, export, report, and evidence routes.
