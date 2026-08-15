import { existsSync, statSync } from "node:fs";

/**
 * Watches rambling.txt by mtime. The human may append mid-run (runs take
 * hours); before each stakeholder turn the orchestrator asks `changed()` and,
 * when true, tells the stakeholder to re-read the file.
 */
export class RambleWatcher {
  private lastMtimeMs: number | undefined;

  constructor(
    private readonly path: string,
    initialMtimeMs?: number,
  ) {
    this.lastMtimeMs = initialMtimeMs;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  currentMtimeMs(): number | undefined {
    if (!this.exists()) return undefined;
    return statSync(this.path).mtimeMs;
  }

  /** True once when an existing, primed file's mtime moves. */
  changed(): boolean {
    const now = this.currentMtimeMs();
    if (now === undefined) return false;
    const changed = this.lastMtimeMs === undefined ? false : now !== this.lastMtimeMs;
    this.lastMtimeMs = now;
    return changed;
  }

  /** Record the baseline without reporting a change (used at run start). */
  prime(): void {
    this.lastMtimeMs = this.currentMtimeMs();
  }

  lastSeenMtimeMs(): number | undefined {
    return this.lastMtimeMs;
  }
}
