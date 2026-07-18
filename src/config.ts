import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────────────────

const TLSSchema = z.object({
  enabled: z.boolean().default(false),
  cert: z.string().optional(),
  key: z.string().optional(),
}).refine((data) => !data.enabled || (data.cert && data.key), {
  message: "TLS cert and key are required when enabled is true",
});

const TokenSchema = z.object({
  token: z.string().min(1, "Token must not be empty"),
  name: z.string().optional(),
  allowed_models: z.array(z.string()).default(["*"]),
});

const ACPClientSchema = z.object({
  model_prefix: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().nullable().default(null),
});

const SessionsSchema = z.object({
  persist: z.boolean().default(true),
  idle_timeout: z.number().default(300),
  max_sessions: z.number().default(10),
});

const MCPSchema = z.object({
  server_name: z.string().default("starlight-bridge"),
  cleanup_after_request: z.boolean().default(true),
  /** Register pin-equivalent tools (weather, reverse_geocode, nearby_search, photos) at startup. */
  pin_tools: z.boolean().default(true),
  /** Penumbra HTTP base on the pin for photo tools. */
  pin_base_url: z.string().default("http://penumbra.local:8080"),
  /** Max base64 chars returned by photo tools (protects context). */
  photo_max_base64_chars: z.number().default(350_000),
});

/**
 * Passthrough mode: proxy requests directly to an LLM API (e.g. Hermes API server)
 * without spawning an ACP agent. The client (e.g. PenumbraOS rig) handles its own tools.
 *
 * When mode is "acp" (default), Starlight spawns ACP agents and runs the full agent loop.
 * When mode is "passthrough", Starlight proxies to the upstream LLM API directly.
 */
const PassthroughSchema = z.object({
  enabled: z.boolean().default(false),
  upstream_url: z.string().default("http://127.0.0.1:8642"),
  upstream_key: z.string().default(""),
  /** When true, strip tools[] from requests (passthrough clients handle tools locally) */
  strip_tools: z.boolean().default(true),
});

/**
 * Rapid mode: answer simple prompts with a fast OpenAI-compatible model first.
 * The rapid model only gets an escalate_to_agent tool. If it escalates (or fails),
 * Starlight falls through to the normal ACP path. Disabled by default so generic
 * installs stay ACP-only.
 *
 * Intended scope: general Q&A, casual chat, weather, and vision only.
 * Live status, tools, device control, coding, and multi-step work escalate to ACP.
 * Keep this prompt product-neutral — no hostnames, devices, or vendor facts.
 */
const DEFAULT_RAPID_SYSTEM_PROMPT = [
  "You are RAPID, the optional fast path in front of a full agent.",
  "Your job is general Q&A, casual conversation, simple explanations, weather, quick math/unit conversion, vision when an image is already provided, and simple calls to the supplied generic tools.",
  "",
  "You are not the full agent. You cannot code, browse freely, execute shell commands, manage files, or perform multi-step technical work.",
  "Use a supplied tool when it directly answers a simple request (for example weather, nearby lookup, device status, or a simple setting toggle). Do not invent tool results.",
  "",
  "Escalate to Hermes for image interpretation after capture, live or private server status, coding, infrastructure, configuration, multi-step work, unsupported tools, or uncertainty.",
  "Prefer escalate_to_agent over guessing. Keep answers short and plain when you do answer.",
].join(" ");

const RapidSchema = z.object({
  enabled: z.boolean().default(false),
  /** OpenAI-compatible chat completions base URL (no trailing /v1/chat/completions). */
  base_url: z.string().default("https://generativelanguage.googleapis.com/v1beta/openai"),
  /** API key. Prefer STARLIGHT_RAPID_API_KEY env over committing secrets. */
  api_key: z.string().default(""),
  /** Upstream model id for the fast path. */
  model: z.string().default("gemini-3-flash-preview"),
  /** Tool name the fast model must call to hand control to ACP. */
  escalate_tool: z.string().default("escalate_to_agent"),
  /** Request timeout in ms for the rapid call. */
  timeout_ms: z.number().default(12_000),
  /**
   * System instruction that teaches the rapid model its limits.
   * Override in config for voice/tone; keep product facts out of the bridge.
   */
  system_prompt: z.string().default(DEFAULT_RAPID_SYSTEM_PROMPT),
});

/** Response shaping for clients that cannot render markdown (e.g. wearables). */
const ResponseSchema = z.object({
  /** Strip common markdown markers from assistant text when true. Default false. */
  strip_markdown: z.boolean().default(false),
});

const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().default(7878),
    tls: TLSSchema.default({ enabled: false }),
  }).default({ host: "0.0.0.0", port: 7878, tls: { enabled: false } }),
  tokens: z.array(TokenSchema).min(1, "At least one token is required"),
  acp_clients: z.array(ACPClientSchema).min(1, "At least one ACP client is required"),
  sessions: SessionsSchema.default({ persist: true, idle_timeout: 300, max_sessions: 10 }),
  mcp: MCPSchema.default({
    server_name: "starlight-bridge",
    cleanup_after_request: true,
    pin_tools: true,
    pin_base_url: "http://penumbra.local:8080",
    photo_max_base64_chars: 350_000,
  }),
  // Default passthrough OFF so ACP+MCP tools are available to Hermes.
  passthrough: PassthroughSchema.default({ enabled: false, upstream_url: "http://127.0.0.1:8642", upstream_key: "", strip_tools: true }),
  rapid: RapidSchema.default({
    enabled: false,
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    api_key: "",
    model: "gemini-3-flash-preview",
    escalate_tool: "escalate_to_agent",
    timeout_ms: 12_000,
    system_prompt: DEFAULT_RAPID_SYSTEM_PROMPT,
  }),
  response: ResponseSchema.default({ strip_markdown: false }),
}).transform((config) => {
  // Pre-sort acp_clients by longest prefix first (for longest-match routing)
  config.acp_clients.sort((a, b) => b.model_prefix.length - a.model_prefix.length);
  // Env wins for secrets so local configs can omit the key.
  if (process.env.STARLIGHT_RAPID_API_KEY) {
    config.rapid.api_key = process.env.STARLIGHT_RAPID_API_KEY;
  }
  return config;
});

// ─── Types ───────────────────────────────────────────────────────────

export type Config = z.infer<typeof ConfigSchema>;
export type ACPClient = z.infer<typeof ACPClientSchema>;
export type Token = z.infer<typeof TokenSchema>;

// ─── Loader ──────────────────────────────────────────────────────────

export function loadConfig(path?: string): Config {
  const configPath = path
    ?? process.env.STARLIGHT_CONFIG
    ?? "./starlight.yml";

  const resolved = resolve(configPath);
  let raw: string;

  try {
    raw = readFileSync(resolved, "utf-8");
  } catch (e) {
    throw new Error(
      `Failed to load config from ${resolved}: ${(e as Error).message}\n` +
      `Set STARLIGHT_CONFIG or create starlight.yml (see starlight.yml.example)`,
    );
  }

  const parsed = parse(raw);
  return ConfigSchema.parse(parsed);
}
