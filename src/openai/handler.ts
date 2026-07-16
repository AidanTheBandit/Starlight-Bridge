import type { Context } from "hono";
import type { Config } from "../config.js";
import { validateToken, isModelAllowed } from "../auth.js";
import { resolveACPClient, stripPrefix } from "../router.js";
import { createSession, markBusy, markIdle } from "../acp/manager.js";
import type { OpenAIRequest, OpenAIResponse, OpenAIError, OpenAITool } from "./types.js";
import { streamACPToOpenAI } from "./stream.js";

function errorResponse(c: Context, status: number, message: string, type: string) {
  const body: OpenAIError = { error: { message, type } };
  return c.json(body, status as 400 | 401 | 403 | 404 | 500);
}

/**
 * Handle POST /v1/chat/completions
 *
 * 1. Authenticate token
 * 2. Check model permissions
 * 3. Resolve ACP client from model prefix
 * 4. Create ACP session (with optional MCP tools from request)
 * 5. Forward prompt, stream or return response
 */
export async function handleChatCompletions(c: Context, config: Config) {
  // ── Auth ──────────────────────────────────────────────────────────
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const tokenInfo = validateToken(config, token);
  if (!tokenInfo) {
    return errorResponse(c, 401, "Invalid or missing API key", "invalid_api_key");
  }

  // ── Parse body ────────────────────────────────────────────────────
  let body: OpenAIRequest;
  try {
    body = await c.req.json<OpenAIRequest>();
  } catch {
    return errorResponse(c, 400, "Invalid JSON in request body", "invalid_request");
  }

  if (!body.model) {
    return errorResponse(c, 400, "Missing required field: model", "invalid_request");
  }

  if (!body.messages || body.messages.length === 0) {
    return errorResponse(c, 400, "Missing required field: messages", "invalid_request");
  }

  // ── Model permission ──────────────────────────────────────────────
  if (!isModelAllowed(tokenInfo, body.model)) {
    return errorResponse(c, 403, `Token not authorized for model: ${body.model}`, "model_forbidden");
  }

  // ── Route to ACP client ───────────────────────────────────────────
  const acpClient = resolveACPClient(config, body.model);
  if (!acpClient) {
    return errorResponse(
      c, 404,
      `No ACP client configured for model prefix matching: ${body.model}`,
      "no_backend",
    );
  }

  const agentModel = stripPrefix(body.model, acpClient.model_prefix);

  // ── Build MCP servers from client-provided tools ──────────────────
  // Validate tools array: filter out entries lacking a valid function object
  const validTools: OpenAITool[] = Array.isArray(body.tools)
    ? body.tools.filter(
        (t): t is OpenAITool =>
          t != null &&
          typeof t === "object" &&
          t.type === "function" &&
          t.function != null &&
          typeof t.function.name === "string" &&
          t.function.name.length > 0,
      )
    : [];

  const scheme = config.server.tls?.enabled ? "https" : "http";
  const mcpServers = validTools.length > 0
    ? [{
        name: config.mcp.server_name,
        // HTTP/SSE transport so ACP can reach back to the bridge
        url: `${scheme}://127.0.0.1:${config.server.port}/mcp`,
        tools: validTools.map((t) => ({
          name: t.function.name,
          description: t.function.description ?? "",
          inputSchema: t.function.parameters ?? { type: "object", properties: {} },
        })),
      }]
    : undefined;

  // ── Create session ────────────────────────────────────────────────
  let session;
  try {
    session = await createSession(acpClient, process.cwd(), mcpServers);
    if (agentModel) {
      await session.setModel(agentModel).catch(() => {
        // Some ACP agents don't support session/model — that's fine
      });
    }
  } catch (err) {
    return errorResponse(
      c, 500,
      `Failed to create ACP session: ${(err as Error).message}`,
      "backend_error",
    );
  }

  // ── Extract user prompt ───────────────────────────────────────────
  const lastUser = body.messages.findLast((m) => m.role === "user");
  if (!lastUser || !lastUser.content) {
    await session.dispose().catch(() => {});
    return errorResponse(c, 400, "No user message found in messages array", "invalid_request");
  }

  const promptText = lastUser.content;

  // ── Stream or non-stream response ─────────────────────────────────
  if (body.stream) {
    // markBusy here; markIdle happens in stream's finally
    markBusy(acpClient.model_prefix);
    return streamACPToOpenAI(c, session, promptText, body.model, config, acpClient.model_prefix);
  }

  // Non-streaming
  markBusy(acpClient.model_prefix);
  try {
    const responseText = await session.prompt(promptText);

    if (config.mcp.cleanup_after_request) {
      await session.dispose().catch(() => {});
    }

    const response: OpenAIResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: responseText },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return c.json(response);
  } catch (err) {
    await session.dispose().catch(() => {});
    return errorResponse(
      c, 500,
      `ACP agent error: ${(err as Error).message}`,
      "backend_error",
    );
  } finally {
    markIdle(acpClient.model_prefix);
  }
}
