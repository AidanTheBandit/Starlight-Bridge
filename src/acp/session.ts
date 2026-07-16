import type { ACPClientWrapper } from "./client.js";

/**
 * An ACP session — a conversation context within an ACP agent process.
 *
 * ACP uses camelCase wire format (sessionId, modelId, mcpServers, etc.).
 */
export class ACPSession {
  private disposed = false;
  private onDispose?: () => void;

  constructor(
    public readonly sessionId: string,
    private client: ACPClientWrapper,
    onDispose?: () => void,
  ) {
    this.onDispose = onDispose;
  }

  /**
   * Send a prompt and wait for the full response.
   * If onChunk is provided, intermediate text chunks are streamed via callback.
   * Async onChunk callbacks are awaited before prompt() returns.
   */
  async prompt(
    text: string,
    onChunk?: (chunk: string) => void | Promise<void>,
  ): Promise<string> {
    if (this.disposed) {
      throw new Error("Session has been disposed");
    }

    let streamedText = "";
    const chunkPromises: Promise<void>[] = [];

    const handler = (params: unknown) => {
      const p = params as {
        sessionId?: string;
        update?: {
          sessionUpdate?: string;
          content?: { type?: string; text?: string } | Array<{ type?: string; text?: string }>;
        };
      };

      if (p.sessionId && p.sessionId !== this.sessionId) return;

      const updateType = p.update?.sessionUpdate;
      if (updateType === "agent_message_chunk" || updateType === "agent_message") {
        const content = p.update?.content;
        const blocks = Array.isArray(content) ? content : content ? [content] : [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            streamedText += block.text;
            if (onChunk) {
              const result = onChunk(block.text);
              if (result instanceof Promise) {
                chunkPromises.push(result);
              }
            }
          }
        }
      }
    };

    const unsubscribe = this.client.onNotification("session/update", handler);

    try {
      const result = await this.client.rpc<{
        stopReason?: string;
      }>("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      }, 300_000);

      // Await any pending async onChunk callbacks
      if (chunkPromises.length > 0) {
        await Promise.all(chunkPromises);
      }

      return streamedText;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Set the model for this session (session/set_model).
   */
  async setModel(model: string): Promise<void> {
    await this.client.rpc("session/set_model", {
      sessionId: this.sessionId,
      modelId: model,
    });
  }

  /**
   * Dispose of this session via session/close.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.client.rpc("session/close", {
        sessionId: this.sessionId,
      });
    } catch {
      // Session may already be gone or method unsupported — ignore
    }
    this.onDispose?.();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
