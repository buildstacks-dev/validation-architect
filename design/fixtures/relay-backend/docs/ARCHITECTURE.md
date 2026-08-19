# Relay — Architecture

## Components

- **Ingest API** (Go) — validates, authenticates (per-tenant API keys),
  assigns event IDs + idempotency keys, appends to the event log. Returns
  202 only after the append is fsync-durable. Stateless replicas.
- **Event log** (Postgres, partitioned `events` table) — the system of
  record for accepted events. Append-only; a background compactor moves
  events past retention (default 30 days) to cold storage (S3 parquet).
- **Scheduler/dispatcher** (Go daemon) — owns delivery state: computes which
  (event, subscription) pairs are due, respecting per-endpoint ordering and
  backoff timers. Leader-elected singleton per shard (Postgres advisory
  locks); failover promotes a standby within seconds.
- **Delivery workers** (Go) — pull due deliveries from the dispatcher,
  execute HTTP POSTs with HMAC signing, record outcomes. Horizontally
  scaled; any worker can deliver any tenant's traffic.
- **Management API + CLI** (`relay`) — CRUD for endpoints/subscriptions,
  delivery inspection, DLQ replay, pause/resume, secret rotation. The CLI is
  a thin client over the management API — no separate business logic.
- **Metrics endpoint** (Prometheus) — read-only projection of delivery
  state; never on any write path.

## State ownership

| State | Owner | Writers |
| --- | --- | --- |
| Accepted events (payloads) | Postgres `events` | Ingest API only |
| Subscriptions, endpoints, secrets | Postgres `config` schema | Management API only |
| Delivery attempts + outcomes | Postgres `deliveries` | Dispatcher (schedule), Workers (outcomes) |
| DLQ entries | Postgres `dlq` | Dispatcher (park), Management API (replay/skip) |
| Retry timers / due-ness | Dispatcher in-memory, rebuilt from `deliveries` on failover | Dispatcher |
| Cold archive | S3 | Compactor |

## Consistency and failure notes

- The dispatcher's in-memory schedule is a cache: on crash/failover the
  standby rebuilds it entirely from Postgres. Correctness must never depend
  on dispatcher memory.
- Worker crash mid-delivery: the attempt row is claimed with a lease;
  lease expiry returns it to due state → this is the duplicate-delivery
  window (documented at-least-once).
- Endpoint pause is a config write; the dispatcher observes it within one
  scheduling tick (≤2s). Events ingested while paused accumulate.
- Postgres is the single point of failure by design; HA via managed
  failover (~30s). Ingest returns 503 during failover — producers are
  expected to retry (documented).
- Clock skew: backoff timers use DB time (`now()`), never wall clock on
  workers, so worker clock drift cannot reorder or starve deliveries.
- Secret rotation: dual-signing window means both old+new signatures are
  sent; window expiry is a config-driven time event.

## Scale shape

~120 tenants; peak ingest ~4k events/s aggregate; the contention point is a
single hot (stream, endpoint) pair with head-of-line blocking during a
subscriber outage — the "one slow endpoint" case, not aggregate throughput.

## Deployment shape

Always-on daemon fleet, single region, rolling deploys with node drain.
CLI ships as a versioned binary; management API is versioned (v1 stable).
