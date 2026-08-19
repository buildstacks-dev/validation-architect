import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const record = readFileSync(
  resolve(root, "docs/decisions/2026-08-19-campaign-consolidation.md"),
  "utf8",
);

const dispositions = new Map([
  ["fixture/demo runs", "replace"],
  ["immutable target capture", "port"],
  ["revision mode and source recovery", "replace"],
  ["model/auth configuration", "port"],
  ["rambling/intake hot reload", "port"],
  ["transcript and human report generation", "replace"],
  ["fresh readers and independent audit", "replace"],
  ["post-hoc readers/audit", "port"],
  ["branch delivery and idempotent re-delivery", "port"],
  ["fidelity audit", "port"],
  ["fleet registry and staleness reporting", "port"],
  ["live smoke behavior", "replace"],
  ["old aborted/completed run inspection", "drop"],
] as const);

describe("campaign consolidation capability record", () => {
  it("accounts exactly once for every unique legacy-host capability", () => {
    for (const [capability, disposition] of dispositions) {
      const row = `| **${capability}** | \`${disposition}\` |`;
      expect(record.split(row).length - 1, capability).toBe(1);
    }
    expect(record.match(/^\| \*\*[^|]+\*\* \| `(?:port|replace|drop)` \|/gm)).toHaveLength(dispositions.size);
  });

  it("selects one public-engine command and refuses legacy-state compatibility", () => {
    expect(record).toContain("`validation-architect-design` is the sole live campaign command");
    expect(record).toContain("public `design()` / `resume()` engine");
    expect(record).toContain("`CampaignCheckpoint` is the only campaign transition state");
    expect(record).toContain("no legacy compatibility path");
    expect(record).toContain("preserved untouched on this machine");
  });
});
