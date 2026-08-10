import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { AgentTurn, DesignerAgent, TurnUsage } from "./types.js";

export interface ClaudeDesignerOptions {
  workspace: string;
  model: string;
  /** "subscription" strips ANTHROPIC_API_KEY so CLI login auth is used. */
  authMode: "subscription" | "api-key";
  maxTurnsPerSend: number;
  resumeSessionId?: string | undefined;
}

/** The designer needs file inspection and corpus authoring, not code execution. */
export const DESIGNER_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write"] as const;

/** Explicit defense in depth in addition to the SDK's base-tool allowlist. */
export const DESIGNER_ESCAPE_TOOLS = [
  "Bash",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "Workflow",
  "NotebookEdit",
  "Computer",
  "EnterWorktree",
  "ExitWorktree",
] as const;

export interface DesignerToolDecision {
  allow: boolean;
  reason: string;
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve through every existing symlink ancestor. This prevents a path that
 * looks workspace-local (for example validation-design/out -> /tmp/out) from
 * bypassing the lexical boundary. Nonexistent suffixes are safe because the
 * designer has no tool capable of creating symlinks or racing the write.
 */
function pathWithin(root: string, cwd: string, requested: string, rejectFinalSymlink: boolean): boolean {
  if (!requested || requested.includes("\0") || /^~(?:[\\/]|$)/.test(requested)) {
    return false;
  }
  const lexical = resolve(cwd, requested);

  let ancestor = lexical;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
  if (rejectFinalSymlink && ancestor === lexical && lstatSync(ancestor).isSymbolicLink()) return false;
  const canonical = resolve(realpathSync.native(ancestor), relative(ancestor, lexical));
  return containedBy(root, canonical);
}

function safeGlobPattern(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    /(?:^|[,\{])\s*(?:\/|~\/|[A-Za-z]:\/)/.test(normalized)
  ) {
    return false;
  }
  return !normalized.split("/").includes("..");
}

/**
 * Pure, unit-testable authorization policy for every model-emitted tool call.
 * The SDK's PreToolUse hook invokes this even when a tool was auto-allowed;
 * canUseTool applies the same policy to any permission request path.
 */
export function evaluateDesignerToolUse(
  workspace: string,
  toolName: string,
  input: Record<string, unknown>,
): DesignerToolDecision {
  const workspaceRoot = realpathSync.native(workspace);
  const artifactRoot = realpathSync.native(join(workspaceRoot, "validation-design"));
  const deny = (reason: string): DesignerToolDecision => ({ allow: false, reason });
  const allow = (reason: string): DesignerToolDecision => ({ allow: true, reason });

  if (toolName === "Read") {
    const file = input["file_path"];
    if (typeof file !== "string" || !pathWithin(workspaceRoot, workspaceRoot, file, false)) {
      return deny("Read is limited to files inside the campaign workspace.");
    }
    return allow("Workspace read allowed.");
  }

  if (toolName === "Grep" || toolName === "Glob") {
    const requested = input["path"];
    if (
      requested !== undefined &&
      (typeof requested !== "string" || !pathWithin(workspaceRoot, workspaceRoot, requested, false))
    ) {
      return deny(`${toolName} is limited to paths inside the campaign workspace.`);
    }
    if (toolName === "Glob" && !safeGlobPattern(input["pattern"])) {
      return deny("Glob patterns may not be absolute or traverse outside the workspace.");
    }
    if (toolName === "Grep" && !safeGlobPattern(input["glob"])) {
      return deny("Grep file filters may not be absolute or traverse outside the workspace.");
    }
    return allow("Workspace search allowed.");
  }

  if (toolName === "Edit" || toolName === "Write") {
    const file = input["file_path"];
    if (typeof file !== "string" || !pathWithin(artifactRoot, workspaceRoot, file, true)) {
      return deny(`${toolName} is limited to regular paths beneath validation-design/.`);
    }
    return allow("Validation-design artifact write allowed.");
  }

  return deny(`Tool ${toolName} is not available to the design campaign.`);
}

/** Read-only counterpart used by independent readers and auditors. */
export function evaluateReadOnlyToolUse(
  workspace: string,
  readRoot: string,
  toolName: string,
  input: Record<string, unknown>,
): DesignerToolDecision {
  const workspaceRoot = realpathSync.native(workspace);
  const allowedRoot = realpathSync.native(readRoot);
  if (!containedBy(workspaceRoot, allowedRoot)) {
    return { allow: false, reason: "Read-only root is outside the campaign workspace." };
  }
  if (toolName === "Read") {
    const file = input["file_path"];
    return typeof file === "string" && pathWithin(allowedRoot, workspaceRoot, file, false)
      ? { allow: true, reason: "Confined read allowed." }
      : { allow: false, reason: "Read is outside the permitted read-only root." };
  }
  if (toolName === "Grep" || toolName === "Glob") {
    const requested = input["path"];
    const pathAllowed = requested === undefined
      ? allowedRoot === workspaceRoot
      : typeof requested === "string" && pathWithin(allowedRoot, workspaceRoot, requested, false);
    const patternAllowed = toolName === "Glob"
      ? safeGlobPattern(input["pattern"])
      : safeGlobPattern(input["glob"]);
    return pathAllowed && patternAllowed
      ? { allow: true, reason: "Confined search allowed." }
      : { allow: false, reason: `${toolName} is outside the permitted read-only root.` };
  }
  return { allow: false, reason: `Tool ${toolName} is unavailable in a read-only session.` };
}

function policyHook(
  decide: (toolName: string, input: Record<string, unknown>) => DesignerToolDecision,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: false, stopReason: "Unexpected hook event in designer tool policy." };
    }
    const toolInput =
      input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
        ? input.tool_input as Record<string, unknown>
        : {};
    const decision = decide(input.tool_name, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.allow ? "allow" : "deny",
        permissionDecisionReason: decision.reason,
      },
    };
  };
}

/**
 * Build the locked-down SDK options separately from send() so containment is
 * covered by the offline suite without starting a provider session.
 */
export function buildClaudeDesignerQueryOptions(
  opts: ClaudeDesignerOptions,
  env: Record<string, string>,
  session?: string,
): Options {
  const workspace = realpathSync.native(opts.workspace);
  const artifactRoot = realpathSync.native(join(workspace, "validation-design"));
  const filesystemRoot = parse(workspace).root;
  const decide = (toolName: string, input: Record<string, unknown>) =>
    evaluateDesignerToolUse(workspace, toolName, input);
  const hook = policyHook(decide);
  const sandbox = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [filesystemRoot],
      allowRead: [workspace],
      denyWrite: [filesystemRoot],
      allowWrite: [artifactRoot],
    },
  } satisfies NonNullable<Options["sandbox"]>;
  return {
    cwd: workspace,
    model: opts.model,
    permissionMode: "dontAsk",
    tools: [...DESIGNER_TOOLS],
    allowedTools: [...DESIGNER_TOOLS],
    disallowedTools: [...DESIGNER_ESCAPE_TOOLS],
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: [],
    skills: [],
    sandbox,
    settings: {
      permissions: {
        defaultMode: "dontAsk",
        disableBypassPermissionsMode: "disable",
        deny: [...DESIGNER_ESCAPE_TOOLS],
      },
      disableSkillShellExecution: true,
      disableBundledSkills: true,
      disableClaudeAiConnectors: true,
      includeGitInstructions: false,
      workflowKeywordTriggerEnabled: false,
    },
    managedSettings: {
      permissions: {
        defaultMode: "dontAsk",
        disableBypassPermissionsMode: "disable",
        deny: [...DESIGNER_ESCAPE_TOOLS],
      },
      sandbox,
      disableSkillShellExecution: true,
      disableBundledSkills: true,
      disableClaudeAiConnectors: true,
      includeGitInstructions: false,
      workflowKeywordTriggerEnabled: false,
      allowedMcpServers: [],
      allowManagedMcpServersOnly: true,
      disableSideloadFlags: true,
      strictPluginOnlyCustomization: ["hooks", "agents", "mcp"],
      allowManagedHooksOnly: true,
      allowedHttpHookUrls: [],
    },
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    canUseTool: async (toolName, input): Promise<PermissionResult> => {
      const decision = decide(toolName, input);
      return decision.allow
        ? { behavior: "allow", decisionClassification: "user_temporary" }
        : { behavior: "deny", message: decision.reason, decisionClassification: "user_reject" };
    },
    maxTurns: opts.maxTurnsPerSend,
    env,
    ...(session ? { resume: session } : {}),
  };
}

/** Locked-down SDK options for fresh reader/auditor sessions. */
export function buildClaudeReadOnlyQueryOptions(opts: {
  workspace: string;
  readRoot?: string | undefined;
  model: string;
  maxTurns: number;
  env: Record<string, string>;
}): Options {
  const workspace = realpathSync.native(opts.workspace);
  const readRoot = realpathSync.native(opts.readRoot ?? workspace);
  if (!containedBy(workspace, readRoot)) {
    throw new Error(`Read-only Claude root escapes workspace: ${readRoot}`);
  }
  const filesystemRoot = parse(workspace).root;
  const decide = (toolName: string, input: Record<string, unknown>) =>
    evaluateReadOnlyToolUse(workspace, readRoot, toolName, input);
  const hook = policyHook(decide);
  const disallowed = [...DESIGNER_ESCAPE_TOOLS, "Edit", "Write"];
  const sandbox = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [filesystemRoot],
      allowRead: [readRoot],
      denyWrite: [filesystemRoot],
      allowWrite: [],
    },
  } satisfies NonNullable<Options["sandbox"]>;
  return {
    cwd: workspace,
    model: opts.model,
    permissionMode: "dontAsk",
    tools: ["Read", "Grep", "Glob"],
    allowedTools: ["Read", "Grep", "Glob"],
    disallowedTools: disallowed,
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: [],
    skills: [],
    sandbox,
    settings: {
      permissions: {
        defaultMode: "dontAsk",
        disableBypassPermissionsMode: "disable",
        deny: disallowed,
      },
      disableSkillShellExecution: true,
      disableBundledSkills: true,
      disableClaudeAiConnectors: true,
      includeGitInstructions: false,
      workflowKeywordTriggerEnabled: false,
    },
    managedSettings: {
      permissions: {
        defaultMode: "dontAsk",
        disableBypassPermissionsMode: "disable",
        deny: disallowed,
      },
      sandbox,
      disableSkillShellExecution: true,
      disableBundledSkills: true,
      disableClaudeAiConnectors: true,
      allowedMcpServers: [],
      allowManagedMcpServersOnly: true,
      disableSideloadFlags: true,
      strictPluginOnlyCustomization: ["hooks", "agents", "mcp"],
      allowManagedHooksOnly: true,
      allowedHttpHookUrls: [],
    },
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    canUseTool: async (toolName, input): Promise<PermissionResult> => {
      const decision = decide(toolName, input);
      return decision.allow
        ? { behavior: "allow", decisionClassification: "user_temporary" }
        : { behavior: "deny", message: decision.reason, decisionClassification: "user_reject" };
    },
    maxTurns: opts.maxTurns,
    env: opts.env,
  };
}

/**
 * Persistent Claude designer session. Each send() is one SDK query resumed
 * onto the same session id, so the conversation survives process restarts —
 * the orchestrator persists the session id after every turn.
 */
export class ClaudeDesigner implements DesignerAgent {
  private session: string | undefined;
  private readonly env: Record<string, string>;

  constructor(private readonly opts: ClaudeDesignerOptions) {
    this.session = opts.resumeSessionId;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (opts.authMode === "subscription") {
      delete env["ANTHROPIC_API_KEY"];
    } else if (!env["ANTHROPIC_API_KEY"]) {
      throw new Error("designer authMode=api-key but ANTHROPIC_API_KEY is not set");
    }
    this.env = env;
  }

  sessionId(): string | undefined {
    return this.session;
  }

  async send(message: string): Promise<AgentTurn> {
    const q = query({
      prompt: message,
      options: buildClaudeDesignerQueryOptions(this.opts, this.env, this.session),
    });

    let resultText: string | undefined;
    let usage: TurnUsage | undefined;
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      if (msg["type"] === "system" && msg["subtype"] === "init") {
        const sid = msg["session_id"];
        if (typeof sid === "string") this.session = sid;
      }
      if (msg["type"] === "result") {
        const sid = msg["session_id"];
        if (typeof sid === "string") this.session = sid;
        const cost = msg["total_cost_usd"];
        const u = msg["usage"] as Record<string, unknown> | undefined;
        usage = {
          ...(typeof cost === "number" ? { costUsd: cost } : {}),
          ...(typeof u?.["input_tokens"] === "number" ? { inputTokens: u["input_tokens"] as number } : {}),
          ...(typeof u?.["output_tokens"] === "number" ? { outputTokens: u["output_tokens"] as number } : {}),
        };
        if (msg["subtype"] === "success" && typeof msg["result"] === "string") {
          resultText = msg["result"];
        } else if (msg["subtype"] !== "success") {
          throw new Error(`designer query ended without success: ${String(msg["subtype"])}`);
        }
      }
    }
    if (resultText === undefined) {
      throw new Error("designer query produced no result message");
    }
    return { text: resultText, ...(usage ? { usage } : {}) };
  }
}
