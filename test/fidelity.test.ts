import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkFidelityReportFormat,
  resolveFidelityScope,
  runBoundFidelityAudit,
  runFidelityAudit,
  specsByFamily,
} from "../src/fidelity.js";
import { runTrace } from "../src/trace.js";
import type { AuditorRunner } from "../src/types.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const weakened = join(repoRoot, "test", "fixtures", "fidelity", "weakened");
const orphanSpec = join(repoRoot, "test", "fixtures", "trace", "orphan-spec");
const tempRepos: string[] = [];

afterEach(() => {
  for (const dir of tempRepos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function committedFidelityRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "vda-fidelity-bound-"));
  tempRepos.push(root);
  cpSync(weakened, root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

function scripted(report: string): AuditorRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run(prompt: string): Promise<string> {
      calls.push(prompt);
      return Promise.resolve(report);
    },
  };
}

const WEAKENED_FINDING_REPORT = `mode: fidelity

AUD-901 (blocking) — tests/cf-w01-r/cf-w01-r.test.ts — CF-W01-R detector cannot fire

Catalog: "every named refusal class refuses pre-mutation" (case-catalog.yaml, oracle: refusal).
Spec: \`expect(true).toBe(true)\` — no duplicate is ever seeded; the negative control plants no violation.

## What I checked

- CF-W01-S: tests/cf-w01-s/cf-w01-s.test.ts — axes a–d, honest.
- CF-W01-R: tests/cf-w01-r/cf-w01-r.test.ts — axes a–d; axis b fails.
`;

describe("fidelity fixture preconditions", () => {
  it("the weakened tree is TRACE-GREEN — closure cannot see the weakening", () => {
    const trace = runTrace(weakened);
    expect(trace.ok).toBe(true);
    expect(trace.reds).toEqual([]);
  });
});

describe("closure preflight", () => {
  it("refuses a trace-red repo without spending an auditor call", async () => {
    const auditor = scripted("never called");
    const res = await runFidelityAudit(auditor, orphanSpec);
    expect(res.status).toBe("refused-closure");
    expect(res.reds.length).toBeGreaterThan(0);
    expect(res.report).toContain("REFUSED");
    expect(auditor.calls).toHaveLength(0);
  });
});

describe("immutable target binding", () => {
  const cleanReport = `mode: fidelity

## What I checked

- CF-W01-S: tests/cf-w01-s/cf-w01-s.test.ts — all four axes.
- CF-W01-R: tests/cf-w01-r/cf-w01-r.test.ts — all four axes.
`;

  it("refuses a dirty checkout before creating a live auditor call", async () => {
    const target = committedFidelityRepo();
    writeFileSync(join(target, "untracked.txt"), "dirty\n");
    const auditor = scripted(cleanReport);

    await expect(runBoundFidelityAudit(auditor, target, { wave: "0" })).rejects.toThrow(
      /uncommitted or untracked/,
    );
    expect(auditor.calls).toHaveLength(0);
  });

  it("audits a detached no-remote clone and reports the pre-audit commit/tree", async () => {
    const target = committedFidelityRepo();
    const expectedCommit = git(target, ["rev-parse", "HEAD"]);
    const expectedTree = git(target, ["rev-parse", "HEAD^{tree}"]);
    let auditRoot = "";
    const auditor: AuditorRunner = {
      run(_prompt, workspace): Promise<string> {
        auditRoot = workspace;
        expect(workspace).not.toBe(target);
        expect(git(workspace, ["rev-parse", "HEAD"])).toBe(expectedCommit);
        expect(git(workspace, ["remote"])).toBe("");
        return Promise.resolve(cleanReport);
      },
    };

    const bound = await runBoundFidelityAudit(auditor, target, { wave: "0" });
    expect(auditRoot).not.toBe("");
    expect(bound.targetRevision).toMatchObject({
      commit: expectedCommit,
      sourceTree: expectedTree,
      dirty: false,
    });
    expect(bound.result.report).toContain(`target-commit: ${expectedCommit}`);
    expect(bound.result.report).toContain(`target-tree: ${expectedTree}`);
    expect(bound.result.report).toContain("input: detached immutable snapshot");
  });

  it("invalidates the result when the user checkout moves during the live pass", async () => {
    const target = committedFidelityRepo();
    const before = git(target, ["rev-parse", "HEAD"]);
    const auditor: AuditorRunner & { calls: number } = {
      calls: 0,
      run(): Promise<string> {
        this.calls++;
        writeFileSync(join(target, "source-only.ts"), "export const moved = true;\n");
        git(target, ["add", "source-only.ts"]);
        git(target, ["commit", "-q", "-m", "move during audit"]);
        return Promise.resolve(cleanReport);
      },
    };

    await expect(runBoundFidelityAudit(auditor, target, { wave: "0" })).rejects.toThrow(
      /Target changed.*result is invalid/,
    );
    expect(auditor.calls).toBe(1);
    expect(git(target, ["rev-parse", "HEAD"])).not.toBe(before);
  });

  it("rejects relative path traversal before the live pass", async () => {
    const target = committedFidelityRepo();
    const auditor = scripted(cleanReport);
    await expect(
      runBoundFidelityAudit(auditor, target, { manifestPath: "../outside.yaml" }),
    ).rejects.toThrow(/must be inside the target repo/);
    expect(auditor.calls).toHaveLength(0);
  });

  it("maps absolute in-repo manifest/test paths into the immutable clone", async () => {
    const target = committedFidelityRepo();
    const auditor = scripted(cleanReport);
    const bound = await runBoundFidelityAudit(auditor, target, {
      manifestPath: join(target, "validation-design", "case-catalog.yaml"),
      testsRoot: join(target, "tests"),
      wave: "0",
    });
    expect(bound.result.status).toBe("ok");
    expect(auditor.calls).toHaveLength(1);
  });
});

describe("scope resolution", () => {
  const trace = runTrace(weakened);
  const manifest = trace.manifest!;
  const byFamily = specsByFamily(manifest, trace.specs);

  it("wave scope: exhaustive over the wave's tickets, implementable families only", () => {
    const scope = resolveFidelityScope(manifest, byFamily, { wave: "0" });
    expect(scope.tickets.map((t) => t.id)).toEqual(["HB-001"]);
    expect(scope.families.map((f) => f.family.id).sort()).toEqual(["CF-W01-R", "CF-W01-S"]);
    const r = scope.families.find((f) => f.family.id === "CF-W01-R")!;
    expect(r.files).toEqual(["tests/cf-w01-r/cf-w01-r.test.ts"]);
  });

  it("ticket scope: explicit set wins", () => {
    const scope = resolveFidelityScope(manifest, byFamily, { tickets: ["HB-002"] });
    expect(scope.families.map((f) => f.family.id)).toEqual(["CF-W02"]);
    // pending family: no citing spec, surfaced as declared-pending
    expect(scope.families[0]!.files).toEqual([]);
  });

  it("no scope flags: the whole backlog", () => {
    const scope = resolveFidelityScope(manifest, byFamily, {});
    expect(scope.label).toBe("all waves");
    expect(scope.families).toHaveLength(3);
  });

  it("fails closed on an unknown ticket and an empty wave", () => {
    expect(() => resolveFidelityScope(manifest, byFamily, { tickets: ["HB-999"] })).toThrow(/Unknown ticket/);
    expect(() => resolveFidelityScope(manifest, byFamily, { wave: "7" })).toThrow(/owns no tickets/);
  });
});

describe("the fidelity prompt", () => {
  it("scopes the sample, states the four axes, and forbids patches", async () => {
    const auditor = scripted(WEAKENED_FINDING_REPORT);
    await runFidelityAudit(auditor, weakened, { wave: "0" });
    const prompt = auditor.calls[0]!;
    // scoped families with their citing specs; out-of-scope family excluded
    expect(prompt).toContain("CF-W01-R");
    expect(prompt).toContain("tests/cf-w01-r/cf-w01-r.test.ts");
    expect(prompt).not.toContain("CF-W02");
    // the four axes and the boundaries
    expect(prompt).toContain("Seed coverage");
    expect(prompt).toContain("Negative-control reality");
    expect(prompt).toContain("Oracle match");
    expect(prompt).toContain("No quiet narrowing");
    expect(prompt).toContain("FINDINGS ONLY");
    expect(prompt).toContain("never propose a patch");
    expect(prompt).toContain("Never relitigate ratified decisions");
    expect(prompt).toContain("AUD-901");
    // the anti-yield rule (a live session once ended on mid-work narration)
    expect(prompt).toContain("no sub-agents, sub-passes, or parallel helpers");
    expect(prompt).toContain('"What I checked"');
  });
});

describe("the weakened-spec pass (acceptance negative control)", () => {
  it("a fidelity pass over the weakened tree yields a finding citing the weakened file", async () => {
    const auditor = scripted(WEAKENED_FINDING_REPORT);
    const res = await runFidelityAudit(auditor, weakened, { wave: "0" });
    expect(res.status).toBe("findings");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ id: "AUD-901", tier: "blocking", iteration: 9 });
    expect(res.findings[0]!.title).toContain("cf-w01-r.test.ts");
    expect(res.report).toContain("mode: fidelity");
    expect(res.report).toContain("scope: wave 0");
    expect(res.report).toContain("findings: 1");
    expect(res.violations).toEqual([]);
  });

  it("a clean report over an honest scope is ok", async () => {
    const clean = `mode: fidelity

## What I checked

- CF-W01-S: tests/cf-w01-s/cf-w01-s.test.ts — all four axes.
- CF-W01-R: tests/cf-w01-r/cf-w01-r.test.ts — all four axes.
`;
    const res = await runFidelityAudit(scripted(clean), weakened, { tickets: ["HB-001"] });
    expect(res.status).toBe("ok");
    expect(res.findings).toEqual([]);
  });

  it("fails closed when What I checked omits part of the declared scope", async () => {
    const partial = `mode: fidelity

## What I checked

- CF-W01-S: tests/cf-w01-s/cf-w01-s.test.ts — all four axes.
`;
    const res = await runFidelityAudit(scripted(partial), weakened, { tickets: ["HB-001"] });
    expect(res.status).toBe("protocol-violation");
    expect(res.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("omits scoped family CF-W01-R"),
      ]),
    );
  });

  it("fails closed when a scoped family is listed without every citing file", async () => {
    const missingFile = `mode: fidelity

## What I checked

- CF-W01-S — all four axes.
- CF-W01-R: tests/cf-w01-r/cf-w01-r.test.ts — all four axes.
`;
    const res = await runFidelityAudit(scripted(missingFile), weakened, { tickets: ["HB-001"] });
    expect(res.status).toBe("protocol-violation");
    expect(res.violations.some((violation) => violation.includes("cf-w01-s.test.ts"))).toBe(true);
  });
});

describe("findings-only format guard (red-then-green)", () => {
  it("RED: a report smuggling a patch is a protocol violation", async () => {
    const patchReport = `mode: fidelity

AUD-901 (blocking) — tests/cf-w01-r/cf-w01-r.test.ts — detector cannot fire

Fix it like this:

\`\`\`diff
- expect(true).toBe(true);
+ expect(store.add(dup)).toThrow();
\`\`\`
`;
    const res = await runFidelityAudit(scripted(patchReport), weakened, { wave: "0" });
    expect(res.status).toBe("protocol-violation");
    expect(res.violations.some((v) => v.includes("fenced diff"))).toBe(true);
    expect(res.report).toContain("PROTOCOL-VIOLATION");
    // the finding is still parsed — the violation is about the patch, not the finding
    expect(res.findings).toHaveLength(1);
  });

  it("catches unified-diff hunks and 'apply this change' prose", () => {
    expect(checkFidelityReportFormat("+++ b/tests/x.test.ts\n@@ -1,2 +1,2 @@")).toEqual([
      expect.stringContaining("unified-diff hunks"),
    ]);
    expect(checkFidelityReportFormat("Please apply this change to the spec.")).toEqual([
      expect.stringContaining("apply this change"),
    ]);
  });

  it("rejects findings outside the fidelity-reserved AUD-9xx range", () => {
    expect(
      checkFidelityReportFormat(
        "AUD-101 (blocking) — tests/x.test.ts — campaign-range id in a fidelity report",
      ),
    ).toEqual([expect.stringContaining("outside the reserved AUD-9xx range")]);
  });

  it("GREEN: findings-only prose passes, and markdown horizontal rules are not diff hunks", () => {
    expect(checkFidelityReportFormat(WEAKENED_FINDING_REPORT)).toEqual([]);
    expect(checkFidelityReportFormat("above\n\n---\n\nbelow")).toEqual([]);
  });

  it("RED: mid-work narration without the mandatory 'What I checked' section must not read as a clean pass", async () => {
    // Observed live (Operon wave-0/1 pass, 2026-08-01): the auditor yielded
    // its turn with "waiting for the remaining sub-passes to complete" — the
    // runner returned that narration as the final text, and it parsed as a
    // clean zero-finding report. Fail closed instead.
    const narration =
      "Verified the CF-B17 driver context directly. Now waiting for the remaining sub-passes to complete; I'll write the final report afterwards.";
    const res = await runFidelityAudit(scripted(narration), weakened, { tickets: ["HB-001"] });
    expect(res.status).toBe("protocol-violation");
    expect(res.violations.some((v) => v.includes("What I checked"))).toBe(true);
    expect(res.report).toContain("PROTOCOL-VIOLATION");
  });
});
