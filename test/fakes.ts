import type {
  AgentTurn,
  AuditorRunner,
  DesignerAgent,
  ReaderPersonaId,
  ReaderRunner,
  StakeholderAgent,
} from "../src/types.js";

export type ScriptStep = string | ((incoming: string) => string) | Error;

/** Scripted agent: replays a fixed sequence of responses, recording inputs. */
class ScriptedAgent {
  readonly received: string[] = [];
  private i = 0;

  constructor(private readonly script: ScriptStep[]) {}

  async step(message: string): Promise<AgentTurn> {
    this.received.push(message);
    const step = this.script[this.i++];
    if (step === undefined) {
      throw new Error(`script exhausted after ${this.i - 1} steps (got: ${message.slice(0, 80)})`);
    }
    if (step instanceof Error) throw step;
    const text = typeof step === "function" ? step(message) : step;
    return { text, usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 } };
  }
}

export class FakeDesigner implements DesignerAgent {
  private readonly agent: ScriptedAgent;
  constructor(script: ScriptStep[]) {
    this.agent = new ScriptedAgent(script);
  }
  get received(): string[] {
    return this.agent.received;
  }
  send(message: string): Promise<AgentTurn> {
    return this.agent.step(message);
  }
  sessionId(): string | undefined {
    return "fake-designer-session";
  }
}

export class FakeStakeholder implements StakeholderAgent {
  private readonly agent: ScriptedAgent;
  constructor(script: ScriptStep[]) {
    this.agent = new ScriptedAgent(script);
  }
  get received(): string[] {
    return this.agent.received;
  }
  send(message: string): Promise<AgentTurn> {
    return this.agent.step(message);
  }
  threadId(): string | undefined {
    return "fake-codex-thread";
  }
}

export class FakeReaders implements ReaderRunner {
  readonly ran: ReaderPersonaId[] = [];
  async run(persona: ReaderPersonaId): Promise<string> {
    this.ran.push(persona);
    return `1. (minor) ${persona}: artifacts were sufficient for my role.`;
  }
}

/** Scripted fresh-context auditor: one script step per audit iteration. */
export class FakeAuditor implements AuditorRunner {
  private readonly agent: ScriptedAgent;
  constructor(script: ScriptStep[]) {
    this.agent = new ScriptedAgent(script);
  }
  /** The prompts each iteration received (iteration-2 scope assertions). */
  get prompts(): string[] {
    return this.agent.received;
  }
  async run(prompt: string): Promise<string> {
    return (await this.agent.step(prompt)).text;
  }
}
