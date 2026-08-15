import {
  computeVerdict,
  parseDispositions,
  renderDispositionRecord,
  validateAuditReport,
} from "./audit.js";
import { parseMarker, stripMarkers } from "./markers.js";
import {
  auditPackageMessage,
  auditReportMessage,
  auditSectionRequiredMessage,
  auditWindowRequiredMessage,
  auditedCoreChangedMessage,
  auditorPrompt,
  corpusGateRequiredMessage,
  designerEmptyTurnNudge,
  rambleRefreshNote,
  readerReportMessage,
  readerRereviewRequiredMessage,
  readerResidueInstruction,
  readerTestRequiredMessage,
} from "./prompts.js";
import type { RambleWatcher } from "./ramble.js";
import type { Transcript } from "./transcript.js";
import type {
  AgentTurn,
  AuditorRunner,
  AuditState,
  CompletionGate,
  DesignerAgent,
  ReaderPersonaId,
  ReaderRunner,
  RunState,
  StakeholderAgent,
} from "./types.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  compileWorkspaceModel,
  workspaceModelSurfaceFingerprint,
  type WorkspaceCompilation,
} from "./workspace-compiler.js";
import { COMPILER_VERSION } from "./versions.js";
import { acceptedBundleIdentity } from "./version-compatibility.js";
import { assertRunStateVersionCompatible } from "./run-state-version.js";

const READER_PERSONAS: ReaderPersonaId[] = ["operator", "new-engineer", "coding-agent"];

/** Feedback-window cap per audit iteration, so the audit loop cannot eat the campaign budget. */
const AUDIT_WINDOW_CAP = 12;
/**
 * Reader-loop convergence threshold: after this many consecutive
 * stakeholder-ratified reader rounds, the next pass is terminal — its
 * findings are recorded in ratification-package.md, not fixed, so the loop
 * cannot livelock on minor-finding fixes that re-dirty the corpus forever
 * (observed: cormidia-rev1-20260810, 29 rounds without a byte-stable pass).
 * Mirrors the audit loop's own termination discipline (window cap, no third
 * iteration). A GATE-REFUSED verdict resets the count — blocking material
 * always returns the campaign to the strict loop.
 */
const READER_CONVERGENT_ROUNDS_FOR_RESIDUE = 2;
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
  /** Deterministic compiler injection for crash/gate tests; defaults to the workspace compiler. */
  compileModel?: (workspace: string) => WorkspaceCompilation;
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

function fingerprintCorpus(workspace: string, excludedRootEntries: ReadonlySet<string>): string {
  const root = join(workspace, "validation-design");
  const hash = createHash("sha256");
  if (!existsSync(root)) return hash.update("validation-design:missing").digest("hex");
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (dir === root && excludedRootEntries.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        hash.update(relative(root, path));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

/** Digest the whole reader-facing corpus, excluding orchestrator-owned audit output. */
export function corpusFingerprint(workspace: string): string {
  return fingerprintCorpus(workspace, new Set(["audit"]));
}

/**
 * Corpus digest minus ratification-package.md: what a terminal (residue)
 * reader pass may not touch. The package is the one artifact designed to
 * absorb post-review records — the same reasoning as auditedCoreFingerprint.
 */
export function readerCoreFingerprint(workspace: string): string {
  return fingerprintCorpus(workspace, new Set(["audit", "ratification-package.md"]));
}

/**
 * Digest only the design core that the independent auditor freezes. The
 * final package and owner views are intentionally written after audit and
 * receive their own structural + fresh-reader gates.
 */
export function auditedCoreFingerprint(workspace: string): string {
  return fingerprintCorpus(workspace, new Set(["audit", "ratification-package.md"]));
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
  assertRunStateVersionCompatible(state);
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

  /**
   * Intent grounding is selected once. Switching between a human file and
   * derived intent mid-run would make already-issued prompts and provenance
   * labels disagree, so stop before another provider call.
   */
  const intentSourceDrifted = (): boolean => {
    if (!state.intentSource) return false;
    const observed = ramble.exists() ? "human-rambling" : "derived-from-repo";
    if (observed === state.intentSource) return false;
    state.status = "aborted";
    state.statusReason =
      state.intentSource === "human-rambling"
        ? "rambling.txt was removed after kickoff; restore it before resuming"
        : "rambling.txt appeared after derived-intent kickoff; remove it before resuming, or start a fresh run to use it";
    transcript.note("orchestrator", `intent source drift rejected: expected ${state.intentSource}, observed ${observed}`);
    persist();
    return true;
  };

  const clearGate = (gate: CompletionGate) => {
    if (!state.gateRejections) return;
    delete state.gateRejections[gate];
    if (Object.keys(state.gateRejections).length === 0) state.gateRejections = undefined;
  };

  /**
   * Queue the corrective message before recording an abort. On explicit
   * resume that exact message/iteration is retried, and the gate receives a
   * fresh budget instead of immediately re-aborting on legacy attempts.
   */
  const rejectGate = (
    gate: CompletionGate,
    next: NonNullable<RunState["pending"]>,
    reason: string,
    note: string,
  ): boolean => {
    state.pending = next;
    state.gateRejections ??= {};
    const attempts = (state.gateRejections[gate] ?? 0) + 1;
    state.gateRejections[gate] = attempts;
    transcript.note("orchestrator", note);
    log(note);
    if (attempts > 2) {
      state.status = "aborted";
      state.statusReason = reason;
      // `vda resume` explicitly reopens an aborted run. Preserve `pending`
      // and reset only this exhausted gate so the correction can succeed.
      state.gateRejections[gate] = 0;
    }
    persist();
    return state.status === "aborted";
  };

  const compileCurrentModel = (): WorkspaceCompilation => {
    const compilation = deps.compileModel
      ? deps.compileModel(state.workspace)
      : compileWorkspaceModel(state.workspace, { regenerate: true });
    const nextCompilation: NonNullable<RunState["compilation"]> = {
      sourceFingerprint: compilation.source_fingerprint,
      surfaceFingerprint: compilation.surface_fingerprint,
      status: compilation.accepted ? "accepted" : "invalid",
      compilerVersion: COMPILER_VERSION,
      ...(compilation.identity ? { modelIdentity: compilation.identity } : {}),
      ...(compilation.model ? { versions: compilation.model.versions } : {}),
      diagnosticCodes: compilation.diagnostics.map((diagnostic) => diagnostic.code),
    };
    if (nextCompilation.status === "accepted" && nextCompilation.modelIdentity && nextCompilation.versions) {
      nextCompilation.acceptedBundleIdentity = acceptedBundleIdentity({
        sourceFingerprint: nextCompilation.sourceFingerprint,
        surfaceFingerprint: nextCompilation.surfaceFingerprint,
        modelIdentity: nextCompilation.modelIdentity,
        versions: nextCompilation.versions,
      });
    }
    state.compilation = nextCompilation;
    return compilation;
  };

  /** Queue a designer repair before any reader/auditor may observe the corpus. */
  const gateCorpus = (): boolean => {
    const compilation = compileCurrentModel();
    if (compilation.accepted) {
      clearGate("compiler");
      clearGate("catalog");
      clearGate("owner-docs");
      return false;
    }
    state.readerReviewFingerprint = undefined;
    const all = compilation.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map(
        (diagnostic) =>
          `${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column} ${diagnostic.concept}: ${diagnostic.message} Correction: ${diagnostic.correction}`,
      );
    // Persist the complete list in the workspace so the designer can read it
    // in slices; the environment message summarizes when the list is large.
    writeFileSync(
      join(state.workspace, "COMPILER-GATE-PROBLEMS.md"),
      `# Deterministic compiler gate — complete problem list\n\n${all.length} problem(s). The structured report is validation-design/compiler-report.json. Fix model facts by class, then emit <<REQUEST-READER-TEST>>.\n\n${all.map((p) => `- ${p}`).join("\n")}\n`,
    );
    const noteLimit = 12;
    const note =
      all.length <= noteLimit
        ? all.join("; ")
        : `${all.slice(0, noteLimit).join("; ")} … and ${all.length - noteLimit} more (full list in workspace COMPILER-GATE-PROBLEMS.md)`;
    rejectGate(
      "compiler",
      { to: "designer", text: corpusGateRequiredMessage(all) },
      "designer repeatedly failed the deterministic compiler corpus gate",
      `deterministic compiler gate rejected: ${note}`,
    );
    return true;
  };

  const runFreshReaders = async (finalOwnerReview: boolean) => {
    log(
      finalOwnerReview
        ? "running final owner-corpus reader review (3 fresh contexts)"
        : "running phase-8 reader test (3 fresh contexts)",
    );
    const reports = await Promise.all(
      READER_PERSONAS.map(async (persona) => ({
        persona,
        text: await withRetry(
          `reader ${persona}`,
          log,
          () => readers.run(persona, state.workspace),
          retryDelayMs,
        ),
      })),
    );
    for (const report of reports) {
      transcript.append({ role: `reader:${report.persona}`, text: report.text });
    }
    state.readersRan = true;
    const fingerprint = corpusFingerprint(state.workspace);
    state.readerReviewFingerprint = fingerprint;
    if (finalOwnerReview && state.audit) state.audit.finalReviewFingerprint = fingerprint;
    const residuePass =
      !finalOwnerReview &&
      !state.audit &&
      (state.readerConvergentRounds ?? 0) >= READER_CONVERGENT_ROUNDS_FOR_RESIDUE;
    if (residuePass) {
      state.readerResidueMode = true;
      state.readerReviewCoreFingerprint = readerCoreFingerprint(state.workspace);
      transcript.note(
        "orchestrator",
        `reader loop converged (${state.readerConvergentRounds} ratified rounds); serving terminal residue pass — findings are recorded in ratification-package.md, not fixed`,
      );
      log("reader loop converged; terminal residue pass served");
    }
    state.pending = {
      to: "designer",
      text: readerReportMessage(reports, finalOwnerReview) + (residuePass ? readerResidueInstruction() : ""),
    };
    clearGate("reader-test");
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
    // Persist the source before any provider call. A failed priming attempt can
    // then resume without recomputing provenance from a changed filesystem.
    if (!state.intentSource) {
      state.intentSource = ramble.exists() ? "human-rambling" : "derived-from-repo";
      transcript.note(
        "orchestrator",
        state.intentSource === "human-rambling"
          ? "product intent source: human-rambling — rambling.txt present; the human's direct voice grounds the owner seat and keeps priority"
          : "product intent source: derived-from-repo — no rambling.txt; the owner seat derives product intent from the repo's docs, README, specs, and source",
      );
    }
    ramble.prime();
    persist();
    if (intentSourceDrifted()) return state;
    log("priming stakeholder persona");
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
    if (intentSourceDrifted()) return state;
    const pending: RunState["pending"] = state.pending;
    if (!pending) throw new Error("orchestrator invariant: pending message missing");

    // A normal designer turn is checkpointed before the loop reaches this
    // transition. If model bytes or a generated view changed, compile and
    // checkpoint before the next stakeholder/auditor provider call. A crash
    // in this deterministic transition therefore resumes the same pending
    // provider message without repeating the turn that produced the edit.
    const modelDirectory = join(state.workspace, "validation-design", "model");
    if (
      existsSync(modelDirectory) &&
      state.compilation?.surfaceFingerprint !== workspaceModelSurfaceFingerprint(state.workspace)
    ) {
      const compilation = compileCurrentModel();
      transcript.note(
        "orchestrator",
        compilation.accepted
          ? `compiled model ${compilation.identity ?? "without identity"}; generated views are current`
          : `model compile recorded ${compilation.diagnostics.filter((item) => item.severity === "error").length} error(s) before the next provider turn`,
      );
      persist();
    }

    if (pending.to === "auditor") {
      const iteration: number = pending.iteration;
      const audit = state.audit ?? (state.audit = freshAuditState());
      // Record the exact continuation before the corpus gate persists a
      // designer-repair detour. A crash at that save point must resume back
      // into this auditor iteration rather than treating an empty audit
      // window as complete.
      audit.resumeIteration = iteration;
      if (gateCorpus()) {
        if (state.status === "aborted") return state;
        continue;
      }
      if (
        iteration === 1 &&
        (!state.readerReviewFingerprint || state.readerReviewFingerprint !== corpusFingerprint(state.workspace))
      ) {
        state.readerReviewFingerprint = undefined;
        audit.resumeIteration = iteration;
        const aborted = rejectGate(
          "reader-test",
          { to: "designer", text: readerRereviewRequiredMessage() },
          "designer refused to re-run readers over the corpus entering audit",
          "independent audit blocked: the current corpus was not the corpus reviewed by fresh readers",
        );
        if (aborted) return state;
        continue;
      }
      audit.resumeIteration = undefined;
      const expectedRoundOneIds = audit.findings
        .filter((finding) => finding.iteration === 1)
        .map((finding) => finding.id);
      const auditedCoreAtStart = auditedCoreFingerprint(state.workspace);
      log(`running independent audit iteration ${iteration} (fresh context)`);
      const reportText = await withRetry(
        `auditor iteration ${iteration}`,
        log,
        () => auditor.run(auditorPrompt(iteration, audit.reportProblems ?? [], state.intentSource), state.workspace),
        retryDelayMs,
      );
      transcript.append({ role: "auditor", text: reportText, note: `audit-iteration-${iteration}` });
      const validation = validateAuditReport(reportText, iteration, expectedRoundOneIds, {
        requireBlindSource:
          iteration !== 2 && existsSync(join(state.workspace, "TARGET-SNAPSHOT.md")),
      });
      if (auditedCoreFingerprint(state.workspace) !== auditedCoreAtStart) {
        validation.problems.push("audited core corpus changed while the auditor was running");
      }
      if (validation.problems.length > 0) {
        audit.reportProblems = validation.problems;
        const attempt = (state.gateRejections?.["audit-report"] ?? 0) + 1;
        deps.saveAuditFile(`audit-report-${iteration}-rejected-${attempt}.md`, reportText);
        const aborted = rejectGate(
          "audit-report",
          { to: "auditor", iteration },
          `auditor iteration ${iteration} repeatedly returned a blank or malformed report`,
          `audit iteration ${iteration} rejected: ${validation.problems.join("; ")}`,
        );
        if (aborted) return state;
        continue;
      }
      audit.reportProblems = undefined;
      clearGate("audit-report");
      deps.saveAuditFile(`audit-report-${iteration}.md`, reportText);
      audit.iteration = iteration;
      audit.auditedCoreFingerprint = auditedCoreAtStart;
      let found = validation.findings;
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
        for (const v of validation.verifications) {
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
        state.pending = { to: "designer", text: auditReportMessage(iteration, found, state.intentSource) };
      }
      persist();
      continue;
    }

    if (pending.to === "designer") {
      const checkpointedMarker = state.checkpointedDesignerMarker;
      const turn: AgentTurn = checkpointedMarker
        ? { text: "" }
        : await withRetry("designer turn", log, () => designer.send(pending.text), retryDelayMs);
      const marker = checkpointedMarker ?? parseMarker(turn.text);
      if (!checkpointedMarker) {
        transcript.append({ role: "designer", text: turn.text, marker, usage: turn.usage });
        log(`designer [${marker ?? "no-marker"}]: ${preview(turn.text)}`);
      } else {
        log(`resuming checkpointed designer marker ${checkpointedMarker}`);
      }

      // Dispositions are mutable only inside the bounded feedback window.
      // Once the verdict/package phase begins, its inputs are frozen: later
      // package or owner-doc prose cannot silently relabel a finding while
      // retaining the already-computed verdict.
      const emittedDispositions = checkpointedMarker ? [] : parseDispositions(turn.text);
      if (state.audit?.phase === "window") {
        for (const d of emittedDispositions) {
          const previous = state.audit.dispositions[d.id];
          const finding = state.audit.findings.find((candidate) => candidate.id === d.id);
          if (
            state.audit.iteration >= MAX_AUDIT_ITERATIONS &&
            (previous?.kind === "reopened" || (finding?.iteration === 2 && d.kind === "fixed"))
          ) {
            transcript.note(
              "orchestrator",
              `${d.id} terminal verifier outcome is authoritative; ignored designer disposition ${d.kind}`,
            );
            continue;
          }
          const unchanged = previous?.kind === d.kind && previous.note === d.note;
          state.audit.dispositions[d.id] = {
            kind: d.kind,
            note: d.note,
            ...(unchanged && previous?.confirmed
              ? {
                  confirmed: true,
                  ...(previous.confirmationNote ? { confirmationNote: previous.confirmationNote } : {}),
                }
              : {}),
            ...(d.kind === "disputed" &&
            unchanged &&
            previous?.arbitrated
              ? {
                  arbitrated: true,
                  ...(previous.arbitrationNote ? { arbitrationNote: previous.arbitrationNote } : {}),
                }
              : {}),
          };
        }
      } else if (state.audit && state.audit.phase !== "done" && emittedDispositions.length > 0) {
        transcript.note(
          "orchestrator",
          `ignored ${emittedDispositions.length} disposition change(s) outside the audit feedback window`,
        );
      }

      const terminalAudit = state.audit;
      const coreIsFrozen =
        terminalAudit !== undefined &&
        (terminalAudit.iteration >= MAX_AUDIT_ITERATIONS ||
          (terminalAudit.iteration === 1 &&
            terminalAudit.findings.length === 0 &&
            terminalAudit.phase !== "window"));
      if (!checkpointedMarker && coreIsFrozen && terminalAudit) {
        if (!terminalAudit.auditedCoreFingerprint) {
          // Safe migration for active pre-fingerprint state: do not bless the
          // current bytes retroactively. Restart the bounded audit over them.
          transcript.note(
            "orchestrator",
            "active audit state predates audited-core fingerprints; restarting independent audit at iteration 1",
          );
          state.audit = freshAuditState();
          state.pending = { to: "auditor", iteration: 1 };
          persist();
          continue;
        }
        if (auditedCoreFingerprint(state.workspace) !== terminalAudit.auditedCoreFingerprint) {
          const aborted = rejectGate(
            "audited-core",
            { to: "designer", text: auditedCoreChangedMessage() },
            "designer repeatedly changed the frozen core corpus after the terminal audit",
            "post-audit core mutation rejected: terminal auditor did not review the current core corpus",
          );
          if (aborted) return state;
          continue;
        }
        clearGate("audited-core");
      }

      // Provider output is durable before compilation, readers, or audit can
      // run. A crash in any following deterministic transition resumes this
      // marker and never resends the designer message that produced it.
      if (
        !checkpointedMarker &&
        (marker === "REQUEST-READER-TEST" || marker === "CAMPAIGN-COMPLETE")
      ) {
        state.checkpointedDesignerMarker = marker;
        persist();
        continue;
      }

      if (marker === "CAMPAIGN-COMPLETE") {
        state.checkpointedDesignerMarker = undefined;
        // Both catalogs and the owner-facing views are unconditional corpus
        // requirements. This check runs before every completion transition,
        // including legacy/pre-set `audit.phase = done` state.
        if (gateCorpus()) {
          if (state.status === "aborted") return state;
          continue;
        }
        if (!state.readersRan) {
          const aborted = rejectGate(
            "reader-test",
            { to: "designer", text: readerTestRequiredMessage() },
            "designer refused the reader test after repeated rejections",
            "CAMPAIGN-COMPLETE rejected: reader test has not run",
          );
          if (aborted) return state;
          continue;
        }
        if (!state.audit) {
          const fingerprint = corpusFingerprint(state.workspace);
          if (state.readerReviewFingerprint !== fingerprint) {
            // Terminal residue pass: the reviewed corpus plus a
            // ratification-package-only delta (the recorded residue) is
            // accepted as current. Any other delta disarms residue mode and
            // returns the campaign to the strict re-review loop.
            const residueOk =
              state.readerResidueMode === true &&
              state.readerReviewCoreFingerprint !== undefined &&
              state.readerReviewCoreFingerprint === readerCoreFingerprint(state.workspace);
            if (residueOk) {
              transcript.note(
                "orchestrator",
                "reader review accepted with a ratification-package-only residue delta (terminal pass rule)",
              );
              state.readerReviewFingerprint = fingerprint;
            } else {
              if (state.readerResidueMode) {
                state.readerResidueMode = undefined;
                state.readerReviewCoreFingerprint = undefined;
                state.readerConvergentRounds = 0;
                transcript.note(
                  "orchestrator",
                  "terminal residue pass violated (edits beyond ratification-package.md); strict re-review loop resumes",
                );
              }
              state.readerReviewFingerprint = undefined;
              const aborted = rejectGate(
                "reader-test",
                { to: "designer", text: readerRereviewRequiredMessage() },
                "designer refused to re-run readers after changing the reviewed corpus",
                "CAMPAIGN-COMPLETE rejected: corpus changed after its reader test",
              );
              if (aborted) return state;
              continue;
            }
          }
          clearGate("reader-test");
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
          const missing = state.audit.findings
            .filter((finding) => !state.audit?.dispositions[finding.id])
            .map((finding) => finding.id);
          const unarbitrated = state.audit.findings
            .filter((finding) => {
              const disposition = state.audit?.dispositions[finding.id];
              return disposition?.kind === "disputed" && disposition.arbitrated !== true;
            })
            .map((finding) => finding.id);
          const unconfirmed = state.audit.findings
            .filter((finding) => {
              const disposition = state.audit?.dispositions[finding.id];
              return (
                disposition !== undefined &&
                disposition.kind !== "reopened" &&
                disposition.confirmed !== true
              );
            })
            .map((finding) => finding.id);
          if (missing.length > 0 || unconfirmed.length > 0 || unarbitrated.length > 0) {
            const aborted = rejectGate(
              "audit-window",
              { to: "designer", text: auditWindowRequiredMessage(missing, unconfirmed, unarbitrated) },
              "designer repeatedly tried to close an incomplete audit feedback window",
              `audit window rejected: missing dispositions [${missing.join(", ")}], unconfirmed dispositions [${unconfirmed.join(", ")}], unarbitrated disputes [${unarbitrated.join(", ")}]`,
            );
            if (aborted) return state;
            continue;
          }
          clearGate("audit-window");
          if (state.audit.resumeIteration !== undefined) {
            const iteration = state.audit.resumeIteration;
            state.audit.resumeIteration = undefined;
            state.pending = { to: "auditor", iteration };
            persist();
            continue;
          }
          advanceFromWindow(state.audit);
          persist();
          continue;
        }
        if (state.audit.phase === "package" && !deps.auditSectionPresent()) {
          const aborted = rejectGate(
            "audit-section",
            { to: "designer", text: auditSectionRequiredMessage() },
            "designer never wrote the ratification-package Audit section",
            "CAMPAIGN-COMPLETE rejected: ratification-package.md has no Audit section",
          );
          if (aborted) return state;
          continue;
        }
        clearGate("audit-section");
        if (state.audit.phase === "package") {
          state.audit.phase = "final-review";
          await runFreshReaders(true);
          persist();
          continue;
        }
        if (state.audit.phase === "owner-docs") {
          // Legacy checkpoints used a separate authored owner-doc phase. The
          // current compiler owns those projections, so resume straight into
          // the same final fresh-reader review without another provider turn.
          state.audit.phase = "final-review";
          await runFreshReaders(true);
          persist();
          continue;
        }
        if (state.audit.phase === "final-review") {
          const fingerprint = corpusFingerprint(state.workspace);
          if (
            !state.audit.finalReviewFingerprint ||
            state.audit.finalReviewFingerprint !== fingerprint
          ) {
            transcript.note(
              "orchestrator",
              "final owner-corpus review invalidated by substantive corpus changes; re-running fresh readers",
            );
            await runFreshReaders(true);
            persist();
            continue;
          }
        }
        state.audit.phase = "done";
        state.status = "completed";
        state.pending = undefined;
        persist();
        return state;
      }
      if (marker === "REQUEST-READER-TEST") {
        state.checkpointedDesignerMarker = undefined;
        if (gateCorpus()) {
          if (state.status === "aborted") return state;
          continue;
        }
        const finalOwnerReview =
          state.audit?.phase === "owner-docs" || state.audit?.phase === "final-review";
        if (state.audit?.phase === "owner-docs") state.audit.phase = "final-review";
        if (!finalOwnerReview) {
          // Close the previous reader round for the convergence counter: a
          // stakeholder-ratified round (CONFIRMED, no GATE-REFUSED) counts
          // toward the terminal-pass threshold; a refusal resets it.
          if (state.readersRan) {
            if (state.readerRoundHadRefusal) state.readerConvergentRounds = 0;
            else if (state.readerRoundHadConfirm) {
              state.readerConvergentRounds = (state.readerConvergentRounds ?? 0) + 1;
            }
          }
          state.readerRoundHadConfirm = undefined;
          state.readerRoundHadRefusal = undefined;
        }
        await runFreshReaders(finalOwnerReview);
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
      const refreshed = state.intentSource === "human-rambling" && ramble.changed();
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
      if (!state.audit && state.readersRan) {
        // Reader-round verdict tracking for the convergence rule. Tagged
        // verdicts are canonical; the prose form ("Yes — I confirm …") is
        // accepted because live stakeholders demonstrably use it.
        if (/^\s*GATE-REFUSED\s*:/im.test(turn.text)) {
          state.readerRoundHadRefusal = true;
        } else if (/^\s*CONFIRMED\s*:/im.test(turn.text) || /\bI\s+(?:re-)?confirm\b/i.test(turn.text)) {
          state.readerRoundHadConfirm = true;
        }
      }
      if (state.audit?.phase === "window") {
        // Live stakeholders phrase rulings three ways (all observed):
        //   CONFIRMED: <rationale>              — the canonical tag
        //   **CONFIRMED — audit window closed.** — bold + em-dash blanket
        //   | AUD-101 | **CONFIRMED** |          — per-finding table row
        // A parser accepting only the first silently drops real confirmations
        // and wedges the window (cormidia-rev1, 3 confirmations unrecorded).
        // Verdict words are matched UPPERCASE-only in the loosened forms so
        // prose ("the stakeholder confirmed earlier") cannot rubber-stamp.
        const anchored = (verdict: string) =>
          new RegExp(String.raw`^[>\s]*[*_]{0,3}${verdict}[*_]{0,3}\s*(?:[:—–.-]|$)`, "m");
        const blanketConfirm =
          /^\s*CONFIRMED\s*:/im.test(turn.text) || anchored("CONFIRMED").test(turn.text);
        const blanketBlock =
          /^\s*(?:OBJECTION|GATE-REFUSED)\s*:/im.test(turn.text) ||
          anchored("OBJECTION").test(turn.text) ||
          anchored("GATE-REFUSED").test(turn.text);
        // Per-id rows carry their own authority: the id and the verdict are on
        // one line, so they apply even inside an otherwise-refusing message and
        // are not gated on the dispositions being re-presented this turn.
        const rowConfirmedIds = new Set<string>();
        for (const line of turn.text.split("\n")) {
          const idMatch = line.match(/\|\s*[*_]{0,3}(AUD-\d+)[*_]{0,3}\s*\|/);
          if (!idMatch) continue;
          const verdictMatch = line.match(/\b(CONFIRMED|OBJECTION|GATE-REFUSED)\b/);
          if (verdictMatch?.[1] === "CONFIRMED") rowConfirmedIds.add((idMatch[1] as string).toUpperCase());
        }
        // Blanket confirmation applies only to exact machine-readable
        // dispositions the stakeholder actually received, never an ID-only
        // "please confirm" summary that hides the kind or rationale.
        const confirmedIds = new Set<string>(rowConfirmedIds);
        if (blanketConfirm && !blanketBlock) {
          const presentedIds = new Set(parseDispositions(pending.text).map((disposition) => disposition.id));
          const responseIds = new Set(
            (turn.text.match(/\bAUD-\d+\b/gi) ?? []).map((id) => id.toUpperCase()),
          );
          const discussedIds =
            responseIds.size === 0
              ? presentedIds
              : new Set([...presentedIds].filter((id) => responseIds.has(id)));
          for (const id of discussedIds) confirmedIds.add(id);
        }
        for (const id of confirmedIds) {
          const disposition = state.audit.dispositions[id];
          if (!disposition || disposition.kind === "reopened") continue;
          disposition.confirmed = true;
          disposition.confirmationNote = turn.text.trim();
          transcript.note("orchestrator", `${id} disposition confirmation persisted from stakeholder CONFIRMED ruling`);
          if (disposition.kind === "disputed") {
            disposition.arbitrated = true;
            disposition.arbitrationNote = turn.text.trim();
            transcript.note("orchestrator", `${id} dispute arbitration persisted from stakeholder CONFIRMED ruling`);
          }
        }
      }
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
