/**
 * Campaign envelope, checkpoint (`validation-architect/design-run/v1`),
 * provenance (`validation-architect/provenance/v1`), and design bundle
 * contracts (VA-API-002). WS3 (#16) implements the behavior; this module owns
 * the shapes and runtime validators.
 */

import type { CriticalityTier } from "../model.js";
import type { AuditTier } from "../types.js";
import {
  INDEPENDENCE_DIMENSIONS,
  SEATS,
  validateSeatRef,
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
  /** Package-derived method identity. */
  packageVersion: string;
  methodVersion: string;
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
  /** Output schemas keyed by phase for structured turns. */
  outputSchemas: Record<string, JsonSchema>;
  limits: {
    maxTurns: number;
    maxWallMs: number;
    maxRelayExchanges?: number;
    maxReaderTurns?: number;
    maxAuditIterations?: number;
    maxStakeholderExchangesPerAuditWindow?: number;
  };
}

export interface TurnReceipt {
  idempotencyKey: string;
  seat: SeatRef;
  state: string;
  status: "ok" | "refused" | "limit_exhausted" | "error";
  identity?: ExecutionIdentity;
  usage?: TurnUsageReport;
  /** Digest of the accepted turn text; the text itself lives in transcripts. */
  textDigest?: string;
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
  pendingTurn?: { idempotencyKey: string; request: TurnRequest };
  receipts: TurnReceipt[];
  /** Opaque native session identities needed to continue persistent seats,
   * keyed by "seat:instance". */
  sessions: Record<string, string>;
  /** Corpus files accepted so far, path → content (unwritten data). */
  artifacts: Record<string, string>;
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
  methodVersion: string;
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

export function validateEnvelope(value: unknown, problems: string[], path = "envelope"): void {
  if (!requireRecord(value, path, problems)) return;
  if (value.schema !== DESIGN_RUN_SCHEMA) problems.push(`${path}.schema must be ${DESIGN_RUN_SCHEMA}`);
  if (value.kind !== "envelope") problems.push(`${path}.kind must be "envelope"`);
  requireEnum(value.profile, `${path}.profile`, PROFILE_TIERS, problems);
  requireString(value.packageVersion, `${path}.packageVersion`, problems);
  requireString(value.methodVersion, `${path}.methodVersion`, problems);
  requireString(value.sourceRevision, `${path}.sourceRevision`, problems);
  requireString(value.inputIdentity, `${path}.inputIdentity`, problems);
  requireEnum(value.shape, `${path}.shape`, ["sequence", "graph"] as const, problems);
  if (requireArray(value.seats, `${path}.seats`, problems)) {
    value.seats.forEach((seat, index) => {
      const seatPath = `${path}.seats[${index}]`;
      if (!requireRecord(seat, seatPath, problems)) return;
      validateSeatRef(seat.seat, `${seatPath}.seat`, problems);
      requireEnum(seat.session, `${seatPath}.session`, ["persistent", "fresh"] as const, problems);
      if (requireArray(seat.independence, `${seatPath}.independence`, problems)) {
        seat.independence.forEach((requirement, rIndex) => {
          const rPath = `${seatPath}.independence[${rIndex}]`;
          if (!requireRecord(requirement, rPath, problems)) return;
          validateSeatRef(requirement.from, `${rPath}.from`, problems);
          if (
            !Array.isArray(requirement.dimensions) ||
            requirement.dimensions.length === 0 ||
            !requirement.dimensions.every((d) => (INDEPENDENCE_DIMENSIONS as readonly string[]).includes(d as string))
          ) {
            problems.push(`${rPath}.dimensions must be a non-empty subset of [${INDEPENDENCE_DIMENSIONS.join(", ")}]`);
          }
        });
      }
    });
  }
  const states = requireStringArray(value.states, `${path}.states`, problems) ? (value.states as string[]) : [];
  const terminals = requireStringArray(value.terminals, `${path}.terminals`, problems)
    ? (value.terminals as string[])
    : [];
  if (states.length > 0 && terminals.some((terminal) => !states.includes(terminal))) {
    problems.push(`${path}.terminals must all appear in states`);
  }
  if (requireArray(value.transitions, `${path}.transitions`, problems)) {
    value.transitions.forEach((transition, index) => {
      const tPath = `${path}.transitions[${index}]`;
      if (!requireRecord(transition, tPath, problems)) return;
      requireString(transition.from, `${tPath}.from`, problems);
      requireString(transition.to, `${tPath}.to`, problems);
      validateSeatRef(transition.seat, `${tPath}.seat`, problems);
      requireInteger(transition.turnCost, `${tPath}.turnCost`, problems);
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
  if (!requireRecord(value.outputSchemas, `${path}.outputSchemas`, problems)) return;
  if (!requireRecord(value.limits, `${path}.limits`, problems)) return;
  requireInteger(value.limits.maxTurns, `${path}.limits.maxTurns`, problems, 1);
  requireInteger(value.limits.maxWallMs, `${path}.limits.maxWallMs`, problems, 1);
}

/** A checkpoint missing any required identity is rejected — resuming from an
 * ambiguous record risks repeating or dropping a paid turn. */
export function validateCheckpoint(value: unknown, problems: string[], path = "checkpoint"): void {
  if (!requireRecord(value, path, problems)) return;
  if (value.schema !== DESIGN_RUN_SCHEMA) problems.push(`${path}.schema must be ${DESIGN_RUN_SCHEMA}`);
  if (value.kind !== "checkpoint") problems.push(`${path}.kind must be "checkpoint"`);
  requireString(value.runId, `${path}.runId`, problems);
  requireInteger(value.generation, `${path}.generation`, problems);
  requireString(value.packageVersion, `${path}.packageVersion`, problems);
  requireString(value.sourceRevision, `${path}.sourceRevision`, problems);
  validateEnvelope(value.envelope, problems, `${path}.envelope`);
  requireString(value.position, `${path}.position`, problems);
  if (value.pendingTurn !== undefined) {
    if (requireRecord(value.pendingTurn, `${path}.pendingTurn`, problems)) {
      requireString(value.pendingTurn.idempotencyKey, `${path}.pendingTurn.idempotencyKey`, problems);
      if (!isRecord(value.pendingTurn.request)) {
        problems.push(`${path}.pendingTurn.request must be the exact pending TurnRequest`);
      }
    }
  }
  if (requireArray(value.receipts, `${path}.receipts`, problems)) {
    const seen = new Set<string>();
    value.receipts.forEach((receipt, index) => {
      const rPath = `${path}.receipts[${index}]`;
      if (!requireRecord(receipt, rPath, problems)) return;
      if (requireString(receipt.idempotencyKey, `${rPath}.idempotencyKey`, problems)) {
        if (seen.has(receipt.idempotencyKey)) problems.push(`${rPath} duplicates idempotency key ${receipt.idempotencyKey}`);
        seen.add(receipt.idempotencyKey);
      }
      validateSeatRef(receipt.seat, `${rPath}.seat`, problems);
      requireString(receipt.state, `${rPath}.state`, problems);
      requireEnum(receipt.status, `${rPath}.status`, TURN_STATUSES, problems);
    });
  }
  if (requireRecord(value.sessions, `${path}.sessions`, problems)) {
    for (const [key, session] of Object.entries(value.sessions)) {
      if (typeof session !== "string" || session.length === 0) {
        problems.push(`${path}.sessions[${key}] must be a non-empty native session identity`);
      }
    }
  }
  if (requireRecord(value.artifacts, `${path}.artifacts`, problems)) {
    for (const key of Object.keys(value.artifacts)) {
      const artifactProblems: string[] = [];
      requireSafePath(key, `${path}.artifacts[${key}]`, artifactProblems);
      problems.push(...artifactProblems);
      if (typeof value.artifacts[key] !== "string") problems.push(`${path}.artifacts[${key}] must be file content`);
    }
  }
  if (!requireRecord(value.usage, `${path}.usage`, problems)) return;
  requireInteger(value.usage.turns, `${path}.usage.turns`, problems);
  requireInteger(value.usage.inputTokens, `${path}.usage.inputTokens`, problems);
  requireInteger(value.usage.outputTokens, `${path}.usage.outputTokens`, problems);
}

export function validateProvenance(value: unknown, problems: string[], path = "provenance"): void {
  if (!requireRecord(value, path, problems)) return;
  if (value.schema !== PROVENANCE_SCHEMA) problems.push(`${path}.schema must be ${PROVENANCE_SCHEMA}`);
  requireString(value.packageVersion, `${path}.packageVersion`, problems);
  requireString(value.methodVersion, `${path}.methodVersion`, problems);
  if (requireRecord(value.schemas, `${path}.schemas`, problems)) {
    for (const [key, id] of Object.entries(value.schemas)) {
      if (typeof id !== "string" || id.length === 0) problems.push(`${path}.schemas[${key}] must be a schema ID`);
    }
  }
  requireEnum(value.profile, `${path}.profile`, PROFILE_TIERS, problems);
  requireString(value.sourceRevision, `${path}.sourceRevision`, problems);
  requireString(value.runId, `${path}.runId`, problems);
}

export function validateDesignBundle(value: unknown, problems: string[], path = "bundle"): void {
  if (!requireRecord(value, path, problems)) return;
  if (requireArray(value.files, `${path}.files`, problems)) {
    value.files.forEach((file, index) => {
      const fPath = `${path}.files[${index}]`;
      if (!requireRecord(file, fPath, problems)) return;
      requireSafePath(file.path, `${fPath}.path`, problems);
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
        value.audit.findings.forEach((finding, index) => {
          const fPath = `${path}.audit.findings[${index}]`;
          if (!requireRecord(finding, fPath, problems)) return;
          requireString(finding.id, `${fPath}.id`, problems);
          requireEnum(finding.tier, `${fPath}.tier`, ["blocking", "significant", "minor"] as const, problems);
          requireString(finding.title, `${fPath}.title`, problems);
          requireInteger(finding.iteration, `${fPath}.iteration`, problems, 1);
        });
      }
    } else {
      problems.push(`${path}.audit.status must be "not_required_by_profile" or "performed"`);
    }
  }
  if (!requireRecord(value.usage, `${path}.usage`, problems)) return;
  requireInteger(value.usage.turns, `${path}.usage.turns`, problems);
  requireInteger(value.usage.inputTokens, `${path}.usage.inputTokens`, problems);
  requireInteger(value.usage.outputTokens, `${path}.usage.outputTokens`, problems);
}

export { SEATS };
