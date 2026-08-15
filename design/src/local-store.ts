/**
 * Production atomic file-backed CampaignStorePort with generation
 * compare-and-swap. Adapted from the core's conformance reference
 * (test/file-campaign-store.ts): checkpoints are validated through the
 * public parseDesignRunCheckpoint on every load, writes go through a
 * temp-file + rename (atomic on POSIX), and a stale generation raises the
 * typed stale_generation conflict instead of overwriting accepted state.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PublicContractError,
  canonicalCheckpoint,
  parseDesignRunCheckpoint,
  type CampaignCheckpoint,
  type CampaignStorePort,
} from "validation-architect";

export interface LocalCampaignStoreOptions {
  /** Explicit state directory; created if absent. */
  directory: string;
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
    const path = this.#path(checkpoint.runId);
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, canonicalCheckpoint(checkpoint));
    renameSync(temp, path); // atomic on POSIX
  }
}
