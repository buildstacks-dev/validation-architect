import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse, stringify } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { main, planControlSweep } from "../enablement/sweep/control-sweep.mjs";
import * as api from "../src/api/index.js";
import { writeValidModel } from "./model-corpus-fixture.js";

/**
 * VA-ENF-008 (#60): the recurring falsifiability sweep. The shipped
 * scheduled-lane template proves, per landed negative control, that the
 * detector run is green unseeded and RED under VA_SEEDED_CONTROL=<control-id>.
 * A control that cannot go red fails the sweep, an empty sweep fails rather
 * than passes (rule 17), and a corpus that does not adopt the template
 * compiles and checks exactly as before.
 */

type DetectorShape = "seed-aware" | "tautological" | "always-red";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sweepTarget(options: { detector: DetectorShape; ticketStatus?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "va-control-sweep-"));
  roots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "PRODUCT.md"), "# Product\n\nContract\n");
  writeValidModel(root);
  const model = join(root, "validation-design", "model");

  const backlogPath = join(model, "backlog.yaml");
  writeFileSync(
    backlogPath,
    readFileSync(backlogPath, "utf8").replace("status: pending", `status: ${options.ticketStatus ?? "landed"}`),
  );
  const policyPath = join(model, "policy.yaml");
  const policy = parse(readFileSync(policyPath, "utf8")) as { lanes: Array<Record<string, unknown>> };
  const perCommit = policy.lanes.find((lane) => lane.id === "per-commit");
  if (!perCommit) throw new Error("fixture is missing its per-commit lane");
  perCommit.command = "node tests/detector.mjs";
  writeFileSync(policyPath, stringify(policy, { lineWidth: 0 }));

  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "fixture.test.ts"), "// Family: CF-X01-S\nit('holds', () => {});\n");
  const detectors: Record<DetectorShape, string> = {
    "seed-aware": "process.exit(process.env.VA_SEEDED_CONTROL === 'NC-X01' ? 1 : 0);\n",
    tautological: "process.exit(0);\n",
    "always-red": "process.exit(2);\n",
  };
  writeFileSync(join(root, "tests", "detector.mjs"), detectors[options.detector]);
  return root;
}

async function runSweep(root: string): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await main(root, { api, log: (line: string) => lines.push(line) });
  return { code, output: lines.join("\n") };
}

function portOver(root: string): InstanceType<typeof api.FakeRepositoryPort> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return new api.FakeRepositoryPort({ revision: "abc123", files });
}

describe("recurring control-falsifiability sweep (VA-ENF-008)", () => {
  it("passes when every landed control is green unseeded and red under its seed", async () => {
    const { code, output } = await runSweep(sweepTarget({ detector: "seed-aware" }));
    expect(output).toContain("NC-X01");
    expect(output).toMatch(/went red/i);
    expect(code).toBe(0);
  });

  it("fails the lane naming the control that cannot go red", async () => {
    // The sweep's own negative control: a tautological detector that ignores
    // the seed and stays green must turn the sweep red.
    const { code, output } = await runSweep(sweepTarget({ detector: "tautological" }));
    expect(code).toBe(1);
    expect(output).toContain("NC-X01");
    expect(output).toMatch(/cannot go red/i);
  });

  it("fails a detector whose unseeded baseline is not green", async () => {
    // A broken command exits nonzero everywhere; that is not red-capability.
    const { code, output } = await runSweep(sweepTarget({ detector: "always-red" }));
    expect(code).toBe(1);
    expect(output).toMatch(/baseline .*not green/i);
  });

  it("fails an empty sweep instead of passing silently", async () => {
    // Nothing landed → nothing swept → red, never green (rule 17).
    const { code, output } = await runSweep(sweepTarget({ detector: "seed-aware", ticketStatus: "pending" }));
    expect(code).toBe(1);
    expect(output).toMatch(/swept no landed control/i);
  });

  it("plans only landed, implementable, test-lane controls from the public graph", async () => {
    const landed = await api.explain(portOver(sweepTarget({ detector: "seed-aware" })), "CF-X01-S");
    const plan = planControlSweep(landed.graph);
    expect(plan.entries).toEqual([
      expect.objectContaining({
        control_id: "NC-X01",
        family_id: "CF-X01-S",
        command: "node tests/detector.mjs",
        paths: ["tests/fixture.test.ts"],
      }),
    ]);

    const pending = await api.explain(
      portOver(sweepTarget({ detector: "seed-aware", ticketStatus: "pending" })),
      "CF-X01-S",
    );
    const pendingPlan = planControlSweep(pending.graph);
    expect(pendingPlan.entries).toEqual([]);
    expect(pendingPlan.skipped.map((item) => item.control_id)).toContain("NC-X01");
  });

  it("keeps a non-adopting corpus checking exactly as before", async () => {
    // AC2: the sweep is a shipped opt-in template, not a core behavior
    // change. The shared pending fixture still records the pre-sweep verdict
    // and no sweep-shaped finding exists anywhere in the record.
    const root = mkdtempSync(join(tmpdir(), "va-no-sweep-"));
    roots.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "PRODUCT.md"), "# Product\n\nContract\n");
    writeValidModel(root);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", ".keep"), "");
    const result = await api.check(portOver(root));
    expect(result.verdict).toBe("inconclusive");
    expect(result.reason).toBe("evidence_incomplete");
    expect(JSON.stringify(result)).not.toMatch(/SWEEP/);
  });
});
