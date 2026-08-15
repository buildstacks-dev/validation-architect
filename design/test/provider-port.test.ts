import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnRequest } from "validation-architect";

// The SDK modules are mocked wholesale: nothing in this suite can reach a
// provider, and every "session" below is scripted.
const queryMock = vi.hoisted(() => vi.fn());
const codexState = vi.hoisted(() => ({
  startThread: vi.fn(),
  resumeThread: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    startThread = codexState.startThread;
    resumeThread = codexState.resumeThread;
  },
}));

import { LocalTurnPort } from "../src/provider-port.js";

const workspace = mkdtempSync(join(tmpdir(), "va-design-port-"));
mkdirSync(join(workspace, "validation-design"), { recursive: true });
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function claudeMessages(session: string, text: string): AsyncIterable<Record<string, unknown>> {
  return (async function* () {
    yield { type: "system", subtype: "init", session_id: session };
    yield {
      type: "result",
      subtype: "success",
      session_id: session,
      result: text,
      usage: { input_tokens: 11, output_tokens: 7 },
    };
  })();
}

function request(seat: TurnRequest["seat"]["seat"], session: TurnRequest["session"], key = "run:turn:1"): TurnRequest {
  return {
    seat: { seat, instance: seat === "reader" ? "reader:operator" : seat },
    independence: [],
    session,
    idempotencyKey: key,
    prompt: "prompt",
    limits: {},
    metadata: { runId: "run", phase: "design", turnIndex: 1 },
  };
}

beforeEach(() => {
  queryMock.mockReset();
  codexState.startThread.mockReset();
  codexState.resumeThread.mockReset();
});

describe("LocalTurnPort seat mapping", () => {
  it("designer new session returns the exact native identity and usage", async () => {
    queryMock.mockReturnValueOnce(claudeMessages("sess-1", "designed"));
    const port = new LocalTurnPort({ workspace, models: { designer: "model-d" } });
    const result = await port.runTurn(request("designer", { mode: "new" }));
    expect(result).toMatchObject({
      status: "ok",
      text: "designed",
      identity: { provider: "anthropic", model: "model-d", session: "sess-1" },
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]?.[0]?.options?.resume).toBeUndefined();
  });

  it("designer resume passes the session to the SDK and reports the pinned identity", async () => {
    queryMock.mockReturnValueOnce(claudeMessages("sess-1", "one"));
    const port = new LocalTurnPort({ workspace });
    await port.runTurn(request("designer", { mode: "new" }));
    // The CLI rotated the native id; the port must keep resuming the live
    // conversation while reporting the identity the engine pinned.
    queryMock.mockReturnValueOnce(claudeMessages("sess-2", "two"));
    const second = await port.runTurn(request("designer", { mode: "resume", sessionId: "sess-1" }, "run:turn:2"));
    expect(queryMock.mock.calls[1]?.[0]?.options?.resume).toBe("sess-1");
    expect(second.status).toBe("ok");
    expect(second.status === "ok" && second.identity.session).toBe("sess-1");
    queryMock.mockReturnValueOnce(claudeMessages("sess-3", "three"));
    await port.runTurn(request("designer", { mode: "resume", sessionId: "sess-1" }, "run:turn:3"));
    expect(queryMock.mock.calls[2]?.[0]?.options?.resume).toBe("sess-2");
  });

  it("auditor and reader are fresh sessions; a resume request is an error, not a retry", async () => {
    queryMock.mockReturnValueOnce(claudeMessages("sess-a", "audited"));
    const port = new LocalTurnPort({ workspace });
    const ok = await port.runTurn(request("auditor", { mode: "new" }));
    expect(ok.status).toBe("ok");
    const bad = await port.runTurn(request("reader", { mode: "resume", sessionId: "sess-a" }, "run:turn:2"));
    expect(bad.status).toBe("error");
    expect(queryMock).toHaveBeenCalledTimes(1); // no second SDK call
  });

  it("stakeholder maps to a Codex thread and resumes by exact thread id", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "challenged", usage: { input_tokens: 3, output_tokens: 4 } });
    codexState.startThread.mockReturnValue({ id: "thread-1", run });
    const port = new LocalTurnPort({ workspace, models: { stakeholder: "model-s" } });
    const first = await port.runTurn(request("stakeholder", { mode: "new" }));
    expect(first).toMatchObject({
      status: "ok",
      text: "challenged",
      identity: { provider: "openai", model: "model-s", session: "thread-1" },
    });
    codexState.resumeThread.mockReturnValue({ id: "thread-1", run });
    const second = await port.runTurn(request("stakeholder", { mode: "resume", sessionId: "thread-1" }, "run:turn:2"));
    expect(codexState.resumeThread).toHaveBeenCalledWith("thread-1", expect.objectContaining({ sandboxMode: "read-only" }));
    expect(second.status).toBe("ok");
  });

  it("a thrown SDK failure settles as the typed error outcome with NO retry", async () => {
    queryMock.mockImplementationOnce(() => {
      throw new Error("provider unavailable");
    });
    const port = new LocalTurnPort({ workspace });
    const result = await port.runTurn(request("designer", { mode: "new" }));
    expect(result).toMatchObject({ status: "error", reason: expect.stringContaining("provider unavailable") });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("a non-success Claude result subtype is the typed error outcome", async () => {
    queryMock.mockReturnValueOnce(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-x" };
        yield { type: "result", subtype: "error_max_turns", session_id: "sess-x" };
      })(),
    );
    const port = new LocalTurnPort({ workspace });
    const result = await port.runTurn(request("designer", { mode: "new" }));
    expect(result.status).toBe("error");
  });
});
