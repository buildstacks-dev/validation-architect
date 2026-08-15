import { describe, expect, it, vi } from "vitest";

// The CLI must answer --help offline without any SDK call; the SDK modules
// are mocked with tripwires so any load-time call would fail the suite.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    throw new Error("SDK must not be called from the CLI help path");
  }),
}));
vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn(() => {
    throw new Error("SDK must not be constructed from the CLI help path");
  }),
}));

import { main } from "../src/cli.js";

function collect(): { io: { stdout: (line: string) => void; stderr: (line: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) }, out, err };
}

describe("validation-architect-design CLI", () => {
  it("prints --help offline with exit 0 and no provider construction", async () => {
    const { io, out } = collect();
    expect(await main(["--help"], io)).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("validation-architect-design [target-dir] --profile");
    expect(help).toContain("resume <runId>");
    expect(help).toContain("--out");
  });

  it("exits 2 with usage when invoked without arguments", async () => {
    const { io, err } = collect();
    expect(await main([], io)).toBe(2);
    expect(err.join("\n")).toContain("usage:");
  });

  it("requires --profile with a C0..C4 value", async () => {
    const { io, err } = collect();
    expect(await main(["."], io)).toBe(2);
    expect(err.join("\n")).toContain("--profile");
    const invalid = collect();
    expect(await main([".", "--profile", "C9", "--intake-file", "x.md"], invalid.io)).toBe(2);
    expect(invalid.err.join("\n")).toContain("--profile");
  });

  it("requires --intake-file for a new campaign", async () => {
    const { io, err } = collect();
    expect(await main([".", "--profile", "C0"], io)).toBe(2);
    expect(err.join("\n")).toContain("--intake-file");
  });

  it("requires a runId for resume", async () => {
    const { io } = collect();
    expect(await main(["resume"], io)).toBe(2);
  });

  it("rejects a flag without a value", async () => {
    const { io, err } = collect();
    expect(await main([".", "--profile"], io)).toBe(2);
    expect(err.join("\n")).toContain("--profile requires a value");
  });
});
