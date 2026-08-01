import {
  computeVerdict,
  parseDispositions,
  parseFindings,
  parseVerifications,
  renderDispositionRecord,
} from "./audit.js";
import { workspaceCatalogProblems } from "./catalog.js";
import { parseMarker, stripMarkers } from "./markers.js";
import {
  auditPackageMessage,
  auditReportMessage,
  auditSectionRequiredMessage,
  auditorPrompt,
  catalogAgreementRequiredMessage,
  designerEmptyTurnNudge,
  rambleRefreshNote,
  readerReportMessage,
  readerTestRequiredMessage,
} from "./prompts.js";
import type { RambleWatcher } from "./ramble.js";
import type { Transcript } from "./transcript.js";
import type {
  AgentTurn,
  AuditorRunner,
  AuditState,
  DesignerAgent,
  ReaderPersonaId,
  ReaderRunner,
  RunState,
  StakeholderAgent,
} from "./types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

const READER_PERSONAS: ReaderPersonaId[] = ["operator", "new-engineer", "coding-agent"];

/** Feedback-window cap per audit iteration, so the audit loop cannot eat the campaign budget. */
const AUDIT_WINDOW_CAP = 12;
/** Hard ceiling — a run exits with verdict "reservations" rather than audit a third time. */
const MAX_AUDIT_ITERATIONS = 2;

export interface OrchestratorDeps {
  designer: DesignerAgent;
  stakeholder: StakeholderAgent;
  readers: ReaderRunner;
  auditor: AuditorRunner;
  transcript: Transcript;
  ramble: RambleWatcher;
  saveState: (state: RunState) => void;
  /** Persist an audit artifact to the run dir AND workspace validation-design/audit/. */
  saveAuditFile: (filename: string, content: string) => void;
  /** Does ratification-package.md carry an Audit section yet? (final-gate check) */
  auditSectionPresent: () => boolean;
  log: (line: string) => void;
  now?: () => number;
  /** Delay before the single retry of a failed agent turn (test hook). */
  retryDelayMs?: number;
}

export interface Kickoffs {
  designer: string;
  stakeholder: string;
}

async function withRetry<T>(
  label: string,
  log: (l: string) => void,
  fn: () => Promise<T>,
  delayMs = 5000,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log(`${label} failed (${(err as Error).message}); retrying once in ${delayMs / 1000}s`);
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
}

function preview(text: string, n = 140): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
}

function freshAuditState(): AuditState {
  return { iteration: 0, phase: "window", windowExchanges: 0, findings: [], dispositions: {} };
}

/**
 * The designer↔stakeholder loop, plus the audit stage. Driven entirely by
 * `state.pending` so a crashed or interrupted run resumes exactly where it
 * stopped: reload state, reconstruct the two sessions from their persisted
 * ids, call runCampaign again. An audit iteration in flight is persisted as
 * `pending: { to: "auditor", iteration }` — auditor sessions are ephemeral,
 * so resume simply re-runs the iteration.
 */
export async function runCampaign(
  deps: OrchestratorDeps,
  state: RunState,
  kickoffs: Kickoffs,
): Promise<RunState> {
  const { designer, stakeholder, readers, auditor, transcript, ramble, saveState, log } = deps;
  const retryDelayMs = deps.retryDelayMs ?? 5000;
  const now = deps.now ?? Date.now;
  const deadline = new Date(state.startedAt).getTime() + state.config.maxWallMinutes * 60_000;

  const persist = () => {
    state.designerSessionId = designer.sessionId();
    state.codexThreadId = stakeholder.threadId();
    state.rambleMtimeMs = ramble.lastSeenMtimeMs();
    state.seq = transcript.nextSeq();
    state.updatedAt = new Date(now()).toISOString();
    saveState(state);
  };

  /** Recorded unresolved = open or disputed; what the package message surfaces to the human. */
  const unresolvedIds = (audit: AuditState): string[] =>
    audit.findings
      .filter((f) => f.tier !== "minor")
      .filter((f) => {
        const d = audit.dispositions[f.id];
        return !d || d.kind !== "fixed";
      })
      .map((f) => f.id);

  /** Close the audit loop: compute the verdict and ask for the package's Audit section. */
  const enterPackagePhase = (audit: AuditState) => {
    audit.verdict = computeVerdict(audit);
    audit.phase = "package";
    state.pending = {
      to: "designer",
      text: auditPackageMessage(audit.verdict, audit.findings, audit.dispositions, unresolvedIds(audit)),
    };
    log(`audit loop closed: verdict ${audit.verdict}`);
  };

  /** End the current feedback window (designer done, or the 12-exchange cap hit). */
  const advanceFromWindow = (audit: AuditState) => {
    if (audit.iteration < MAX_AUDIT_ITERATIONS && audit.findings.length > 0) {
      deps.saveAuditFile(`audit-${audit.iteration}-dispositions.md`, renderDispositionRecord(audit));
      state.pending = { to: "auditor", iteration: audit.iteration + 1 };
    } else {
      enterPackagePhase(audit);
    }
  };

  if (!state.pending) {
    // Fresh run: prime the stakeholder persona, then queue the designer kickoff.
    log("priming stakeholder persona");
    ramble.prime();
    const ack: AgentTurn = await withRetry(
      "stakeholder priming",
      log,
      () => stakeholder.send(kickoffs.stakeholder),
      retryDelayMs,
    );
    transcript.append({ role: "stakeholder", text: ack.text, usage: ack.usage, note: "persona-priming" });
    state.pending = { to: "designer", text: kickoffs.designer };
    persist();
  }

  while (true) {
    if (now() > deadline) {
      state.status = "aborted";
      state.statusReason = `wall clock exceeded ${state.config.maxWallMinutes} minutes`;
      persist();
      return state;
    }
    const pending: RunState["pending"] = state.pending;
    if (!pending) throw new Error("orchestrator invariant: pending message missing");

    if (pending.to === "auditor") {
      const iteration: number = pending.iteration;
      log(`running independent audit iteration ${iteration} (fresh context)`);
      const reportText = await withRetry(
        `auditor iteration ${iteration}`,
        log,
        () => auditor.run(auditorPrompt(iteration), state.workspace),
        retryDelayMs,
      );
      transcript.append({ role: "auditor", text: reportText, note: `audit-iteration-${iteration}` });
      deps.saveAuditFile(`audit-report-${iteration}.md`, reportText);

      const audit = state.audit ?? (state.audit = freshAuditState());
      audit.iteration = iteration;
      let found = parseFindings(reportText, iteration);
      if (iteration >= 2) {
        // Iteration-2 scope rule (the convergence guarantee): new findings are
        // admissible only at blocking tier — enforced in the auditor prompt
        // AND here, so a prompt-drifting auditor cannot reopen the loop.
        const inadmissible = found.filter((f) => f.tier !== "blocking");
        if (inadmissible.length > 0) {
          transcript.note(
            "orchestrator",
            `audit iteration ${iteration}: dropped ${inadmissible.length} non-blocking new finding(s) — inadmissible in verification scope`,
          );
        }
        found = found.filter((f) => f.tier === "blocking");
        // Round-1 findings the verifier judged NOT-FIXED / REGRESSION reopen.
        for (const v of parseVerifications(reportText)) {
          if (v.verdict === "VERIFIED") continue;
          if (!audit.findings.some((f) => f.id === v.id)) continue;
          audit.dispositions[v.id] = { kind: "reopened", note: `${v.verdict}: ${v.note}` };
        }
      }
      audit.findings.push(...found);
      log(`audit iteration ${iteration}: ${found.length} finding(s) admitted`);

      if (found.length === 0 && iteration === 1) {
        // Nothing to disposition and nothing for a verifier to verify: close
        // the loop. The report generator flags a zero-finding first pass on a
        // long campaign as AUDIT-SUSPECT.
        transcript.note("orchestrator", "audit iteration 1 reported zero findings; skipping the feedback window and iteration 2");
        enterPackagePhase(audit);
      } else {
        audit.phase = "window";
        audit.windowExchanges = 0;
        state.pending = { to: "designer", text: auditReportMessage(iteration, reportText) };
      }
      persist();
      continue;
    }

    if (pending.to === "designer") {
      const turn: AgentTurn = await withRetry("designer turn", log, () => designer.send(pending.text), retryDelayMs);
      const marker = parseMarker(turn.text);
      transcript.append({ role: "designer", text: turn.text, marker, usage: turn.usage });
      log(`designer [${marker ?? "no-marker"}]: ${preview(turn.text)}`);

      // Disposition lines are honored wherever the designer emits them while
      // the audit is open (window or package phase).
      if (state.audit && state.audit.phase !== "done") {
        for (const d of parseDispositions(turn.text)) {
          state.audit.dispositions[d.id] = { kind: d.kind, note: d.note };
        }
      }

      if (marker === "CAMPAIGN-COMPLETE") {
        if (!state.readersRan) {
          // Guardrails enforce invariants: the adversarial review is not
          // optional, and a flag in the report is not a gate.
          state.completionRejections = (state.completionRejections ?? 0) + 1;
          if (state.completionRejections > 2) {
            state.status = "aborted";
            state.statusReason = "designer refused the reader test after repeated rejections";
            persist();
            return state;
          }
          transcript.note("orchestrator", "CAMPAIGN-COMPLETE rejected: reader test has not run");
          log("rejected premature CAMPAIGN-COMPLETE (no reader test yet)");
          state.pending = { to: "designer", text: readerTestRequiredMessage() };
          persist();
          continue;
        }
        if (!state.audit) {
          // Same shape as the reader gate: completion is not accepted until an
          // independent audit has run against the finished corpus.
          state.audit = freshAuditState();
          state.pending = { to: "auditor", iteration: 1 };
          transcript.note("orchestrator", "CAMPAIGN-COMPLETE gated: entering independent audit (iteration 1)");
          log("gated CAMPAIGN-COMPLETE: independent audit begins");
          persist();
          continue;
        }
        if (state.audit.phase === "window") {
          advanceFromWindow(state.audit);
          persist();
          continue;
        }
        if (state.audit.phase === "package" && !deps.auditSectionPresent()) {
          state.completionRejections = (state.completionRejections ?? 0) + 1;
          if (state.completionRejections > 2) {
            state.status = "aborted";
            state.statusReason = "designer never wrote the ratification-package Audit section";
            persist();
            return state;
          }
          transcript.note("orchestrator", "CAMPAIGN-COMPLETE rejected: ratification-package.md has no Audit section");
          log("rejected CAMPAIGN-COMPLETE (Audit section missing from ratification package)");
          state.pending = { to: "designer", text: auditSectionRequiredMessage() };
          persist();
          continue;
        }
        // Manifest ↔ markdown agreement (issue #4): when the campaign produced
        // a catalog, the machine-readable companion must exist and agree. Skip
        // when neither is present (short scripted tests that pre-set auditDone).
        if (existsSync(join(state.workspace, "validation-design", "case-catalog.md"))) {
          const catalogProblems = workspaceCatalogProblems(state.workspace);
          if (catalogProblems.length > 0) {
            state.completionRejections = (state.completionRejections ?? 0) + 1;
            if (state.completionRejections > 2) {
              state.status = "aborted";
              state.statusReason = "case-catalog.yaml does not agree with case-catalog.md";
              persist();
              return state;
            }
            transcript.note(
              "orchestrator",
              `CAMPAIGN-COMPLETE rejected: catalog agreement — ${catalogProblems.join("; ")}`,
            );
            log("rejected CAMPAIGN-COMPLETE (case-catalog manifest disagrees with the markdown catalog)");
            state.pending = { to: "designer", text: catalogAgreementRequiredMessage(catalogProblems) };
            persist();
            continue;
          }
        }
        // phase "package" with the Audit section written, or "done" (pre-set).
        state.audit.phase = "done";
        state.status = "completed";
        state.pending = undefined;
        persist();
        return state;
      }
      if (marker === "REQUEST-READER-TEST") {
        log("running phase-8 reader test (3 fresh contexts)");
        const reports = await Promise.all(
          READER_PERSONAS.map(async (p) => ({
            persona: p,
            text: await withRetry(`reader ${p}`, log, () => readers.run(p, state.workspace), retryDelayMs),
          })),
        );
        for (const r of reports) {
          transcript.append({ role: `reader:${r.persona}`, text: r.text });
        }
        // Reader round-trips don't count as exchanges: they are environment
        // services to the designer, not stakeholder conversation.
        state.readersRan = true;
        state.pending = { to: "designer", text: readerReportMessage(reports) };
        persist();
        continue;
      }
      if (marker === undefined) {
        transcript.note("orchestrator", "designer message had no protocol marker; routing to stakeholder");
      }
      if (state.audit?.phase === "window" && state.audit.windowExchanges >= AUDIT_WINDOW_CAP) {
        // The feedback window cannot eat the campaign budget: at the cap the
        // orchestrator advances the audit machine instead of relaying further.
        transcript.note(
          "orchestrator",
          `audit feedback window cap reached (${AUDIT_WINDOW_CAP} exchanges); advancing with current dispositions`,
        );
        log("audit feedback window cap reached; advancing");
        advanceFromWindow(state.audit);
        persist();
        continue;
      }
      const relayText = stripMarkers(turn.text);
      if (!relayText.trim()) {
        // A tool-call-only designer turn ends with an empty message; relaying
        // "" kills the Codex exec. Nudge the designer to speak instead —
        // bounded, so a mute designer cannot loop forever.
        state.emptyDesignerTurns = (state.emptyDesignerTurns ?? 0) + 1;
        if (state.emptyDesignerTurns > 2) {
          state.status = "aborted";
          state.statusReason = "designer produced repeated empty turns";
          persist();
          return state;
        }
        transcript.note("orchestrator", "designer turn had no relayable content; nudging designer");
        log("designer turn empty; nudging instead of relaying");
        state.pending = { to: "designer", text: designerEmptyTurnNudge() };
        persist();
        continue;
      }
      state.emptyDesignerTurns = 0;
      const refreshed = ramble.changed();
      if (refreshed) transcript.note("orchestrator", "rambling.txt changed; stakeholder told to re-read");
      state.pending = {
        to: "stakeholder",
        text: (refreshed ? rambleRefreshNote() : "") + relayText,
      };
      persist();
    } else {
      if (!pending.text.trim()) {
        // Belt-and-braces for state persisted by pre-guard versions: an empty
        // message already queued for the stakeholder reroutes as a nudge.
        transcript.note("orchestrator", "empty message was queued for stakeholder; nudging designer instead");
        state.pending = { to: "designer", text: designerEmptyTurnNudge() };
        persist();
        continue;
      }
      const turn: AgentTurn = await withRetry(
        "stakeholder turn",
        log,
        () => stakeholder.send(pending.text),
        retryDelayMs,
      );
      transcript.append({ role: "stakeholder", text: turn.text, usage: turn.usage });
      log(`stakeholder: ${preview(turn.text)}`);
      state.exchanges += 1;
      if (state.audit?.phase === "window") state.audit.windowExchanges += 1;
      if (state.exchanges >= state.config.maxExchanges) {
        state.status = "aborted";
        state.statusReason = `exchange cap reached (${state.config.maxExchanges})`;
        state.pending = { to: "designer", text: turn.text };
        persist();
        return state;
      }
      state.pending = { to: "designer", text: turn.text };
      persist();
    }
  }
}
