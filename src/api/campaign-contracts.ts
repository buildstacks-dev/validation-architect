/**
 * Campaign envelope, checkpoint (`validation-architect/design-run/v1`),
 * provenance (`validation-architect/provenance/v1`), and design bundle
 * contracts (VA-API-002). WS3 (#16) implements the behavior; this module owns
 * the shapes and runtime validators.
 */

import type { CriticalityTier } from "../model.js";
import type { AuditTier } from "../types.js";
import { validateAgainstSchema } from "./json-schema.js";
import {
  INDEPENDENCE_DIMENSIONS,
  SEATS,
  validateExecutionIdentity,
  validateSeatRef,
  validateTurnRequest,
  type IndependenceRequirement,
  type JsonSchema,
  type SeatRef,
  type TurnRequest,
  type ExecutionIdentity,
  type TurnUsageReport,
} from "./ports.js";
import {
  isRecord,
  requireArray,
  requireEnum,
  requireInteger,
  requireRecord,
  requireSafePath,
  requireString,
  requireStringArray,
} from "./validate.js";

export const DESIGN_RUN_SCHEMA = "validation-architect/design-run/v1";
export const PROVENANCE_SCHEMA = "validation-architect/provenance/v1";
/** No individual provider invocation may receive more than one hour, even
 * when more total campaign wall remains. */
export const MAX_PROVIDER_TURN_WALL_MS = 60 * 60_000;

export type ProfileTier = CriticalityTier;
export const PROFILE_TIERS: readonly ProfileTier[] = ["C0", "C1", "C2", "C3", "C4"];

/** One declared seat instance with its session lifecycle and independence. */
export interface EnvelopeSeat {
  seat: SeatRef;
  /** "persistent" starts once then resumes the exact native session; "fresh"
   * seats request a new session on every turn. */
  session: "persistent" | "fresh";
  independence: IndependenceRequirement[];
}

/** A finite C0–C2 sequence step or a C3/C4 graph transition. Both shapes are
 * bounded and admittable before the first turn. */
export interface EnvelopeTransition {
  /** State this transition leaves. Sequences use "step:<n>". */
  from: string;
  /** State this transition enters; terminal states appear in `terminals`. */
  to: string;
  seat: SeatRef;
  /** Provider turns this transition costs (deterministic checks cost 0). */
  turnCost: number;
}

export interface CampaignEnvelope {
  schema: typeof DESIGN_RUN_SCHEMA;
  kind: "envelope";
  profile: ProfileTier;
  /** The sole released identity of code, prompts, and skills. */
  packageVersion: string;
  /** Exact source revision of the target repository. */
  sourceRevision: string;
  /** Identity digest of the admitted request inputs. */
  inputIdentity: string;
  shape: "sequence" | "graph";
  seats: EnvelopeSeat[];
  /** Every state; sequences enumerate step states in order. */
  states: string[];
  transitions: EnvelopeTransition[];
  /** Complete terminal coverage: every path ends in one of these. */
  terminals: string[];
  /** Output schemas keyed by logical seat role for structured turns. */
  outputSchemas: Record<string, JsonSchema>;
  limits: {
    maxTurns: number;
    maxWallMs: number;
    maxTokensPerTurn: number;
    maxArtifactFiles: number;
    maxArtifactBytes: number;
    maxHistoryBytes: number;
    maxPromptBytes: number;
    maxIntakeBytes: number;
    maxRelayExchanges?: number;
    maxReaderTurns?: number;
    maxAuditIterations?: number;
    maxStakeholderExchangesPerAuditWindow?: number;
  };
}

export interface TurnReceipt {
  idempotencyKey: string;
  seat: SeatRef;
  /** State before the turn and the exact admitted destination. */
  state: string;
  nextState: string;
  status: "ok" | "refused" | "limit_exhausted" | "error";
  identity?: ExecutionIdentity;
  usage?: TurnUsageReport;
  /** Digest of the accepted turn text; the text itself lives in transcripts. */
  textDigest?: string;
  /** Whether an ok provider result passed structured/artifact validation. */
  accepted?: boolean;
  /** Library-validated structured output (never the host's `parsed` as-is);
   * persisted so a resumed process replays identical control decisions. */
  output?: unknown;
  /** Content-free identities of artifact writes accepted from this turn. */
  artifactChanges?: Array<{ path: string; sha256: string }>;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function artifactMetrics(artifacts: Record<string, string>): { files: number; bytes: number } {
  return {
    files: Object.keys(artifacts).length,
    bytes: Object.values(artifacts).reduce((sum, content) => sum + utf8ByteLength(content), 0),
  };
}

/** Bytes retained for authority-bearing structured outputs, excluding fixed
 * receipt metadata and artifact content already held once in `artifacts`. */
export function structuredHistoryBytes(receipts: TurnReceipt[]): number {
  return receipts.reduce((sum, receipt) => {
    if (receipt.output === undefined && receipt.artifactChanges === undefined) return sum;
    return sum + utf8ByteLength(JSON.stringify({
      ...(receipt.output !== undefined ? { output: receipt.output } : {}),
      ...(receipt.artifactChanges !== undefined ? { artifactChanges: receipt.artifactChanges } : {}),
    }));
  }, 0);
}

export interface RepositorySnapshot {
  revision: string;
  identity: string;
  /** Full matching path inventory; `files` is the bounded content projection. */
  inventory: string[];
  files: Array<{ path: string; content: string }>;
}

export interface CampaignCheckpoint {
  schema: typeof DESIGN_RUN_SCHEMA;
  kind: "checkpoint";
  runId: string;
  /** Compare-and-swap generation; every save names the generation it extends. */
  generation: number;
  packageVersion: string;
  sourceRevision: string;
  envelope: CampaignEnvelope;
  /** Current state-machine position (a state name from the envelope). */
  position: string;
  /** The exact next pending request, saved BEFORE the turn is invoked. */
  pendingTurn?: { idempotencyKey: string; request: TurnRequest; createdAtEpochMs: number };
  receipts: TurnReceipt[];
  /** Opaque native session identities needed to continue persistent seats,
   * keyed by "seat:instance". */
  sessions: Record<string, string>;
  /** Corpus files accepted so far, path → content (unwritten data). */
  artifacts: Record<string, string>;
  /** Exact request/snapshot facts needed to re-derive every resumed prompt. */
  intake: string;
  /** Initial admitted intake used to rebuild the immutable envelope identity. */
  intakeBase: string;
  /** Fixed append-only source identity and kickoff presence, when watched. */
  intakeSource?: { sourceId: string; presentAtKickoff: boolean; instanceId: string | null };
  mode: "greenfield" | "revision";
  repository: RepositorySnapshot;
  startedAtEpochMs: number;
  /** Core artifact identity presented to the latest independent auditor. */
  auditCoreIdentity?: string;
  usage: { turns: number; inputTokens: number; outputTokens: number };
}

/** Host-owned durable compare-and-swap checkpoint store (campaign only). A
 * stale `expectedGeneration` is refused rather than overwriting another
 * process; the campaign saves the pending request before invoking a turn and
 * the accepted result afterward. */
export interface CampaignStorePort {
  load(runId: string): Promise<CampaignCheckpoint | null>;
  save(checkpoint: CampaignCheckpoint, expectedGeneration: number): Promise<void>;
}

export interface Provenance {
  schema: typeof PROVENANCE_SCHEMA;
  packageVersion: string;
  schemas: Record<string, string>;
  profile: ProfileTier;
  sourceRevision: string;
  runId: string;
}

export interface AuditFindingRecord {
  id: string;
  tier: AuditTier;
  title: string;
  iteration: number;
  disposition?: { kind: "fixed" | "disputed" | "deferred"; note: string };
  /** Iteration-2 verification of an iteration-1 finding. */
  verification?: "fixed" | "not-fixed" | "disputed";
}

/** Public performed-audit verdicts. The internal `clean-with-disputes` verdict
 * maps losslessly onto `clean-with-reservations` with the dispute evidence
 * preserved in findings; it never leaks as a public verdict. */
export type PublicAuditVerdict = "clean" | "clean-with-reservations" | "reservations";

export type BundleAudit =
  | { status: "not_required_by_profile" }
  | { status: "performed"; verdict: PublicAuditVerdict; findings: AuditFindingRecord[] };

export interface ProfileAssessment {
  selected: ProfileTier;
  minimumSupportedByFindings: ProfileTier;
  escalationRequired: boolean;
}

export interface DesignBundle {
  /** The corpus, unwritten; the caller owns publication. */
  files: Array<{ path: string; content: string }>;
  provenance: Provenance;
  profileAssessment: ProfileAssessment;
  audit: BundleAudit;
  usage: { turns: number; inputTokens: number; outputTokens: number };
}

export type IncompleteReason = "turn_refused" | "limit_exhausted" | "turn_error" | "invalid_artifact";

export type DesignOutcome =
  | { status: "complete"; bundle: DesignBundle }
  | { status: "incomplete"; checkpoint: CampaignCheckpoint; reason: IncompleteReason; nextAction: string };

const TURN_STATUSES = ["ok", "refused", "limit_exhausted", "error"] as const;
const seatKey = (seat: SeatRef): string => `${seat.seat}:${seat.instance}`;

export function validateEnvelope(value: unknown, problems: string[], path = "envelope"): void {
  if (!requireRecord(value, path, problems)) return;
  if (value.schema !== DESIGN_RUN_SCHEMA) problems.push(`${path}.schema must be ${DESIGN_RUN_SCHEMA}`);
  if (value.kind !== "envelope") problems.push(`${path}.kind must be "envelope"`);
  requireEnum(value.profile, `${path}.profile`, PROFILE_TIERS, problems);
  requireString(value.packageVersion, `${path}.packageVersion`, problems);
  if (value.methodVersion !== undefined) problems.push(`${path}.methodVersion is not a released identity; use packageVersion`);
  requireString(value.sourceRevision, `${path}.sourceRevision`, problems);
  requireString(value.inputIdentity, `${path}.inputIdentity`, problems);
  requireEnum(value.shape, `${path}.shape`, ["sequence", "graph"] as const, problems);
  const declaredSeats = new Set<string>();
  const independenceReferences: Array<{ key: string; path: string }> = [];
  if (requireArray(value.seats, `${path}.seats`, problems)) {
    if (value.seats.length === 0) problems.push(`${path}.seats must not be empty`);
    value.seats.forEach((seat, index) => {
      const seatPath = `${path}.seats[${index}]`;
      if (!requireRecord(seat, seatPath, problems)) return;
      validateSeatRef(seat.seat, `${seatPath}.seat`, problems);
      if (isRecord(seat.seat) && typeof seat.seat.seat === "string" && typeof seat.seat.instance === "string") {
        const key = `${seat.seat.seat}:${seat.seat.instance}`;
        if (declaredSeats.has(key)) problems.push(`${seatPath}.seat duplicates ${key}`);
        declaredSeats.add(key);
      }
      requireEnum(seat.session, `${seatPath}.session`, ["persistent", "fresh"] as const, problems);
      if (requireArray(seat.independence, `${seatPath}.independence`, problems)) {
        seat.independence.forEach((requirement, rIndex) => {
          const rPath = `${seatPath}.independence[${rIndex}]`;
          if (!requireRecord(requirement, rPath, problems)) return;
          validateSeatRef(requirement.from, `${rPath}.from`, problems);
          if (isRecord(requirement.from) && typeof requirement.from.seat === "string" && typeof requirement.from.instance === "string") {
            independenceReferences.push({ key: `${requirement.from.seat}:${requirement.from.instance}`, path: `${rPath}.from` });
          }
          if (
            !Array.isArray(requirement.dimensions) ||
            requirement.dimensions.length === 0 ||
            !requirement.dimensions.every((d) => (INDEPENDENCE_DIMENSIONS as readonly string[]).includes(d as string)) ||
            new Set(requirement.dimensions).size !== requirement.dimensions.length
          ) {
            problems.push(`${rPath}.dimensions must be a unique non-empty subset of [${INDEPENDENCE_DIMENSIONS.join(", ")}]`);
          }
        });
      }
    });
  }
  for (const reference of independenceReferences) {
    if (!declaredSeats.has(reference.key)) problems.push(`${reference.path} names undeclared seat ${reference.key}`);
  }
  const states = requireStringArray(value.states, `${path}.states`, problems) ? (value.states as string[]) : [];
  const terminals = requireStringArray(value.terminals, `${path}.terminals`, problems)
    ? (value.terminals as string[])
    : [];
  if (states.length === 0) problems.push(`${path}.states must not be empty`);
  if (new Set(states).size !== states.length) problems.push(`${path}.states must be unique`);
  if (terminals.length === 0) problems.push(`${path}.terminals must not be empty`);
  if (new Set(terminals).size !== terminals.length) problems.push(`${path}.terminals must be unique`);
  if (states.length > 0 && terminals.some((terminal) => !states.includes(terminal))) {
    problems.push(`${path}.terminals must all appear in states`);
  }
  const transitions: Array<{ from: string; to: string; seat: string; turnCost: number }> = [];
  if (requireArray(value.transitions, `${path}.transitions`, problems)) {
    if (value.transitions.length === 0) problems.push(`${path}.transitions must not be empty`);
    value.transitions.forEach((transition, index) => {
      const tPath = `${path}.transitions[${index}]`;
      if (!requireRecord(transition, tPath, problems)) return;
      requireString(transition.from, `${tPath}.from`, problems);
      requireString(transition.to, `${tPath}.to`, problems);
      validateSeatRef(transition.seat, `${tPath}.seat`, problems);
      requireInteger(transition.turnCost, `${tPath}.turnCost`, problems);
      if (
        typeof transition.from === "string" &&
        typeof transition.to === "string" &&
        isRecord(transition.seat) &&
        typeof transition.seat.seat === "string" &&
        typeof transition.seat.instance === "string" &&
        typeof transition.turnCost === "number"
      ) {
        const key = `${transition.seat.seat}:${transition.seat.instance}`;
        transitions.push({ from: transition.from, to: transition.to, seat: key, turnCost: transition.turnCost });
        if (!declaredSeats.has(key)) problems.push(`${tPath}.seat names undeclared seat ${key}`);
      }
      if (states.length > 0) {
        if (typeof transition.from === "string" && !states.includes(transition.from)) {
          problems.push(`${tPath}.from names undeclared state ${String(transition.from)}`);
        }
        if (typeof transition.to === "string" && !states.includes(transition.to)) {
          problems.push(`${tPath}.to names undeclared state ${String(transition.to)}`);
        }
      }
    });
  }
  const transitionKeys = transitions.map((transition) => `${transition.from}\0${transition.to}\0${transition.seat}`);
  if (new Set(transitionKeys).size !== transitionKeys.length) problems.push(`${path}.transitions must be unique`);
  if (states.length > 0) {
    const reachable = new Set<string>([states[0] as string]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const transition of transitions) {
        if (reachable.has(transition.from) && !reachable.has(transition.to)) {
          reachable.add(transition.to);
          changed = true;
        }
      }
    }
    for (const state of states) if (!reachable.has(state)) problems.push(`${path}.state ${state} is unreachable`);
    for (const terminal of terminals) {
      if (transitions.some((transition) => transition.from === terminal)) problems.push(`${path}.terminal ${terminal} must not have outgoing transitions`);
    }
    for (const state of states.filter((state) => !terminals.includes(state))) {
      const outgoing = transitions.filter((transition) => transition.from === state);
      if (outgoing.length === 0) problems.push(`${path}.nonterminal ${state} has no outgoing transition`);
      if (value.shape === "sequence" && outgoing.length !== 1) problems.push(`${path}.sequence state ${state} must have exactly one outgoing transition`);
    }
  }
  if (requireRecord(value.outputSchemas, `${path}.outputSchemas`, problems)) {
    for (const [phase, schema] of Object.entries(value.outputSchemas)) {
      if (phase.length === 0 || !isRecord(schema)) problems.push(`${path}.outputSchemas.${phase || "(empty)"} must be an object schema`);
    }
  }
  if (!requireRecord(value.limits, `${path}.limits`, problems)) return;
  const maxTurnsValid = requireInteger(value.limits.maxTurns, `${path}.limits.maxTurns`, problems, 1);
  requireInteger(value.limits.maxWallMs, `${path}.limits.maxWallMs`, problems, 1);
  requireInteger(value.limits.maxTokensPerTurn, `${path}.limits.maxTokensPerTurn`, problems, 1);
  for (const key of ["maxArtifactFiles", "maxArtifactBytes", "maxHistoryBytes", "maxPromptBytes", "maxIntakeBytes"]) {
    requireInteger(value.limits[key], `${path}.limits.${key}`, problems, 1);
  }
  for (const key of ["maxRelayExchanges", "maxReaderTurns", "maxAuditIterations", "maxStakeholderExchangesPerAuditWindow"]) {
    if (value.limits[key] !== undefined) requireInteger(value.limits[key], `${path}.limits.${key}`, problems, 1);
  }
  const finiteTurns: Partial<Record<ProfileTier, number>> = { C0: 1, C1: 2, C2: 4 };
  if (typeof value.profile === "string" && value.profile in finiteTurns) {
    const expected = finiteTurns[value.profile as ProfileTier];
    if (value.shape !== "sequence") problems.push(`${path}.shape must be sequence for ${value.profile}`);
    if (maxTurnsValid && typeof value.limits.maxTurns === "number" && value.limits.maxTurns > (expected as number)) {
      problems.push(`${path}.limits.maxTurns may not exceed ${expected} for ${value.profile}`);
    }
    if (transitions.reduce((sum, transition) => sum + transition.turnCost, 0) !== expected) {
      problems.push(`${path}.transitions must admit exactly ${expected} provider turns for ${value.profile}`);
    }
  } else if (value.profile === "C3" || value.profile === "C4") {
    if (value.shape !== "graph") problems.push(`${path}.shape must be graph for ${value.profile}`);
    for (const key of ["maxRelayExchanges", "maxReaderTurns", "maxAuditIterations", "maxStakeholderExchangesPerAuditWindow"]) {
      if (value.limits[key] === undefined) problems.push(`${path}.limits.${key} is required for ${value.profile}`);
    }
  }
  const maxTurns = typeof value.limits.maxTurns === "number" ? value.limits.maxTurns : 0;
  if (maxTurnsValid && transitions.some((transition) => transition.turnCost > maxTurns)) {
    problems.push(`${path}.transition turn cost cannot exceed maxTurns`);
  }
}

/** A checkpoint missing any required identity is rejected — resuming from an
 * ambiguous record risks repeating or dropping a paid turn. */
export function validateCheckpoint(value: unknown, problems: string[], path = "checkpoint"): void {
  if (!requireRecord(value, path, problems)) return;
  if (value.schema !== DESIGN_RUN_SCHEMA) problems.push(`${path}.schema must be ${DESIGN_RUN_SCHEMA}`);
  if (value.kind !== "checkpoint") problems.push(`${path}.kind must be "checkpoint"`);
  const runIdValid = requireString(value.runId, `${path}.runId`, problems);
  requireInteger(value.generation, `${path}.generation`, problems);
  const packageVersionValid = requireString(value.packageVersion, `${path}.packageVersion`, problems);
  const sourceRevisionValid = requireString(value.sourceRevision, `${path}.sourceRevision`, problems);
  validateEnvelope(value.envelope, problems, `${path}.envelope`);
  const envelope = isRecord(value.envelope) ? value.envelope : undefined;
  if (envelope && packageVersionValid && envelope.packageVersion !== value.packageVersion) {
    problems.push(`${path}.packageVersion must match ${path}.envelope.packageVersion`);
  }
  if (envelope && sourceRevisionValid && envelope.sourceRevision !== value.sourceRevision) {
    problems.push(`${path}.sourceRevision must match ${path}.envelope.sourceRevision`);
  }
  const states = envelope && Array.isArray(envelope.states) ? envelope.states.filter((state): state is string => typeof state === "string") : [];
  const positionValid = requireString(value.position, `${path}.position`, problems);
  const position = typeof value.position === "string" ? value.position : "";
  if (positionValid && !states.includes(position)) problems.push(`${path}.position names undeclared state ${position}`);
  const declaredSeats = new Map<string, Record<string, unknown>>();
  if (envelope && Array.isArray(envelope.seats)) {
    for (const candidate of envelope.seats) {
      if (isRecord(candidate) && isRecord(candidate.seat) && typeof candidate.seat.seat === "string" && typeof candidate.seat.instance === "string") {
        declaredSeats.set(`${candidate.seat.seat}:${candidate.seat.instance}`, candidate);
      }
    }
  }
  const transitions = envelope && Array.isArray(envelope.transitions)
    ? envelope.transitions.filter((transition): transition is Record<string, unknown> => isRecord(transition))
    : [];
  const matchingTransitions = (state: string, seat: Record<string, unknown>, to?: string): Record<string, unknown>[] => {
    const key = typeof seat.seat === "string" && typeof seat.instance === "string" ? `${seat.seat}:${seat.instance}` : "";
    return transitions.filter((transition) => {
      if (transition.from !== state || (to !== undefined && transition.to !== to) || !isRecord(transition.seat)) return false;
      return `${String(transition.seat.seat)}:${String(transition.seat.instance)}` === key;
    });
  };

  const receiptKeys = new Set<string>();
  const lastPersistentIdentity = new Map<string, string>();
  const acceptedIdentities = new Map<string, Record<string, unknown>>();
  let receiptInputTokens = 0;
  let receiptOutputTokens = 0;
  let replayPosition = states[0];
  if (requireArray(value.receipts, `${path}.receipts`, problems)) {
    value.receipts.forEach((receipt, index) => {
      const rPath = `${path}.receipts[${index}]`;
      if (!requireRecord(receipt, rPath, problems)) return;
      if (requireString(receipt.idempotencyKey, `${rPath}.idempotencyKey`, problems)) {
        if (receiptKeys.has(receipt.idempotencyKey)) problems.push(`${rPath} duplicates idempotency key ${receipt.idempotencyKey}`);
        receiptKeys.add(receipt.idempotencyKey);
      }
      validateSeatRef(receipt.seat, `${rPath}.seat`, problems);
      const stateValid = requireString(receipt.state, `${rPath}.state`, problems);
      const receiptState = typeof receipt.state === "string" ? receipt.state : "";
      const nextStateValid = requireString(receipt.nextState, `${rPath}.nextState`, problems);
      const receiptNextState = typeof receipt.nextState === "string" ? receipt.nextState : "";
      const statusValid = requireEnum(receipt.status, `${rPath}.status`, TURN_STATUSES, problems);
      const receiptSeat = isRecord(receipt.seat) ? receipt.seat : undefined;
      const receiptSeatKey = receiptSeat && typeof receiptSeat.seat === "string" && typeof receiptSeat.instance === "string"
        ? `${receiptSeat.seat}:${receiptSeat.instance}`
        : undefined;
      if (receiptSeatKey && !declaredSeats.has(receiptSeatKey)) problems.push(`${rPath}.seat names undeclared seat ${receiptSeatKey}`);
      if (stateValid && !states.includes(receiptState)) problems.push(`${rPath}.state names undeclared state ${receiptState}`);
      if (nextStateValid && !states.includes(receiptNextState)) problems.push(`${rPath}.nextState names undeclared state ${receiptNextState}`);
      if (stateValid && replayPosition !== undefined && receiptState !== replayPosition) {
        problems.push(`${rPath}.state must continue from ${replayPosition}`);
      }
      const candidates = stateValid && nextStateValid && receiptSeat ? matchingTransitions(receiptState, receiptSeat, receiptNextState) : [];
      if (stateValid && nextStateValid && receiptSeat && candidates.length !== 1) {
        problems.push(`${rPath} must identify exactly one admitted transition`);
      }
      if (receipt.identity !== undefined) validateExecutionIdentity(receipt.identity, `${rPath}.identity`, problems);
      if (receipt.artifactChanges !== undefined) {
        if (receipt.status !== "ok" || receipt.accepted !== true) {
          problems.push(`${rPath}.artifactChanges is valid only for an accepted ok result`);
        }
        if (requireArray(receipt.artifactChanges, `${rPath}.artifactChanges`, problems)) {
          const changedPaths = new Set<string>();
          receipt.artifactChanges.forEach((change, changeIndex) => {
            const changePath = `${rPath}.artifactChanges[${changeIndex}]`;
            if (!requireRecord(change, changePath, problems)) return;
            if (requireSafePath(change.path, `${changePath}.path`, problems)) {
              if (!change.path.startsWith("validation-design/")) problems.push(`${changePath}.path must be beneath validation-design/`);
              if (changedPaths.has(change.path)) problems.push(`${changePath}.path duplicates ${change.path}`);
              changedPaths.add(change.path);
            }
            if (typeof change.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(change.sha256)) {
              problems.push(`${changePath}.sha256 must be a lowercase sha256 digest`);
            }
          });
        }
      }
      if (statusValid && receipt.status === "ok") {
        if (!isRecord(receipt.identity)) problems.push(`${rPath}.identity is required for an accepted turn`);
        if (typeof receipt.accepted !== "boolean") problems.push(`${rPath}.accepted is required for an ok provider result`);
        if (typeof receipt.textDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.textDigest)) {
          problems.push(`${rPath}.textDigest must be a lowercase sha256 digest for an accepted turn`);
        }
        if (receipt.accepted === true && candidates[0] && typeof candidates[0].to === "string") replayPosition = candidates[0].to;
        if (receipt.accepted === true && receiptSeatKey && isRecord(receipt.identity) && typeof receipt.identity.session === "string") {
          const declared = declaredSeats.get(receiptSeatKey);
          const prior = acceptedIdentities.get(receiptSeatKey);
          if (declared?.session === "persistent" && prior) {
            for (const dimension of ["provider", "model", "session"] as const) {
              if (prior[dimension] !== receipt.identity[dimension]) {
                problems.push(`${rPath}.identity.${dimension} must remain stable for persistent seat ${receiptSeatKey}`);
              }
            }
          }
          if (declared?.session === "fresh" && prior?.session === receipt.identity.session) {
            problems.push(`${rPath}.identity.session reuses a prior fresh session for ${receiptSeatKey}`);
          }
          if (declared && Array.isArray(declared.independence)) {
            for (const requirement of declared.independence) {
              if (!isRecord(requirement) || !isRecord(requirement.from) || !Array.isArray(requirement.dimensions)) continue;
              const fromKey = `${String(requirement.from.seat)}:${String(requirement.from.instance)}`;
              const other = acceptedIdentities.get(fromKey);
              if (!other) continue;
              for (const dimension of requirement.dimensions) {
                if (
                  (dimension === "provider" || dimension === "model" || dimension === "session") &&
                  other[dimension] === receipt.identity[dimension]
                ) {
                  problems.push(`${rPath}.identity.${dimension} violates independence from ${fromKey}`);
                }
              }
            }
          }
          const schema = envelope && isRecord(envelope.outputSchemas) && typeof receiptSeat?.seat === "string"
            ? envelope.outputSchemas[receiptSeat.seat]
            : undefined;
          if (isRecord(schema)) validateAgainstSchema(receipt.output, schema, `${rPath}.output`, problems);
          acceptedIdentities.set(receiptSeatKey, receipt.identity);
          lastPersistentIdentity.set(receiptSeatKey, receipt.identity.session);
        }
      } else if (receipt.textDigest !== undefined) {
        problems.push(`${rPath}.textDigest is only valid for an accepted turn`);
      } else if (receipt.accepted !== undefined || receipt.output !== undefined) {
        problems.push(`${rPath}.accepted/output are only valid for an ok provider result`);
      }
      if (receipt.usage !== undefined) {
        if (requireRecord(receipt.usage, `${rPath}.usage`, problems)) {
          if (requireInteger(receipt.usage.inputTokens, `${rPath}.usage.inputTokens`, problems)) receiptInputTokens += receipt.usage.inputTokens;
          if (requireInteger(receipt.usage.outputTokens, `${rPath}.usage.outputTokens`, problems)) receiptOutputTokens += receipt.usage.outputTokens;
        }
      }
    });
  }
  if (positionValid && replayPosition !== undefined && value.position !== replayPosition) {
    problems.push(`${path}.position ${value.position} does not match replayed position ${replayPosition}`);
  }
  if (requireRecord(value.sessions, `${path}.sessions`, problems)) {
    for (const [key, session] of Object.entries(value.sessions)) {
      if (typeof session !== "string" || session.length === 0) {
        problems.push(`${path}.sessions[${key}] must be a non-empty native session identity`);
      }
      const declared = declaredSeats.get(key);
      if (!declared) problems.push(`${path}.sessions[${key}] names an undeclared seat`);
      else if (declared.session !== "persistent") problems.push(`${path}.sessions[${key}] is invalid for a fresh seat`);
      const acceptedIdentity = lastPersistentIdentity.get(key);
      if (acceptedIdentity !== undefined && session !== acceptedIdentity) {
        problems.push(`${path}.sessions[${key}] must equal the last accepted native session identity`);
      }
    }
    for (const [key, session] of lastPersistentIdentity) {
      if (declaredSeats.get(key)?.session === "persistent" && value.sessions[key] !== session) {
        problems.push(`${path}.sessions[${key}] is required after an accepted persistent-seat turn`);
      }
    }
  }
  if (value.pendingTurn !== undefined) {
    if (requireRecord(value.pendingTurn, `${path}.pendingTurn`, problems)) {
      const pendingKeyValid = requireString(value.pendingTurn.idempotencyKey, `${path}.pendingTurn.idempotencyKey`, problems);
      const pendingKey = typeof value.pendingTurn.idempotencyKey === "string" ? value.pendingTurn.idempotencyKey : "";
      const pendingCreatedValid = requireInteger(
        value.pendingTurn.createdAtEpochMs,
        `${path}.pendingTurn.createdAtEpochMs`,
        problems,
        1,
      );
      if (isRecord(value.pendingTurn.request)) {
        validateTurnRequest(value.pendingTurn.request, problems);
        const request = value.pendingTurn.request;
        if (pendingKeyValid && request.idempotencyKey !== value.pendingTurn.idempotencyKey) {
          problems.push(`${path}.pendingTurn idempotency keys must match`);
        }
        if (pendingKeyValid && receiptKeys.has(pendingKey)) {
          problems.push(`${path}.pendingTurn idempotency key is already settled`);
        }
        if (isRecord(request.metadata)) {
          if (runIdValid && request.metadata.runId !== value.runId) problems.push(`${path}.pendingTurn.request.metadata.runId must match checkpoint runId`);
          if (typeof request.metadata.phase === "string" && !states.includes(request.metadata.phase)) {
            problems.push(`${path}.pendingTurn.request.metadata.phase must name the admitted next state`);
          }
          if (Array.isArray(value.receipts) && request.metadata.turnIndex !== value.receipts.length + 1) {
            problems.push(`${path}.pendingTurn.request.metadata.turnIndex must follow accepted receipts`);
          }
        }
        if (isRecord(request.seat) && positionValid) {
          const key = typeof request.seat.seat === "string" && typeof request.seat.instance === "string"
            ? `${request.seat.seat}:${request.seat.instance}`
            : "";
          const declared = declaredSeats.get(key);
          if (!declared) problems.push(`${path}.pendingTurn.request.seat names undeclared seat ${key}`);
          const requestedNext = isRecord(request.metadata) && typeof request.metadata.phase === "string" ? request.metadata.phase : undefined;
          if (matchingTransitions(position, request.seat, requestedNext).length !== 1) {
            problems.push(`${path}.pendingTurn.request must identify exactly one transition from ${position}`);
          }
          if (declared && JSON.stringify(request.independence) !== JSON.stringify(declared.independence)) {
            problems.push(`${path}.pendingTurn.request.independence must match the admitted seat requirement`);
          }
          if (declared?.session === "fresh" && (!isRecord(request.session) || request.session.mode !== "new")) {
            problems.push(`${path}.pendingTurn.request.session must be new for a fresh seat`);
          }
          if (declared?.session === "persistent") {
            const stored = isRecord(value.sessions) && typeof value.sessions[key] === "string" ? value.sessions[key] : undefined;
            if (stored === undefined && (!isRecord(request.session) || request.session.mode !== "new")) {
              problems.push(`${path}.pendingTurn.request.session must start new before a persistent session exists`);
            }
            if (stored !== undefined && (!isRecord(request.session) || request.session.mode !== "resume" || request.session.sessionId !== stored)) {
              problems.push(`${path}.pendingTurn.request.session must resume the exact stored native session`);
            }
          }
        }
        if (isRecord(request.limits) && envelope && isRecord(envelope.limits)) {
          const startedAt = value.startedAtEpochMs;
          const campaignWall = envelope.limits.maxWallMs;
          const createdAt = pendingCreatedValid ? value.pendingTurn.createdAtEpochMs as number : 0;
          if (
            pendingCreatedValid &&
            typeof startedAt === "number" &&
            Number.isSafeInteger(startedAt) &&
            typeof campaignWall === "number" &&
            Number.isSafeInteger(campaignWall)
          ) {
            const deadline = startedAt + campaignWall;
            if (!Number.isSafeInteger(deadline)) {
              problems.push(`${path} absolute campaign deadline must be a safe integer`);
            } else if (createdAt < startedAt || createdAt >= deadline) {
              problems.push(`${path}.pendingTurn.createdAtEpochMs must be within the admitted campaign wall`);
            } else {
              const expectedWall = Math.min(deadline - createdAt, MAX_PROVIDER_TURN_WALL_MS);
              if (request.limits.maxWallMs !== expectedWall) {
                problems.push(`${path}.pendingTurn.request.limits.maxWallMs must equal the persisted remaining campaign wall ${expectedWall}`);
              }
              if (request.limits.deadlineAtEpochMs !== deadline) {
                problems.push(`${path}.pendingTurn.request.limits.deadlineAtEpochMs must equal the absolute campaign deadline ${deadline}`);
              }
            }
          }
        }
        if (
          typeof request.prompt === "string" &&
          envelope &&
          isRecord(envelope.limits) &&
          typeof envelope.limits.maxPromptBytes === "number" &&
          utf8ByteLength(request.prompt) > envelope.limits.maxPromptBytes
        ) {
          problems.push(`${path}.pendingTurn.request.prompt exceeds the admitted maxPromptBytes`);
        }
      } else {
        problems.push(`${path}.pendingTurn.request must be the exact pending TurnRequest`);
      }
    }
  }
  if (requireRecord(value.artifacts, `${path}.artifacts`, problems)) {
    for (const key of Object.keys(value.artifacts)) {
      const artifactProblems: string[] = [];
      requireSafePath(key, `${path}.artifacts[${key}]`, artifactProblems);
      problems.push(...artifactProblems);
      if (!key.startsWith("validation-design/")) problems.push(`${path}.artifacts[${key}] must be beneath validation-design/`);
      if (typeof value.artifacts[key] !== "string") problems.push(`${path}.artifacts[${key}] must be file content`);
    }
    if (envelope && isRecord(envelope.limits)) {
      const artifactRecord = Object.fromEntries(
        Object.entries(value.artifacts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      const metrics = artifactMetrics(artifactRecord);
      if (typeof envelope.limits.maxArtifactFiles === "number" && metrics.files > envelope.limits.maxArtifactFiles) {
        problems.push(`${path}.artifacts exceed the admitted maxArtifactFiles`);
      }
      if (typeof envelope.limits.maxArtifactBytes === "number" && metrics.bytes > envelope.limits.maxArtifactBytes) {
        problems.push(`${path}.artifacts exceed the admitted maxArtifactBytes`);
      }
    }
  }
  if (typeof value.intake !== "string") problems.push(`${path}.intake must be a string`);
  else if (
    envelope &&
    isRecord(envelope.limits) &&
    typeof envelope.limits.maxIntakeBytes === "number" &&
    utf8ByteLength(value.intake) > envelope.limits.maxIntakeBytes
  ) {
    problems.push(`${path}.intake exceeds the admitted maxIntakeBytes`);
  }
  if (typeof value.intakeBase !== "string") {
    problems.push(`${path}.intakeBase must be a string`);
  } else if (typeof value.intake === "string" && !value.intake.startsWith(value.intakeBase)) {
    problems.push(`${path}.intake must preserve the admitted intakeBase prefix`);
  }
  if (value.intakeSource !== undefined) {
    if (requireRecord(value.intakeSource, `${path}.intakeSource`, problems)) {
      requireString(value.intakeSource.sourceId, `${path}.intakeSource.sourceId`, problems);
      if (typeof value.intakeSource.presentAtKickoff !== "boolean") {
        problems.push(`${path}.intakeSource.presentAtKickoff must be boolean`);
      }
      if (value.intakeSource.instanceId !== null && typeof value.intakeSource.instanceId !== "string") {
        problems.push(`${path}.intakeSource.instanceId must be a string or null`);
      }
    }
  }
  requireEnum(value.mode, `${path}.mode`, ["greenfield", "revision"] as const, problems);
  if (requireRecord(value.repository, `${path}.repository`, problems)) {
    const repository = value.repository;
    requireString(repository.revision, `${path}.repository.revision`, problems);
    if (sourceRevisionValid && repository.revision !== value.sourceRevision) {
      problems.push(`${path}.repository.revision must match checkpoint sourceRevision`);
    }
    if (typeof repository.identity !== "string" || !/^[a-f0-9]{64}$/.test(repository.identity)) {
      problems.push(`${path}.repository.identity must be a lowercase sha256 digest`);
    }
    if (requireStringArray(repository.inventory, `${path}.repository.inventory`, problems)) {
      const inventory = repository.inventory as string[];
      if (new Set(inventory).size !== inventory.length) problems.push(`${path}.repository.inventory must be unique`);
      inventory.forEach((item, index) => requireSafePath(item, `${path}.repository.inventory[${index}]`, problems));
    }
    if (requireArray(repository.files, `${path}.repository.files`, problems)) {
      const paths = new Set<string>();
      repository.files.forEach((file, index) => {
        const filePath = `${path}.repository.files[${index}]`;
        if (!requireRecord(file, filePath, problems)) return;
        if (requireSafePath(file.path, `${filePath}.path`, problems)) {
          if (paths.has(file.path)) problems.push(`${filePath}.path duplicates ${file.path}`);
          paths.add(file.path);
          if (Array.isArray(repository.inventory) && !repository.inventory.includes(file.path)) {
            problems.push(`${filePath}.path must appear in repository.inventory`);
          }
        }
        if (typeof file.content !== "string") problems.push(`${filePath}.content must be a string`);
      });
    }
  }
  const startedAtValid = requireInteger(value.startedAtEpochMs, `${path}.startedAtEpochMs`, problems, 1);
  if (
    startedAtValid &&
    envelope &&
    isRecord(envelope.limits) &&
    typeof envelope.limits.maxWallMs === "number" &&
    Number.isSafeInteger(envelope.limits.maxWallMs) &&
    !Number.isSafeInteger((value.startedAtEpochMs as number) + envelope.limits.maxWallMs)
  ) {
    problems.push(`${path} absolute campaign deadline must be a safe integer`);
  }
  if (value.auditCoreIdentity !== undefined && (typeof value.auditCoreIdentity !== "string" || !/^[a-f0-9]{64}$/.test(value.auditCoreIdentity))) {
    problems.push(`${path}.auditCoreIdentity must be a lowercase sha256 digest when present`);
  }
  if (!requireRecord(value.usage, `${path}.usage`, problems)) return;
  if (requireInteger(value.usage.turns, `${path}.usage.turns`, problems) && Array.isArray(value.receipts) && value.usage.turns !== value.receipts.length) {
    problems.push(`${path}.usage.turns must equal the number of settled receipts`);
  }
  if (requireInteger(value.usage.inputTokens, `${path}.usage.inputTokens`, problems) && value.usage.inputTokens !== receiptInputTokens) {
    problems.push(`${path}.usage.inputTokens must equal receipt usage`);
  }
  if (requireInteger(value.usage.outputTokens, `${path}.usage.outputTokens`, problems) && value.usage.outputTokens !== receiptOutputTokens) {
    problems.push(`${path}.usage.outputTokens must equal receipt usage`);
  }
  if (envelope && isRecord(envelope.limits) && typeof envelope.limits.maxTurns === "number" && Array.isArray(value.receipts) && value.receipts.length > envelope.limits.maxTurns) {
    problems.push(`${path}.receipts exceed the admitted maxTurns`);
  }
  if (
    envelope &&
    isRecord(envelope.limits) &&
    typeof envelope.limits.maxHistoryBytes === "number" &&
    Array.isArray(value.receipts) &&
    structuredHistoryBytes(value.receipts.filter(isRecord) as unknown as TurnReceipt[]) > envelope.limits.maxHistoryBytes
  ) {
    problems.push(`${path}.receipts exceed the admitted maxHistoryBytes`);
  }
}

export function validateProvenance(value: unknown, problems: string[], path = "provenance"): void {
  if (!requireRecord(value, path, problems)) return;
  if (value.schema !== PROVENANCE_SCHEMA) problems.push(`${path}.schema must be ${PROVENANCE_SCHEMA}`);
  requireString(value.packageVersion, `${path}.packageVersion`, problems);
  if (value.methodVersion !== undefined) problems.push(`${path}.methodVersion is not a released identity; use packageVersion`);
  if (requireRecord(value.schemas, `${path}.schemas`, problems)) {
    const expected = {
      corpus: "validation-architect/corpus/v1",
      caseCatalog: "validation-architect/case-catalog/v1",
      result: "validation-architect/result/v1",
      plan: "validation-architect/plan/v1",
      designRun: DESIGN_RUN_SCHEMA,
      provenance: PROVENANCE_SCHEMA,
    };
    const actualKeys = Object.keys(value.schemas).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(Object.keys(expected).sort())) {
      problems.push(`${path}.schemas must contain exactly [${Object.keys(expected).join(", ")}]`);
    }
    for (const [key, id] of Object.entries(expected)) {
      if (value.schemas[key] !== id) problems.push(`${path}.schemas.${key} must be ${id}`);
    }
  }
  requireEnum(value.profile, `${path}.profile`, PROFILE_TIERS, problems);
  requireString(value.sourceRevision, `${path}.sourceRevision`, problems);
  requireString(value.runId, `${path}.runId`, problems);
}

export function validateDesignBundle(value: unknown, problems: string[], path = "bundle"): void {
  if (!requireRecord(value, path, problems)) return;
  if (requireArray(value.files, `${path}.files`, problems)) {
    const paths = new Set<string>();
    if (value.files.length === 0) problems.push(`${path}.files must not be empty`);
    value.files.forEach((file, index) => {
      const fPath = `${path}.files[${index}]`;
      if (!requireRecord(file, fPath, problems)) return;
      if (requireSafePath(file.path, `${fPath}.path`, problems)) {
        if (!file.path.startsWith("validation-design/")) problems.push(`${fPath}.path must be beneath validation-design/`);
        if (paths.has(file.path)) problems.push(`${fPath}.path duplicates ${file.path}`);
        paths.add(file.path);
      }
      if (typeof file.content !== "string") problems.push(`${fPath}.content must be a string`);
    });
  }
  validateProvenance(value.provenance, problems, `${path}.provenance`);
  if (requireRecord(value.profileAssessment, `${path}.profileAssessment`, problems)) {
    requireEnum(value.profileAssessment.selected, `${path}.profileAssessment.selected`, PROFILE_TIERS, problems);
    requireEnum(
      value.profileAssessment.minimumSupportedByFindings,
      `${path}.profileAssessment.minimumSupportedByFindings`,
      PROFILE_TIERS,
      problems,
    );
    if (typeof value.profileAssessment.escalationRequired !== "boolean") {
      problems.push(`${path}.profileAssessment.escalationRequired must be a boolean`);
    }
    if (isRecord(value.provenance) && value.provenance.profile !== value.profileAssessment.selected) {
      problems.push(`${path}.profileAssessment.selected must match provenance.profile`);
    }
  }
  if (requireRecord(value.audit, `${path}.audit`, problems)) {
    if (value.audit.status === "not_required_by_profile") {
      // explicit omission — never presented as clean
    } else if (value.audit.status === "performed") {
      requireEnum(
        value.audit.verdict,
        `${path}.audit.verdict`,
        ["clean", "clean-with-reservations", "reservations"] as const,
        problems,
      );
      if (requireArray(value.audit.findings, `${path}.audit.findings`, problems)) {
        const findingIds = new Set<string>();
        value.audit.findings.forEach((finding, index) => {
          const fPath = `${path}.audit.findings[${index}]`;
          if (!requireRecord(finding, fPath, problems)) return;
          if (requireString(finding.id, `${fPath}.id`, problems)) {
            const key = `${String(finding.iteration)}:${finding.id}`;
            if (findingIds.has(key)) problems.push(`${fPath} duplicates iteration/id ${key}`);
            findingIds.add(key);
          }
          requireEnum(finding.tier, `${fPath}.tier`, ["blocking", "significant", "minor"] as const, problems);
          requireString(finding.title, `${fPath}.title`, problems);
          requireInteger(finding.iteration, `${fPath}.iteration`, problems, 1);
          if (finding.disposition !== undefined && requireRecord(finding.disposition, `${fPath}.disposition`, problems)) {
            requireEnum(finding.disposition.kind, `${fPath}.disposition.kind`, ["fixed", "disputed", "deferred"] as const, problems);
            requireString(finding.disposition.note, `${fPath}.disposition.note`, problems);
          }
          if (finding.verification !== undefined) {
            requireEnum(finding.verification, `${fPath}.verification`, ["fixed", "not-fixed", "disputed"] as const, problems);
          }
        });
      }
    } else {
      problems.push(`${path}.audit.status must be "not_required_by_profile" or "performed"`);
    }
    if (isRecord(value.provenance)) {
      if (value.provenance.profile === "C0" && value.audit.status !== "not_required_by_profile") {
        problems.push(`${path}.audit must record not_required_by_profile for C0`);
      }
      if (value.provenance.profile !== "C0" && value.audit.status !== "performed") {
        problems.push(`${path}.audit must be performed for C1-C4`);
      }
    }
  }
  if (!requireRecord(value.usage, `${path}.usage`, problems)) return;
  requireInteger(value.usage.turns, `${path}.usage.turns`, problems);
  requireInteger(value.usage.inputTokens, `${path}.usage.inputTokens`, problems);
  requireInteger(value.usage.outputTokens, `${path}.usage.outputTokens`, problems);
}

export { SEATS };
