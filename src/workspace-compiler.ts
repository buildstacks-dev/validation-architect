import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL_DIRECTORY,
  MODEL_FILES,
  type CompiledModelBundle,
  type CompilerDiagnostic,
  type ModelFileSet,
  type ModelFilename,
} from "./model.js";
import { compileValidationModel } from "./model-compiler.js";
import { GENERATED_MODEL_VIEWS } from "./model-views.js";
import { COMPILER_VERSION } from "./versions.js";

export interface WorkspaceCompileOptions {
  regenerate: boolean;
}

export interface WorkspaceCompilation extends CompiledModelBundle {
  source_fingerprint: string;
  surface_fingerprint: string;
  report_path: string;
}

function designRoot(workspace: string): string {
  return join(workspace, "validation-design");
}

function modelRoot(workspace: string): string {
  return join(designRoot(workspace), MODEL_DIRECTORY);
}

interface ReadOutcome {
  value?: string;
  errorCode?: string;
}

function readIfPresent(path: string): ReadOutcome {
  try {
    return { value: readFileSync(path, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? {} : { errorCode: code ?? "UNKNOWN" };
  }
}

function readWorkspaceModelInput(workspace: string): {
  files: Partial<ModelFileSet>;
  diagnostics: CompilerDiagnostic[];
  sourceFingerprint: string;
} {
  const root = modelRoot(workspace);
  const files: Partial<Record<ModelFilename, string>> = {};
  const diagnostics: CompilerDiagnostic[] = [];
  const hash = createHash("sha256");
  for (const file of MODEL_FILES) {
    const outcome = readIfPresent(join(root, file));
    hash.update(file).update("\0");
    if (outcome.value !== undefined) {
      files[file] = outcome.value;
      hash.update(outcome.value);
    } else if (outcome.errorCode) {
      hash.update(`<unreadable:${outcome.errorCode}>`);
      diagnostics.push({
        code: "MODEL_FILE_UNREADABLE",
        severity: "error",
        concept: file,
        location: { file: `validation-design/model/${file}`, line: 1, column: 1 },
        message: `Required logical model file ${file} could not be read (${outcome.errorCode}).`,
        correction: `Make validation-design/model/${file} a readable regular UTF-8 file, then compile again.`,
      });
    } else {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return { files, diagnostics, sourceFingerprint: hash.digest("hex") };
}

export function readWorkspaceModelFiles(workspace: string): Partial<ModelFileSet> {
  return readWorkspaceModelInput(workspace).files;
}

export function workspaceModelSourceFingerprint(workspace: string): string {
  return readWorkspaceModelInput(workspace).sourceFingerprint;
}

export function workspaceModelSurfaceFingerprint(workspace: string): string {
  const root = designRoot(workspace);
  const hash = createHash("sha256").update(workspaceModelSourceFingerprint(workspace));
  for (const file of GENERATED_MODEL_VIEWS) {
    hash.update(file).update("\0");
    const outcome = readIfPresent(join(root, file));
    hash.update(outcome.value ?? (outcome.errorCode ? `<unreadable:${outcome.errorCode}>` : "<missing>")).update("\0");
  }
  return hash.digest("hex");
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function renderReport(bundle: CompiledModelBundle, sourceFingerprint: string): string {
  return `${JSON.stringify(
    {
      schema: COMPILER_VERSION,
      accepted: bundle.accepted,
      source_fingerprint: sourceFingerprint,
      model_identity: bundle.identity ?? null,
      versions: bundle.model?.versions ?? null,
      generated_views: Object.keys(bundle.generated_views).sort(),
      diagnostics: bundle.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    },
    null,
    2,
  )}\n`;
}

export function compileWorkspaceModel(
  workspace: string,
  options: WorkspaceCompileOptions,
): WorkspaceCompilation {
  const root = designRoot(workspace);
  mkdirSync(root, { recursive: true });
  const input = readWorkspaceModelInput(workspace);
  const files = input.files;
  const existingViews: Partial<Record<string, string>> = {};
  for (const file of GENERATED_MODEL_VIEWS) {
    const value = readIfPresent(join(root, file)).value;
    if (value !== undefined) existingViews[file] = value;
  }
  const sourceFingerprint = input.sourceFingerprint;
  const compiled = compileValidationModel(files, {
    existingViews,
    allowRegenerate: options.regenerate,
  });
  const unreadable = new Set(input.diagnostics.map((diagnostic) => diagnostic.concept));
  const bundle: CompiledModelBundle = input.diagnostics.length === 0
    ? compiled
    : {
        accepted: false,
        diagnostics: [
          ...input.diagnostics,
          ...compiled.diagnostics.filter(
            (diagnostic) => diagnostic.code !== "MODEL_FILE_MISSING" || !unreadable.has(diagnostic.concept),
          ),
        ],
        generated_views: {},
      };
  if (bundle.accepted && options.regenerate) {
    for (const file of GENERATED_MODEL_VIEWS) {
      const expected = bundle.generated_views[file];
      if (expected !== undefined && existingViews[file] !== expected) atomicWrite(join(root, file), expected);
    }
  }
  const reportPath = join(root, "compiler-report.json");
  atomicWrite(reportPath, renderReport(bundle, sourceFingerprint));
  return {
    ...bundle,
    source_fingerprint: sourceFingerprint,
    surface_fingerprint: workspaceModelSurfaceFingerprint(workspace),
    report_path: reportPath,
  };
}

export function workspaceCompilerProblems(workspace: string): string[] {
  const result = compileWorkspaceModel(workspace, { regenerate: false });
  return result.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map(
      (diagnostic) =>
        `${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column} ${diagnostic.concept}: ${diagnostic.message} Correction: ${diagnostic.correction}`,
    );
}
