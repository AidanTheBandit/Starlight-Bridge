import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface RegisteredTool {
  name: string;
  description: string;
  /** Raw JSON Schema for input, as provided in OpenAI tools[]. */
  inputSchema: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Configured bridge tools shared intentionally by every MCP scope. */
export const toolRegistry = new Map<string, RegisteredTool>();
/** Client tools isolated by opaque conversation/session scope. */
const scopedToolRegistries = new Map<string, Map<string, RegisteredTool>>();

export function setTools(newTools: RegisteredTool[]): void {
  for (const tool of newTools) toolRegistry.set(tool.name, tool);
}

export function replaceTools(newTools: RegisteredTool[]): void {
  toolRegistry.clear();
  setTools(newTools);
}

export function clearTools(): void {
  toolRegistry.clear();
  scopedToolRegistries.clear();
}

export function getToolNames(): string[] {
  return Array.from(toolRegistry.keys());
}

export function setScopedTools(scope: string, tools: RegisteredTool[]): void {
  const registry = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    if (toolRegistry.has(tool.name)) {
      throw new Error(`Client tool \"${tool.name}\" conflicts with a configured bridge tool`);
    }
    if (registry.has(tool.name)) {
      throw new Error(`Duplicate client tool name: ${tool.name}`);
    }
    registry.set(tool.name, tool);
  }
  if (registry.size > 0) scopedToolRegistries.set(scope, registry);
  else scopedToolRegistries.delete(scope);
}

export function clearScopedTools(scope: string): void {
  scopedToolRegistries.delete(scope);
}

export function getToolsForScope(scope?: string): Map<string, RegisteredTool> {
  const combined = new Map(toolRegistry);
  if (scope) {
    for (const [name, tool] of scopedToolRegistries.get(scope) ?? []) {
      combined.set(name, tool);
    }
  }
  return combined;
}

export function createDynamicMcpServer(scope?: string): Server {
  const server = new Server(
    { name: "starlight-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(getToolsForScope(scope).values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = getToolsForScope(scope).get(name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Tool \"${name}\" not found` }],
        isError: true,
      };
    }
    if (tool.handler) {
      try {
        const result = await tool.handler(args ?? {});
        return {
          content: [{
            type: "text" as const,
            text: typeof result === "string" ? result : JSON.stringify(result),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Tool error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
    return {
      content: [{
        type: "text" as const,
        text: `Tool \"${name}\" acknowledged. Args: ${JSON.stringify(args ?? {})}`,
      }],
    };
  });

  return server;
}
