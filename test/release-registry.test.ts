import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyViewResult,
  publicationPlan,
  tarballIntegrity,
} from "../scripts/release-registry.mjs";

const version = "0.4.3";
const integrity = `sha512-${createHash("sha512").update("tarball").digest("base64")}`;
const processResult = (status: number, stdout: string, stderr = "") => ({ status, stdout, stderr });

describe("release registry reconciliation", () => {
  it("distinguishes an explicit E404 from network/auth ambiguity", () => {
    expect(
      classifyViewResult(
        processResult(1, JSON.stringify({ error: { code: "E404" } }), "npm error code E404"),
        version,
        integrity,
        "validation-architect",
      ),
    ).toEqual({ state: "missing" });
    expect(() =>
      classifyViewResult(
        processResult(1, "", "npm error code ECONNRESET"),
        version,
        integrity,
        "validation-architect",
      ),
    ).toThrow(/ambiguous/);
  });

  it("accepts only the exact published version and tarball integrity", () => {
    const exact = JSON.stringify({ version, "dist.integrity": integrity });
    expect(classifyViewResult(processResult(0, exact), version, integrity, "validation-architect")).toEqual({
      state: "matching",
      integrity,
    });
    expect(() =>
      classifyViewResult(
        processResult(0, JSON.stringify({ version, "dist.integrity": "sha512-other" })),
        version,
        integrity,
        "validation-architect",
      ),
    ).toThrow(/different integrity/);
  });

  it("plans a fresh or core-complete recovery without allowing reverse skew", () => {
    const missing = { state: "missing" } as const;
    const matching = { state: "matching", integrity } as const;
    expect(publicationPlan(missing, missing)).toEqual({ publishCore: true, publishDesign: true });
    expect(publicationPlan(matching, missing)).toEqual({ publishCore: false, publishDesign: true });
    expect(publicationPlan(matching, matching)).toEqual({ publishCore: false, publishDesign: false });
    expect(() => publicationPlan(missing, matching)).toThrow(/Design is published while core is missing/);
  });

  it("computes npm-compatible sha512 SRI from the exact tarball bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "va-registry-test-"));
    const path = join(directory, "fixture.tgz");
    writeFileSync(path, "tarball");
    try {
      expect(tarballIntegrity(path)).toBe(integrity);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
