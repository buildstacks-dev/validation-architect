import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRACEABILITY_CONVENTIONS } from "../src/conventions.js";
import { materializeEnablementBundle } from "../src/enablement.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("product-repo enablement bundle", () => {
  it("materializes the skill, CI lane, pinned install guide, and exact conventions", () => {
    const root = mkdtempSync(join(tmpdir(), "vda-enablement-test-"));
    scratch.push(root);
    const corpus = join(root, "validation-design");
    const bundle = materializeEnablementBundle(corpus, resolve(__dirname, ".."));

    expect(existsSync(join(bundle, "skills", "implement-harness-ticket", "SKILL.md"))).toBe(true);
    expect(existsSync(join(bundle, "ci", "validation-trace.yml"))).toBe(true);
    const version = (JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as {
      version: string;
    }).version;
    expect(readFileSync(join(bundle, "INSTALL.md"), "utf8")).toContain(
      `validation-architect@${version}`,
    );
    expect(readFileSync(join(bundle, "INSTALL.md"), "utf8")).not.toContain("{{PACKAGE_VERSION}}");
    expect(readFileSync(join(bundle, "traceability-conventions.md"), "utf8")).toContain(
      TRACEABILITY_CONVENTIONS,
    );
  });
});
