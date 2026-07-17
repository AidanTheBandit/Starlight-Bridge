import { beforeEach, describe, expect, it } from "vitest";
import {
  clearScopedTools,
  clearTools,
  getToolsForScope,
  setScopedTools,
  setTools,
} from "../src/mcp/store.js";

const schema = { type: "object", properties: {} };

describe("scoped MCP tool registries", () => {
  beforeEach(() => clearTools());

  it("combines configured tools with only the requested client scope", () => {
    setTools([{ name: "builtin", description: "base", inputSchema: schema }]);
    setScopedTools("scope-a", [{ name: "private_a", description: "a", inputSchema: schema }]);
    setScopedTools("scope-b", [{ name: "private_b", description: "b", inputSchema: schema }]);

    expect([...getToolsForScope("scope-a").keys()]).toEqual(["builtin", "private_a"]);
    expect([...getToolsForScope("scope-b").keys()]).toEqual(["builtin", "private_b"]);
    expect([...getToolsForScope().keys()]).toEqual(["builtin"]);
  });

  it("rejects client tools that shadow configured tools", () => {
    setTools([{ name: "weather", description: "base", inputSchema: schema }]);
    expect(() => setScopedTools("scope", [
      { name: "weather", description: "client", inputSchema: schema },
    ])).toThrow(/conflicts/i);
  });

  it("removes one scope without affecting another", () => {
    setScopedTools("scope-a", [{ name: "a", description: "a", inputSchema: schema }]);
    setScopedTools("scope-b", [{ name: "b", description: "b", inputSchema: schema }]);
    clearScopedTools("scope-a");
    expect([...getToolsForScope("scope-a").keys()]).toEqual([]);
    expect([...getToolsForScope("scope-b").keys()]).toEqual(["b"]);
  });
});
