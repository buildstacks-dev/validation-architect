import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACEABILITY_CONVENTIONS } from "./conventions.js";

const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Materialize the complete product-repo enablement handoff inside a delivered
 * validation-design corpus. The caller owns when that corpus is delivered;
 * this helper only writes beneath `<corpus>/enablement`.
 */
export function materializeEnablementBundle(
  corpusDir: string,
  packageRoot = DEFAULT_PACKAGE_ROOT,
): string {
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json must declare the enablement package version");
  }

  const bundle = join(corpusDir, "enablement");
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(join(bundle, "skills"), { recursive: true });
  mkdirSync(join(bundle, "ci"), { recursive: true });

  cpSync(
    join(packageRoot, "skill", "implement-harness-ticket"),
    join(bundle, "skills", "implement-harness-ticket"),
    { recursive: true },
  );
  cpSync(
    join(packageRoot, "enablement", "ci", "validation-trace.yml"),
    join(bundle, "ci", "validation-trace.yml"),
  );

  const install = readFileSync(join(packageRoot, "enablement", "INSTALL.md"), "utf8");
  const packageSpecifier = `validation-architect@${packageJson.version}`;
  if (!install.includes(packageSpecifier) || install.includes("{{PACKAGE_VERSION}}")) {
    throw new Error(
      `enablement/INSTALL.md must pin ${packageSpecifier} without template placeholders`,
    );
  }
  writeFileSync(join(bundle, "INSTALL.md"), install);
  writeFileSync(
    join(bundle, "traceability-conventions.md"),
    `# Traceability conventions\n\n${TRACEABILITY_CONVENTIONS}\n`,
  );
  return bundle;
}
