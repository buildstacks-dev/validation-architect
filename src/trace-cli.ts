import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateManifest, serializeManifest } from "./catalog.js";
import { runTrace } from "./trace.js";

/**
 * validation-trace — deterministic design→implementation closure checks
 * (issue #5). Product-agnostic: reads only the case-catalog manifest and the
 * ratified conventions; meant to run in the TARGET repo's CI on every
 * commit. Exits non-zero on any red — fail-closed by construction.
 */

const USAGE = `usage:
  validation-trace <target-repo> [--manifest <path>] [--tests <path>] [--out <report.md>] [--quiet]
      Run the three closure checks (forward, backward, status honesty) plus
      the manifest↔markdown agreement check, and render the trace report.
      Exit code: 0 all green, 1 any red, 2 usage/setup error.

  validation-trace generate <case-catalog.md> <harness-backlog.md> [--product <name>]
      [--tests-root <path>] [-o <case-catalog.yaml>]
      Derive the machine-readable manifest from the markdown catalog +
      backlog (bootstrap helper for corpora that predate the manifest).`;

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("-") && a !== "-") {
      const key = a.replace(/^--?/, "");
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function cmdGenerate(args: string[]): number {
  const { positional, flags } = parseFlags(args);
  const [catalogPath, backlogPath] = positional;
  if (!catalogPath || !backlogPath) {
    console.error(USAGE);
    return 2;
  }
  const opts: Parameters<typeof generateManifest>[2] = {};
  const product = flags.get("product");
  if (product) opts.product = product;
  const testsRoot = flags.get("tests-root");
  if (testsRoot) opts.conventions = { tests_root: testsRoot };
  const { manifest, problems } = generateManifest(
    readFileSync(resolve(catalogPath), "utf8"),
    readFileSync(resolve(backlogPath), "utf8"),
    opts,
  );
  for (const p of problems) console.error(`[generate] problem: ${p}`);
  const yaml = serializeManifest(manifest);
  const out = flags.get("o") ?? flags.get("out");
  if (out) {
    writeFileSync(resolve(out), yaml);
    console.error(`[generate] wrote ${out} (${manifest.families.length} families, ${manifest.tickets.length} tickets)`);
  } else {
    process.stdout.write(yaml);
  }
  return problems.length > 0 ? 1 : 0;
}

function cmdCheck(args: string[]): number {
  const { positional, flags } = parseFlags(args);
  const target = positional[0];
  if (!target) {
    console.error(USAGE);
    return 2;
  }
  const opts: Parameters<typeof runTrace>[1] = {};
  const manifest = flags.get("manifest");
  // Resolve --manifest against cwd so an absolute OR cwd-relative path works
  // when the enablement bundle hasn't been installed into the target yet
  // (the Operon pilot smoke case).
  if (manifest) opts.manifestPath = resolve(manifest);
  const tests = flags.get("tests");
  if (tests) opts.testsRoot = tests;

  const result = runTrace(resolve(target), opts);
  const out = flags.get("out");
  if (out) writeFileSync(resolve(out), result.report);
  if (flags.get("quiet") !== "true") process.stdout.write(result.report);
  if (!result.ok) {
    console.error(`\n[validation-trace] RED — ${result.reds.length} finding(s):`);
    for (const r of result.reds) console.error(`  - ${r}`);
    return 1;
  }
  console.error("\n[validation-trace] green — forward, backward, and status-honesty closure hold.");
  return 0;
}

const [first, ...rest] = process.argv.slice(2);
if (first === "generate") {
  process.exitCode = cmdGenerate(rest);
} else if (first === undefined || first === "--help" || first === "-h") {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  process.exitCode = cmdCheck([first, ...rest]);
}
