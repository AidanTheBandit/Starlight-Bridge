import { describe, it, expect } from "vitest";
import { resolveACPClient, stripPrefix } from "../src/router.js";
import type { Config } from "../src/config.js";

// acp_clients pre-sorted by longest prefix (as loadConfig does)
const mockConfig: Config = {
  server: { host: "0.0.0.0", port: 7878, tls: { enabled: false } },
  tokens: [],
  acp_clients: [
    { model_prefix: "hermes-dev", command: "hermes-dev", args: ["acp"], env: {}, cwd: null },
    { model_prefix: "hermes", command: "hermes", args: ["acp"], env: {}, cwd: null },
    { model_prefix: "claude", command: "claude", args: [], env: {}, cwd: null },
  ],
  sessions: { persist: true, idle_timeout: 300, max_sessions: 10 },
  mcp: { server_name: "starlight-bridge", cleanup_after_request: true, pin_tools: false, pin_base_url: "http://127.0.0.1:8080", photo_max_base64_chars: 1000 },
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

describe("resolveACPClient", () => {
  it("resolves hermes prefix", () => {
    const client = resolveACPClient(mockConfig, "hermes-glm-5.2");
    expect(client).not.toBeNull();
    expect(client!.command).toBe("hermes");
  });

  it("resolves claude prefix", () => {
    const client = resolveACPClient(mockConfig, "claude-sonnet-4");
    expect(client).not.toBeNull();
    expect(client!.command).toBe("claude");
  });

  it("returns null for unknown prefix", () => {
    expect(resolveACPClient(mockConfig, "unknown-model")).toBeNull();
  });

  it("uses longest prefix match", () => {
    // "hermes-dev" is longer than "hermes", so "hermes-dev-x" should match hermes-dev
    const client = resolveACPClient(mockConfig, "hermes-dev-something");
    expect(client).not.toBeNull();
    expect(client!.model_prefix).toBe("hermes-dev");
    expect(client!.command).toBe("hermes-dev");
  });
});

describe("stripPrefix", () => {
  it("strips prefix with dash", () => {
    expect(stripPrefix("hermes-glm-5.2", "hermes")).toBe("glm-5.2");
  });

  it("returns model as-is if no dash after prefix", () => {
    expect(stripPrefix("hermes", "hermes")).toBe("hermes");
  });

  it("returns model as-is if prefix doesn't match", () => {
    expect(stripPrefix("claude-sonnet", "hermes")).toBe("claude-sonnet");
  });
});
