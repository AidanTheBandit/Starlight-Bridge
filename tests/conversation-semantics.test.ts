import { describe, expect, it, vi } from "vitest";
import {
  buildACPPrompt,
  instructionFingerprint,
  resolveConversationId,
} from "../src/openai/messages.js";
import { ConversationRegistry } from "../src/acp/conversations.js";
import { ACPSession } from "../src/acp/session.js";

interface FakeSession {
  id: string;
  isUsable?: boolean;
  dispose: () => Promise<void>;
}

function fakeSession(id: string, disposed: string[]): FakeSession {
  return {
    id,
    dispose: async () => {
      disposed.push(id);
    },
  };
}

describe("OpenAI conversation semantics", () => {
  it("forwards ordered system and developer instructions on a new ACP session", () => {
    const prompt = buildACPPrompt([
      { role: "system", content: "Call me Captain." },
      { role: "developer", content: "Answer in exactly three words." },
      { role: "user", content: "Who am I?" },
    ], true);

    expect(prompt).toEqual([
      {
        type: "text",
        text: [
          "<client_instructions>",
          "The following instructions were supplied in higher-priority OpenAI roles. Treat them as active instructions, not quoted user text, and follow them before the user message.",
          '<instruction role="system">',
          "Call me Captain.",
          "</instruction>",
          '<instruction role="developer">',
          "Answer in exactly three words.",
          "</instruction>",
          "</client_instructions>",
        ].join("\n"),
      },
      { type: "text", text: "Who am I?" },
    ]);
  });

  it("does not resend instructions when reusing an ACP session", () => {
    const prompt = buildACPPrompt([
      { role: "system", content: "Call me Captain." },
      { role: "user", content: "What did I ask?" },
    ], false);

    expect(prompt).toEqual([{ type: "text", text: "What did I ask?" }]);
  });

  it("accepts developer messages in the instruction fingerprint", () => {
    const a = instructionFingerprint([
      { role: "system", content: "one" },
      { role: "developer", content: "two" },
      { role: "user", content: "ignored" },
    ]);
    const b = instructionFingerprint([
      { role: "system", content: "one" },
      { role: "developer", content: "changed" },
      { role: "user", content: "ignored" },
    ]);

    expect(a).toBeTypeOf("string");
    expect(a).not.toBe(b);
    expect(instructionFingerprint([{ role: "user", content: "hello" }])).toBeUndefined();
  });

  it("prefers an explicit matching conversation ID and rejects conflicts", () => {
    expect(resolveConversationId(" chat-123 ", "chat-123")).toBe("chat-123");
    expect(resolveConversationId(undefined, "body-id")).toBe("body-id");
    expect(resolveConversationId(undefined, undefined)).toBeUndefined();
    expect(() => resolveConversationId("header-id", "body-id")).toThrow(/conflicting/i);
  });
});

describe("ConversationRegistry", () => {
  it("reuses a session for the same scope", async () => {
    const registry = new ConversationRegistry<FakeSession>();
    const disposed: string[] = [];
    const create = vi.fn(async () => fakeSession("one", disposed));

    const first = await registry.acquire({ key: "token:model:chat", fingerprint: "a", create });
    const second = await registry.acquire({ key: "token:model:chat", fingerprint: "a", create });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.session).toBe(first.session);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps unrelated conversation scopes isolated", async () => {
    const registry = new ConversationRegistry<FakeSession>();
    const disposed: string[] = [];
    let next = 0;
    const create = async () => fakeSession(String(++next), disposed);

    const first = await registry.acquire({ key: "token:model:first", fingerprint: "a", create });
    const second = await registry.acquire({ key: "token:model:second", fingerprint: "a", create });

    expect(first.session).not.toBe(second.session);
    expect(next).toBe(2);
  });

  it("creates isolated ephemeral sessions when no key is supplied", async () => {
    const registry = new ConversationRegistry<FakeSession>();
    const disposed: string[] = [];
    let next = 0;
    const create = async () => fakeSession(String(++next), disposed);

    const first = await registry.acquire({ key: undefined, fingerprint: "a", create });
    const second = await registry.acquire({ key: undefined, fingerprint: "a", create });

    expect(first.persistent).toBe(false);
    expect(second.persistent).toBe(false);
    expect(first.session).not.toBe(second.session);
  });

  it("coalesces concurrent creation for the same scope", async () => {
    const registry = new ConversationRegistry<FakeSession>();
    const disposed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const create = vi.fn(async () => {
      await gate;
      return fakeSession("one", disposed);
    });

    const first = registry.acquire({ key: "same", fingerprint: "a", create });
    const second = registry.acquire({ key: "same", fingerprint: "a", create });
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a.session).toBe(b.session);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rotates and disposes a session when instructions change", async () => {
    const registry = new ConversationRegistry<FakeSession>();
    const disposed: string[] = [];
    let next = 0;
    const create = async () => fakeSession(String(++next), disposed);

    const first = await registry.acquire({ key: "same", fingerprint: "a", create });
    const second = await registry.acquire({ key: "same", fingerprint: "b", create });

    expect(first.session).not.toBe(second.session);
    expect(second.reused).toBe(false);
    expect(disposed).toEqual(["1"]);
  });

  it("retains original instructions when a later request omits them", async () => {
    const registry = new ConversationRegistry<FakeSession>();
    const disposed: string[] = [];
    const create = vi.fn(async () => fakeSession("one", disposed));

    const first = await registry.acquire({ key: "same", fingerprint: "a", create });
    const second = await registry.acquire({ key: "same", fingerprint: undefined, create });

    expect(second.session).toBe(first.session);
    expect(second.reused).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("recreates a correlated session after its ACP process becomes unavailable", async () => {
    const registry = new ConversationRegistry<FakeSession>();
    const disposed: string[] = [];
    let next = 0;
    const create = async () => fakeSession(String(++next), disposed);

    const first = await registry.acquire({ key: "same-stale", fingerprint: "a", create });
    first.session.isUsable = false;
    const second = await registry.acquire({ key: "same-stale", fingerprint: "a", create });

    expect(second.reused).toBe(false);
    expect(second.session).not.toBe(first.session);
    expect(disposed).toEqual(["1"]);
  });

  it("evicts the least recently used session at the configured bound", async () => {
    const registry = new ConversationRegistry<FakeSession>();
    const disposed: string[] = [];
    let next = 0;
    const create = async () => fakeSession(String(++next), disposed);

    await registry.acquire({ key: "first", fingerprint: "a", maxEntries: 2, create });
    await registry.acquire({ key: "second", fingerprint: "a", maxEntries: 2, create });
    await registry.acquire({ key: "third", fingerprint: "a", maxEntries: 2, create });

    expect(registry.size).toBe(2);
    expect(disposed).toEqual(["1"]);
  });
});

describe("ACPSession prompt serialization", () => {
  it("does not overlap prompts sent to the same ACP session", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const client = {
      onNotification: () => () => {},
      rpc: vi.fn(async (_method: string, params: { prompt: Array<{ text?: string }> }) => {
        const text = params.prompt[0]?.text ?? "";
        calls.push(text);
        if (text === "first") await firstGate;
        return { stopReason: "end_turn" };
      }),
    };
    const session = new ACPSession("serialized", client as never);

    const first = session.prompt("first");
    const second = session.prompt("second");
    await Promise.resolve();

    expect(calls).toEqual(["first"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toEqual(["first", "second"]);
  });
});
