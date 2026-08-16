import { createHash } from "node:crypto";
import {
  MODEL_FILES,
  type CompiledModelBundle,
  type CompilerDiagnostic,
  type ModelFilename,
} from "./model.js";
import type { CoreVersionBundle } from "./versions.js";
import { COMPILER_VERSION } from "./versions.js";

export interface CompilerReportRecord {
  schema: typeof COMPILER_VERSION;
  accepted: boolean;
  source_fingerprint: string;
  model_identity: string | null;
  versions: CoreVersionBundle | null;
  generated_views: string[];
  diagnostics: CompilerDiagnostic[];
}

export interface CanonicalCompilerReport {
  record: CompilerReportRecord;
  /** Canonical two-space JSON with one trailing newline. */
  content: string;
}

export interface UnreadableModelSource {
  unreadable: string;
}

export type ModelSourceInput = Partial<Record<ModelFilename, string | UnreadableModelSource>>;

/**
 * Bind the eight logical filenames in their declared order, including exact
 * UTF-8 source bytes and explicit missing/unreadable markers.
 */
export function modelSourceFingerprint(sources: ModelSourceInput): string {
  const hash = createHash("sha256");
  for (const file of MODEL_FILES) {
    const source = sources[file];
    hash.update(file).update("\0");
    if (typeof source === "string") hash.update(source);
    else if (source) hash.update(`<unreadable:${source.unreadable}>`);
    else hash.update("<missing>");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function serializeCompilerReport(record: CompilerReportRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function buildCompilerReport(
  bundle: CompiledModelBundle,
  sourceFingerprint: string,
): CanonicalCompilerReport {
  const record: CompilerReportRecord = {
    schema: COMPILER_VERSION,
    accepted: bundle.accepted,
    source_fingerprint: sourceFingerprint,
    model_identity: bundle.identity ?? null,
    versions: bundle.model?.versions ?? null,
    generated_views: Object.keys(bundle.generated_views).sort(),
    diagnostics: bundle.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
  };
  return { record, content: serializeCompilerReport(record) };
}
