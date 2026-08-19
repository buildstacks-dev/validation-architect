# Docsmith — AI Support Triage and Draft Replies

Docsmith sits inside a company's support inbox (Zendesk today). For every
incoming ticket it (1) classifies the ticket, (2) researches the answer in
the company knowledge base and account systems, and (3) drafts a reply. A
human support agent reviews the draft, edits if needed, and clicks send.
Docsmith never sends anything on its own — **every outbound reply is
human-approved before sending, no exceptions.** That rule is contractual
with our customers and is the reason risk-averse companies buy us at all.

Customers are B2B SaaS support teams (15 paying customers, ~9,000 tickets/day
aggregate). Docsmith sees customer PII and account data, and a wrong draft
that slips through review can make financial promises (refunds, discounts,
SLA credits) the company never offered. We treat quality failures as
high-consequence: the product's entire value proposition is that drafts are
trustworthy enough to mostly approve unchanged.

## The pipeline per ticket

1. **Triage (classifier).** Assigns category (billing, bug, how-to, account,
   password-reset, plan-question, other), urgency, and language. Category
   routes the ticket to a team queue and selects the drafting playbook.
   Misclassification cost is asymmetric: a billing dispute routed to how-to
   wastes hours; a how-to routed to billing wastes minutes.
2. **Research (agent loop).** An agentic loop with tools: KB search, account
   lookup (read-only), entitlements API (what plan/features/credits this
   customer actually has), prior-ticket history. The loop plans queries,
   reads results, and assembles grounded context. Budget: max 12 tool calls
   and a per-ticket token ceiling; on exhaustion it must degrade to "escalate
   to human with partial context", never loop.
3. **Draft (drafter).** Writes the reply from the researched context using
   the category playbook. Any numbers about money, credits, or entitlements
   MUST come from the entitlements API response, never from model memory.
   Tone matches the customer's configured voice profile.
4. **Check (hallucination judge).** A second model call scores the draft
   against the researched context: unsupported claims, invented policy,
   money promises not backed by entitlements. Drafts scoring below threshold
   are flagged "needs careful review" in the UI (they are still shown — the
   human is the gate either way).
5. **Review and send (human).** The support agent sees draft + citations +
   judge flags, edits or regenerates, then approves. Docsmith records the
   approval identity and the diff between draft and sent text.

## Journeys beyond the pipeline

- **Onboarding**: connect Zendesk, import KB, configure voice profile and
  playbooks, shadow mode (drafts generated but hidden) for two weeks, then
  go-live per queue.
- **Feedback loop**: sent-vs-draft diffs and agent ratings accumulate into a
  weekly quality report per category; customers use it to tune playbooks.
- **Kill switch**: a customer admin can pause Docsmith per queue instantly;
  tickets then flow untouched.

## Explicit rules

- No autonomous sending. Ever. (See above — contractual.)
- Account and entitlements access is read-only; Docsmith never mutates the
  customer's systems of record.
- PII stays within the customer's data boundary: prompts to the model
  provider are logged, redacted per the customer's redaction config.
- If any pipeline stage fails, the ticket flows to the human queue exactly
  as it would without Docsmith — degraded, never blocked.
