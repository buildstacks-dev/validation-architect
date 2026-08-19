/**
 * The three injected ports (VA-API-002, contract D2). These are the ONLY
 * effect capabilities the headless library ever requests. Publication, branch
 * creation, process execution, credentials, approval, authorization, and
 * budget settlement are deliberately not ports.
 */

import {
  isRecord,
  requireEnum,
  requireInteger,
  requireRecord,
  requireString,
  requireStringArray,
} from "./validate.js";

/** Read-only repository facts. The test inventory is derived through these
 * reads; it is not a fourth port. */
export interface RepositoryPort {
  /** Exact commit identity of the checkout the facts come from. */
  revision(): Promise<string>;
  /** UTF-8 content, or null when the path does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Repository-relative paths matching any of the globs. */
  listFiles(globs: string[]): Promise<string[]>;
  /** Paths changed between two revisions. */
  changedPaths(base: string, head: string): Promise<string[]>;
  /** Optional append-only human-intake channel. `content: null` records that
   * the fixed source was absent at kickoff; adding/removing it later is drift. */
  intakeSnapshot?(): Promise<IntakeSnapshot>;
}

export interface IntakeSnapshot {
  sourceId: string;
  content: string | null;
  /** Stable instance identity for the fixed source (null while absent). */
  instanceId: string | null;
}

export type Seat = "designer" | "stakeholder" | "auditor" | "reader";

export interface SeatRef {
  seat: Seat;
  /** designer, stakeholder, auditor:1, reader:operator, ... */
  instance: string;
}

export type IndependenceDimension = "provider" | "model" | "session";

export interface IndependenceRequirement {
  from: SeatRef;
  dimensions: IndependenceDimension[];
}

export type SessionRequest = { mode: "new" } | { mode: "resume"; sessionId: string };

/** Structural JSON-schema-shaped object; the library validates turn output
 * against it and never trusts a host-supplied `parsed` value by presence. */
export type JsonSchema = Record<string, unknown>;

export interface TurnLimits {
  maxTokens?: number;
  maxWallMs?: number;
  /** Absolute campaign deadline. A host may use less than maxWallMs when a
   * persisted request is replayed later, but never more. */
  deadlineAtEpochMs?: number;
}

export interface TurnMetadata {
  runId: string;
  phase: string;
  turnIndex: number;
}

export interface TurnRequest {
  seat: SeatRef;
  independence: IndependenceRequirement[];
  session: SessionRequest;
  /** Stable across crash recovery; replaying it must reconcile, never spend. */
  idempotencyKey: string;
  prompt: string;
  outputSchema?: JsonSchema;
  limits: TurnLimits;
  metadata: TurnMetadata;
}

export interface ExecutionIdentity {
  /** Opaque, stable and comparable within this host. */
  provider: string;
  /** Opaque, stable and comparable within this host. */
  model: string;
  /** Exact native session identity. */
  session: string;
}

export interface TurnUsageReport {
  inputTokens: number;
  outputTokens: number;
}

export type TurnResult =
  | {
      status: "ok";
      text: string;
      /** Advisory; the library re-validates against outputSchema. */
      parsed?: unknown;
      identity: ExecutionIdentity;
      usage?: TurnUsageReport;
    }
  | {
      status: "refused" | "limit_exhausted" | "error";
      reason: string;
      /** Absent when refusal happened before assignment. */
      identity?: ExecutionIdentity;
      usage?: TurnUsageReport;
    };

/** Durable evidence returned by a reconciliation-only lookup. The lookup may
 * never initiate provider work; the settlement time lets the engine distinguish
 * a pre-deadline result from work that completed after the campaign expired. */
export interface TurnSettlement {
  result: TurnResult;
  settledAtEpochMs: number;
}

/** Campaign turns only. */
export interface TurnPort {
  /** Return a durable prior settlement for this exact request, or null. This
   * method is read-only with respect to providers and must never spend. */
  reconcileTurn(request: TurnRequest): Promise<TurnSettlement | null>;
  runTurn(request: TurnRequest): Promise<TurnResult>;
}

export const SEATS: readonly Seat[] = ["designer", "stakeholder", "auditor", "reader"];
export const INDEPENDENCE_DIMENSIONS: readonly IndependenceDimension[] = ["provider", "model", "session"];
export const TURN_RESULT_STATUSES = ["ok", "refused", "limit_exhausted", "error"] as const;

export function validateSeatRef(value: unknown, path: string, problems: string[]): void {
  if (!requireRecord(value, path, problems)) return;
  requireEnum(value.seat, `${path}.seat`, SEATS, problems);
  requireString(value.instance, `${path}.instance`, problems);
}

export function validateExecutionIdentity(value: unknown, path: string, problems: string[]): void {
  if (!requireRecord(value, path, problems)) return;
  requireString(value.provider, `${path}.provider`, problems);
  requireString(value.model, `${path}.model`, problems);
  requireString(value.session, `${path}.session`, problems);
}

function validateUsage(value: unknown, path: string, problems: string[]): void {
  if (value === undefined) return;
  if (!requireRecord(value, path, problems)) return;
  requireInteger(value.inputTokens, `${path}.inputTokens`, problems);
  requireInteger(value.outputTokens, `${path}.outputTokens`, problems);
}

export function validateTurnRequest(value: unknown, problems: string[]): void {
  const path = "turnRequest";
  if (!requireRecord(value, path, problems)) return;
  validateSeatRef(value.seat, `${path}.seat`, problems);
  if (Array.isArray(value.independence)) {
    const seenRequirements = new Set<string>();
    value.independence.forEach((item, index) => {
      const itemPath = `${path}.independence[${index}]`;
      if (!requireRecord(item, itemPath, problems)) return;
      validateSeatRef(item.from, `${itemPath}.from`, problems);
      if (isRecord(item.from) && typeof item.from.seat === "string" && typeof item.from.instance === "string") {
        const key = `${item.from.seat}:${item.from.instance}`;
        if (seenRequirements.has(key)) problems.push(`${itemPath}.from duplicates independence requirement ${key}`);
        seenRequirements.add(key);
      }
      if (
        !Array.isArray(item.dimensions) ||
        item.dimensions.length === 0 ||
        !item.dimensions.every((dimension) => (INDEPENDENCE_DIMENSIONS as readonly string[]).includes(dimension as string)) ||
        new Set(item.dimensions).size !== item.dimensions.length
      ) {
        problems.push(`${itemPath}.dimensions must be a unique non-empty subset of [${INDEPENDENCE_DIMENSIONS.join(", ")}]`);
      }
    });
  } else {
    problems.push(`${path}.independence must be an array`);
  }
  if (isRecord(value.session) && value.session.mode === "new") {
    if (value.session.sessionId !== undefined) problems.push(`${path}.session.sessionId is invalid for a new session`);
  } else if (isRecord(value.session) && value.session.mode === "resume") {
    requireString(value.session.sessionId, `${path}.session.sessionId`, problems);
  } else {
    problems.push(`${path}.session must be { mode: "new" } or { mode: "resume", sessionId }`);
  }
  requireString(value.idempotencyKey, `${path}.idempotencyKey`, problems);
  requireString(value.prompt, `${path}.prompt`, problems);
  if (value.outputSchema !== undefined && !isRecord(value.outputSchema)) {
    problems.push(`${path}.outputSchema must be an object when present`);
  }
  if (!requireRecord(value.limits, `${path}.limits`, problems)) return;
  if (value.limits.maxTokens !== undefined) requireInteger(value.limits.maxTokens, `${path}.limits.maxTokens`, problems, 1);
  if (value.limits.maxWallMs !== undefined) requireInteger(value.limits.maxWallMs, `${path}.limits.maxWallMs`, problems, 1);
  if (value.limits.deadlineAtEpochMs !== undefined) requireInteger(value.limits.deadlineAtEpochMs, `${path}.limits.deadlineAtEpochMs`, problems, 1);
  if (!requireRecord(value.metadata, `${path}.metadata`, problems)) return;
  requireString(value.metadata.runId, `${path}.metadata.runId`, problems);
  requireString(value.metadata.phase, `${path}.metadata.phase`, problems);
  requireInteger(value.metadata.turnIndex, `${path}.metadata.turnIndex`, problems, 1);
}

/** Validates the full TurnResult union. Success never happens by omission:
 * an unknown or missing status is a validation failure, not an "ok". */
export function validateTurnResult(value: unknown, problems: string[]): void {
  const path = "turnResult";
  if (!requireRecord(value, path, problems)) return;
  if (!requireEnum(value.status, `${path}.status`, TURN_RESULT_STATUSES, problems)) return;
  if (value.status === "ok") {
    if (typeof value.text !== "string") problems.push(`${path}.text must be a string`);
    validateExecutionIdentity(value.identity, `${path}.identity`, problems);
    if (value.reason !== undefined) problems.push(`${path}.reason is invalid for an ok result`);
  } else {
    requireString(value.reason, `${path}.reason`, problems);
    if (value.identity !== undefined) validateExecutionIdentity(value.identity, `${path}.identity`, problems);
    if (value.text !== undefined || value.parsed !== undefined) problems.push(`${path}.text/parsed are invalid for a non-ok result`);
  }
  validateUsage(value.usage, `${path}.usage`, problems);
}

export function validateTurnSettlement(value: unknown, problems: string[]): void {
  const path = "turnSettlement";
  if (!requireRecord(value, path, problems)) return;
  validateTurnResult(value.result, problems);
  requireInteger(value.settledAtEpochMs, `${path}.settledAtEpochMs`, problems, 1);
}

export { requireStringArray };
