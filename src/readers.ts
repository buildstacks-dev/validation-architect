import { query } from "@anthropic-ai/claude-agent-sdk";
import { readerPrompt } from "./prompts.js";
import type { ReaderPersonaId, ReaderRunner } from "./types.js";

export interface ClaudeReaderOptions {
  model: string;
  authMode: "subscription" | "api-key";
}

/**
 * Phase-8 ephemeral readers: fresh single-shot sessions with read-only tools,
 * one per persona. Fresh context is the point — a reader that shared the
 * designer's context could not honestly report what the artifacts alone fail
 * to convey.
 */
export class ClaudeReaderRunner implements ReaderRunner {
  private readonly env: Record<string, string>;

  constructor(private readonly opts: ClaudeReaderOptions) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (opts.authMode === "subscription") delete env["ANTHROPIC_API_KEY"];
    this.env = env;
  }

  async run(persona: ReaderPersonaId, workspace: string): Promise<string> {
    const q = query({
      prompt: readerPrompt(persona),
      options: {
        cwd: workspace,
        model: this.opts.model,
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Grep", "Glob"],
        settingSources: [],
        maxTurns: 60,
        env: this.env,
      },
    });
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      if (msg["type"] === "result") {
        if (msg["subtype"] === "success" && typeof msg["result"] === "string") {
          return msg["result"];
        }
        throw new Error(`reader ${persona} ended without success: ${String(msg["subtype"])}`);
      }
    }
    throw new Error(`reader ${persona} produced no result`);
  }
}
