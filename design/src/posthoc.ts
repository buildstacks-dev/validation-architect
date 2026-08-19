/** Fresh post-hoc readers/audit over a completed public checkpoint. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AUDITOR_OUTPUT_SCHEMA,
  READER_OUTPUT_SCHEMA,
  validateAgainstSchema,
  validateDesignRunCheckpoint,
  validateTurnResult,
  type CampaignCheckpoint,
  type JsonSchema,
  type SeatRef,
  type TurnPort,
  type TurnRequest,
  type TurnResult,
} from "validation-architect";

interface PostHocEvidence {
  idempotencyKey: string;
  output: Record<string, unknown>;
  identity: { provider: string; model: string; session: string };
  usage?: { inputTokens: number; outputTokens: number };
}

export interface PostHocAuditResult extends PostHocEvidence {
  path: string;
}

export interface PostHocReadersResult {
  path: string;
  outputs: PostHocEvidence[];
}

const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

function completed(raw: CampaignCheckpoint): CampaignCheckpoint {
  const checkpoint = validateDesignRunCheckpoint(structuredClone(raw));
  if (!SAFE_RUN_ID.test(checkpoint.runId)) throw new Error(`unsafe run id ${checkpoint.runId}`);
  if (checkpoint.pendingTurn || !checkpoint.envelope.terminals.includes(checkpoint.position)) {
    throw new Error(`run ${checkpoint.runId} is not complete`);
  }
  return checkpoint;
}

function artifactPrompt(checkpoint: CampaignCheckpoint, purpose: string): string {
  const artifacts = Object.entries(checkpoint.artifacts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => `--- ${path} ---\n${content}`)
    .join("\n");
  return [
    `Post-hoc ${purpose} for completed Validation Architect run ${checkpoint.runId}.`,
    "Return findings only in the requested JSON schema. You are read-only: never propose or apply patches.",
    `Source revision: ${checkpoint.sourceRevision}`,
    `Artifact authority:\n${artifacts}`,
  ].join("\n\n");
}

function evidenceDirectory(stateDirectory: string, runId: string): string {
  return join(resolve(stateDirectory), "posthoc", runId);
}

function nextIndex(directory: string, prefix: string): number {
  if (!existsSync(directory)) return 1;
  const used = readdirSync(directory).flatMap((name) => {
    const match = new RegExp(`^${prefix}-(\\d+)\\.json$`).exec(name);
    return match ? [Number(match[1])] : [];
  });
  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

function writeEvidence(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function judgment(
  checkpoint: CampaignCheckpoint,
  turns: TurnPort,
  seat: SeatRef,
  idempotencyKey: string,
  prompt: string,
  schema: JsonSchema,
): Promise<PostHocEvidence> {
  const request: TurnRequest = {
    seat,
    independence: [],
    session: { mode: "new" },
    idempotencyKey,
    prompt,
    outputSchema: schema,
    limits: { maxTokens: 32_768, maxWallMs: 60 * 60_000 },
    metadata: { runId: checkpoint.runId, phase: `posthoc:${seat.instance}`, turnIndex: 1 },
  };
  const prior = await turns.reconcileTurn(request);
  const result: TurnResult = prior?.result ?? await turns.runTurn(request);
  const resultProblems: string[] = [];
  validateTurnResult(result, resultProblems);
  if (resultProblems.length > 0) throw new Error(`post-hoc result is invalid: ${resultProblems.join("; ")}`);
  if (result.status !== "ok") throw new Error(`post-hoc turn ${idempotencyKey} returned ${result.status}: ${result.reason}`);
  let output: unknown;
  try {
    output = JSON.parse(result.text);
  } catch (error) {
    throw new Error(`post-hoc turn returned invalid JSON: ${(error as Error).message}`);
  }
  const outputProblems = validateAgainstSchema(output, schema);
  if (outputProblems.length > 0 || typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new Error(`post-hoc output failed schema: ${outputProblems.join("; ")}`);
  }
  return {
    idempotencyKey,
    output: output as Record<string, unknown>,
    identity: result.identity,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

export async function runPostHocAudit(
  rawCheckpoint: CampaignCheckpoint,
  turns: TurnPort,
  stateDirectory: string,
): Promise<PostHocAuditResult> {
  const checkpoint = completed(rawCheckpoint);
  const directory = evidenceDirectory(stateDirectory, checkpoint.runId);
  const iteration = nextIndex(directory, "audit");
  const evidence = await judgment(
    checkpoint,
    turns,
    { seat: "auditor", instance: `posthoc-auditor:${iteration}` },
    `${checkpoint.runId}:posthoc:audit:${iteration}`,
    artifactPrompt(checkpoint, `audit iteration ${iteration}`),
    AUDITOR_OUTPUT_SCHEMA,
  );
  const path = join(directory, `audit-${iteration}.json`);
  writeEvidence(path, { kind: "posthoc-audit", iteration, ...evidence });
  return { path, ...evidence };
}

export async function runPostHocReaders(
  rawCheckpoint: CampaignCheckpoint,
  turns: TurnPort,
  stateDirectory: string,
): Promise<PostHocReadersResult> {
  const checkpoint = completed(rawCheckpoint);
  const directory = evidenceDirectory(stateDirectory, checkpoint.runId);
  const iteration = nextIndex(directory, "readers");
  const personas = ["operator", "new-engineer", "coding-agent"] as const;
  const outputs: PostHocEvidence[] = [];
  for (const persona of personas) {
    outputs.push(await judgment(
      checkpoint,
      turns,
      { seat: "reader", instance: `posthoc-reader:${persona}:${iteration}` },
      `${checkpoint.runId}:posthoc:readers:${iteration}:${persona}`,
      artifactPrompt(checkpoint, `${persona} reader pass ${iteration}`),
      READER_OUTPUT_SCHEMA,
    ));
  }
  const path = join(directory, `readers-${iteration}.json`);
  writeEvidence(path, { kind: "posthoc-readers", iteration, outputs });
  return { path, outputs };
}
