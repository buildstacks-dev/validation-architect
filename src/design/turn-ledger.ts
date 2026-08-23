/**
 * Durable at-most-once settlement ledger for SDK turns. A locally settled key
 * replays byte-equivalent data across processes. If an owner dies while the
 * provider outcome is still ambiguous, the ledger returns an error instead of
 * issuing a second SDK call; neither bundled SDK exposes native reconciliation.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  validateTurnResult,
  type TurnRequest,
  type TurnResult,
  type TurnSettlement,
} from "../api/index.js";

interface PendingTurn {
  version: 2;
  status: "pending";
  idempotencyKey: string;
  requestDigest: string;
  ownerPid: number;
  expiresAtEpochMs: number;
}

interface SettledTurn {
  version: 2;
  status: "settled";
  idempotencyKey: string;
  requestDigest: string;
  result: TurnResult;
  settledAtEpochMs: number;
}

type TurnLedgerRecord = PendingTurn | SettledTurn;
export type TurnClaim =
  | { kind: "owner"; path: string; pending: PendingTurn }
  | { kind: "replay"; settlement: TurnSettlement }
  | { kind: "ambiguous"; result: TurnResult };

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const wait = (milliseconds: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function validateRecord(value: unknown, path: string): TurnLedgerRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Turn ledger ${path} is not an object.`);
  const record = value as Record<string, unknown>;
  if (record["version"] !== 2 || (record["status"] !== "pending" && record["status"] !== "settled")) {
    throw new Error(`Turn ledger ${path} has an unsupported record.`);
  }
  if (typeof record["idempotencyKey"] !== "string" || typeof record["requestDigest"] !== "string") {
    throw new Error(`Turn ledger ${path} is missing its request identity.`);
  }
  if (record["status"] === "pending") {
    if (typeof record["ownerPid"] !== "number" || typeof record["expiresAtEpochMs"] !== "number") {
      throw new Error(`Turn ledger ${path} has an invalid pending owner/deadline.`);
    }
  } else {
    if (
      typeof record["settledAtEpochMs"] !== "number" ||
      !Number.isSafeInteger(record["settledAtEpochMs"]) ||
      record["settledAtEpochMs"] < 1
    ) {
      throw new Error(`Turn ledger ${path} has an invalid settlement time.`);
    }
    const problems: string[] = [];
    validateTurnResult(record["result"], problems);
    if (problems.length > 0) throw new Error(`Turn ledger ${path} has an invalid result: ${problems.join("; ")}`);
  }
  return record as unknown as TurnLedgerRecord;
}

export class TurnLedger {
  readonly #directory: string;

  constructor(stateDirectory: string) {
    this.#directory = resolve(stateDirectory, "turn-settlements");
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
  }

  async reconcile(request: TurnRequest): Promise<TurnSettlement | null> {
    const path = join(this.#directory, `${sha256(request.idempotencyKey)}.json`);
    if (!existsSync(path)) return null;
    const requestDigest = sha256(canonicalJson(request));
    const existing = await this.#read(path);
    if (existing.idempotencyKey !== request.idempotencyKey || existing.requestDigest !== requestDigest) {
      throw new Error(`Idempotency key ${request.idempotencyKey} was reused for a different TurnRequest.`);
    }
    if (existing.status !== "settled") return null;
    return {
      result: structuredClone(existing.result),
      settledAtEpochMs: existing.settledAtEpochMs,
    };
  }

  async claim(request: TurnRequest, effectiveWallMs = request.limits.maxWallMs ?? 60 * 60_000): Promise<TurnClaim> {
    const path = join(this.#directory, `${sha256(request.idempotencyKey)}.json`);
    const requestDigest = sha256(canonicalJson(request));
    const pending: PendingTurn = {
      version: 2,
      status: "pending",
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      ownerPid: process.pid,
      expiresAtEpochMs: Date.now() + effectiveWallMs + 5_000,
    };
    let created = false;
    try {
      const descriptor = openSync(path, "wx", 0o600);
      created = true;
      try {
        writeFileSync(descriptor, canonicalJson(pending));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return { kind: "owner", path, pending };
    } catch (error) {
      if (created) {
        try { unlinkSync(path); } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    for (;;) {
      const existing = await this.#read(path);
      if (existing.idempotencyKey !== request.idempotencyKey || existing.requestDigest !== requestDigest) {
        throw new Error(`Idempotency key ${request.idempotencyKey} was reused for a different TurnRequest.`);
      }
      if (existing.status === "settled") {
        return {
          kind: "replay",
          settlement: {
            result: structuredClone(existing.result),
            settledAtEpochMs: existing.settledAtEpochMs,
          },
        };
      }
      if (!processAlive(existing.ownerPid) || Date.now() >= existing.expiresAtEpochMs) {
        return {
          kind: "ambiguous",
          result: {
            status: "error",
            reason: `Turn ${request.idempotencyKey} has an ambiguous prior settlement; replay is refused to prevent duplicate provider spend.`,
          },
        };
      }
      await wait(25);
    }
  }

  settle(claim: Extract<TurnClaim, { kind: "owner" }>, result: TurnResult): void {
    const problems: string[] = [];
    validateTurnResult(result, problems);
    if (problems.length > 0) throw new Error(`Cannot persist invalid TurnResult: ${problems.join("; ")}`);
    const settled: SettledTurn = {
      version: 2,
      status: "settled",
      idempotencyKey: claim.pending.idempotencyKey,
      requestDigest: claim.pending.requestDigest,
      result,
      settledAtEpochMs: Date.now(),
    };
    const temp = `${claim.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const descriptor = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(descriptor, canonicalJson(settled));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temp, claim.path);
    } finally {
      try { unlinkSync(temp); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async #read(path: string): Promise<TurnLedgerRecord> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return validateRecord(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
      } catch (error) {
        lastError = error;
        await wait(5);
      }
    }
    throw lastError;
  }
}
