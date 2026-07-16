import type { ACPClientWrapper } from "./client.js";

/**
 * An ACP session — a conversation context within an ACP agent process.
 * Handles prompt sending, model selection, and MCP server registration.
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

    // Collect streamed text from session/update notifications
    let streamedText = "";
    const chunkPromises: Promise<void>[] = [];

    const handler = (params: unknown) => {
      const p = params as {
        session_id?: string;
        update?: {
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      if (p.session_id !== this.sessionId) return;
      if (p.update?.type === "agent_message_chunk" || p.update?.type === "agent_message") {
        for (const block of p.update.content ?? []) {
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
        response?: string | Array<{ type: string; text?: string }>;
        stop_reason?: string;
      }>("session/prompt", {
        session_id: this.sessionId,
        prompt: [{ type: "text", text }],
      });

      // Await any pending async onChunk callbacks
      if (chunkPromises.length > 0) {
        await Promise.all(chunkPromises);
      }

      // Prefer the final response field if present
      if (result.response) {
        if (typeof result.response === "string") {
          return result.response;
        }
        // Array of content blocks
        return result.response
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("");
      }

      // Fall back to whatever was streamed
      return streamedText;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Set the model for this session.
   */
  async setModel(model: string): Promise<void> {
    await this.client.rpc("session/model", {
      session_id: this.sessionId,
      model,
    });
  }

  /**
   * Register MCP servers for this session (dynamic tool injection).
   */
  async setMcpServers(servers: unknown[]): Promise<void> {
    await this.client.rpc("session/mcpServers", {
      session_id: this.sessionId,
      mcp_servers: servers,
    });
  }

  /**
   * Dispose of this session, freeing resources on the ACP agent.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.client.rpc("session/dispose", {
        session_id: this.sessionId,
      });
    } catch {
      // Session may already be gone — ignore
    }
    // Notify manager to remove from registry
    this.onDispose?.();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
