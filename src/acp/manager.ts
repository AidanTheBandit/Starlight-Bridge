import { spawn, type ChildProcess } from "node:child_process";
import type { ACPClient } from "../config.js";
import { ACPClientWrapper } from "./client.js";
import { ACPSession } from "./session.js";

interface ManagedProcess {
  process: ChildProcess;
  wrapper: ACPClientWrapper;
  client: ACPClient;
  sessions: Map<string, ACPSession>;
  lastUsed: number;
  busyCount: number;
}

const processes = new Map<string, ManagedProcess>();

/**
 * Get or create an ACP client process for the given config.
 */
export function getOrCreateClient(client: ACPClient): ACPClientWrapper {
  const existing = processes.get(client.model_prefix);
  if (existing && existing.wrapper.isAlive) {
    existing.lastUsed = Date.now();
    return existing.wrapper;
  }

  if (existing) {
    processes.delete(client.model_prefix);
  }

  console.log(`[starlight] Spawning ACP client: ${client.command} ${client.args.join(" ")}`);

  const proc = spawn(client.command, client.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...client.env },
    cwd: client.cwd ?? undefined,
  });

  const wrapper = new ACPClientWrapper(proc, client.model_prefix);
  const managed: ManagedProcess = {
    process: proc,
    wrapper,
    client,
    sessions: new Map(),
    lastUsed: Date.now(),
    busyCount: 0,
  };

  processes.set(client.model_prefix, managed);

  proc.on("exit", (code: number | null) => {
    console.log(`[starlight] ACP client "${client.model_prefix}" exited (code ${code})`);
    const current = processes.get(client.model_prefix);
    if (current && current.process === proc) {
      processes.delete(client.model_prefix);
    }
  });

  proc.on("error", (err: Error) => {
    console.error(`[starlight] ACP client "${client.model_prefix}" error:`, err.message);
    const current = processes.get(client.model_prefix);
    if (current && current.process === proc) {
      processes.delete(client.model_prefix);
    }
  });

  return wrapper;
}

/**
 * Normalize MCP servers into ACP camelCase wire format.
 */
function toAcpMcpServers(mcpServers?: unknown[]): unknown[] {
  if (!mcpServers || mcpServers.length === 0) return [];

  return mcpServers.map((raw) => {
    const s = raw as Record<string, unknown>;
    if (s.command) {
      return {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? [],
      };
    }
    if (s.url) {
      const entry: Record<string, unknown> = {
        name: s.name,
        url: s.url,
        headers: s.headers ?? [],
      };
      if (s.type) entry.type = s.type;
      return entry;
    }
    return null;
  }).filter(Boolean);
}

/**
 * Create a new ACP session, optionally with MCP servers.
 */
export async function createSession(
  client: ACPClient,
  cwd: string = process.cwd(),
  mcpServers?: unknown[],
): Promise<ACPSession> {
  const wrapper = getOrCreateClient(client);
  const managed = processes.get(client.model_prefix)!;

  await wrapper.ensureInitialized();

  const params = {
    cwd,
    mcpServers: toAcpMcpServers(mcpServers),
  };

  managed.busyCount++;
  try {
    const result = await wrapper.rpc<{ sessionId?: string }>("session/new", params);
    const sessionId = result.sessionId;
    if (!sessionId) {
      throw new Error("session/new returned no sessionId");
    }
    const session = new ACPSession(sessionId, wrapper, () => {
      managed.sessions.delete(sessionId);
    });
    managed.sessions.set(sessionId, session);
    managed.lastUsed = Date.now();
    return session;
  } finally {
    managed.busyCount--;
  }
}

/**
 * Load an existing ACP session by ID.
 */
export async function loadSession(
  client: ACPClient,
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<ACPSession | null> {
  const managed = processes.get(client.model_prefix);
  if (managed) {
    const existing = managed.sessions.get(sessionId);
    if (existing && !existing.isDisposed) {
      managed.lastUsed = Date.now();
      return existing;
    }
  }

  const wrapper = getOrCreateClient(client);
  const m = processes.get(client.model_prefix)!;
  await wrapper.ensureInitialized();

  m.busyCount++;
  try {
    await wrapper.rpc("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    });
    const session = new ACPSession(sessionId, wrapper, () => {
      m.sessions.delete(sessionId);
    });
    m.sessions.set(sessionId, session);
    m.lastUsed = Date.now();
    return session;
  } catch {
    return null;
  } finally {
    m.busyCount--;
  }
}

export function markBusy(prefix: string): void {
  const m = processes.get(prefix);
  if (m) m.busyCount++;
}

export function markIdle(prefix: string): void {
  const m = processes.get(prefix);
  if (m) m.busyCount = Math.max(0, m.busyCount - 1);
}

export function closeAll(): void {
  for (const [prefix, managed] of processes) {
    console.log(`[starlight] Shutting down ACP client: ${prefix}`);
    managed.wrapper.kill();
  }
  processes.clear();
}

export function getStatus(): Array<{ prefix: string; alive: boolean; sessions: number; busy: boolean }> {
  return Array.from(processes.entries()).map(([prefix, m]) => ({
    prefix,
    alive: m.wrapper.isAlive,
    sessions: m.sessions.size,
    busy: m.busyCount > 0,
  }));
}

export function cleanupIdle(idleTimeoutMs: number): void {
  const now = Date.now();
  for (const [prefix, managed] of processes) {
    if (managed.busyCount > 0) continue;
    if (now - managed.lastUsed > idleTimeoutMs) {
      console.log(`[starlight] Cleaning up idle ACP client: ${prefix}`);
      managed.wrapper.kill();
      processes.delete(prefix);
    }
  }
}
