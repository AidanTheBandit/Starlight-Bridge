import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { Config } from "../config.js";
import type { OpenAIError } from "./types.js";

function errorResponse(c: Context, status: number, message: string, type: string) {
  const body: OpenAIError = { error: { message, type } };
  return c.json(body, status as 400 | 401 | 403 | 404 | 500);
}

/**
 * Passthrough handler — proxy the OpenAI request directly to an upstream LLM API.
 *
 * No ACP agent, no MCP tools, no agent loop. Just a transparent proxy.
 * Used when the client (e.g. PenumbraOS rig) handles its own tools and
 * just needs raw LLM completions.
 */
export async function passthrough(c: Context, config: Config): Promise<Response> {
  // Auth already validated by caller
  const body = await c.req.text();

  let bodyJson: Record<string, unknown>;
  try {
    bodyJson = JSON.parse(body);
  } catch {
    return errorResponse(c, 400, "Invalid JSON in request body", "invalid_request");
  }

  // Strip tools if configured (client handles tools locally)
  if (config.passthrough.strip_tools) {
    delete bodyJson.tools;
    delete bodyJson.tool_choice;
  }
  // Starlight's correlation extension is not part of the OpenAI schema.
  delete bodyJson.conversation_id;

  const upstreamUrl = config.passthrough.upstream_url + "/v1/chat/completions";
  const upstreamKey = config.passthrough.upstream_key;
  const isStream = bodyJson.stream === true;

  if (isStream) {
    // Stream the response through
    return stream(c, async (s) => {
      try {
        const resp = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${upstreamKey}`,
          },
          body: JSON.stringify(bodyJson),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          await s.write(`data: ${JSON.stringify({ error: { message: `Upstream error: ${resp.status} ${errText}`, type: "upstream_error" } })}\n\n`);
          await s.write("data: [DONE]\n\n");
          return;
        }

        const reader = resp.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(decoder.decode(value));
        }
      } catch (err) {
        await s.write(`data: ${JSON.stringify({ error: { message: `Passthrough error: ${(err as Error).message}`, type: "passthrough_error" } })}\n\n`);
        await s.write("data: [DONE]\n\n");
      }
    });
  }

  // Non-streaming
  try {
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify(bodyJson),
    });

    const respBody = await resp.text();

    return new Response(respBody, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return errorResponse(c, 502, `Upstream connection failed: ${(err as Error).message}`, "upstream_error");
  }
}
