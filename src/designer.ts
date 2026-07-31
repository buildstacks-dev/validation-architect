import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTurn, DesignerAgent, TurnUsage } from "./types.js";

export interface ClaudeDesignerOptions {
  workspace: string;
  model: string;
  /** "subscription" strips ANTHROPIC_API_KEY so CLI login auth is used. */
  authMode: "subscription" | "api-key";
  maxTurnsPerSend: number;
  resumeSessionId?: string | undefined;
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
      options: {
        cwd: this.opts.workspace,
        model: this.opts.model,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
        maxTurns: this.opts.maxTurnsPerSend,
        env: this.env,
        ...(this.session ? { resume: this.session } : {}),
      },
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
