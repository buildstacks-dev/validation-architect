/** Packaged fixture discovery and answer-key-free source materialization. */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

export function listPackagedFixtures(): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort();
}

export function packagedFixtureDirectory(name: string): string {
  if (!/^[a-z0-9-]+$/.test(name) || !listPackagedFixtures().includes(name)) {
    throw new Error(`unknown fixture ${name}; available: ${listPackagedFixtures().join(", ") || "(none)"}`);
  }
  return join(root, name);
}

export function materializeFixtureTarget(
  name: string,
  stateDirectory: string,
  runId: string,
): string {
  const source = packagedFixtureDirectory(name);
  const target = join(resolve(stateDirectory), "fixture-sources", runId);
  if (existsSync(target)) throw new Error(`fixture source already exists for run ${runId}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    cpSync(source, target, {
      recursive: true,
      filter: (path) => path === source || !path.endsWith(`${process.platform === "win32" ? "\\" : "/"}fixture.yaml`),
    });
    if (existsSync(join(target, "fixture.yaml"))) throw new Error("fixture answer key reached campaign source");
    git(target, ["init", "-q"]);
    git(target, ["config", "user.email", "fixture@validation-architect.invalid"]);
    git(target, ["config", "user.name", "Validation Architect Fixture"]);
    git(target, ["add", "."]);
    git(target, ["commit", "-qm", `Materialize ${name}`]);
    return target;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
