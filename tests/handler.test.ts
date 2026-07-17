import { describe, it, expect } from "vitest";
import { createApp } from "../src/server.js";
import type { Config } from "../src/config.js";

const mockConfig: Config = {
  server: { host: "0.0.0.0", port: 7878, tls: { enabled: false } },
  tokens: [
    { token: "test-token", name: "Test", allowed_models: ["*"] },
  ],
  acp_clients: [
    { model_prefix: "hermes", command: "hermes", args: ["acp"], env: {}, cwd: null },
  ],
  sessions: { persist: true, idle_timeout: 300, max_sessions: 10 },
  mcp: {
    server_name: "starlight-bridge",
    cleanup_after_request: true,
    pin_tools: true,
    pin_base_url: "http://penumbra.local:8080",
    photo_max_base64_chars: 350_000,
  },
  passthrough: {
    enabled: false,
    upstream_url: "http://127.0.0.1:8642",
    upstream_key: "",
    strip_tools: true,
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

describe("HTTP endpoints", () => {
  const app = createApp(mockConfig);

  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("acp_clients");
    expect(body).toHaveProperty("uptime_seconds");
  });

  it("GET /v1/models returns model list", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("hermes-default");
  });

  it("POST /v1/chat/completions rejects missing auth", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hermes-glm-5.2",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_api_key");
  });

  it("POST /v1/chat/completions rejects bad token", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({
        model: "hermes-glm-5.2",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /v1/chat/completions rejects missing model", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request");
  });

  it("POST /v1/chat/completions rejects unknown model prefix", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        model: "unknown-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("no_backend");
  });

  it("returns 404 for unknown endpoints", async () => {
    const res = await app.request("/v1/something-else");
    expect(res.status).toBe(404);
  });
});
