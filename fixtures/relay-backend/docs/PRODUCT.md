# Relay — Webhook Delivery Infrastructure

Relay is webhook delivery as a service: producers (our customers' backends)
POST events to Relay, and Relay guarantees durable, retried, observable
delivery to each tenant's configured subscriber endpoints. Customers build
their own products on top of Relay's guarantee — if Relay drops or corrupts
events, *their* customers see data loss. That transitive blast radius is why
we treat Relay as high-consequence infrastructure.

There is no UI. Relay is operated entirely through a CLI (`relay`) and a
management REST API; delivery status is observable via the API and a
Prometheus metrics endpoint.

## Users

- **Tenant developer** — configures endpoints, subscriptions, and signing
  secrets; inspects delivery status; replays failed deliveries.
- **Tenant admin** — everything above plus destructive operations: endpoint
  deletion, DLQ replay, secret rotation.
- **Relay operator** (us) — runs the service, handles incidents, manages
  capacity and upgrades.

## The delivery contract (what customers pay for)

1. **Durable acceptance.** When Relay returns `202 Accepted` for an ingested
   event, that event is durably persisted. An accepted event is never
   silently dropped — it is either delivered, in retry, or parked in the
   dead-letter queue (DLQ) with a recorded reason.
2. **At-least-once delivery.** Every accepted event is delivered to every
   matching subscription at least once. Duplicates are possible (crash
   between delivery and acknowledgment); every delivery carries the event's
   stable idempotency key so consumers can dedupe.
3. **Per-endpoint ordering.** Within a single (stream, endpoint) pair,
   events are delivered in ingestion order. A failing event blocks its
   stream on that endpoint (head-of-line) until it succeeds, exhausts
   retries into the DLQ, or is manually skipped by a tenant admin.
4. **Bounded retry.** Failed deliveries retry on exponential backoff
   (configurable, default 10 attempts over ~6h), then park in the DLQ.
   DLQ replay re-enters the normal delivery path preserving order.
5. **Signed payloads.** Every delivery is HMAC-signed with the endpoint's
   secret. Secret rotation supports dual-signing overlap windows.

## Core journeys

- Ingest: producer POSTs an event batch → 202 with per-event IDs.
- Deliver: Relay POSTs to subscriber endpoints, records attempt outcomes.
- Endpoint outage: retries back off; tenant sees attempt history; DLQ after
  exhaustion; alerting webhook (meta!) fires on DLQ threshold.
- Replay: tenant admin replays DLQ entries or a time-range of delivered
  events (e.g., after a subscriber-side bug).
- Pause/resume: tenant developer pauses an endpoint (planned maintenance);
  events queue durably; resume drains in order.
- Operate: operator drains a node for deploy; in-flight deliveries complete
  or hand off; no event is lost across the drain.

## Explicit non-goals

- Exactly-once delivery. We provide at-least-once plus idempotency keys;
  consumer-side dedupe is the documented contract.
- Payload transformation. Relay delivers what was ingested, byte-identical.
- Multi-region active-active (single-region today; DR by backup restore).
