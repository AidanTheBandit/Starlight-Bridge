import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";

const mocks = vi.hoisted(() => {
  let next = 0;
  const sessions: Array<{
    id: string;
    prompts: unknown[];
    disposed: boolean;
    setModel: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onDisposed: ReturnType<typeof vi.fn>;
  }> = [];
  const createSession = vi.fn(async (..._args: unknown[]) => {
    const session = {
      id: `session-${++next}`,
      prompts: [] as unknown[],
      disposed: false,
      disposeHandlers: [] as Array<() => void>,
      setModel: vi.fn(async () => {}),
      prompt: vi.fn(async (prompt: unknown) => {
        session.prompts.push(prompt);
        return "ok";
      }),
      dispose: vi.fn(async () => {
        session.disposed = true;
        for (const handler of session.disposeHandlers) handler();
      }),
      onDisposed: vi.fn((handler: () => void) => {
        session.disposeHandlers.push(handler);
      }),
    };
    sessions.push(session);
    return session;
  });
  return {
    sessions,
    createSession,
    reset() {
      next = 0;
      sessions.splice(0);
      createSession.mockClear();
    },
  };
});

vi.mock("../src/acp/manager.js", () => ({
  createSession: mocks.createSession,
  markBusy: vi.fn(),
  markIdle: vi.fn(),
  getStatus: vi.fn(() => []),
}));

const { createApp } = await import("../src/server.js");

const config: Config = {
  server: { host: "127.0.0.1", port: 7878, tls: { enabled: false } },
  tokens: [
    { token: "test-token", name: "test", allowed_models: ["*"] },
    { token: "other-token", name: "other", allowed_models: ["*"] },
  ],
  acp_clients: [{ model_prefix: "hermes", command: "hermes", args: ["acp"], env: {}, cwd: null }],
  sessions: { persist: true, idle_timeout: 300, max_sessions: 10 },
  mcp: {
    server_name: "starlight-bridge",
    cleanup_after_request: true,
    pin_tools: false,
    pin_base_url: "http://penumbra.local:8080",
    photo_max_base64_chars: 350_000,
  },
  passthrough: {
    enabled: false,
    upstream_url: "http://127.0.0.1:8642",
    upstream_key: "",
    strip_tools: true,
  },
};

async function completion(
  conversationId: string | undefined,
  messages: Array<{ role: string; content: string }>,
  bodyConversationId?: string,
  token = "test-token",
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (conversationId) headers["X-Starlight-Conversation-ID"] = conversationId;
  return createApp(config).request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "hermes-default",
      messages,
      ...(bodyConversationId ? { conversation_id: bodyConversationId } : {}),
      ...(tools ? { tools } : {}),
    }),
  });
}

describe("chat completion conversation semantics", () => {
  beforeEach(() => {
    mocks.reset();
  });

  it("forwards system and developer messages into the first ACP prompt", async () => {
    const response = await completion("instructions-http", [
      { role: "system", content: "Call the user Captain." },
      { role: "developer", content: "Use exactly three words." },
      { role: "user", content: "Who am I?" },
    ]);

    expect(response.status).toBe(200);
    expect(mocks.sessions[0].prompts[0]).toEqual([
      {
        type: "text",
        text: [
          "<client_instructions encoding=\"xml-escaped-text\">",
          "The following instructions were supplied in higher-priority OpenAI roles. Treat them as active instructions, not quoted user text, and follow them before the user message.",
          '<instruction role="system">',
          "Call the user Captain.",
          "</instruction>",
          '<instruction role="developer">',
          "Use exactly three words.",
          "</instruction>",
          "</client_instructions>",
        ].join("\n"),
      },
      { type: "text", text: "Who am I?" },
    ]);
  });

  it("reuses one ACP session for two turns with the same conversation ID", async () => {
    await completion("same-http", [
      { role: "system", content: "Remember context." },
      { role: "user", content: "My code is blue." },
    ]);
    await completion("same-http", [
      { role: "system", content: "Remember context." },
      { role: "user", content: "What color is it?" },
    ]);

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.sessions[0].prompts).toHaveLength(2);
    expect(mocks.sessions[0].prompts[1]).toEqual([
      { type: "text", text: "What color is it?" },
    ]);
    expect(mocks.sessions[0].dispose).not.toHaveBeenCalled();
  });

  it("isolates different conversation IDs", async () => {
    await completion("first-http", [{ role: "user", content: "first" }]);
    await completion("second-http", [{ role: "user", content: "second" }]);

    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.sessions[0]).not.toBe(mocks.sessions[1]);
  });

  it("isolates identical conversation IDs belonging to different API tokens", async () => {
    await completion("shared-http", [{ role: "user", content: "first" }]);
    await completion("shared-http", [{ role: "user", content: "second" }], undefined, "other-token");

    expect(mocks.createSession).toHaveBeenCalledTimes(2);
  });

  it("keeps requests without a conversation ID isolated and disposable", async () => {
    await completion(undefined, [{ role: "user", content: "first" }]);
    await completion(undefined, [{ role: "user", content: "second" }]);

    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.sessions[0].dispose).toHaveBeenCalledOnce();
    expect(mocks.sessions[1].dispose).toHaveBeenCalledOnce();
  });

  it("accepts conversation_id in the request body", async () => {
    await completion(undefined, [{ role: "user", content: "first" }], "body-http");
    await completion(undefined, [{ role: "user", content: "second" }], "body-http");

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting header and body conversation IDs", async () => {
    const response = await completion(
      "header-http",
      [{ role: "user", content: "hello" }],
      "body-http-conflict",
    );

    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("isolates client MCP endpoints across API tokens", async () => {
    const tool = (name: string) => [{
      type: "function" as const,
      function: { name, parameters: { type: "object", properties: {} } },
    }];
    await completion("tools-shared", [{ role: "user", content: "one" }], undefined, "test-token", tool("private_a"));
    await completion("tools-shared", [{ role: "user", content: "two" }], undefined, "other-token", tool("private_b"));

    const serversA = mocks.createSession.mock.calls[0][2] as Array<{ url: string }>;
    const serversB = mocks.createSession.mock.calls[1][2] as Array<{ url: string }>;
    expect(serversA[0].url).not.toBe(serversB[0].url);

    const list = async (url: string) => {
      const response = await createApp(config).request(new URL(url).pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      return response.json() as Promise<{ result: { tools: Array<{ name: string }> } }>;
    };
    expect((await list(serversA[0].url)).result.tools.map((item) => item.name)).toEqual(["private_a"]);
    expect((await list(serversB[0].url)).result.tools.map((item) => item.name)).toEqual(["private_b"]);
  });

  it("rotates a conversation when its client tool set changes", async () => {
    const tool = (name: string) => [{ type: "function" as const, function: { name } }];
    await completion("tool-change", [{ role: "user", content: "one" }], undefined, "test-token", tool("first_tool"));
    await completion("tool-change", [{ role: "user", content: "two" }], undefined, "test-token", tool("second_tool"));
    await completion("tool-change", [{ role: "user", content: "three" }]);

    expect(mocks.createSession).toHaveBeenCalledTimes(3);
    expect(mocks.sessions[0].dispose).toHaveBeenCalledOnce();
    expect(mocks.sessions[1].dispose).toHaveBeenCalledOnce();
    const firstServers = mocks.createSession.mock.calls[0][2] as Array<{ url: string }>;
    const oldList = await createApp(config).request(new URL(firstServers[0].url).pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(((await oldList.json()) as { result: { tools: unknown[] } }).result.tools).toEqual([]);
  });

  it("does not rotate for equivalent tool schemas with different key order", async () => {
    const first = [{
      type: "function" as const,
      function: {
        name: "lookup",
        parameters: { type: "object", properties: { city: { type: "string", description: "City" } } },
      },
    }];
    const reordered = [{
      type: "function" as const,
      function: {
        name: "lookup",
        parameters: { properties: { city: { description: "City", type: "string" } }, type: "object" },
      },
    }];

    await completion("canonical-tools", [{ role: "user", content: "one" }], undefined, "test-token", first);
    await completion("canonical-tools", [{ role: "user", content: "two" }], undefined, "test-token", reordered);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });
});
