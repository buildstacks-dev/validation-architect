import type { ValidationResultV1 } from "./validation-result.js";
import type {
  RelationshipGraph,
  RelationshipNode,
  RelationshipQuery,
  TraceFinding,
} from "./relationship-graph.js";

export type RelationshipViewRole = "author" | "architect" | "reviewer" | "operator";

export interface RelationshipRoleView {
  role: RelationshipViewRole;
  graph_identity: string;
  product_revision: string;
  title: string;
  sections: Array<{ heading: string; items: string[] }>;
  underlying_ids: string[];
  unresolved: TraceFinding[];
  markdown: string;
}

const byKind = (nodes: readonly RelationshipNode[], kind: RelationshipNode["kind"]): RelationshipNode[] =>
  nodes.filter((item) => item.kind === kind);
const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

function meaning(node: RelationshipNode): string {
  return `${node.meaning} — ${node.kind} \`${node.id}\`${node.path ? ` at \`${node.path}\`` : ""}`;
}

function relatedIds(graph: RelationshipGraph, id: string, type: string): string[] {
  return graph.edges
    .filter((item) => item.type === type && (item.from === id || item.to === id))
    .map((item) => item.from === id ? item.to : item.from)
    .sort();
}

function render(view: Omit<RelationshipRoleView, "markdown">): string {
  const sections = view.sections.map((section) => `## ${section.heading}\n\n${section.items.length > 0 ? section.items.map((item) => `- ${item}`).join("\n") : "- None."}`).join("\n\n");
  const unresolved = view.unresolved.length > 0
    ? `\n\n## Unresolved gaps\n\n${view.unresolved.map((item) => `- ${item.message} (\`${item.code}\`, \`${item.subject_id}\`)`).join("\n")}`
    : "";
  return `# ${view.title}\n\nPlain product meaning leads; exact identities remain attached. Graph \`${view.graph_identity}\`, revision \`${view.product_revision}\`.\n\n${sections}${unresolved}\n`;
}

function reviewerSections(graph: RelationshipGraph, nodes: readonly RelationshipNode[]): RelationshipRoleView["sections"] {
  const families = byKind(nodes, "family");
  return [
    { heading: "Protected meaning", items: byKind(nodes, "structure").map(meaning) },
    { heading: "Trace chain", items: families.map((family) => `${meaning(family)}; tests: ${relatedIds(graph, family.id, "implemented-by").join(", ") || "unresolved"}; evidence: ${byKind(nodes, "evidence").map((item) => item.id).join(", ") || "unresolved"}.`) },
    { heading: "Ownership and validation rationale", items: families.map((family) => `${family.meaning} — owner \`${family.owner_id ?? "unresolved"}\`, layer \`${String(family.details.layer ?? "unresolved")}\`, oracle \`${String(family.details.oracle ?? "unresolved")}\`.`) },
    { heading: "Exclusions", items: families.flatMap((family) => (family.details.exclusions as string[] | undefined ?? []).map((item) => `${item} — \`${family.id}\``)) },
    { heading: "Negative controls", items: byKind(nodes, "control").map(meaning) },
    { heading: "Evidence", items: byKind(nodes, "evidence").map((item) => `${meaning(item)}; declared state \`${item.state ?? "unresolved"}\`.`) },
  ];
}

function operatorSections(result: ValidationResultV1 | undefined): RelationshipRoleView["sections"] {
  if (!result) return [{ heading: "Run status", items: ["No revision-bound result was supplied; operator cause and evidence remain unresolved."] }];
  const blocked = result.cases.filter((item) => item.blocked_by);
  return [
    { heading: "First cause and next action", items: [`${result.summary} Next: ${result.next_action} Root \`${result.ownership?.root_id ?? "unresolved"}\`.`] },
    { heading: "Affected cases", items: result.cases.map((item) => `${item.summary} — \`${item.id}\` is ${item.status}${item.blocked_by ? `; blocked by \`${item.blocked_by}\`` : ""}.`) },
    { heading: "Run identity", items: [`Revision \`${result.identity.product_revision}\`, lane \`${result.identity.lane}\`, environment \`${result.identity.environment}\`; ${blocked.length} derivative case(s).`] },
    { heading: "Evidence links", items: result.evidence.map((item) => `${item.reference} — \`${item.id}\`, sha256 \`${item.integrity.digest}\`.`) },
  ];
}

export function generateRelationshipViews(
  graph: RelationshipGraph,
  query: RelationshipQuery,
  options: { result?: ValidationResultV1; author_expansions?: readonly string[]; author_unknowns?: readonly string[] } = {},
): Record<RelationshipViewRole, RelationshipRoleView> {
  const ids = unique(query.nodes.map((item) => item.id));
  const families = byKind(query.nodes, "family");
  const definitions: Array<[RelationshipViewRole, string, RelationshipRoleView["sections"]]> = [
    ["author", "Author validation view", [
      { heading: "Affected meaning", items: byKind(query.nodes, "structure").map(meaning) },
      { heading: "Trustworthy commands and fixtures", items: byKind(query.nodes, "test").map((item) => `${item.meaning}${item.details.command ? `; command \`${String(item.details.command)}\`` : "; command unresolved"}.`) },
      { heading: "Negative controls", items: byKind(query.nodes, "control").map(meaning) },
      { heading: "Expansions", items: [...(options.author_expansions ?? [])] },
      { heading: "Unknowns", items: [...(options.author_unknowns ?? []), ...query.unresolved.map((item) => item.message)] },
    ]],
    ["architect", "Architect validation view", [
      { heading: "Enumerated structures and families", items: [...byKind(query.nodes, "structure"), ...families].map(meaning) },
      { heading: "Ownership", items: [...byKind(query.nodes, "structure"), ...families].map((item) => `${item.meaning} — owner \`${item.owner_id ?? "unresolved"}\` (\`${item.id}\`).`) },
      { heading: "Layer and oracle rationale", items: families.map((item) => `${item.meaning} — layer \`${String(item.details.layer ?? "unresolved")}\`, oracle \`${String(item.details.oracle ?? "unresolved")}\`, risk \`${String(item.details.risk ?? "unresolved")}\`.`) },
      { heading: "Closure findings", items: graph.findings.map((item) => `${item.message} — ${item.level} \`${item.code}\`.`) },
    ]],
    ["reviewer", "Reviewer validation view", reviewerSections(graph, query.nodes)],
    ["operator", "Operator validation view", operatorSections(options.result)],
  ];
  return Object.fromEntries(definitions.map(([role, title, sections]) => {
    const base = { role, graph_identity: graph.identity.graph_identity, product_revision: graph.identity.product_revision, title, sections, underlying_ids: ids, unresolved: query.unresolved };
    return [role, { ...base, markdown: render(base) }];
  })) as Record<RelationshipViewRole, RelationshipRoleView>;
}

export function explainRelationshipQuery(query: RelationshipQuery, graph: RelationshipGraph): string {
  const structures = byKind(query.nodes, "structure");
  const lead = structures.length > 0
    ? structures.map((item) => item.meaning).join("; ")
    : query.roots.length > 0 ? query.nodes[0]?.meaning ?? query.selector : `No declared relationship resolves ${query.selector}`;
  const chain = ["structure", "family", "test", "evidence"].map((kind) => {
    const items = byKind(query.nodes, kind as RelationshipNode["kind"]);
    return `${kind}: ${items.map((item) => `\`${item.id}\`${item.path ? ` (\`${item.path}\`)` : ""}`).join(", ") || "unresolved"}`;
  });
  const gaps = query.unresolved.length > 0 ? `\n\nUnresolved:\n${query.unresolved.map((item) => `- ${item.message}`).join("\n")}` : "";
  return `${lead}\n\n${chain.join("\n")}\n\nThis is structural trace closure, not a claim of test fidelity. Graph \`${graph.identity.graph_identity}\`.${gaps}`;
}
