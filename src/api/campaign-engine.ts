/**
 * Provider-neutral campaign engine (VA-API-004, #16): `design(request, ports)`
 * and `resume(runId, ports)`. Every effect flows through the three injected
 * ports; the engine constructs no provider, opens no socket, writes no file,
 * and never enlarges its own admitted envelope. Crash safety comes from the
 * save-pending-before-turn / save-accepted-after-validation compare-and-swap
 * protocol with stable idempotency keys.
 */

import { createHash } from "node:crypto";
import type { ModelFileSet } from "../model-compiler.js";
import { MODEL_FILES, type CriticalityTier } from "../model.js";
import { CORE_PACKAGE_VERSION, METHOD_VERSION } from "../versions.js";
import {
  DESIGN_RUN_SCHEMA,
  PROFILE_TIERS,
  PROVENANCE_SCHEMA,
  type AuditFindingRecord,
  type BundleAudit,
  type CampaignCheckpoint,
  type CampaignEnvelope,
  type CampaignStorePort,
  type DesignBundle,
  type DesignOutcome,
  type EnvelopeTransition,
  type IncompleteReason,
  type ProfileTier,
  type PublicAuditVerdict,
  type TurnReceipt,
} from "./campaign-contracts.js";
import { identityMismatch, invalidCheckpoint, invalidInput, versionMismatch } from "./errors.js";
import { validateAgainstSchema } from "./json-schema.js";
import type {
  ExecutionIdentity,
  IndependenceRequirement,
  JsonSchema,
  RepositoryPort,
  SeatRef,
  TurnPort,
  TurnRequest,
  TurnResult,
} from "./ports.js";
import { validateTurnResult } from "./ports.js";
import { PUBLISHED_SCHEMA_IDS, canonicalJson, validateCorpus, validateDesignRunCheckpoint } from "./schemas.js";
import { assertValid, isRecord, requireEnum, requireString, safeRepositoryPath } from "./validate.js";

export interface DesignPorts {
  repository: RepositoryPort;
  turns: TurnPort;
  store: CampaignStorePort;
}

export interface DesignRequest {
  runId: string;
  profile: ProfileTier;
  /** Freeform intake context the prompts embed (product summary, sources). */
  intake: string;
  /** Greenfield corpus or deliberate revision of the current one. */
  mode?: "greenfield" | "revision";
  /** Host tightening of the declared limits; enlargement is refused. */
  limits?: Partial<CampaignEnvelope["limits"]>;
  /**
   * Pre-spend admission: inspect the envelope and return it (optionally with
   * further-tightened limits) to admit, or null to refuse. No TurnPort call
   * happens before this resolves to an admitted envelope.
   */
  admit?: (envelope: CampaignEnvelope) => Promise<CampaignEnvelope | null> | CampaignEnvelope | null;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const tierRank = (tier: ProfileTier): number => PROFILE_TIERS.indexOf(tier);

const DESIGNER: SeatRef = { seat: "designer", instance: "designer" };
const STAKEHOLDER: SeatRef = { seat: "stakeholder", instance: "stakeholder" };
const AUDITOR_1: SeatRef = { seat: "auditor", instance: "auditor:1" };
const AUDITOR_2: SeatRef = { seat: "auditor", instance: "auditor:2" };
const READERS: SeatRef[] = [
  { seat: "reader", instance: "reader:operator" },
  { seat: "reader", instance: "reader:new-engineer" },
  { seat: "reader", instance: "reader:coding-agent" },
];

const CROSS_PROVIDER: IndependenceRequirement[] = [
  { from: STAKEHOLDER, dimensions: ["provider", "model", "session"] },
];
const FRESH_FROM_DESIGNER: IndependenceRequirement[] = [{ from: DESIGNER, dimensions: ["session"] }];

// ── output schemas ───────────────────────────────────────────────────────────

const FILE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["path", "content"],
  properties: { path: { type: "string", minLength: 1 }, content: { type: "string" } },
};

export const DESIGNER_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["marker"],
  properties: {
    marker: { enum: ["CONTINUE", "CAMPAIGN-COMPLETE", "AWAITING-HUMAN"] },
    files: { type: "array", items: FILE_SCHEMA },
    escalation: {
      type: "object",
      required: ["minimumProfile", "reason"],
      properties: { minimumProfile: { enum: [...PROFILE_TIERS] }, reason: { type: "string", minLength: 1 } },
    },
    dispositions: {
      type: "array",
      items: {
        type: "object",
        required: ["findingId", "kind", "note"],
        properties: {
          findingId: { type: "string", minLength: 1 },
          kind: { enum: ["fixed", "disputed", "deferred"] },
          note: { type: "string" },
        },
      },
    },
  },
};

export const STAKEHOLDER_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["message", "approved"],
  properties: { message: { type: "string", minLength: 1 }, approved: { type: "boolean" } },
};

export const AUDITOR_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["verdict", "findings"],
  properties: {
    verdict: { enum: ["clean", "clean-with-reservations", "clean-with-disputes", "reservations"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "tier", "title"],
        properties: {
          id: { type: "string", minLength: 1 },
          tier: { enum: ["blocking", "significant", "minor"] },
          title: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export const READER_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["gaps"],
  properties: { gaps: { type: "array", items: { type: "string" } } },
};

// ── envelope construction ────────────────────────────────────────────────────

const t = (from: string, to: string, seat: SeatRef, turnCost = 1): EnvelopeTransition => ({ from, to, seat, turnCost });

function profileShape(profile: ProfileTier): Pick<CampaignEnvelope, "shape" | "seats" | "states" | "transitions" | "terminals" | "limits"> {
  const designerSeat = { seat: DESIGNER, session: "persistent" as const, independence: CROSS_PROVIDER };
  const stakeholderSeat = {
    seat: STAKEHOLDER,
    session: "persistent" as const,
    independence: [{ from: DESIGNER, dimensions: ["provider", "model", "session"] as ("provider" | "model" | "session")[] }],
  };
  const freshSeat = (seat: SeatRef, priorFresh: SeatRef[]) => ({
    seat,
    session: "fresh" as const,
    independence: [
      ...FRESH_FROM_DESIGNER,
      ...priorFresh.map((from) => ({ from, dimensions: ["session"] as ("provider" | "model" | "session")[] })),
    ],
  });
  switch (profile) {
    case "C0":
      return {
        shape: "sequence",
        seats: [{ seat: DESIGNER, session: "persistent", independence: [] }],
        states: ["start", "done"],
        transitions: [t("start", "done", DESIGNER)],
        terminals: ["done"],
        limits: { maxTurns: 1, maxWallMs: 30 * 60_000 },
      };
    case "C1":
      return {
        shape: "sequence",
        seats: [{ seat: DESIGNER, session: "persistent", independence: [] }, freshSeat(AUDITOR_1, [])],
        states: ["start", "designed", "done"],
        transitions: [t("start", "designed", DESIGNER), t("designed", "done", AUDITOR_1)],
        terminals: ["done"],
        limits: { maxTurns: 2, maxWallMs: 60 * 60_000, maxAuditIterations: 1 },
      };
    case "C2":
      return {
        shape: "sequence",
        seats: [designerSeat, stakeholderSeat, freshSeat(AUDITOR_1, [])],
        states: ["start", "drafted", "challenged", "revised", "done"],
        transitions: [
          t("start", "drafted", DESIGNER),
          t("drafted", "challenged", STAKEHOLDER),
          t("challenged", "revised", DESIGNER),
          t("revised", "done", AUDITOR_1),
        ],
        terminals: ["done"],
        limits: { maxTurns: 4, maxWallMs: 2 * 60 * 60_000, maxAuditIterations: 1 },
      };
    default: {
      const readerSeats = READERS.map((reader, index) => freshSeat(reader, READERS.slice(0, index)));
      return {
        shape: "graph",
        seats: [designerSeat, stakeholderSeat, ...readerSeats, freshSeat(AUDITOR_1, READERS), freshSeat(AUDITOR_2, [...READERS, AUDITOR_1])],
        states: [
          "start",
          "relay:designer",
          "relay:stakeholder",
          "readers:1",
          "readers:2",
          "readers:3",
          "audit:1",
          "dispositions",
          "feedback",
          "audit:2",
          "done",
        ],
        transitions: [
          t("start", "relay:designer", DESIGNER),
          t("relay:designer", "relay:stakeholder", STAKEHOLDER),
          t("relay:stakeholder", "relay:designer", DESIGNER),
          t("relay:designer", "readers:1", READERS[0] as SeatRef),
          t("readers:1", "readers:2", READERS[1] as SeatRef),
          t("readers:2", "readers:3", READERS[2] as SeatRef),
          t("readers:3", "relay:designer", DESIGNER),
          t("relay:designer", "audit:1", AUDITOR_1),
          t("audit:1", "done", DESIGNER),
          t("audit:1", "dispositions", DESIGNER),
          t("dispositions", "feedback", STAKEHOLDER),
          t("feedback", "dispositions", DESIGNER),
          t("feedback", "audit:2", AUDITOR_2),
          t("audit:2", "done", DESIGNER),
        ],
        terminals: ["done"],
        limits: {
          maxTurns: 84,
          maxWallMs: 300 * 60_000,
          maxRelayExchanges: 60,
          maxReaderTurns: 3,
          maxAuditIterations: 2,
          maxStakeholderExchangesPerAuditWindow: 12,
        },
      };
    }
  }
}

function outputSchemas(profile: ProfileTier): Record<string, JsonSchema> {
  const base: Record<string, JsonSchema> = { designer: DESIGNER_OUTPUT_SCHEMA, auditor: AUDITOR_OUTPUT_SCHEMA };
  if (profile === "C2" || profile === "C3" || profile === "C4") base.stakeholder = STAKEHOLDER_OUTPUT_SCHEMA;
  if (profile === "C3" || profile === "C4") base.reader = READER_OUTPUT_SCHEMA;
  return base;
}

export function buildEnvelope(request: DesignRequest, sourceRevision: string): CampaignEnvelope {
  const shape = profileShape(request.profile);
  const limits = { ...shape.limits };
  for (const [key, value] of Object.entries(request.limits ?? {})) {
    if (typeof value !== "number") continue;
    const current = (limits as Record<string, number | undefined>)[key];
    if (current !== undefined && value > current) {
      throw invalidInput(`limits.${key} may only tighten the declared bound (${current}), got ${value}`, { key });
    }
    (limits as Record<string, number | undefined>)[key] = value;
  }
  return {
    schema: DESIGN_RUN_SCHEMA,
    kind: "envelope",
    profile: request.profile,
    packageVersion: CORE_PACKAGE_VERSION,
    methodVersion: METHOD_VERSION,
    sourceRevision,
    inputIdentity: sha256(canonicalJson({ runId: request.runId, profile: request.profile, intake: request.intake, mode: request.mode ?? "greenfield", sourceRevision })),
    shape: shape.shape,
    seats: shape.seats,
    states: shape.states,
    transitions: shape.transitions,
    terminals: shape.terminals,
    outputSchemas: outputSchemas(request.profile),
    limits,
  };
}

/** The admitted envelope may only tighten limits; anything else is a mutation. */
function assertAdmittedEnvelope(declared: CampaignEnvelope, admitted: CampaignEnvelope): void {
  const { limits: declaredLimits, ...declaredRest } = declared;
  const { limits: admittedLimits, ...admittedRest } = admitted;
  if (canonicalJson(declaredRest) !== canonicalJson(admittedRest)) {
    throw invalidInput("The admitted envelope mutates a non-limit field; a host may only tighten limits.");
  }
  for (const [key, value] of Object.entries(admittedLimits)) {
    const declaredValue = (declaredLimits as Record<string, number | undefined>)[key];
    if (typeof value === "number" && typeof declaredValue === "number" && value > declaredValue) {
      throw invalidInput(`The admitted envelope enlarges limits.${key} (${declaredValue} -> ${value}).`);
    }
  }
}

// ── controller ───────────────────────────────────────────────────────────────

interface ControlDecision {
  transition: EnvelopeTransition;
  phase: string;
}

const okReceipts = (checkpoint: CampaignCheckpoint): TurnReceipt[] =>
  checkpoint.receipts.filter((receipt) => receipt.status === "ok");

const lastOutput = (checkpoint: CampaignCheckpoint, seat: SeatRef): Record<string, unknown> | undefined => {
  for (let index = checkpoint.receipts.length - 1; index >= 0; index -= 1) {
    const receipt = checkpoint.receipts[index] as TurnReceipt;
    if (receipt.seat.seat === seat.seat && receipt.seat.instance === seat.instance && receipt.status === "ok") {
      return isRecord(receipt.output) ? receipt.output : undefined;
    }
  }
  return undefined;
};

const countStates = (checkpoint: CampaignCheckpoint, states: string[]): number =>
  okReceipts(checkpoint).filter((receipt) => states.includes(receipt.state)).length;

function pick(envelope: CampaignEnvelope, from: string, to: string): EnvelopeTransition {
  const transition = envelope.transitions.find((item) => item.from === from && item.to === to);
  if (!transition) throw invalidCheckpoint(`No declared transition ${from} -> ${to}; the graph cannot be extended at run time.`);
  return transition;
}

/**
 * Deterministic next-step decision from the checkpoint alone, so a resumed
 * process replays the identical campaign. Returns null at a terminal.
 */
function decide(checkpoint: CampaignCheckpoint): ControlDecision | null {
  const envelope = checkpoint.envelope;
  const position = checkpoint.position;
  if (envelope.terminals.includes(position)) return null;

  if (envelope.shape === "sequence") {
    const transition = envelope.transitions.find((item) => item.from === position);
    if (!transition) throw invalidCheckpoint(`Sequence position ${position} has no outgoing transition.`);
    const phase = transition.seat.seat === "auditor" ? "audit:1" : position === "drafted" ? "challenge" : "design";
    return { transition, phase };
  }

  // C3/C4 graph control.
  const readersDone = countStates(checkpoint, ["readers:1", "readers:2", "readers:3"]) >= 3;
  switch (position) {
    case "start":
      return { transition: pick(envelope, "start", "relay:designer"), phase: "kickoff" };
    case "relay:designer": {
      const designerOutput = lastOutput(checkpoint, DESIGNER);
      const marker = designerOutput?.marker;
      if (marker === "CAMPAIGN-COMPLETE") {
        if (!readersDone) return { transition: pick(envelope, "relay:designer", "readers:1"), phase: "readers" };
        return { transition: pick(envelope, "relay:designer", "audit:1"), phase: "audit:1" };
      }
      return { transition: pick(envelope, "relay:designer", "relay:stakeholder"), phase: "relay" };
    }
    case "relay:stakeholder":
      return { transition: pick(envelope, "relay:stakeholder", "relay:designer"), phase: "relay" };
    case "readers:1":
      return { transition: pick(envelope, "readers:1", "readers:2"), phase: "readers" };
    case "readers:2":
      return { transition: pick(envelope, "readers:2", "readers:3"), phase: "readers" };
    case "readers:3":
      return { transition: pick(envelope, "readers:3", "relay:designer"), phase: "reader-residue" };
    case "audit:1": {
      const audit = lastOutput(checkpoint, AUDITOR_1);
      const findings = Array.isArray(audit?.findings) ? audit.findings : [];
      if (audit?.verdict === "clean" && findings.length === 0) {
        return { transition: pick(envelope, "audit:1", "done"), phase: "final-review" };
      }
      return { transition: pick(envelope, "audit:1", "dispositions"), phase: "dispositions" };
    }
    case "dispositions":
      return { transition: pick(envelope, "dispositions", "feedback"), phase: "audit-feedback" };
    case "feedback": {
      const stakeholder = lastOutput(checkpoint, STAKEHOLDER);
      if (stakeholder?.approved === true) {
        return { transition: pick(envelope, "feedback", "audit:2"), phase: "audit:2" };
      }
      return { transition: pick(envelope, "feedback", "dispositions"), phase: "audit-feedback" };
    }
    case "audit:2":
      return { transition: pick(envelope, "audit:2", "done"), phase: "final-review" };
    default:
      throw invalidCheckpoint(`Unknown campaign position ${position}.`);
  }
}

/** Typed bound enforcement; the engine never buys itself more turns. */
function exhaustedBound(checkpoint: CampaignCheckpoint, decision: ControlDecision): string | null {
  const limits = checkpoint.envelope.limits;
  if (checkpoint.usage.turns >= limits.maxTurns) return `maxTurns (${limits.maxTurns})`;
  if (decision.phase === "relay" && limits.maxRelayExchanges !== undefined) {
    if (countStates(checkpoint, ["relay:designer", "relay:stakeholder"]) >= limits.maxRelayExchanges) {
      return `maxRelayExchanges (${limits.maxRelayExchanges})`;
    }
  }
  if (decision.phase === "audit-feedback" && limits.maxStakeholderExchangesPerAuditWindow !== undefined) {
    if (countStates(checkpoint, ["dispositions", "feedback"]) >= 2 * limits.maxStakeholderExchangesPerAuditWindow) {
      return `maxStakeholderExchangesPerAuditWindow (${limits.maxStakeholderExchangesPerAuditWindow})`;
    }
  }
  return null;
}

// ── prompts ──────────────────────────────────────────────────────────────────

function promptFor(phase: string, seat: SeatRef, request: { profile: ProfileTier; intake: string; mode: string }): string {
  const header = `Validation Architect campaign (profile ${request.profile}, ${request.mode}). Phase: ${phase}. Seat: ${seat.seat}:${seat.instance}.`;
  const intake = `Intake:\n${request.intake}`;
  const contract =
    seat.seat === "designer"
      ? "Return JSON matching the designer output schema: marker, corpus files under validation-design/, optional escalation."
      : seat.seat === "stakeholder"
        ? "Challenge the design as the product owner. Return JSON: message, approved."
        : seat.seat === "auditor"
          ? "Audit the corpus independently. Return JSON: verdict, findings[]."
          : "Read only the artifacts; report gaps. Return JSON: gaps[].";
  return `${header}\n${intake}\n${contract}`;
}

// ── identity, sessions, structured output ────────────────────────────────────

function seatKey(seat: SeatRef): string {
  return `${seat.seat}:${seat.instance}`;
}

function recordedIdentity(checkpoint: CampaignCheckpoint, seat: SeatRef): ExecutionIdentity | undefined {
  for (let index = checkpoint.receipts.length - 1; index >= 0; index -= 1) {
    const receipt = checkpoint.receipts[index] as TurnReceipt;
    if (seatKey(receipt.seat) === seatKey(seat) && receipt.identity) return receipt.identity;
  }
  return undefined;
}

function verifyIdentity(
  checkpoint: CampaignCheckpoint,
  request: TurnRequest,
  identity: ExecutionIdentity,
): void {
  // A resumed persistent seat must stay in its exact native session and keep
  // a stable provider/model identity.
  if (request.session.mode === "resume" && identity.session !== request.session.sessionId) {
    throw identityMismatch(
      `Seat ${seatKey(request.seat)} was asked to resume session ${request.session.sessionId} but returned ${identity.session}.`,
      { seat: request.seat },
    );
  }
  const prior = recordedIdentity(checkpoint, request.seat);
  if (prior && request.session.mode === "resume") {
    if (prior.provider !== identity.provider || prior.model !== identity.model) {
      throw identityMismatch(`Seat ${seatKey(request.seat)} changed provider/model mid-session.`, { seat: request.seat });
    }
  }
  for (const requirement of request.independence) {
    const other = recordedIdentity(checkpoint, requirement.from);
    if (!other) continue;
    for (const dimension of requirement.dimensions) {
      if (identity[dimension] === other[dimension]) {
        throw identityMismatch(
          `Seat ${seatKey(request.seat)} must be ${dimension}-independent from ${seatKey(requirement.from)}, but both returned ${identity[dimension]}.`,
          { seat: request.seat, dimension },
        );
      }
    }
  }
}

/** Parse and validate structured output from the turn text; a host-supplied
 * `parsed` value is never trusted. */
function structuredOutput(text: string, schema: JsonSchema | undefined): { output?: unknown; problems: string[] } {
  if (!schema) return { problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problems: ["turn text is not parseable JSON for the requested output schema"] };
  }
  const problems = validateAgainstSchema(parsed, schema);
  return problems.length > 0 ? { problems } : { output: parsed, problems: [] };
}

// ── artifact checks ──────────────────────────────────────────────────────────

const DESIGN_PREFIX = "validation-design/";

function artifactProblems(files: Array<{ path: string; content: string }>, merged: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!safeRepositoryPath(file.path) || !file.path.startsWith(DESIGN_PREFIX)) {
      problems.push(`artifact path ${file.path} must sit beneath ${DESIGN_PREFIX} with no traversal`);
    }
  }
  if (problems.length > 0) return problems;
  const modelFiles: Partial<ModelFileSet> = {};
  for (const file of MODEL_FILES) {
    const content = merged[`${DESIGN_PREFIX}model/${file}`];
    if (content !== undefined) modelFiles[file] = content;
  }
  if (Object.keys(modelFiles).length > 0) {
    const validated = validateCorpus(modelFiles);
    if (!validated.valid) problems.push(...validated.problems.map((item) => `corpus: ${item}`));
  }
  return problems;
}

/** The final designer artifact set must be a complete, compiling corpus. */
function completionProblems(artifacts: Record<string, string>): string[] {
  const missing = MODEL_FILES.filter((file) => artifacts[`${DESIGN_PREFIX}model/${file}`] === undefined);
  if (missing.length > 0) return [`corpus is missing required model file(s): ${missing.join(", ")}`];
  return [];
}

// ── bundle production ────────────────────────────────────────────────────────

function mapAuditVerdict(internal: string): PublicAuditVerdict {
  // Lossless: the legacy internal "clean-with-disputes" surfaces publicly as
  // clean-with-reservations; the dispute evidence stays in the findings.
  return internal === "clean" ? "clean" : internal === "reservations" ? "reservations" : "clean-with-reservations";
}

function bundleAudit(checkpoint: CampaignCheckpoint): BundleAudit {
  if (checkpoint.envelope.profile === "C0") return { status: "not_required_by_profile" };
  const auditors = [AUDITOR_2, AUDITOR_1];
  for (const auditor of auditors) {
    const output = lastOutput(checkpoint, auditor);
    if (output) {
      const findings = (Array.isArray(output.findings) ? output.findings : []) as AuditFindingRecord[];
      const iteration = auditor === AUDITOR_2 ? 2 : 1;
      return {
        status: "performed",
        verdict: mapAuditVerdict(String(output.verdict)),
        findings: findings.map((finding) => ({ ...finding, iteration })),
      };
    }
  }
  throw invalidCheckpoint("Campaign reached its terminal without the profile-required audit receipt.");
}

function escalation(checkpoint: CampaignCheckpoint): { minimum: ProfileTier; required: boolean } {
  const selected = checkpoint.envelope.profile;
  let minimum: ProfileTier = selected;
  const designer = lastOutput(checkpoint, DESIGNER);
  const reported = isRecord(designer?.escalation) ? designer.escalation.minimumProfile : undefined;
  if (typeof reported === "string" && PROFILE_TIERS.includes(reported as ProfileTier)) {
    if (tierRank(reported as ProfileTier) > tierRank(minimum)) minimum = reported as ProfileTier;
  }
  const projectYaml = checkpoint.artifacts[`${DESIGN_PREFIX}model/project.yaml`];
  if (projectYaml) {
    const declared = projectYaml.match(/criticality:\s*["']?(C[0-4])["']?/)?.[1] as CriticalityTier | undefined;
    if (declared && tierRank(declared) > tierRank(minimum)) minimum = declared;
  }
  return { minimum, required: tierRank(minimum) > tierRank(selected) };
}

function produceBundle(checkpoint: CampaignCheckpoint): DesignBundle {
  const { minimum, required } = escalation(checkpoint);
  return {
    files: Object.entries(checkpoint.artifacts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({ path, content })),
    provenance: {
      schema: PROVENANCE_SCHEMA,
      packageVersion: checkpoint.packageVersion,
      methodVersion: checkpoint.envelope.methodVersion,
      schemas: { ...PUBLISHED_SCHEMA_IDS },
      profile: checkpoint.envelope.profile,
      sourceRevision: checkpoint.sourceRevision,
      runId: checkpoint.runId,
    },
    profileAssessment: {
      selected: checkpoint.envelope.profile,
      minimumSupportedByFindings: minimum,
      escalationRequired: required,
    },
    audit: bundleAudit(checkpoint),
    usage: { ...checkpoint.usage },
  };
}

// ── the engine loop ──────────────────────────────────────────────────────────

interface EngineContext {
  ports: DesignPorts;
  intake: { profile: ProfileTier; intake: string; mode: string };
}

function incomplete(checkpoint: CampaignCheckpoint, reason: IncompleteReason, nextAction: string): DesignOutcome {
  return { status: "incomplete", checkpoint, reason, nextAction };
}

async function saveNext(
  store: CampaignStorePort,
  checkpoint: CampaignCheckpoint,
  mutate: (next: CampaignCheckpoint) => void,
): Promise<CampaignCheckpoint> {
  const next = structuredClone(checkpoint);
  next.generation = checkpoint.generation + 1;
  mutate(next);
  await store.save(next, checkpoint.generation);
  return next;
}

async function runLoop(checkpoint: CampaignCheckpoint, context: EngineContext): Promise<DesignOutcome> {
  const { ports } = context;
  let current = checkpoint;

  // A pending turn from a prior process is reconciled first: the same
  // idempotency key is replayed and must settle without a second spend.
  while (true) {
    if (current.pendingTurn) {
      const request = current.pendingTurn.request;
      const outcome = await settleTurn(current, request, context);
      if (outcome.kind === "incomplete") return outcome.outcome;
      current = outcome.checkpoint;
      continue;
    }

    // A failed run is a failed run: a settled non-ok or rejected-artifact
    // turn stays the campaign's outcome; resume never spends a recovery turn.
    const last = current.receipts[current.receipts.length - 1];
    if (last && last.status !== "ok") {
      const reason: IncompleteReason =
        last.status === "refused" ? "turn_refused" : last.status === "limit_exhausted" ? "limit_exhausted" : "turn_error";
      return incomplete(
        current,
        reason,
        `Seat ${seatKey(last.seat)} settled ${last.status} at ${last.state}; this campaign is a typed failure. Start a deliberate new campaign to try again.`,
      );
    }
    if (last && last.status === "ok" && last.state !== current.position && !current.envelope.terminals.includes(current.position)) {
      return incomplete(
        current,
        "invalid_artifact",
        `Seat ${seatKey(last.seat)} produced output that failed deterministic validation; the campaign did not advance and no recovery turn is added.`,
      );
    }

    const decision = decide(current);
    if (decision === null) {
      const missing = completionProblems(current.artifacts);
      if (missing.length > 0) {
        return incomplete(current, "invalid_artifact", `The terminal corpus is incomplete: ${missing.join("; ")}`);
      }
      return { status: "complete", bundle: produceBundle(current) };
    }

    const bound = exhaustedBound(current, decision);
    if (bound) {
      return incomplete(current, "limit_exhausted", `Declared bound ${bound} is exhausted; the library never extends its own envelope. A deliberate new campaign with a deeper budget is the only continuation.`);
    }

    const seat = decision.transition.seat;
    const seatSpec = current.envelope.seats.find((item) => seatKey(item.seat) === seatKey(seat));
    if (!seatSpec) throw invalidCheckpoint(`Transition names undeclared seat ${seatKey(seat)}.`);
    const existingSession = current.sessions[seatKey(seat)];
    const session =
      seatSpec.session === "persistent" && existingSession ? { mode: "resume" as const, sessionId: existingSession } : { mode: "new" as const };
    const schemaKey = seat.seat;
    const request: TurnRequest = {
      seat,
      independence: seatSpec.independence,
      session,
      idempotencyKey: `${current.runId}:turn:${current.receipts.length + 1}`,
      prompt: promptFor(decision.phase, seat, context.intake),
      ...(current.envelope.outputSchemas[schemaKey] ? { outputSchema: current.envelope.outputSchemas[schemaKey] } : {}),
      limits: {},
      metadata: { runId: current.runId, phase: decision.phase, turnIndex: current.receipts.length + 1 },
    };

    // Save the exact pending request BEFORE invoking the turn (crash window).
    current = await saveNext(ports.store, current, (next) => {
      next.pendingTurn = { idempotencyKey: request.idempotencyKey, request };
    });
  }
}

async function settleTurn(
  current: CampaignCheckpoint,
  request: TurnRequest,
  context: EngineContext,
): Promise<{ kind: "ok"; checkpoint: CampaignCheckpoint } | { kind: "incomplete"; outcome: DesignOutcome }> {
  const { ports } = context;
  const result: TurnResult = await ports.turns.runTurn(request);
  const shapeProblems: string[] = [];
  validateTurnResult(result, shapeProblems);
  assertValid("TurnResult", shapeProblems);

  // Re-derive the decided transition deterministically: two transitions out
  // of one state may share a seat (audit:1 -> done vs dispositions), and the
  // controller's decision is a pure function of the checkpoint.
  const decision = decide(current);
  if (!decision || seatKey(decision.transition.seat) !== seatKey(request.seat)) {
    throw invalidCheckpoint(`Pending turn does not match the controller's decision at ${current.position}.`);
  }
  const transition = decision.transition;

  const baseReceipt = {
    idempotencyKey: request.idempotencyKey,
    seat: request.seat,
    state: transition.to,
    usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
  };

  if (result.status !== "ok") {
    const reason: IncompleteReason =
      result.status === "refused" ? "turn_refused" : result.status === "limit_exhausted" ? "limit_exhausted" : "turn_error";
    const settled = await saveNext(ports.store, current, (next) => {
      delete next.pendingTurn;
      next.receipts.push({ ...baseReceipt, status: result.status, ...(result.identity ? { identity: result.identity } : {}) });
      next.usage.turns += 1;
      next.usage.inputTokens += result.usage?.inputTokens ?? 0;
      next.usage.outputTokens += result.usage?.outputTokens ?? 0;
    });
    return {
      kind: "incomplete",
      outcome: incomplete(
        settled,
        reason,
        `Seat ${seatKey(request.seat)} returned ${result.status}: ${result.reason}. The engine does not retry, substitute a seat, or add a recovery turn; resume after the host resolves the cause.`,
      ),
    };
  }

  verifyIdentity(current, request, result.identity);

  const { output, problems } = structuredOutput(result.text, request.outputSchema);
  let artifactFailures: string[] = [];
  const files = isRecord(output) && Array.isArray(output.files) ? (output.files as Array<{ path: string; content: string }>) : [];
  const mergedArtifacts = { ...current.artifacts };
  if (problems.length === 0 && files.length > 0) {
    for (const file of files) mergedArtifacts[file.path] = file.content;
    artifactFailures = artifactProblems(files, mergedArtifacts);
  }

  const invalid = [...problems, ...artifactFailures];
  const settled = await saveNext(ports.store, current, (next) => {
    delete next.pendingTurn;
    next.receipts.push({
      ...baseReceipt,
      status: "ok",
      identity: result.identity,
      textDigest: sha256(result.text),
      ...(output !== undefined ? { output } : {}),
    });
    next.usage.turns += 1;
    next.usage.inputTokens += result.usage?.inputTokens ?? 0;
    next.usage.outputTokens += result.usage?.outputTokens ?? 0;
    if (invalid.length === 0) {
      next.position = transition.to;
      next.sessions[seatKey(request.seat)] = result.identity.session;
      next.artifacts = mergedArtifacts;
    }
  });

  if (invalid.length > 0) {
    return {
      kind: "incomplete",
      outcome: incomplete(
        settled,
        "invalid_artifact",
        `Seat ${seatKey(request.seat)} produced invalid output: ${invalid.join("; ")}. No thin bundle is manufactured; revise and resume deliberately.`,
      ),
    };
  }
  return { kind: "ok", checkpoint: settled };
}

// ── public operations ────────────────────────────────────────────────────────

export async function design(request: DesignRequest, ports: DesignPorts): Promise<DesignOutcome> {
  const problems: string[] = [];
  requireString(request?.runId, "request.runId", problems);
  requireEnum(request?.profile, "request.profile", PROFILE_TIERS, problems);
  requireString(request?.intake, "request.intake", problems);
  if (request?.mode !== undefined) requireEnum(request.mode, "request.mode", ["greenfield", "revision"] as const, problems);
  assertValid("design request", problems);

  const revision = await ports.repository.revision();
  const declared = buildEnvelope(request, revision);
  let admitted = declared;
  if (request.admit) {
    const answer = await request.admit(structuredClone(declared));
    if (answer === null) {
      throw invalidInput(`Run ${request.runId} was not admitted; zero turns were spent.`, { runId: request.runId });
    }
    assertAdmittedEnvelope(declared, answer);
    admitted = answer;
  }

  if ((await ports.store.load(request.runId)) !== null) {
    throw invalidInput(`Run ${request.runId} already has a checkpoint; use resume(runId, ports).`, { runId: request.runId });
  }

  const initial: CampaignCheckpoint = {
    schema: DESIGN_RUN_SCHEMA,
    kind: "checkpoint",
    runId: request.runId,
    generation: 1,
    packageVersion: CORE_PACKAGE_VERSION,
    sourceRevision: revision,
    envelope: admitted,
    position: "start",
    receipts: [],
    sessions: {},
    artifacts: {},
    intake: request.intake,
    usage: { turns: 0, inputTokens: 0, outputTokens: 0 },
  };
  await ports.store.save(initial, 0);

  return runLoop(initial, {
    ports,
    intake: { profile: request.profile, intake: request.intake, mode: request.mode ?? "greenfield" },
  });
}

export async function resume(runId: string, ports: DesignPorts): Promise<DesignOutcome> {
  const problems: string[] = [];
  requireString(runId, "runId", problems);
  assertValid("resume request", problems);

  const raw = await ports.store.load(runId);
  if (raw === null) throw invalidInput(`Run ${runId} has no checkpoint to resume.`, { runId });
  const checkpoint = validateDesignRunCheckpoint(raw);

  if (checkpoint.packageVersion !== CORE_PACKAGE_VERSION) {
    throw versionMismatch(
      `Run ${runId} was begun by package ${checkpoint.packageVersion}; resume requires that exact version (current: ${CORE_PACKAGE_VERSION}).`,
      { expected: checkpoint.packageVersion, actual: CORE_PACKAGE_VERSION },
    );
  }
  const revision = await ports.repository.revision();
  if (checkpoint.sourceRevision !== revision) {
    throw versionMismatch(
      `Run ${runId} is bound to source revision ${checkpoint.sourceRevision}, but the repository is at ${revision}.`,
      { expected: checkpoint.sourceRevision, actual: revision },
    );
  }

  const rebuilt = buildEnvelope(
    {
      runId,
      profile: checkpoint.envelope.profile,
      intake: "",
      mode: "greenfield",
    },
    revision,
  );
  // Structural integrity: states/transitions/terminals must be the declared
  // shape for the profile — a mutated envelope is refused before any turn.
  if (
    canonicalJson({ s: rebuilt.states, t: rebuilt.transitions, x: rebuilt.terminals }) !==
    canonicalJson({ s: checkpoint.envelope.states, t: checkpoint.envelope.transitions, x: checkpoint.envelope.terminals })
  ) {
    throw invalidCheckpoint(`Run ${runId} carries a mutated envelope shape and cannot be resumed.`, { runId });
  }

  return runLoop(checkpoint, {
    ports,
    intake: { profile: checkpoint.envelope.profile, intake: checkpoint.intake ?? "", mode: "resume" },
  });
}
