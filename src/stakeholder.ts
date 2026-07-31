import { Codex, type Thread } from "@openai/codex-sdk";
import type { AgentTurn, StakeholderAgent, TurnUsage } from "./types.js";

export interface CodexStakeholderOptions {
  workspace: string;
  model: string;
  /** "chatgpt" uses the codex CLI's stored ChatGPT login; "api-key" uses OPENAI_API_KEY. */
  authMode: "chatgpt" | "api-key";
  resumeThreadId?: string | undefined;
  /** Per-turn wall ceiling; a hung provider call must not hang the campaign. */
  turnTimeoutMs?: number | undefined;
}

/**
 * Persistent Codex stakeholder thread, sandboxed read-only over the shared
 * workspace so it can study docs, rambling.txt, and the designer's artifacts
 * but can never write anything.
 */
export class CodexStakeholder implements StakeholderAgent {
  private thread: Thread | undefined;
  private readonly codex: Codex;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CodexStakeholderOptions) {
    if (opts.authMode === "api-key") {
      const key = process.env["OPENAI_API_KEY"];
      if (!key) throw new Error("stakeholder authMode=api-key but OPENAI_API_KEY is not set");
      this.codex = new Codex({ apiKey: key });
    } else {
      this.codex = new Codex();
    }
    this.timeoutMs = opts.turnTimeoutMs ?? 20 * 60 * 1000;
  }

  threadId(): string | undefined {
    return this.thread?.id ?? undefined;
  }

  private ensureThread(): Thread {
    if (!this.thread) {
      const options = {
        model: this.opts.model,
        sandboxMode: "read-only" as const,
        workingDirectory: this.opts.workspace,
        skipGitRepoCheck: true,
        approvalPolicy: "never" as const,
      };
      this.thread = this.opts.resumeThreadId
        ? this.codex.resumeThread(this.opts.resumeThreadId, options)
        : this.codex.startThread(options);
    }
    return this.thread;
  }

  async send(message: string): Promise<AgentTurn> {
    const thread = this.ensureThread();
    const run = thread.run(message);
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`stakeholder turn exceeded ${this.timeoutMs / 60000} minutes`)),
        this.timeoutMs,
      );
      t.unref?.();
    });
    const result = await Promise.race([run, timeout]);
    const text = result.finalResponse ?? "";
    if (!text.trim()) {
      throw new Error("stakeholder turn returned an empty final response");
    }
    const rawUsage = (result as { usage?: Record<string, unknown> | null }).usage;
    let usage: TurnUsage | undefined;
    if (rawUsage) {
      usage = {
        ...(typeof rawUsage["input_tokens"] === "number"
          ? { inputTokens: rawUsage["input_tokens"] as number }
          : {}),
        ...(typeof rawUsage["output_tokens"] === "number"
          ? { outputTokens: rawUsage["output_tokens"] as number }
          : {}),
      };
    }
    return { text, ...(usage ? { usage } : {}) };
  }
}
