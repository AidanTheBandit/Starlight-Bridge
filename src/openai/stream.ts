import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { ACPSession, ACPPromptContent } from "../acp/session.js";
import type { Config } from "../config.js";
import type { OpenAIStreamChunk } from "./types.js";
import { markIdle } from "../acp/manager.js";

class SSEWriteError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SSEWriteError";
    this.cause = cause;
  }
}

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
  disposeAfterRequest: boolean = config.mcp.cleanup_after_request,
  onSessionError?: () => void | Promise<void>,
  onComplete?: () => void | Promise<void>,
): Promise<Response> {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  return stream(c, async (s) => {
    const write = async (data: string): Promise<void> => {
      try {
        await s.write(data);
      } catch (err) {
        throw new SSEWriteError(err);
      }
    };

    try {
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
      await write(`data: ${JSON.stringify(roleChunk)}\n\n`);

      try {
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
          await write(`data: ${JSON.stringify(contentChunk)}\n\n`);
        });
      } catch (err) {
        // A downstream SSE failure is local to this response. Only an actual
        // ACP prompt failure makes the retained session unsafe to reuse.
        if (!(err instanceof SSEWriteError) && onSessionError) {
          try {
            await onSessionError();
          } catch {
            // Preserve the original prompt error.
          }
        }
        throw err;
      }

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
      await write(`data: ${JSON.stringify(stopChunk)}\n\n`);
      await write("data: [DONE]\n\n");
    } catch (err) {
      // If the transport itself failed, writing another SSE frame cannot help.
      if (!(err instanceof SSEWriteError)) {
        const errorChunk = {
          error: {
            message: (err as Error).message,
            type: "server_error",
          },
        };
        try {
          await write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          await write("data: [DONE]\n\n");
        } catch {
          // The client disconnected while reporting the prompt failure.
        }
      }
    } finally {
      if (disposeAfterRequest) {
        await session.dispose().catch(() => {});
      }
      if (onComplete) {
        await Promise.resolve(onComplete()).catch(() => {});
      }
      if (modelPrefix) {
        markIdle(modelPrefix);
      }
    }
  });
}
