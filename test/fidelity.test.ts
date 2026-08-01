import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkFidelityReportFormat,
  resolveFidelityScope,
  runFidelityAudit,
  specsByFamily,
} from "../src/fidelity.js";
import { runTrace } from "../src/trace.js";
import type { AuditorRunner } from "../src/types.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const weakened = join(repoRoot, "test", "fixtures", "fidelity", "weakened");
const orphanSpec = join(repoRoot, "test", "fixtures", "trace", "orphan-spec");

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

AUD-901 (blocking) — tests/cf-w01/cf-w01-r.test.ts — CF-W01-R detector cannot fire

Catalog: "every named refusal class refuses pre-mutation" (case-catalog.yaml, oracle: refusal).
Spec: \`expect(true).toBe(true)\` — no duplicate is ever seeded; the negative control plants no violation.

## What I checked

- CF-W01-S: tests/cf-w01/cf-w01-s.test.ts — axes a–d, honest.
- CF-W01-R: tests/cf-w01/cf-w01-r.test.ts — axis b fails.
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

describe("scope resolution", () => {
  const trace = runTrace(weakened);
  const manifest = trace.manifest!;
  const byFamily = specsByFamily(manifest, trace.specs);

  it("wave scope: exhaustive over the wave's tickets, implementable families only", () => {
    const scope = resolveFidelityScope(manifest, byFamily, { wave: "0" });
    expect(scope.tickets.map((t) => t.id)).toEqual(["HB-001"]);
    expect(scope.families.map((f) => f.family.id).sort()).toEqual(["CF-W01-R", "CF-W01-S"]);
    const r = scope.families.find((f) => f.family.id === "CF-W01-R")!;
    expect(r.files).toEqual(["tests/cf-w01/cf-w01-r.test.ts"]);
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
    expect(prompt).toContain("tests/cf-w01/cf-w01-r.test.ts");
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
    const clean = "mode: fidelity\n\n## What I checked\n\n- CF-W01-S: honest across all four axes.\n";
    const res = await runFidelityAudit(scripted(clean), weakened, { tickets: ["HB-001"] });
    expect(res.status).toBe("ok");
    expect(res.findings).toEqual([]);
  });
});

describe("findings-only format guard (red-then-green)", () => {
  it("RED: a report smuggling a patch is a protocol violation", async () => {
    const patchReport = `mode: fidelity

AUD-901 (blocking) — tests/cf-w01/cf-w01-r.test.ts — detector cannot fire

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

  it("GREEN: findings-only prose passes, and markdown horizontal rules are not diff hunks", () => {
    expect(checkFidelityReportFormat(WEAKENED_FINDING_REPORT)).toEqual([]);
    expect(checkFidelityReportFormat("above\n\n---\n\nbelow")).toEqual([]);
  });
});
