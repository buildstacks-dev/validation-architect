import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_MODEL_VIEWS } from "./model-views.js";
import { compileWorkspaceModel } from "./workspace-compiler.js";

export interface ReaderBundle {
  root: string;
  identity: string;
  files: string[];
}

/** Materialize an ephemeral, generated-only view of one compiler identity. */
export function createReaderBundle(workspace: string): ReaderBundle {
  const compiled = compileWorkspaceModel(workspace, { regenerate: false });
  if (!compiled.accepted || !compiled.identity || !compiled.model) {
    throw new Error("reader bundle requires a clean compiled model and generated views");
  }
  const root = mkdtempSync(join(workspace, ".reader-bundle-"));
  try {
    for (const file of GENERATED_MODEL_VIEWS) {
      const content = compiled.generated_views[file];
      if (content === undefined) throw new Error(`compiled reader view ${file} is missing`);
      writeFileSync(join(root, file), content);
    }
    const report = readFileSync(compiled.report_path, "utf8");
    const reportIdentity = (JSON.parse(report) as { model_identity?: unknown }).model_identity;
    if (reportIdentity !== compiled.identity) throw new Error("compiler report identity disagrees with generated views");
    writeFileSync(join(root, "compiler-report.json"), report);
    const files = [...GENERATED_MODEL_VIEWS, "compiler-report.json", "bundle-identity.json"];
    writeFileSync(
      join(root, "bundle-identity.json"),
      `${JSON.stringify({ schema: "validation-architect/reader-bundle/v1", model_identity: compiled.identity, versions: compiled.model.versions, files }, null, 2)}\n`,
    );
    return { root, identity: compiled.identity, files };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function removeReaderBundle(bundle: ReaderBundle): void {
  rmSync(bundle.root, { recursive: true, force: true });
}
