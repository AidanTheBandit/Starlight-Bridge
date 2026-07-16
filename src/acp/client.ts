import type { ChildProcess } from "node:child_process";

// ─── JSON-RPC Types ──────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

// ─── ACP Client ──────────────────────────────────────────────────────

export class ACPClientWrapper {
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = "";
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private dead = false;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private proc: ChildProcess,
    private label: string,
  ) {
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[ACP ${label}]`, text);
    });

    this.proc.on("exit", (code) => {
      console.log(`[ACP ${label}] process exited (code ${code})`);
      this.failAll("process exited");
    });
    this.proc.on("error", (err) => this.failAll(`process error: ${err.message}`));
  }

  private failAll(reason: string): void {
    this.dead = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`ACP ${this.label}: ${reason}`));
      this.pending.delete(id);
    }
  }

  private write(obj: unknown): void {
    if (!this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error(`ACP ${this.label}: stdin unavailable`);
    }
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;

        if (msg.method) {
          // Agent → client message
          if (msg.id !== undefined && msg.id !== null) {
            // Request from agent — must respond
            void this.handleAgentRequest(msg.method, msg.params, msg.id);
          } else {
            // Notification
            const handlers = this.notificationHandlers.get(msg.method);
            if (handlers) {
              for (const handler of handlers) {
                handler(msg.params);
              }
            }
          }
        } else if (msg.id !== undefined && msg.id !== null) {
          // Response to our request
          const entry = this.pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              entry.resolve(msg.result);
            }
          }
        }
      } catch {
        // malformed line — skip
      }
    }
  }

  /**
   * Handle requests from the ACP agent (permission prompts, fs access, etc.).
   * Auto-approve permissions so headless operation works.
   */
  private async handleAgentRequest(
    method: string,
    params: unknown,
    id: number | string,
  ): Promise<void> {
    try {
      let result: unknown = {};

      if (method === "session/request_permission") {
        // Auto-allow all permissions for headless bridge use
        const p = params as { options?: Array<{ optionId?: string; id?: string }> };
        const options = p?.options ?? [];
        const allow =
          options.find((o) => /allow/i.test(o.optionId ?? o.id ?? "")) ??
          options[0];
        if (allow) {
          result = {
            outcome: {
              outcome: "selected",
              optionId: allow.optionId ?? allow.id,
            },
          };
        }
      } else if (method === "fs/read_text_file" || method === "fs/write_text_file") {
        result = { content: "" };
      } else {
        console.error(`[ACP ${this.label}] unhandled agent request: ${method}`);
        result = {};
      }

      this.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: (err as Error).message },
      });
    }
  }

  /**
   * Register a notification handler. Returns an unsubscribe function.
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  async rpc<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.dead) {
      throw new Error(`ACP ${this.label}: process is dead`);
    }

    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP RPC timeout after ${timeoutMs}ms: ${method}`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      try {
        this.write(req);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /**
   * Perform ACP initialize handshake (required before any session methods).
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      console.log(`[ACP ${this.label}] initializing...`);
      await this.rpc("initialize", {
        protocolVersion: 1,
        clientInfo: {
          name: "starlight-bridge",
          version: "0.1.0",
        },
        clientCapabilities: {},
      }, 30_000);
      this.initialized = true;
      console.log(`[ACP ${this.label}] initialized`);
    })();

    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  get isAlive(): boolean {
    return !this.dead && this.proc.exitCode === null && this.proc.killed === false;
  }

  kill(): void {
    this.failAll("killed");
    this.proc.kill();
  }
}
