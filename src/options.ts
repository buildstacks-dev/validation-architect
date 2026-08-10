import type { ClaudeAuthMode, CodexAuthMode, RunConfig } from "./types.js";

export function positiveIntegerFlag(raw: string | undefined, flag: string, fallback?: number): number {
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${flag} requires a value`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${flag} must be a positive integer; received "${raw}"`);
  }
  return parsed;
}

export function nonNegativeIntegerFlag(raw: string | undefined, flag: string, fallback?: number): number {
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${flag} requires a value`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${flag} must be a non-negative integer; received "${raw}"`);
  }
  return parsed;
}

function enumFlag<T extends string>(raw: string | undefined, flag: string, fallback: T, values: readonly T[]): T {
  const value = raw ?? fallback;
  if (!values.includes(value as T)) {
    throw new Error(`--${flag} must be one of ${values.join(" | ")}; received "${value}"`);
  }
  return value as T;
}

export function claudeAuthFlag(raw?: string): ClaudeAuthMode {
  return enumFlag(raw, "claude-auth", "subscription", ["subscription", "api-key"]);
}

export function codexAuthFlag(raw?: string): CodexAuthMode {
  return enumFlag(raw, "codex-auth", "chatgpt", ["chatgpt", "api-key"]);
}

export function buildRunConfig(
  fixture: string,
  runId: string,
  flags: ReadonlyMap<string, string>,
): RunConfig {
  const smoke = flags.get("smoke") === "true";
  const designerModel = flags.get("designer-model") ?? "claude-fable-5";
  return {
    fixture,
    runId,
    designerModel,
    stakeholderModel: flags.get("stakeholder-model") ?? "gpt-5.6-sol",
    readerModel: flags.get("reader-model") ?? "claude-sonnet-5",
    auditorModel: flags.get("auditor-model") ?? designerModel,
    claudeAuth: claudeAuthFlag(flags.get("claude-auth")),
    codexAuth: codexAuthFlag(flags.get("codex-auth")),
    maxExchanges: positiveIntegerFlag(flags.get("max-exchanges"), "max-exchanges", smoke ? 4 : 60),
    maxWallMinutes: positiveIntegerFlag(flags.get("wall-minutes"), "wall-minutes", smoke ? 45 : 300),
    designerMaxTurns: positiveIntegerFlag(flags.get("designer-max-turns"), "designer-max-turns", 250),
  };
}
