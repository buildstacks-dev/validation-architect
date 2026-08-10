import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditVerdict, CampaignMode, RunStatus, TargetRevision } from "./types.js";

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

export interface RegistryFidelity {
  at: string;
  scope: string;
  status: string;
  findings: number;
  blocking: number;
  /** Delivery revision this pass actually inspected; absent means unbound/legacy evidence. */
  deliveryCommit?: string;
  /** Exact delivered corpus inspected; topology-independent binding for new evidence. */
  deliveryCorpusTree?: string;
  /** Target HEAD on which the fidelity pass ran. */
  targetCommit?: string;
  /** Root tree at targetCommit; absent only for legacy/untrusted evidence. */
  targetTree?: string;
  /** Time the immutable target identity was captured before the live pass. */
  targetCapturedAt?: string;
}

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
  delivery?: {
    runId: string;
    branch: string;
    commit: string;
    deliveredAt: string;
    /** Product revision the delivery branch was pinned to. */
    baseCommit?: string;
    /** Root tree digest at baseCommit. */
    sourceTree?: string;
    /** Git tree object for the exact delivered validation-design/ contents. */
    corpusTree?: string;
  };
  lastFidelity?: RegistryFidelity;
  /** Latest evidence per scope so a clean pass cannot erase another scope's open findings. */
  fidelityByScope?: Record<string, RegistryFidelity>;
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

function upsert(
  path: string,
  target: string,
  patch: Partial<RegistryEntry> | ((previous: RegistryEntry | undefined) => Partial<RegistryEntry>),
): RegistryEntry {
  const reg = loadRegistry(path);
  const prev = reg.repos[target];
  const resolvedPatch = typeof patch === "function" ? patch(prev) : patch;
  const entry: RegistryEntry = {
    ...(prev ?? { target }),
    ...resolvedPatch,
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
  fidelity: Omit<
    RegistryFidelity,
    "deliveryCommit" | "deliveryCorpusTree" | "targetCommit" | "targetTree" | "targetCapturedAt"
  >,
  targetRevision: TargetRevision,
): RegistryEntry {
  if (targetRevision.dirty !== false || !Number.isFinite(Date.parse(targetRevision.capturedAt))) {
    throw new Error("Cannot record fidelity: target identity is not a valid clean pre-audit capture.");
  }
  let actualTree: string;
  try {
    actualTree = execFileSync("git", ["rev-parse", `${targetRevision.commit}^{tree}`], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      `Cannot record fidelity: captured target revision ${targetRevision.commit} is unavailable in ${target}.`,
    );
  }
  if (actualTree !== targetRevision.sourceTree) {
    throw new Error(
      `Cannot record fidelity: captured target tree ${targetRevision.sourceTree} does not match ${targetRevision.commit} (${actualTree}).`,
    );
  }
  return upsert(path, target, (previous) => {
    const delivery = previous?.delivery;
    const installed = delivery
      ? deliveryInstalledAtRevision(target, delivery, targetRevision.commit)
      : undefined;
    const bound: RegistryFidelity = {
      ...fidelity,
      targetCommit: targetRevision.commit,
      targetTree: targetRevision.sourceTree,
      targetCapturedAt: targetRevision.capturedAt,
      ...(delivery && installed === true ? { deliveryCommit: delivery.commit } : {}),
      ...(delivery?.corpusTree && installed === true
        ? { deliveryCorpusTree: delivery.corpusTree }
        : {}),
    };
    return {
      lastFidelity: bound,
      fidelityByScope: {
        ...(previous?.lastFidelity
          ? { [previous.lastFidelity.scope]: previous.lastFidelity }
          : {}),
        ...(previous?.fidelityByScope ?? {}),
        [bound.scope]: bound,
      },
    };
  });
}

function deliveryInstalledAtRevision(
  target: string,
  delivery: DeliveryIdentity,
  revision: string,
): boolean | undefined {
  if (!delivery.corpusTree) return commitIsAncestor(target, delivery.commit, revision);
  const tree = validationDesignTree(target, revision);
  return tree === undefined ? undefined : tree === delivery.corpusTree;
}

function targetHead(target: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

function targetWorkingIdentity(
  target: string,
): { commit: string; tree: string; dirty: boolean } | undefined {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const dirty = Boolean(execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim());
    return { commit, tree, dirty };
  } catch {
    return undefined;
  }
}

function commitIsAncestor(target: string, ancestor: string, descendant = "HEAD"): boolean | undefined {
  try {
    execFileSync("git", ["cat-file", "-e", `${ancestor}^{commit}`], {
      cwd: target,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return undefined;
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: target,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return status === 1 ? false : undefined;
  }
}

/**
 * Legacy docs-only helper retained for callers outside the fleet view.
 * Fleet freshness uses sourceChangedSince so source/config changes cannot
 * remain green merely because docs/ did not move.
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

/**
 * Has committed or working-tree product input changed from the captured base?
 * Everything outside validation-design/ is source/config input; ignored files
 * remain ignored, while untracked non-ignored files fail stale rather than
 * passing by absence. Commit topology/date is irrelevant — trees are compared.
 */
export function sourceChangedSince(target: string, baseCommit: string): boolean | undefined {
  try {
    execFileSync("git", ["cat-file", "-e", `${baseCommit}^{commit}`], {
      cwd: target,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const pathspec = [".", ":(exclude)validation-design", ":(exclude)validation-design/**"];
    const committed = execFileSync(
      "git",
      ["diff", "--name-only", baseCommit, "HEAD", "--", ...pathspec],
      { cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const working = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...pathspec],
      { cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return Boolean(committed || working);
  } catch {
    return undefined;
  }
}

export interface DeliveryIdentity {
  commit: string;
  /** Absent only for registry records created before corpus-tree binding. */
  corpusTree?: string;
}

/**
 * Resolve the validation-design/ tree at a revision, distinguishing no repo
 * from no exact corpus. HEAD is considered exact only when its checked-out
 * validation-design/ content has no tracked or untracked changes: fidelity
 * inspects the working checkout, not an abstract commit.
 */
export function validationDesignTree(target: string, revision = "HEAD"): string | undefined {
  if (!targetHead(target)) return undefined;
  try {
    if (revision === "HEAD") {
      const working = execFileSync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all", "--", "validation-design"],
        { cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (working) return "";
    }
    return execFileSync("git", ["rev-parse", `${revision}:validation-design`], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // A readable repository without validation-design/ does not carry this
    // delivery. Callers need false, represented by an empty tree identity.
    return "";
  }
}

/**
 * Is the exact delivered corpus currently checked out? New records compare the
 * validation-design tree, so squash/rebase merges remain recognizable. Only
 * legacy records without a corpus tree fall back to commit ancestry.
 */
export function deliveryInstalled(
  target: string,
  delivery: string | DeliveryIdentity,
): boolean | undefined {
  if (typeof delivery === "string" || !delivery.corpusTree) {
    return commitIsAncestor(target, typeof delivery === "string" ? delivery : delivery.commit);
  }
  const current = validationDesignTree(target);
  return current === undefined ? undefined : current === delivery.corpusTree;
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
 * - DELIVERY-NOT-IN-HEAD — the recorded delivery is not installed here.
 * - DESIGN-STALE — source/config differs from the campaign's captured base.
 * - FIDELITY-INVALID / -UNBOUND / -STALE — judgment evidence cannot support
 *   the installed delivery.
 * - FINDINGS-OPEN — the latest pass for any scope still has findings.
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
      const installed = deliveryInstalled(target, entry.delivery);
      if (installed === false) {
        flags.push(`DELIVERY-NOT-IN-HEAD — the exact corpus from ${entry.delivery.branch} @ ${entry.delivery.commit.slice(0, 12)} is not installed in the target checkout`);
      } else if (installed === undefined) {
        flags.push("STALENESS-UNKNOWN — target checkout is unreadable; cannot verify the installed corpus");
      }
      const changed = entry.delivery.baseCommit
        ? sourceChangedSince(target, entry.delivery.baseCommit)
        : undefined;
      if (changed === true) {
        flags.push(`DESIGN-STALE — source/config changed from campaign base ${entry.delivery.baseCommit?.slice(0, 12)}; consider a revision campaign`);
      } else if (changed === undefined) {
        flags.push("STALENESS-UNKNOWN — target revision is legacy/unreadable; cannot compare source/config against the campaign base");
      }
    }
    const fidelityRecords = Object.values(entry.fidelityByScope ?? {});
    const currentTarget = targetWorkingIdentity(target);
    if (fidelityRecords.length === 0 && entry.lastFidelity) fidelityRecords.push(entry.lastFidelity);
    if (fidelityRecords.length === 0) {
      flags.push("NEVER-AUDITED — no fidelity pass recorded");
    } else {
      for (const fidelity of fidelityRecords.sort((a, b) => a.scope.localeCompare(b.scope))) {
        if (fidelity.status !== "ok" && fidelity.status !== "findings") {
          flags.push(`FIDELITY-INVALID — ${fidelity.scope} pass ended ${fidelity.status}; it is not clean evidence`);
        }
        if (
          !fidelity.deliveryCommit ||
          !fidelity.targetCommit ||
          !fidelity.targetTree ||
          !fidelity.targetCapturedAt
        ) {
          flags.push(`FIDELITY-UNBOUND — ${fidelity.scope} pass is not bound to both an installed delivery and target revision`);
        } else {
          const deliveryChanged =
            entry.delivery &&
            (fidelity.deliveryCorpusTree && entry.delivery.corpusTree
              ? fidelity.deliveryCorpusTree !== entry.delivery.corpusTree
              : fidelity.deliveryCommit !== entry.delivery.commit);
          const targetChanged =
            currentTarget !== undefined &&
            (fidelity.targetCommit !== currentTarget.commit ||
              fidelity.targetTree !== currentTarget.tree ||
              currentTarget.dirty);
          if (deliveryChanged || targetChanged) {
            flags.push(
              `FIDELITY-STALE — ${fidelity.scope} inspected target ${fidelity.targetCommit.slice(0, 12)} / delivery ${fidelity.deliveryCommit.slice(0, 12)}, not the current checkout`,
            );
          }
        }
        if (fidelity.findings > 0) {
          const ageDays = (now.getTime() - Date.parse(fidelity.at)) / 86_400_000;
          const age = ageDays > staleDays ? ` open for ${Math.floor(ageDays)}d` : " from the last pass";
          flags.push(`FINDINGS-OPEN — ${fidelity.scope}: ${fidelity.findings} finding(s) (${fidelity.blocking} blocking)${age}`);
        }
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
            ? `installed: ${e.delivery.branch} @ ${e.delivery.commit.slice(0, 12)} (${e.delivery.deliveredAt.slice(0, 10)})${e.delivery.baseCommit ? ` · base ${e.delivery.baseCommit.slice(0, 12)}` : ""}`
            : "installed: none",
          e.lastFidelity
            ? `fidelity: ${e.lastFidelity.at.slice(0, 10)} (${e.lastFidelity.scope}, ${e.lastFidelity.status}) — ${e.lastFidelity.findings} finding(s), ${e.lastFidelity.blocking} blocking`
            : "fidelity: never",
          e.enablementSchema ? `enablement: ${e.enablementSchema}` : undefined,
        ].filter(Boolean)
      : [];
    const flagLines = l.flags.length > 0 ? l.flags.map((f) => `  !! ${f}`) : ["  ok"];
    return [`${l.target}`, ...detail.map((d) => `  ${d}`), ...flagLines].join("\n");
  });
  return parts.join("\n\n");
}
