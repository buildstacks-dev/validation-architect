/**
 * validation-architect — the core CLI (VA-PKG-001). Every command composes the
 * PUBLIC api (src/api/index.ts) over the CLI-only local repository adapter;
 * the library itself never touches the filesystem, Git, or a provider. The
 * CLI is the effect boundary: only `compile --write` writes, and only under
 * validation-design/.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  RENDER_VIEWS,
  canonicalJson,
  canonicalResult,
  check,
  compile,
  explain,
  ingest,
  isPublicContractError,
  plan,
  render,
  type IngestInput,
  type RepositoryFactsOptions,
} from "./api/index.js";
import type { RelationshipViewRole } from "./relationship-views.js";
import { CliLocalRepository } from "./cli-local-repository.js";

const ROOT_USAGE = `usage: validation-architect <command> [options]

commands:
  check [dir]                 CI gate: fail-closed result/v1 record for the
                              corpus against the tests that exist. Exit 0
                              unless the verdict is "fail" (a structurally
                              closed but evidence-incomplete trace records
                              inconclusive and exits 0; broken closure exits 1).
  compile [dir]               Author findings + regenerated views. Exit 1 when
                              the corpus is not accepted. --write regenerates
                              five Markdown views plus compiler-report.json
                              under <dir>/validation-design/.
  plan [dir] [--changed ...]  Explained advisory test plan (JSON). No --changed
                              paths means the full-suite/environment question.
  explain <selector> [dir]    Relationship explanation: prose first, exact IDs
                              second, unresolved hops explicit.
  report <file> --context <ctx.json>
                              Normalize runner/trace evidence into result/v1.

global:
  --help                      This help (also per command).

exit codes: 0 ok · 1 gate/contract failure · 2 usage error`;

const COMMAND_USAGE: Record<string, string> = {
  check: `usage: validation-architect check [dir] [--lane <laneId>] [--tests-root <path>] [--json]

Runs the public check() entry point over <dir> (default ".") and prints the
result summary (--json prints the full canonical result/v1 record).
Exit 0 unless verdict === "fail": structurally closed but evidence-incomplete
records inconclusive and exits 0; broken closure or a non-compiling corpus
exits 1.`,
  compile: `usage: validation-architect compile [dir] [--tests-root <path>] [--write]

Runs the public compile() entry point: source-located author findings and
regenerated views plus a canonical compiler/v1 report as data. Exit 1 when the
corpus is not accepted. With --write the CLI writes compiler-report.json and
the five Markdown views under <dir>/validation-design/ (the library never
writes).`,
  plan: `usage: validation-architect plan [dir] [--changed <path> [<path> ...]] [--lane <laneId>] [--tests-root <path>]

Prints the explained plan JSON. Without --changed this is the supported
full-suite/environment question; unknown or uncertain mappings expand to the
full applicable suite and the full required CI run stays authoritative.`,
  explain: `usage: validation-architect explain <selector> [dir] [--tests-root <path>]

Prints the explanation prose for a structure, contract, family, test,
evidence, or path selector, then the exact matched IDs.`,
  report: `usage: validation-architect report <file> --context <ctx.json> [--view <${RENDER_VIEWS.join("|")}>] [--selector <sel>]

<file> is a JSON document with a discriminated ingest input: {"kind":
"validation-result"|"relationship-trace"|"startup-conformance"|
"bootstrap-failure", ...}. --context names a JSON file with the mapping
context (identity, structure_id, root_id, owner, evidence). The validated
result/v1 record is printed as canonical JSON; when the input carries a
relationship graph and --view is given, the rendered role prose is printed
instead.`,
};

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
  help: boolean;
}

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["write", "json", "help"]);
/** Flags that consume every following non-flag argument. */
const LIST_FLAGS = new Set(["changed"]);
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  check: new Set(["lane", "tests-root", "json"]),
  compile: new Set(["tests-root", "write"]),
  plan: new Set(["changed", "lane", "tests-root"]),
  explain: new Set(["tests-root"]),
  report: new Set(["context", "view", "selector"]),
};

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  let help = false;
  const push = (key: string, value: string): void => {
    const existing = flags.get(key) ?? [];
    existing.push(value);
    flags.set(key, existing);
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i] as string;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const key = argument.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        push(key, "true");
        continue;
      }
      if (LIST_FLAGS.has(key)) {
        while (i + 1 < argv.length && !(argv[i + 1] as string).startsWith("-")) {
          push(key, argv[i + 1] as string);
          i++;
        }
        if (!flags.has(key)) flags.set(key, []);
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`flag --${key} requires a value`);
      }
      push(key, value);
      i++;
      continue;
    }
    positional.push(argument);
  }
  return { positional, flags, help };
}

class UsageError extends Error {}

function factsOptions(flags: Map<string, string[]>): RepositoryFactsOptions {
  const testsRoot = flags.get("tests-root")?.[0];
  return testsRoot ? { testsRoot } : {};
}

function repositoryFor(positional: string[]): { repo: CliLocalRepository; dir: string } {
  const dir = resolve(positional[0] ?? ".");
  return { repo: new CliLocalRepository(dir), dir };
}

async function cmdCheck(args: ParsedArgs): Promise<number> {
  const { repo } = repositoryFor(args.positional);
  const lane = args.flags.get("lane")?.[0];
  const result = await check(repo, { ...factsOptions(args.flags), ...(lane ? { lane } : {}) });
  if (args.flags.has("json")) {
    process.stdout.write(`${canonicalResult(result)}\n`);
  } else {
    process.stdout.write(
      [
        `verdict: ${result.verdict} (${result.applicability}, ${result.completeness}${result.reason ? `, reason: ${result.reason}` : ""})`,
        `summary: ${result.summary}`,
        `next action: ${result.next_action}`,
        `lane: ${result.identity.lane} · revision: ${result.identity.product_revision}`,
        `cases: ${result.cases.length} · evidence: ${result.evidence.length}`,
      ].join("\n") + "\n",
    );
  }
  return result.verdict === "fail" ? 1 : 0;
}

async function cmdCompile(args: ParsedArgs): Promise<number> {
  const { repo, dir } = repositoryFor(args.positional);
  const output = await compile(repo, factsOptions(args.flags));
  for (const finding of output.findings) {
    const location = `${finding.location.file}:${finding.location.line}:${finding.location.column}`;
    process.stderr.write(`[${finding.severity}] ${location} ${finding.message} Correction: ${finding.correction}\n`);
  }
  if (args.flags.has("write")) {
    const targetRoot = realpathSync.native(dir);
    const designRoot = join(targetRoot, "validation-design");
    if (existsSync(designRoot) && (lstatSync(designRoot).isSymbolicLink() || !lstatSync(designRoot).isDirectory())) {
      throw new Error("validation-design must be a real directory before generated views can be written.");
    }
    mkdirSync(designRoot, { recursive: true });
    const artifacts: Array<{ artifact: string; content: string }> = [
      ...Object.entries(output.views).map(([artifact, content]) => ({ artifact, content })),
      { artifact: "compiler-report.json", content: output.report.content },
    ];
    const writes = artifacts.map(({ artifact, content }) => {
      const target = resolve(designRoot, artifact);
      const rel = relative(designRoot, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Generated artifact path escapes validation-design: ${artifact}`);
      }
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error(`Generated artifact refuses to follow a symlink: ${artifact}`);
      }
      return { artifact, content, target };
    });
    for (const { artifact, content, target } of writes) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      process.stderr.write(`[validation-architect] wrote validation-design/${artifact}\n`);
    }
  }
  process.stdout.write(
    output.accepted
      ? `accepted: model ${output.identity} at revision ${output.revision}\n`
      : `rejected: ${output.findings.length} finding(s) at revision ${output.revision}\n`,
  );
  return output.accepted ? 0 : 1;
}

async function cmdPlan(args: ParsedArgs): Promise<number> {
  const { repo } = repositoryFor(args.positional);
  const changed = args.flags.get("changed") ?? [];
  const lane = args.flags.get("lane")?.[0];
  const result = await plan(repo, changed, { ...factsOptions(args.flags), ...(lane ? { lane } : {}) });
  process.stdout.write(`${canonicalJson(result)}\n`);
  return 0;
}

async function cmdExplain(args: ParsedArgs): Promise<number> {
  const selector = args.positional[0];
  if (!selector) {
    process.stderr.write(`${COMMAND_USAGE["explain"]}\n`);
    return 2;
  }
  const { repo } = repositoryFor(args.positional.slice(1));
  const output = await explain(repo, selector, factsOptions(args.flags));
  process.stdout.write(`${output.explanation}\n`);
  process.stdout.write(`matched by: ${output.query.matched_by}\n`);
  process.stdout.write(`roots: ${output.query.roots.join(", ") || "(none)"}\n`);
  process.stdout.write(`nodes: ${output.query.nodes.map((node) => node.id).join(", ") || "(none)"}\n`);
  if (output.query.unresolved.length > 0) {
    process.stdout.write(`unresolved: ${output.query.unresolved.map((item) => item.message).join(" | ")}\n`);
  }
  return 0;
}

async function cmdReport(args: ParsedArgs): Promise<number> {
  const file = args.positional[0];
  const contextPath = args.flags.get("context")?.[0];
  if (!file || !contextPath) {
    process.stderr.write(`${COMMAND_USAGE["report"]}\n`);
    return 2;
  }
  const input = JSON.parse(readFileSync(resolve(file), "utf8")) as IngestInput;
  const ctx = JSON.parse(readFileSync(resolve(contextPath), "utf8")) as unknown;
  const result = ingest(input, ctx);
  const view = args.flags.get("view")?.[0];
  if (view && input.kind === "relationship-trace") {
    const selector = args.flags.get("selector")?.[0] ?? input.graph.identity.model_identity;
    const rendered = render(view as RelationshipViewRole, {
      graph: input.graph,
      selector,
      result,
    });
    process.stdout.write(`${rendered.markdown}\n`);
    return 0;
  }
  process.stdout.write(`${canonicalResult(result)}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    const stream = command === undefined ? process.stderr : process.stdout;
    stream.write(`${ROOT_USAGE}\n`);
    return command === undefined ? 2 : 0;
  }
  const usage = COMMAND_USAGE[command];
  if (!usage) {
    process.stderr.write(`validation-architect: unknown command "${command}"\n\n${ROOT_USAGE}\n`);
    return 2;
  }
  try {
    args = parseArgs(rest);
    const allowed = COMMAND_FLAGS[command] as ReadonlySet<string>;
    for (const key of args.flags.keys()) {
      if (!allowed.has(key)) throw new UsageError(`unknown flag --${key}`);
    }
  } catch (error) {
    process.stderr.write(`validation-architect ${command}: ${(error as Error).message}\n\n${usage}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  try {
    switch (command) {
      case "check":
        return await cmdCheck(args);
      case "compile":
        return await cmdCompile(args);
      case "plan":
        return await cmdPlan(args);
      case "explain":
        return await cmdExplain(args);
      case "report":
        return await cmdReport(args);
      default:
        return 2;
    }
  } catch (error) {
    if (isPublicContractError(error)) {
      process.stderr.write(`[validation-architect] ${error.code}: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`[validation-architect] error: ${(error as Error).message}\n`);
    return 1;
  }
}

// bin/validation-architect.js imports main() and awaits it; importing this
// module performs no effect, which keeps main() directly testable.
