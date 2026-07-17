// ─── OpenAI-compatible request/response types ────────────────────────

export interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool" | "function";
  content: OpenAIMessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export type OpenAIMessageContent = string | OpenAIContentPart[] | null;

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: string | { url: string; detail?: "auto" | "low" | "high" };
    };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  n?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  /** Starlight extension: explicit conversation correlation key. */
  conversation_id?: string;
  user?: string;
}

export interface OpenAIChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIStreamDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code?: string;
    param?: string | null;
  };
}

export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}
