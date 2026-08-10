import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { AgentTurn, DesignerAgent, TurnUsage } from "./types.js";

/** One recorded refusal of a model-emitted tool call. */
export interface DesignerToolDenial {
  tool: string;
  /** The path or command the model attempted, when the input carried one. */
  attempted?: string | undefined;
  reason: string;
}

export interface ClaudeDesignerOptions {
  workspace: string;
  model: string;
  /** "subscription" strips ANTHROPIC_API_KEY so CLI login auth is used. */
  authMode: "subscription" | "api-key";
  maxTurnsPerSend: number;
  resumeSessionId?: string | undefined;
  /**
   * Invoked for every denied tool call so the refusal lands in the run
   * transcript. A silent denial is an invisible guard; the orchestrator wires
   * this to transcript notes.
   */
  onDenial?: ((denial: DesignerToolDenial) => void) | undefined;
}

/**
 * The designer needs file inspection, corpus authoring, and enough shell for
 * git-minded skill steps. Bash is NOT free rein: every command is statically
 * confined to the workspace by evaluateBashCommand, fail-closed.
 */
export const DESIGNER_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"] as const;

/** Explicit defense in depth in addition to the SDK's base-tool allowlist. */
export const DESIGNER_ESCAPE_TOOLS = [
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
 * Commands whose effects cannot be bound to the path arguments we can see:
 * cwd/environment mutators, defer-evaluation builtins, shells and interpreters
 * (which can smuggle absolute paths inside code strings), package runners, and
 * privilege/detach wrappers. The OS sandbox is the second layer behind this
 * list; the static layer refuses what it cannot prove.
 */
const BASH_DENIED_COMMANDS = new Set([
  "cd", "pushd", "popd",
  "eval", "exec", "source", ".", "command", "builtin",
  "env", "export", "unset", "set", "shopt", "alias", "unalias", "trap", "ulimit", "umask",
  "sudo", "su", "doas", "nohup", "setsid", "chroot", "xargs",
  "time", "timeout", "nice", "stdbuf", "watch",
  "sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish", "script", "expect", "screen", "tmux",
  "node", "deno", "bun", "python", "python3", "perl", "ruby", "php",
  "npx", "bunx", "npm", "pnpm", "yarn", "make",
]);

interface BashToken {
  text: string;
  redirectTarget: boolean;
}

type BashScan = { ok: true; commands: BashToken[][] } | { ok: false; reason: string };

/**
 * Conservative shell scanner: understands quoting, pipes/&&/||/;, comments,
 * and fd-safe redirections, and refuses everything it cannot model —
 * expansion ($, backticks), heredocs, subshells, grouping, backslash escapes,
 * background &, tilde words. Refusal, not best-effort parsing, is the point:
 * an undeterminable destination is an escape until proven otherwise.
 */
function scanBashCommand(raw: string): BashScan {
  const commands: BashToken[][] = [];
  let current: BashToken[] = [];
  let text = "";
  let active = false;
  let redirectNext = false;
  let pendingHard: "&&" | "||" | "|" | null = null;
  const deny = (reason: string): BashScan => ({ ok: false, reason });

  const flushToken = (): void => {
    if (!active) return;
    current.push({ text, redirectTarget: redirectNext });
    redirectNext = false;
    text = "";
    active = false;
  };
  /** Returns an error string, or null. `hard` separators require both sides. */
  const endCommand = (op: "&&" | "||" | "|" | ";" | "\n"): string | null => {
    flushToken();
    if (redirectNext) return "redirection without a target";
    if (current.length === 0) {
      if (op === "&&" || op === "||" || op === "|") return `empty command before ${op}`;
      if (op === ";" && pendingHard) return `empty command after ${pendingHard}`;
      return null;
    }
    commands.push(current);
    current = [];
    pendingHard = op === "&&" || op === "||" || op === "|" ? op : null;
    return null;
  };

  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i]!;
    if (c === "\0") return deny("NUL byte");
    if (c === "'") {
      const close = raw.indexOf("'", i + 1);
      if (close === -1) return deny("unterminated single quote");
      text += raw.slice(i + 1, close);
      active = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) return deny("unterminated double quote");
        const d = raw[j]!;
        if (d === '"') break;
        if (d === "$" || d === "`" || d === "\\") return deny("expansion inside double quotes");
        text += d;
        j++;
      }
      active = true;
      i = j + 1;
      continue;
    }
    if (c === " " || c === "\t") {
      flushToken();
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      const err = endCommand("\n");
      if (err) return deny(err);
      i++;
      continue;
    }
    if (c === ";") {
      const err = endCommand(";");
      if (err) return deny(err);
      i++;
      continue;
    }
    if (c === "&") {
      if (raw[i + 1] === "&") {
        const err = endCommand("&&");
        if (err) return deny(err);
        i += 2;
        continue;
      }
      return deny("background execution or &-redirection");
    }
    if (c === "|") {
      const op = raw[i + 1] === "|" ? "||" : "|";
      const err = endCommand(op);
      if (err) return deny(err);
      i += op.length;
      continue;
    }
    if (c === ">" || c === "<") {
      // A purely numeric unquoted token directly before the operator is an fd
      // prefix (2>, 1>), not an argument.
      if (active && /^[0-9]+$/.test(text)) {
        text = "";
        active = false;
      } else {
        flushToken();
      }
      if (c === "<") {
        if (raw[i + 1] === "<") return deny("heredoc or herestring");
        redirectNext = true;
        i++;
        continue;
      }
      let j = i + 1;
      if (raw[j] === ">") j++;
      if (raw[j] === "&") {
        // fd duplication (2>&1, >&2, >&-): no filesystem destination.
        let k = j + 1;
        if (raw[k] === "-") {
          k++;
        } else {
          if (!/[0-9]/.test(raw[k] ?? "")) return deny("redirection to an &-target");
          while (/[0-9]/.test(raw[k] ?? "")) k++;
        }
        i = k;
        continue;
      }
      redirectNext = true;
      i = j;
      continue;
    }
    if (c === "$") return deny("variable expansion or command substitution");
    if (c === "`") return deny("backtick command substitution");
    if (c === "\\") return deny("backslash escape");
    if (c === "(" || c === ")") return deny("subshell or process substitution");
    if (c === "{" || c === "}") return deny("brace expansion or command grouping");
    if (c === "~" && !active) return deny("tilde expansion");
    if (c === "#" && !active) {
      while (i < n && raw[i] !== "\n") i++;
      continue;
    }
    text += c;
    active = true;
    i++;
  }
  flushToken();
  if (redirectNext) return { ok: false, reason: "redirection without a target" };
  if (current.length > 0) {
    commands.push(current);
  } else if (pendingHard) {
    return { ok: false, reason: `empty command after ${pendingHard}` };
  }
  if (commands.length === 0) return { ok: false, reason: "empty command" };
  return { ok: true, commands };
}

function hasDotDotSegment(value: string): boolean {
  return value.split("/").some((segment) => segment === "..");
}

/** Returns a problem description when a token's effect could leave the workspace. */
function analyzeBashToken(workspaceRoot: string, token: BashToken): string | null {
  const value = token.text;
  if (value.length === 0) return token.redirectTarget ? "empty redirection target" : null;
  if (token.redirectTarget && value.startsWith("-")) return `redirection target '${value}'`;
  // Split at '=' so --flag=path and VAR=path shapes expose their path part.
  for (const part of value.split("=")) {
    if (part.length === 0) continue;
    if (part.startsWith("~")) return `tilde path '${part}'`;
    if (hasDotDotSegment(part)) return `path traversal in '${value}'`;
    if (part.startsWith("/")) {
      if (!pathWithin(workspaceRoot, workspaceRoot, part, false)) {
        return `absolute path outside the workspace: '${part}'`;
      }
      continue;
    }
    if (part.includes("/")) {
      if (part.startsWith("-")) return `flag with embedded path: '${part}'`;
      if (/\s/.test(part)) {
        // Quoted prose (a commit message, a grep pattern). Its words are not
        // opened as paths by the shell, but refuse escaping-looking ones.
        for (const word of part.split(/\s+/)) {
          if (word.startsWith("/") || word.startsWith("~") || hasDotDotSegment(word)) {
            return `escaping path in quoted text: '${word}'`;
          }
        }
        continue;
      }
      if (!pathWithin(workspaceRoot, workspaceRoot, part, false)) {
        return `path resolves outside the workspace: '${part}'`;
      }
      continue;
    }
    // No slash: an existing bare name could still be a symlink out.
    if (!part.startsWith("-") && !pathWithin(workspaceRoot, workspaceRoot, part, false)) {
      return `name resolves outside the workspace: '${part}'`;
    }
  }
  return null;
}

/**
 * Static workspace confinement for one Bash command string. Where a
 * destination cannot be determined, DENY: availability damage is recoverable,
 * an escaped write into a real checkout is not. The OS sandbox (read/write
 * scoped, no network) backstops what static analysis cannot see, e.g. paths
 * synthesized at runtime by an allowed binary.
 */
export function evaluateBashCommand(workspaceRoot: string, command: unknown): DesignerToolDecision {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { allow: false, reason: "Bash requires a non-empty command string." };
  }
  const scan = scanBashCommand(command);
  if (!scan.ok) {
    return {
      allow: false,
      reason: `Bash command is not statically confinable to the workspace (${scan.reason}); denied fail-closed.`,
    };
  }
  for (const tokens of scan.commands) {
    const words = tokens.filter((t) => !t.redirectTarget);
    if (words.length === 0) {
      return { allow: false, reason: "Bash command consisting only of redirections; denied fail-closed." };
    }
    const name = words[0]!.text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) {
      return { allow: false, reason: `Bash environment assignments ('${name}') are not permitted.` };
    }
    if (BASH_DENIED_COMMANDS.has(name)) {
      return {
        allow: false,
        reason: `Bash command '${name}' can change directory, environment, or defer evaluation; denied fail-closed.`,
      };
    }
    for (const token of tokens) {
      const problem = analyzeBashToken(workspaceRoot, token);
      if (problem) {
        return { allow: false, reason: `Bash argument escapes the workspace (${problem}).` };
      }
    }
  }
  return { allow: true, reason: "Bash command confined to the workspace." };
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

  if (toolName === "Bash") {
    return evaluateBashCommand(workspaceRoot, input["command"]);
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
  const decide = (toolName: string, input: Record<string, unknown>): DesignerToolDecision => {
    const decision = evaluateDesignerToolUse(workspace, toolName, input);
    if (!decision.allow && opts.onDenial) {
      const attempted = ["file_path", "path", "command", "pattern", "glob"]
        .map((key) => input[key])
        .find((value): value is string => typeof value === "string");
      try {
        opts.onDenial({ tool: toolName, attempted, reason: decision.reason });
      } catch {
        // Recording must never turn a denial into a crash.
      }
    }
    return decision;
  };
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
      // Reads: denying the filesystem root would stop sandboxed commands from
      // even resolving toolchains (macOS's git shim reads /var/select). Deny
      // the user-data troves wholesale and re-allow the workspace; system
      // paths stay readable so allowed binaries can run. Static policy still
      // denies every visible out-of-workspace path before execution.
      denyRead: [
        join(filesystemRoot, "Users"),
        join(filesystemRoot, "home"),
        join(filesystemRoot, "root"),
        join(filesystemRoot, "var", "root"),
        join(filesystemRoot, "Volumes"),
      ],
      allowRead: [workspace],
      // Writes: deny beats allow on the write side (verified against SDK
      // 0.3.220), so a blanket denyWrite would also kill the artifact root.
      // The sandbox denies writes outside allowWrite by default; the explicit
      // denials pin the workspace surfaces the designer must treat as
      // read-only evidence even though they sit inside its cwd.
      denyWrite: [
        join(workspace, "docs"),
        join(workspace, "target-source"),
        join(workspace, ".claude"),
        join(workspace, "rambling.txt"),
        join(workspace, "TARGET-SNAPSHOT.md"),
        join(workspace, "TARGET-DIFF.md"),
        join(workspace, "TARGET-DIFF.patch"),
      ],
      allowWrite: [artifactRoot, join(workspace, ".git")],
    },
    credentials: {
      // The orchestrator's own provider credentials never reach sandboxed
      // designer commands (printenv would otherwise land them in context).
      envVars: [
        { name: "ANTHROPIC_API_KEY", mode: "deny" },
        { name: "OPENAI_API_KEY", mode: "deny" },
      ],
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
  const disallowed = [...DESIGNER_ESCAPE_TOOLS, "Bash", "Edit", "Write"];
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
