# Docsmith — Architecture

## Components

- **Ingest webhook service** (Python/FastAPI) — receives Zendesk ticket
  events, dedupes (Zendesk redelivers), enqueues pipeline jobs. Stateless.
- **Pipeline orchestrator** (Python, Celery on Redis) — runs the four-stage
  pipeline per ticket as a job chain; owns stage state, retries, and the
  per-ticket budget ledger (tool calls, tokens, wall time).
- **Model gateway** — the single chokepoint for all LLM calls. Owns: provider
  routing (primary Anthropic, fallback OpenAI), per-customer redaction
  before egress, prompt/response logging, token accounting, timeout and
  malformed-output retry policy. No component calls a provider directly.
- **KB index** (per-customer Postgres + pgvector) — embedded knowledge base
  chunks; rebuilt on KB import, incrementally updated on article change
  events. Owned by the indexer worker.
- **Draft store** (Postgres) — tickets, stage outputs, drafts, judge scores,
  citations, approval records, sent diffs. System of record for everything
  Docsmith produces.
- **Zendesk app** (UI) — the review surface inside Zendesk: draft, citations,
  judge flags, approve/edit/regenerate. Talks to our API; approval writes
  the approval record before the reply is pushed to Zendesk as the sent text.
- **Customer systems** (external, read-only): Zendesk API, customer KB
  sources, account API, entitlements API.
- **Model providers** (external): Anthropic (primary), OpenAI (fallback).
  Fallback is per-call-site configuration, not automatic mid-ticket.

## LLM call sites (the model-mediated surface)

| Site | Kind | Output contract |
| --- | --- | --- |
| Classifier | single call | JSON: category enum, urgency enum, language, confidence |
| Research loop | agentic (≤12 tool calls) | tool-call sequence + assembled context bundle with source citations |
| Drafter | single call | reply text + per-claim citation map |
| Hallucination judge | single call (LLM-as-judge) | JSON: per-claim support verdicts, overall score 0–100, flag reasons |

Judge threshold today: score < 70 ⇒ "needs careful review" flag. The
threshold was picked by eyeballing two weeks of shadow-mode output at launch.
The judge's own precision/recall has never been measured — there is no
seeded-defect set, and nobody knows its false-negative rate on money claims.

## State ownership

| State | Owner | Writers |
| --- | --- | --- |
| Ticket + stage state, budget ledger | Draft store | Orchestrator only |
| Drafts, judge scores, approvals, diffs | Draft store | Orchestrator (drafts/scores), Zendesk app API (approvals) |
| KB chunks + embeddings | KB index | Indexer worker only |
| Prompt/response logs (redacted) | Model gateway log store | Gateway only |
| Sent replies | Zendesk (external SoR) | Zendesk app API on approval |

## Consistency and failure notes

- Zendesk redelivers webhooks: ingest dedupe is by (ticket_id, event_id);
  a missed dedupe re-runs the pipeline and produces a second draft — the UI
  shows the latest draft only, but both are stored.
- Provider outage: gateway retries (2x, jittered), then per-site fallback if
  configured, else the stage fails ⇒ ticket degrades to human queue. A
  fallback draft is marked with its provider+model for the quality report.
- Budget exhaustion mid-research: assemble partial context, mark
  "escalated: budget", skip drafting only if context is empty.
- Judge outage: drafts flow with an explicit "unchecked" flag (never a
  silent green) — the human gate is unchanged.
- Redaction runs before every egress; a redaction-config load failure fails
  closed (no call leaves).
- KB reindex races article edits: index versions are monotonic; the research
  loop records the index version it read (staleness is diagnosable).

## Deployment shape

Multi-tenant SaaS, always-on, single region. Shadow mode per queue is the
rollout mechanism. Nightly batch: quality report aggregation per customer.
