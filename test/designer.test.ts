import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeDesignerQueryOptions,
  buildClaudeReadOnlyQueryOptions,
  DESIGNER_ESCAPE_TOOLS,
  DESIGNER_TOOLS,
  evaluateDesignerToolUse,
  evaluateReadOnlyToolUse,
} from "../src/designer.js";

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vda-designer-policy-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(join(workspace, "docs"), { recursive: true });
  mkdirSync(join(workspace, "validation-design"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, "docs", "architecture.md"), "# Architecture\n");
  writeFileSync(join(outside, "secret.txt"), "outside\n");
  symlinkSync(join(outside, "secret.txt"), join(workspace, "docs", "escape.txt"));
  symlinkSync(outside, join(workspace, "validation-design", "escape"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Claude designer tool policy", () => {
  it("allows workspace reads but rejects traversal, absolute escapes, and symlink escapes", () => {
    expect(evaluateDesignerToolUse(workspace, "Read", { file_path: "docs/architecture.md" }).allow).toBe(true);
    expect(evaluateDesignerToolUse(workspace, "Read", { file_path: join(outside, "secret.txt") }).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Read", { file_path: "../outside/secret.txt" }).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Read", { file_path: "docs/escape.txt" }).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Glob", { path: "../outside", pattern: "**/*" }).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Glob", { pattern: "../../**/*" }).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Grep", { path: "docs", glob: "{/etc/**,*.md}" }).allow).toBe(false);
  });

  it("allows new artifact paths but rejects every write outside validation-design or through symlinks", () => {
    expect(
      evaluateDesignerToolUse(workspace, "Write", {
        file_path: "validation-design/contracts/payment.md",
      }).allow,
    ).toBe(true);
    expect(
      evaluateDesignerToolUse(workspace, "Edit", {
        file_path: join(workspace, "validation-design", "invariants.md"),
      }).allow,
    ).toBe(true);
    expect(evaluateDesignerToolUse(workspace, "Write", { file_path: "docs/rewrite.md" }).allow).toBe(false);
    expect(
      evaluateDesignerToolUse(workspace, "Write", {
        file_path: "validation-design/escape/exfiltrated.md",
      }).allow,
    ).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Edit", { file_path: "../outside/secret.txt" }).allow).toBe(false);
  });

  it("denies shell, network, agent, and every unknown tool", () => {
    for (const tool of DESIGNER_ESCAPE_TOOLS) {
      expect(evaluateDesignerToolUse(workspace, tool, {}).allow, tool).toBe(false);
    }
    expect(evaluateDesignerToolUse(workspace, "mcp__remote__run", {}).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Skill", { skill: "anything" }).allow).toBe(false);
  });
});

describe("Claude designer SDK options", () => {
  it("constructs a fail-closed, filesystem-scoped session without bypass permissions", async () => {
    const options = buildClaudeDesignerQueryOptions(
      {
        workspace,
        model: "claude-test",
        authMode: "subscription",
        maxTurnsPerSend: 17,
      },
      { PATH: "/bin" },
      "resume-id",
    );

    expect(options.permissionMode).toBe("dontAsk");
    expect("allowDangerouslySkipPermissions" in options).toBe(false);
    expect(options.tools).toEqual([...DESIGNER_TOOLS]);
    expect(options.allowedTools).toEqual([...DESIGNER_TOOLS]);
    expect(options.disallowedTools).toEqual(expect.arrayContaining([...DESIGNER_ESCAPE_TOOLS]));
    expect(options.settingSources).toEqual([]);
    expect(options.skills).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    expect(options.resume).toBe("resume-id");
    const canonicalWorkspace = options.cwd as string;
    expect(options.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false },
      filesystem: {
        denyRead: [parse(canonicalWorkspace).root],
        allowRead: [canonicalWorkspace],
        denyWrite: [parse(canonicalWorkspace).root],
        allowWrite: [join(canonicalWorkspace, "validation-design")],
      },
    });
    expect(options.settings).toMatchObject({
      permissions: { defaultMode: "dontAsk", disableBypassPermissionsMode: "disable" },
      disableSkillShellExecution: true,
      disableBundledSkills: true,
      disableClaudeAiConnectors: true,
    });
    expect(options.managedSettings).toMatchObject({
      permissions: { defaultMode: "dontAsk", disableBypassPermissionsMode: "disable" },
      allowedMcpServers: [],
      allowManagedMcpServersOnly: true,
      disableSideloadFlags: true,
      allowManagedHooksOnly: true,
      allowedHttpHookUrls: [],
    });

    const hook = options.hooks?.["PreToolUse"]?.[0]?.hooks[0];
    expect(hook).toBeDefined();
    const hookResult = await hook!(
      {
        hook_event_name: "PreToolUse",
        session_id: "session",
        transcript_path: join(root, "session.jsonl"),
        cwd: workspace,
        tool_name: "Write",
        tool_input: { file_path: "docs/not-allowed.md" },
        tool_use_id: "tool-1",
      },
      "tool-1",
      { signal: new AbortController().signal },
    );
    expect(hookResult).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });

    const permission = await options.canUseTool!(
      "WebFetch",
      { url: "https://example.com" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-2",
        requestId: "request-2",
      },
    );
    expect(permission).toMatchObject({ behavior: "deny" });
  });

  it("confines independent readers to their declared root and exposes no write/escape tools", () => {
    const corpus = join(workspace, "validation-design");
    const options = buildClaudeReadOnlyQueryOptions({
      workspace,
      readRoot: corpus,
      model: "claude-test",
      maxTurns: 20,
      env: { PATH: "/bin" },
    });
    expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "WebFetch", "Agent", "Edit", "Write"]));
    expect(options.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
    expect(
      evaluateReadOnlyToolUse(workspace, corpus, "Read", {
        file_path: "validation-design/invariants.md",
      }).allow,
    ).toBe(true);
    expect(
      evaluateReadOnlyToolUse(workspace, corpus, "Read", {
        file_path: "docs/architecture.md",
      }).allow,
    ).toBe(false);
    expect(evaluateReadOnlyToolUse(workspace, corpus, "Grep", { pattern: "INV" }).allow).toBe(false);
    expect(
      evaluateReadOnlyToolUse(workspace, corpus, "Grep", {
        pattern: "INV",
        path: "validation-design",
      }).allow,
    ).toBe(true);
    expect(evaluateReadOnlyToolUse(workspace, corpus, "Write", { file_path: "validation-design/x" }).allow).toBe(false);
  });
});
