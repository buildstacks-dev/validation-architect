# Lumen — Architecture

## Components

- **Web SPA** (React) — the only UI. Talks to the API over HTTPS/JSON.
  Stateless; all state lives server-side.
- **API service** (Node/Express) — owns all business logic: expense lifecycle,
  approval policy evaluation, batch orchestration, report generation. Twelve
  stateless replicas behind a load balancer.
- **Postgres** — the system of record. Owns: tenants, users, expenses,
  approvals, reimbursement batches, batch items, policy config, audit log.
  Single primary with a read replica used only for report exports.
- **Receipt store** (S3) — owns receipt images. Written once at upload, never
  mutated. Postgres stores the object key; S3 stores the bytes. The audit
  archive is a separate S3 bucket with object-lock retention (7 years).
- **Worker** (Node) — processes async jobs from a Postgres-backed job queue
  (`jobs` table, SKIP LOCKED): reimbursement batch execution, report
  generation, receipt archival, webhook processing.
- **Stripe** (external) — executes payouts. We store Stripe transfer IDs on
  batch items. Stripe webhooks report transfer success/failure back to the
  API, which the worker reconciles.
- **Email provider** (external, Postmark) — notifications: approval requests,
  rejections, payout confirmations. Best-effort; a lost email never blocks a
  journey.

## State ownership

| State | Owner | Writers |
| --- | --- | --- |
| Expense records, approvals, policy | Postgres | API only |
| Reimbursement batches + items | Postgres | API (create), Worker (execute/reconcile) |
| Receipt images | S3 upload bucket | API (presigned upload) |
| Audit archive | S3 archive bucket (object-lock) | Worker (archival job) |
| Payout execution | Stripe | Worker via Stripe API |
| Job queue | Postgres `jobs` table | API (enqueue), Worker (claim/complete) |

## Consistency and failure notes

- Expense state machine: `draft → submitted → approved → reimbursed`, with
  `submitted → rejected → draft` as the rework loop. Transitions are enforced
  in the API layer inside Postgres transactions.
- Batch execution is idempotent by design: each batch item carries an
  idempotency key (`batch_id:expense_id`) passed to Stripe, so a crashed and
  re-run batch job must not double-transfer. Reconciliation marks items paid
  only on Stripe webhook confirmation, not on API-call success.
- The worker and API can be down independently. Approvals continue if the
  worker is down (payouts queue up). If Postgres is down, everything is down —
  accepted single point of failure.
- Stripe can be slow/unavailable: batch items retry with exponential backoff;
  a batch stuck > 24h pages the operator.
- Report exports read the replica; they can be stale by up to ~30s. Money
  paths never read the replica.

## Deployment shape

Multi-tenant SaaS, single region, deployed via CI (GitHub Actions → ECS).
Database migrations run before API deploy. No feature flags system yet;
deploys are all-or-nothing.
