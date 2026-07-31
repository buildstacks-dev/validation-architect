import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptEntry, TranscriptRole } from "./types.js";

export function transcriptPath(runDir: string): string {
  return join(runDir, "transcript.jsonl");
}

/** Append-only JSONL transcript; the run report is derived from this file. */
export class Transcript {
  private seq: number;

  constructor(
    private readonly runDir: string,
    startSeq = 0,
  ) {
    this.seq = startSeq;
  }

  nextSeq(): number {
    return this.seq;
  }

  append(entry: Omit<TranscriptEntry, "ts" | "seq">): TranscriptEntry {
    const full: TranscriptEntry = {
      ts: new Date().toISOString(),
      seq: this.seq++,
      ...entry,
    };
    appendFileSync(transcriptPath(this.runDir), `${JSON.stringify(full)}\n`);
    return full;
  }

  note(role: TranscriptRole, note: string): void {
    this.append({ role, text: "", note });
  }
}

export function readTranscript(runDir: string): TranscriptEntry[] {
  const path = transcriptPath(runDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TranscriptEntry);
}
