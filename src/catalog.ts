import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * The machine-readable case-catalog manifest (issue #4).
 *
 * `case-catalog.md` stays the human artifact; this manifest is what tools
 * (the trace CLI, CI lanes) consume. The two must agree — disagreement is a
 * corpus bug, the same non-normative rule as the owner documents. Field
 * names are snake_case because they are the YAML surface.
 */

export const MANIFEST_SCHEMA = "validation-architect/case-catalog/v1";

export type FamilyStatus = "implementable" | "pruned" | "blocked";

export interface CatalogFamily {
  id: string;
  /** Which derivation matrix the family came from (markdown section title). */
  section: string;
  layers?: string;
  oracle?: string;
  risk?: string;
  status: FamilyStatus;
  /** Full prune token when pruned, e.g. "PRUNE-dup:CF-J05-A", "PRUNE-na". */
  prune?: string;
  /** Owning finding/obligation when the whole cell is blocked, e.g. "F-PT-006". */
  blocked_by?: string;
  /** The cell text, kept for pruned/blocked rows so the reason travels with the status. */
  reason?: string;
  /** Findings named IN an implementable cell (partial blocks), e.g. ["F-PT-015"]. */
  blocked_remainder?: string[];
  /** Collapsed failure-mode columns a single boundary family stands for. */
  covers?: string[];
  /** Owning backlog ticket (first backlog ticket that claims the family). */
  ticket?: string;
  wave?: string;
}

export interface CatalogTicket {
  id: string;
  name?: string;
  wave: string;
  status: "pending" | "landed";
  /** Family ids the ticket's backlog entry claims. */
  families: string[];
}

export interface ManifestConventions {
  /** Test tree root, relative to the target repo (e.g. "claude-tests"). */
  tests_root?: string;
  /** Filename suffixes that mark a spec file. */
  spec_suffixes?: string[];
}

export interface CaseCatalogManifest {
  schema: string;
  product?: string;
  conventions?: ManifestConventions;
  families: CatalogFamily[];
  tickets: CatalogTicket[];
}

// ---------------------------------------------------------------------------
// Cell-id normalization
// ---------------------------------------------------------------------------

/**
 * Normalize one catalog cell id (or one spec citation) into concrete family
 * ids, per the conventions observed in the Operon pilot:
 *
 * - `CF-B01-{ok,to,ps,rt,...}` — the §4/§5 row-collapsing convention: ONE
 *   family (base id) standing for its enumerated failure-mode columns.
 * - `CF-B02-*` — same: one collapsed family, base id.
 * - `CF-SM-APPR-L/I/R/C`, `CF-S3-qual+judge` — compound suffix: separate
 *   cells sharing a row; expands to one id per suffix part.
 * - plain ids pass through.
 */
export function expandCellId(raw: string): { ids: string[]; covers?: string[] } {
  const cell = raw.replace(/\*\*/g, "").replace(/`/g, "").trim();
  const brace = cell.match(/^(CF-[A-Za-z0-9-]+)-\{([^}]+)\}$/);
  if (brace) {
    return {
      ids: [brace[1] as string],
      covers: (brace[2] as string).split(",").map((s) => s.trim()).filter(Boolean),
    };
  }
  const wildcard = cell.match(/^(CF-[A-Za-z0-9-]+)-\*$/);
  if (wildcard) return { ids: [wildcard[1] as string] };
  const compound = cell.match(/^(CF-[A-Za-z0-9-]+)-([A-Za-z0-9]+(?:[/+][A-Za-z0-9]+)+)$/);
  if (compound) {
    const base = compound[1] as string;
    return { ids: (compound[2] as string).split(/[/+]/).map((p) => `${base}-${p}`) };
  }
  if (/^CF-[A-Za-z0-9-]+$/.test(cell)) return { ids: [cell] };
  return { ids: [] };
}

/**
 * CF tokens in free text (backlog entries, spec headers), brace forms
 * included. The lookbehind refuses mid-token matches so a conformance-suite
 * id like `B01-CF-11` (Operon github-double) is not mistaken for a family
 * citation `CF-11`.
 */
const CF_TOKEN_RE =
  /(?<![A-Za-z0-9-])CF-[A-Za-z0-9-]+-\{[^}]*\}|(?<![A-Za-z0-9-])CF-[A-Za-z0-9*/+-]+[A-Za-z0-9*]/g;

export function extractCfTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CF_TOKEN_RE)) {
    const token = m[0];
    // A slash-joined list of FULL family ids ("CF-B02-L3/CF-B03-L3/CF-B04-L3",
    // the HB-051 backlog convention) is separate citations — distinct from the
    // compound-suffix convention ("CF-J16-S/R/I", parts are not full ids),
    // which stays one token for expandCellId.
    if (token.includes("/CF-")) {
      for (const part of token.split("/")) {
        if (part.startsWith("CF-")) out.add(part);
      }
    } else {
      out.add(token);
    }
  }
  return [...out];
}

/**
 * How a token relates to a known family id.
 * - "credits": exact id, or the token extends the family id (CF-B14-CE
 *   credits the collapsed family CF-B14) — strong enough for forward closure.
 * - "group": the token is a base that several families extend (a bare
 *   CF-SM-APPR names the group) — resolves for backward closure, but does
 *   NOT credit any specific family with coverage.
 */
export function tokenMatch(token: string, familyId: string): "credits" | "group" | "none" {
  if (token === familyId || token.startsWith(`${familyId}-`)) return "credits";
  if (familyId.startsWith(`${token}-`)) return "group";
  return "none";
}

// ---------------------------------------------------------------------------
// case-catalog.md parsing (ground truth: the Operon pilot's catalog)
// ---------------------------------------------------------------------------

export interface ParsedCatalog {
  families: CatalogFamily[];
  problems: string[];
}

const isEmDash = (s: string): boolean => s === "" || s === "—" || s === "-";

function stripMd(s: string): string {
  return s.replace(/\*\*/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

interface TableRow {
  cells: string[];
  section: string;
  headers: string[];
}

/**
 * Split a markdown table row on `|`, ignoring pipes inside inline code —
 * ground truth requires it (the CF-SM-APPR row's cell text contains
 * `pending→approved|denied→…` in backticks).
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (const ch of line) {
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells.slice(1, -1);
}

function* tableRows(md: string): Generator<TableRow> {
  let section = "";
  let headers: string[] | null = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^##\s+(?:\d+\.\s*)?(.+)$/);
    if (h) {
      section = (h[1] as string).replace(/\s*\(.*$/, "").trim();
      headers = null;
      continue;
    }
    if (!line.trimStart().startsWith("|")) {
      headers = null;
      continue;
    }
    const cells = splitRow(line);
    if (cells.length === 0) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator
    if (headers === null) {
      headers = cells.map((c) => stripMd(c).toLowerCase());
      continue;
    }
    yield { cells, section, headers };
  }
}

/**
 * Parse the markdown catalog into family entries. Fail-closed: any row that
 * cannot be classified lands in `problems` rather than being skipped.
 */
export function parseCatalogMarkdown(md: string): ParsedCatalog {
  const families: CatalogFamily[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  const push = (f: CatalogFamily) => {
    if (seen.has(f.id)) {
      problems.push(`duplicate family id ${f.id} (section "${f.section}")`);
      return;
    }
    seen.add(f.id);
    families.push(f);
  };

  for (const { cells, section, headers } of tableRows(md)) {
    const rawCell = cells[0] ?? "";
    if (!rawCell.includes("CF-")) continue;
    const { ids, covers } = expandCellId(rawCell);
    if (ids.length === 0) {
      problems.push(`unparseable cell id "${stripMd(rawCell)}" (section "${section}")`);
      continue;
    }

    // The §5 per-ID resolver table (header "Layer set") also carries rows in
    // the ordinary Cell|Family|Layer|Oracle|Risk shape (CF-C-OPLIFE etc.);
    // resolver rows are recognizable by a layer spec in column 2.
    const isResolverTable = headers.some((h) => h.includes("layer set"));
    const col2 = stripMd(cells[1] ?? "");
    const isResolverRow = isResolverTable && /^\d/.test(col2);

    let familyText: string;
    let layers: string;
    let oracle: string | undefined;
    let risk: string;
    let remainderText = "";
    if (isResolverRow) {
      familyText = "";
      layers = col2;
      risk = stripMd(cells[2] ?? "");
      remainderText = stripMd(cells[4] ?? "");
    } else {
      familyText = col2;
      layers = stripMd(cells[2] ?? "");
      oracle = stripMd(cells[3] ?? "");
      risk = stripMd(cells[4] ?? "");
    }

    const nonImplementable =
      !isResolverRow && isEmDash(layers) && isEmDash(oracle ?? "") && isEmDash(risk);

    for (const id of ids) {
      const base: CatalogFamily = { id, section, status: "implementable" };
      if (covers) base.covers = covers;

      if (nonImplementable) {
        const blocked = familyText.match(/BLOCKED:([A-Za-z0-9._-]+)/);
        const prune = familyText.match(/PRUNE-[a-z]+(?::[^\s)]+)?/);
        if (blocked) {
          push({ ...base, status: "blocked", blocked_by: blocked[1] as string, reason: familyText });
        } else if (prune) {
          push({ ...base, status: "pruned", prune: prune[0], reason: familyText });
        } else {
          problems.push(
            `row ${id} (section "${section}") has no layer/oracle/risk but neither a PRUNE token nor a BLOCKED:<finding>`,
          );
        }
        continue;
      }

      const remainder = [
        ...new Set(
          [...`${familyText} ${remainderText}`.matchAll(/BLOCKED:([A-Za-z0-9._-]+)/g)].map(
            (m) => m[1] as string,
          ),
        ),
      ];
      const entry: CatalogFamily = { ...base, layers, risk };
      if (oracle && !isEmDash(oracle)) entry.oracle = oracle;
      if (remainder.length > 0) entry.blocked_remainder = remainder;
      push(entry);
    }
  }

  if (families.length === 0) problems.push("no family rows found in the markdown catalog");
  return { families, problems };
}

// ---------------------------------------------------------------------------
// harness-backlog.md parsing (tickets, waves, LANDED annotations)
// ---------------------------------------------------------------------------

export interface ParsedBacklogTicket {
  id: string;
  name?: string;
  wave: string;
  landed: boolean;
  /** Raw CF tokens the ticket's text mentions (unresolved). */
  cfTokens: string[];
}

function waveLabel(heading: string): string {
  const wave = heading.match(/^Wave\s+(\S+)/);
  if (wave) return (wave[1] as string).replace(/[^\w.-]/g, "");
  return (heading.split(/\s+/)[0] ?? heading).toLowerCase().replace(/[^\w-]/g, "");
}

/** `HB-001..HB-006 LANDED` ranges and single `HB-xxx … LANDED` mentions. */
function landedTicketIds(md: string): Set<string> {
  const landed = new Set<string>();
  for (const m of md.matchAll(/HB-(\d+)\.\.HB-(\d+)\s+LANDED/g)) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    const width = (m[1] as string).length;
    for (let n = from; n <= to; n++) landed.add(`HB-${String(n).padStart(width, "0")}`);
  }
  for (const m of md.matchAll(/\b(HB-[A-Za-z0-9]+)\s+LANDED/g)) landed.add(m[1] as string);
  return landed;
}

export function parseBacklogMarkdown(md: string): ParsedBacklogTicket[] {
  const landed = landedTicketIds(md);
  const tickets: ParsedBacklogTicket[] = [];
  const seen = new Set<string>();

  // Sections delimit waves; bold **HB-xxx…** tokens open tickets whose text
  // runs to the next bold ticket token or the next heading.
  const sections = md.split(/^## /m).slice(1);
  for (const sec of sections) {
    const heading = (sec.split("\n")[0] ?? "").trim();
    const wave = waveLabel(heading);
    const body = sec.slice(heading.length);
    const bolds = [...body.matchAll(/\*\*(HB-[A-Za-z0-9]+)([^*]*)\*\*/g)];
    for (let i = 0; i < bolds.length; i++) {
      const m = bolds[i] as RegExpMatchArray;
      const id = m[1] as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < bolds.length ? ((bolds[i + 1] as RegExpMatchArray).index ?? body.length) : body.length;
      const span = body.slice(start, end);
      const boldRest = (m[2] ?? "").trim();
      let name: string | undefined;
      const dashName = boldRest.match(/^[—–-]\s*(.+?)\.?\s*$/);
      if (dashName) {
        name = dashName[1] as string;
      } else {
        const lead = span.replace(/\s+/g, " ").trim();
        const cut = lead.search(/[(.]/);
        const candidate = (cut > 0 ? lead.slice(0, cut) : lead).trim();
        if (candidate) name = candidate.slice(0, 100);
      }
      const ticket: ParsedBacklogTicket = {
        id,
        wave,
        landed: landed.has(id),
        cfTokens: extractCfTokens(span),
      };
      if (name) ticket.name = name;
      tickets.push(ticket);
    }
  }
  return tickets;
}

// ---------------------------------------------------------------------------
// Manifest generation, serialization, agreement
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  product?: string;
  conventions?: ManifestConventions;
}

/**
 * Join the markdown catalog with the backlog into a manifest: each family's
 * owning ticket is the FIRST backlog ticket whose entry claims it (backlog
 * order = wave order), carrying that ticket's wave.
 */
export function generateManifest(
  catalogMd: string,
  backlogMd: string,
  opts: GenerateOptions = {},
): { manifest: CaseCatalogManifest; problems: string[] } {
  const { families, problems } = parseCatalogMarkdown(catalogMd);
  const parsedTickets = parseBacklogMarkdown(backlogMd);

  const tickets: CatalogTicket[] = parsedTickets.map((t) => {
    const claimed = new Set<string>();
    for (const token of t.cfTokens) {
      for (const id of expandCellId(token).ids) {
        for (const f of families) {
          if (tokenMatch(id, f.id) !== "none") claimed.add(f.id);
        }
      }
    }
    const ticket: CatalogTicket = {
      id: t.id,
      wave: t.wave,
      status: t.landed ? "landed" : "pending",
      families: [...claimed].sort(),
    };
    if (t.name) ticket.name = t.name;
    return ticket;
  });

  const owner = new Map<string, CatalogTicket>();
  for (const ticket of tickets) {
    for (const id of ticket.families) {
      if (!owner.has(id)) owner.set(id, ticket);
    }
  }
  for (const f of families) {
    const t = owner.get(f.id);
    if (t) {
      f.ticket = t.id;
      f.wave = t.wave;
    }
  }

  const manifest: CaseCatalogManifest = {
    schema: MANIFEST_SCHEMA,
    ...(opts.product ? { product: opts.product } : {}),
    ...(opts.conventions ? { conventions: opts.conventions } : {}),
    families,
    tickets,
  };
  return { manifest, problems };
}

const MANIFEST_HEADER = `# case-catalog.yaml — machine-readable companion to case-catalog.md.
# Generated; the markdown catalog stays the human artifact and the two MUST
# agree (the trace CLI and the campaign gate both check). One entry per case
# family: id, layers, oracle, risk, prune/blocked status + reason, owning
# backlog ticket, wave.
`;

export function serializeManifest(manifest: CaseCatalogManifest): string {
  return MANIFEST_HEADER + stringifyYaml(manifest, { lineWidth: 100 });
}

/** Parse + validate a manifest. Throws on structural invalidity (fail-closed). */
export function parseManifest(text: string): CaseCatalogManifest {
  const doc = parseYaml(text) as Partial<CaseCatalogManifest> | null;
  if (!doc || typeof doc !== "object") throw new Error("manifest is not a YAML mapping");
  if (doc.schema !== MANIFEST_SCHEMA) {
    throw new Error(`manifest schema is "${doc.schema ?? "(absent)"}", expected "${MANIFEST_SCHEMA}"`);
  }
  if (!Array.isArray(doc.families) || doc.families.length === 0) {
    throw new Error("manifest has no families");
  }
  for (const f of doc.families) {
    if (!f?.id || typeof f.id !== "string") throw new Error("manifest family without an id");
    if (!["implementable", "pruned", "blocked"].includes(f.status as string)) {
      throw new Error(`family ${f.id} has invalid status "${String(f.status)}"`);
    }
  }
  if (!Array.isArray(doc.tickets)) throw new Error("manifest has no tickets list");
  for (const t of doc.tickets) {
    if (!t?.id || typeof t.id !== "string") throw new Error("manifest ticket without an id");
    if (!["pending", "landed"].includes(t.status as string)) {
      throw new Error(`ticket ${t.id} has invalid status "${String(t.status)}"`);
    }
    if (!Array.isArray(t.families)) throw new Error(`ticket ${t.id} has no families list`);
  }
  return doc as CaseCatalogManifest;
}

/**
 * The manifest ↔ markdown-catalog agreement check (issue #4 acceptance:
 * family ids round-trip exactly, prunes and blocks included). Returns
 * disagreement strings; empty = the two agree.
 */
export function checkCatalogAgreement(manifest: CaseCatalogManifest, catalogMd: string): string[] {
  const out: string[] = [];
  const { families, problems } = parseCatalogMarkdown(catalogMd);
  out.push(...problems.map((p) => `catalog parse: ${p}`));

  const inMd = new Map(families.map((f) => [f.id, f]));
  const inManifest = new Map(manifest.families.map((f) => [f.id, f]));

  for (const id of inMd.keys()) {
    if (!inManifest.has(id)) out.push(`family ${id} is in case-catalog.md but missing from the manifest`);
  }
  for (const id of inManifest.keys()) {
    if (!inMd.has(id)) out.push(`family ${id} is in the manifest but not in case-catalog.md`);
  }
  for (const [id, md] of inMd) {
    const mf = inManifest.get(id);
    if (!mf) continue;
    if (mf.status !== md.status) {
      out.push(`family ${id}: manifest says ${mf.status}, case-catalog.md says ${md.status}`);
      continue;
    }
    if (md.status === "pruned" && mf.prune !== md.prune) {
      out.push(`family ${id}: prune token disagrees (manifest "${mf.prune ?? ""}", markdown "${md.prune ?? ""}")`);
    }
    if (md.status === "blocked" && mf.blocked_by !== md.blocked_by) {
      out.push(
        `family ${id}: blocked-by disagrees (manifest "${mf.blocked_by ?? ""}", markdown "${md.blocked_by ?? ""}")`,
      );
    }
    const a = [...(mf.blocked_remainder ?? [])].sort().join(",");
    const b = [...(md.blocked_remainder ?? [])].sort().join(",");
    if (a !== b) out.push(`family ${id}: blocked remainder disagrees (manifest "${a}", markdown "${b}")`);
  }
  return out;
}

/**
 * Campaign-workspace agreement gate: the deliverable manifest must exist,
 * parse, and agree with the markdown catalog. Fail-closed — a missing or
 * unparseable manifest is a problem, not a skip.
 */
export function workspaceCatalogProblems(workspace: string): string[] {
  const dir = join(workspace, "validation-design");
  const mdPath = join(dir, "case-catalog.md");
  const yamlPath = join(dir, "case-catalog.yaml");
  if (!existsSync(mdPath)) return ["validation-design/case-catalog.md is missing"];
  if (!existsSync(yamlPath)) {
    return ["validation-design/case-catalog.yaml is missing — the machine-readable manifest is a required deliverable"];
  }
  let manifest: CaseCatalogManifest;
  try {
    manifest = parseManifest(readFileSync(yamlPath, "utf8"));
  } catch (err) {
    return [`case-catalog.yaml does not parse as a valid manifest: ${(err as Error).message}`];
  }
  return checkCatalogAgreement(manifest, readFileSync(mdPath, "utf8"));
}
