import { describe, it, expect } from "vitest";
import { validateToken, isModelAllowed } from "../src/auth.js";
import type { Config, Token } from "../src/config.js";

const mockConfig: Config = {
  server: { host: "0.0.0.0", port: 7878, tls: { enabled: false } },
  tokens: [
    { token: "abc", name: "App1", allowed_models: ["hermes-*"] },
    { token: "xyz", name: "App2", allowed_models: ["*"] },
    { token: "restricted", name: "App3", allowed_models: ["hermes-glm-5.2"] },
  ],
  acp_clients: [],
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
  response: {
    strip_markdown: false,
  },

};

describe("validateToken", () => {
  it("returns token info for known token", () => {
    const result = validateToken(mockConfig, "abc");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("App1");
  });

  it("returns null for unknown token", () => {
    expect(validateToken(mockConfig, "nope")).toBeNull();
  });

  it("returns null for empty token", () => {
    expect(validateToken(mockConfig, "")).toBeNull();
  });
});

describe("isModelAllowed", () => {
  it("allows glob match (hermes-*)", () => {
    const token = validateToken(mockConfig, "abc")!;
    expect(isModelAllowed(token, "hermes-glm-5.2")).toBe(true);
    expect(isModelAllowed(token, "hermes-anything")).toBe(true);
  });

  it("rejects non-matching model for restricted token", () => {
    const token = validateToken(mockConfig, "abc")!;
    expect(isModelAllowed(token, "claude-sonnet-4")).toBe(false);
  });

  it("allows wildcard (*)", () => {
    const token = validateToken(mockConfig, "xyz")!;
    expect(isModelAllowed(token, "anything-goes")).toBe(true);
    expect(isModelAllowed(token, "hermes-x")).toBe(true);
    expect(isModelAllowed(token, "claude-y")).toBe(true);
  });

  it("allows exact match", () => {
    const token = validateToken(mockConfig, "restricted")!;
    expect(isModelAllowed(token, "hermes-glm-5.2")).toBe(true);
    expect(isModelAllowed(token, "hermes-other")).toBe(false);
  });

  it("treats ? as a literal character, not a wildcard", () => {
    const token: Token = { token: "x", allowed_models: ["foo?bar"] };
    expect(isModelAllowed(token, "foo?bar")).toBe(true);
    expect(isModelAllowed(token, "fooxbar")).toBe(false);
  });
});
