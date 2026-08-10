import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeDesignerQueryOptions,
  buildClaudeReadOnlyQueryOptions,
  DESIGNER_ESCAPE_TOOLS,
  DESIGNER_TOOLS,
  evaluateBashCommand,
  evaluateDesignerToolUse,
  evaluateReadOnlyToolUse,
} from "../src/designer.js";
import type { DesignerToolDenial } from "../src/designer.js";

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

  it("denies network, agent, and every unknown tool", () => {
    for (const tool of DESIGNER_ESCAPE_TOOLS) {
      expect(evaluateDesignerToolUse(workspace, tool, {}).allow, tool).toBe(false);
    }
    expect(evaluateDesignerToolUse(workspace, "mcp__remote__run", {}).allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Skill", { skill: "anything" }).allow).toBe(false);
  });
});

/**
 * Negative controls for issue #10 hazard 1: the smoke-run designer left its
 * workspace, ran `git checkout main` in the real product checkout, and created
 * research/ + tmp/ there. Each seeded escape below must go red, and ordinary
 * in-workspace work must stay green — a guard that denies everything would be
 * a different bug.
 */
describe("designer Bash confinement", () => {
  const bash = (command: string) => evaluateDesignerToolUse(workspace, "Bash", { command });

  it("denies the smoke incident: git checkout main against a path outside the workspace", () => {
    expect(bash(`cd ${outside} && git checkout main`).allow).toBe(false);
    expect(bash(`git -C ${outside} checkout main`).allow).toBe(false);
    expect(bash(`git --git-dir=${outside}/.git checkout main`).allow).toBe(false);
    expect(bash(`cd ${outside} && mkdir research tmp`).allow).toBe(false);
  });

  it("denies absolute and traversal paths outside the workspace", () => {
    expect(bash("touch /tmp/escape.txt").allow).toBe(false);
    expect(bash('cat "/etc/passwd"').allow).toBe(false);
    expect(bash("mkdir ../research").allow).toBe(false);
    expect(bash("cp docs/a.md ../../elsewhere.md").allow).toBe(false);
    expect(bash("echo hi > /tmp/out.txt").allow).toBe(false);
  });

  it("denies undeterminable destinations: variables, substitution, heredocs, escapes", () => {
    expect(bash("cd $HOME && ls").allow).toBe(false);
    expect(bash("ls ${TARGET_DIR}").allow).toBe(false);
    expect(bash("touch $(pwd)/../escape.txt").allow).toBe(false);
    expect(bash("rm -rf `git rev-parse --show-toplevel`").allow).toBe(false);
    expect(bash("cat <<EOF > out.md\nhello\nEOF").allow).toBe(false);
    expect(bash("ls ~/Documents").allow).toBe(false);
    expect(bash("touch \\/tmp\\/x").allow).toBe(false);
    expect(bash("(cd / && ls)").allow).toBe(false);
    expect(bash("sleep 100 &").allow).toBe(false);
  });

  it("denies cwd/env mutators, shell-in-shell, interpreters, and assignment prefixes", () => {
    expect(bash("cd validation-design").allow).toBe(false);
    expect(bash("export GIT_DIR=elsewhere").allow).toBe(false);
    expect(bash("HOME=/etc git status").allow).toBe(false);
    expect(bash("bash -c 'touch /tmp/x'").allow).toBe(false);
    expect(bash("node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'").allow).toBe(false);
    expect(bash("git status | xargs rm").allow).toBe(false);
    expect(bash("eval ls").allow).toBe(false);
  });

  it("denies writes through an in-workspace symlink that points outside", () => {
    expect(bash("echo escaped > validation-design/escape/exfil.md").allow).toBe(false);
    expect(bash("touch validation-design/escape/exfil.md").allow).toBe(false);
    expect(bash("cat docs/escape.txt").allow).toBe(false);
  });

  it("denies flags with embedded absolute paths and empty commands", () => {
    expect(bash("gcc -I/usr/include main.c").allow).toBe(false);
    expect(bash("git commit -m 'see /etc/passwd for details'").allow).toBe(false);
    expect(bash("").allow).toBe(false);
    expect(bash("   ").allow).toBe(false);
    expect(evaluateDesignerToolUse(workspace, "Bash", {}).allow).toBe(false);
    expect(bash("ls &&").allow).toBe(false);
    expect(bash("| sh").allow).toBe(false);
  });

  it("ALLOWS ordinary in-workspace work — the distinguishing control", () => {
    expect(bash("git status").allow).toBe(true);
    expect(bash("git log --oneline -5").allow).toBe(true);
    expect(bash("git checkout main").allow).toBe(true);
    expect(bash("ls validation-design").allow).toBe(true);
    expect(bash("mkdir -p validation-design/contracts").allow).toBe(true);
    expect(bash("wc -l validation-design/invariants.md docs/architecture.md").allow).toBe(true);
    expect(bash("git add validation-design && git commit -m 'add invariants'").allow).toBe(true);
    expect(bash("grep -rn INV- validation-design | head -20").allow).toBe(true);
    expect(bash("git diff HEAD~1 2>&1 | head").allow).toBe(true);
    expect(bash("git log --pretty=format:%H%x09%s -3 > validation-design/history.txt").allow).toBe(true);
  });

  it("evaluateBashCommand rejects non-string input fail-closed", () => {
    expect(evaluateBashCommand(workspace, undefined).allow).toBe(false);
    expect(evaluateBashCommand(workspace, 42).allow).toBe(false);
    expect(evaluateBashCommand(workspace, "git status\0rm -rf /").allow).toBe(false);
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
        allowRead: [canonicalWorkspace],
        // Deny beats allow on the sandbox write side (verified against SDK
        // 0.3.220), so the read-only workspace surfaces are pinned
        // individually instead of denying the filesystem root.
        denyWrite: expect.arrayContaining([
          join(canonicalWorkspace, "docs"),
          join(canonicalWorkspace, "target-source"),
          join(canonicalWorkspace, ".claude"),
          join(canonicalWorkspace, "rambling.txt"),
        ]),
        allowWrite: [join(canonicalWorkspace, "validation-design"), join(canonicalWorkspace, ".git")],
      },
      credentials: {
        envVars: expect.arrayContaining([
          { name: "ANTHROPIC_API_KEY", mode: "deny" },
          { name: "OPENAI_API_KEY", mode: "deny" },
        ]),
      },
    });
    // The user-data troves are read-denied for sandboxed commands; system
    // paths stay readable so allowed binaries can execute at all.
    const denyRead = (options.sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead;
    expect(denyRead.some((p) => p.endsWith("Users") || p.endsWith("home"))).toBe(true);
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

  it("records every denial with tool, attempted path, and reason — no silent guards", async () => {
    const denials: DesignerToolDenial[] = [];
    const options = buildClaudeDesignerQueryOptions(
      {
        workspace,
        model: "claude-test",
        authMode: "subscription",
        maxTurnsPerSend: 5,
        onDenial: (denial) => denials.push(denial),
      },
      { PATH: "/bin" },
    );

    const hook = options.hooks?.["PreToolUse"]?.[0]?.hooks[0];
    await hook!(
      {
        hook_event_name: "PreToolUse",
        session_id: "session",
        transcript_path: join(root, "session.jsonl"),
        cwd: workspace,
        tool_name: "Bash",
        tool_input: { command: "cd /real/product && git checkout main" },
        tool_use_id: "tool-1",
      },
      "tool-1",
      { signal: new AbortController().signal },
    );
    await options.canUseTool!(
      "Write",
      { file_path: "../../research/notes.md", content: "escape" },
      { signal: new AbortController().signal, toolUseID: "tool-2", requestId: "request-2" },
    );
    // In-policy calls must NOT be recorded as denials.
    await options.canUseTool!(
      "Read",
      { file_path: "docs/architecture.md" },
      { signal: new AbortController().signal, toolUseID: "tool-3", requestId: "request-3" },
    );

    expect(denials).toHaveLength(2);
    expect(denials[0]).toMatchObject({
      tool: "Bash",
      attempted: "cd /real/product && git checkout main",
    });
    expect(denials[0]!.reason).toContain("denied fail-closed");
    expect(denials[1]).toMatchObject({ tool: "Write", attempted: "../../research/notes.md" });
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
