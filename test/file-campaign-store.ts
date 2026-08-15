import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CampaignCheckpoint, CampaignStorePort } from "../src/api/campaign-contracts.js";
import { staleGeneration, invalidCheckpoint } from "../src/api/errors.js";
import { parseDesignRunCheckpoint, canonicalCheckpoint } from "../src/api/schemas.js";

/**
 * Test-only file-backed compare-and-swap store used to prove the campaign
 * engine's independent-process behavior: checkpoints survive JSON round-trips
 * across processes and a stale generation never overwrites accepted state.
 * The production local adapter ships with the design package (#17); this is
 * its conformance reference.
 */
export class FileCampaignStore implements CampaignStorePort {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  #path(runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw invalidCheckpoint(`unsafe runId ${runId}`);
    return join(this.directory, `${runId}.json`);
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
      throw staleGeneration(expectedGeneration, currentGeneration, checkpoint.runId);
    }
    if (checkpoint.generation !== expectedGeneration + 1) {
      throw invalidCheckpoint(`generation must be ${expectedGeneration + 1}, got ${checkpoint.generation}`, {
        runId: checkpoint.runId,
      });
    }
    const path = this.#path(checkpoint.runId);
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, canonicalCheckpoint(checkpoint));
    renameSync(temp, path); // atomic on POSIX
  }
}
