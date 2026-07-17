import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { ACPSession, ACPPromptContent } from "../acp/session.js";
import type { Config } from "../config.js";
import type { OpenAIStreamChunk } from "./types.js";
import { markIdle } from "../acp/manager.js";

/**
 * Stream an ACP session response as OpenAI-compatible SSE.
 * Caller must call markBusy(prefix) before invoking this.
 * This function calls markIdle(prefix) when the stream completes.
 */
export async function streamACPToOpenAI(
  c: Context,
  session: ACPSession,
  prompt: ACPPromptContent[],
  model: string,
  config: Config,
  modelPrefix?: string,
): Promise<Response> {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  return stream(c, async (s) => {
    try {
      // Initial role delta
      const roleChunk: OpenAIStreamChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        }],
      };
      await s.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

      // Stream content — onChunk is async and awaited by session.prompt
      await session.prompt(prompt, async (chunk: string) => {
        const contentChunk: OpenAIStreamChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: { content: chunk },
            finish_reason: null,
          }],
        };
        await s.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
      });

      // Final stop chunk
      const stopChunk: OpenAIStreamChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "stop",
        }],
      };
      await s.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
      await s.write("data: [DONE]\n\n");
    } catch (err) {
      const errorChunk = {
        error: {
          message: (err as Error).message,
          type: "server_error",
        },
      };
      await s.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      await s.write("data: [DONE]\n\n");
    } finally {
      if (config.mcp.cleanup_after_request) {
        await session.dispose().catch(() => {});
      }
      if (modelPrefix) {
        markIdle(modelPrefix);
      }
    }
  });
}
