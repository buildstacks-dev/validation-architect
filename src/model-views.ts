import type {
  BacklogTicket,
  CompiledDesignModel,
  ModelOwner,
  ProductStructure,
  ValidationFamily,
} from "./model.js";

export const GENERATED_MODEL_VIEWS = [
  "case-catalog.md",
  "harness-backlog.md",
  "owner-briefing.md",
  "owner-backlog.md",
  "planned-trace.md",
] as const;

export type GeneratedModelView = (typeof GENERATED_MODEL_VIEWS)[number];

const md = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
const list = (values: readonly string[] | undefined): string =>
  values && values.length > 0 ? values.map(md).join(", ") : "—";

const GENERATED_NOTICE =
  "> Generated from `validation-design/model/*.yaml`. Do not edit machine facts here; edit the YAML model and recompile.\n";

function familyExecution(family: ValidationFamily): string {
  if (family.evidence) return `EVIDENCE:${family.evidence.state}:${family.evidence.path}`;
  return list(family.planned_tests);
}

function familyStatus(family: ValidationFamily): string {
  if (family.status === "pruned") return `PRUNED — ${family.reason ?? "reason missing"}`;
  if (family.status === "blocked") {
    return `BLOCKED:${family.blocked_by ?? "unknown"} — ${family.reason ?? "reason missing"}`;
  }
  return "IMPLEMENTABLE";
}

function renderCatalog(model: CompiledDesignModel): string {
  const rows = model.families.map(
    (family) =>
      `| ${md(family.id)} | ${md(family.title)} | ${md(family.meaning)} | ${list(family.structure_ids)} | ${list(family.source_ids)} | ${md(family.lane)} | ${md(family.layer ?? "—")} | ${md(family.oracle ?? "—")} | ${md(family.risk ?? "—")} | ${list(family.control_ids)} | ${md(family.owner)} | ${md(family.ticket ?? "—")} | ${md(familyStatus(family))} | ${md(familyExecution(family))} |`,
  );
  const controls = model.controls.map((control) => `| ${md(control.id)} | ${md(control.title)} | ${md(control.family_id)} | ${md(control.expected_failure)} | ${md(control.owner)} |`);
  return `# Case catalog\n\n${GENERATED_NOTICE}\n| Family | Title | Protected meaning | Structures | Provenance | Lane | Layer | Oracle | Risk | Negative controls | Owner | Ticket | Status | Planned implementation / evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n## Negative controls\n\n| Control | Title | Family | Expected red behavior | Owner |\n| --- | --- | --- | --- | --- |\n${controls.join("\n")}\n`;
}

function renderBacklog(model: CompiledDesignModel): string {
  const byWave = new Map<string, BacklogTicket[]>();
  for (const ticket of model.tickets) {
    const group = byWave.get(ticket.wave) ?? [];
    group.push(ticket);
    byWave.set(ticket.wave, group);
  }
  const sections = [...byWave.entries()].map(([wave, tickets]) => {
    const rows = tickets.map((ticket) => {
      const dependencies = ticket.depends_on?.length
        ? ` Depends on ${ticket.depends_on.map((id) => `\`${id}\``).join(", ")}.`
        : "";
      const acceptance = ticket.acceptance_criteria.map((criterion) => `  - ${criterion}`).join("\n");
      return `- **${ticket.id} — ${ticket.title}** (${ticket.status}; owner \`${ticket.owner}\`; executor ${ticket.executor}; ${ticket.layer}/\`${ticket.lane}\`). Families: ${ticket.family_ids.map((id) => `\`${id}\``).join(", ")}.${dependencies}\n  Acceptance:\n${acceptance}`;
    });
    return `## Wave ${wave}\n\n${rows.join("\n")}`;
  });
  return `# Harness backlog\n\n${GENERATED_NOTICE}\n${sections.join("\n\n")}\n`;
}

function ownerName(owner: ModelOwner | undefined, ownerId: string): string {
  return owner ? `${owner.name} (\`${owner.id}\`)` : `\`${ownerId}\``;
}

function structuresOfKind(model: CompiledDesignModel, kind: ProductStructure["kind"]): ProductStructure[] {
  return model.structures.filter((structure) => structure.kind === kind);
}

function structureBullets(structures: readonly ProductStructure[], owners: ReadonlyMap<string, ModelOwner>): string {
  if (structures.length === 0) return "- None declared.\n";
  return `${structures
    .map(
      (structure) =>
        `- **${structure.title}** (\`${structure.id}\`, ${structure.kind}) — ${structure.meaning} Owner: ${ownerName(owners.get(structure.owner), structure.owner)}.${structure.acceptance_criteria?.length ? ` Acceptance: ${structure.acceptance_criteria.join("; ")}.` : ""}${structure.failure_modes?.length ? ` Failure modes: ${structure.failure_modes.join("; ")}.` : ""}`,
    )
    .join("\n")}\n`;
}

function renderOwnerBriefing(model: CompiledDesignModel): string {
  const owners = new Map(model.owners.map((owner) => [owner.id, owner]));
  const risky = model.structures.filter((structure) =>
    ["boundary", "operation", "llm-site"].includes(structure.kind),
  );
  const promises = model.structures.filter((structure) =>
    ["invariant", "contract", "journey"].includes(structure.kind),
  );
  const exclusions = model.families.flatMap((family) =>
    (family.exclusions ?? []).map((exclusion) => `- \`${family.id}\`: ${exclusion}`),
  );
  const decisions = model.families.filter((family) => family.status !== "implementable");
  const unknowns = model.sources.filter((source) => source.kind === "proposed" || source.kind === "simulated");
  const layerPolicy = model.policy.layers.map((layer) => `- \`${layer.id}\` ${layer.title}: ${layer.status}${layer.reason ? ` — ${layer.reason}` : ""}.`).join("\n");
  const lanePolicy = model.policy.lanes.map((lane) => `- \`${lane.id}\` ${lane.requirement}, ${lane.status}; triggers: ${list(lane.triggers)}${lane.command ? `; command: \`${lane.command}\`` : ""}${lane.reason ? ` — ${lane.reason}` : ""}.`).join("\n");
  const ownership = model.owners.map((owner) => `- \`${owner.id}\` ${owner.name}: ${owner.responsibility}.`).join("\n");
  return `# Owner briefing\n\n${GENERATED_NOTICE}\nThis is a non-normative projection, not a second source of truth.\n\n## Assurance policy\n\n- Intended use: ${model.product.intended_use}.\n- Criticality: \`${model.product.criticality}\` — ${model.product.criticality_reason}.\n- Default: ${model.policy.default}; inheritance: ${model.policy.inheritance}.\n\n### Validation layers\n\n${layerPolicy}\n\n### Execution lanes\n\n${lanePolicy}\n\n- Active exceptions: ${model.policy.exceptions.length === 0 ? "none" : model.policy.exceptions.map((item) => `\`${item.id}\` (${item.kind}, expires ${item.expires})`).join(", ")}.\n\n### Ownership\n\n${ownership}\n\n## What this product can break\n\n${structureBullets(risky, owners)}\n## The promises\n\n${structureBullets(promises, owners)}\n## The seams\n\n${structureBullets(structuresOfKind(model, "interface"), owners)}\n## What we deliberately will NOT test\n\n${exclusions.length > 0 ? `${exclusions.join("\n")}\n` : "- No exclusions declared.\n"}\n## The decisions on your desk\n\n${
    decisions.length > 0
      ? `${decisions.map((family) => `- \`${family.id}\` is ${family.status}: ${family.reason ?? family.blocked_by ?? "reason missing"}.`).join("\n")}\n`
      : "- No pruned or blocked family decisions.\n"
  }\n## What is still unknown\n\n${
    unknowns.length > 0
      ? `${unknowns.map((source) => `- \`${source.id}\` (${source.kind})${source.locator ? `: ${source.locator}` : ""}.`).join("\n")}\n`
      : "- No simulated or proposed sources remain.\n"
  }\n## What gets built, in what order\n\n${model.tickets.map((ticket) => `- Wave ${ticket.wave}: \`${ticket.id}\` — ${ticket.title} (${ticket.status}).`).join("\n")}\n`;
}

function renderOwnerBacklog(model: CompiledDesignModel): string {
  const owners = new Map(model.owners.map((owner) => [owner.id, owner]));
  const rows = model.tickets.map(
    (ticket) =>
      `| ${md(ticket.wave)} | ${md(ticket.id)} | ${md(ticket.title)} | ${md(ticket.status)} | ${md(ownerName(owners.get(ticket.owner), ticket.owner))} | ${list(ticket.family_ids)} |`,
  );
  return `# Owner backlog\n\n${GENERATED_NOTICE}\nThis is a non-normative projection, not a second source of truth. Backlog revision: current canonical model; generated from model/backlog.yaml through harness-backlog.md.\n\n| Wave | Ticket | Work | Status | Owner | Families |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
}

function renderPlannedTrace(model: CompiledDesignModel): string {
  const structures = model.structures.map((structure) => `| ${md(structure.id)} | ${md(structure.kind)} | ${md(structure.meaning)} | ${list(structure.changed_paths)} | ${list(structure.source_ids)} | ${md(structure.owner)} |`);
  const rows = model.families.map((family) => {
    const implementation = family.evidence
      ? `${family.evidence.state}:${family.evidence.path}`
      : list(family.planned_tests);
    return `| ${md(family.id)} | ${list(family.structure_ids)} | ${md(family.ticket ?? "—")} | ${list(family.control_ids)} | ${md(implementation)} | ${md(family.owner)} |`;
  });
  return `# Planned implementation trace\n\n${GENERATED_NOTICE}\nThis report proves declared planned-link closure only. It does not claim that tests exist, passed, or faithfully implement their oracle.\n\n## Product structure routing\n\n| Structure | Kind | Protected meaning | Changed paths | Provenance | Owner |\n| --- | --- | --- | --- | --- | --- |\n${structures.join("\n")}\n\n## Planned family closure\n\n| Family | Product structures | Ticket | Negative controls | Planned tests / evidence | Owner |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
}

export function generateModelViews(model: CompiledDesignModel): Record<GeneratedModelView, string> {
  return {
    "case-catalog.md": renderCatalog(model),
    "harness-backlog.md": renderBacklog(model),
    "owner-briefing.md": renderOwnerBriefing(model),
    "owner-backlog.md": renderOwnerBacklog(model),
    "planned-trace.md": renderPlannedTrace(model),
  };
}
