/** Offline fleet registry. Absence is UNKNOWN; only completion paths write. */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DeliveryResult } from "./delivery.js";
import type { RunContext } from "./run-context.js";

const SCHEMA = "validation-architect-design/registry/v1";

export interface RegistryEntry {
  target: string;
  campaign?: { runId: string; sourceRevision: string; completedAt: string };
  delivery?: DeliveryResult & { runId: string; deliveredAt: string };
  fidelity?: { sourceRevision: string; verdict: "clean" | "findings"; recordedAt: string };
}

export type FleetStatus =
  | "UNKNOWN"
  | "NEVER_DELIVERED"
  | "DELIVERY_NOT_INSTALLED"
  | "DESIGN_STALE"
  | "FIDELITY_UNKNOWN"
  | "FIDELITY_STALE"
  | "FIDELITY_FINDINGS"
  | "HEALTHY";

interface FleetRegistry {
  schema: typeof SCHEMA;
  entries: Record<string, RegistryEntry>;
}

const empty = (): FleetRegistry => ({ schema: SCHEMA, entries: {} });

function load(path: string): FleetRegistry {
  if (!existsSync(path)) return empty();
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`registry ${path} is invalid`);
  const record = value as Record<string, unknown>;
  if (record["schema"] !== SCHEMA || typeof record["entries"] !== "object" || record["entries"] === null) {
    throw new Error(`registry ${path} has an unsupported shape`);
  }
  return value as FleetRegistry;
}

function save(path: string, registry: FleetRegistry): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function targetKey(target: string): string {
  return resolve(target);
}

export function recordCampaignCompletion(path: string, context: RunContext, completedAt = new Date().toISOString()): void {
  if (context.fixture) return;
  const registry = load(path);
  const key = targetKey(context.target);
  registry.entries[key] = {
    ...(registry.entries[key] ?? { target: key }),
    target: key,
    campaign: { runId: context.runId, sourceRevision: context.sourceRevision, completedAt },
  };
  save(path, registry);
}

export function recordDeliveryCompletion(
  path: string,
  context: RunContext,
  delivery: DeliveryResult,
  deliveredAt = new Date().toISOString(),
): void {
  if (context.fixture) return;
  const registry = load(path);
  const key = targetKey(context.target);
  registry.entries[key] = {
    ...(registry.entries[key] ?? { target: key }),
    target: key,
    delivery: { ...delivery, runId: context.runId, deliveredAt },
  };
  save(path, registry);
}

export function recordFidelityCompletion(
  path: string,
  target: string,
  sourceRevision: string,
  verdict: "clean" | "findings",
  recordedAt = new Date().toISOString(),
): void {
  const registry = load(path);
  const key = targetKey(target);
  registry.entries[key] = {
    ...(registry.entries[key] ?? { target: key }),
    target: key,
    fidelity: { sourceRevision, verdict, recordedAt },
  };
  save(path, registry);
}

export function registryEntries(path: string): RegistryEntry[] {
  return Object.values(load(path).entries).sort((left, right) => left.target.localeCompare(right.target));
}

export function registryStatus(path: string, target: string): RegistryEntry | null {
  return load(path).entries[targetKey(target)] ?? null;
}

function gitStatus(target: string, args: string[]): number {
  return spawnSync("git", args, { cwd: target, stdio: "ignore" }).status ?? 1;
}

function gitOutput(target: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: target, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function evaluateFleetStatus(entry: RegistryEntry | null, target: string): FleetStatus {
  if (!entry) return "UNKNOWN";
  if (!entry.delivery) return "NEVER_DELIVERED";
  if (gitStatus(target, ["diff", "--quiet", "HEAD", entry.delivery.commit, "--", "validation-design"]) !== 0) {
    return "DELIVERY_NOT_INSTALLED";
  }
  if (gitStatus(target, ["diff", "--quiet", entry.delivery.baseCommit, "HEAD", "--", ".", ":(exclude)validation-design"]) !== 0) {
    return "DESIGN_STALE";
  }
  if (!entry.fidelity) return "FIDELITY_UNKNOWN";
  if (entry.fidelity.sourceRevision !== gitOutput(target, ["rev-parse", "HEAD"])) return "FIDELITY_STALE";
  return entry.fidelity.verdict === "clean" ? "HEALTHY" : "FIDELITY_FINDINGS";
}
