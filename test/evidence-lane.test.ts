import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CaseCatalogManifest,
  checkCatalogAgreement,
  parseCatalogMarkdown,
  parseManifest,
  serializeManifest,
} from "../src/catalog.js";
import { runTrace } from "../src/trace.js";

function evidenceManifest(overrides: Partial<Record<string, unknown>> = {}): CaseCatalogManifest {
  return {
    schema: "validation-architect/case-catalog/v1",
    families: [
      {
        id: "CF-EV-L3",
        section: "Harness self-test register",
        status: "implementable",
        layers: "3",
        risk: "E3",
        ticket: "HB-001",
        wave: "0",
        evidence_path: "research/cert.md",
        evidence_state: "incomplete",
        ...overrides,
      } as CaseCatalogManifest["families"][number],
    ],
    tickets: [{ id: "HB-001", name: "L3 certification", wave: "0", status: "landed", families: ["CF-EV-L3"] }],
  };
}

function makeTarget(manifest: CaseCatalogManifest, opts: { artifact?: boolean } = {}): string {
  const target = mkdtempSync(join(tmpdir(), "vda-evidence-"));
  mkdirSync(join(target, "validation-design"), { recursive: true });
  mkdirSync(join(target, "tests"), { recursive: true });
  writeFileSync(join(target, "validation-design", "case-catalog.yaml"), serializeManifest(manifest));
  if (opts.artifact !== false) {
    mkdirSync(join(target, "research"), { recursive: true });
    writeFileSync(join(target, "research", "cert.md"), "# Certification record\n");
  }
  return target;
}

describe("evidence-lane manifest validation", () => {
  it("round-trips a valid evidence declaration through serialize + parse", () => {
    const parsed = parseManifest(serializeManifest(evidenceManifest()));
    expect(parsed.families[0]?.evidence_state).toBe("incomplete");
    expect(parsed.families[0]?.evidence_path).toBe("research/cert.md");
  });

  it("rejects an invalid evidence state", () => {
    expect(() => parseManifest(serializeManifest(evidenceManifest({ evidence_state: "done" })))).toThrow(
      /invalid evidence_state/,
    );
  });

  it("rejects an unpaired evidence declaration", () => {
    expect(() =>
      parseManifest(serializeManifest(evidenceManifest({ evidence_state: undefined }))),
    ).toThrow(/invalid evidence_state|paired/);
  });

  it("rejects traversal and absolute evidence paths", () => {
    expect(() =>
      parseManifest(serializeManifest(evidenceManifest({ evidence_path: "../outside.md" }))),
    ).toThrow(/repo-relative/);
    expect(() =>
      parseManifest(serializeManifest(evidenceManifest({ evidence_path: "/etc/passwd" }))),
    ).toThrow(/repo-relative/);
  });

  it("rejects evidence on a non-implementable family", () => {
    const manifest = evidenceManifest({ status: "pruned", prune: "PRUNE-na", layers: undefined, risk: undefined });
    expect(() => parseManifest(serializeManifest(manifest))).toThrow(/implementable families only/);
  });
});

describe("evidence-lane markdown grammar and agreement", () => {
  const md = `# Catalog

## Harness self-test register

| Cell | Case family | Layer | Oracle | Risk |
| --- | --- | --- | --- | --- |
| CF-EV-L3 | real certification EVIDENCE:incomplete:research/cert.md | 3 | evid | E3 |
`;

  it("extracts the EVIDENCE token from an implementable row", () => {
    const parsed = parseCatalogMarkdown(md);
    expect(parsed.families[0]?.evidence_state).toBe("incomplete");
    expect(parsed.families[0]?.evidence_path).toBe("research/cert.md");
  });

  it("flags manifest ↔ markdown evidence disagreement", () => {
    const manifest = evidenceManifest({ evidence_state: "complete" });
    const out = checkCatalogAgreement(manifest, md);
    expect(out.some((x) => x.includes("CF-EV-L3") && x.includes("evidence declaration disagrees"))).toBe(true);
  });

  it("agrees when both surfaces declare the same evidence", () => {
    const out = checkCatalogAgreement(evidenceManifest(), md);
    expect(out.filter((x) => x.includes("evidence"))).toEqual([]);
  });
});

describe("evidence-lane trace closure", () => {
  it("closes forward and status honesty via a verified evidence artifact", () => {
    const r = runTrace(makeTarget(evidenceManifest()));
    expect(r.ok).toBe(true);
    expect(r.checks.forward).toEqual([]);
    expect(r.checks.statusHonesty).toEqual([]);
    expect(r.report).toContain("Evidence-cited families");
    expect(r.report).toContain("incomplete");
    expect(r.report).toContain("research/cert.md");
  });

  it("fails closed when the declared artifact is missing", () => {
    const r = runTrace(makeTarget(evidenceManifest(), { artifact: false }));
    expect(r.ok).toBe(false);
    expect(r.checks.forward.some((x) => x.includes("CF-EV-L3") && x.includes("does not exist"))).toBe(true);
    expect(r.report).toContain("**MISSING**");
  });

  it("never lets evidence excuse a family that also has zero declaration", () => {
    const manifest = evidenceManifest({ evidence_path: undefined, evidence_state: undefined });
    const r = runTrace(makeTarget(manifest));
    expect(r.ok).toBe(false);
    expect(r.checks.statusHonesty.some((x) => x.includes("CF-EV-L3"))).toBe(true);
  });
});
