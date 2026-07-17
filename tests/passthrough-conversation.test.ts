import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { createApp } from "../src/server.js";

const config: Config = {
  server: { host: "127.0.0.1", port: 7878, tls: { enabled: false } },
  tokens: [{ token: "test-token", allowed_models: ["*"] }],
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
    enabled: true,
    upstream_url: "http://upstream.invalid",
    upstream_key: "upstream-key",
    strip_tools: false,
  },
  rapid: {
    enabled: false,
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    api_key: "",
    model: "gemini-3-flash-preview",
    escalate_tool: "escalate_to_agent",
    timeout_ms: 12000,
    system_prompt: "fast path",
  },

};

describe("passthrough extensions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("strips Starlight conversation_id before forwarding upstream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [] }),
    );
    const response = await createApp(config).request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        model: "hermes-default",
        messages: [{ role: "user", content: "hello" }],
        conversation_id: "local-only",
      }),
    });

    expect(response.status).toBe(200);
    const forwarded = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(forwarded.conversation_id).toBeUndefined();
    expect(forwarded.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});
