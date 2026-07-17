#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { closeAll } from "./acp/manager.js";
import { setTools } from "./mcp/store.js";
import { buildPinTools, configurePinTools } from "./mcp/pin-tools.js";
import type { Config } from "./config.js";

// ─── Load config ─────────────────────────────────────────────────────

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// ─── Register pin tools for Hermes MCP ───────────────────────────────
if (config.mcp.pin_tools) {
  configurePinTools({
    pinBaseUrl: config.mcp.pin_base_url,
    maxBase64Chars: config.mcp.photo_max_base64_chars,
  });
  const pinTools = buildPinTools();
  setTools(pinTools);
  console.log(
    `[starlight] pin tools registered (${config.mcp.pin_base_url}): ${pinTools.map((t) => t.name).join(", ")}`,
  );
}

// ─── Create app ──────────────────────────────────────────────────────

const app = createApp(config);

// ─── Start server ────────────────────────────────────────────────────

const server = serve({
  fetch: app.fetch,
  hostname: config.server.host,
  port: config.server.port,
}, (info: { address: string; port: number }) => {
  console.log(`\n  ★ Starlight Bridge v0.1.0`);
  console.log(`  Listening on http://${info.address}:${info.port}`);
  console.log(`  ACP clients: ${config.acp_clients.map((c) => c.model_prefix).join(", ")}`);
  console.log(`  Tokens: ${config.tokens.length}`);
  console.log();
});

// ─── Graceful shutdown ───────────────────────────────────────────────

function shutdown() {
  console.log("\n[starlight] Shutting down...");
  closeAll();

  server.close(() => {
    process.exit(0);
  });

  // Force exit if active connections (like SSE) keep the server alive
  setTimeout(() => {
    console.error("[starlight] Forcing shutdown due to lingering connections");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
