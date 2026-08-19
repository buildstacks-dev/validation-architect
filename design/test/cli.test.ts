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

import { defaultStateDirectory, main } from "../src/cli.js";

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
    expect(help).toContain("list [target-dir]");
    expect(help).toContain("report <runId>");
    expect(help).toContain("fixture <name>");
    expect(help).toContain("--smoke");
    expect(help).toContain("deliver <runId>");
    expect(help).toContain("repos [target-dir ...]");
    expect(help).toContain("readers <runId>");
    expect(help).toContain("audit <runId>");
    expect(help).toContain("fidelity <target-dir>");
    expect(help).toContain("--out");
    expect(help).toContain("[--intake-file <file>]");
    expect(help).toContain("--claude-auth <subscription|api-key>");
    expect(help).toContain("--codex-auth <chatgpt|api-key>");
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

  it("defaults checkpoint/provider state outside the target checkout", () => {
    const target = "/tmp/example-product";
    expect(defaultStateDirectory(target)).not.toContain(`${target}/`);
  });

  it("requires a runId for resume", async () => {
    const { io } = collect();
    expect(await main(["resume"], io)).toBe(2);
  });

  it("requires a fixture name and a profile outside smoke mode", async () => {
    const missing = collect();
    expect(await main(["fixture"], missing.io)).toBe(2);
    expect(missing.err.join("\n")).toContain("fixture requires");
    const profile = collect();
    expect(await main(["fixture", "lumen-webapp"], profile.io)).toBe(2);
    expect(profile.err.join("\n")).toContain("--profile");
  });

  it("rejects a flag without a value", async () => {
    const { io, err } = collect();
    expect(await main([".", "--profile"], io)).toBe(2);
    expect(err.join("\n")).toContain("--profile requires a value");
  });

  it("rejects unknown flags instead of silently ignoring them", async () => {
    const { io, err } = collect();
    expect(await main([".", "--profile", "C0", "--mystery", "x"], io)).toBe(2);
    expect(err.join("\n")).toContain("unknown flag --mystery");
  });

  it("rejects flags that belong to the other command", async () => {
    const { io, err } = collect();
    expect(await main(["resume", "run-1", "--profile", "C0"], io)).toBe(2);
    expect(err.join("\n")).toContain("--profile is not valid for resume");
  });

  it("rejects invalid auth modes before campaign setup", async () => {
    const claude = collect();
    expect(await main([".", "--profile", "C0", "--claude-auth", "other"], claude.io)).toBe(2);
    expect(claude.err.join("\n")).toContain("--claude-auth");
    const codex = collect();
    expect(await main([".", "--profile", "C0", "--codex-auth", "other"], codex.io)).toBe(2);
    expect(codex.err.join("\n")).toContain("--codex-auth");
  });

  it("validates fidelity scope before provider setup", async () => {
    const invalid = collect();
    expect(await main(["fidelity", ".", "--wave", "0"], invalid.io)).toBe(2);
    expect(invalid.err.join("\n")).toContain("--wave");
    const conflicting = collect();
    expect(await main(["fidelity", ".", "--wave", "1", "--tickets", "HB-1"], conflicting.io)).toBe(2);
    expect(conflicting.err.join("\n")).toContain("not both");
  });
});
