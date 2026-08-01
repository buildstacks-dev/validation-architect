import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkCatalogAgreement,
  expandCellId,
  extractCfTokens,
  generateManifest,
  parseBacklogMarkdown,
  parseCatalogMarkdown,
  parseManifest,
  serializeManifest,
  tokenMatch,
  workspaceCatalogProblems,
} from "../src/catalog.js";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const corpusDir = resolve(__dirname, "fixtures", "operon-corpus");
const catalogMd = readFileSync(join(corpusDir, "case-catalog.md"), "utf8");
const backlogMd = readFileSync(join(corpusDir, "harness-backlog.md"), "utf8");
const committedManifest = readFileSync(join(corpusDir, "case-catalog.yaml"), "utf8");

describe("expandCellId", () => {
  it("passes plain ids through", () => {
    expect(expandCellId("CF-J01-S")).toEqual({ ids: ["CF-J01-S"] });
    expect(expandCellId("CF-INV-001")).toEqual({ ids: ["CF-INV-001"] });
  });

  it("collapses wildcard and brace rows to their base family (row-collapsing convention)", () => {
    expect(expandCellId("CF-B02-*")).toEqual({ ids: ["CF-B02"] });
    expect(expandCellId("CF-B01-{ok,to,ps,rt,dup,stale,skew}")).toEqual({
      ids: ["CF-B01"],
      covers: ["ok", "to", "ps", "rt", "dup", "stale", "skew"],
    });
  });

  it("expands compound slash/plus suffixes to one id per cell", () => {
    expect(expandCellId("CF-SM-APPR-L/I/R/C").ids).toEqual([
      "CF-SM-APPR-L",
      "CF-SM-APPR-I",
      "CF-SM-APPR-R",
      "CF-SM-APPR-C",
    ]);
    expect(expandCellId("CF-S3-qual+judge").ids).toEqual(["CF-S3-qual", "CF-S3-judge"]);
    expect(expandCellId("CF-INV-001/002/004").ids).toEqual(["CF-INV-001", "CF-INV-002", "CF-INV-004"]);
  });

  it("rejects non-CF garbage", () => {
    expect(expandCellId("HB-014").ids).toEqual([]);
  });
});

describe("extractCfTokens", () => {
  it("does not pull CF-fragments out of non-family ids (B01-CF-11)", () => {
    expect(extractCfTokens('expect(failedIds).toContain("B01-CF-11");')).toEqual([]);
    expect(extractCfTokens("// CF-B01-L3 — the GitHub live smoke")).toEqual(["CF-B01-L3"]);
  });
});

describe("tokenMatch", () => {
  it("credits exact matches and extensions, groups bare bases", () => {
    expect(tokenMatch("CF-B14", "CF-B14")).toBe("credits");
    expect(tokenMatch("CF-B14-CE", "CF-B14")).toBe("credits"); // sub-id of a collapsed family
    expect(tokenMatch("CF-SM-APPR", "CF-SM-APPR-L")).toBe("group"); // resolves, no coverage credit
    expect(tokenMatch("CF-B14", "CF-B15")).toBe("none");
    expect(tokenMatch("CF-B1", "CF-B14")).toBe("none"); // no partial-token matches
  });
});

describe("parseCatalogMarkdown against the Operon pilot catalog (ground truth)", () => {
  const { families, problems } = parseCatalogMarkdown(catalogMd);
  const byId = new Map(families.map((f) => [f.id, f]));

  it("parses the whole catalog with zero problems (fail-closed parser)", () => {
    expect(problems).toEqual([]);
  });

  it("reproduces the catalog's own closure accounting", () => {
    // §9 closure statement: 81 journey family cells (+4 pruned +1 blocked as
    // 86 rows), 32 state-machine cells, 15 invariants, 22 boundary entries,
    // 22+1 contract entries, 6 interfaces, 33 LLM entries, 7 ops entries.
    expect(families).toHaveLength(224);
    expect(families.filter((f) => f.status === "implementable")).toHaveLength(192);
    expect(families.filter((f) => f.status === "pruned")).toHaveLength(31);
    expect(families.filter((f) => f.status === "blocked")).toHaveLength(1);
  });

  it("classifies plain journey rows", () => {
    expect(byId.get("CF-J01-S")).toMatchObject({
      status: "implementable",
      section: "Journey matrix",
      layers: "2",
      oracle: "state",
      risk: "STD",
    });
  });

  it("classifies prune rows including empty-cell prunes", () => {
    expect(byId.get("CF-J06-A")).toMatchObject({ status: "pruned", prune: "PRUNE-na" });
    expect(byId.get("CF-J13")).toMatchObject({ status: "pruned" }); // CF-J13-* wildcard row
    expect(byId.get("CF-J16-RC")).toMatchObject({ status: "pruned" }); // empty layer/oracle/risk cells
    expect(byId.get("CF-J16-RC")?.prune).toContain("PRUNE-dup:CF-J16-I");
  });

  it("classifies the blocked cell with its owning finding", () => {
    expect(byId.get("CF-J17-A")).toMatchObject({ status: "blocked", blocked_by: "B-17-L3" });
  });

  it("keeps embedded finding-blocks on implementable families", () => {
    expect(byId.get("CF-J10-I")?.blocked_remainder).toEqual(["F-PT-006"]);
    expect(byId.get("CF-B14")?.blocked_remainder).toEqual(["F-PT-015", "F-PT-016"]);
    expect(byId.get("CF-INV-002")?.blocked_remainder).toEqual(["F-PT-013"]);
  });

  it("expands collapsed state-machine rows despite pipes inside inline code", () => {
    // The CF-SM-APPR cell text contains `pending→approved|denied→…` — the
    // splitter must not shred the row on those pipes.
    for (const suffix of ["L", "I", "R", "C"]) {
      expect(byId.get(`CF-SM-APPR-${suffix}`)).toMatchObject({
        status: "implementable",
        layers: "2",
        oracle: "state",
        risk: "E1",
      });
    }
    expect(byId.get("CF-SM-LADDER-L")?.status).toBe("implementable");
    expect(byId.get("CF-SM-LADDER-R")?.status).toBe("pruned");
  });

  it("collapses boundary wildcard/brace rows to one family each", () => {
    expect(byId.get("CF-B01")?.covers).toEqual(["ok", "to", "ps", "rt", "dup", "stale", "skew"]);
    expect(byId.get("CF-B01-L3")?.layers).toBe("3");
    expect(byId.get("CF-B02")?.status).toBe("implementable");
    expect(byId.has("CF-B02-*")).toBe(false);
  });

  it("handles the §5 per-ID resolver table including its mixed-shape rows", () => {
    expect(byId.get("CF-C-B09A")).toMatchObject({
      status: "implementable",
      layers: "2",
      risk: "E1",
      blocked_remainder: ["F-PT-008"],
    });
    expect(byId.get("CF-C-OPLIFE")).toMatchObject({ status: "implementable", layers: "2" });
    expect(byId.get("CF-C-ACCEPT")?.status).toBe("pruned");
  });

  it("expands LLM-site compound rows (plus and slash)", () => {
    expect(byId.get("CF-S3-qual")?.status).toBe("implementable");
    expect(byId.get("CF-S3-judge")?.status).toBe("implementable");
    expect(byId.get("CF-S9-qual")?.status).toBe("pruned");
    expect(byId.get("CF-S9-traj")?.status).toBe("pruned");
    expect(byId.get("CF-S2-env")?.status).toBe("pruned"); // dup-pruned to the guardrail families
  });
});

describe("parseBacklogMarkdown against the Operon backlog", () => {
  const tickets = parseBacklogMarkdown(backlogMd);
  const byId = new Map(tickets.map((t) => [t.id, t]));

  it("finds every wave's tickets with wave labels", () => {
    expect(byId.get("HB-001")).toMatchObject({ wave: "0", landed: true });
    expect(byId.get("HB-014")).toMatchObject({ wave: "1", landed: false });
    expect(byId.get("HB-054")?.wave).toBe("L3");
    expect(byId.get("HB-070")?.wave).toBe("L5");
    expect(byId.get("HB-P1")?.wave).toBe("unparked");
    expect(byId.get("HB-P3")?.wave).toBe("parked");
    expect(byId.get("HB-080")?.wave).toBe("post-ratification");
  });

  it("expands the LANDED range annotation (HB-001..HB-006)", () => {
    const landed = tickets.filter((t) => t.landed).map((t) => t.id);
    expect(landed.sort()).toEqual(["HB-001", "HB-002", "HB-003", "HB-004", "HB-005", "HB-006"]);
  });

  it("extracts names and CF claims", () => {
    expect(byId.get("HB-001")?.name).toBe("Harness root + CI lane");
    expect(byId.get("HB-010")?.name).toBe("Gate classifier adversarial suite");
    expect(byId.get("HB-014")?.cfTokens).toContain("CF-B10-*");
    expect(byId.get("HB-014")?.cfTokens).toContain("CF-INV-001");
  });
});

describe("generateManifest (catalog × backlog join)", () => {
  const { manifest, problems } = generateManifest(catalogMd, backlogMd, {
    product: "operon",
    conventions: { tests_root: "claude-tests" },
  });

  it("joins with zero problems", () => {
    expect(problems).toEqual([]);
  });

  it("assigns owning tickets and waves from the first claiming backlog entry", () => {
    const inv1 = manifest.families.find((f) => f.id === "CF-INV-001");
    expect(inv1).toMatchObject({ ticket: "HB-014", wave: "1" });
    const b10 = manifest.families.find((f) => f.id === "CF-B10");
    expect(b10?.ticket).toBe("HB-014");
    const j07i = manifest.families.find((f) => f.id === "CF-J07-I");
    expect(j07i?.ticket).toBe("HB-022"); // Wave 2 claims it before HB-P1's unparked entry
  });

  it("round-trips: the committed sample manifest is exactly what generation produces", () => {
    // Guards drift between the fixture and the generator. Regenerate with
    //   pnpm trace generate test/fixtures/operon-corpus/case-catalog.md \
    //     test/fixtures/operon-corpus/harness-backlog.md --product operon \
    //     --tests-root claude-tests -o test/fixtures/operon-corpus/case-catalog.yaml
    expect(serializeManifest(manifest)).toBe(committedManifest);
  });

  it("the serialized manifest parses back and validates", () => {
    const parsed = parseManifest(serializeManifest(manifest));
    expect(parsed.families).toHaveLength(manifest.families.length);
    expect(parsed.tickets).toHaveLength(manifest.tickets.length);
  });
});

describe("parseManifest fail-closed validation", () => {
  it("rejects a wrong schema id", () => {
    expect(() => parseManifest("schema: nope/v9\nfamilies: []\ntickets: []\n")).toThrow(/schema/);
  });

  it("rejects families with invalid status", () => {
    expect(() =>
      parseManifest(
        `schema: validation-architect/case-catalog/v1\nfamilies:\n  - id: CF-X\n    status: done\ntickets: []\n`,
      ),
    ).toThrow(/invalid status/);
  });
});

describe("checkCatalogAgreement (manifest ↔ markdown, disagreement = red)", () => {
  const manifest = parseManifest(committedManifest);

  it("agrees on the untouched Operon pair (clean path)", () => {
    expect(checkCatalogAgreement(manifest, catalogMd)).toEqual([]);
  });

  it("fires when the manifest is missing a family the markdown has", () => {
    const mutilated = { ...manifest, families: manifest.families.filter((f) => f.id !== "CF-INV-007") };
    const reds = checkCatalogAgreement(mutilated, catalogMd);
    expect(reds.some((r) => r.includes("CF-INV-007") && r.includes("missing from the manifest"))).toBe(true);
  });

  it("fires when the manifest invents a family the markdown lacks", () => {
    const extra = {
      ...manifest,
      families: [...manifest.families, { id: "CF-FAKE-001", section: "Journey matrix", status: "implementable" as const }],
    };
    const reds = checkCatalogAgreement(extra, catalogMd);
    expect(reds.some((r) => r.includes("CF-FAKE-001") && r.includes("not in case-catalog.md"))).toBe(true);
  });

  it("fires on a status flip (a silently un-pruned family)", () => {
    const flipped = {
      ...manifest,
      families: manifest.families.map((f) =>
        f.id === "CF-J06-A" ? { ...f, status: "implementable" as const } : f,
      ),
    };
    const reds = checkCatalogAgreement(flipped, catalogMd);
    expect(reds.some((r) => r.includes("CF-J06-A") && r.includes("pruned"))).toBe(true);
  });

  it("fires on a blocked-by swap", () => {
    const swapped = {
      ...manifest,
      families: manifest.families.map((f) =>
        f.id === "CF-J17-A" ? { ...f, blocked_by: "F-PT-999" } : f,
      ),
    };
    const reds = checkCatalogAgreement(swapped, catalogMd);
    expect(reds.some((r) => r.includes("CF-J17-A") && r.includes("blocked-by disagrees"))).toBe(true);
  });
});

describe("workspaceCatalogProblems (the campaign completion gate)", () => {
  function makeWorkspace(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "vda-catalog-gate-"));
    mkdirSync(join(dir, "validation-design"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, "validation-design", name), content);
    }
    return dir;
  }

  it("is clean when manifest and markdown agree", () => {
    const ws = makeWorkspace({ "case-catalog.md": catalogMd, "case-catalog.yaml": committedManifest });
    expect(workspaceCatalogProblems(ws)).toEqual([]);
  });

  it("fails closed when the manifest deliverable is missing", () => {
    const ws = makeWorkspace({ "case-catalog.md": catalogMd });
    expect(workspaceCatalogProblems(ws).some((p) => p.includes("case-catalog.yaml is missing"))).toBe(true);
  });

  it("fails closed when the manifest does not parse", () => {
    const ws = makeWorkspace({ "case-catalog.md": catalogMd, "case-catalog.yaml": "schema: wrong\n" });
    expect(workspaceCatalogProblems(ws).some((p) => p.includes("does not parse"))).toBe(true);
  });

  it("reports disagreements", () => {
    const broken = committedManifest.replace("- id: CF-INV-007\n", "- id: CF-INV-707\n");
    const ws = makeWorkspace({ "case-catalog.md": catalogMd, "case-catalog.yaml": broken });
    const problems = workspaceCatalogProblems(ws);
    expect(problems.some((p) => p.includes("CF-INV-007"))).toBe(true);
    expect(problems.some((p) => p.includes("CF-INV-707"))).toBe(true);
  });
});
