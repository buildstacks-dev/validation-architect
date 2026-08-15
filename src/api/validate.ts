/**
 * Internal runtime-validation combinators for the public contract layer.
 * Hand-rolled because the core package's only runtime dependency is `yaml`.
 * Every public boundary validates with these; a TypeScript cast cannot bypass
 * them because the entry points call the validators on the live value.
 */

import { invalidInput } from "./errors.js";

export type Check = (value: unknown, path: string, problems: string[]) => void;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function requireString(value: unknown, path: string, problems: string[]): value is string {
  if (typeof value === "string" && value.length > 0) return true;
  problems.push(`${path} must be a non-empty string`);
  return false;
}

export function optionalString(value: unknown, path: string, problems: string[]): void {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    problems.push(`${path} must be a non-empty string when present`);
  }
}

export function requireNumber(value: unknown, path: string, problems: string[]): value is number {
  if (typeof value === "number" && Number.isFinite(value)) return true;
  problems.push(`${path} must be a finite number`);
  return false;
}

export function requireInteger(value: unknown, path: string, problems: string[], minimum = 0): value is number {
  if (typeof value === "number" && Number.isInteger(value) && value >= minimum) return true;
  problems.push(`${path} must be an integer >= ${minimum}`);
  return false;
}

export function requireEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  problems: string[],
): value is T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return true;
  problems.push(`${path} must be one of [${allowed.join(", ")}]`);
  return false;
}

export function requireArray(value: unknown, path: string, problems: string[]): value is unknown[] {
  if (Array.isArray(value)) return true;
  problems.push(`${path} must be an array`);
  return false;
}

export function requireStringArray(value: unknown, path: string, problems: string[]): value is string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) return true;
  problems.push(`${path} must be an array of non-empty strings`);
  return false;
}

export function requireRecord(value: unknown, path: string, problems: string[]): value is Record<string, unknown> {
  if (isRecord(value)) return true;
  problems.push(`${path} must be an object`);
  return false;
}

/**
 * Repository-relative path guard: rejects traversal, absolute paths, NUL, and
 * backslash separators so a hostile corpus or query cannot escape the target.
 */
export function safeRepositoryPath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split("/").includes("..");
}

export function requireSafePath(value: unknown, path: string, problems: string[]): value is string {
  if (typeof value === "string" && safeRepositoryPath(value)) return true;
  problems.push(`${path} must be a repository-relative path without traversal`);
  return false;
}

/** Throw the typed invalid-input failure when a validator reported problems. */
export function assertValid(kind: string, problems: string[]): void {
  if (problems.length > 0) {
    throw invalidInput(`${kind} failed validation: ${problems.join("; ")}`, { kind, problems: [...problems] });
  }
}
