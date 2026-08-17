import type { CompiledDesignModel, CompilerDiagnostic, ModelFilename } from "./model.js";

interface ModelValidationContext {
  diagnostics: CompilerDiagnostic[];
  safePath(path: string): boolean;
  shapeError(file: ModelFilename, id: string, field: string, correction: string): void;
  linkError(file: ModelFilename, concept: string, message: string, correction: string): void;
  codedError(code: string, file: ModelFilename, concept: string, message: string, correction: string): void;
}

export function validateModel(model: CompiledDesignModel, context: ModelValidationContext): void {
  const { diagnostics, safePath, shapeError, linkError, codedError } = context;
  const owners = new Set(model.owners.map((item) => item.id));
  const sources = new Set(model.sources.map((item) => item.id));
  const structureById = new Map(model.structures.map((item) => [item.id, item]));
  const structures = new Set(structureById.keys());
  const layers = new Map(model.policy.layers.map((item) => [item.id, item]));
  const lanes = new Map(model.policy.lanes.map((item) => [item.id, item]));
  const controls = new Map(model.controls.map((item) => [item.id, item]));
  const families = new Map(model.families.map((item) => [item.id, item]));
  const tickets = new Map(model.tickets.map((item) => [item.id, item]));

  for (const source of model.sources) {
    if (source.path && !safePath(source.path)) linkError("sources.yaml", source.id, `${source.id} has unsafe source path ${source.path}.`, "Use a repository-relative path with no traversal.");
    if (source.kind === "doc" && !source.path) shapeError("sources.yaml", source.id, "path", "Document provenance must name its repository-relative path.");
    if (source.kind === "rambling" && (!source.quote || !source.path)) shapeError("sources.yaml", source.id, "path/quote", "Rambling provenance requires a path and cited quote.");
    if ((source.kind === "simulated" || source.kind === "proposed") && !source.locator) shapeError("sources.yaml", source.id, "locator", "Simulated and proposed provenance must explain where the judgment is recorded.");
  }
  for (const structure of model.structures) {
    if (!owners.has(structure.owner)) linkError("structures.yaml", structure.id, `${structure.id} cites missing owner ${structure.owner}.`, "Declare the owner in owners.yaml or correct the reference.");
    for (const id of structure.source_ids) if (!sources.has(id)) linkError("structures.yaml", structure.id, `${structure.id} cites missing provenance ${id}.`, "Declare the source in sources.yaml or correct source_ids.");
    for (const path of structure.changed_paths ?? []) if (!safePath(path)) linkError("structures.yaml", structure.id, `${structure.id} has unsafe changed-path mapping ${path}.`, "Use a bounded repository-relative path or glob with no traversal.");
    if (structure.kind === "contract" && !structure.acceptance_criteria?.length) shapeError("structures.yaml", structure.id, "acceptance_criteria", "A contract needs testable acceptance criteria, including inputs, outputs, errors, and idempotency where applicable.");
    if (structure.kind === "contract" && !structure.error_criteria?.length) codedError("MODEL_CONTRACT_ERROR_CRITERIA_MISSING", "structures.yaml", structure.id, `${structure.id} declares no typed error criteria; a happy-path-only contract is not a contract.`, "Add error_criteria stating invalid-input behavior, typed errors, and idempotency under retry where applicable.");
    if (structure.kind === "boundary" && !structure.failure_modes?.length) shapeError("structures.yaml", structure.id, "failure_modes", "A boundary needs explicit independent failure modes, including crash-mid-step where applicable.");
    if (structure.criticality && !structure.criticality_reason) shapeError("structures.yaml", structure.id, "criticality_reason", "Explain every component criticality override; omit both fields to inherit the product tier.");
  }
  for (const id of ["L1", "L2", "L3", "L4", "L5", "L6"] as const) if (!layers.has(id)) linkError("policy.yaml", id, `Required validation layer ${id} is undeclared.`, `Declare ${id} as active or declared-empty with a reason.`);
  for (const layer of model.policy.layers) if (layer.status === "declared-empty" && !layer.reason) shapeError("policy.yaml", layer.id, "reason", "Every declared-empty layer needs a plain-language reason.");
  for (const id of ["inner-loop", "per-commit", "triggered", "release", "scheduled"]) if (!lanes.has(id)) linkError("policy.yaml", id, `Required execution lane ${id} is undeclared.`, `Declare ${id} as active or declared-empty with a reason.`);
  for (const lane of model.policy.lanes) {
    if (lane.status === "declared-empty" && !lane.reason) shapeError("policy.yaml", lane.id, "reason", "Every declared-empty lane needs a plain-language reason.");
    if (lane.status === "active" && lane.triggers.length === 0) shapeError("policy.yaml", lane.id, "triggers", "Every active lane needs at least one exact trigger.");
    if (lane.status === "active" && lane.kind === "test" && !lane.command) shapeError("policy.yaml", lane.id, "command", "Every active test lane needs the actual command users and CI run.");
    if (lane.id === "inner-loop" && (lane.status !== "active" || lane.kind !== "test" || !lane.command)) shapeError("policy.yaml", lane.id, "status/kind/command", "The inner-loop must be an active test lane with an actual pre-push command.");
  }
  for (const exception of model.policy.exceptions) {
    if (!owners.has(exception.owner)) linkError("policy.yaml", exception.id, `${exception.id} cites missing owner ${exception.owner}.`, "Declare the owner or correct the exception owner.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires)) shapeError("policy.yaml", exception.id, "expires", "Use an exact YYYY-MM-DD expiry; the auditor evaluates whether it has lapsed.");
    if (exception.kind === "provisional" && !exception.value) shapeError("policy.yaml", exception.id, "value", "A provisional exception must state the testable temporary value.");
  }
  if (["C2", "C3", "C4"].includes(model.product.criticality) && layers.get("L5")?.status !== "active") shapeError("policy.yaml", "L5", "status", "C2-C4 products require an active L5 ops-hardening layer with threat and contention obligations.");
  if (model.policy.coexistence) for (const path of [model.policy.coexistence.isolated_root, ...model.policy.coexistence.protected_paths]) if (!safePath(path)) linkError("policy.yaml", "coexistence", `Coexistence path ${path} is unsafe.`, "Use bounded repository-relative isolated and protected paths with no traversal.");

  if (model.families.length === 0 || model.families.every((family) => family.status !== "implementable")) {
    diagnostics.push({ code: "MODEL_REQUIRED_SCOPE_EMPTY", severity: "error", concept: "families", location: { file: "validation-design/model/families.yaml", line: 1, column: 1 }, message: "The model has no implementable required family; empty validation cannot be accepted.", correction: "Declare at least one implementable family or explicitly model why each applicable lane is empty." });
  }
  for (const family of model.families) {
    if (!owners.has(family.owner)) linkError("families.yaml", family.id, `${family.id} cites missing owner ${family.owner}.`, "Declare the owner in owners.yaml or correct the family owner.");
    for (const id of family.source_ids) if (!sources.has(id)) linkError("families.yaml", family.id, `${family.id} cites missing provenance ${id}.`, "Declare the source or correct source_ids.");
    for (const id of family.structure_ids) if (!structures.has(id)) linkError("families.yaml", family.id, `${family.id} cites missing structure ${id}.`, "Declare the structure or correct structure_ids.");
    const lane = lanes.get(family.lane);
    if (!lane) linkError("families.yaml", family.id, `${family.id} cites missing lane ${family.lane}.`, "Declare the lane in policy.yaml or correct lane.");
    else if (lane.status !== "active") linkError("families.yaml", family.id, `${family.id} uses declared-empty lane ${family.lane}.`, "Activate the lane with its command/triggers or move the family to an active lane.");
    const layer = family.layer ? layers.get(family.layer) : undefined;
    if (family.layer && !layer) linkError("families.yaml", family.id, `${family.id} cites missing layer ${family.layer}.`, "Use one of the declared L1-L6 layers.");
    else if (layer?.status !== "active") linkError("families.yaml", family.id, `${family.id} uses declared-empty layer ${family.layer}.`, "Activate the layer or correct the family placement.");
    const ticket = family.ticket ? tickets.get(family.ticket) : undefined;
    if (family.ticket && !ticket) linkError("families.yaml", family.id, `${family.id} cites missing ticket ${family.ticket}.`, "Declare the ticket in backlog.yaml or correct ticket.");
    else if (ticket && !ticket.family_ids.includes(family.id)) linkError("families.yaml", family.id, `${family.id} points to ${ticket.id}, but that ticket does not include it.`, "Add the family to the ticket family_ids or correct the owning ticket.");
    if (family.status === "implementable") {
      for (const field of ["layer", "oracle", "risk"] as const) if (!family[field]) shapeError("families.yaml", family.id, field, `Set ${field} for the cheapest falsifying detector.`);
      if (!family.ticket) shapeError("families.yaml", family.id, "ticket", "Every implementable family needs one owning backlog ticket.");
      if (!family.control_ids?.length) shapeError("families.yaml", family.id, "control_ids", "Pair every implementable detector with at least one negative control.");
      for (const id of family.control_ids ?? []) {
        const control = controls.get(id);
        if (!control) linkError("families.yaml", family.id, `${family.id} cites missing negative control ${id}.`, "Declare the control in controls.yaml or correct control_ids.");
        else if (control.family_id !== family.id) linkError("families.yaml", family.id, `${id} belongs to ${control.family_id}, not ${family.id}.`, "Make the family/control relationship agree in both directions.");
      }
      if (lane?.kind === "test" && !family.planned_tests?.length) shapeError("families.yaml", family.id, "planned_tests", "Test lanes require one or more planned repository-relative test paths.");
      if (lane?.kind === "evidence" && !family.evidence) shapeError("families.yaml", family.id, "evidence", "Evidence lanes require an honest state and repository-relative artifact path.");
      for (const path of family.planned_tests ?? []) if (!safePath(path)) linkError("families.yaml", family.id, `${family.id} has unsafe planned test path ${path}.`, "Use repository-relative paths with no traversal.");
      if (family.evidence && !safePath(family.evidence.path)) linkError("families.yaml", family.id, `${family.id} has unsafe evidence path ${family.evidence.path}.`, "Use a repository-relative evidence path with no traversal.");
    } else if (!family.reason || (family.status === "blocked" && !family.blocked_by)) shapeError("families.yaml", family.id, family.status === "blocked" ? "reason/blocked_by" : "reason", "Pruned and blocked families require an explicit reason; blocked families also require blocked_by.");
    for (const reference of family.covers_failure_modes ?? []) {
      const separator = reference.indexOf("#");
      const structureId = separator > 0 ? reference.slice(0, separator) : "";
      const mode = separator > 0 ? reference.slice(separator + 1) : "";
      if (!structureId || !mode) { linkError("families.yaml", family.id, `${family.id} has malformed failure-mode reference ${reference}.`, 'Use "<structure-id>#<declared failure mode>" exactly as the structure declares it.'); continue; }
      const structure = structureById.get(structureId);
      if (!structure) linkError("families.yaml", family.id, `${family.id} cites failure mode ${reference} on missing structure ${structureId}.`, "Declare the structure in structures.yaml or correct covers_failure_modes.");
      else if (!(structure.failure_modes ?? []).includes(mode)) linkError("families.yaml", family.id, `${family.id} cites ${reference}, but ${structureId} declares no failure mode "${mode}".`, "Cite a declared failure mode verbatim or add the mode through the reviewed structure workflow.");
    }
  }
  // Failure-mode coverage closure (VA-ENF-001): every declared boundary
  // failure mode is covered by at least one family or pruned by name. A mode
  // that is merely listed, tested nowhere, and pruned nowhere is the
  // compliant-but-hollow hole this rule closes.
  const coveredModes = new Set(model.families.flatMap((family) => family.covers_failure_modes ?? []));
  for (const structure of model.structures) {
    if (structure.kind !== "boundary") continue;
    for (const mode of structure.failure_modes ?? []) {
      if (coveredModes.has(`${structure.id}#${mode}`)) continue;
      codedError("MODEL_FAILURE_MODE_UNCOVERED", "structures.yaml", structure.id, `${structure.id} declares failure mode "${mode}" with no covering family and no named prune.`, `Add covers_failure_modes: ["${structure.id}#${mode}"] to a detector family, or record the deliberate gap as a pruned family citing the same reference with its reason.`);
    }
  }
  for (const control of model.controls) {
    if (!families.has(control.family_id)) linkError("controls.yaml", control.id, `${control.id} cites missing family ${control.family_id}.`, "Declare the family or correct family_id.");
    if (!owners.has(control.owner)) linkError("controls.yaml", control.id, `${control.id} cites missing owner ${control.owner}.`, "Declare the owner or correct the control owner.");
  }
  for (const ticket of model.tickets) {
    if (!owners.has(ticket.owner)) linkError("backlog.yaml", ticket.id, `${ticket.id} cites missing owner ${ticket.owner}.`, "Declare the owner or correct the ticket owner.");
    if (!lanes.has(ticket.lane)) linkError("backlog.yaml", ticket.id, `${ticket.id} cites missing lane ${ticket.lane}.`, "Declare the execution lane or correct the ticket lane.");
    if (layers.get(ticket.layer)?.status !== "active") linkError("backlog.yaml", ticket.id, `${ticket.id} cites missing or inactive layer ${ticket.layer}.`, "Use the active layer the ticket's families implement.");
    for (const id of ticket.family_ids) {
      const family = families.get(id);
      if (!family) linkError("backlog.yaml", ticket.id, `${ticket.id} cites missing family ${id}.`, "Declare the family or remove the broken family_ids entry.");
      else if (family.ticket !== ticket.id) linkError("backlog.yaml", ticket.id, `${ticket.id} claims ${id}, but that family points to ${family.ticket ?? "no ticket"}.`, "Make ticket ownership agree in both directions.");
      else if (family.lane !== ticket.lane || family.layer !== ticket.layer) linkError("backlog.yaml", ticket.id, `${ticket.id} mixes ${id} from ${family.layer}/${family.lane} into ${ticket.layer}/${ticket.lane}.`, "Split tickets at layer/lane boundaries so expansion gates cannot stall cheaper work.");
    }
    const dependencies = ticket.depends_on ?? [];
    if (new Set(dependencies).size !== dependencies.length) shapeError("backlog.yaml", ticket.id, "depends_on", "List each dependency exactly once.");
    for (const id of dependencies) {
      if (id === ticket.id) linkError("backlog.yaml", ticket.id, `${ticket.id} cannot depend on itself.`, "Remove the self-reference or name the actual prerequisite ticket.");
      else if (!tickets.has(id)) linkError("backlog.yaml", ticket.id, `${ticket.id} depends on missing ticket ${id}.`, "Declare the dependency or remove the broken depends_on entry.");
    }
  }
  const visitedTickets = new Set<string>();
  const visitingTickets = new Set<string>();
  const visitTicket = (ticketId: string, path: string[]): void => {
    if (visitedTickets.has(ticketId)) return;
    visitingTickets.add(ticketId);
    for (const dependency of tickets.get(ticketId)?.depends_on ?? []) {
      if (!tickets.has(dependency) || dependency === ticketId) continue;
      if (visitingTickets.has(dependency)) {
        const start = path.indexOf(dependency);
        const cycle = [...path.slice(Math.max(0, start)), dependency];
        linkError("backlog.yaml", ticketId, `Ticket dependency cycle: ${cycle.join(" -> ")}.`, "Break the cycle so every ticket has a finite prerequisite order.");
      } else {
        visitTicket(dependency, [...path, dependency]);
      }
    }
    visitingTickets.delete(ticketId);
    visitedTickets.add(ticketId);
  };
  for (const ticket of model.tickets) visitTicket(ticket.id, [ticket.id]);
  for (const layer of model.policy.layers) {
    const used = model.families.some((family) => family.layer === layer.id);
    if (layer.status === "active" && !used) shapeError("policy.yaml", layer.id, "status", "An active layer needs at least one family; otherwise declare it empty with a reason.");
    if (layer.status === "declared-empty" && used) shapeError("policy.yaml", layer.id, "status", "A layer with families cannot be declared empty.");
  }
}
