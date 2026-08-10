import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REGISTRY_SCHEMA,
  deliveryInstalled,
  docsChangedSince,
  loadRegistry,
  recordCampaign,
  recordDelivery,
  recordFidelity as persistFidelity,
  renderRepos,
  repoStatuses,
  sourceChangedSince,
  validationDesignTree,
} from "../src/registry.js";
import { captureTargetRevision } from "../src/target.js";

let tmp: string;
let regPath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vda-registry-test-"));
  regPath = join(tmp, "registry.json");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function gitAt(cwd: string, isoDate: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function head(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function targetRevision(cwd: string) {
  return {
    commit: head(cwd),
    sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim(),
    capturedAt: "2026-07-01T00:00:00Z",
    dirty: false as const,
  };
}

function recordFidelity(
  path: string,
  target: string,
  fidelity: Parameters<typeof persistFidelity>[2],
) {
  return persistFidelity(path, target, fidelity, targetRevision(target));
}

function commitAll(cwd: string, isoDate: string, message: string): string {
  gitAt(cwd, isoDate, ["add", "-A"]);
  gitAt(cwd, isoDate, ["commit", "-q", "-m", message]);
  return head(cwd);
}

/** A small product repo with committed docs plus source/config inputs. */
function repoWithDocsCommittedAt(name: string, docsDate: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "docs", "arch.md"), `# arch as of ${docsDate}\n`);
  writeFileSync(join(dir, "src", "service.ts"), "export const version = 1;\n");
  writeFileSync(join(dir, "service.config.json"), '{"mode":"safe"}\n');
  gitAt(dir, docsDate, ["init", "-q", "-b", "main"]);
  commitAll(dir, docsDate, "product inputs");
  return dir;
}

function installDelivery(repo: string, runId: string, isoDate: string): string {
  mkdirSync(join(repo, "validation-design"), { recursive: true });
  writeFileSync(
    join(repo, "validation-design", "validation-policy.yaml"),
    `schema: validation-architect/policy/v1\nrun: ${runId}\n`,
  );
  return commitAll(repo, isoDate, `install ${runId}`);
}

describe("registry persistence", () => {
  it("absent file loads as an empty registry; records round-trip", () => {
    const repo = repoWithDocsCommittedAt("persistence", "2026-07-01T00:00:00Z");
    expect(loadRegistry(regPath).repos).toEqual({});
    recordCampaign(regPath, repo, {
      runId: "a-1",
      mode: "greenfield",
      status: "completed",
      verdict: "clean",
      at: "2026-07-01T00:00:00Z",
    });
    recordDelivery(
      regPath,
      repo,
      { runId: "a-1", branch: "validation-design/a-1", commit: "abc123", deliveredAt: "2026-07-01T01:00:00Z" },
      "validation-architect/case-catalog/v1",
    );
    recordFidelity(regPath, repo, {
      at: "2026-07-02T00:00:00Z",
      scope: "wave 0",
      status: "ok",
      findings: 0,
      blocking: 0,
    });
    const entry = loadRegistry(regPath).repos[repo]!;
    expect(entry.lastCampaign?.runId).toBe("a-1");
    expect(entry.delivery?.branch).toBe("validation-design/a-1");
    expect(entry.lastFidelity?.status).toBe("ok");
    expect(entry.enablementSchema).toBe("validation-architect/case-catalog/v1");
    // upserts preserve unrelated fields
    recordFidelity(regPath, repo, { at: "2026-07-10T00:00:00Z", scope: "wave 1", status: "findings", findings: 2, blocking: 1 });
    const after = loadRegistry(regPath).repos[repo]!;
    expect(after.delivery?.commit).toBe("abc123");
    expect(after.lastFidelity?.findings).toBe(2);
  });

  it("fails closed on an unknown schema", () => {
    writeFileSync(regPath, JSON.stringify({ schema: "v99", repos: {} }));
    expect(() => loadRegistry(regPath)).toThrow(/Unknown registry schema/);
  });
});

describe("docsChangedSince", () => {
  it("true when docs/ was committed after the delivery, false when before, undefined off-repo", () => {
    const repo = repoWithDocsCommittedAt("p1", "2026-07-15T00:00:00Z");
    expect(docsChangedSince(repo, "2026-07-01T00:00:00Z")).toBe(true);
    expect(docsChangedSince(repo, "2026-07-20T00:00:00Z")).toBe(false);
    expect(docsChangedSince(join(tmp, "not-a-repo"), "2026-07-01T00:00:00Z")).toBeUndefined();
  });
});

describe("source and delivery revision checks", () => {
  it("records the pre-audit identity instead of reading a newer post-audit HEAD", () => {
    const repo = repoWithDocsCommittedAt("captured-fidelity", "2026-07-01T00:00:00Z");
    const base = head(repo);
    const delivery = installDelivery(repo, "captured", "2026-07-02T00:00:00Z");
    const corpusTree = validationDesignTree(repo)!;
    recordDelivery(regPath, repo, {
      runId: "captured",
      branch: "validation-design/captured",
      commit: delivery,
      baseCommit: base,
      corpusTree,
      deliveredAt: "2026-07-02T00:00:00Z",
    });
    const captured = targetRevision(repo);

    writeFileSync(join(repo, "src", "service.ts"), "export const version = 2;\n");
    const newer = commitAll(repo, "2026-07-03T00:00:00Z", "target moved after audit");
    persistFidelity(
      regPath,
      repo,
      {
        at: "2026-07-03T00:00:00Z",
        scope: "all waves",
        status: "ok",
        findings: 0,
        blocking: 0,
      },
      captured,
    );

    const entry = loadRegistry(regPath).repos[repo]!;
    expect(entry.lastFidelity).toMatchObject({
      targetCommit: captured.commit,
      targetTree: captured.sourceTree,
      targetCapturedAt: captured.capturedAt,
      deliveryCommit: delivery,
      deliveryCorpusTree: corpusTree,
    });
    expect(entry.lastFidelity?.targetCommit).not.toBe(newer);
    expect(repoStatuses(loadRegistry(regPath))[0]!.flags).toEqual(
      expect.arrayContaining([expect.stringMatching(/^FIDELITY-STALE/)]),
    );
  });

  it("refuses a captured commit/tree mismatch instead of writing evidence", () => {
    const repo = repoWithDocsCommittedAt("bad-captured-tree", "2026-07-01T00:00:00Z");
    const captured = targetRevision(repo);
    expect(() =>
      persistFidelity(
        regPath,
        repo,
        {
          at: "2026-07-02T00:00:00Z",
          scope: "all waves",
          status: "ok",
          findings: 0,
          blocking: 0,
        },
        { ...captured, sourceTree: "0".repeat(40) },
      ),
    ).toThrow(/does not match/);
    expect(loadRegistry(regPath).repos[repo]).toBeUndefined();
  });

  it("detects source/config changes while ignoring delivery-only corpus changes", () => {
    const repo = repoWithDocsCommittedAt("source-drift", "2026-07-01T00:00:00Z");
    const base = head(repo);
    const delivery = installDelivery(repo, "r1", "2026-07-02T00:00:00Z");
    expect(sourceChangedSince(repo, base)).toBe(false);
    expect(deliveryInstalled(repo, delivery)).toBe(true);

    writeFileSync(join(repo, "src", "service.ts"), "export const version = 2;\n");
    commitAll(repo, "2026-07-03T00:00:00Z", "source only");
    expect(sourceChangedSince(repo, base)).toBe(true);

    // Working-tree config drift also fails closed before it is committed.
    writeFileSync(join(repo, "new-service.config.json"), "{}\n");
    expect(sourceChangedSince(repo, base)).toBe(true);
    expect(sourceChangedSince(join(tmp, "not-a-repo"), base)).toBeUndefined();
  });

  it("knows when a delivery branch exists but is not installed in current HEAD", () => {
    const repo = repoWithDocsCommittedAt("not-installed", "2026-07-01T00:00:00Z");
    const base = head(repo);
    gitAt(repo, "2026-07-02T00:00:00Z", ["checkout", "-q", "-b", "validation-design/r1"]);
    const delivery = installDelivery(repo, "r1", "2026-07-02T00:00:00Z");
    gitAt(repo, "2026-07-02T00:00:00Z", ["checkout", "-q", "main"]);
    expect(head(repo)).toBe(base);
    expect(deliveryInstalled(repo, delivery)).toBe(false);
  });

  it("recognizes an identical corpus after a squash merge and binds fidelity to its tree", () => {
    const repo = repoWithDocsCommittedAt("squash-installed", "2026-07-01T00:00:00Z");
    const base = head(repo);
    gitAt(repo, "2026-07-02T00:00:00Z", ["checkout", "-q", "-b", "validation-design/squash"]);
    const delivery = installDelivery(repo, "squash", "2026-07-02T00:00:00Z");
    const corpusTree = validationDesignTree(repo)!;

    gitAt(repo, "2026-07-03T00:00:00Z", ["checkout", "-q", "main"]);
    gitAt(repo, "2026-07-03T00:00:00Z", ["merge", "--squash", "validation-design/squash"]);
    const squash = commitAll(repo, "2026-07-03T00:00:00Z", "squash delivered corpus");
    expect(squash).not.toBe(delivery);

    // Legacy records retain ancestry semantics; new records identify content.
    expect(deliveryInstalled(repo, delivery)).toBe(false);
    expect(deliveryInstalled(repo, { commit: delivery, corpusTree })).toBe(true);
    recordDelivery(regPath, repo, {
      runId: "squash",
      branch: "validation-design/squash",
      commit: delivery,
      baseCommit: base,
      corpusTree,
      deliveredAt: "2026-07-02T00:00:00Z",
    });
    recordFidelity(regPath, repo, {
      at: "2026-07-04T00:00:00Z",
      scope: "all waves",
      status: "ok",
      findings: 0,
      blocking: 0,
    });

    const line = repoStatuses(loadRegistry(regPath))[0]!;
    expect(line.flags.some((flag) => flag.startsWith("DELIVERY-NOT-IN-HEAD"))).toBe(false);
    expect(line.flags.some((flag) => flag.startsWith("FIDELITY-UNBOUND"))).toBe(false);
    expect(line.entry?.lastFidelity).toMatchObject({
      deliveryCommit: delivery,
      deliveryCorpusTree: corpusTree,
      targetCommit: squash,
    });
  });

  it("refuses a dirty corpus before fidelity and detects changed delivered content", () => {
    const repo = repoWithDocsCommittedAt("changed-corpus", "2026-07-01T00:00:00Z");
    const base = head(repo);
    const delivery = installDelivery(repo, "changed", "2026-07-02T00:00:00Z");
    const corpusTree = validationDesignTree(repo)!;
    const identity = { commit: delivery, corpusTree };
    recordDelivery(regPath, repo, {
      runId: "changed",
      branch: "validation-design/changed",
      commit: delivery,
      baseCommit: base,
      corpusTree,
      deliveredAt: "2026-07-02T00:00:00Z",
    });

    // Fidelity reads the checkout, so an uncommitted corpus edit cannot bind.
    writeFileSync(join(repo, "validation-design", "local-notes.md"), "not delivered\n");
    expect(deliveryInstalled(repo, identity)).toBe(false);
    expect(() => captureTargetRevision(repo)).toThrow(/uncommitted or untracked/);
    expect(loadRegistry(regPath).repos[repo]!.lastFidelity).toBeUndefined();

    commitAll(repo, "2026-07-04T00:00:00Z", "change delivered corpus");
    expect(deliveryInstalled(repo, identity)).toBe(false);
    const flags = repoStatuses(loadRegistry(regPath))[0]!.flags;
    expect(flags.some((flag) => flag.startsWith("DELIVERY-NOT-IN-HEAD"))).toBe(true);
    expect(flags.some((flag) => flag.startsWith("NEVER-AUDITED"))).toBe(true);
  });
});

describe("the staleness question, one command (#8 acceptance)", () => {
  it("two targets: stale design vs never-delivered/never-audited, answered together", () => {
    // Target A: only product source moved after the pinned campaign base.
    const repoA = repoWithDocsCommittedAt("a", "2026-07-01T00:00:00Z");
    const baseA = head(repoA);
    const deliveryA = installDelivery(repoA, "a-1", "2026-07-02T00:00:00Z");
    writeFileSync(join(repoA, "src", "service.ts"), "export const version = 2;\n");
    commitAll(repoA, "2026-07-15T00:00:00Z", "source implementation changed");
    recordCampaign(regPath, repoA, { runId: "a-1", mode: "greenfield", status: "completed", verdict: "clean", at: "2026-07-01T00:00:00Z" });
    recordDelivery(regPath, repoA, {
      runId: "a-1",
      branch: "validation-design/a-1",
      commit: deliveryA,
      baseCommit: baseA,
      deliveredAt: "2026-07-02T00:00:00Z",
    });
    recordFidelity(regPath, repoA, { at: "2026-07-02T00:00:00Z", scope: "wave 0", status: "findings", findings: 3, blocking: 1 });
    // Target B: campaign aborted, nothing delivered, never audited.
    const repoB = repoWithDocsCommittedAt("b", "2026-07-10T00:00:00Z");
    recordCampaign(regPath, repoB, { runId: "b-1", mode: "greenfield", status: "aborted", at: "2026-07-11T00:00:00Z" });

    const lines = repoStatuses(loadRegistry(regPath), [], { now: new Date("2026-07-31T00:00:00Z") });
    const a = lines.find((l) => l.target === repoA)!;
    const b = lines.find((l) => l.target === repoB)!;
    expect(a.flags.some((f) => f.startsWith("DESIGN-STALE"))).toBe(true);
    expect(a.flags.some((f) => f.startsWith("FINDINGS-OPEN") && f.includes("29d"))).toBe(true);
    expect(b.flags.some((f) => f.startsWith("CAMPAIGN-INCOMPLETE"))).toBe(true);
    expect(b.flags.some((f) => f.startsWith("NEVER-DELIVERED"))).toBe(true);
    expect(b.flags.some((f) => f.startsWith("NEVER-AUDITED"))).toBe(true);

    const rendered = renderRepos(lines);
    expect(rendered).toContain("DESIGN-STALE");
    expect(rendered).toContain("NEVER-AUDITED");
  });

  it("absent entry = UNKNOWN, loudly — never healthy", () => {
    const lines = repoStatuses(loadRegistry(regPath), ["/repos/never-seen"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.flags[0]).toMatch(/UNKNOWN/);
    expect(renderRepos(lines)).toContain("!! UNKNOWN");
  });

  it("a healthy repo requires an installed pinned delivery and fidelity bound to it", () => {
    const repo = repoWithDocsCommittedAt("healthy", "2026-07-01T00:00:00Z");
    const base = head(repo);
    const delivery = installDelivery(repo, "h-1", "2026-07-05T00:00:00Z");
    recordCampaign(regPath, repo, { runId: "h-1", mode: "revision", status: "completed", verdict: "clean", at: "2026-07-05T00:00:00Z" });
    recordDelivery(regPath, repo, {
      runId: "h-1",
      branch: "validation-design/h-1",
      commit: delivery,
      baseCommit: base,
      deliveredAt: "2026-07-05T00:00:00Z",
    });
    recordFidelity(regPath, repo, { at: "2026-07-06T00:00:00Z", scope: "all waves", status: "ok", findings: 0, blocking: 0 });
    const lines = repoStatuses(loadRegistry(regPath), [], { now: new Date("2026-07-31T00:00:00Z") });
    expect(lines[0]!.flags).toEqual([]);
    expect(lines[0]!.entry?.lastFidelity?.deliveryCommit).toBe(delivery);
    expect(lines[0]!.entry?.lastFidelity?.targetCommit).toBe(delivery);
    expect(renderRepos(lines)).toContain("  ok");
  });

  it("never treats a protocol-violating zero-finding report as clean evidence", () => {
    const repo = repoWithDocsCommittedAt("protocol", "2026-07-01T00:00:00Z");
    const base = head(repo);
    const delivery = installDelivery(repo, "p-1", "2026-07-02T00:00:00Z");
    recordDelivery(regPath, repo, {
      runId: "p-1",
      branch: "validation-design/p-1",
      commit: delivery,
      baseCommit: base,
      deliveredAt: "2026-07-02T00:00:00Z",
    });
    recordFidelity(regPath, repo, {
      at: "2026-07-03T00:00:00Z",
      scope: "all waves",
      status: "protocol-violation",
      findings: 0,
      blocking: 0,
    });
    const flags = repoStatuses(loadRegistry(regPath))[0]!.flags;
    expect(flags.some((f) => f.startsWith("FIDELITY-INVALID"))).toBe(true);
    expect(flags).not.toContain("NEVER-AUDITED — no fidelity pass recorded");
  });

  it("invalidates old clean fidelity when a newer delivery is recorded", () => {
    const repo = repoWithDocsCommittedAt("new-delivery", "2026-07-01T00:00:00Z");
    const campaign1Base = head(repo);
    const delivery1 = installDelivery(repo, "r1", "2026-07-02T00:00:00Z");
    recordDelivery(regPath, repo, {
      runId: "r1",
      branch: "validation-design/r1",
      commit: delivery1,
      baseCommit: campaign1Base,
      deliveredAt: "2026-07-02T00:00:00Z",
    });
    recordFidelity(regPath, repo, { at: "2026-07-03T00:00:00Z", scope: "all waves", status: "ok", findings: 0, blocking: 0 });

    const campaign2Base = head(repo);
    const delivery2 = installDelivery(repo, "r2", "2026-07-04T00:00:00Z");
    recordDelivery(regPath, repo, {
      runId: "r2",
      branch: "validation-design/r2",
      commit: delivery2,
      baseCommit: campaign2Base,
      deliveredAt: "2026-07-04T00:00:00Z",
    });
    const flags = repoStatuses(loadRegistry(regPath))[0]!.flags;
    expect(flags.some((f) => f.startsWith("FIDELITY-STALE") && f.includes(delivery1.slice(0, 12)))).toBe(true);
    expect(flags.some((f) => f.startsWith("DESIGN-STALE"))).toBe(false);
  });

  it("invalidates fidelity when the target revision advances even if the delivered corpus is identical", () => {
    const repo = repoWithDocsCommittedAt("same-corpus-new-source", "2026-07-01T00:00:00Z");
    const base = head(repo);
    const delivery = installDelivery(repo, "r1", "2026-07-02T00:00:00Z");
    const corpusTree = validationDesignTree(repo)!;
    recordDelivery(regPath, repo, {
      runId: "r1",
      branch: "validation-design/r1",
      commit: delivery,
      baseCommit: base,
      corpusTree,
      deliveredAt: "2026-07-02T00:00:00Z",
    });
    recordFidelity(regPath, repo, {
      at: "2026-07-03T00:00:00Z",
      scope: "all waves",
      status: "ok",
      findings: 0,
      blocking: 0,
    });

    writeFileSync(join(repo, "src", "service.ts"), "export const version = 2;\n");
    const newTarget = commitAll(repo, "2026-07-04T00:00:00Z", "source changed");
    // Simulate a steady-state campaign that delivers identical corpus from a
    // newly pinned product revision. Old fidelity must not become current.
    recordDelivery(regPath, repo, {
      runId: "r2",
      branch: "validation-design/r2",
      commit: newTarget,
      baseCommit: newTarget,
      corpusTree,
      deliveredAt: "2026-07-05T00:00:00Z",
    });
    const flags = repoStatuses(loadRegistry(regPath))[0]!.flags;
    expect(flags.some((flag) => flag.startsWith("FIDELITY-STALE"))).toBe(true);
    expect(flags.some((flag) => flag.startsWith("DESIGN-STALE"))).toBe(false);
  });

  it("keeps findings open per scope instead of letting another scope erase them", () => {
    const repo = repoWithDocsCommittedAt("scopes", "2026-07-01T00:00:00Z");
    const base = head(repo);
    const delivery = installDelivery(repo, "s-1", "2026-07-02T00:00:00Z");
    recordDelivery(regPath, repo, {
      runId: "s-1",
      branch: "validation-design/s-1",
      commit: delivery,
      baseCommit: base,
      deliveredAt: "2026-07-02T00:00:00Z",
    });
    recordFidelity(regPath, repo, { at: "2026-07-03T00:00:00Z", scope: "wave 0", status: "findings", findings: 2, blocking: 1 });
    recordFidelity(regPath, repo, { at: "2026-07-04T00:00:00Z", scope: "wave 1", status: "ok", findings: 0, blocking: 0 });
    const flags = repoStatuses(loadRegistry(regPath))[0]!.flags;
    expect(flags.some((f) => f.startsWith("FINDINGS-OPEN") && f.includes("wave 0"))).toBe(true);
    expect(Object.keys(loadRegistry(regPath).repos[repo]!.fidelityByScope ?? {})).toEqual(["wave 0", "wave 1"]);
  });

  it("migrates a legacy lastFidelity into the per-scope ledger before recording another scope", () => {
    const repo = repoWithDocsCommittedAt("legacy-scope", "2026-07-01T00:00:00Z");
    const base = head(repo);
    const delivery = installDelivery(repo, "legacy-scope", "2026-07-02T00:00:00Z");
    recordDelivery(regPath, repo, {
      runId: "legacy-scope",
      branch: "validation-design/legacy-scope",
      commit: delivery,
      baseCommit: base,
      deliveredAt: "2026-07-02T00:00:00Z",
    });
    recordFidelity(regPath, repo, {
      at: "2026-07-03T00:00:00Z",
      scope: "wave 0",
      status: "findings",
      findings: 2,
      blocking: 1,
    });

    // Recreate the v1 shape written before fidelityByScope existed.
    const legacy = loadRegistry(regPath);
    delete legacy.repos[repo]!.fidelityByScope;
    writeFileSync(regPath, `${JSON.stringify(legacy, null, 2)}\n`);

    recordFidelity(regPath, repo, {
      at: "2026-07-04T00:00:00Z",
      scope: "wave 1",
      status: "ok",
      findings: 0,
      blocking: 0,
    });
    const migrated = loadRegistry(regPath).repos[repo]!;
    expect(Object.keys(migrated.fidelityByScope ?? {})).toEqual(["wave 0", "wave 1"]);
    expect(migrated.fidelityByScope?.["wave 0"]).toMatchObject({
      status: "findings",
      findings: 2,
      blocking: 1,
    });
    expect(repoStatuses(loadRegistry(regPath))[0]!.flags).toEqual(
      expect.arrayContaining([expect.stringMatching(/^FINDINGS-OPEN — wave 0:/)]),
    );
  });

  it("flags both an uninstalled delivery and fidelity run against the old checkout", () => {
    const repo = repoWithDocsCommittedAt("unbound", "2026-07-01T00:00:00Z");
    const base = head(repo);
    gitAt(repo, "2026-07-02T00:00:00Z", ["checkout", "-q", "-b", "validation-design/u-1"]);
    const delivery = installDelivery(repo, "u-1", "2026-07-02T00:00:00Z");
    gitAt(repo, "2026-07-02T00:00:00Z", ["checkout", "-q", "main"]);
    recordDelivery(regPath, repo, {
      runId: "u-1",
      branch: "validation-design/u-1",
      commit: delivery,
      baseCommit: base,
      deliveredAt: "2026-07-02T00:00:00Z",
    });
    recordFidelity(regPath, repo, { at: "2026-07-03T00:00:00Z", scope: "all waves", status: "ok", findings: 0, blocking: 0 });
    const flags = repoStatuses(loadRegistry(regPath))[0]!.flags;
    expect(flags.some((f) => f.startsWith("DELIVERY-NOT-IN-HEAD"))).toBe(true);
    expect(flags.some((f) => f.startsWith("FIDELITY-UNBOUND"))).toBe(true);
  });

  it("unreadable target never passes silently: STALENESS-UNKNOWN", () => {
    recordDelivery(regPath, "/gone/repo", { runId: "g-1", branch: "b", commit: "c", deliveredAt: "2026-07-01T00:00:00Z" });
    const lines = repoStatuses(loadRegistry(regPath), []);
    expect(lines[0]!.flags.some((f) => f.startsWith("STALENESS-UNKNOWN"))).toBe(true);
  });

  it("empty registry renders as empty, not as healthy", () => {
    expect(renderRepos(repoStatuses(loadRegistry(regPath), []))).toContain("registry empty");
  });
});
