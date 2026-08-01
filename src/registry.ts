import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditVerdict, CampaignMode, RunStatus } from "./types.js";

/**
 * The per-repo ledger (issue #8): the architect is the one identity that
 * spans the owner's repos, so run-level bookkeeping is lifted to one entry
 * per target repo. Hard rules from the issue:
 *
 * - Entries are written ONLY by the code paths that complete campaigns,
 *   deliveries, and fidelity audits — never hand-maintained.
 * - An absent entry is "unknown", reported loudly, never treated as healthy
 *   (no green by absence).
 *
 * The registry lives at runs/registry.json — local operator state, like the
 * runs it aggregates. Campaign residue stays per-run; this only aggregates.
 */

export const REGISTRY_SCHEMA = "validation-architect/registry/v1";

export interface RegistryEntry {
  /** Absolute target repo path — the key, repeated for readability. */
  target: string;
  lastCampaign?: {
    runId: string;
    mode: CampaignMode;
    status: RunStatus;
    verdict?: AuditVerdict;
    at: string;
  };
  /** Installed design revision: the corpus delivery per #1's branch flow. */
  delivery?: { runId: string; branch: string; commit: string; deliveredAt: string };
  lastFidelity?: {
    at: string;
    scope: string;
    status: string;
    findings: number;
    blocking: number;
  };
  /** Enablement bundle version observed at delivery (the manifest schema id). */
  enablementSchema?: string;
  updatedAt: string;
}

export interface Registry {
  schema: typeof REGISTRY_SCHEMA;
  repos: Record<string, RegistryEntry>;
}

export function loadRegistry(path: string): Registry {
  if (!existsSync(path)) return { schema: REGISTRY_SCHEMA, repos: {} };
  const reg = JSON.parse(readFileSync(path, "utf8")) as Registry;
  if (reg.schema !== REGISTRY_SCHEMA) {
    throw new Error(`Unknown registry schema "${reg.schema}" at ${path} (expected ${REGISTRY_SCHEMA})`);
  }
  return reg;
}

function saveRegistry(path: string, reg: Registry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(reg, null, 2)}\n`);
}

function upsert(path: string, target: string, patch: Partial<RegistryEntry>): RegistryEntry {
  const reg = loadRegistry(path);
  const prev = reg.repos[target];
  const entry: RegistryEntry = {
    ...(prev ?? { target }),
    ...patch,
    target,
    updatedAt: new Date().toISOString(),
  };
  reg.repos[target] = entry;
  saveRegistry(path, reg);
  return entry;
}

export function recordCampaign(
  path: string,
  target: string,
  campaign: NonNullable<RegistryEntry["lastCampaign"]>,
): RegistryEntry {
  return upsert(path, target, { lastCampaign: campaign });
}

export function recordDelivery(
  path: string,
  target: string,
  delivery: NonNullable<RegistryEntry["delivery"]>,
  enablementSchema?: string,
): RegistryEntry {
  return upsert(path, target, {
    delivery,
    ...(enablementSchema !== undefined ? { enablementSchema } : {}),
  });
}

export function recordFidelity(
  path: string,
  target: string,
  fidelity: NonNullable<RegistryEntry["lastFidelity"]>,
): RegistryEntry {
  return upsert(path, target, { lastFidelity: fidelity });
}

/**
 * The staleness signal #8 names: has anything under docs/ been committed in
 * the target AFTER the last corpus delivery? Best-effort local git; returns
 * undefined when the question cannot be answered (missing repo, no
 * delivery), which callers must report as unknown — not as healthy.
 */
export function docsChangedSince(target: string, sinceIso: string): boolean | undefined {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", "docs"],
      { cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!out) return false; // no commits touching docs at all
    return Date.parse(out) > Date.parse(sinceIso);
  } catch {
    return undefined;
  }
}

export interface RepoStatusLine {
  target: string;
  flags: string[];
  entry?: RegistryEntry;
}

/**
 * Answer the staleness question for every known repo (plus any explicitly
 * queried paths, which surface loudly as UNKNOWN when absent). Flags, all
 * fail-closed:
 *
 * - UNKNOWN — no registry entry: never treated as healthy.
 * - NEVER-DELIVERED / NEVER-AUDITED — the gap named, not silence.
 * - DESIGN-STALE — docs/ commits in the target postdate the last delivery.
 * - FINDINGS-OPEN — last fidelity pass left findings and is older than
 *   `staleDays` (default 14) with no newer pass.
 * - CAMPAIGN-INCOMPLETE — last campaign did not complete.
 */
export function repoStatuses(
  reg: Registry,
  queryPaths: string[] = [],
  opts: { now?: Date; staleDays?: number } = {},
): RepoStatusLine[] {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? 14;
  const out: RepoStatusLine[] = [];
  const targets = new Set<string>([...Object.keys(reg.repos), ...queryPaths]);
  for (const target of [...targets].sort()) {
    const entry = reg.repos[target];
    if (!entry) {
      out.push({ target, flags: ["UNKNOWN — no registry entry; never treated as healthy"] });
      continue;
    }
    const flags: string[] = [];
    if (entry.lastCampaign && entry.lastCampaign.status !== "completed") {
      flags.push(`CAMPAIGN-INCOMPLETE — last campaign ${entry.lastCampaign.runId} is ${entry.lastCampaign.status}`);
    }
    if (!entry.delivery) {
      flags.push("NEVER-DELIVERED — no corpus revision installed in the repo");
    } else {
      const changed = docsChangedSince(target, entry.delivery.deliveredAt);
      if (changed === true) {
        flags.push(`DESIGN-STALE — docs/ changed after the last delivery (${entry.delivery.deliveredAt.slice(0, 10)}); consider a revision campaign`);
      } else if (changed === undefined) {
        flags.push("STALENESS-UNKNOWN — target repo unreadable; cannot compare docs/ against the delivery");
      }
    }
    if (!entry.lastFidelity) {
      flags.push("NEVER-AUDITED — no fidelity pass recorded");
    } else if (entry.lastFidelity.findings > 0) {
      const ageDays = (now.getTime() - Date.parse(entry.lastFidelity.at)) / 86_400_000;
      if (ageDays > staleDays) {
        flags.push(`FINDINGS-OPEN — ${entry.lastFidelity.findings} finding(s) (${entry.lastFidelity.blocking} blocking) open for ${Math.floor(ageDays)}d`);
      } else {
        flags.push(`FINDINGS-OPEN — ${entry.lastFidelity.findings} finding(s) (${entry.lastFidelity.blocking} blocking) from the last pass`);
      }
    }
    out.push({ target, flags, entry });
  }
  return out;
}

export function renderRepos(lines: RepoStatusLine[]): string {
  if (lines.length === 0) {
    return "(registry empty — no target campaigns recorded yet; fixture runs are not registered)";
  }
  const parts = lines.map((l) => {
    const e = l.entry;
    const detail = e
      ? [
          e.lastCampaign
            ? `campaign: ${e.lastCampaign.runId} (${e.lastCampaign.mode}, ${e.lastCampaign.status}${e.lastCampaign.verdict ? `, audit ${e.lastCampaign.verdict}` : ""})`
            : "campaign: none",
          e.delivery
            ? `installed: ${e.delivery.branch} @ ${e.delivery.commit.slice(0, 12)} (${e.delivery.deliveredAt.slice(0, 10)})`
            : "installed: none",
          e.lastFidelity
            ? `fidelity: ${e.lastFidelity.at.slice(0, 10)} (${e.lastFidelity.scope}) — ${e.lastFidelity.findings} finding(s), ${e.lastFidelity.blocking} blocking`
            : "fidelity: never",
          e.enablementSchema ? `enablement: ${e.enablementSchema}` : undefined,
        ].filter(Boolean)
      : [];
    const flagLines = l.flags.length > 0 ? l.flags.map((f) => `  !! ${f}`) : ["  ok"];
    return [`${l.target}`, ...detail.map((d) => `  ${d}`), ...flagLines].join("\n");
  });
  return parts.join("\n\n");
}
