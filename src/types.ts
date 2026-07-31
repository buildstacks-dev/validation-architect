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
}

export type AuditVerdict = "clean" | "clean-with-disputes" | "reservations";

/**
 * The audit-stage state machine, persisted so a crash anywhere in the loop
 * resumes exactly. Phases: an auditor run is represented by
 * `pending.to === "auditor"` (not a phase); "window" = the capped feedback
 * window after an audit report; "package" = awaiting the designer's
 * ratification-package Audit section; "done" = final CAMPAIGN-COMPLETE
 * acceptable.
 */
export interface AuditState {
  /** Audit reports produced so far (0–2). */
  iteration: number;
  phase: "window" | "package" | "done";
  /** Stakeholder turns consumed inside the current feedback window. */
  windowExchanges: number;
  findings: AuditFinding[];
  /** Latest disposition per finding id. */
  dispositions: Record<string, AuditDisposition>;
  verdict?: AuditVerdict | undefined;
}

export type ClaudeAuthMode = "subscription" | "api-key";
export type CodexAuthMode = "chatgpt" | "api-key";

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
  /** Audit-stage state machine; absent until the first gated CAMPAIGN-COMPLETE. */
  audit?: AuditState | undefined;
  /** Premature CAMPAIGN-COMPLETE rejections issued (bounded, then abort). */
  completionRejections?: number | undefined;
  /**
   * Consecutive designer turns with no relayable content (bounded, then
   * abort). A tool-call-only designer turn yields an empty result; relaying
   * "" kills the Codex side, so the orchestrator nudges instead (#lumen-1).
   */
  emptyDesignerTurns?: number | undefined;
  rambleMtimeMs?: number | undefined;
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
