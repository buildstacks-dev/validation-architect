/** Local repository composition with one fixed append-only intake source. */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IntakeSnapshot, RepositoryPort } from "validation-architect";
import { LocalRepository } from "./local-repository.js";

export interface RunRepositoryOptions {
  root: string;
  intakeSource: string;
}

export class RunRepository implements RepositoryPort {
  readonly #repository: LocalRepository;
  readonly #intakeSource: string;
  readonly #sourceId: string;

  constructor(options: RunRepositoryOptions) {
    this.#repository = new LocalRepository({ root: options.root });
    this.#intakeSource = resolve(options.intakeSource);
    this.#sourceId = `file:${this.#intakeSource}`;
  }

  revision(): Promise<string> {
    return this.#repository.revision();
  }

  readFile(path: string): Promise<string | null> {
    return this.#repository.readFile(path);
  }

  listFiles(globs: string[]): Promise<string[]> {
    return this.#repository.listFiles(globs);
  }

  changedPaths(base: string, head: string): Promise<string[]> {
    return this.#repository.changedPaths(base, head);
  }

  async intakeSnapshot(): Promise<IntakeSnapshot> {
    if (!existsSync(this.#intakeSource)) return { sourceId: this.#sourceId, content: null, instanceId: null };
    const entry = lstatSync(this.#intakeSource);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`intake source must remain a real regular file: ${this.#intakeSource}`);
    }
    return {
      sourceId: this.#sourceId,
      content: readFileSync(this.#intakeSource, "utf8"),
      instanceId: `${entry.dev}:${entry.ino}`,
    };
  }
}
