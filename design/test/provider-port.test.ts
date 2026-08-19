import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, type TurnRequest } from "validation-architect";

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
const stateDirectory = mkdtempSync(join(tmpdir(), "va-design-port-state-"));
mkdirSync(join(workspace, "validation-design"), { recursive: true });
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(stateDirectory, { recursive: true, force: true });
});

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
  rmSync(stateDirectory, { recursive: true, force: true });
  mkdirSync(stateDirectory, { recursive: true });
  queryMock.mockReset();
  codexState.startThread.mockReset();
  codexState.resumeThread.mockReset();
});

describe("LocalTurnPort seat mapping", () => {
  it("designer new session returns the exact native identity and usage", async () => {
    queryMock.mockReturnValueOnce(claudeMessages("sess-1", "designed"));
    const port = new LocalTurnPort({ workspace, stateDirectory, models: { designer: "model-d" } });
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

  it("designer resume reports the exact native identity instead of masking rotation", async () => {
    queryMock.mockReturnValueOnce(claudeMessages("sess-1", "one"));
    const port = new LocalTurnPort({ workspace, stateDirectory });
    await port.runTurn(request("designer", { mode: "new" }));
    queryMock.mockReturnValueOnce(claudeMessages("sess-2", "two"));
    const second = await port.runTurn(request("designer", { mode: "resume", sessionId: "sess-1" }, "run:turn:2"));
    expect(queryMock.mock.calls[1]?.[0]?.options?.resume).toBe("sess-1");
    expect(second.status).toBe("ok");
    expect(second.status === "ok" && second.identity.session).toBe("sess-2");
    queryMock.mockReturnValueOnce(claudeMessages("sess-3", "three"));
    await port.runTurn(request("designer", { mode: "resume", sessionId: "sess-1" }, "run:turn:3"));
    expect(queryMock.mock.calls[2]?.[0]?.options?.resume).toBe("sess-1");
  });

  it("replays a settled idempotency key across port instances without another SDK call", async () => {
    const turn = request("designer", { mode: "new" }, "run:stable-key");
    queryMock.mockReturnValueOnce(claudeMessages("sess-idem", "designed"));
    const first = await new LocalTurnPort({ workspace, stateDirectory }).runTurn(turn);
    const restarted = new LocalTurnPort({ workspace, stateDirectory });
    const settlement = await restarted.reconcileTurn(structuredClone(turn));
    expect(settlement?.result).toEqual(first);
    expect(settlement?.settledAtEpochMs).toEqual(expect.any(Number));
    const second = await restarted.runTurn(structuredClone(turn));
    expect(second).toEqual(first);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent claims for one idempotency key", async () => {
    let release!: () => void;
    const providerGate = new Promise<void>((resolveGate) => { release = resolveGate; });
    queryMock.mockReturnValueOnce((async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-concurrent" };
      await providerGate;
      yield {
        type: "result",
        subtype: "success",
        session_id: "sess-concurrent",
        result: "designed",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());
    const turn = request("designer", { mode: "new" }, "run:concurrent-key");
    const first = new LocalTurnPort({ workspace, stateDirectory }).runTurn(turn);
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledTimes(1));
    const second = new LocalTurnPort({ workspace, stateDirectory }).runTurn(structuredClone(turn));
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("refuses reuse of an idempotency key for a different request without provider spend", async () => {
    queryMock.mockReturnValueOnce(claudeMessages("sess-idem", "designed"));
    const port = new LocalTurnPort({ workspace, stateDirectory });
    await port.runTurn(request("designer", { mode: "new" }, "run:reused-key"));
    const changed = request("designer", { mode: "new" }, "run:reused-key");
    changed.prompt = "different prompt";
    const result = await new LocalTurnPort({ workspace, stateDirectory }).runTurn(changed);
    expect(result).toMatchObject({ status: "error", reason: expect.stringContaining("different TurnRequest") });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("fails an ambiguous dead-owner settlement closed without another provider call", async () => {
    const turn = request("designer", { mode: "new" }, "run:ambiguous-key");
    const ledger = join(stateDirectory, "turn-settlements");
    mkdirSync(ledger, { recursive: true });
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    writeFileSync(
      join(ledger, `${sha256(turn.idempotencyKey)}.json`),
      canonicalJson({
        version: 2,
        status: "pending",
        idempotencyKey: turn.idempotencyKey,
        requestDigest: sha256(canonicalJson(turn)),
        ownerPid: 2147483647,
        expiresAtEpochMs: Date.now() + 60_000,
      }),
    );
    const result = await new LocalTurnPort({ workspace, stateDirectory }).runTurn(turn);
    expect(result).toMatchObject({ status: "error", reason: expect.stringContaining("ambiguous prior settlement") });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("requires provider settlement state outside the target workspace", () => {
    expect(() => new LocalTurnPort({ workspace, stateDirectory: join(workspace, ".state") })).toThrow(/outside/);
  });

  it("rejects an external-looking state symlink that resolves into the target", () => {
    const targetState = join(workspace, ".provider-state");
    const alias = join(stateDirectory, "state-link");
    mkdirSync(targetState, { recursive: true });
    symlinkSync(targetState, alias, "dir");
    expect(() => new LocalTurnPort({ workspace, stateDirectory: alias })).toThrow(/outside/);
  });

  it("rejects malformed turn requests before any provider call", async () => {
    const malformed = request("designer", { mode: "new" });
    malformed.metadata.turnIndex = 0;
    const result = await new LocalTurnPort({ workspace, stateDirectory }).runTurn(malformed);
    expect(result).toMatchObject({ status: "error", reason: expect.stringContaining("Invalid TurnRequest") });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("starts no provider work when the request's absolute deadline has arrived", async () => {
    const expired = request("designer", { mode: "new" }, "run:expired-key");
    expired.limits = { maxWallMs: 60_000, deadlineAtEpochMs: Date.now() };
    const result = await new LocalTurnPort({ workspace, stateDirectory }).runTurn(expired);
    expect(result).toMatchObject({ status: "limit_exhausted", reason: expect.stringContaining("was not started") });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("auditor and reader are fresh sessions; a resume request is an error, not a retry", async () => {
    queryMock.mockReturnValueOnce(claudeMessages("sess-a", "audited"));
    const port = new LocalTurnPort({ workspace, stateDirectory });
    const ok = await port.runTurn(request("auditor", { mode: "new" }));
    expect(ok.status).toBe("ok");
    const bad = await port.runTurn(request("reader", { mode: "resume", sessionId: "sess-a" }, "run:turn:2"));
    expect(bad.status).toBe("error");
    expect(queryMock).toHaveBeenCalledTimes(1); // no second SDK call
  });

  it("stakeholder maps to a Codex thread and resumes by exact thread id", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "challenged", usage: { input_tokens: 3, output_tokens: 4 } });
    codexState.startThread.mockReturnValue({ id: "thread-1", run });
    const port = new LocalTurnPort({ workspace, stateDirectory, models: { stakeholder: "model-s" } });
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
    const port = new LocalTurnPort({ workspace, stateDirectory });
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
    const port = new LocalTurnPort({ workspace, stateDirectory });
    const result = await port.runTurn(request("designer", { mode: "new" }));
    expect(result.status).toBe("error");
  });
});
