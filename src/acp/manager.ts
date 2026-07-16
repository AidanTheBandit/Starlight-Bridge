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
  /** Number of in-flight RPCs/prompts. cleanupIdle skips busy processes. */
  busyCount: number;
}

const processes = new Map<string, ManagedProcess>();

/**
 * Get or create an ACP client process for the given config.
 * Processes are reused across requests (keyed by model_prefix).
 */
export function getOrCreateClient(client: ACPClient): ACPClientWrapper {
  const existing = processes.get(client.model_prefix);
  if (existing && existing.wrapper.isAlive) {
    existing.lastUsed = Date.now();
    return existing.wrapper;
  }

  // Clean up dead process
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

  // Only remove if this is still the current process (avoid stale exit killing a replacement)
  proc.on("exit", (code) => {
    console.log(`[starlight] ACP client "${client.model_prefix}" exited (code ${code})`);
    const current = processes.get(client.model_prefix);
    if (current && current.process === proc) {
      processes.delete(client.model_prefix);
    }
  });

  proc.on("error", (err) => {
    console.error(`[starlight] ACP client "${client.model_prefix}" error:`, err.message);
    const current = processes.get(client.model_prefix);
    if (current && current.process === proc) {
      processes.delete(client.model_prefix);
    }
  });

  return wrapper;
}

/**
 * Create a new ACP session, optionally with MCP servers for tool injection.
 */
export async function createSession(
  client: ACPClient,
  cwd: string = process.cwd(),
  mcpServers?: unknown[],
): Promise<ACPSession> {
  const wrapper = getOrCreateClient(client);
  const managed = processes.get(client.model_prefix)!;

  const params: Record<string, unknown> = { cwd };
  if (mcpServers && mcpServers.length > 0) {
    params.mcp_servers = mcpServers;
  }

  managed.busyCount++;
  try {
    const result = await wrapper.rpc<{ session_id: string }>("session/new", params);
    const session = new ACPSession(result.session_id, wrapper, () => {
      // Dispose callback: remove from manager registry
      managed.sessions.delete(result.session_id);
    });
    managed.sessions.set(result.session_id, session);
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

  m.busyCount++;
  try {
    await wrapper.rpc("session/load", { session_id: sessionId, cwd });
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

/**
 * Mark a managed process as busy (in-flight work).
 * Call markIdle when done.
 */
export function markBusy(prefix: string): void {
  const m = processes.get(prefix);
  if (m) m.busyCount++;
}

export function markIdle(prefix: string): void {
  const m = processes.get(prefix);
  if (m) m.busyCount = Math.max(0, m.busyCount - 1);
}

/**
 * Close all ACP processes. Call on shutdown.
 */
export function closeAll(): void {
  for (const [prefix, managed] of processes) {
    console.log(`[starlight] Shutting down ACP client: ${prefix}`);
    managed.wrapper.kill();
  }
  processes.clear();
}

/**
 * Get status of all managed processes.
 */
export function getStatus(): Array<{ prefix: string; alive: boolean; sessions: number; busy: boolean }> {
  return Array.from(processes.entries()).map(([prefix, m]) => ({
    prefix,
    alive: m.wrapper.isAlive,
    sessions: m.sessions.size,
    busy: m.busyCount > 0,
  }));
}

/**
 * Clean up idle sessions and processes.
 * Skips processes with in-flight work (busyCount > 0).
 */
export function cleanupIdle(idleTimeoutMs: number): void {
  const now = Date.now();
  for (const [prefix, managed] of processes) {
    if (managed.busyCount > 0) continue; // don't kill busy processes
    if (now - managed.lastUsed > idleTimeoutMs) {
      console.log(`[starlight] Cleaning up idle ACP client: ${prefix}`);
      managed.wrapper.kill();
      processes.delete(prefix);
    }
  }
}
