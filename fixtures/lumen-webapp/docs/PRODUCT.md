# Lumen — Team Expense Tracking

Lumen is a SaaS product for small and mid-size companies to manage employee
expenses end to end: submission, approval, reimbursement, and reporting. It is
customer-facing, holds financial records, and moves real money through Stripe
payouts. Roughly 400 companies use it in production; the largest tenant has
~2,000 employees.

## Users and roles

- **Employee** — submits expenses with receipts, tracks reimbursement status.
- **Manager** — approves or rejects expenses for their direct reports.
- **Finance admin** — configures policy, runs reimbursement batches, exports
  reports, manages the company's Stripe connection.
- **Lumen operator** (us) — operates the platform, handles support escalations.

## Core journeys

1. **Submit an expense.** Employee creates an expense (amount, category, date,
   merchant), attaches a receipt photo, submits. Draft expenses can be edited;
   submitted ones cannot.
2. **Approve.** Manager reviews pending expenses. Policy: any expense above
   $200 requires manager approval; above $2,000 it additionally requires a
   second approval from a finance admin (dual approval). At or below $200,
   expenses auto-approve on submission. Rejection returns the expense to the
   employee with a required comment.
3. **Reimburse.** Finance admin runs a reimbursement batch: all approved,
   unreimbursed expenses for the pay period are paid out via Stripe transfers
   to employee bank accounts. A batch is atomic per employee: either all of an
   employee's expenses in the batch pay out, or none do.
4. **Report and export.** Finance admin exports monthly CSV/PDF reports per
   department and per employee. Exports are read-only projections.
5. **Policy configuration.** Finance admin edits approval thresholds (within
   platform floors: the $200 manager-approval floor cannot be raised above
   $1,000), expense categories, and receipt requirements.

## Non-negotiable business rules

- Money moves exactly once per approved expense. A retried or re-run batch
  must never double-pay.
- Receipts are retained for 7 years for audit compliance (tax law). Deleting
  an expense never deletes its receipt from the audit archive.
- An expense's approval history is immutable and exportable — auditors rely
  on it.
- Tenants are strictly isolated: no cross-company data access, ever.
- Reimbursement requires a verified bank account and a completed Stripe
  onboarding for the tenant.

## Known intentions (not yet built)

- Mobile app (today: responsive web only).
- Corporate-card feed ingestion (today: manual entry only).
- Multi-currency (today: USD only).
