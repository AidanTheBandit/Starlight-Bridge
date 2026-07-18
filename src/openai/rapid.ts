import type { Config } from "../config.js";
import type { RegisteredTool } from "../mcp/store.js";
import type { OpenAIMessage, OpenAIRequest, OpenAIResponse, OpenAITool } from "./types.js";

export type RapidDecision =
  | { kind: "answer"; content: string; model: string }
  | { kind: "escalate"; reason: string }
  | { kind: "skip"; reason: string };

type RapidToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

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

/** Heuristic: technical / toolful / live-status prompts skip rapid and go to ACP. */
export function shouldEscalateToAgent(text: string): string | null {
  const t = text.toLowerCase();
  if (!t.trim()) return null;

  // Product-neutral only. No hostnames, nicknames, or vendor facts.
  const patterns: Array<[RegExp, string]> = [
    // Live status the fast model cannot know
    [/\b(how many (people|players|users)|player count|online (now|right now)|server status|is (the )?server (up|down|online)|who('s| is) (on|online))\b/, "live_status"],
    // Simple generic tool requests may be handled by rapid when those tools are available.
    [/\b(nearby|directions|navigate|maps?)\b/, "live_location_data"],
    [/\b(wifi|cellular|battery|device status|toggle (wifi|cellular))\b/, "device_control"],
    // Coding / technical
    [/\b(code|coding|debug|debugger|stacktrace|stack trace|exception|segfault|compile|compiler)\b/, "coding"],
    [/\b(typescript|javascript|python|rust|kotlin|java|golang|c\+\+|sql|regex)\b/, "programming_language"],
    [/\b(function|class |import |export |const |let |var |async |await |promise|api endpoint)\b/, "code_syntax"],
    [/\b(git|github|pull request|merge conflict|dockerfile|kubernetes|k8s|helm|terraform)\b/, "devops"],
    // Servers / infra
    [/\b(servers?|vps|hosting|datacenter|data center|rack|uptime|latency|bandwidth)\b/, "servers"],
    [/\b(ssh|deploy|deployment|systemd|nginx|apache|caddy|docker|container|ci\/cd|firewall|iptables|selinux)\b/, "infra"],
    [/\b(reverse engineer|decompile|frida|protobuf|grpc|json-rpc|mcp|acp)\b/, "systems_engineering"],
    [/\b(config|configuration|yaml|toml|json schema|env var|environment variable)\b/, "config_work"],
    [/\b(implement|refactor|patch|fix the bug|write a script|unit test|integration test)\b/, "engineering_task"],
    // Multi-step / research
    [/\b(browse|search the web|look up|research|scrape|crawl)\b/, "browsing"],
    [/\b(step by step|multi-?step|plan out|architecture|design a system)\b/, "multi_step"],
  ];

  for (const [re, reason] of patterns) {
    if (re.test(t)) return reason;
  }
  return null;
}

function rapidTools(tools: RegisteredTool[], escalateTool: string): OpenAITool[] {
  const configured = tools
    .filter((tool) => tool.handler)
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  return [
    ...configured,
    {
      type: "function" as const,
      function: {
        name: escalateTool,
        description:
          "Hand this request to Hermes/ACP. MUST call for coding, infrastructure, multi-step work, unsupported tools, camera image analysis, or uncertainty.",
        parameters: {
          type: "object",
          properties: { reason: { type: "string", description: "Short reason." } },
          required: ["reason"],
        },
      },
    },
  ];
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
      // Pass text; for user turns also pass image_url parts so rapid can do vision Q&A.
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const parts = msg.content.filter(
          (part) =>
            (part.type === "text" && typeof part.text === "string") ||
            part.type === "image_url",
        );
        if (parts.length > 0) {
          out.push({ role: "user", content: parts as OpenAIMessage["content"] });
          continue;
        }
      }
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
  tools: RegisteredTool[] = [],
  executeTool?: RapidToolExecutor,
): Promise<RapidDecision> {
  const rapid = config.rapid;
  if (!rapid?.enabled) return { kind: "skip", reason: "disabled" };
  if (!rapid.api_key) return { kind: "skip", reason: "missing_api_key" };
  if (config.passthrough?.enabled) return { kind: "skip", reason: "passthrough_enabled" };

  // Client-supplied tools mean the caller expects agentic tool use — go ACP.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return { kind: "skip", reason: "client_tools_present" };
  }
  // Multimodal content is allowed for vision Q&A (rapid model may answer from images).
  // Non-text non-image parts still skip.
  const hasUnsupportedParts = body.messages.some((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string" || msg.content == null) return false;
    return msg.content.some((part) => part.type !== "text" && part.type !== "image_url");
  });
  if (hasUnsupportedParts) {
    return { kind: "skip", reason: "unsupported_content" };
  }
  const userText = lastUserText(body.messages);
  if (!userText && !hasNonTextUserContent(body.messages)) {
    return { kind: "skip", reason: "empty_user_message" };
  }
  // Deterministic escalate for technical / toolful requests before calling the fast model.
  if (userText) {
    const reason = shouldEscalateToAgent(userText);
    const simpleToolReasons = new Set(["live_location_data", "device_control"]);
    if (reason && !(simpleToolReasons.has(reason) && tools.some((tool) => tool.handler))) {
      return { kind: "escalate", reason };
    }
  }

  const escalateTool = rapid.escalate_tool || "escalate_to_agent";
  const base = normalizeBaseUrl(rapid.base_url);
  const url = `${base}/chat/completions`;
  const rapidMessages = buildRapidMessages(body, rapid.system_prompt);
  const availableTools = rapidTools(tools, escalateTool);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, rapid.timeout_ms));

  try {
    for (let turn = 0; turn < 2; turn++) {
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
          messages: rapidMessages,
          tools: availableTools,
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
        const call = toolCalls[0];
        const name = call.function?.name ?? "";
        const registered = tools.find((tool) => tool.name === name);
        if (!executeTool || !registered) {
          return { kind: "escalate", reason: `unavailable_tool:${name || "unknown"}` };
        }
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
        } catch {
          return { kind: "escalate", reason: `invalid_tool_args:${name}` };
        }
        let result: unknown;
        try {
          result = await executeTool(name, args);
        } catch (err) {
          result = { error: (err as Error).message };
        }
        rapidMessages.push({
          role: "assistant",
          content: typeof message.content === "string" ? message.content : null,
          tool_calls: toolCalls as OpenAIMessage["tool_calls"],
        });
        rapidMessages.push({
          role: "tool",
          tool_call_id: call.id || `${name}-${turn}`,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
        continue;
      }

      const content = typeof message.content === "string" ? message.content.trim() : "";
      if (!content) return { kind: "escalate", reason: "empty_content" };

      return {
        kind: "answer",
        content,
        model: data.model || rapid.model,
      };
    }
    return { kind: "escalate", reason: "rapid_tool_loop_limit" };
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
