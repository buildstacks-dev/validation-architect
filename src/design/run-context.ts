/**
 * Operational metadata and immutable source capture for the public campaign
 * engine. This is deliberately not campaign transition state: the only
 * transition record is the core CampaignCheckpoint stored by LocalCampaignStore.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProfileTier } from "../api/index.js";

const RUN_CONTEXT_SCHEMA = "validation-architect-design/run-context/v1";
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

export interface RunContext {
  schema: typeof RUN_CONTEXT_SCHEMA;
  runId: string;
  target: string;
  snapshot: string;
  sourceRevision: string;
  profile: ProfileTier;
  intakeSource: string;
  fixture?: string;
  createdAt: string;
}

export interface CaptureRunContextOptions {
  runId: string;
  target: string;
  stateDirectory: string;
  profile: ProfileTier;
  intakeFile?: string;
  fixture?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`unsafe run id ${runId}`);
}

function metadataPath(stateDirectory: string, runId: string): string {
  assertRunId(runId);
  return join(resolve(stateDirectory), "runs", `${runId}.json`);
}

function validateRunContext(value: unknown, path: string): RunContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`run metadata ${path} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    record["schema"] !== RUN_CONTEXT_SCHEMA ||
    typeof record["runId"] !== "string" ||
    !SAFE_RUN_ID.test(record["runId"]) ||
    typeof record["target"] !== "string" ||
    typeof record["snapshot"] !== "string" ||
    typeof record["sourceRevision"] !== "string" ||
    typeof record["intakeSource"] !== "string" ||
    typeof record["createdAt"] !== "string" ||
    !["C0", "C1", "C2", "C3", "C4"].includes(String(record["profile"]))
  ) {
    throw new Error(`run metadata ${path} has an unsupported shape`);
  }
  if (record["fixture"] !== undefined && typeof record["fixture"] !== "string") {
    throw new Error(`run metadata ${path} has an invalid fixture identity`);
  }
  return record as unknown as RunContext;
}

function writeRunContext(stateDirectory: string, context: RunContext): void {
  const destination = metadataPath(stateDirectory, context.runId);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function captureRunContext(options: CaptureRunContextOptions): RunContext {
  assertRunId(options.runId);
  const target = realpathSync.native(resolve(options.target));
  const stateDirectory = resolve(options.stateDirectory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const realState = realpathSync.native(stateDirectory);
  if (containedBy(target, realState)) {
    throw new Error("campaign state directory must remain outside the target checkout");
  }
  if (existsSync(metadataPath(realState, options.runId))) {
    throw new Error(`run ${options.runId} already has metadata; use resume`);
  }
  if (git(target, ["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("target checkout must be clean before immutable capture");
  }
  const sourceRevision = git(target, ["rev-parse", "HEAD"]);
  const intakeSource = resolve(options.intakeFile ?? join(target, "rambling.txt"));
  if (options.intakeFile !== undefined && !existsSync(intakeSource)) {
    throw new Error(`explicit intake file does not exist: ${intakeSource}`);
  }
  if (existsSync(intakeSource)) {
    const entry = lstatSync(intakeSource);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`intake source must be a real regular file: ${intakeSource}`);
    }
  }
  const snapshot = join(realState, "workspaces", options.runId, "source");
  if (existsSync(snapshot)) throw new Error(`snapshot path already exists for run ${options.runId}`);
  mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
  try {
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", target, snapshot], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    git(snapshot, ["checkout", "--quiet", "--detach", sourceRevision]);
    git(snapshot, ["remote", "remove", "origin"]);
    if (git(snapshot, ["rev-parse", "HEAD"]) !== sourceRevision) {
      throw new Error("immutable snapshot revision does not match captured target HEAD");
    }
    const context: RunContext = {
      schema: RUN_CONTEXT_SCHEMA,
      runId: options.runId,
      target,
      snapshot: realpathSync.native(snapshot),
      sourceRevision,
      profile: options.profile,
      intakeSource,
      ...(options.fixture ? { fixture: options.fixture } : {}),
      createdAt: new Date().toISOString(),
    };
    writeRunContext(realState, context);
    return context;
  } catch (error) {
    rmSync(join(realState, "workspaces", options.runId), { recursive: true, force: true });
    throw error;
  }
}

export function loadRunContext(stateDirectory: string, runId: string): RunContext {
  const path = metadataPath(stateDirectory, runId);
  if (!existsSync(path)) throw new Error(`no run metadata for ${runId}`);
  const context = validateRunContext(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  const snapshot = realpathSync.native(context.snapshot);
  if (git(snapshot, ["rev-parse", "HEAD"]) !== context.sourceRevision) {
    throw new Error(`run ${runId} snapshot moved from ${context.sourceRevision}`);
  }
  if (git(snapshot, ["remote"]) !== "") throw new Error(`run ${runId} snapshot unexpectedly has a remote`);
  return { ...context, snapshot };
}

export function listRunContexts(stateDirectory: string): RunContext[] {
  const directory = join(resolve(stateDirectory), "runs");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => validateRunContext(JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown, join(directory, name)));
}
