import type { Context } from "hono";
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { validateToken, isModelAllowed } from "../auth.js";
import { resolveACPClient, stripPrefix } from "../router.js";
import { createSession, markBusy, markIdle } from "../acp/manager.js";
import { ConversationRegistry } from "../acp/conversations.js";
import type { ACPSession } from "../acp/session.js";
import {
  clearScopedTools,
  setScopedTools,
  toolRegistry,
  type RegisteredTool,
} from "../mcp/store.js";
import type { OpenAIRequest, OpenAIResponse, OpenAIError, OpenAITool } from "./types.js";
import { streamACPToOpenAI } from "./stream.js";
import { passthrough } from "./passthrough.js";
import { buildACPPrompt, instructionFingerprint, resolveConversationId } from "./messages.js";

const DEFERRED_VISION_MARKER = "__HUMANE_DEFERRED_VISION__";
const conversations = new ConversationRegistry<ACPSession>();

function errorResponse(c: Context, status: number, message: string, type: string) {
  const body: OpenAIError = { error: { message, type } };
  return c.json(body, status as 400 | 401 | 403 | 404 | 500 | 503);
}

function clientTools(body: OpenAIRequest): RegisteredTool[] {
  const validTools: OpenAITool[] = Array.isArray(body.tools)
    ? body.tools.filter(
      (tool): tool is OpenAITool =>
        tool != null &&
        typeof tool === "object" &&
        tool.type === "function" &&
        tool.function != null &&
        typeof tool.function.name === "string" &&
        tool.function.name.length > 0,
    )
    : [];
  return validTools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    inputSchema: tool.function.parameters ?? { type: "object", properties: {} },
  }));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function sessionFingerprint(messages: OpenAIRequest["messages"], tools: RegisteredTool[]): string {
  const toolDefinitions = tools
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256")
    .update(instructionFingerprint(messages))
    .update("\0")
    .update(JSON.stringify(canonicalize(toolDefinitions)))
    .digest("hex");
}

export async function handleChatCompletions(c: Context, config: Config) {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const tokenInfo = validateToken(config, token);
  if (!tokenInfo) return errorResponse(c, 401, "Invalid or missing API key", "invalid_api_key");

  let body: OpenAIRequest;
  try {
    body = await c.req.json<OpenAIRequest>();
  } catch {
    return errorResponse(c, 400, "Invalid JSON in request body", "invalid_request");
  }
  if (!body.model) return errorResponse(c, 400, "Missing required field: model", "invalid_request");
  if (!body.messages || body.messages.length === 0) {
    return errorResponse(c, 400, "Missing required field: messages", "invalid_request");
  }
  if (!isModelAllowed(tokenInfo, body.model)) {
    return errorResponse(c, 403, `Token not authorized for model: ${body.model}`, "model_forbidden");
  }

  if (config.passthrough.enabled) return passthrough(c, config);

  const acpClient = resolveACPClient(config, body.model);
  if (!acpClient) return errorResponse(c, 404, `No ACP client for model: ${body.model}`, "no_backend");
  const agentModel = stripPrefix(body.model, acpClient.model_prefix);

  let conversationId: string | undefined;
  let firstPrompt;
  let tools: RegisteredTool[];
  try {
    if (body.conversation_id != null && typeof body.conversation_id !== "string") {
      throw new Error("conversation_id must be a string");
    }
    conversationId = resolveConversationId(
      c.req.header("X-Starlight-Conversation-ID"),
      body.conversation_id,
    );
    firstPrompt = buildACPPrompt(body.messages, true);
    tools = clientTools(body);
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
  const fingerprint = sessionFingerprint(body.messages, tools);
  const toolScope = tools.length > 0
    ? createHash("sha256")
      .update(conversationKey ?? randomUUID())
      .update("\0")
      .update(fingerprint)
      .digest("hex")
    : undefined;

  try {
    if (toolScope) setScopedTools(toolScope, tools);
  } catch (err) {
    return errorResponse(c, 400, (err as Error).message, "invalid_request");
  }

  const mcpServers = toolRegistry.size > 0 || toolScope
    ? [{
      name: config.mcp.server_name,
      type: "http" as const,
      url: `http://127.0.0.1:${config.server.port}${toolScope ? `/mcp/${toolScope}` : "/mcp"}`,
      headers: [],
    }]
    : [];

  let acquired;
  try {
    acquired = await conversations.acquire({
      key: conversationKey,
      fingerprint,
      maxEntries: config.sessions.max_sessions,
      idleTimeoutMs: config.sessions.idle_timeout * 1000,
      create: async () => {
        const created = await createSession(acpClient, process.cwd(), mcpServers);
        if (toolScope) created.onDisposed(() => clearScopedTools(toolScope));
        if (agentModel && agentModel !== "default") {
          await created.setModel(agentModel).catch(() => {});
        }
        return created;
      },
    });
  } catch (err) {
    if (toolScope) clearScopedTools(toolScope);
    const capacity = (err as Error).message.includes("capacity reached");
    return errorResponse(
      c,
      capacity ? 503 : 500,
      `Failed to create ACP session: ${(err as Error).message}`,
      capacity ? "capacity_exceeded" : "backend_error",
    );
  }

  const session = acquired.session;
  let prompt;
  try {
    prompt = acquired.reused ? buildACPPrompt(body.messages, false) : firstPrompt;
  } catch (err) {
    if (acquired.persistent) await conversations.invalidate(conversationKey, session);
    await acquired.release();
    return errorResponse(c, 400, (err as Error).message, "invalid_request");
  }

  // The registry owns disposal for ephemeral sessions when their lease ends.
  const disposeAfterRequest = false;

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
      () => acquired.release(),
    );
  }

  markBusy(acpClient.model_prefix);
  try {
    let responseText = await session.prompt(prompt);
    if (responseText.includes(DEFERRED_VISION_MARKER)) responseText = DEFERRED_VISION_MARKER;

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
    if (acquired.persistent) await conversations.invalidate(conversationKey, session);
    return errorResponse(c, 500, `ACP agent error: ${(err as Error).message}`, "backend_error");
  } finally {
    await acquired.release();
    markIdle(acpClient.model_prefix);
  }
}
