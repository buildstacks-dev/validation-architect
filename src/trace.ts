import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type CaseCatalogManifest,
  type CatalogFamily,
  type CatalogTicket,
  expandCellId,
  extractCfTokens,
  checkCatalogAgreement,
  parseManifest,
  tokenMatch,
} from "./catalog.js";

/**
 * The trace CLI's core (issue #5): deterministic, product-agnostic
 * design→implementation closure checks over a target repo, given only its
 * case-catalog manifest and the ratified conventions. Three checks, all
 * fail-closed, plus the human trace report.
 *
 * Boundary: this proves CLOSURE, not fidelity. Whether a citing test
 * actually falsifies its ratified seed is judgment work (the fidelity
 * audit), never this tool's claim.
 */

export interface TraceOptions {
  /** Manifest path relative to the target root (or absolute). */
  manifestPath?: string;
  /** Test-tree root relative to the target root; overrides the manifest's conventions. */
  testsRoot?: string;
}

export interface SpecFileInfo {
  /** Path relative to the target root. */
  path: string;
  /** Normalized family citations found in the file. */
  citations: string[];
  /** Number of test cases (it/test call sites — a heuristic count). */
  tests: number;
}

export interface TraceChecks {
  /** Manifest ↔ markdown-catalog disagreements (when case-catalog.md is present). */
  agreement: string[];
  /** Implementable families with no citing spec and no declared pending wave. */
  forward: string[];
  /** Citations that resolve to no known family. */
  backward: string[];
  /** LANDED tickets whose families lack citing specs. */
  statusHonesty: string[];
}

export interface TraceResult {
  ok: boolean;
  /** Every red line, prefixed with its check name. */
  reds: string[];
  checks: TraceChecks;
  specs: SpecFileInfo[];
  report: string;
  /** The parsed manifest (absent when the run failed before parsing it). */
  manifest?: CaseCatalogManifest;
}

const DEFAULT_SPEC_SUFFIXES = [".test.ts", ".test.tsx", ".test.js", ".test.mjs", ".spec.ts"];

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out.sort();
}

function countTests(source: string): number {
  return [...source.matchAll(/^\s*(?:it|test)(?:\.\w+)?\s*\(/gm)].length;
}

/** Collect spec files and their normalized family citations. */
export function scanSpecs(targetRoot: string, testsRoot: string, suffixes: string[]): SpecFileInfo[] {
  const absRoot = join(targetRoot, testsRoot);
  if (!existsSync(absRoot)) return [];
  const specs: SpecFileInfo[] = [];
  for (const file of walk(absRoot)) {
    if (!suffixes.some((s) => file.endsWith(s))) continue;
    const source = readFileSync(file, "utf8");
    const citations = new Set<string>();
    for (const token of extractCfTokens(source)) {
      for (const id of expandCellId(token).ids) citations.add(id);
    }
    specs.push({ path: relative(targetRoot, file), citations: [...citations].sort(), tests: countTests(source) });
  }
  return specs;
}

interface FamilyCoverage {
  family: CatalogFamily;
  files: string[];
  tests: number;
}

function coverage(manifest: CaseCatalogManifest, specs: SpecFileInfo[]): Map<string, FamilyCoverage> {
  const map = new Map<string, FamilyCoverage>(
    manifest.families.map((f) => [f.id, { family: f, files: [], tests: 0 }]),
  );
  for (const spec of specs) {
    const credited = new Set<string>();
    for (const c of spec.citations) {
      for (const f of manifest.families) {
        if (tokenMatch(c, f.id) === "credits") credited.add(f.id);
      }
    }
    for (const id of credited) {
      const cov = map.get(id) as FamilyCoverage;
      cov.files.push(spec.path);
      cov.tests += spec.tests;
    }
  }
  return map;
}

/**
 * Plain-language ticket names from owner-backlog.md (issue #3's companion):
 * any heading or bold line of the shape `HB-xxx — plain name`. Absent file =
 * empty map; the report falls back to backlog names, then bare ids.
 */
export function ownerBacklogNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of text.matchAll(/(HB-[A-Za-z0-9]+)\s*[—–:-]\s*([^\n*]+)/g)) {
    const id = m[1] as string;
    if (!names.has(id)) names.set(id, (m[2] as string).replace(/[.*]+\s*$/, "").trim());
  }
  return names;
}

export function runTrace(targetRoot: string, opts: TraceOptions = {}): TraceResult {
  const checks: TraceChecks = { agreement: [], forward: [], backward: [], statusHonesty: [] };
  const manifestRel = opts.manifestPath ?? join("validation-design", "case-catalog.yaml");
  // Absolute --manifest paths win; relative ones resolve against the target
  // root (the product-repo convention: the enablement bundle lands next to
  // the tests). Callers that keep the manifest outside the target pass an
  // absolute path.
  const manifestAbs = manifestRel.startsWith("/") ? manifestRel : join(targetRoot, manifestRel);

  const fail = (reds: string[]): TraceResult => ({
    ok: false,
    reds,
    checks,
    specs: [],
    report: `# Trace report\n\nFAILED before scanning:\n\n${reds.map((r) => `- ${r}`).join("\n")}\n`,
  });

  if (!existsSync(manifestAbs)) return fail([`manifest: ${manifestRel} not found under ${targetRoot}`]);
  let manifest: CaseCatalogManifest;
  try {
    manifest = parseManifest(readFileSync(manifestAbs, "utf8"));
  } catch (err) {
    return fail([`manifest: ${manifestRel} invalid — ${(err as Error).message}`]);
  }

  // Agreement: when the human catalog sits next to the manifest, the two
  // must agree (issue #4). Its absence is not a red — a target repo may
  // vendor only the manifest.
  const catalogMdAbs = join(manifestAbs, "..", "case-catalog.md");
  if (existsSync(catalogMdAbs)) {
    checks.agreement = checkCatalogAgreement(manifest, readFileSync(catalogMdAbs, "utf8"));
  }

  const testsRoot = opts.testsRoot ?? manifest.conventions?.tests_root ?? "tests";
  if (!existsSync(join(targetRoot, testsRoot))) {
    return fail([`tests root "${testsRoot}" not found under ${targetRoot} (fail-closed: nothing to trace)`]);
  }
  const suffixes = manifest.conventions?.spec_suffixes ?? DEFAULT_SPEC_SUFFIXES;
  const specs = scanSpecs(targetRoot, testsRoot, suffixes);
  const cov = coverage(manifest, specs);
  const ticketById = new Map(manifest.tickets.map((t) => [t.id, t]));

  // 1. Forward closure: every implementable family has ≥1 citing spec or a
  //    declared pending wave (an owning ticket that is not LANDED).
  for (const { family, files } of cov.values()) {
    if (family.status !== "implementable" || files.length > 0) continue;
    const ticket = family.ticket ? ticketById.get(family.ticket) : undefined;
    if (!ticket) {
      checks.forward.push(
        `${family.id} has no citing spec and no owning ticket/wave — an undeclared gap (assign it a backlog ticket or prune it by name)`,
      );
    } else if (ticket.status === "landed") {
      checks.forward.push(`${family.id} has no citing spec but its owning ticket ${ticket.id} is LANDED`);
    }
    // pending ticket → declared pending wave → green.
  }

  // 2. Backward closure: every citation resolves to a known family.
  for (const spec of specs) {
    for (const c of spec.citations) {
      const resolves = manifest.families.some((f) => tokenMatch(c, f.id) !== "none");
      if (!resolves) checks.backward.push(`${spec.path} cites unknown family "${c}"`);
    }
  }

  // 3. Status honesty: a LANDED ticket whose implementable families lack
  //    citing specs is lying about being landed.
  for (const ticket of manifest.tickets) {
    if (ticket.status !== "landed") continue;
    for (const id of ticket.families) {
      const c = cov.get(id);
      if (!c || c.family.status !== "implementable") continue;
      if (c.files.length === 0) {
        checks.statusHonesty.push(`${ticket.id} is LANDED but its family ${id} has no citing spec`);
      }
    }
  }

  const reds = [
    ...checks.agreement.map((r) => `agreement: ${r}`),
    ...checks.forward.map((r) => `forward: ${r}`),
    ...checks.backward.map((r) => `backward: ${r}`),
    ...checks.statusHonesty.map((r) => `status-honesty: ${r}`),
  ];

  const ownerBacklogAbs = join(manifestAbs, "..", "owner-backlog.md");
  const names = existsSync(ownerBacklogAbs)
    ? ownerBacklogNames(readFileSync(ownerBacklogAbs, "utf8"))
    : new Map<string, string>();

  const report = renderTraceReport(manifest, cov, specs, checks, names);
  return { ok: reds.length === 0, reds, checks, specs, report, manifest };
}

function renderTraceReport(
  manifest: CaseCatalogManifest,
  cov: Map<string, FamilyCoverage>,
  specs: SpecFileInfo[],
  checks: TraceChecks,
  ownerNames: Map<string, string>,
): string {
  const impl = manifest.families.filter((f) => f.status === "implementable");
  const pruned = manifest.families.filter((f) => f.status === "pruned");
  const blocked = manifest.families.filter((f) => f.status === "blocked");
  const totalTests = specs.reduce((n, s) => n + s.tests, 0);

  const checkLine = (label: string, reds: string[]) =>
    `- **${label}:** ${reds.length === 0 ? "green" : `RED (${reds.length})`}`;

  const ticketRow = (t: CatalogTicket): string => {
    const fams = t.families.filter((id) => cov.get(id)?.family.status === "implementable");
    const files = new Set<string>();
    let tests = 0;
    for (const id of fams) {
      const c = cov.get(id);
      if (!c) continue;
      for (const f of c.files) files.add(f);
    }
    for (const f of files) tests += specs.find((s) => s.path === f)?.tests ?? 0;
    const covered = fams.filter((id) => (cov.get(id)?.files.length ?? 0) > 0).length;
    const name = ownerNames.get(t.id) ?? t.name ?? t.id;
    const state =
      fams.length === 0
        ? t.status
        : `${t.status} · ${covered}/${fams.length} families traced`;
    return `| ${t.id} | ${name} | ${fams.length} | ${files.size} | ${tests} | ${state} |`;
  };

  const waves = [...new Set(manifest.tickets.map((t) => t.wave))];
  const waveSections = waves
    .map((w) => {
      const rows = manifest.tickets.filter((t) => t.wave === w).map(ticketRow).join("\n");
      return `### Wave ${w}\n\n| Ticket | What it covers | Families | Files | Tests | Status |\n| --- | --- | --- | --- | --- | --- |\n${rows}`;
    })
    .join("\n\n");

  const unowned = impl.filter((f) => !f.ticket);
  const unownedSection =
    unowned.length > 0
      ? `\n## Families without an owning ticket\n\n${unowned.map((f) => `- \`${f.id}\` (${f.section})`).join("\n")}\n`
      : "";

  const redSection =
    checks.agreement.length + checks.forward.length + checks.backward.length + checks.statusHonesty.length > 0
      ? `\n## Red findings\n\n${[
          ...checks.agreement.map((r) => `- **agreement:** ${r}`),
          ...checks.forward.map((r) => `- **forward:** ${r}`),
          ...checks.backward.map((r) => `- **backward:** ${r}`),
          ...checks.statusHonesty.map((r) => `- **status-honesty:** ${r}`),
        ].join("\n")}\n`
      : "";

  return `# Trace report${manifest.product ? ` — ${manifest.product}` : ""}

Deterministic design→implementation closure over the case-catalog manifest.
This proves **closure, not fidelity** — whether a citing test truly falsifies
its ratified seed is the fidelity audit's judgment, not this report's claim.

## Summary

- **Families:** ${manifest.families.length} (${impl.length} implementable · ${pruned.length} pruned · ${blocked.length} blocked)
- **Specs:** ${specs.length} files · ${totalTests} tests
${checkLine("Agreement (manifest ↔ markdown catalog)", checks.agreement)}
${checkLine("Forward closure", checks.forward)}
${checkLine("Backward closure", checks.backward)}
${checkLine("Status honesty", checks.statusHonesty)}

## Tickets by wave

${waveSections}
${unownedSection}${redSection}`;
}
