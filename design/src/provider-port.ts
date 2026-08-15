/**
 * The ONE concrete TurnPort of the design package: logical seats map to SDK
 * calls. Designer turns run in a persistent Claude Agent SDK session under
 * the same confinement enforcement pattern as the core's campaign host
 * (PreToolUse hook + canUseTool + OS sandbox: reads confined to the
 * workspace, writes only beneath validation-design/, Bash denied
 * fail-closed). The stakeholder is a persistent Codex thread resumed by its
 * exact native thread id; auditors and readers are fresh read-only Claude
 * sessions. Importing this module performs no SDK call; the class takes a
 * config object and the option-building is pure so the hook callbacks are
 * unit-testable offline. The port NEVER retries: a provider failure is the
 * typed "error" turn result and the engine decides what a failed run means.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { Codex, type Thread } from "@openai/codex-sdk";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecutionIdentity, TurnPort, TurnRequest, TurnResult, TurnUsageReport } from "validation-architect";

// ── configuration ────────────────────────────────────────────────────────────

export interface LocalTurnPortModels {
  designer?: string;
  stakeholder?: string;
  auditor?: string;
  reader?: string;
}

export interface LocalTurnPortConfig {
  /** Campaign workspace root: the target checkout the seats may read. */
  workspace: string;
  /** Model overrides per seat; defaults below. */
  models?: LocalTurnPortModels;
  /** Claude turn ceiling per send (tool-use steps, not campaign turns). */
  maxTurnsPerSend?: number;
}

export const DEFAULT_MODELS: Required<LocalTurnPortModels> = {
  designer: "claude-fable-5",
  stakeholder: "gpt-5.6-sol",
  auditor: "claude-fable-5",
  reader: "claude-sonnet-5",
};

export function modelForSeat(seat: TurnRequest["seat"]["seat"], models: LocalTurnPortModels = {}): string {
  return models[seat] ?? DEFAULT_MODELS[seat];
}

// ── confinement policy (pure, unit-testable offline) ─────────────────────────

export interface ToolDecision {
  allow: boolean;
  reason: string;
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve through every existing symlink ancestor so a workspace-local-looking
 * path (validation-design/out -> /tmp/out) cannot bypass the lexical boundary.
 */
function pathWithin(root: string, cwd: string, requested: string, rejectFinalSymlink: boolean): boolean {
  if (!requested || requested.includes("\0") || /^~(?:[\\/]|$)/.test(requested)) return false;
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
    /(?:^|[,{])\s*(?:\/|~\/|[A-Za-z]:\/)/.test(normalized)
  ) {
    return false;
  }
  return !normalized.split("/").includes("..");
}

/**
 * Designer-seat policy: reads and searches confined to the workspace, writes
 * only beneath validation-design/, Bash denied fail-closed (this adapter
 * grants the designer no shell at all), every other tool denied.
 */
export function evaluateDesignerToolUse(
  workspace: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolDecision {
  const workspaceRoot = realpathSync.native(workspace);
  const artifactRoot = join(workspaceRoot, "validation-design");
  const deny = (reason: string): ToolDecision => ({ allow: false, reason });
  const allow = (reason: string): ToolDecision => ({ allow: true, reason });

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
    const pattern = toolName === "Glob" ? input["pattern"] : input["glob"];
    if (!safeGlobPattern(pattern)) {
      return deny(`${toolName} patterns may not be absolute or traverse outside the workspace.`);
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
    return deny("Bash is denied fail-closed in the design adapter; the designer works through Read/Grep/Glob/Edit/Write only.");
  }

  return deny(`Tool ${toolName} is not available to the design campaign.`);
}

/** Read-only policy for fresh auditor/reader seats. */
export function evaluateReadOnlyToolUse(
  workspace: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolDecision {
  const workspaceRoot = realpathSync.native(workspace);
  if (toolName === "Read") {
    const file = input["file_path"];
    return typeof file === "string" && pathWithin(workspaceRoot, workspaceRoot, file, false)
      ? { allow: true, reason: "Confined read allowed." }
      : { allow: false, reason: "Read is outside the campaign workspace." };
  }
  if (toolName === "Grep" || toolName === "Glob") {
    const requested = input["path"];
    const pathAllowed =
      requested === undefined ||
      (typeof requested === "string" && pathWithin(workspaceRoot, workspaceRoot, requested, false));
    const patternAllowed = safeGlobPattern(toolName === "Glob" ? input["pattern"] : input["glob"]);
    return pathAllowed && patternAllowed
      ? { allow: true, reason: "Confined search allowed." }
      : { allow: false, reason: `${toolName} is outside the campaign workspace.` };
  }
  return { allow: false, reason: `Tool ${toolName} is unavailable in a read-only session.` };
}

// ── SDK option building (pure) ───────────────────────────────────────────────

function policyHook(decide: (toolName: string, input: Record<string, unknown>) => ToolDecision): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: false, stopReason: "Unexpected hook event in design turn policy." };
    }
    const toolInput =
      input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
        ? (input.tool_input as Record<string, unknown>)
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

const ESCAPE_TOOLS = [
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

function sandboxFor(workspace: string, artifactWrites: boolean): NonNullable<Options["sandbox"]> {
  return {
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
      denyRead: [],
      allowRead: [workspace],
      denyWrite: [workspace],
      allowWrite: artifactWrites ? [join(workspace, "validation-design")] : [],
    },
    credentials: {
      envVars: [
        { name: "ANTHROPIC_API_KEY", mode: "deny" },
        { name: "OPENAI_API_KEY", mode: "deny" },
      ],
    },
  } as NonNullable<Options["sandbox"]>;
}

function claudeOptions(
  workspace: string,
  model: string,
  tools: string[],
  decide: (toolName: string, input: Record<string, unknown>) => ToolDecision,
  artifactWrites: boolean,
  maxTurns: number,
  resumeSession?: string,
): Options {
  const hook = policyHook(decide);
  const sandbox = sandboxFor(workspace, artifactWrites);
  return {
    cwd: workspace,
    model,
    permissionMode: "dontAsk",
    tools,
    allowedTools: tools,
    disallowedTools: [...ESCAPE_TOOLS],
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: [],
    skills: [],
    sandbox,
    settings: {
      permissions: {
        defaultMode: "dontAsk",
        disableBypassPermissionsMode: "disable",
        deny: [...ESCAPE_TOOLS],
      },
      disableSkillShellExecution: true,
      disableBundledSkills: true,
      disableClaudeAiConnectors: true,
      includeGitInstructions: false,
      workflowKeywordTriggerEnabled: false,
    },
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    canUseTool: async (toolName, input): Promise<PermissionResult> => {
      const decision = decide(toolName, input);
      return decision.allow
        ? { behavior: "allow", decisionClassification: "user_temporary" }
        : { behavior: "deny", message: decision.reason, decisionClassification: "user_reject" };
    },
    maxTurns,
    ...(resumeSession ? { resume: resumeSession } : {}),
  };
}

/** Persistent designer session options: the confinement pattern above. */
export function buildDesignerQueryOptions(config: LocalTurnPortConfig, resumeSession?: string): Options {
  const workspace = realpathSync.native(config.workspace);
  return claudeOptions(
    workspace,
    modelForSeat("designer", config.models),
    ["Read", "Grep", "Glob", "Edit", "Write"],
    (toolName, input) => evaluateDesignerToolUse(workspace, toolName, input),
    true,
    config.maxTurnsPerSend ?? 50,
    resumeSession,
  );
}

/** Fresh read-only auditor/reader session options. */
export function buildReadOnlyQueryOptions(
  config: LocalTurnPortConfig,
  seat: "auditor" | "reader",
): Options {
  const workspace = realpathSync.native(config.workspace);
  return claudeOptions(
    workspace,
    modelForSeat(seat, config.models),
    ["Read", "Grep", "Glob"],
    (toolName, input) => evaluateReadOnlyToolUse(workspace, toolName, input),
    false,
    config.maxTurnsPerSend ?? 50,
  );
}

/** Read-only Codex thread options for the stakeholder seat. */
export function buildStakeholderThreadOptions(config: LocalTurnPortConfig): {
  model: string;
  sandboxMode: "read-only";
  workingDirectory: string;
  skipGitRepoCheck: boolean;
  approvalPolicy: "never";
  networkAccessEnabled: boolean;
  webSearchMode: "disabled";
} {
  return {
    model: modelForSeat("stakeholder", config.models),
    sandboxMode: "read-only",
    workingDirectory: realpathSync.native(config.workspace),
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
  };
}

// ── the port ─────────────────────────────────────────────────────────────────

function usageFrom(raw: Record<string, unknown> | undefined | null): TurnUsageReport | undefined {
  if (!raw) return undefined;
  const input = raw["input_tokens"];
  const output = raw["output_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return { inputTokens: input, outputTokens: output };
}

export class LocalTurnPort implements TurnPort {
  readonly #config: LocalTurnPortConfig;
  #codex: Codex | undefined;
  /**
   * A resumed campaign seat is identified by the native session id the engine
   * recorded on its FIRST turn. The Claude CLI may rotate the underlying
   * session id on each resumed query; the port tracks the latest native id
   * per recorded identity so the conversation actually continues, while the
   * identity it reports for a resume stays the exact id the engine pinned
   * (verifyIdentity requires equality — a different id IS a session change).
   */
  readonly #sessionAliases = new Map<string, string>();

  constructor(config: LocalTurnPortConfig) {
    this.#config = config;
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    // NEVER retry: one SDK invocation per turn request; any provider failure
    // becomes the typed "error" outcome and the engine settles it.
    try {
      switch (request.seat.seat) {
        case "designer":
          return await this.#claudeTurn(request, "designer");
        case "auditor":
          return await this.#claudeTurn(request, "auditor");
        case "reader":
          return await this.#claudeTurn(request, "reader");
        case "stakeholder":
          return await this.#codexTurn(request);
        default:
          return { status: "error", reason: `Unknown seat ${String(request.seat.seat)}` };
      }
    } catch (error) {
      return { status: "error", reason: (error as Error).message };
    }
  }

  async #claudeTurn(request: TurnRequest, seat: "designer" | "auditor" | "reader"): Promise<TurnResult> {
    if (seat !== "designer" && request.session.mode === "resume") {
      return { status: "error", reason: `Seat ${seat} is fresh-per-turn; a resume request is a host bug.` };
    }
    const model = modelForSeat(seat, this.#config.models);
    const requested = request.session.mode === "resume" ? request.session.sessionId : undefined;
    const nativeToResume = requested ? this.#sessionAliases.get(requested) ?? requested : undefined;
    const options =
      seat === "designer"
        ? buildDesignerQueryOptions(this.#config, nativeToResume)
        : buildReadOnlyQueryOptions(this.#config, seat);
    const stream = query({ prompt: request.prompt, options });
    let session: string | undefined;
    let text: string | undefined;
    let usage: TurnUsageReport | undefined;
    for await (const message of stream as AsyncIterable<Record<string, unknown>>) {
      if (message["type"] === "system" && message["subtype"] === "init") {
        const sid = message["session_id"];
        if (typeof sid === "string") session = sid;
      }
      if (message["type"] === "result") {
        const sid = message["session_id"];
        if (typeof sid === "string") session = sid;
        usage = usageFrom(message["usage"] as Record<string, unknown> | undefined) ?? usage;
        if (message["subtype"] === "success" && typeof message["result"] === "string") {
          text = message["result"];
        } else if (message["subtype"] !== "success") {
          return {
            status: "error",
            reason: `Claude ${seat} query ended without success: ${String(message["subtype"])}`,
            ...(session ? { identity: { provider: "anthropic", model, session } } : {}),
            ...(usage ? { usage } : {}),
          };
        }
      }
    }
    if (text === undefined || session === undefined) {
      return { status: "error", reason: `Claude ${seat} query produced no result/session identity.` };
    }
    if (requested) this.#sessionAliases.set(requested, session);
    const identity: ExecutionIdentity = { provider: "anthropic", model, session: requested ?? session };
    return { status: "ok", text, identity, ...(usage ? { usage } : {}) };
  }

  async #codexTurn(request: TurnRequest): Promise<TurnResult> {
    this.#codex ??= new Codex();
    const options = buildStakeholderThreadOptions(this.#config);
    const thread: Thread =
      request.session.mode === "resume"
        ? this.#codex.resumeThread(request.session.sessionId, options)
        : this.#codex.startThread(options);
    const result = await thread.run(request.prompt);
    const model = options.model;
    const session = thread.id ?? undefined;
    if (typeof session !== "string" || session.length === 0) {
      return { status: "error", reason: "Codex stakeholder turn settled without a native thread id." };
    }
    const identity: ExecutionIdentity = { provider: "openai", model, session };
    const text = result.finalResponse ?? "";
    if (!text.trim()) {
      return { status: "error", reason: "Codex stakeholder turn returned an empty final response.", identity };
    }
    const usage = usageFrom((result as { usage?: Record<string, unknown> | null }).usage);
    return { status: "ok", text, identity, ...(usage ? { usage } : {}) };
  }
}
