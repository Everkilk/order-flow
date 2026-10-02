# Shared demo setup and recovery

Prepared 2 October 2026. Hosted execution is pending. This procedure accompanies the reviewed `DEMO-V2` manifest in `server/scripts/demo-dataset.mjs`.

## Before applying

1. Verify the published frontend and backend source revisions and API readiness. The bulk-read endpoint must be available before setup.
2. Inspect Vercel, Render and AWS dashboards for current free plans, remaining allowances, spending settings, credit expiry and database expiry. Record the observations in the QA report. Stop if the $0 constraint cannot be verified.
3. Confirm the new `DEMO-V2` namespace and three account addresses are unused. Existing accounts, including deactivated accounts, are not replaced or reset by this utility.
4. Coordinate with testers so nobody edits this new collection during setup. Preserve earlier records and Admin's read state.
5. Review the dry run and expected final balances. Applying uses normal authenticated APIs, CSV validation/commit and workflow commands, never direct balance writes.

From the repository's `server` directory, a dry run is:

```powershell
npm run seed:demo
```

It requires no passwords, network access or database writes. It prints the manifest and independent expected balances.

## Private inputs and one apply

The operator supplies these environment variables privately:

| Variable | Meaning |
| --- | --- |
| DEMO_ADMIN_PASSWORD | Existing Admin password; Admin is retained |
| DEMO_STAFF_PASSWORD | User-agreed final password for staff@example.com |
| DEMO_NORTH_PASSWORD | Final password for staff.north@example.com |
| DEMO_VIEWER_PASSWORD | Final password for viewer@example.com |

All three new passwords must satisfy the existing minimum of 12 characters. Accounts are activated through the ordinary temporary-password/change-password flow and verified with their final passwords. Passwords, cookies and database/AWS credentials must not appear in logs, checkpoints, committed documents or frontend files.

An operator may prepare a private `server/.env.demo.local` containing these variables. It is ignored by Git. Do not print its contents. This file does not need DATABASE_URL or AWS keys: hosted setup uses the existing website's API and storage configuration.

After the capacity gate is recorded, execute once from `server`:

```powershell
node --env-file=.env.demo.local scripts/seed-demo.mjs --apply --dataset=DEMO-V2 --target=https://order-flow-khaki-phi.vercel.app --checkpoint=.demo-state/DEMO-V2.json --free-tier-confirmed
```

The flag records an operator decision; it does not inspect provider billing. Keep the same checkpoint throughout this collection's setup. The target is restricted to the known demo origin or localhost. Do not run simultaneous copies.

## Bounds and evidence

The initial setup plus hosted verification has a ceiling of 1,000 explicit API requests, eight CSV tasks, 256 KiB per uploaded file, 2 MiB of uploaded data and 60 minutes before reassessment. The script counts requests and enforces its cumulative hosted request ceiling across resumes. Count subsequent browser/API checks separately against the remaining initial budget; stop before it is exhausted.

The local interrupted/resumed rehearsal used **812 cumulative requests**, **seven CSV tasks** and **24,210 uploaded bytes**. Seven tasks means three imports and four exports; validating and committing each import creates separate background work, so this is **ten background jobs**. Hosted polling may increase requests. Builds, provider health checks, notification streams and normal visitors also consume provider capacity. Application request ceilings do not guarantee a $0 bill.

The script downloads all four exports, checks their contents and numeric presentation, and records nonsecret byte counts and SHA-256 hashes. It verifies account activation, roles, warehouse restrictions, final document states, all 180 balances, transfer transit/quarantine/discrepancies and inventory ledger sums. It marks Staff's existing workflow alerts read before creating the four exports, then verifies later export alerts remain unread. Admin's alerts are retained.

The nonsecret checkpoint includes target, manifest hash, completed steps, IDs, command keys, record fingerprints, request/file counters and independent expected balances. Keep the execution checkpoint private locally even though it has no passwords. Copy only the reviewed ID/status/balance manifest and summary to the QA deliverables after success. Close test tabs and sessions; do not create keepalive traffic.

## Recovery decisions

| Situation | Required response |
| --- | --- |
| Controlled interruption between completed steps | Inspect the checkpoint, confirm no `pending` operation, recheck capacity and rerun with the same target/manifest/checkpoint/private inputs. Completed steps are reused. |
| Active import/export times out | Keep its existing job ID. Inspect that job and worker result. Stop polling at a terminal state; do not re-upload or request another export merely because a response was delayed. |
| Checkpoint has `pending` | Automatic replay stops before network access. Determine whether the original action committed. Review its original ID, idempotency/commit key, document revision and related stock/ledger effects. Reconcile the completed result and fingerprints in a reviewed recovery step before clearing the marker. Never simply delete it and rerun. |
| Login/activation uncertain | Inspect the existing account and ordinary sign-in/password-change state using private inputs. Do not replace its password or recreate the account automatically. |
| Namespace/account collision | Stop and resolve with the user. Do not overwrite, adopt or reset unrelated records. |
| Tester changed a saved record | Stop. Preserve the tester's work. Use an agreed new namespace/batch or a reviewed normal workflow correction. |
| Insufficient free capacity or expired database | Stop hosted mutations. Report the actual provider condition. Preserve artifacts/checkpoint and agree an option consistent with the user's $0 requirement. |
| Failed deployment | Repair the source or restore compatible frontend/backend revisions. Do not delete seeded inventory/history to roll back a release. |

Read-only verification during a completed rerun can stop if testers have edited data, consumed the later unread notifications, or an export has expired. That stop is evidence of changed shared state, not permission to reset it. Do not use repeated seed runs as routine monitoring.

## Expand later

Review a new bounded manifest and namespace. Recalculate expected balances independently, test ownership and unit precision, rehearse in an isolated local database and recheck current provider capacity before applying. Preserve the original collection and its history. The website gains no new product-count restriction from this setup process.
