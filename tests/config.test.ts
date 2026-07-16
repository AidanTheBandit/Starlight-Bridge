import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("loadConfig", () => {
  it("loads a valid config", () => {
    const path = join(tmpdir(), `starlight-test-${randomUUID()}.yml`);
    writeFileSync(path, `
server:
  host: "127.0.0.1"
  port: 9999
tokens:
  - token: "test-token"
    name: "Test"
    allowed_models:
      - "hermes-*"
acp_clients:
  - model_prefix: "hermes"
    command: "hermes"
    args: ["acp"]
`);
    try {
      const config = loadConfig(path);
      expect(config.server.host).toBe("127.0.0.1");
      expect(config.server.port).toBe(9999);
      expect(config.tokens).toHaveLength(1);
      expect(config.tokens[0].token).toBe("test-token");
      expect(config.acp_clients).toHaveLength(1);
      expect(config.acp_clients[0].model_prefix).toBe("hermes");
      // defaults
      expect(config.sessions.persist).toBe(true);
      expect(config.mcp.server_name).toBe("starlight-bridge");
    } finally {
      unlinkSync(path);
    }
  });

  it("throws on missing file", () => {
    expect(() => loadConfig("/nonexistent/path.yml")).toThrow("Failed to load config");
  });

  it("throws on invalid config (missing tokens)", () => {
    const path = join(tmpdir(), `starlight-test-bad-${randomUUID()}.yml`);
    writeFileSync(path, `
server:
  port: 7878
acp_clients: []
`);
    try {
      expect(() => loadConfig(path)).toThrow();
    } finally {
      unlinkSync(path);
    }
  });

  it("rejects empty tokens", () => {
    const path = join(tmpdir(), `starlight-test-empty-token-${randomUUID()}.yml`);
    writeFileSync(path, `
server:
  port: 7878
tokens:
  - token: ""
    name: "Empty"
acp_clients:
  - model_prefix: "hermes"
    command: "hermes"
`);
    try {
      expect(() => loadConfig(path)).toThrow();
    } finally {
      unlinkSync(path);
    }
  });

  it("pre-sorts acp_clients by longest prefix", () => {
    const path = join(tmpdir(), `starlight-test-sort-${randomUUID()}.yml`);
    writeFileSync(path, `
tokens:
  - token: "t"
acp_clients:
  - model_prefix: "hermes"
    command: "hermes"
  - model_prefix: "hermes-dev"
    command: "hermes-dev"
`);
    try {
      const config = loadConfig(path);
      // Longest first
      expect(config.acp_clients[0].model_prefix).toBe("hermes-dev");
      expect(config.acp_clients[1].model_prefix).toBe("hermes");
    } finally {
      unlinkSync(path);
    }
  });

  it("requires TLS cert/key when enabled", () => {
    const path = join(tmpdir(), `starlight-test-tls-${randomUUID()}.yml`);
    writeFileSync(path, `
server:
  tls:
    enabled: true
tokens:
  - token: "t"
acp_clients:
  - model_prefix: "hermes"
    command: "hermes"
`);
    try {
      expect(() => loadConfig(path)).toThrow(/TLS cert and key/);
    } finally {
      unlinkSync(path);
    }
  });
});
