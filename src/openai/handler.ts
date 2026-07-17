import type { Context } from "hono";
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { validateToken, isModelAllowed } from "../auth.js";
import { resolveACPClient, stripPrefix } from "../router.js";
import { createSession, markBusy, markIdle } from "../acp/manager.js";
import { ConversationRegistry } from "../acp/conversations.js";
import type { ACPSession } from "../acp/session.js";
import { setTools } from "../mcp/store.js";
import type { OpenAIRequest, OpenAIResponse, OpenAIError, OpenAITool } from "./types.js";
import { streamACPToOpenAI } from "./stream.js";
import { passthrough } from "./passthrough.js";
import { buildACPPrompt, instructionFingerprint, resolveConversationId } from "./messages.js";

/** Must match penumbra dumb_backend DEFERRED_VISION_MARKER */
const DEFERRED_VISION_MARKER = "__HUMANE_DEFERRED_VISION__";
const conversations = new ConversationRegistry<ACPSession>();

function errorResponse(c: Context, status: number, message: string, type: string) {
  const body: OpenAIError = { error: { message, type } };
  return c.json(body, status as 400 | 401 | 403 | 404 | 500);
}

export async function handleChatCompletions(c: Context, config: Config) {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const tokenInfo = validateToken(config, token);
  if (!tokenInfo) {
    return errorResponse(c, 401, "Invalid or missing API key", "invalid_api_key");
  }

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

  if (!isModelAllowed(tokenInfo, body.model)) {
    return errorResponse(c, 403, `Token not authorized for model: ${body.model}`, "model_forbidden");
  }

  // ── Passthrough mode: proxy straight to upstream LLM API ──────────
  if (config.passthrough.enabled) {
    return passthrough(c, config);
  }

  // ── ACP mode: spawn agent, register MCP tools ─────────────────────
  const acpClient = resolveACPClient(config, body.model);
  if (!acpClient) {
    return errorResponse(c, 404, `No ACP client for model: ${body.model}`, "no_backend");
  }

  const agentModel = stripPrefix(body.model, acpClient.model_prefix);

  // Register tools as MCP
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

  if (validTools.length > 0) {
    setTools(
      validTools.map((t) => ({
        name: t.function.name,
        description: t.function.description ?? "",
        inputSchema: t.function.parameters ?? { type: "object", properties: {} },
      })),
    );
  }

  // Always pass MCP server if tools exist
  const { toolRegistry } = await import("../mcp/store.js");
  const hasTools = validTools.length > 0 || toolRegistry.size > 0;
  const mcpServers = hasTools
    ? [{
        name: config.mcp.server_name,
        type: "http" as const,
        url: `http://127.0.0.1:${config.server.port}/mcp`,
        headers: [],
      }]
    : [];

  let conversationId: string | undefined;
  let fingerprint: string | undefined;
  let firstPrompt;
  try {
    if (body.conversation_id != null && typeof body.conversation_id !== "string") {
      throw new Error("conversation_id must be a string");
    }
    conversationId = resolveConversationId(
      c.req.header("X-Starlight-Conversation-ID"),
      body.conversation_id,
    );
    fingerprint = instructionFingerprint(body.messages);
    firstPrompt = buildACPPrompt(body.messages, true);
  } catch (err) {
    return errorResponse(c, 400, (err as Error).message, "invalid_request");
  }

  const conversationKey = config.sessions.persist && conversationId
    ? createHash("sha256")
      .update(token)
      .update("\0")
      .update(body.model)
      .update("\0")
      .update(conversationId)
      .digest("hex")
    : undefined;

  let acquired;
  try {
    acquired = await conversations.acquire({
      key: conversationKey,
      fingerprint,
      maxEntries: config.sessions.max_sessions,
      idleTimeoutMs: config.sessions.idle_timeout * 1000,
      create: async () => {
        const created = await createSession(acpClient, process.cwd(), mcpServers);
        if (agentModel && agentModel !== "default") {
          await created.setModel(agentModel).catch(() => {});
        }
        return created;
      },
    });
  } catch (err) {
    return errorResponse(c, 500, `Failed to create ACP session: ${(err as Error).message}`, "backend_error");
  }

  const session = acquired.session;
  let prompt;
  try {
    prompt = acquired.reused ? buildACPPrompt(body.messages, false) : firstPrompt;
  } catch (err) {
    if (acquired.persistent) {
      await conversations.invalidate(conversationKey, session);
    } else {
      await session.dispose().catch(() => {});
    }
    return errorResponse(c, 400, (err as Error).message, "invalid_request");
  }

  const disposeAfterRequest = !acquired.persistent && config.mcp.cleanup_after_request;

  if (body.stream) {
    markBusy(acpClient.model_prefix);
    return streamACPToOpenAI(
      c,
      session,
      prompt,
      body.model,
      config,
      acpClient.model_prefix,
      disposeAfterRequest,
      acquired.persistent
        ? () => conversations.invalidate(conversationKey, session)
        : undefined,
    );
  }

  markBusy(acpClient.model_prefix);
  try {
    let responseText = await session.prompt(prompt);
    if (disposeAfterRequest) {
      await session.dispose().catch(() => {});
    }

    // If Hermes decided the pin needs the camera, collapse to the exact sentinel
    // penumbra dumb mode maps to ChatResult::DeferredVision → UnderstandScene action.
    if (responseText.includes(DEFERRED_VISION_MARKER)) {
      responseText = DEFERRED_VISION_MARKER;
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
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return c.json(response);
  } catch (err) {
    if (acquired.persistent) {
      await conversations.invalidate(conversationKey, session);
    } else {
      await session.dispose().catch(() => {});
    }
    return errorResponse(c, 500, `ACP agent error: ${(err as Error).message}`, "backend_error");
  } finally {
    markIdle(acpClient.model_prefix);
  }
}
