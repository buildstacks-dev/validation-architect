/** Immutable, findings-only fidelity judgment through the sole TurnPort. */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AUDITOR_OUTPUT_SCHEMA,
  check,
  validateAgainstSchema,
  validateTurnResult,
  type TurnPort,
  type TurnRequest,
} from "validation-architect";
import { LocalRepository } from "./local-repository.js";

export interface FidelityScope {
  wave?: number;
  tickets?: string[];
}

export interface FidelityOptions {
  target: string;
  stateDirectory: string;
  operationId: string;
  scope?: FidelityScope;
}

export interface FidelityResult {
  path: string;
  sourceRevision: string;
  output: Record<string, unknown>;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function git(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function ensureSnapshot(target: string, stateDirectory: string, operationId: string, sourceRevision: string): string {
  const snapshot = join(resolve(stateDirectory), "fidelity-workspaces", operationId);
  if (!existsSync(snapshot)) {
    mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", target, snapshot], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    git(snapshot, ["checkout", "--quiet", "--detach", sourceRevision]);
    git(snapshot, ["remote", "remove", "origin"]);
  }
  if (git(snapshot, ["rev-parse", "HEAD"]) !== sourceRevision || git(snapshot, ["remote"]) !== "") {
    throw new Error(`fidelity snapshot ${snapshot} does not match immutable source ${sourceRevision}`);
  }
  return realpathSync.native(snapshot);
}

export async function runFidelity(
  options: FidelityOptions,
  turnFactory: (workspace: string) => TurnPort,
): Promise<FidelityResult> {
  if (!SAFE_ID.test(options.operationId)) throw new Error(`unsafe fidelity operation id ${options.operationId}`);
  const target = realpathSync.native(resolve(options.target));
  if (git(target, ["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("fidelity requires a clean target checkout");
  }
  const sourceRevision = git(target, ["rev-parse", "HEAD"]);
  const evidencePath = join(resolve(options.stateDirectory), "fidelity", `${options.operationId}.json`);
  if (existsSync(evidencePath)) {
    const prior = JSON.parse(readFileSync(evidencePath, "utf8")) as FidelityResult;
    if (prior.sourceRevision !== sourceRevision) throw new Error("existing fidelity evidence is bound to another source revision");
    return { ...prior, path: evidencePath };
  }
  const snapshot = ensureSnapshot(target, options.stateDirectory, options.operationId, sourceRevision);
  const gate = await check(new LocalRepository({ root: snapshot }));
  if (gate.verdict === "fail") {
    throw new Error(`fidelity refused because validation-architect check is red: ${gate.summary}`);
  }
  const scope = options.scope?.wave !== undefined
    ? `wave ${options.scope.wave}`
    : options.scope?.tickets?.length
      ? `tickets ${options.scope.tickets.join(", ")}`
      : "the complete landed corpus";
  const request: TurnRequest = {
    seat: { seat: "auditor", instance: `fidelity:${options.operationId}` },
    independence: [],
    session: { mode: "new" },
    idempotencyKey: `fidelity:${options.operationId}:${sourceRevision}`,
    prompt: [
      `Run a findings-only fidelity audit for ${scope} at source ${sourceRevision}.`,
      "Read the checked validation model and cited executable specs in this immutable workspace.",
      "Judge whether the specs actually falsify their reviewed seeds and oracles.",
      "Return only the requested audit JSON. Never edit files, propose patches, or claim product green from structural closure alone.",
    ].join("\n\n"),
    outputSchema: AUDITOR_OUTPUT_SCHEMA,
    limits: { maxTokens: 32_768, maxWallMs: 60 * 60_000 },
    metadata: { runId: options.operationId, phase: "fidelity", turnIndex: 1 },
  };
  const turns = turnFactory(snapshot);
  const prior = await turns.reconcileTurn(request);
  const result = prior?.result ?? await turns.runTurn(request);
  const resultProblems: string[] = [];
  validateTurnResult(result, resultProblems);
  if (resultProblems.length > 0) throw new Error(`fidelity result is invalid: ${resultProblems.join("; ")}`);
  if (result.status !== "ok") throw new Error(`fidelity turn returned ${result.status}: ${result.reason}`);
  const output = JSON.parse(result.text) as unknown;
  const outputProblems = validateAgainstSchema(output, AUDITOR_OUTPUT_SCHEMA);
  if (outputProblems.length > 0 || typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new Error(`fidelity output failed schema: ${outputProblems.join("; ")}`);
  }
  if (
    git(target, ["status", "--porcelain", "--untracked-files=all"]) !== "" ||
    git(target, ["rev-parse", "HEAD"]) !== sourceRevision
  ) {
    throw new Error("target checkout moved during fidelity; result was invalidated");
  }
  const evidence = {
    sourceRevision,
    output: output as Record<string, unknown>,
    identity: result.identity,
    ...(result.usage ? { usage: result.usage } : {}),
  };
  atomicWrite(evidencePath, evidence);
  return { path: evidencePath, sourceRevision, output: evidence.output };
}
