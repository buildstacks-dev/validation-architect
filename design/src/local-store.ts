/**
 * Production atomic file-backed CampaignStorePort with generation
 * compare-and-swap. Adapted from the core's conformance reference
 * (test/file-campaign-store.ts): checkpoints are validated through the
 * public parseDesignRunCheckpoint on every load, writes go through a
 * temp-file + rename (atomic on POSIX), and a stale generation raises the
 * typed stale_generation conflict instead of overwriting accepted state.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  PublicContractError,
  canonicalCheckpoint,
  parseDesignRunCheckpoint,
  validateDesignRunCheckpoint,
  type CampaignCheckpoint,
  type CampaignStorePort,
} from "validation-architect";

export interface LocalCampaignStoreOptions {
  /** Explicit state directory; created if absent. */
  directory: string;
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LocalCampaignStore implements CampaignStorePort {
  readonly #directory: string;

  constructor(options: LocalCampaignStoreOptions) {
    this.#directory = resolve(options.directory);
    mkdirSync(this.#directory, { recursive: true });
  }

  get directory(): string {
    return this.#directory;
  }

  #path(runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
      throw new PublicContractError("invalid_checkpoint", `unsafe runId ${runId}`, { runId });
    }
    return join(this.#directory, `${runId}.json`);
  }

  async load(runId: string): Promise<CampaignCheckpoint | null> {
    try {
      return parseDesignRunCheckpoint(readFileSync(this.#path(runId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(checkpoint: CampaignCheckpoint, expectedGeneration: number): Promise<void> {
    validateDesignRunCheckpoint(checkpoint);
    const path = this.#path(checkpoint.runId);
    const lock = `${path}.lock`;
    await this.#withLock(lock, async () => {
      const current = await this.load(checkpoint.runId);
      const currentGeneration = current?.generation ?? 0;
      if (currentGeneration !== expectedGeneration) {
        throw new PublicContractError(
          "stale_generation",
          `Checkpoint save for run ${checkpoint.runId} expected generation ${expectedGeneration} but the store holds ${currentGeneration}; another process advanced the campaign.`,
          { expected: expectedGeneration, actual: currentGeneration, runId: checkpoint.runId },
        );
      }
      if (checkpoint.generation !== expectedGeneration + 1) {
        throw new PublicContractError(
          "invalid_checkpoint",
          `generation must be ${expectedGeneration + 1}, got ${checkpoint.generation}`,
          { runId: checkpoint.runId },
        );
      }
      const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        const descriptor = openSync(temp, "wx", 0o600);
        try {
          writeFileSync(descriptor, canonicalCheckpoint(checkpoint));
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        renameSync(temp, path);
      } finally {
        try { unlinkSync(temp); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    });
  }

  async #withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 10_000;
    let descriptor: number | undefined;
    while (descriptor === undefined) {
      try {
        descriptor = openSync(path, "wx", 0o600);
        try {
          writeFileSync(descriptor, String(process.pid));
          fsyncSync(descriptor);
        } catch (error) {
          closeSync(descriptor);
          descriptor = undefined;
          try { unlinkSync(path); } catch { /* preserve the original write failure */ }
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const owner = Number.parseInt(readFileSync(path, "utf8"), 10);
          if (Number.isSafeInteger(owner) && owner > 0 && !processAlive(owner)) unlinkSync(path);
          else if (!Number.isSafeInteger(owner) && Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectionError;
        }
        if (Date.now() >= deadline) {
          throw new PublicContractError("stale_generation", `Timed out acquiring checkpoint lock ${path}.`);
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    try {
      return await action();
    } finally {
      closeSync(descriptor);
      try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
