import type { ACPClientWrapper } from "./client.js";

export type ACPPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; uri?: string };

/**
 * An ACP session — a conversation context within an ACP agent process.
 *
 * ACP uses camelCase wire format (sessionId, modelId, mcpServers, etc.).
 */
export class ACPSession {
  private disposed = false;
  private readonly disposeHandlers: Array<() => void> = [];
  private promptQueue: Promise<void> = Promise.resolve();

  constructor(
    public readonly sessionId: string,
    private client: ACPClientWrapper,
    onDispose?: () => void,
  ) {
    if (onDispose) this.disposeHandlers.push(onDispose);
  }

  /**
   * Send a prompt and wait for the full response.
   * If onChunk is provided, intermediate text chunks are streamed via callback.
   * Async onChunk callbacks are awaited before prompt() returns.
   */
  async prompt(
    content: string | ACPPromptContent[],
    onChunk?: (chunk: string) => void | Promise<void>,
  ): Promise<string> {
    const result = this.promptQueue.then(() => this.executePrompt(content, onChunk));
    this.promptQueue = result.then(() => {}, () => {});
    return result;
  }

  private async executePrompt(
    content: string | ACPPromptContent[],
    onChunk?: (chunk: string) => void | Promise<void>,
  ): Promise<string> {
    if (this.disposed) {
      throw new Error("Session has been disposed");
    }

    let streamedText = "";
    let chunkWrites: Promise<void> = Promise.resolve();
    let chunkWriteError: unknown;

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
              chunkWrites = chunkWrites
                .then(() => onChunk(block.text!))
                .catch((err) => {
                  chunkWriteError ??= err;
                });
            }
          }
        }
      }
    };

    const unsubscribe = this.client.onNotification("session/update", handler);

    try {
      const prompt: ACPPromptContent[] = typeof content === "string"
        ? [{ type: "text", text: content }]
        : content;
      const result = await this.client.rpc<{
        stopReason?: string;
      }>("session/prompt", {
        sessionId: this.sessionId,
        prompt,
      }, 300_000);

      // Preserve write order and surface the first streaming write failure.
      await chunkWrites;
      if (chunkWriteError) throw chunkWriteError;

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
    for (const handler of this.disposeHandlers) handler();
  }

  onDisposed(handler: () => void): void {
    if (this.disposed) handler();
    else this.disposeHandlers.push(handler);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get isUsable(): boolean {
    return !this.disposed && this.client.isAlive;
  }
}
