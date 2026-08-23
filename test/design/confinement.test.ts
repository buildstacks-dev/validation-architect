import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// No provider is ever reached from this suite: both SDK modules are mocked
// before the provider port loads.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("@openai/codex-sdk", () => ({ Codex: vi.fn() }));

import {
  buildDesignerQueryOptions,
  buildReadOnlyQueryOptions,
  buildStakeholderThreadOptions,
  evaluateDesignerToolUse,
  evaluateReadOnlyToolUse,
} from "../../src/design/provider-port.js";

const workspace = mkdtempSync(join(tmpdir(), "va-design-confinement-"));
mkdirSync(join(workspace, "validation-design"), { recursive: true });
mkdirSync(join(workspace, "docs"), { recursive: true });
writeFileSync(join(workspace, "docs", "PRODUCT.md"), "# Product\n");
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

describe("designer seat confinement policy (pure)", () => {
  it("allows an ordinary in-workspace read", () => {
    const decision = evaluateDesignerToolUse(workspace, "Read", { file_path: join(workspace, "docs", "PRODUCT.md") });
    expect(decision.allow).toBe(true);
  });

  it("denies a read outside the workspace", () => {
    for (const attempt of ["/etc/passwd", join(workspace, "..", "outside.txt"), "../outside.txt", "~/secrets"]) {
      const decision = evaluateDesignerToolUse(workspace, "Read", { file_path: attempt });
      expect(decision.allow, attempt).toBe(false);
    }
  });

  it("denies writes beneath validation-design because artifacts return as data", () => {
    const decision = evaluateDesignerToolUse(workspace, "Write", {
      file_path: join(workspace, "validation-design", "model", "families.yaml"),
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("structured output");
  });

  it("denies a write outside validation-design/", () => {
    for (const attempt of [
      join(workspace, "docs", "PRODUCT.md"),
      join(workspace, "README.md"),
      "/tmp/escape.txt",
      "validation-design/../README.md",
    ]) {
      const decision = evaluateDesignerToolUse(workspace, "Write", { file_path: attempt });
      expect(decision.allow, attempt).toBe(false);
    }
  });

  it("denies a symlinked validation-design write target that escapes the workspace", () => {
    const escape = mkdtempSync(join(tmpdir(), "va-design-escape-"));
    try {
      symlinkSync(escape, join(workspace, "validation-design", "out"));
      const decision = evaluateDesignerToolUse(workspace, "Write", {
        file_path: join(workspace, "validation-design", "out"),
      });
      expect(decision.allow).toBe(false);
      const nested = evaluateDesignerToolUse(workspace, "Write", {
        file_path: join(workspace, "validation-design", "out", "x.yaml"),
      });
      expect(nested.allow).toBe(false);
    } finally {
      rmSync(join(workspace, "validation-design", "out"), { force: true });
      rmSync(escape, { recursive: true, force: true });
    }
  });

  it("denies Bash fail-closed, even for harmless-looking commands", () => {
    for (const command of ["ls", "cat docs/PRODUCT.md", "echo hi"]) {
      const decision = evaluateDesignerToolUse(workspace, "Bash", { command });
      expect(decision.allow, command).toBe(false);
      expect(decision.reason).toMatch(/fail-closed/);
    }
  });

  it("denies unknown and escape tools", () => {
    for (const tool of ["WebFetch", "Agent", "NotebookEdit", "Computer", "SomethingNew"]) {
      expect(evaluateDesignerToolUse(workspace, tool, {}).allow, tool).toBe(false);
    }
  });

  it("confines Grep/Glob paths and patterns", () => {
    expect(evaluateDesignerToolUse(workspace, "Glob", { pattern: "**/*.yaml" }).allow).toBe(true);
    expect(evaluateDesignerToolUse(workspace, "Glob", { pattern: "/etc/**" }).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Glob", { pattern: "../**" }).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Grep", { path: "/etc" }).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Grep", { path: workspace, glob: "*.md" }).allow).toBe(true);
  });
});

describe("read-only seat policy (auditor/reader)", () => {
  it("allows confined reads and searches only", () => {
    expect(evaluateReadOnlyToolUse(workspace, "Read", { file_path: join(workspace, "docs", "PRODUCT.md") }).allow).toBe(true);
    expect(evaluateReadOnlyToolUse(workspace, "Read", { file_path: "/etc/passwd" }).allow).toBe(false);
    expect(evaluateReadOnlyToolUse(workspace, "Write", { file_path: join(workspace, "validation-design", "x") }).allow).toBe(false);
    expect(evaluateReadOnlyToolUse(workspace, "Edit", { file_path: join(workspace, "validation-design", "x") }).allow).toBe(false);
    expect(evaluateReadOnlyToolUse(workspace, "Bash", { command: "ls" }).allow).toBe(false);
  });
});

describe("SDK option building wires the same policy into hook and canUseTool", () => {
  it("PreToolUse hook denies both an out-of-workspace read and a target write", async () => {
    const options = buildDesignerQueryOptions({ workspace });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    expect(hook).toBeTypeOf("function");
    const denied = (await hook!(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/etc/passwd" } } as never,
      undefined,
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    const write = (await hook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(workspace, "validation-design", "notes.md") },
      } as never,
      undefined,
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(write.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("canUseTool applies the identical decision, deny fail-closed for Bash", async () => {
    const options = buildDesignerQueryOptions({ workspace });
    expect(options.canUseTool).toBeTypeOf("function");
    const context = {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
      requestId: "req-1",
    };
    const bash = await options.canUseTool!("Bash", { command: "ls" }, context);
    expect(bash?.behavior).toBe("deny");
    const write = await options.canUseTool!(
      "Write",
      { file_path: join(workspace, "validation-design", "notes.md") },
      { ...context, toolUseID: "tool-2", requestId: "req-2" },
    );
    expect(write?.behavior).toBe("deny");
  });

  it("designer options carry the sandbox, tool allowlist, and no Bash", () => {
    const options = buildDesignerQueryOptions({ workspace });
    expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(options.disallowedTools).toContain("Bash");
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write"]));
    const sandbox = options.sandbox as {
      enabled: boolean;
      network: { allowedDomains: string[] };
      filesystem: { denyWrite: string[]; allowWrite: string[] };
    };
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.network.allowedDomains).toEqual([]);
    expect(sandbox.filesystem.denyWrite).toContain("/");
    expect(sandbox.filesystem.allowWrite).toEqual([]);
  });

  it("read-only options grant no write or edit tool and honor model overrides", () => {
    const options = buildReadOnlyQueryOptions({ workspace, models: { auditor: "model-a" } }, "auditor");
    expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(options.model).toBe("model-a");
    expect(options.resume).toBeUndefined();
  });

  it("stakeholder thread options are read-only, offline, approval-never", () => {
    const options = buildStakeholderThreadOptions({ workspace, models: { stakeholder: "model-s" } });
    expect(options).toMatchObject({
      model: "model-s",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });
  });
});
