import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type CaseCatalogManifest,
  type CatalogFamily,
  type CatalogTicket,
  creditedFamilyIds,
  expandCellId,
  extractCfTokens,
  checkBacklogAgreement,
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
  /** Backlog-ticket ids named by the required first comment block. */
  tickets: string[];
  /** Whether the file starts with the required comment block. */
  hasHeader: boolean;
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
  /** Violations of the normative path/header/test-call conventions. */
  structure: string[];
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

function firstCommentBlock(source: string): string | undefined {
  const lineBlock = source.match(/^\s*((?:\/\/[^\n]*(?:\n|$))+)/);
  if (lineBlock) return lineBlock[1];
  return source.match(/^\s*(\/\*[\s\S]*?\*\/)/)?.[1];
}

/** Pure per-file spec parse shared by the filesystem scanner and the
 * RepositoryPort-based public facade. */
export function parseSpecSource(relativePath: string, source: string): SpecFileInfo {
  const header = firstCommentBlock(source);
  const citations = new Set<string>();
  for (const token of extractCfTokens(header ?? "")) {
    for (const id of expandCellId(token).ids) citations.add(id);
  }
  const tickets = [...new Set((header ?? "").match(/\bHB-[A-Za-z0-9]+\b/g) ?? [])].sort();
  return {
    path: relativePath,
    citations: [...citations].sort(),
    tickets,
    hasHeader: header !== undefined,
    tests: countTests(source),
  };
}

/** Collect spec files and their normalized family citations. */
export function scanSpecs(targetRoot: string, testsRoot: string, suffixes: string[]): SpecFileInfo[] {
  const absRoot = join(targetRoot, testsRoot);
  if (!existsSync(absRoot)) return [];
  const specs: SpecFileInfo[] = [];
  for (const file of walk(absRoot)) {
    if (!suffixes.some((s) => file.endsWith(s))) continue;
    specs.push(parseSpecSource(relative(targetRoot, file), readFileSync(file, "utf8")));
  }
  return specs;
}

interface FamilyCoverage {
  family: CatalogFamily;
  files: string[];
  tests: number;
}

function analyzeSpecs(
  manifest: CaseCatalogManifest,
  specs: SpecFileInfo[],
): { credits: Map<string, Set<string>>; problems: string[] } {
  const credits = new Map<string, Set<string>>();
  const problems: string[] = [];
  const knownTickets = new Set(manifest.tickets.map((ticket) => ticket.id));

  for (const spec of specs) {
    const valid = new Set<string>();
    credits.set(spec.path, valid);
    if (!spec.hasHeader) problems.push(`${spec.path} does not begin with a comment header`);
    if (spec.citations.length === 0) problems.push(`${spec.path} header cites no concrete CF family`);
    if (spec.tests === 0) problems.push(`${spec.path} contains no it/test call sites`);
    for (const ticket of spec.tickets) {
      if (!knownTickets.has(ticket)) problems.push(`${spec.path} header cites unknown ticket ${ticket}`);
    }

    for (const citation of spec.citations) {
      const familyIds = creditedFamilyIds(citation, manifest.families);
      if (familyIds.length === 0) {
        if (manifest.families.some((family) => tokenMatch(citation, family.id) === "group")) {
          problems.push(`${spec.path} cites family group ${citation}; cite a concrete family id`);
        }
        continue;
      }
      for (const id of familyIds) {
        const family = manifest.families.find((candidate) => candidate.id === id) as CatalogFamily;
        const directoryParts = spec.path.split("/").slice(0, -1).map((part) => part.toLowerCase());
        if (!directoryParts.some((part) => part.includes(id.toLowerCase()))) {
          problems.push(`${spec.path} cites ${id} but is not under a directory named for that family`);
          continue;
        }
        if (!family.ticket) {
          problems.push(`${spec.path} cites ${id}, which has no owning backlog ticket`);
          continue;
        }
        if (!spec.tickets.includes(family.ticket)) {
          problems.push(`${spec.path} cites ${id} but its header does not cite owning ticket ${family.ticket}`);
          continue;
        }
        if (spec.tests > 0) valid.add(id);
      }
    }
  }
  return { credits, problems };
}

function coverage(
  manifest: CaseCatalogManifest,
  specs: SpecFileInfo[],
  credits: Map<string, Set<string>>,
): Map<string, FamilyCoverage> {
  const map = new Map<string, FamilyCoverage>(
    manifest.families.map((f) => [f.id, { family: f, files: [], tests: 0 }]),
  );
  for (const spec of specs) {
    for (const id of credits.get(spec.path) ?? []) {
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
  const checks: TraceChecks = { agreement: [], forward: [], backward: [], statusHonesty: [], structure: [] };
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
    const catalogMd = readFileSync(catalogMdAbs, "utf8");
    checks.agreement = checkCatalogAgreement(manifest, catalogMd);
    const backlogAbs = join(manifestAbs, "..", "harness-backlog.md");
    if (existsSync(backlogAbs)) {
      checks.agreement.push(...checkBacklogAgreement(manifest, catalogMd, readFileSync(backlogAbs, "utf8")));
    }
  }

  const testsRoot = opts.testsRoot ?? manifest.conventions?.tests_root ?? "tests";
  if (!existsSync(join(targetRoot, testsRoot))) {
    return fail([`tests root "${testsRoot}" not found under ${targetRoot} (fail-closed: nothing to trace)`]);
  }
  const suffixes = manifest.conventions?.spec_suffixes ?? DEFAULT_SPEC_SUFFIXES;
  const specs = scanSpecs(targetRoot, testsRoot, suffixes);
  const analysis = analyzeSpecs(manifest, specs);
  checks.structure = analysis.problems;
  const cov = coverage(manifest, specs, analysis.credits);
  const ticketById = new Map(manifest.tickets.map((t) => [t.id, t]));

  // Non-test-lane evidence: a family may declare an artifact instead of a
  // citing spec (L3 certification records, L4 corpora, L5 records, L-ACC
  // campaign evidence). Existence is verified fail-closed; the declared
  // state travels into the report. Whether the artifact PROVES anything is
  // fidelity's judgment, exactly as with citing tests.
  const evidence = new Map<string, { state: string; path: string; exists: boolean }>();
  for (const family of manifest.families) {
    if (family.status === "implementable" && family.evidence_path && family.evidence_state) {
      evidence.set(family.id, {
        state: family.evidence_state,
        path: family.evidence_path,
        exists: existsSync(join(targetRoot, family.evidence_path)),
      });
    }
  }

  // 1. Forward closure: every implementable family has ≥1 citing spec, a
  //    verified evidence artifact, or a declared pending wave (an owning
  //    ticket that is not LANDED).
  for (const { family, files } of cov.values()) {
    if (family.status !== "implementable" || files.length > 0) continue;
    const declared = evidence.get(family.id);
    if (declared) {
      if (!declared.exists) {
        checks.forward.push(
          `${family.id} declares evidence "${declared.path}" (${declared.state}) but the artifact does not exist — fail-closed`,
        );
      }
      continue;
    }
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
      if (c.files.length === 0 && evidence.get(id)?.exists !== true) {
        checks.statusHonesty.push(`${ticket.id} is LANDED but its family ${id} has no citing spec`);
      }
    }
  }

  const reds = [
    ...checks.agreement.map((r) => `agreement: ${r}`),
    ...checks.forward.map((r) => `forward: ${r}`),
    ...checks.backward.map((r) => `backward: ${r}`),
    ...checks.statusHonesty.map((r) => `status-honesty: ${r}`),
    ...checks.structure.map((r) => `structure: ${r}`),
  ];

  const ownerBacklogAbs = join(manifestAbs, "..", "owner-backlog.md");
  const names = existsSync(ownerBacklogAbs)
    ? ownerBacklogNames(readFileSync(ownerBacklogAbs, "utf8"))
    : new Map<string, string>();

  const report = renderTraceReport(manifest, cov, specs, checks, names, evidence);
  return { ok: reds.length === 0, reds, checks, specs, report, manifest };
}

function renderTraceReport(
  manifest: CaseCatalogManifest,
  cov: Map<string, FamilyCoverage>,
  specs: SpecFileInfo[],
  checks: TraceChecks,
  ownerNames: Map<string, string>,
  evidence: Map<string, { state: string; path: string; exists: boolean }> = new Map(),
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

  const evidenceRows = [...evidence.entries()].sort(([a], [b]) => a.localeCompare(b));
  const evidenceSection =
    evidenceRows.length > 0
      ? `\n## Evidence-cited families (non-test lanes)\n\nExistence is verified; the state is the family's own honest declaration. Whether\nthe artifact proves its obligation is the fidelity audit's judgment.\n\n| Family | State | Artifact | Found |\n| --- | --- | --- | --- |\n${evidenceRows
          .map(
            ([id, ev]) => `| ${id} | ${ev.state} | \`${ev.path}\` | ${ev.exists ? "yes" : "**MISSING**"} |`,
          )
          .join("\n")}\n`
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
- **Specs:** ${specs.length} files · ${totalTests} tests${evidenceRows.length > 0 ? `\n- **Evidence-cited families:** ${evidenceRows.length} (${EVIDENCE_STATE_ORDER.map((s) => `${evidenceRows.filter(([, e]) => e.state === s).length} ${s}`).join(" · ")})` : ""}
${checkLine("Agreement (manifest ↔ markdown catalog)", checks.agreement)}
${checkLine("Forward closure", checks.forward)}
${checkLine("Backward closure", checks.backward)}
${checkLine("Status honesty", checks.statusHonesty)}
${checkLine("Spec structure", checks.structure)}

## Tickets by wave

${waveSections}
${unownedSection}${evidenceSection}${redSection}`;
}

const EVIDENCE_STATE_ORDER = ["complete", "incomplete", "inconclusive", "unobserved"];
