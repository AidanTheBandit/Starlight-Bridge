import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Manages a dynamic set of MCP tools that can be registered and unregistered at runtime.
 *
 * The bridge hosts this MCP server at /mcp. When an OpenAI request arrives with
 * `tools: [...]`, those tools are registered here so the ACP agent can see and call them.
 * When the request completes, tools are unregistered.
 */

export interface RegisteredTool {
  name: string;
  description: string;
  /** Raw JSON Schema for input — as provided in the OpenAI tools[] array. */
  inputSchema: Record<string, unknown>;
  /** Optional execution handler. If absent, returns a placeholder result. */
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
}

// Global tool registry — shared across all MCP connections for the current request
const toolRegistry = new Map<string, RegisteredTool>();

/**
 * Register tools. Merges with existing tools (doesn't clear).
 * If a tool with the same name already exists, it's overwritten.
 */
export function setTools(newTools: RegisteredTool[]): void {
  for (const tool of newTools) {
    toolRegistry.set(tool.name, tool);
  }
}

/**
 * Register tools, replacing the entire set.
 */
export function replaceTools(newTools: RegisteredTool[]): void {
  toolRegistry.clear();
  for (const tool of newTools) {
    toolRegistry.set(tool.name, tool);
  }
}

/**
 * Clear all registered tools.
 */
export function clearTools(): void {
  toolRegistry.clear();
}

/**
 * Get all currently registered tool names.
 */
export function getToolNames(): string[] {
  return Array.from(toolRegistry.keys());
}

/**
 * Convert a JSON Schema properties object to a zod-like raw shape.
 *
 * The MCP SDK's registerTool takes inputSchema as a ZodRawShapeCompat — a
 * Record<string, z.ZodType>. We can't build proper zod validators from arbitrary
 * JSON schemas without a full converter, but the SDK also accepts raw schemas
 * via the low-level Server API.
 *
 * Instead we use the low-level `Server` directly to register tools with raw
 * JSON Schema, bypassing zod entirely.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Create a low-level MCP Server that serves tools from the global registry.
 * Uses raw JSON Schema instead of zod — no validation constraints needed
 * since the agent generates the args and we trust the schema match.
 */
export function createDynamicMcpServer(): Server {
  const server = new Server(
    { name: "starlight-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // List tools — returns current registry
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const toolsList = Array.from(toolRegistry.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools: toolsList };
  });

  // Call tool — execute the handler or return placeholder
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolRegistry.get(name);

    if (!tool) {
      return {
        content: [
          { type: "text" as const, text: `Tool "${name}" not found` },
        ],
        isError: true,
      };
    }

    if (tool.handler) {
      try {
        const result = await tool.handler(args ?? {});
        return {
          content: [
            {
              type: "text" as const,
              text: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Tool error: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    // No handler — return a placeholder so the agent loop continues
    return {
      content: [
        {
          type: "text" as const,
          text: `Tool "${name}" acknowledged. Args: ${JSON.stringify(args ?? {})}`,
        },
      ],
    };
  });

  return server;
}

export { toolRegistry };
