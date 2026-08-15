/**
 * CLI-only read-only RepositoryPort over the local filesystem and `git`.
 * This is host composition for src/core-cli.ts: it is never imported from
 * src/api/** — the library itself performs no filesystem or process effect.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Directories that are never repository facts. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

function safeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split("/").includes("..");
}

function safeGitRef(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && /^[A-Za-z0-9._/~^@{}-]+$/.test(value) && !value.includes("..");
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Read-only local repository composition. Reads are confined to the target
 * root (traversal, absolute paths, and symlink escapes are refused); revision
 * and changed-path answers come from `git` as a subprocess.
 */
export class CliLocalRepository {
  readonly #root: string;

  constructor(root: string) {
    this.#root = realpathSync.native(resolve(root));
  }

  #git(args: string[]): string {
    try {
      return execFileSync("git", ["-C", this.#root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw new Error(
        `git ${args.join(" ")} failed in ${this.#root}: ${(error as Error).message}`,
      );
    }
  }

  /** Canonical absolute path when the target stays inside the root, else null. */
  #resolveContained(path: string): string | null {
    if (!safeRelativePath(path)) return null;
    const lexical = join(this.#root, path);
    let ancestor = lexical;
    for (;;) {
      try {
        lstatSync(ancestor);
        break;
      } catch {
        const parent = resolve(ancestor, "..");
        if (parent === ancestor) return null;
        ancestor = parent;
      }
    }
    const canonical = resolve(realpathSync.native(ancestor), relative(ancestor, lexical));
    const rel = relative(this.#root, canonical);
    if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) return null;
    return canonical;
  }

  async revision(): Promise<string> {
    return this.#git(["rev-parse", "HEAD"]);
  }

  async readFile(path: string): Promise<string | null> {
    const contained = this.#resolveContained(path);
    if (contained === null) {
      throw new Error(`Repository path rejected (absolute, traversal, or symlink escape): ${path}`);
    }
    try {
      return readFileSync(contained, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR") {
        return null;
      }
      throw error;
    }
  }

  async listFiles(globs: string[]): Promise<string[]> {
    const expressions = globs.map(globToRegExp);
    const found: string[] = [];
    const walk = (current: string): void => {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const absolute = join(current, entry.name);
        if (entry.isSymbolicLink()) continue; // a symlink is never a repository fact
        if (entry.isDirectory()) {
          walk(absolute);
        } else if (entry.isFile()) {
          const rel = relative(this.#root, absolute).replaceAll(sep, "/");
          if (expressions.some((expression) => expression.test(rel))) found.push(rel);
        }
      }
    };
    walk(this.#root);
    return found.sort();
  }

  async changedPaths(base: string, head: string): Promise<string[]> {
    if (!safeGitRef(base) || !safeGitRef(head)) {
      throw new Error(`changedPaths rejects unsafe revision names: ${base}..${head}`);
    }
    const output = this.#git(["diff", "--name-only", `${base}..${head}`]);
    return output.length === 0 ? [] : output.split("\n");
  }
}
