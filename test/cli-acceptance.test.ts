import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompilationState, RunConfig, RunState } from "../src/types.js";
import { captureTargetBase } from "../src/target.js";
import { TRACE_ALIAS_DEPRECATION } from "../src/trace-cli.js";
import { COMPILER_VERSION, CURRENT_CORE_VERSIONS } from "../src/versions.js";
import { acceptedBundleIdentity, versionedValueHash } from "../src/version-compatibility.js";
import { compileWorkspaceModel } from "../src/workspace-compiler.js";
import { UNVERSIONED_RUN_RECOVERY } from "../src/run-state-version.js";
import { writeValidModel } from "./model-corpus-fixture.js";

/**
 * Acceptance tests that drive the SHIPPED command surface as a subprocess.
 * The campaign state machine itself is covered by orchestrator.test.ts with
 * fake providers; what only these tests can prove is that the version gate,
 * the delivery refusals, and the model trace are actually WIRED to `vda` and
 * `validation-trace` — every guard below is reachable only through argv.
 *
 * No provider is contacted: every case either stops at a gate before the
 * first provider turn, or acts on an already-completed run.
 */

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");

let tmp: string;
let runsRoot: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vda-cli-"));
  runsRoot = join(tmp, "runs");
  mkdirSync(runsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

function cli(entry: string, args: string[]): CliResult {
  const result = spawnSync(tsx, [entry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, VDA_RUNS_ROOT: runsRoot },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { code: result.status ?? -1, stdout, stderr, output: `${stdout}${stderr}` };
}

const vda = (args: string[]): CliResult => cli("src/cli.ts", args);
const trace = (args: string[]): CliResult => cli("src/trace-cli.ts", args);

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A committed product repo carrying docs/, a tests root, and no corpus. */
function makeTargetRepo(): string {
  const target = join(tmp, "product");
  mkdirSync(join(target, "docs"), { recursive: true });
  mkdirSync(join(target, "src"), { recursive: true });
  mkdirSync(join(target, "tests"), { recursive: true });
  writeFileSync(join(target, "docs", "PRODUCT.md"), "# Product\n\nContract\n");
  writeFileSync(join(target, "src", "index.ts"), "export const revision = 1;\n");
  // The inventory adapter reads the citing header and counts executable cases,
  // so the fixture spec has to be a real one for the trace to see it at all.
  writeFileSync(
    join(target, "tests", "fixture.test.ts"),
    [
      "// Family: CF-X01-S",
      "// Ticket: HB-001",
      "it('preserves the stable response', () => {});",
      "it('turns red when the stable response changes', () => {});",
      "",
    ].join("\n"),
  );
  git(tmp, ["init", "-q", "-b", "main", "product"]);
  git(target, ["add", "-A"]);
  git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return target;
}

/** A workspace whose corpus compiles clean, exactly as a finished campaign leaves it. */
function makeWorkspace(sourceRevision = "abc123"): string {
  const workspace = join(tmp, "ws");
  mkdirSync(workspace, { recursive: true });
  writeValidModel(workspace, sourceRevision);
  return workspace;
}

/** Mirror of the orchestrator's accepted-compilation record for a clean workspace. */
function acceptedCompilation(workspace: string): CompilationState {
  const compiled = compileWorkspaceModel(workspace, { regenerate: true });
  if (!compiled.accepted || !compiled.identity || !compiled.model) {
    throw new Error(`fixture workspace did not compile: ${JSON.stringify(compiled.diagnostics)}`);
  }
  const state: CompilationState = {
    sourceFingerprint: compiled.source_fingerprint,
    surfaceFingerprint: compiled.surface_fingerprint,
    status: "accepted",
    compilerVersion: COMPILER_VERSION,
    modelIdentity: compiled.identity,
    versions: compiled.model.versions,
    diagnosticCodes: compiled.diagnostics.map((diagnostic) => diagnostic.code),
  };
  state.acceptedBundleIdentity = acceptedBundleIdentity({
    sourceFingerprint: state.sourceFingerprint,
    surfaceFingerprint: state.surfaceFingerprint,
    modelIdentity: compiled.identity,
    versions: compiled.model.versions,
  });
  return state;
}

function makeConfig(runId: string): RunConfig {
  return {
    fixture: "fixture-x",
    runId,
    designerModel: "m1",
    stakeholderModel: "m2",
    readerModel: "m3",
    claudeAuth: "subscription",
    codexAuth: "chatgpt",
    maxExchanges: 10,
    maxWallMinutes: 60,
    designerMaxTurns: 50,
  };
}

/** Persist a run exactly where the CLI will look for it. */
function writeRun(runId: string, overrides: Partial<RunState>): RunState {
  const now = new Date().toISOString();
  const state: RunState = {
    runId,
    fixture: "fixture-x",
    workspace: join(tmp, "ws"),
    status: "completed",
    exchanges: 4,
    seq: 8,
    startedAt: now,
    updatedAt: now,
    config: makeConfig(runId),
    ...overrides,
  };
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function readRun(runId: string): RunState {
  return JSON.parse(
    execFileSync("cat", [join(runsRoot, runId, "state.json")], { encoding: "utf8" }),
  ) as RunState;
}

const deliveryBranches = (target: string): string[] =>
  git(target, ["branch", "--list", "validation-design/*"])
    .split("\n")
    .map((line) => line.replace("*", "").trim())
    .filter(Boolean);

/**
 * Acceptance #2 — the named pre-1.0 recovery is the ONLY route back for a run
 * created before core versions existed. recoverUnversionedRunState is unit
 * covered; these cases prove `vda` reaches it, persists the result, and
 * refuses everything else.
 */
describe("pre-1.0 run state recovery through the CLI", () => {
  const pending = { to: "designer" as const, text: "continue the design" };

  it("refuses to deliver an unversioned run before it touches the repository", () => {
    writeRun("legacy-deliver", { coreVersions: undefined, pending });
    const result = vda(["deliver", "legacy-deliver"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/delivery refused before repository mutation/);
    expect(result.stderr).toContain(UNVERSIONED_RUN_RECOVERY);
  });

  it("adopts current versions under the named recovery and preserves the pending message", () => {
    const before = writeRun("legacy-resume", { coreVersions: undefined, pending });
    const pendingIdentity = versionedValueHash(before.pending ?? null);

    const result = vda(["resume", "legacy-resume", "--recover-core-state", UNVERSIONED_RUN_RECOVERY]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/recorded named core-state recovery/);

    const after = readRun("legacy-resume");
    expect(after.coreVersions).toEqual(CURRENT_CORE_VERSIONS);
    expect(after.versionRecovery).toMatchObject({
      name: UNVERSIONED_RUN_RECOVERY,
      source: "unversioned-pre1-run-state",
      pendingIdentity,
    });
    // The recovery stamps provenance only — the un-relayed message is untouched.
    expect(after.pending).toEqual(before.pending);
    expect(versionedValueHash(after.pending ?? null)).toBe(pendingIdentity);
  });

  it("rejects an unrecognized recovery name without writing provenance", () => {
    writeRun("legacy-bad-name", { coreVersions: undefined, pending });
    const result = vda(["resume", "legacy-bad-name", "--recover-core-state", "just-adopt-it"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown core-state recovery/);
    expect(readRun("legacy-bad-name").coreVersions).toBeUndefined();
  });

  it("refuses pre-1.0 adoption for a run that already accepted a compilation", () => {
    const workspace = makeWorkspace();
    const compilation = acceptedCompilation(workspace);
    writeRun("legacy-accepted", {
      coreVersions: undefined,
      workspace,
      pending,
      compilation: { ...compilation, versions: undefined, acceptedBundleIdentity: undefined },
    });
    const result = vda(["resume", "legacy-accepted", "--recover-core-state", UNVERSIONED_RUN_RECOVERY]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/reviewed schema migration/);
  });
});

/**
 * Acceptance #3 — `vda deliver` is the only command that writes to the user's
 * product repo. Every refusal below must happen BEFORE that write, so the
 * branch assertions matter as much as the exit codes.
 */
describe("vda deliver refuses a workspace that is not compiler-clean", () => {
  function completedTargetRun(runId: string): { target: string; workspace: string } {
    const target = makeTargetRepo();
    const workspace = makeWorkspace(git(target, ["rev-parse", "HEAD"]).trim());
    writeRun(runId, {
      workspace,
      target,
      targetBase: captureTargetBase(target),
      coreVersions: structuredClone(CURRENT_CORE_VERSIONS),
      compilation: acceptedCompilation(workspace),
    });
    return { target, workspace };
  }

  it("refuses when the authoritative model no longer compiles, leaving the target untouched", () => {
    const { target, workspace } = completedTargetRun("broken-model");
    rmSync(join(workspace, "validation-design", "model", "families.yaml"));

    const result = vda(["deliver", "broken-model"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/delivery refused/);
    expect(result.stderr).toMatch(/not compiler-clean/);
    expect(deliveryBranches(target)).toEqual([]);
  });

  it("refuses when a generated view was hand-edited after completion", () => {
    const { target, workspace } = completedTargetRun("edited-view");
    writeFileSync(
      join(workspace, "validation-design", "case-catalog.md"),
      "# Hand-edited catalog\n\nCF-X01-S is now something else entirely.\n",
    );

    const result = vda(["deliver", "edited-view"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/delivery refused/);
    expect(deliveryBranches(target)).toEqual([]);
  });

  it("refuses when the model changed after completion, naming the identity drift", () => {
    const { target, workspace } = completedTargetRun("drifted-model");
    // Re-author and recompile: the corpus stays clean, but it is a different model
    // than the one the campaign completed on.
    const families = join(workspace, "validation-design", "model", "families.yaml");
    writeFileSync(
      families,
      execFileSync("cat", [families], { encoding: "utf8" }).replace(
        "title: Fixture happy path",
        "title: Fixture happy path (revised after completion)",
      ),
    );
    const recompiled = compileWorkspaceModel(workspace, { regenerate: true });
    expect(recompiled.accepted).toBe(true);

    const result = vda(["deliver", "drifted-model"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/does not match current/);
    expect(deliveryBranches(target)).toEqual([]);
  });
});

/**
 * Pre-1.0 ships no migration off the authored `validation-policy.yaml` corpus.
 * That is a decision, so `vda run` states it before spending a provider turn
 * rather than letting the compiler gate surface it as link diagnostics.
 */
describe("a pre-model corpus is refused with the re-derive instruction", () => {
  function legacyTarget(): string {
    const target = makeTargetRepo();
    mkdirSync(join(target, "validation-design"), { recursive: true });
    writeFileSync(join(target, "validation-design", "validation-policy.yaml"), "gates: {}\n");
    writeFileSync(join(target, "validation-design", "invariants.md"), "# Invariants\n\nINV-01\n");
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "legacy corpus"]);
    return target;
  }

  it("names the missing migration and points at --fresh instead of failing later", () => {
    const target = legacyTarget();
    const result = vda(["run", "--target", target]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/pre-model corpus/);
    expect(result.stderr).toMatch(/--fresh/);
    // Refused before any run directory was claimed.
    expect(existsSync(join(runsRoot, "product"))).toBe(false);
  });

  it("leaves a current model corpus in ordinary revision mode", () => {
    const target = makeTargetRepo();
    writeValidModel(target, git(target, ["rev-parse", "HEAD"]).trim());
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "corpus"]);
    // --max-exchanges 0 is rejected by config validation, which halts the run
    // after mode resolution and before the first provider turn.
    const result = vda(["run", "--target", target, "--max-exchanges", "0"]);
    expect(result.output).toMatch(/entering harness-revision mode/);
    expect(result.output).not.toMatch(/pre-model corpus/);
  });
});

/**
 * Acceptance #4 — the positive path the three refusals above are guarding:
 * a clean corpus passes the shipped model trace and lands on a delivery
 * branch without disturbing the user's checkout.
 */
describe("a compiler-clean corpus traces green and delivers", () => {
  it("passes the validation-trace alias through the same public check path", () => {
    const target = makeTargetRepo();
    const workspace = makeWorkspace(git(target, ["rev-parse", "HEAD"]).trim());
    // The corpus under audit is the one the campaign produced.
    execFileSync("cp", ["-R", join(workspace, "validation-design"), target]);

    const result = trace([target]);
    expect(result.stdout).toContain("verdict: inconclusive");
    expect(result.code).toBe(0);
    // Decision 2: exactly one deterministic deprecation line on stderr, and
    // the warning never alters exit status.
    const warning = 'validation-trace is a deprecated alias for "validation-architect check" and will be removed at 1.0.';
    expect(result.stderr).toContain(warning);
    expect(result.stderr.split(warning).length - 1).toBe(1);
  });

  it("warns on every alias invocation, --help included", () => {
    const result = trace(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("deprecated alias");
    expect(result.stdout).toContain("validation-architect check [dir]");
  });

  it("routes the retired generate subcommand to validation-architect compile with exit 2", () => {
    const result = trace(["generate", "catalog.md", "backlog.md"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("validation-architect compile");
  });

  it("keeps the incumbent legacy closure gate green before any checked-model file exists", () => {
    const legacy = join(repoRoot, "test", "fixtures", "trace", "conforming");
    const result = trace([
      legacy,
      "--manifest",
      "validation-design/case-catalog.yaml",
      "--tests",
      "tests",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Trace report — widgetd");
    expect(result.stderr).toContain("legacy manifest bridge active");
    expect(result.stderr.split(TRACE_ALIAS_DEPRECATION).length - 1).toBe(1);
  });

  it("preserves a legacy closure red through the bounded bridge", () => {
    const legacy = join(repoRoot, "test", "fixtures", "trace", "orphan-spec");
    const result = trace([
      legacy,
      "--manifest",
      "validation-design/case-catalog.yaml",
      "--tests",
      "tests",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[validation-trace] RED");
  });

  it("never falls back to the legacy manifest after any checked-model file appears", () => {
    const target = join(tmp, "partial-model");
    cpSync(join(repoRoot, "test", "fixtures", "trace", "conforming"), target, { recursive: true });
    mkdirSync(join(target, "validation-design", "model"), { recursive: true });
    writeFileSync(
      join(target, "validation-design", "model", "project.yaml"),
      "schema: validation-architect/model/project/v1\n",
    );
    git(tmp, ["init", "-q", "-b", "main", "partial-model"]);
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "partial model"]);

    const result = trace([
      target,
      "--manifest",
      "validation-design/case-catalog.yaml",
      "--tests",
      "tests",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("checked-model authority");
    expect(result.stderr).toContain("invalid_input");
    expect(result.stdout).not.toContain("# Trace report — widgetd");
  });

  it("maps legacy alias flags onto the exact checked-model path after cutover", () => {
    const target = makeTargetRepo();
    const workspace = makeWorkspace(git(target, ["rev-parse", "HEAD"]).trim());
    execFileSync("cp", ["-R", join(workspace, "validation-design"), target]);
    const checked = trace([target, "--tests-root", "tests"]);
    const aliased = trace([
      target,
      "--manifest",
      "validation-design/does-not-exist.yaml",
      "--tests",
      "tests",
    ]);
    expect(aliased.code).toBe(checked.code);
    expect(aliased.stdout).toBe(checked.stdout);
    expect(aliased.stderr).toContain("checked-model authority");
    expect(aliased.stderr.split(TRACE_ALIAS_DEPRECATION).length - 1).toBe(1);
  });

  it("delivers the corpus to a branch and leaves the working tree clean", () => {
    const target = makeTargetRepo();
    const workspace = makeWorkspace(git(target, ["rev-parse", "HEAD"]).trim());
    const headBefore = git(target, ["rev-parse", "HEAD"]).trim();
    writeRun("clean-delivery", {
      workspace,
      target,
      targetBase: captureTargetBase(target),
      coreVersions: structuredClone(CURRENT_CORE_VERSIONS),
      compilation: acceptedCompilation(workspace),
    });

    const result = vda(["deliver", "clean-delivery"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/delivered to/);

    const branches = deliveryBranches(target);
    expect(branches).toHaveLength(1);
    const branch = branches[0] as string;

    // The corpus is on the branch, not in the user's checkout.
    const landed = git(target, ["ls-tree", "-r", "--name-only", branch]).split("\n");
    expect(landed).toContain("validation-design/model/families.yaml");
    expect(landed).toContain("validation-design/case-catalog.md");
    expect(git(target, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(git(target, ["status", "--porcelain"]).trim()).toBe("");
    expect(existsSync(join(target, "validation-design"))).toBe(false);

    // Re-delivery is idempotent: same branch, no second branch.
    const again = vda(["deliver", "clean-delivery"]);
    expect(again.code).toBe(0);
    expect(deliveryBranches(target)).toEqual(branches);
  });
});
