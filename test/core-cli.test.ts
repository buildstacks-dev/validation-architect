import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/core-cli.js";
import { writeValidModel } from "./model-corpus-fixture.js";

/**
 * Acceptance for the NEW core CLI (VA-PKG-001): every command composes the
 * public api over the CLI-only local repository. What only these tests prove
 * is the argv wiring and the exit-code contract — check preserves the trace
 * closure semantics (structurally closed but evidence-incomplete exits 0 with
 * an inconclusive record; broken closure exits 1).
 */

let tmp: string;
let out: string[];
let err: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "va-core-cli-"));
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A committed product repo carrying a clean corpus and its citing spec. */
function makeTarget(options: { withSpec?: boolean } = {}): string {
  const target = join(tmp, "product");
  mkdirSync(join(target, "docs"), { recursive: true });
  writeFileSync(join(target, "docs", "PRODUCT.md"), "# Product\n\nContract\n");
  writeValidModel(target);
  if (options.withSpec !== false) {
    mkdirSync(join(target, "tests"), { recursive: true });
    writeFileSync(
      join(target, "tests", "fixture.test.ts"),
      ["// Family: CF-X01-S", "// Ticket: HB-001", "it('holds', () => {});", ""].join("\n"),
    );
  }
  git(tmp, ["init", "-q", "-b", "main", "product"]);
  git(target, ["add", "-A"]);
  git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return target;
}

describe("help and unknown commands", () => {
  it("prints root help with exit 0 and exits 2 on an unknown command", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out.join("")).toContain("usage: validation-architect <command>");
    expect(await main(["frobnicate"])).toBe(2);
    expect(err.join("")).toContain('unknown command "frobnicate"');
  });

  it("prints per-command help without touching a repository", async () => {
    for (const command of ["check", "compile", "plan", "explain", "report"]) {
      out = [];
      expect(await main([command, "--help"]), command).toBe(0);
      expect(out.join(""), command).toContain(`validation-architect ${command}`);
    }
  });

  it("exits 2 with usage when invoked bare", async () => {
    expect(await main([])).toBe(2);
  });
});

describe("check exit-code contract", () => {
  it("exits 0 with an inconclusive record for a closed but evidence-incomplete corpus", async () => {
    const target = makeTarget();
    expect(await main(["check", target, "--json"])).toBe(0);
    const record = JSON.parse(out.join("")) as { verdict: string; reason?: string; completeness: string };
    expect(record.verdict).toBe("inconclusive");
    expect(record.reason).toBe("evidence_incomplete");
  });

  it("exits 1 on broken closure with a fail/traceability_broken record", async () => {
    const target = makeTarget({ withSpec: false });
    expect(await main(["check", target, "--json"])).toBe(1);
    const record = JSON.parse(out.join("")) as { verdict: string; reason?: string };
    expect(record.verdict).toBe("fail");
    expect(record.reason).toBe("traceability_broken");
  });

  it("exits 1 when the corpus does not compile (fail-closed, typed error)", async () => {
    const target = makeTarget();
    rmSync(join(target, "validation-design", "model", "families.yaml"));
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "break"]);
    expect(await main(["check", target])).toBe(1);
    expect(err.join("")).toContain("invalid_input");
  });
});

describe("compile", () => {
  it("accepts a clean corpus and only writes views with --write", async () => {
    const target = makeTarget();
    const catalog = join(target, "validation-design", "case-catalog.md");
    rmSync(catalog);
    expect(await main(["compile", target])).toBe(0);
    expect(existsSync(catalog)).toBe(false); // no write without --write
    expect(await main(["compile", target, "--write"])).toBe(0);
    expect(existsSync(catalog)).toBe(true);
    expect(readFileSync(catalog, "utf8")).toContain("CF-X01-S");
  });

  it("exits 1 with findings for a corpus that does not compile", async () => {
    const target = makeTarget();
    rmSync(join(target, "validation-design", "model", "families.yaml"));
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "break"]);
    expect(await main(["compile", target])).toBe(1);
    expect(err.join("")).toContain("[error]");
  });
});

describe("plan and explain", () => {
  it("prints the full-suite plan JSON for an empty changed set", async () => {
    const target = makeTarget();
    expect(await main(["plan", target])).toBe(0);
    const plan = JSON.parse(out.join("")) as { schema: string; family_ids: string[]; full_required_ci: { command: string } };
    expect(plan.schema).toContain("plan/v1");
    expect(plan.family_ids).toContain("CF-X01-S");
  });

  it("prints a changed-path plan", async () => {
    const target = makeTarget();
    expect(await main(["plan", target, "--changed", "src/index.ts"])).toBe(0);
    const plan = JSON.parse(out.join("")) as { changed_inputs: unknown[] };
    expect(plan.changed_inputs).toHaveLength(1);
  });

  it("explains a selector with prose then exact IDs", async () => {
    const target = makeTarget();
    expect(await main(["explain", "CF-X01-S", target])).toBe(0);
    const text = out.join("");
    expect(text).toContain("CF-X01-S");
    expect(text).toContain("roots: CF-X01-S");
  });
});

describe("report", () => {
  it("ingests a validation-result file and prints the validated record", async () => {
    const target = makeTarget();
    expect(await main(["check", target, "--json"])).toBe(0);
    const record = JSON.parse(out.join("")) as { identity: { versions: unknown } };
    out = [];
    const inputPath = join(tmp, "ingest.json");
    writeFileSync(inputPath, JSON.stringify({ kind: "validation-result", value: record }));
    const contextPath = join(tmp, "ctx.json");
    writeFileSync(
      contextPath,
      JSON.stringify({
        identity: {
          product_revision: "abc123",
          lane: "per-commit",
          environment: "repository-port",
          versions: record.identity.versions,
        },
        structure_id: "fixture-x",
        root_id: "TRACE-ROOT",
        owner: "OWN-1",
        evidence: [],
      }),
    );
    expect(await main(["report", inputPath, "--context", contextPath])).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ verdict: "inconclusive" });
  });

  it("exits 2 without a --context file", async () => {
    expect(await main(["report", "whatever.json"])).toBe(2);
  });
});
