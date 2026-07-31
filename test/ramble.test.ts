import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RambleWatcher } from "../src/ramble.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vda-ramble-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("RambleWatcher", () => {
  it("reports no change when the file never changes", () => {
    const p = join(dir, "rambling.txt");
    writeFileSync(p, "thoughts");
    const w = new RambleWatcher(p);
    w.prime();
    expect(w.changed()).toBe(false);
    expect(w.changed()).toBe(false);
  });

  it("reports a change exactly once after an mtime bump", () => {
    const p = join(dir, "rambling.txt");
    writeFileSync(p, "thoughts");
    const w = new RambleWatcher(p);
    w.prime();
    utimesSync(p, new Date(), new Date(Date.now() + 10_000));
    expect(w.changed()).toBe(true);
    expect(w.changed()).toBe(false);
  });

  it("handles a missing file (pure-simulation mode)", () => {
    const w = new RambleWatcher(join(dir, "absent.txt"));
    w.prime();
    expect(w.exists()).toBe(false);
    expect(w.changed()).toBe(false);
  });

  it("restores its baseline from a persisted mtime (resume path)", () => {
    const p = join(dir, "rambling.txt");
    writeFileSync(p, "thoughts");
    const w1 = new RambleWatcher(p);
    w1.prime();
    const persisted = w1.lastSeenMtimeMs();
    const w2 = new RambleWatcher(p, persisted);
    expect(w2.changed()).toBe(false);
    utimesSync(p, new Date(), new Date(Date.now() + 10_000));
    expect(w2.changed()).toBe(true);
  });
});
