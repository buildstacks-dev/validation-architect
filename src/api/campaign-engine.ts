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
import { CORE_PACKAGE_VERSION } from "../versions.js";
import {
  DESIGN_RUN_SCHEMA,
  MAX_PROVIDER_TURN_WALL_MS,
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
  type RepositorySnapshot,
  type TurnReceipt,
  validateDesignBundle,
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
import { validateTurnResult, validateTurnSettlement } from "./ports.js";
import {
  PUBLISHED_SCHEMA_IDS,
  canonicalJson,
  validateCorpus,
  validateDesignRunCheckpoint,
  validateDesignRunEnvelope,
} from "./schemas.js";
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
  intake?: string;
  /** Greenfield corpus or deliberate revision of the current one. */
  mode?: "greenfield" | "revision";
  /** Host tightening of the declared limits; enlargement is refused. */
  limits?: Partial<CampaignEnvelope["limits"]>;
  /**
   * Pre-spend admission: inspect the envelope and return it (optionally with
   * further-tightened limits) to admit, or null to refuse. No TurnPort call
   * happens before this resolves to an admitted envelope.
   */
  admit: (envelope: CampaignEnvelope) => Promise<CampaignEnvelope | null> | CampaignEnvelope | null;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const tierRank = (tier: ProfileTier): number => PROFILE_TIERS.indexOf(tier);
const REPOSITORY_CONTEXT_GLOBS = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "docs/**",
  "research/**",
  "src/**",
  "tests/**",
  "test/**",
  "validation-design/**",
] as const;
const MAX_REPOSITORY_INVENTORY_FILES = 20_000;
const MAX_REPOSITORY_CONTEXT_FILES = 512;
const MAX_REPOSITORY_CONTEXT_BYTES = 384 * 1024;

function repositorySnapshotIdentity(snapshot: Pick<RepositorySnapshot, "inventory" | "files">): string {
  return sha256(canonicalJson(snapshot));
}

async function captureRepository(repository: RepositoryPort): Promise<RepositorySnapshot> {
  const revision = await repository.revision();
  if (typeof revision !== "string" || revision.length === 0) {
    throw invalidInput("RepositoryPort.revision() must return an exact non-empty revision before admission.");
  }
  const inventory = [...new Set(await repository.listFiles([...REPOSITORY_CONTEXT_GLOBS]))].sort();
  if (inventory.length > MAX_REPOSITORY_INVENTORY_FILES) {
    throw invalidInput(`Repository context has ${inventory.length} files; the admitted inventory maximum is ${MAX_REPOSITORY_INVENTORY_FILES}.`, {
      files: inventory.length,
    });
  }
  for (const path of inventory) {
    if (!safeRepositoryPath(path)) throw invalidInput(`RepositoryPort.listFiles returned unsafe path ${path}`, { path });
  }
  const priority = (path: string): number => path.startsWith("validation-design/")
    ? 0
    : /^(README\.md|AGENTS\.md|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(path)
      ? 1
      : path.startsWith("docs/") || path.startsWith("research/")
        ? 2
        : path.startsWith("test")
          ? 3
          : 4;
  const contentPaths = [...inventory].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  const files: RepositorySnapshot["files"] = [];
  let bytes = 0;
  for (const path of contentPaths) {
    if (files.length >= MAX_REPOSITORY_CONTEXT_FILES && !path.startsWith(DESIGN_PREFIX)) continue;
    const content = await repository.readFile(path);
    if (content === null || content.includes("\0")) continue;
    const nextBytes = bytes + Buffer.byteLength(content, "utf8");
    if (nextBytes > MAX_REPOSITORY_CONTEXT_BYTES) {
      if (path.startsWith(DESIGN_PREFIX)) {
        throw invalidInput(`Existing design corpus exceeds the ${MAX_REPOSITORY_CONTEXT_BYTES}-byte campaign context bound.`, {
          bytes: nextBytes,
        });
      }
      continue;
    }
    bytes = nextBytes;
    files.push({ path, content });
  }
  if (files.length > MAX_REPOSITORY_CONTEXT_FILES) {
    throw invalidInput(`Existing design corpus has too many files for campaign context (${files.length}).`, {
      files: files.length,
    });
  }
  const after = await repository.revision();
  if (after !== revision) {
    throw versionMismatch("Repository revision changed while campaign context was captured.", {
      expected: revision,
      actual: after,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { revision, identity: repositorySnapshotIdentity({ inventory, files }), inventory, files };
}

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
  additionalProperties: false,
  properties: { path: { type: "string", minLength: 1 }, content: { type: "string" } },
};

export const DESIGNER_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["marker"],
  additionalProperties: false,
  properties: {
    marker: { enum: ["CONTINUE", "CAMPAIGN-COMPLETE", "AWAITING-HUMAN"] },
    files: { type: "array", items: FILE_SCHEMA },
    escalation: {
      type: "object",
      required: ["minimumProfile", "reason"],
      additionalProperties: false,
      properties: { minimumProfile: { enum: [...PROFILE_TIERS] }, reason: { type: "string", minLength: 1 } },
    },
    dispositions: {
      type: "array",
      items: {
        type: "object",
        required: ["findingId", "kind", "note"],
        additionalProperties: false,
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
  additionalProperties: false,
  properties: { message: { type: "string", minLength: 1 }, approved: { type: "boolean" } },
};

export const AUDITOR_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["verdict", "findings"],
  additionalProperties: false,
  properties: {
    verdict: { enum: ["clean", "clean-with-reservations", "clean-with-disputes", "reservations"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "tier", "title"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          tier: { enum: ["blocking", "significant", "minor"] },
          title: { type: "string", minLength: 1 },
        },
      },
    },
    verification: {
      type: "array",
      items: {
        type: "object",
        required: ["findingId", "status"],
        additionalProperties: false,
        properties: {
          findingId: { type: "string", minLength: 1 },
          status: { enum: ["fixed", "not-fixed", "disputed"] },
        },
      },
    },
  },
};

export const READER_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["findings"],
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "tier", "title"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          tier: { enum: ["blocking", "significant", "minor"] },
          title: { type: "string", minLength: 1 },
        },
      },
    },
  },
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
        limits: { maxTurns: 1, maxWallMs: 30 * 60_000, maxTokensPerTurn: 32_768 },
      };
    case "C1":
      return {
        shape: "sequence",
        seats: [{ seat: DESIGNER, session: "persistent", independence: [] }, freshSeat(AUDITOR_1, [])],
        states: ["start", "designed", "done"],
        transitions: [t("start", "designed", DESIGNER), t("designed", "done", AUDITOR_1)],
        terminals: ["done"],
        limits: { maxTurns: 2, maxWallMs: 60 * 60_000, maxTokensPerTurn: 32_768, maxAuditIterations: 1 },
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
        limits: { maxTurns: 4, maxWallMs: 2 * 60 * 60_000, maxTokensPerTurn: 32_768, maxAuditIterations: 1 },
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
          "reader:designer",
          "reader:stakeholder",
          "reader:residue",
          "reader:residue-confirm",
          "audit:1",
          "dispositions",
          "feedback",
          "audit:2",
          "audit-record",
          "done",
        ],
        transitions: [
          t("start", "relay:designer", DESIGNER),
          t("relay:designer", "relay:stakeholder", STAKEHOLDER),
          t("relay:stakeholder", "relay:designer", DESIGNER),
          t("relay:designer", "readers:1", READERS[0] as SeatRef),
          t("readers:1", "readers:2", READERS[1] as SeatRef),
          t("readers:2", "readers:3", READERS[2] as SeatRef),
          t("readers:3", "reader:designer", DESIGNER),
          t("readers:3", "reader:residue", DESIGNER),
          t("reader:designer", "reader:stakeholder", STAKEHOLDER),
          t("reader:stakeholder", "readers:1", READERS[0] as SeatRef),
          t("reader:residue", "reader:residue-confirm", STAKEHOLDER),
          t("reader:residue-confirm", "readers:1", READERS[0] as SeatRef),
          t("reader:residue-confirm", "audit:1", AUDITOR_1),
          t("audit:1", "audit-record", DESIGNER),
          t("audit:1", "dispositions", DESIGNER),
          t("dispositions", "feedback", STAKEHOLDER),
          t("feedback", "dispositions", DESIGNER),
          t("feedback", "audit:2", AUDITOR_2),
          t("audit:2", "audit-record", DESIGNER),
          t("audit-record", "done", STAKEHOLDER),
        ],
        terminals: ["done"],
        limits: {
          // kickoff + relay + three reader rounds and ratifications + two
          // audits + the bounded disposition window + final record/owner gate
          maxTurns: 104,
          maxWallMs: 300 * 60_000,
          maxTokensPerTurn: 32_768,
          maxRelayExchanges: 60,
          maxReaderTurns: 9,
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

export function buildEnvelope(
  request: DesignRequest,
  sourceRevision: string,
  repositoryIdentity = sha256(`repository:${sourceRevision}`),
): CampaignEnvelope {
  const shape = profileShape(request.profile);
  const limits = { ...shape.limits };
  for (const [key, value] of Object.entries(request.limits ?? {})) {
    const current = (limits as Record<string, number | undefined>)[key];
    if (current === undefined) throw invalidInput(`Unknown campaign limit ${key}`, { key });
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw invalidInput(`limits.${key} must be a positive integer`, { key, value });
    }
    if (value > current) {
      throw invalidInput(`limits.${key} may only tighten the declared bound (${current}), got ${value}`, { key });
    }
    (limits as Record<string, number | undefined>)[key] = value;
  }
  const envelope: CampaignEnvelope = {
    schema: DESIGN_RUN_SCHEMA,
    kind: "envelope",
    profile: request.profile,
    packageVersion: CORE_PACKAGE_VERSION,
    sourceRevision,
    inputIdentity: sha256(canonicalJson({
      runId: request.runId,
      profile: request.profile,
      intake: request.intake ?? "",
      mode: request.mode ?? "greenfield",
      sourceRevision,
      repositoryIdentity,
    })),
    shape: shape.shape,
    seats: shape.seats,
    states: shape.states,
    transitions: shape.transitions,
    terminals: shape.terminals,
    outputSchemas: outputSchemas(request.profile),
    limits,
  };
  validateDesignRunEnvelope(envelope);
  return envelope;
}

/** The admitted envelope may only tighten limits; anything else is a mutation. */
function assertAdmittedEnvelope(declared: CampaignEnvelope, admitted: CampaignEnvelope): void {
  validateDesignRunEnvelope(admitted);
  const { limits: declaredLimits, ...declaredRest } = declared;
  const { limits: admittedLimits, ...admittedRest } = admitted;
  if (canonicalJson(declaredRest) !== canonicalJson(admittedRest)) {
    throw invalidInput("The admitted envelope mutates a non-limit field; a host may only tighten limits.");
  }
  if (canonicalJson(Object.keys(declaredLimits).sort()) !== canonicalJson(Object.keys(admittedLimits).sort())) {
    throw invalidInput("The admitted envelope must preserve every declared limit key.");
  }
  for (const [key, value] of Object.entries(admittedLimits)) {
    const declaredValue = (declaredLimits as Record<string, number | undefined>)[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || typeof declaredValue !== "number") {
      throw invalidInput(`The admitted envelope has an invalid limits.${key}.`);
    }
    if (value > declaredValue) {
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
  checkpoint.receipts.filter((receipt) => receipt.status === "ok" && receipt.accepted === true);

const lastOutput = (checkpoint: CampaignCheckpoint, seat: SeatRef): Record<string, unknown> | undefined => {
  for (let index = checkpoint.receipts.length - 1; index >= 0; index -= 1) {
    const receipt = checkpoint.receipts[index] as TurnReceipt;
    if (
      receipt.seat.seat === seat.seat &&
      receipt.seat.instance === seat.instance &&
      receipt.status === "ok" &&
      receipt.accepted === true
    ) {
      return isRecord(receipt.output) ? receipt.output : undefined;
    }
  }
  return undefined;
};

function lastOutputFor(
  checkpoint: CampaignCheckpoint,
  predicate: (receipt: TurnReceipt) => boolean,
): Record<string, unknown> | undefined {
  for (let index = checkpoint.receipts.length - 1; index >= 0; index -= 1) {
    const receipt = checkpoint.receipts[index] as TurnReceipt;
    if (receipt.status === "ok" && receipt.accepted === true && predicate(receipt)) {
      return isRecord(receipt.output) ? receipt.output : undefined;
    }
  }
  return undefined;
}

const countStates = (checkpoint: CampaignCheckpoint, states: string[]): number =>
  okReceipts(checkpoint).filter((receipt) => states.includes(receipt.state)).length;

const countSeat = (checkpoint: CampaignCheckpoint, seat: SeatRef["seat"]): number =>
  okReceipts(checkpoint).filter((receipt) => receipt.seat.seat === seat).length;

function currentReaderFindings(checkpoint: CampaignCheckpoint): Array<Record<string, unknown>> {
  const recent = [...okReceipts(checkpoint)].reverse().filter((receipt) => receipt.seat.seat === "reader").slice(0, 3);
  return recent.flatMap((receipt) => {
    const output = isRecord(receipt.output) ? receipt.output : undefined;
    return Array.isArray(output?.findings)
      ? output.findings.filter((finding): finding is Record<string, unknown> => isRecord(finding))
      : [];
  });
}

function ratifiedReaderRounds(checkpoint: CampaignCheckpoint): number {
  let streak = 0;
  for (const receipt of [...okReceipts(checkpoint)].reverse()) {
    if (receipt.seat.seat !== "stakeholder" || !["reader:designer", "reader:residue"].includes(receipt.state)) continue;
    const approved = isRecord(receipt.output) && receipt.output.approved === true;
    if (!approved || receipt.state === "reader:residue") break;
    streak += 1;
  }
  return streak;
}

const auditFeedbackExchanges = (checkpoint: CampaignCheckpoint): number =>
  okReceipts(checkpoint).filter((receipt) => receipt.seat.seat === "stakeholder" && receipt.state === "dispositions").length;

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
  switch (position) {
    case "start":
      return { transition: pick(envelope, "start", "relay:designer"), phase: "kickoff" };
    case "relay:designer": {
      const designerOutput = lastOutput(checkpoint, DESIGNER);
      const marker = designerOutput?.marker;
      if (marker === "CAMPAIGN-COMPLETE") {
        return { transition: pick(envelope, "relay:designer", "readers:1"), phase: "readers" };
      }
      return { transition: pick(envelope, "relay:designer", "relay:stakeholder"), phase: "relay" };
    }
    case "relay:stakeholder":
      return { transition: pick(envelope, "relay:stakeholder", "relay:designer"), phase: "relay" };
    case "readers:1":
      return { transition: pick(envelope, "readers:1", "readers:2"), phase: "readers" };
    case "readers:2":
      return { transition: pick(envelope, "readers:2", "readers:3"), phase: "readers" };
    case "readers:3": {
      const blocking = currentReaderFindings(checkpoint).some((finding) => finding.tier === "blocking");
      if (!blocking && ratifiedReaderRounds(checkpoint) >= 2) {
        return { transition: pick(envelope, "readers:3", "reader:residue"), phase: "reader-residue" };
      }
      return { transition: pick(envelope, "readers:3", "reader:designer"), phase: "reader-revision" };
    }
    case "reader:designer":
      return { transition: pick(envelope, "reader:designer", "reader:stakeholder"), phase: "reader-ratification" };
    case "reader:stakeholder":
      return { transition: pick(envelope, "reader:stakeholder", "readers:1"), phase: "readers" };
    case "reader:residue":
      return { transition: pick(envelope, "reader:residue", "reader:residue-confirm"), phase: "reader-residue-confirm" };
    case "reader:residue-confirm": {
      const stakeholder = lastOutput(checkpoint, STAKEHOLDER);
      return stakeholder?.approved === true
        ? { transition: pick(envelope, "reader:residue-confirm", "audit:1"), phase: "audit:1" }
        : { transition: pick(envelope, "reader:residue-confirm", "readers:1"), phase: "readers" };
    }
    case "audit:1": {
      const audit = lastOutput(checkpoint, AUDITOR_1);
      const findings = Array.isArray(audit?.findings) ? audit.findings : [];
      if (audit?.verdict === "clean" && findings.length === 0) {
        return { transition: pick(envelope, "audit:1", "audit-record"), phase: "audit-record" };
      }
      return { transition: pick(envelope, "audit:1", "dispositions"), phase: "dispositions" };
    }
    case "dispositions":
      return { transition: pick(envelope, "dispositions", "feedback"), phase: "audit-feedback" };
    case "feedback": {
      const stakeholder = lastOutput(checkpoint, STAKEHOLDER);
      if (
        stakeholder?.approved === true ||
        auditFeedbackExchanges(checkpoint) >= (envelope.limits.maxStakeholderExchangesPerAuditWindow ?? 1)
      ) {
        return { transition: pick(envelope, "feedback", "audit:2"), phase: "audit:2" };
      }
      return { transition: pick(envelope, "feedback", "dispositions"), phase: "audit-feedback" };
    }
    case "audit:2":
      return { transition: pick(envelope, "audit:2", "audit-record"), phase: "audit-record" };
    case "audit-record":
      return { transition: pick(envelope, "audit-record", "done"), phase: "final-owner" };
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
  if (decision.transition.seat.seat === "reader" && limits.maxReaderTurns !== undefined && countSeat(checkpoint, "reader") >= limits.maxReaderTurns) {
    return `maxReaderTurns (${limits.maxReaderTurns})`;
  }
  if (decision.transition.seat.seat === "auditor" && limits.maxAuditIterations !== undefined && countSeat(checkpoint, "auditor") >= limits.maxAuditIterations) {
    return `maxAuditIterations (${limits.maxAuditIterations})`;
  }
  return null;
}

// ── prompts ──────────────────────────────────────────────────────────────────

function promptFor(checkpoint: CampaignCheckpoint, decision: ControlDecision): string {
  const seat = decision.transition.seat;
  const repository = checkpoint.repository.files
    .map((file) => `--- ${file.path} ---\n${file.content}`)
    .join("\n");
  const artifacts = Object.entries(checkpoint.artifacts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => `--- ${path} ---\n${content}`)
    .join("\n");
  const history = okReceipts(checkpoint).map((receipt) => ({
    state: receipt.state,
    nextState: receipt.nextState,
    seat: receipt.seat,
    output: isRecord(receipt.output) && Array.isArray(receipt.output.files)
      ? {
          ...receipt.output,
          files: receipt.output.files.flatMap((file) => isRecord(file) && typeof file.path === "string" && typeof file.content === "string"
            ? [{ path: file.path, sha256: sha256(file.content) }]
            : []),
        }
      : receipt.output,
  }));
  const shared = [
    `Validation Architect campaign. Profile: ${checkpoint.envelope.profile}. Mode: ${checkpoint.mode}. Phase: ${decision.phase}. Seat: ${seatKey(seat)}.`,
    "Use only the repository snapshot, accepted artifact bundle, and prior structured outputs below. Do not assume a shared filesystem or hidden conversation state.",
    `Intake:\n${checkpoint.intake || "(none; derive intent from repository evidence)"}`,
    `Repository inventory:\n${checkpoint.repository.inventory.join("\n") || "(empty)"}`,
    `Repository content snapshot (${checkpoint.repository.revision}, sha256 ${checkpoint.repository.identity}):\n${repository || "(no selected text files)"}`,
    `Accepted artifact bundle:\n${artifacts || "(empty)"}`,
    `Prior accepted outputs:\n${canonicalJson(history)}`,
  ];
  const contract = seat.seat === "designer"
    ? "Return only JSON matching the designer schema. Files are the complete changed artifact payload under validation-design/. Use CONTINUE until the corpus is genuinely ready; CAMPAIGN-COMPLETE is a claim checked by the engine."
    : seat.seat === "stakeholder"
      ? "Act as the product owner, challenge unsupported claims, and return only JSON {message, approved}. Approval must be evidence-backed; false is a gate refusal."
      : seat.seat === "auditor"
        ? "Audit only the supplied artifact bundle and return only JSON matching the auditor schema. Do not relitigate ratified taste decisions."
        : "Read the supplied artifact bundle independently and return only JSON {findings:[{id,tier,title}]}. Empty findings is explicit, never inferred.";
  const phaseRule = decision.phase === "audit:2"
    ? "Iteration 2 must verify every round-1 disposition. Include verification for every round-1 finding. New findings are admissible only at blocking tier."
    : decision.phase === "audit-record"
      ? "The audited core is frozen. Change only validation-design/ratification-package.md to record the verdict, every finding, disposition, dispute, and deferral under an Audit heading."
    : decision.phase === "reader-residue"
      ? "This is the terminal reader-residue write. Change only validation-design/ratification-package.md and record every current reader finding; do not change the audited core corpus."
      : decision.phase === "final-owner"
        ? "This is the final owner-reader gate after audit. Approve only if the supplied audit evidence and ratification package are internally consistent. You cannot edit artifacts."
        : decision.phase === "dispositions"
          ? "Disposition every round-1 audit finding exactly once as fixed, disputed, or deferred, with evidence in the note."
          : "Preserve provenance labels and fail closed on unresolved product truth.";
  return [...shared, contract, phaseRule].join("\n\n");
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
  if (prior && request.session.mode === "new" && prior.session === identity.session) {
    throw identityMismatch(`Fresh seat ${seatKey(request.seat)} reused native session ${identity.session}.`, {
      seat: request.seat,
    });
  }
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
const RATIFICATION_PATH = `${DESIGN_PREFIX}ratification-package.md`;

function artifactIdentity(artifacts: Record<string, string>, excludeRatification = false): string {
  return sha256(canonicalJson(Object.entries(artifacts)
    .filter(([path]) => !excludeRatification || path !== RATIFICATION_PATH)
    .sort(([a], [b]) => a.localeCompare(b))));
}

function artifactProblems(files: Array<{ path: string; content: string }>, merged: Record<string, string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!safeRepositoryPath(file.path) || !file.path.startsWith(DESIGN_PREFIX)) {
      problems.push(`artifact path ${file.path} must sit beneath ${DESIGN_PREFIX} with no traversal`);
    }
    if (seen.has(file.path)) problems.push(`artifact path ${file.path} appears more than once in one turn`);
    seen.add(file.path);
  }
  if (problems.length > 0) return problems;
  const modelFiles: Partial<ModelFileSet> = {};
  for (const file of MODEL_FILES) {
    const content = merged[`${DESIGN_PREFIX}model/${file}`];
    if (content !== undefined) modelFiles[file] = content;
  }
  if (Object.keys(modelFiles).length === MODEL_FILES.length) {
    const validated = validateCorpus(modelFiles);
    if (!validated.valid) problems.push(...validated.problems.map((item) => `corpus: ${item}`));
  }
  return problems;
}

/** The final artifact set must be complete, compiler-clean, and protocol-complete. */
function completionProblems(checkpoint: CampaignCheckpoint): string[] {
  const problems: string[] = [];
  const missing = MODEL_FILES.filter((file) => checkpoint.artifacts[`${DESIGN_PREFIX}model/${file}`] === undefined);
  if (missing.length > 0) problems.push(`corpus is missing required model file(s): ${missing.join(", ")}`);
  else {
    const modelFiles = Object.fromEntries(MODEL_FILES.map((file) => [file, checkpoint.artifacts[`${DESIGN_PREFIX}model/${file}`]])) as unknown as ModelFileSet;
    const validated = validateCorpus(modelFiles);
    if (!validated.valid) problems.push(...validated.problems.map((item) => `corpus: ${item}`));
  }
  const designer = lastOutputFor(
    checkpoint,
    (receipt) => receipt.seat.seat === "designer" && isRecord(receipt.output) && "marker" in receipt.output,
  );
  if (designer?.marker !== "CAMPAIGN-COMPLETE") problems.push("the final designer output did not declare CAMPAIGN-COMPLETE");
  if (checkpoint.envelope.profile === "C3" || checkpoint.envelope.profile === "C4") {
    const ratification = checkpoint.artifacts[RATIFICATION_PATH];
    if (!ratification || !/^#{1,6}\s+Audit\b/im.test(ratification)) {
      problems.push("ratification-package.md must contain an Audit heading");
    }
    if (!checkpoint.auditCoreIdentity || checkpoint.auditCoreIdentity !== artifactIdentity(checkpoint.artifacts, true)) {
      problems.push("the core artifact set changed after the terminal independent audit");
    }
    const ownerGate = [...okReceipts(checkpoint)].reverse().find((receipt) => receipt.seat.seat === "stakeholder" && receipt.state === "audit-record");
    if (!ownerGate || !isRecord(ownerGate.output) || ownerGate.output.approved !== true) {
      problems.push("the final owner-reader gate was not confirmed");
    }
  }
  return problems;
}

// ── bundle production ────────────────────────────────────────────────────────

function mapAuditVerdict(internal: string): PublicAuditVerdict {
  // Lossless: the legacy internal "clean-with-disputes" surfaces publicly as
  // clean-with-reservations; the dispute evidence stays in the findings.
  return internal === "clean" ? "clean" : internal === "reservations" ? "reservations" : "clean-with-reservations";
}

function bundleAudit(checkpoint: CampaignCheckpoint): BundleAudit {
  if (checkpoint.envelope.profile === "C0") return { status: "not_required_by_profile" };
  const first = lastOutput(checkpoint, AUDITOR_1);
  if (!first) throw invalidCheckpoint("Campaign reached its terminal without the profile-required audit receipt.");
  const second = lastOutput(checkpoint, AUDITOR_2);
  const dispositions = lastOutputFor(
    checkpoint,
    (receipt) => receipt.seat.seat === "designer" && ["audit:1", "feedback"].includes(receipt.state),
  );
  const dispositionsById = new Map<string, { kind: "fixed" | "disputed" | "deferred"; note: string }>();
  if (Array.isArray(dispositions?.dispositions)) {
    for (const item of dispositions.dispositions) {
      if (
        isRecord(item) &&
        typeof item.findingId === "string" &&
        (item.kind === "fixed" || item.kind === "disputed" || item.kind === "deferred") &&
        typeof item.note === "string"
      ) {
        dispositionsById.set(item.findingId, { kind: item.kind, note: item.note });
      }
    }
  }
  const verificationById = new Map<string, "fixed" | "not-fixed" | "disputed">();
  if (Array.isArray(second?.verification)) {
    for (const item of second.verification) {
      if (
        isRecord(item) &&
        typeof item.findingId === "string" &&
        (item.status === "fixed" || item.status === "not-fixed" || item.status === "disputed")
      ) {
        verificationById.set(item.findingId, item.status);
      }
    }
  }
  const firstFindings = (Array.isArray(first.findings) ? first.findings : [])
    .filter((finding): finding is Record<string, unknown> => isRecord(finding))
    .map((finding) => ({
      id: String(finding.id),
      tier: finding.tier as AuditFindingRecord["tier"],
      title: String(finding.title),
      iteration: 1,
      ...(dispositionsById.has(String(finding.id)) ? { disposition: dispositionsById.get(String(finding.id)) } : {}),
      ...(verificationById.has(String(finding.id)) ? { verification: verificationById.get(String(finding.id)) } : {}),
    }));
  const secondFindings = (Array.isArray(second?.findings) ? second.findings : [])
    .filter((finding): finding is Record<string, unknown> => isRecord(finding))
    .map((finding) => ({
      id: String(finding.id),
      tier: finding.tier as AuditFindingRecord["tier"],
      title: String(finding.title),
      iteration: 2,
    }));
  return {
    status: "performed",
    verdict: mapAuditVerdict(String(second?.verdict ?? first.verdict)),
    findings: [...firstFindings, ...secondFindings],
  };
}

function escalation(checkpoint: CampaignCheckpoint): { minimum: ProfileTier; required: boolean } {
  const selected = checkpoint.envelope.profile;
  let minimum: ProfileTier = selected;
  for (const receipt of okReceipts(checkpoint)) {
    if (receipt.seat.seat !== "designer" || !isRecord(receipt.output) || !isRecord(receipt.output.escalation)) continue;
    const reported = receipt.output.escalation.minimumProfile;
    if (typeof reported === "string" && PROFILE_TIERS.includes(reported as ProfileTier)) {
      if (tierRank(reported as ProfileTier) > tierRank(minimum)) minimum = reported as ProfileTier;
    }
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
  const bundle: DesignBundle = {
    files: Object.entries(checkpoint.artifacts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({ path, content })),
    provenance: {
      schema: PROVENANCE_SCHEMA,
      packageVersion: checkpoint.packageVersion,
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
  const problems: string[] = [];
  validateDesignBundle(bundle, problems);
  assertValid("DesignBundle", problems);
  return bundle;
}

// ── the engine loop ──────────────────────────────────────────────────────────

interface EngineContext {
  ports: DesignPorts;
}

function campaignDeadline(checkpoint: CampaignCheckpoint): number {
  return checkpoint.startedAtEpochMs + checkpoint.envelope.limits.maxWallMs;
}

function wallLimitReached(checkpoint: CampaignCheckpoint, atEpochMs = Date.now()): boolean {
  return atEpochMs >= campaignDeadline(checkpoint);
}

function requestFor(
  checkpoint: CampaignCheckpoint,
  decision: ControlDecision,
  createdAtEpochMs: number,
): TurnRequest {
  const seat = decision.transition.seat;
  const seatSpec = checkpoint.envelope.seats.find((item) => seatKey(item.seat) === seatKey(seat));
  if (!seatSpec) throw invalidCheckpoint(`Transition names undeclared seat ${seatKey(seat)}.`);
  const existingSession = checkpoint.sessions[seatKey(seat)];
  const session = seatSpec.session === "persistent" && existingSession
    ? { mode: "resume" as const, sessionId: existingSession }
    : { mode: "new" as const };
  const outputSchema = checkpoint.envelope.outputSchemas[seat.seat];
  return {
    seat,
    independence: seatSpec.independence,
    session,
    idempotencyKey: `${checkpoint.runId}:turn:${checkpoint.receipts.length + 1}`,
    prompt: promptFor(checkpoint, decision),
    ...(outputSchema ? { outputSchema } : {}),
    limits: {
      maxTokens: checkpoint.envelope.limits.maxTokensPerTurn,
      maxWallMs: Math.min(campaignDeadline(checkpoint) - createdAtEpochMs, MAX_PROVIDER_TURN_WALL_MS),
      deadlineAtEpochMs: campaignDeadline(checkpoint),
    },
    // The destination disambiguates graph branches that use the same seat.
    metadata: {
      runId: checkpoint.runId,
      phase: decision.transition.to,
      turnIndex: checkpoint.receipts.length + 1,
    },
  };
}

function findingIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => isRecord(item) && typeof item.id === "string" ? [item.id] : []);
}

function phaseProblems(
  checkpoint: CampaignCheckpoint,
  decision: ControlDecision,
  output: unknown,
  files: Array<{ path: string; content: string }>,
  mergedArtifacts: Record<string, string>,
): string[] {
  if (!isRecord(output)) return [];
  const problems: string[] = [];
  const uniqueIds = (items: unknown, path: string, key: "id" | "findingId"): string[] => {
    if (!Array.isArray(items)) return [];
    const ids: string[] = [];
    for (const [index, item] of items.entries()) {
      if (!isRecord(item) || typeof item[key] !== "string") continue;
      const id = item[key] as string;
      if (ids.includes(id)) problems.push(`${path}[${index}].${key} duplicates ${id}`);
      ids.push(id);
    }
    return ids;
  };

  if (output.marker === "CAMPAIGN-COMPLETE") {
    const missing = MODEL_FILES.filter((file) => mergedArtifacts[`${DESIGN_PREFIX}model/${file}`] === undefined);
    if (missing.length > 0) problems.push(`CAMPAIGN-COMPLETE requires every model file; missing ${missing.join(", ")}`);
  }
  if (decision.transition.seat.seat === "designer" && checkpoint.envelope.shape === "sequence") {
    const finalDesignerStep = checkpoint.envelope.profile === "C0" || checkpoint.envelope.profile === "C1" || checkpoint.position === "challenged";
    if (finalDesignerStep && output.marker !== "CAMPAIGN-COMPLETE") {
      problems.push("the finite profile's final designer turn must declare CAMPAIGN-COMPLETE");
    }
  }

  if (decision.transition.seat.seat === "reader") {
    uniqueIds(output.findings, "reader.findings", "id");
  }

  if (decision.transition.seat.seat === "auditor") {
    const ids = uniqueIds(output.findings, "audit.findings", "id");
    if (output.verdict === "clean" && ids.length > 0) problems.push("a clean audit may not carry findings");
    if (output.verdict !== "clean" && ids.length === 0) problems.push("a non-clean audit must carry at least one finding");
  }
  if (decision.phase === "audit:1" && output.verification !== undefined) {
    problems.push("iteration 1 may not claim iteration-2 verification");
  }

  const roundOne = lastOutput(checkpoint, AUDITOR_1);
  const roundOneIds = findingIds(roundOne?.findings);
  if (decision.phase === "dispositions") {
    const dispositionIds = uniqueIds(output.dispositions, "designer.dispositions", "findingId");
    if (canonicalJson([...dispositionIds].sort()) !== canonicalJson([...roundOneIds].sort())) {
      problems.push("designer.dispositions must cover every round-1 audit finding exactly once");
    }
  }
  if (decision.phase === "audit:2") {
    const verificationIds = uniqueIds(output.verification, "audit.verification", "findingId");
    if (canonicalJson([...verificationIds].sort()) !== canonicalJson([...roundOneIds].sort())) {
      problems.push("iteration-2 verification must cover every round-1 audit finding exactly once");
    }
    uniqueIds(output.findings, "audit.findings", "id");
    if (Array.isArray(output.findings)) {
      for (const finding of output.findings) {
        if (isRecord(finding) && typeof finding.id === "string" && !roundOneIds.includes(finding.id) && finding.tier !== "blocking") {
          problems.push(`iteration-2 new finding ${finding.id} is admissible only at blocking tier`);
        }
      }
    }
  }

  if (decision.phase === "reader-residue" || decision.phase === "audit-record") {
    if (files.length !== 1 || files[0]?.path !== RATIFICATION_PATH) {
      problems.push(`${decision.phase} must change only ${RATIFICATION_PATH}`);
    }
    if (artifactIdentity(checkpoint.artifacts, true) !== artifactIdentity(mergedArtifacts, true)) {
      problems.push(`${decision.phase} may not change the core artifact set`);
    }
    const record = files[0]?.content ?? "";
    const requiredIds = decision.phase === "reader-residue"
      ? currentReaderFindings(checkpoint).flatMap((finding) => typeof finding.id === "string" ? [finding.id] : [])
      : [
          ...findingIds(lastOutput(checkpoint, AUDITOR_1)?.findings),
          ...findingIds(lastOutput(checkpoint, AUDITOR_2)?.findings),
        ];
    for (const id of new Set(requiredIds)) {
      if (!record.includes(id)) problems.push(`${decision.phase} record must preserve finding ${id}`);
    }
  }
  return problems;
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
  validateDesignRunCheckpoint(next);
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
      const outcome = await settleTurn(current, current.pendingTurn, context);
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
    if (last && last.status === "ok" && last.accepted === false) {
      return incomplete(
        current,
        "invalid_artifact",
        `Seat ${seatKey(last.seat)} produced output that failed deterministic validation; the campaign did not advance and no recovery turn is added.`,
      );
    }

    const decision = decide(current);
    if (decision === null) {
      const missing = completionProblems(current);
      if (missing.length > 0) {
        return incomplete(current, "invalid_artifact", `The terminal corpus is incomplete: ${missing.join("; ")}`);
      }
      return { status: "complete", bundle: produceBundle(current) };
    }

    const createdAtEpochMs = Date.now();
    if (wallLimitReached(current, createdAtEpochMs)) {
      return incomplete(
        current,
        "limit_exhausted",
        `Declared bound maxWallMs (${current.envelope.limits.maxWallMs}) is exhausted; no new provider turn was started.`,
      );
    }

    const bound = exhaustedBound(current, decision);
    if (bound) {
      return incomplete(current, "limit_exhausted", `Declared bound ${bound} is exhausted; the library never extends its own envelope. A deliberate new campaign with a deeper budget is the only continuation.`);
    }

    const request = requestFor(current, decision, createdAtEpochMs);

    // Save the exact pending request BEFORE invoking the turn (crash window).
    current = await saveNext(ports.store, current, (next) => {
      if (
        (next.envelope.profile === "C3" || next.envelope.profile === "C4") &&
        decision.transition.seat.seat === "auditor"
      ) {
        next.auditCoreIdentity = artifactIdentity(next.artifacts, true);
      }
      next.pendingTurn = { idempotencyKey: request.idempotencyKey, request, createdAtEpochMs };
    });
  }
}

async function settleTurn(
  current: CampaignCheckpoint,
  pending: NonNullable<CampaignCheckpoint["pendingTurn"]>,
  context: EngineContext,
): Promise<{ kind: "ok"; checkpoint: CampaignCheckpoint } | { kind: "incomplete"; outcome: DesignOutcome }> {
  const { ports } = context;
  const request = pending.request;
  // Re-derive the decided transition deterministically: two transitions out
  // of one state may share a seat (audit:1 -> done vs dispositions), and the
  // controller's decision is a pure function of the checkpoint.
  const decision = decide(current);
  if (
    !decision ||
    canonicalJson(requestFor(current, decision, pending.createdAtEpochMs)) !== canonicalJson(request)
  ) {
    throw invalidCheckpoint(`Pending turn does not match the controller's decision at ${current.position}.`);
  }
  const transition = decision.transition;
  const reconciled = await ports.turns.reconcileTurn(request);
  if (reconciled !== null) {
    const settlementProblems: string[] = [];
    validateTurnSettlement(reconciled, settlementProblems);
    if (reconciled.settledAtEpochMs > Date.now()) {
      settlementProblems.push("turnSettlement.settledAtEpochMs may not be in the future");
    }
    assertValid("TurnSettlement", settlementProblems);
    if (reconciled.settledAtEpochMs >= campaignDeadline(current)) {
      return settleDeadlineFailure(current, request, transition, reconciled.result, context, reconciled.settledAtEpochMs);
    }
    return processTurnResult(current, request, decision, reconciled.result, context, false);
  }

  if (wallLimitReached(current)) {
    return {
      kind: "incomplete",
      outcome: incomplete(
        current,
        "limit_exhausted",
        `Absolute campaign deadline ${campaignDeadline(current)} was reached with pending turn ${request.idempotencyKey} unsettled. Reconciliation performed no provider work; only a result durably settled before the deadline may still be recovered.`,
      ),
    };
  }

  const result: TurnResult = await ports.turns.runTurn(request);
  const shapeProblems: string[] = [];
  validateTurnResult(result, shapeProblems);
  assertValid("TurnResult", shapeProblems);
  if (wallLimitReached(current)) {
    return settleDeadlineFailure(current, request, transition, result, context, Date.now());
  }
  return processTurnResult(current, request, decision, result, context, true);
}

async function settleDeadlineFailure(
  current: CampaignCheckpoint,
  request: TurnRequest,
  transition: EnvelopeTransition,
  result: TurnResult,
  context: EngineContext,
  observedAtEpochMs: number,
): Promise<{ kind: "incomplete"; outcome: DesignOutcome }> {
  const settled = await saveNext(context.ports.store, current, (next) => {
    delete next.pendingTurn;
    next.receipts.push({
      idempotencyKey: request.idempotencyKey,
      seat: request.seat,
      state: transition.from,
      nextState: transition.to,
      status: "limit_exhausted",
      usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
      ...(result.identity ? { identity: result.identity } : {}),
    });
    next.usage.turns += 1;
    next.usage.inputTokens += result.usage?.inputTokens ?? 0;
    next.usage.outputTokens += result.usage?.outputTokens ?? 0;
  });
  return {
    kind: "incomplete",
    outcome: incomplete(
      settled,
      "limit_exhausted",
      `Turn ${request.idempotencyKey} settled at or returned by ${observedAtEpochMs}, at or after the absolute campaign deadline ${campaignDeadline(current)}. Its result and artifacts were rejected and the campaign did not advance.`,
    ),
  };
}

async function processTurnResult(
  current: CampaignCheckpoint,
  request: TurnRequest,
  decision: ControlDecision,
  result: TurnResult,
  context: EngineContext,
  enforceCurrentDeadline: boolean,
): Promise<{ kind: "ok"; checkpoint: CampaignCheckpoint } | { kind: "incomplete"; outcome: DesignOutcome }> {
  const { ports } = context;
  const transition = decision.transition;
  const shapeProblems: string[] = [];
  validateTurnResult(result, shapeProblems);
  assertValid("TurnResult", shapeProblems);

  const baseReceipt = {
    idempotencyKey: request.idempotencyKey,
    seat: request.seat,
    state: transition.from,
    nextState: transition.to,
    usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
  };

  if (result.status !== "ok") {
    if (enforceCurrentDeadline && wallLimitReached(current)) {
      return settleDeadlineFailure(current, request, transition, result, context, Date.now());
    }
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
  if (problems.length === 0 && artifactFailures.length === 0) {
    artifactFailures.push(...phaseProblems(current, decision, output, files, mergedArtifacts));
  }

  const invalid = [...problems, ...artifactFailures];
  if (enforceCurrentDeadline && wallLimitReached(current)) {
    return settleDeadlineFailure(current, request, transition, result, context, Date.now());
  }
  const settled = await saveNext(ports.store, current, (next) => {
    delete next.pendingTurn;
    next.receipts.push({
      ...baseReceipt,
      status: "ok",
      identity: result.identity,
      textDigest: sha256(result.text),
      accepted: invalid.length === 0,
      ...(output !== undefined ? { output } : {}),
    });
    next.usage.turns += 1;
    next.usage.inputTokens += result.usage?.inputTokens ?? 0;
    next.usage.outputTokens += result.usage?.outputTokens ?? 0;
    if (invalid.length === 0) {
      next.position = transition.to;
      const seatSpec = next.envelope.seats.find((item) => seatKey(item.seat) === seatKey(request.seat));
      if (seatSpec?.session === "persistent") next.sessions[seatKey(request.seat)] = result.identity.session;
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

function validatePorts(ports: DesignPorts): void {
  const problems: string[] = [];
  if (!isRecord(ports)) {
    throw invalidInput("design ports must be an object");
  }
  const required: Array<[unknown, string, string[]]> = [
    [ports.repository, "ports.repository", ["revision", "readFile", "listFiles", "changedPaths"]],
    [ports.turns, "ports.turns", ["reconcileTurn", "runTurn"]],
    [ports.store, "ports.store", ["load", "save"]],
  ];
  for (const [port, path, methods] of required) {
    if (!isRecord(port)) {
      problems.push(`${path} must be an object`);
      continue;
    }
    for (const method of methods) if (typeof port[method] !== "function") problems.push(`${path}.${method} must be a function`);
  }
  assertValid("design ports", problems);
}

function revisionArtifacts(repository: RepositorySnapshot): Record<string, string> {
  return Object.fromEntries(
    repository.files
      .filter((file) => file.path.startsWith(DESIGN_PREFIX))
      .map((file) => [file.path, file.content]),
  );
}

function assertRevisionCorpus(artifacts: Record<string, string>): void {
  const missing = MODEL_FILES.filter((file) => artifacts[`${DESIGN_PREFIX}model/${file}`] === undefined);
  if (missing.length > 0) {
    throw invalidInput(`Revision mode requires an existing complete corpus; missing ${missing.join(", ")}.`);
  }
  const modelFiles = Object.fromEntries(
    MODEL_FILES.map((file) => [file, artifacts[`${DESIGN_PREFIX}model/${file}`]]),
  ) as unknown as ModelFileSet;
  const validated = validateCorpus(modelFiles);
  if (!validated.valid) throw invalidInput(`Revision mode corpus is invalid: ${validated.problems.join("; ")}`);
}

export async function design(request: DesignRequest, ports: DesignPorts): Promise<DesignOutcome> {
  validatePorts(ports);
  const problems: string[] = [];
  requireString(request?.runId, "request.runId", problems);
  requireEnum(request?.profile, "request.profile", PROFILE_TIERS, problems);
  if (request?.intake !== undefined) requireString(request.intake, "request.intake", problems);
  if (request?.mode !== undefined) requireEnum(request.mode, "request.mode", ["greenfield", "revision"] as const, problems);
  if (request?.limits !== undefined && !isRecord(request.limits)) problems.push("request.limits must be an object");
  if (typeof request?.admit !== "function") problems.push("request.admit must be a function");
  assertValid("design request", problems);

  if ((await ports.store.load(request.runId)) !== null) {
    throw invalidInput(`Run ${request.runId} already has a checkpoint; use resume(runId, ports).`, { runId: request.runId });
  }

  const repository = await captureRepository(ports.repository);
  const mode = request.mode ?? "greenfield";
  const artifacts = mode === "revision" ? revisionArtifacts(repository) : {};
  if (mode === "revision") assertRevisionCorpus(artifacts);
  const declared = buildEnvelope(request, repository.revision, repository.identity);
  const answer = await request.admit(structuredClone(declared));
  if (answer === null) {
    throw invalidInput(`Run ${request.runId} was not admitted; zero turns were spent.`, { runId: request.runId });
  }
  assertAdmittedEnvelope(declared, answer);

  const initial: CampaignCheckpoint = {
    schema: DESIGN_RUN_SCHEMA,
    kind: "checkpoint",
    runId: request.runId,
    generation: 1,
    packageVersion: CORE_PACKAGE_VERSION,
    sourceRevision: repository.revision,
    envelope: answer,
    position: "start",
    receipts: [],
    sessions: {},
    artifacts,
    intake: request.intake ?? "",
    mode,
    repository,
    startedAtEpochMs: Date.now(),
    usage: { turns: 0, inputTokens: 0, outputTokens: 0 },
  };
  validateDesignRunCheckpoint(initial);
  await ports.store.save(initial, 0);

  return runLoop(initial, { ports });
}

export async function resume(runId: string, ports: DesignPorts): Promise<DesignOutcome> {
  validatePorts(ports);
  const problems: string[] = [];
  requireString(runId, "runId", problems);
  assertValid("resume request", problems);

  const raw = await ports.store.load(runId);
  if (raw === null) throw invalidInput(`Run ${runId} has no checkpoint to resume.`, { runId });
  const checkpoint = validateDesignRunCheckpoint(raw);
  if (checkpoint.runId !== runId) {
    throw invalidCheckpoint(`Loaded checkpoint ${checkpoint.runId} does not match requested run ${runId}.`);
  }

  if (checkpoint.packageVersion !== CORE_PACKAGE_VERSION) {
    throw versionMismatch(
      `Run ${runId} was begun by package ${checkpoint.packageVersion}; resume requires that exact version (current: ${CORE_PACKAGE_VERSION}).`,
      { expected: checkpoint.packageVersion, actual: CORE_PACKAGE_VERSION },
    );
  }
  const repository = await captureRepository(ports.repository);
  if (checkpoint.sourceRevision !== repository.revision) {
    throw versionMismatch(
      `Run ${runId} is bound to source revision ${checkpoint.sourceRevision}, but the repository is at ${repository.revision}.`,
      { expected: checkpoint.sourceRevision, actual: repository.revision },
    );
  }
  if (canonicalJson(checkpoint.repository) !== canonicalJson(repository)) {
    throw versionMismatch(`Run ${runId} repository snapshot no longer matches its admitted context.`, {
      expected: checkpoint.repository.identity,
      actual: repository.identity,
    });
  }

  const rebuilt = buildEnvelope(
    {
      runId,
      profile: checkpoint.envelope.profile,
      intake: checkpoint.intake,
      mode: checkpoint.mode,
      admit: () => null,
    },
    repository.revision,
    repository.identity,
  );
  assertAdmittedEnvelope(rebuilt, checkpoint.envelope);

  return runLoop(checkpoint, { ports });
}
