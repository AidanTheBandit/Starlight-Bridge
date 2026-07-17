import type { Config } from "../config.js";
import type { OpenAIMessage, OpenAIRequest, OpenAIResponse } from "./types.js";

export type RapidDecision =
  | { kind: "answer"; content: string; model: string }
  | { kind: "escalate"; reason: string }
  | { kind: "skip"; reason: string };

interface RapidUpstreamChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

interface RapidUpstreamResponse {
  model?: string;
  choices?: RapidUpstreamChoice[];
}

function textFromContent(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function lastUserText(messages: OpenAIRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    return textFromContent(msg.content).trim();
  }
  return "";
}

function hasNonTextUserContent(messages: OpenAIRequest["messages"]): boolean {
  return messages.some((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string" || msg.content == null) return false;
    return msg.content.some((part) => part.type !== "text");
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1\/chat\/completions$/i, "");
}

function buildRapidMessages(body: OpenAIRequest, systemPrompt: string): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];
  for (const msg of body.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = textFromContent(msg.content);
      if (text.trim()) out.push({ role: "system", content: text });
      continue;
    }
    if (msg.role === "assistant" || msg.role === "user") {
      // Rapid mode is text-only. Drop tool/function messages and non-text parts.
      const text = textFromContent(msg.content);
      if (text.trim()) out.push({ role: msg.role, content: text });
    }
  }
  return out;
}

/**
 * Try the configured fast model first.
 *
 * Returns an immediate answer, an escalate decision (caller should run ACP),
 * or skip when rapid mode should not run for this request.
 */
export async function tryRapid(
  body: OpenAIRequest,
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<RapidDecision> {
  const rapid = config.rapid;
  if (!rapid?.enabled) return { kind: "skip", reason: "disabled" };
  if (!rapid.api_key) return { kind: "skip", reason: "missing_api_key" };
  if (config.passthrough?.enabled) return { kind: "skip", reason: "passthrough_enabled" };

  // Client-supplied tools mean the caller expects agentic tool use — go ACP.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return { kind: "skip", reason: "client_tools_present" };
  }
  if (hasNonTextUserContent(body.messages)) {
    return { kind: "skip", reason: "non_text_content" };
  }
  if (!lastUserText(body.messages)) {
    return { kind: "skip", reason: "empty_user_message" };
  }

  const escalateTool = rapid.escalate_tool || "escalate_to_agent";
  const base = normalizeBaseUrl(rapid.base_url);
  const url = `${base}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, rapid.timeout_ms));

  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rapid.api_key}`,
      },
      body: JSON.stringify({
        model: rapid.model,
        stream: false,
        temperature: 0.2,
        messages: buildRapidMessages(body, rapid.system_prompt),
        tools: [
          {
            type: "function",
            function: {
              name: escalateTool,
              description:
                "Hand this request to the full agent path. Call when tools, device access, current data, multi-step work, or uncertainty is required.",
              parameters: {
                type: "object",
                properties: {
                  reason: {
                    type: "string",
                    description: "Short reason the full agent is needed.",
                  },
                },
                required: ["reason"],
              },
            },
          },
        ],
        tool_choice: "auto",
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return {
        kind: "escalate",
        reason: `rapid upstream ${resp.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`,
      };
    }

    const data = (await resp.json()) as RapidUpstreamResponse;
    const choice = data.choices?.[0];
    const message = choice?.message;
    if (!message) return { kind: "escalate", reason: "empty_rapid_response" };

    const toolCalls = message.tool_calls ?? [];
    const escalateCall = toolCalls.find((call) => call.function?.name === escalateTool);
    if (escalateCall) {
      let reason = "escalate_to_agent";
      try {
        const args = JSON.parse(escalateCall.function?.arguments || "{}") as { reason?: string };
        if (args.reason?.trim()) reason = args.reason.trim();
      } catch {
        // keep default
      }
      return { kind: "escalate", reason };
    }

    if (toolCalls.length > 0) {
      // Any unexpected tool is treated as an ACP handoff.
      return { kind: "escalate", reason: `unexpected_tool:${toolCalls[0]?.function?.name ?? "unknown"}` };
    }

    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!content) return { kind: "escalate", reason: "empty_content" };

    return {
      kind: "answer",
      content,
      model: data.model || rapid.model,
    };
  } catch (err) {
    const msg = (err as Error).name === "AbortError"
      ? "rapid_timeout"
      : `rapid_error:${(err as Error).message}`;
    return { kind: "escalate", reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function rapidAnswerResponse(
  requestModel: string,
  content: string,
  _rapidModel: string,
): OpenAIResponse {
  return {
    id: `chatcmpl-rapid-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
