import { createDynamicMcpServer } from "./store.js";
import type { Config } from "../config.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * MCP HTTP endpoint handlers.
 *
 * The bridge serves MCP at /mcp using Streamable HTTP transport.
 * Tools are dynamically set per-request by the OpenAI handler.
 */

// We use the low-level Server directly with the StreamableHTTP transport.
// Since Hono gives us a web-standard Request and the transport wants
// Node.js IncomingMessage/ServerResponse, we bridge them.

export async function handleMcpRequest(
  request: Request,
  config: Config,
): Promise<Response> {
  // For stateless mode, create a fresh server per request
  const server = createDynamicMcpServer();

  try {
    // For now, handle the MCP protocol at the HTTP level manually.
    // This is simpler than trying to adapt Hono Request → Node IncomingMessage.
    const method = request.method;
    const body = method === "POST" ? await request.json() : null;

    if (!body) {
      return new Response(JSON.stringify({ error: "No body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle JSON-RPC
    const jsonrpc = body as { jsonrpc?: string; method?: string; id?: number; params?: unknown };

    if (jsonrpc.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: jsonrpc.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "starlight-bridge", version: "0.1.0" },
        },
      });
    }

    if (jsonrpc.method === "tools/list") {
      // Import the registry dynamically to get current tools
      const { toolRegistry } = await import("./store.js");
      const toolsList = Array.from(toolRegistry.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return Response.json({
        jsonrpc: "2.0",
        id: jsonrpc.id,
        result: { tools: toolsList },
      });
    }

    if (jsonrpc.method === "tools/call") {
      const { toolRegistry } = await import("./store.js");
      const params = jsonrpc.params as { name: string; arguments?: Record<string, unknown> };
      const tool = toolRegistry.get(params.name);

      if (!tool) {
        return Response.json({
          jsonrpc: "2.0",
          id: jsonrpc.id,
          result: {
            content: [{ type: "text", text: `Tool "${params.name}" not found` }],
            isError: true,
          },
        });
      }

      if (tool.handler) {
        try {
          const result = await tool.handler(params.arguments ?? {});
          return Response.json({
            jsonrpc: "2.0",
            id: jsonrpc.id,
            result: {
              content: [{
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result),
              }],
            },
          });
        } catch (err) {
          return Response.json({
            jsonrpc: "2.0",
            id: jsonrpc.id,
            result: {
              content: [{ type: "text", text: `Tool error: ${(err as Error).message}` }],
              isError: true,
            },
          });
        }
      }

      // No handler — placeholder
      return Response.json({
        jsonrpc: "2.0",
        id: jsonrpc.id,
        result: {
          content: [{
            type: "text",
            text: `Tool "${params.name}" acknowledged. Args: ${JSON.stringify(params.arguments ?? {})}`,
          }],
        },
      });
    }

    if (jsonrpc.method === "ping") {
      return Response.json({
        jsonrpc: "2.0",
        id: jsonrpc.id,
        result: {},
      });
    }

    // Unknown method
    return Response.json({
      jsonrpc: "2.0",
      id: jsonrpc.id ?? null,
      error: { code: -32601, message: `Method not found: ${jsonrpc.method}` },
    });
  } catch (err) {
    console.error("[starlight] MCP request error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: { message: "MCP server error", detail: (err as Error).message } }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Clean up all active MCP resources.
 */
export async function closeAllMcp(): Promise<void> {
  // Nothing to clean up in stateless mode
}
