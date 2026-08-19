/**
 * The ONE concrete TurnPort of the design package: logical seats map to SDK
 * calls. Designer turns run in a persistent Claude Agent SDK session under
 * the same confinement enforcement pattern as the core's campaign host
 * (PreToolUse hook + canUseTool + OS sandbox), but are read-only: artifacts
 * return as structured data and no provider tool writes the target. The
 * stakeholder is a persistent Codex thread resumed by its
 * exact native thread id; auditors and readers are fresh read-only Claude
 * sessions. Importing this module performs no SDK call; the class takes a
 * config object and the option-building is pure so the hook callbacks are
 * unit-testable offline. The port NEVER retries: a provider failure is the
 * typed "error" turn result and the engine decides what a failed run means.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { Codex, type Thread } from "@openai/codex-sdk";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import {
  validateTurnRequest,
  type ExecutionIdentity,
  type TurnPort,
  type TurnRequest,
  type TurnResult,
  type TurnSettlement,
  type TurnUsageReport,
} from "validation-architect";
import { TurnLedger } from "./turn-ledger.js";

// ── configuration ────────────────────────────────────────────────────────────

export interface LocalTurnPortModels {
  designer?: string;
  stakeholder?: string;
  auditor?: string;
  reader?: string;
}

export interface LocalTurnPolicyConfig {
  /** Campaign workspace root: the target checkout the seats may read. */
  workspace: string;
  /** Model overrides per seat; defaults below. */
  models?: LocalTurnPortModels;
  /** Claude turn ceiling per send (tool-use steps, not campaign turns). */
  maxTurnsPerSend?: number;
  claudeAuth?: "subscription" | "api-key";
  codexAuth?: "chatgpt" | "api-key";
}

export interface LocalTurnPortConfig extends LocalTurnPolicyConfig {
  /** Durable state root shared with the campaign store; never the target. */
  stateDirectory: string;
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
 * Designer-seat policy: confined reads/searches only. Artifacts cross the
 * structured TurnResult boundary; a provider tool never writes the target.
 */
export function evaluateDesignerToolUse(
  workspace: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolDecision {
  const workspaceRoot = realpathSync.native(workspace);
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

  if (toolName === "Edit" || toolName === "Write") return deny(`${toolName} is denied; return artifacts in structured output.`);

  if (toolName === "Bash") {
    return deny("Bash is denied fail-closed in the design adapter; the designer uses confined read/search tools only.");
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

function sandboxFor(workspace: string) {
  const filesystemRoot = parse(workspace).root;
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
      denyRead: [filesystemRoot],
      allowRead: [workspace],
      denyWrite: [filesystemRoot],
      allowWrite: [],
    },
    credentials: {
      envVars: [
        { name: "ANTHROPIC_API_KEY", mode: "deny" },
        { name: "OPENAI_API_KEY", mode: "deny" },
      ],
    },
  } satisfies NonNullable<Options["sandbox"]>;
}

function claudeOptions(
  workspace: string,
  model: string,
  tools: string[],
  decide: (toolName: string, input: Record<string, unknown>) => ToolDecision,
  maxTurns: number,
  resumeSession?: string,
): Options {
  const hook = policyHook(decide);
  const sandbox = sandboxFor(workspace);
  const disallowed = [...ESCAPE_TOOLS, "Edit", "Write"];
  return {
    cwd: workspace,
    model,
    permissionMode: "dontAsk",
    tools,
    allowedTools: tools,
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
    maxTurns,
    ...(resumeSession ? { resume: resumeSession } : {}),
  };
}

/** Persistent designer session options: the confinement pattern above. */
export function buildDesignerQueryOptions(config: LocalTurnPolicyConfig, resumeSession?: string): Options {
  const workspace = realpathSync.native(config.workspace);
  return claudeOptions(
    workspace,
    modelForSeat("designer", config.models),
    ["Read", "Grep", "Glob"],
    (toolName, input) => evaluateDesignerToolUse(workspace, toolName, input),
    config.maxTurnsPerSend ?? 50,
    resumeSession,
  );
}

/** Fresh read-only auditor/reader session options. */
export function buildReadOnlyQueryOptions(
  config: LocalTurnPolicyConfig,
  seat: "auditor" | "reader",
): Options {
  const workspace = realpathSync.native(config.workspace);
  return claudeOptions(
    workspace,
    modelForSeat(seat, config.models),
    ["Read", "Grep", "Glob"],
    (toolName, input) => evaluateReadOnlyToolUse(workspace, toolName, input),
    config.maxTurnsPerSend ?? 50,
  );
}

/** Read-only Codex thread options for the stakeholder seat. */
export function buildStakeholderThreadOptions(config: LocalTurnPolicyConfig): {
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
  readonly #ledger: TurnLedger;
  #codex: Codex | undefined;
  readonly #claudeEnv: Record<string, string>;

  constructor(config: LocalTurnPortConfig) {
    mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
    const workspace = realpathSync.native(config.workspace);
    const stateDirectory = realpathSync.native(config.stateDirectory);
    if (containedBy(resolve(config.workspace), stateDirectory) || containedBy(workspace, stateDirectory)) {
      throw new Error("LocalTurnPort stateDirectory must be outside the target workspace.");
    }
    this.#config = { ...config, workspace, stateDirectory };
    this.#ledger = new TurnLedger(stateDirectory);
    this.#claudeEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    if ((config.claudeAuth ?? "subscription") === "subscription") {
      delete this.#claudeEnv["ANTHROPIC_API_KEY"];
    } else if (!this.#claudeEnv["ANTHROPIC_API_KEY"]) {
      throw new Error("claudeAuth=api-key requires ANTHROPIC_API_KEY");
    }
    if ((config.codexAuth ?? "chatgpt") === "api-key" && !process.env["OPENAI_API_KEY"]) {
      throw new Error("codexAuth=api-key requires OPENAI_API_KEY");
    }
  }

  async reconcileTurn(request: TurnRequest): Promise<TurnSettlement | null> {
    const requestProblems: string[] = [];
    validateTurnRequest(request, requestProblems);
    if (requestProblems.length > 0) {
      throw new Error(`Invalid TurnRequest: ${requestProblems.join("; ")}`);
    }
    return this.#ledger.reconcile(request);
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const requestProblems: string[] = [];
    validateTurnRequest(request, requestProblems);
    if (requestProblems.length > 0) {
      return { status: "error", reason: `Invalid TurnRequest: ${requestProblems.join("; ")}` };
    }
    let claim;
    try {
      const reconciled = await this.#ledger.reconcile(request);
      if (reconciled) return reconciled.result;
      const requestedWall = request.limits.maxWallMs ?? 60 * 60_000;
      const deadlineWall = request.limits.deadlineAtEpochMs === undefined
        ? Number.POSITIVE_INFINITY
        : request.limits.deadlineAtEpochMs - Date.now();
      const effectiveWall = Math.min(requestedWall, deadlineWall);
      if (effectiveWall <= 0) {
        return {
          status: "limit_exhausted",
          reason: `Provider work was not started because absolute deadline ${request.limits.deadlineAtEpochMs} was reached.`,
        };
      }
      claim = await this.#ledger.claim(request, effectiveWall);
    } catch (error) {
      return { status: "error", reason: (error as Error).message };
    }
    if (claim.kind === "replay") return claim.settlement.result;
    if (claim.kind === "ambiguous") return claim.result;

    const abortController = new AbortController();
    const requestedWall = request.limits.maxWallMs ?? 60 * 60_000;
    const deadlineWall = request.limits.deadlineAtEpochMs === undefined
      ? Number.POSITIVE_INFINITY
      : request.limits.deadlineAtEpochMs - Date.now();
    const effectiveWall = Math.min(requestedWall, deadlineWall);
    if (effectiveWall <= 0) {
      const expired: TurnResult = {
        status: "limit_exhausted",
        reason: `Provider work was not started because absolute deadline ${request.limits.deadlineAtEpochMs} was reached.`,
      };
      this.#ledger.settle(claim, expired);
      return expired;
    }
    const wallMs = Number.isFinite(effectiveWall) ? effectiveWall : undefined;
    const timeout = wallMs === undefined ? undefined : setTimeout(() => abortController.abort(), wallMs);
    let result: TurnResult;
    try {
      result = await this.#invoke(request, abortController);
      if (
        result.status === "ok" &&
        request.limits.maxTokens !== undefined &&
        result.usage !== undefined &&
        result.usage.outputTokens > request.limits.maxTokens
      ) {
        result = {
          status: "limit_exhausted",
          reason: `Provider output used ${result.usage.outputTokens} tokens, above the admitted ${request.limits.maxTokens}.`,
          identity: result.identity,
          usage: result.usage,
        };
      }
    } catch (error) {
      result = abortController.signal.aborted
        ? { status: "limit_exhausted", reason: `Provider turn exceeded its admitted ${wallMs}ms wall limit.` }
        : { status: "error", reason: (error as Error).message };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    try {
      this.#ledger.settle(claim, result);
      return result;
    } catch (error) {
      return {
        status: "error",
        reason: `Provider turn settled but its idempotency record could not be committed: ${(error as Error).message}`,
        ...(result.identity ? { identity: result.identity } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    }
  }

  async #invoke(request: TurnRequest, abortController: AbortController): Promise<TurnResult> {
    switch (request.seat.seat) {
      case "designer":
        return this.#claudeTurn(request, "designer", abortController);
      case "auditor":
        return this.#claudeTurn(request, "auditor", abortController);
      case "reader":
        return this.#claudeTurn(request, "reader", abortController);
      case "stakeholder":
        return this.#codexTurn(request, abortController.signal);
      default:
        return { status: "error", reason: `Unknown seat ${String(request.seat.seat)}` };
    }
  }

  async #claudeTurn(
    request: TurnRequest,
    seat: "designer" | "auditor" | "reader",
    abortController: AbortController,
  ): Promise<TurnResult> {
    if (seat !== "designer" && request.session.mode === "resume") {
      return { status: "error", reason: `Seat ${seat} is fresh-per-turn; a resume request is a host bug.` };
    }
    const model = modelForSeat(seat, this.#config.models);
    const requested = request.session.mode === "resume" ? request.session.sessionId : undefined;
    const options =
      seat === "designer"
        ? buildDesignerQueryOptions(this.#config, requested)
        : buildReadOnlyQueryOptions(this.#config, seat);
    options.abortController = abortController;
    options.env = this.#claudeEnv;
    if (request.outputSchema) options.outputFormat = { type: "json_schema", schema: request.outputSchema };
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
          text = message["structured_output"] === undefined
            ? message["result"]
            : JSON.stringify(message["structured_output"]);
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
    const identity: ExecutionIdentity = { provider: "anthropic", model, session };
    return { status: "ok", text, identity, ...(usage ? { usage } : {}) };
  }

  async #codexTurn(request: TurnRequest, signal: AbortSignal): Promise<TurnResult> {
    this.#codex ??= (this.#config.codexAuth ?? "chatgpt") === "api-key"
      ? new Codex({ apiKey: process.env["OPENAI_API_KEY"] as string })
      : new Codex();
    const options = buildStakeholderThreadOptions(this.#config);
    const thread: Thread =
      request.session.mode === "resume"
        ? this.#codex.resumeThread(request.session.sessionId, options)
        : this.#codex.startThread(options);
    const result = await thread.run(request.prompt, {
      signal,
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
    });
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
