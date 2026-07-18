import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { tryRapid } from "../src/openai/rapid.js";
import type { OpenAIRequest } from "../src/openai/types.js";

function baseConfig(overrides: Partial<Config["rapid"]> = {}): Config {
  return {
    server: { host: "127.0.0.1", port: 7878, tls: { enabled: false } },
    tokens: [{ token: "t", allowed_models: ["*"] }],
    acp_clients: [{ model_prefix: "hermes", command: "hermes", args: [], env: {}, cwd: null }],
    sessions: { persist: true, idle_timeout: 300, max_sessions: 10 },
    mcp: {
      server_name: "starlight-bridge",
      cleanup_after_request: true,
      pin_tools: false,
      pin_base_url: "http://127.0.0.1:8080",
      photo_max_base64_chars: 1000,
    },
    passthrough: { enabled: false, upstream_url: "http://127.0.0.1:1", upstream_key: "", strip_tools: true },
    rapid: {
      enabled: true,
      base_url: "https://example.test/v1beta/openai",
      api_key: "test-key",
      model: "gemini-3-flash-preview",
      escalate_tool: "escalate_to_agent",
      timeout_ms: 5000,
      system_prompt: "fast path",
      ...overrides,
    },
  response: {
    strip_markdown: false,
  },

  } as Config;
}

const simpleBody: OpenAIRequest = {
  model: "hermes-default",
  messages: [{ role: "user", content: "What is 2+2?" }],
};

describe("tryRapid", () => {
  it("skips when disabled", async () => {
    const decision = await tryRapid(simpleBody, baseConfig({ enabled: false }));
    expect(decision).toEqual({ kind: "skip", reason: "disabled" });
  });

  it("skips when client tools are present", async () => {
    const decision = await tryRapid({
      ...simpleBody,
      tools: [{ type: "function", function: { name: "weather", parameters: {} } }],
    }, baseConfig());
    expect(decision).toEqual({ kind: "skip", reason: "client_tools_present" });
  });

  it("returns answer content from the fast model", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: "gemini-3-flash-preview",
      choices: [{ message: { role: "assistant", content: "4" }, finish_reason: "stop" }],
    }), { status: 200 }));

    const decision = await tryRapid(simpleBody, baseConfig(), fetchImpl as unknown as typeof fetch);
    expect(decision).toEqual({ kind: "answer", content: "4", model: "gemini-3-flash-preview" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body));
    expect(payload.tools[0].function.name).toBe("escalate_to_agent");
  });

  it("escalates when the fast model calls escalate_to_agent", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "1",
            type: "function",
            function: { name: "escalate_to_agent", arguments: "{\"reason\":\"needs tools\"}" },
          }],
        },
      }],
    }), { status: 200 }));

    const decision = await tryRapid(simpleBody, baseConfig(), fetchImpl as unknown as typeof fetch);
    expect(decision).toEqual({ kind: "escalate", reason: "needs tools" });
  });

  it("escalates on upstream failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const decision = await tryRapid(simpleBody, baseConfig(), fetchImpl as unknown as typeof fetch);
    expect(decision.kind).toBe("escalate");
  });

  it("escalates technical prompts before calling the fast model", async () => {
    const fetchImpl = vi.fn(async () => new Response("should not be called", { status: 500 }));
    const decision = await tryRapid({
      model: "hermes-default",
      messages: [{ role: "user", content: "Debug this TypeScript stacktrace and patch the bug" }],
    }, baseConfig(), fetchImpl as unknown as typeof fetch);
    expect(decision).toEqual({ kind: "escalate", reason: "coding" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("escalates device/tool prompts before calling the fast model", async () => {
    const fetchImpl = vi.fn(async () => new Response("should not be called", { status: 500 }));
    const decision = await tryRapid({
      model: "hermes-default",
      messages: [{ role: "user", content: "Navigate me nearby to a coffee shop" }],
    }, baseConfig(), fetchImpl as unknown as typeof fetch);
    expect(decision).toEqual({ kind: "escalate", reason: "live_location_data" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("escalates live status prompts before calling the fast model", async () => {
    const fetchImpl = vi.fn(async () => new Response("should not be called", { status: 500 }));
    const decision = await tryRapid({
      model: "hermes-default",
      messages: [{ role: "user", content: "How many people are on the minecraft server?" }],
    }, baseConfig(), fetchImpl as unknown as typeof fetch);
    expect(decision).toEqual({ kind: "escalate", reason: "live_status" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("escalates server questions before calling the fast model", async () => {
    const fetchImpl = vi.fn(async () => new Response("should not be called", { status: 500 }));
    const decision = await tryRapid({
      model: "hermes-default",
      messages: [{ role: "user", content: "How are my servers doing?" }],
    }, baseConfig(), fetchImpl as unknown as typeof fetch);
    expect(decision).toEqual({ kind: "escalate", reason: "servers" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not pre-escalate plain weather questions", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: "gemini-3-flash-preview",
      choices: [{ message: { role: "assistant", content: "Sunny, about 72F." }, finish_reason: "stop" }],
    }), { status: 200 }));
    const decision = await tryRapid({
      model: "hermes-default",
      messages: [{ role: "user", content: "What's the weather like today?" }],
    }, baseConfig(), fetchImpl as unknown as typeof fetch);
    expect(decision).toEqual({ kind: "answer", content: "Sunny, about 72F.", model: "gemini-3-flash-preview" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
