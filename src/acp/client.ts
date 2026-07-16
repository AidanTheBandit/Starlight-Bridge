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
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string; // for notifications
  params?: unknown;
}

// ─── ACP Client ──────────────────────────────────────────────────────

export class ACPClientWrapper {
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = "";
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private dead = false;

  constructor(
    private proc: ChildProcess,
    private label: string,
  ) {
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[ACP ${label}]`, chunk.toString().trim());
    });

    // Reject all pending RPCs on process death
    this.proc.on("exit", () => this.failAll("process exited"));
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

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && msg.id !== null) {
          // Response to a request
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
        } else if (msg.method) {
          // Notification (no id)
          const handlers = this.notificationHandlers.get(msg.method);
          if (handlers) {
            for (const handler of handlers) {
              handler(msg.params);
            }
          }
        }
      } catch {
        // malformed line — skip
      }
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
    if (!this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error(`ACP ${this.label}: stdin unavailable`);
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
        const ok = this.proc.stdin!.write(JSON.stringify(req) + "\n");
        if (!ok) {
          // Backpressure — wait for drain, but don't block the promise
          this.proc.stdin!.once("drain", () => {});
        }
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`ACP ${this.label}: write failed: ${(err as Error).message}`));
      }
    });
  }

  get isAlive(): boolean {
    return !this.dead && this.proc.exitCode === null && this.proc.killed === false;
  }

  kill(): void {
    this.failAll("killed");
    this.proc.kill();
  }
}
