/**
 * Spec-detection conventions (issue #88). Both closure paths — the public
 * check() facade over RepositoryPort and the CLI trace host — recognize spec
 * files, count executable test call sites, and read the first-comment
 * traceability header through one compiled convention. The checked model may
 * declare a reviewed `conventions` block in model/project.yaml: a named
 * runner preset, or `runner: custom` with an explicit detection block that is
 * recorded verbatim in the compiled identity so closure results stay
 * reproducible. Absent, the jest-vitest preset applies — today's exact JS/TS
 * behavior — so existing corpora keep byte-identical identities and closure
 * results. Unknown or ambiguous conventions fail closed at compile time; the
 * compiler never silently falls back to JS/TS.
 */

export const SPEC_HEADER_COMMENT_STYLES = [
  "slash-line", // // …
  "slash-block", // /* … */
  "hash-line", // # …
  "dash-line", // -- …
  "docstring", // """ … """ or ''' … '''
] as const;

export type SpecHeaderCommentStyle = (typeof SPEC_HEADER_COMMENT_STYLES)[number];

/** Basename shape matched in addition to full-path suffixes (pytest test_*.py). */
export interface SpecBasenamePattern {
  prefix: string;
  suffix: string;
}

export interface SpecConventions {
  /** Named preset identity, or "custom" for an explicit reviewed pattern. */
  runner: string;
  /** Literal path suffixes that mark a spec file. */
  spec_suffixes: string[];
  /** Additional basename prefix+suffix shapes a preset may declare. */
  spec_basename_patterns?: SpecBasenamePattern[];
  /** Regular expression (applied with the g and m flags) matching one
   * executable test call site per match — a heuristic count, never fidelity. */
  test_call_pattern: string;
  /** Header comment styles admitted for the first-comment traceability
   * header, tried in the declared order; the first matching style wins. */
  header_comment_styles: SpecHeaderCommentStyle[];
}

export const CUSTOM_SPEC_RUNNER = "custom";

/** The historical hardcoded suffixes, now the jest-vitest preset's suffixes. */
export const DEFAULT_SPEC_SUFFIXES = [".test.ts", ".test.tsx", ".test.js", ".test.mjs", ".spec.ts"] as const;

/**
 * Named runner presets validated by the compiler. jest-vitest reproduces the
 * previously hardcoded behavior exactly; preset semantics are pinned by the
 * versions bundle every corpus already declares, and the resolved detection
 * block (not just the preset name) enters the compiled identity.
 */
export const SPEC_RUNNER_PRESETS: Readonly<Record<string, SpecConventions>> = Object.freeze({
  "jest-vitest": {
    runner: "jest-vitest",
    spec_suffixes: [...DEFAULT_SPEC_SUFFIXES],
    test_call_pattern: String.raw`^\s*(?:it|test)(?:\.\w+)?\s*\(`,
    header_comment_styles: ["slash-line", "slash-block"],
  },
  pytest: {
    runner: "pytest",
    spec_suffixes: ["_test.py"],
    spec_basename_patterns: [{ prefix: "test_", suffix: ".py" }],
    test_call_pattern: String.raw`^\s*(?:async\s+)?def\s+test_\w*\s*\(`,
    header_comment_styles: ["hash-line", "docstring"],
  },
  "go-test": {
    runner: "go-test",
    spec_suffixes: ["_test.go"],
    test_call_pattern: String.raw`^func\s+(?:Test|Benchmark|Example|Fuzz)\w*\s*\(`,
    header_comment_styles: ["slash-line", "slash-block"],
  },
  junit: {
    runner: "junit",
    spec_suffixes: ["Test.java", "Tests.java", "TestCase.java", "IT.java"],
    test_call_pattern: String.raw`^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b`,
    header_comment_styles: ["slash-line", "slash-block"],
  },
});

export const DEFAULT_SPEC_CONVENTIONS = SPEC_RUNNER_PRESETS["jest-vitest"] as SpecConventions;

/** The compiled model's declared conventions, or the exact historical default. */
export function resolveSpecConventions(declared?: SpecConventions): SpecConventions {
  return declared ?? DEFAULT_SPEC_CONVENTIONS;
}

const HEADER_MATCHERS: Readonly<Record<SpecHeaderCommentStyle, RegExp>> = Object.freeze({
  "slash-line": /^\s*((?:\/\/[^\n]*(?:\n|$))+)/,
  "slash-block": /^\s*(\/\*[\s\S]*?\*\/)/,
  "hash-line": /^\s*((?:#[^\n]*(?:\n|$))+)/,
  "dash-line": /^\s*((?:--[^\n]*(?:\n|$))+)/,
  docstring: /^\s*("""[\s\S]*?"""|'''[\s\S]*?''')/,
});

/** Whether a repository-relative path is a spec file under the convention. */
export function isSpecPath(path: string, conventions: SpecConventions): boolean {
  if (conventions.spec_suffixes.some((suffix) => path.endsWith(suffix))) return true;
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (conventions.spec_basename_patterns ?? []).some(
    (pattern) =>
      basename.length >= pattern.prefix.length + pattern.suffix.length &&
      basename.startsWith(pattern.prefix) &&
      basename.endsWith(pattern.suffix),
  );
}

/** Count executable test call sites — a heuristic count, never fidelity. */
export function countTestCallSites(source: string, conventions: SpecConventions): number {
  return [...source.matchAll(new RegExp(conventions.test_call_pattern, "gm"))].length;
}

/** The first-comment traceability header, under the convention's styles. */
export function firstSpecHeader(source: string, conventions: SpecConventions): string | undefined {
  for (const style of conventions.header_comment_styles) {
    const match = source.match(HEADER_MATCHERS[style]);
    if (match) return match[1];
  }
  return undefined;
}
