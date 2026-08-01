import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REGISTRY_SCHEMA,
  docsChangedSince,
  loadRegistry,
  recordCampaign,
  recordDelivery,
  recordFidelity,
  renderRepos,
  repoStatuses,
} from "../src/registry.js";

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

/** A product repo whose docs/ was last committed at `docsDate`. */
function repoWithDocsCommittedAt(name: string, docsDate: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "arch.md"), `# arch as of ${docsDate}\n`);
  gitAt(dir, docsDate, ["init", "-q", "-b", "main"]);
  gitAt(dir, docsDate, ["add", "-A"]);
  gitAt(dir, docsDate, ["commit", "-q", "-m", "docs"]);
  return dir;
}

describe("registry persistence", () => {
  it("absent file loads as an empty registry; records round-trip", () => {
    expect(loadRegistry(regPath).repos).toEqual({});
    recordCampaign(regPath, "/repos/a", {
      runId: "a-1",
      mode: "greenfield",
      status: "completed",
      verdict: "clean",
      at: "2026-07-01T00:00:00Z",
    });
    recordDelivery(
      regPath,
      "/repos/a",
      { runId: "a-1", branch: "validation-design/a-1", commit: "abc123", deliveredAt: "2026-07-01T01:00:00Z" },
      "validation-architect/case-catalog/v1",
    );
    recordFidelity(regPath, "/repos/a", {
      at: "2026-07-02T00:00:00Z",
      scope: "wave 0",
      status: "ok",
      findings: 0,
      blocking: 0,
    });
    const entry = loadRegistry(regPath).repos["/repos/a"]!;
    expect(entry.lastCampaign?.runId).toBe("a-1");
    expect(entry.delivery?.branch).toBe("validation-design/a-1");
    expect(entry.lastFidelity?.status).toBe("ok");
    expect(entry.enablementSchema).toBe("validation-architect/case-catalog/v1");
    // upserts preserve unrelated fields
    recordFidelity(regPath, "/repos/a", { at: "2026-07-10T00:00:00Z", scope: "wave 1", status: "findings", findings: 2, blocking: 1 });
    const after = loadRegistry(regPath).repos["/repos/a"]!;
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

describe("the staleness question, one command (#8 acceptance)", () => {
  it("two targets: stale design vs never-delivered/never-audited, answered together", () => {
    // Target A: delivered 2026-07-01, docs moved 2026-07-15 → DESIGN-STALE.
    const repoA = repoWithDocsCommittedAt("a", "2026-07-15T00:00:00Z");
    recordCampaign(regPath, repoA, { runId: "a-1", mode: "greenfield", status: "completed", verdict: "clean", at: "2026-07-01T00:00:00Z" });
    recordDelivery(regPath, repoA, { runId: "a-1", branch: "validation-design/a-1", commit: "aaa", deliveredAt: "2026-07-01T00:00:00Z" });
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

  it("a healthy repo shows ok: delivered after the last docs commit, clean fidelity", () => {
    const repo = repoWithDocsCommittedAt("healthy", "2026-07-01T00:00:00Z");
    recordCampaign(regPath, repo, { runId: "h-1", mode: "revision", status: "completed", verdict: "clean", at: "2026-07-05T00:00:00Z" });
    recordDelivery(regPath, repo, { runId: "h-1", branch: "validation-design/h-1", commit: "hhh", deliveredAt: "2026-07-05T00:00:00Z" });
    recordFidelity(regPath, repo, { at: "2026-07-06T00:00:00Z", scope: "all waves", status: "ok", findings: 0, blocking: 0 });
    const lines = repoStatuses(loadRegistry(regPath), [], { now: new Date("2026-07-31T00:00:00Z") });
    expect(lines[0]!.flags).toEqual([]);
    expect(renderRepos(lines)).toContain("  ok");
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
