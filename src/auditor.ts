import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeReadOnlyQueryOptions } from "./designer.js";
import type { AuditorRunner } from "./types.js";

export interface ClaudeAuditorOptions {
  model: string;
  authMode: "subscription" | "api-key";
}

/**
 * Independent audit iterations: each run() is a FRESH single-shot session with
 * read-only tools over the workspace, like the Phase-8 readers. Fresh context
 * is the point — an auditor that shared the designer's session (or saw the
 * transcript) could not independently judge what the corpus alone supports.
 * The workspace cwd plus read-only tools bound its world to docs/,
 * rambling.txt, validation-design/, and the vendored skills; the run dir
 * (transcript.jsonl, state.json) is outside it by construction.
 */
export class ClaudeAuditorRunner implements AuditorRunner {
  private readonly env: Record<string, string>;

  constructor(private readonly opts: ClaudeAuditorOptions) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (opts.authMode === "subscription") delete env["ANTHROPIC_API_KEY"];
    this.env = env;
  }

  async run(prompt: string, workspace: string): Promise<string> {
    const q = query({
      prompt,
      options: buildClaudeReadOnlyQueryOptions({
        workspace,
        model: this.opts.model,
        // The audit reads a large corpus plus the skill's references; give it
        // more headroom than a reader.
        maxTurns: 200,
        env: this.env,
      }),
    });
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      if (msg["type"] === "result") {
        if (msg["subtype"] === "success" && typeof msg["result"] === "string") {
          return msg["result"];
        }
        throw new Error(`auditor ended without success: ${String(msg["subtype"])}`);
      }
    }
    throw new Error("auditor produced no result");
  }
}
