# Corpus index — Operon

Snapshot of the Operon repository's ratified documentation at commit
`5bea926` (2026-07-31), the commit that froze the legacy validation surface.
This mirrors the repo layout:

- `README.md` — product view: status, commands, observability, known limitations
- `AGENTS.md` — platform-development rules (root rulebook)
- `TASTE.md` · `roles.yaml` · `pipelines.yaml` — human-ratified org templates and protocol surfaces
- `apps.yaml` — registered apps (sandbox targets alpha/beta among them)
- `docs/PURPOSE.md` — the decision log; its Decided section is ratified truth (v2.9 is the validation-rebuild decision)
- `docs/VISION.md` · `docs/architecture.md` · `docs/DEVELOPMENT.md` — operator outcome, system map, development lifecycle
- `docs/<subsystem>/` — one folder per subsystem; `design.md` (or `contract.md`) is that folder's contract: loop, scheduler, approvals, episodes, qualification, harness, org, learning-loop, live-ui, reporting, narrative

Deliberately absent: the legacy test suite, eval/qualification machinery, and
`docs/testing/` — all frozen in the repo under `archive-do-not-read/` per the
2026-07-31 clean-slate decision (PURPOSE v2.9). This campaign designs the
replacement unanchored from the incumbent suite; do not ask for the old
suite's contents. Note the qualification docs carry a status banner: the
*contract* remains canonical record, its *machinery* is archived and release
gating is suspended.
