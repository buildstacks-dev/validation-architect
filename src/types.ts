export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface AgentTurn {
  text: string;
  usage?: TurnUsage;
}

/** The Claude-side designer session. One instance = one persistent session. */
export interface DesignerAgent {
  send(message: string): Promise<AgentTurn>;
  sessionId(): string | undefined;
}

/** The Codex-side stakeholder session. One instance = one persistent thread. */
export interface StakeholderAgent {
  send(message: string): Promise<AgentTurn>;
  threadId(): string | undefined;
}

export type ReaderPersonaId = "operator" | "new-engineer" | "coding-agent";

/** Runs one ephemeral fresh-context reader and returns its findings text. */
export interface ReaderRunner {
  run(persona: ReaderPersonaId, workspace: string): Promise<string>;
}

/**
 * Runs one ephemeral fresh-context audit iteration and returns its report
 * text. Like the readers, every call is a NEW session: the auditor must never
 * inherit the designer's context or see the campaign transcript.
 */
export interface AuditorRunner {
  run(prompt: string, workspace: string): Promise<string>;
}

export type AuditTier = "blocking" | "significant" | "minor";

/** One tiered finding parsed from an audit report (`AUD-xxx (tier) — …`). */
export interface AuditFinding {
  id: string;
  tier: AuditTier;
  title: string;
  /** Which audit iteration reported it (1 or 2; higher for post-hoc audits). */
  iteration: number;
}

/**
 * fixed/disputed/deferred come from designer `DISPOSITION:` lines;
 * "reopened" is set by the orchestrator when the iteration-2 auditor reports
 * a round-1 finding NOT-FIXED or REGRESSION.
 */
export type AuditDispositionKind = "fixed" | "disputed" | "deferred" | "reopened";

export interface AuditDisposition {
  kind: AuditDispositionKind;
  note: string;
  /** Stakeholder confirmed this exact kind + rationale in the feedback window. */
  confirmed?: boolean | undefined;
  /** Persisted confirmation evidence; cleared whenever the disposition changes. */
  confirmationNote?: string | undefined;
  /** A disputed disposition is not closed until the stakeholder confirms it. */
  arbitrated?: boolean | undefined;
  /** Persisted stakeholder evidence for the arbitration, so resume cannot lose it. */
  arbitrationNote?: string | undefined;
}

export type AuditVerdict = "clean" | "clean-with-disputes" | "reservations";

/**
 * The audit-stage state machine, persisted so a crash anywhere in the loop
 * resumes exactly. Phases: an auditor run is represented by
 * `pending.to === "auditor"` (not a phase); "window" = the capped feedback
 * window after an audit report; "package" = awaiting the designer's
 * ratification-package Audit section; "owner-docs" = awaiting structurally
 * valid owner-briefing.md + owner-backlog.md; "final-review" = the final
 * owner-facing corpus has been read by fresh readers and must remain
 * unchanged; "done" = final CAMPAIGN-COMPLETE acceptable.
 */
export interface AuditState {
  /** Audit reports produced so far (0–2). */
  iteration: number;
  phase: "window" | "package" | "owner-docs" | "final-review" | "done";
  /** Stakeholder turns consumed inside the current feedback window. */
  windowExchanges: number;
  findings: AuditFinding[];
  /** Latest disposition per finding id. */
  dispositions: Record<string, AuditDisposition>;
  verdict?: AuditVerdict | undefined;
  /** Problems from the latest malformed auditor response, used by a retry prompt. */
  reportProblems?: string[] | undefined;
  /** Auditor iteration interrupted by a deterministic/reader repair detour. */
  resumeIteration?: number | undefined;
  /** Fingerprint reviewed by the mandatory post-audit fresh-reader pass. */
  finalReviewFingerprint?: string | undefined;
  /** Stable core corpus read by the most recently accepted auditor pass. */
  auditedCoreFingerprint?: string | undefined;
}

export type ClaudeAuthMode = "subscription" | "api-key";
export type CodexAuthMode = "chatgpt" | "api-key";

/** How the designer kickoff scopes the campaign (issue #1). */
export type CampaignMode = "greenfield" | "revision";

/** Exact clean Git identity captured before work that consumes product source. */
export interface TargetRevision {
  commit: string;
  sourceTree: string;
  capturedAt: string;
  /** Capture helpers reject dirty trees, so a trusted revision is always clean. */
  dirty: false;
}

/**
 * Immutable product-repo revision captured when a target campaign starts.
 * The snapshot path is relative to the run workspace so state remains
 * relocatable.
 */
export interface TargetBase extends TargetRevision {
  docsTree?: string | undefined;
  snapshot: string;
}

export interface RunConfig {
  fixture: string;
  runId: string;
  designerModel: string;
  stakeholderModel: string;
  readerModel: string;
  /** Optional (absent in pre-audit state files); defaults to designerModel. */
  auditorModel?: string | undefined;
  claudeAuth: ClaudeAuthMode;
  codexAuth: CodexAuthMode;
  /** Max designer→stakeholder→designer round trips before forced stop. */
  maxExchanges: number;
  /** Wall-clock ceiling for the whole campaign, minutes. */
  maxWallMinutes: number;
  /** Max internal assistant turns per designer send (runaway guard). */
  designerMaxTurns: number;
}

export type Marker = "AWAITING-HUMAN" | "REQUEST-READER-TEST" | "CAMPAIGN-COMPLETE";

export type TranscriptRole =
  | "designer"
  | "stakeholder"
  | "orchestrator"
  | "auditor"
  | `reader:${ReaderPersonaId}`;

export interface TranscriptEntry {
  ts: string;
  seq: number;
  role: TranscriptRole;
  text: string;
  marker?: Marker | undefined;
  usage?: TurnUsage | undefined;
  note?: string | undefined;
}

export type RunStatus = "running" | "completed" | "aborted" | "failed";

/** Independent retry budgets for completion/audit gates. */
export type CompletionGate =
  | "reader-test"
  | "catalog"
  | "audit-report"
  | "audit-window"
  | "audit-section"
  | "audited-core"
  | "owner-docs";

/** Persisted after every turn so a run can be resumed after crash/auth loss. */
export interface RunState {
  runId: string;
  fixture: string;
  workspace: string;
  status: RunStatus;
  statusReason?: string | undefined;
  exchanges: number;
  seq: number;
  designerSessionId?: string | undefined;
  codexThreadId?: string | undefined;
  /**
   * The message that should be delivered next, and to whom. The auditor
   * variant carries no text: the auditor prompt is derived from the iteration
   * number, so an audit iteration interrupted mid-run re-runs on resume.
   */
  pending?:
    | { to: "designer" | "stakeholder"; text: string }
    | { to: "auditor"; iteration: number }
    | undefined;
  /** Set once the Phase-8 reader test has run; gates CAMPAIGN-COMPLETE. */
  readersRan?: boolean | undefined;
  /** Digest of the exact non-audit corpus seen by the latest reader pass. */
  readerReviewFingerprint?: string | undefined;
  /**
   * Reader-loop convergence (issue: livelock — every round's minor fixes
   * re-dirty the corpus and force another round, so the fixed point of a
   * byte-stable pass can be unreachable). Counts consecutive reader rounds
   * the stakeholder ratified (a CONFIRMED verdict, no GATE-REFUSED); at the
   * threshold the next pass is terminal: residue is recorded in
   * ratification-package.md, never fixed in the corpus.
   */
  readerConvergentRounds?: number | undefined;
  /** Verdicts observed since the last reader pass, feeding the counter. */
  readerRoundHadConfirm?: boolean | undefined;
  readerRoundHadRefusal?: boolean | undefined;
  /** The terminal residue pass was served; completion may carry a ratification-package-only delta. */
  readerResidueMode?: boolean | undefined;
  /** Corpus digest excluding ratification-package.md, captured at the terminal pass. */
  readerReviewCoreFingerprint?: string | undefined;
  /** Audit-stage state machine; absent until the first gated CAMPAIGN-COMPLETE. */
  audit?: AuditState | undefined;
  /** @deprecated Pre-0.2 shared counter; ignored so old state cannot poison a different gate. */
  completionRejections?: number | undefined;
  /** Per-gate consecutive rejection counts; a successful gate resets only itself. */
  gateRejections?: Partial<Record<CompletionGate, number>> | undefined;
  /**
   * Consecutive designer turns with no relayable content (bounded, then
   * abort). A tool-call-only designer turn yields an empty result; relaying
   * "" kills the Codex side, so the orchestrator nudges instead (#lumen-1).
   */
  emptyDesignerTurns?: number | undefined;
  rambleMtimeMs?: number | undefined;
  /**
   * Absolute path of the target product repo when the run is anchored to one
   * (issue #1). Absent for fixture runs — the test/demo path.
   */
  target?: string | undefined;
  /** Frozen target revision/source snapshot used by designer, auditor, and delivery. */
  targetBase?: TargetBase | undefined;
  /** One-time fresh-kickoff directive used when explicitly re-anchoring legacy target state. */
  sourceRecoveryDirective?: string | undefined;
  /** Kickoff scope chosen at run start; "revision" when the target already carried a corpus. */
  campaignMode?: CampaignMode | undefined;
  /** Recovery-only branch override; avoids rewriting an incompatible legacy delivery branch. */
  deliveryBranch?: string | undefined;
  /** Set once artifacts have been delivered to the target repo as a branch. */
  delivery?: {
    branch: string;
    commit: string;
    deliveredAt: string;
    /** Absent only on state files written before target revisions were pinned. */
    baseCommit?: string | undefined;
    sourceTree?: string | undefined;
    /** Exact delivered validation-design/ tree; absent on legacy state files. */
    corpusTree?: string | undefined;
  } | undefined;
  startedAt: string;
  updatedAt: string;
  config: RunConfig;
}

export interface FixtureInfo {
  name: string;
  dir: string;
  displayName: string;
  hasRambling: boolean;
}
