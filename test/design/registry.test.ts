import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  evaluateFleetStatus,
  recordCampaignCompletion,
  recordDeliveryCompletion,
  recordFidelityCompletion,
  registryEntries,
  registryStatus,
} from "../../src/design/registry.js";
import type { RunContext } from "../../src/design/run-context.js";

const root = mkdtempSync(join(tmpdir(), "va-design-registry-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const context: RunContext = {
  schema: "validation-architect-design/run-context/v1",
  runId: "registry-run",
  target: join(root, "target"),
  snapshot: join(root, "snapshot"),
  sourceRevision: "a".repeat(40),
  profile: "C2",
  intakeSource: join(root, "target", "rambling.txt"),
  createdAt: "2026-08-19T00:00:00.000Z",
};

describe("public-engine fleet registry", () => {
  it("is UNKNOWN by absence and writes only explicit completion evidence", () => {
    const path = join(root, "registry.json");
    expect(registryStatus(path, context.target)).toBeNull();
    expect(evaluateFleetStatus(null, context.target)).toBe("UNKNOWN");
    expect(registryEntries(path)).toEqual([]);

    recordCampaignCompletion(path, context, "2026-08-19T01:00:00.000Z");
    expect(registryStatus(path, context.target)?.campaign).toEqual({
      runId: context.runId,
      sourceRevision: context.sourceRevision,
      completedAt: "2026-08-19T01:00:00.000Z",
    });
    expect(evaluateFleetStatus(registryStatus(path, context.target), context.target)).toBe("NEVER_DELIVERED");

    recordDeliveryCompletion(path, context, {
      branch: "validation-design/registry-run",
      commit: "b".repeat(40),
      baseCommit: context.sourceRevision,
    }, "2026-08-19T02:00:00.000Z");
    expect(registryStatus(path, context.target)?.delivery).toMatchObject({
      runId: context.runId,
      branch: "validation-design/registry-run",
      deliveredAt: "2026-08-19T02:00:00.000Z",
    });
    expect(registryEntries(path)).toHaveLength(1);

    recordFidelityCompletion(path, context.target, "b".repeat(40), "findings", "2026-08-19T03:00:00.000Z");
    expect(registryStatus(path, context.target)?.fidelity).toEqual({
      sourceRevision: "b".repeat(40),
      verdict: "findings",
      recordedAt: "2026-08-19T03:00:00.000Z",
    });
  });

  it("never registers fixture completions", () => {
    const path = join(root, "fixture-registry.json");
    recordCampaignCompletion(path, { ...context, fixture: "lumen-webapp" });
    expect(registryEntries(path)).toEqual([]);
  });
});
