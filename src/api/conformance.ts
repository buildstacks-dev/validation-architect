/**
 * Deterministic conformance fakes (VA-API-002). Hosts use these to develop
 * and test port implementations offline; the repository's own tests use them
 * to exercise every status, identity dimension, and CAS race without a
 * provider, network, or filesystem.
 */

import { staleGeneration, invalidCheckpoint, invalidInput } from "./errors.js";
import type { CampaignCheckpoint, CampaignStorePort } from "./campaign-contracts.js";
import { validateDesignRunCheckpoint } from "./schemas.js";
import type {
  ExecutionIdentity,
  RepositoryPort,
  TurnPort,
  TurnRequest,
  TurnResult,
  TurnSettlement,
} from "./ports.js";
import { validateTurnRequest, validateTurnResult } from "./ports.js";
import { assertValid, safeRepositoryPath } from "./validate.js";

// ── repository ───────────────────────────────────────────────────────────────

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`);
}

/** In-memory read-only repository over a path → content map. */
export class FakeRepositoryPort implements RepositoryPort {
  readonly #files: ReadonlyMap<string, string>;
  readonly #revision: string;
  readonly #changed: ReadonlyMap<string, readonly string[]>;

  constructor(options: {
    revision: string;
    files: Record<string, string>;
    /** Optional changed-path answers keyed by `${base}..${head}`. */
    changed?: Record<string, string[]>;
  }) {
    for (const path of Object.keys(options.files)) {
      if (!safeRepositoryPath(path)) throw invalidInput(`FakeRepositoryPort rejects unsafe path ${path}`);
    }
    this.#files = new Map(Object.entries(options.files));
    this.#revision = options.revision;
    this.#changed = new Map(Object.entries(options.changed ?? {}));
  }

  async revision(): Promise<string> {
    return this.#revision;
  }

  async readFile(path: string): Promise<string | null> {
    if (!safeRepositoryPath(path)) throw invalidInput(`readFile rejects unsafe path ${path}`);
    return this.#files.get(path) ?? null;
  }

  async listFiles(globs: string[]): Promise<string[]> {
    const expressions = globs.map(globToRegExp);
    return [...this.#files.keys()].filter((path) => expressions.some((expression) => expression.test(path))).sort();
  }

  async changedPaths(base: string, head: string): Promise<string[]> {
    return [...(this.#changed.get(`${base}..${head}`) ?? [])];
  }
}

// ── turns ────────────────────────────────────────────────────────────────────

export interface ScriptedTurn {
  /** Optional guard: the fake refuses the script when the incoming request's
   * seat/session does not match, which catches sequence drift in tests. */
  expect?: { seat?: string; instance?: string; sessionMode?: "new" | "resume" };
  result: TurnResult | ((request: TurnRequest) => TurnResult);
}

/**
 * Replays a scripted list of turn results in order, validating every request
 * and result shape. Records all requests for assertions. Deterministic:
 * identical scripts and requests produce identical transcripts.
 */
export class ScriptedTurnPort implements TurnPort {
  readonly requests: TurnRequest[] = [];
  readonly #script: ScriptedTurn[];
  readonly #settled = new Map<string, TurnSettlement>();
  #cursor = 0;

  constructor(script: ScriptedTurn[]) {
    this.#script = script;
  }

  async reconcileTurn(request: TurnRequest): Promise<TurnSettlement | null> {
    const requestProblems: string[] = [];
    validateTurnRequest(request, requestProblems);
    assertValid("TurnRequest", requestProblems);
    return structuredClone(this.#settled.get(request.idempotencyKey) ?? null);
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const requestProblems: string[] = [];
    validateTurnRequest(request, requestProblems);
    assertValid("TurnRequest", requestProblems);

    // Idempotent settlement: replaying a settled key returns the same result
    // and consumes no scripted turn — the crash-window contract.
    const settled = this.#settled.get(request.idempotencyKey);
    if (settled) return structuredClone(settled.result);

    const entry = this.#script[this.#cursor];
    if (!entry) {
      throw invalidInput(
        `ScriptedTurnPort exhausted after ${this.#cursor} turns; unplanned request for seat ${request.seat.seat}:${request.seat.instance}`,
        { turnIndex: this.#cursor },
      );
    }
    if (entry.expect) {
      const { seat, instance, sessionMode } = entry.expect;
      if (
        (seat && request.seat.seat !== seat) ||
        (instance && request.seat.instance !== instance) ||
        (sessionMode && request.session.mode !== sessionMode)
      ) {
        throw invalidInput(
          `ScriptedTurnPort expected ${seat ?? "*"}:${instance ?? "*"} (${sessionMode ?? "*"}), got ${request.seat.seat}:${request.seat.instance} (${request.session.mode})`,
          { turnIndex: this.#cursor },
        );
      }
    }
    this.#cursor += 1;
    const result = typeof entry.result === "function" ? entry.result(request) : entry.result;
    const resultProblems: string[] = [];
    validateTurnResult(result, resultProblems);
    assertValid("TurnResult", resultProblems);
    this.requests.push(request);
    this.#settled.set(request.idempotencyKey, { result: structuredClone(result), settledAtEpochMs: Date.now() });
    return result;
  }

  get consumed(): number {
    return this.#cursor;
  }
}

export function okTurn(text: string, identity: ExecutionIdentity, parsed?: unknown): TurnResult {
  return { status: "ok", text, identity, ...(parsed !== undefined ? { parsed } : {}), usage: { inputTokens: 10, outputTokens: 20 } };
}

// ── campaign store ───────────────────────────────────────────────────────────

/**
 * Deterministic in-memory compare-and-swap store. Two writers saving against
 * the same generation yield exactly one accepted write; the stale writer
 * receives the typed `stale_generation` conflict and cannot overwrite.
 */
export class InMemoryCampaignStore implements CampaignStorePort {
  readonly #checkpoints = new Map<string, CampaignCheckpoint>();

  async load(runId: string): Promise<CampaignCheckpoint | null> {
    const checkpoint = this.#checkpoints.get(runId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async save(checkpoint: CampaignCheckpoint, expectedGeneration: number): Promise<void> {
    validateDesignRunCheckpoint(checkpoint);
    const current = this.#checkpoints.get(checkpoint.runId);
    const currentGeneration = current?.generation ?? 0;
    if (currentGeneration !== expectedGeneration) {
      throw staleGeneration(expectedGeneration, currentGeneration, checkpoint.runId);
    }
    if (checkpoint.generation !== expectedGeneration + 1) {
      throw invalidCheckpoint(
        `Checkpoint generation must be expectedGeneration + 1 (${expectedGeneration + 1}), got ${checkpoint.generation}`,
        { runId: checkpoint.runId },
      );
    }
    this.#checkpoints.set(checkpoint.runId, structuredClone(checkpoint));
  }
}
