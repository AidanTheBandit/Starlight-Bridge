interface DisposableSession {
  readonly isUsable?: boolean;
  dispose(): Promise<void>;
}

interface ConversationEntry<T extends DisposableSession> {
  session: T;
  fingerprint?: string;
  lastUsed: number;
}

export interface AcquireConversationOptions<T extends DisposableSession> {
  key?: string;
  fingerprint?: string;
  maxEntries?: number;
  idleTimeoutMs?: number;
  create(): Promise<T>;
}

export interface AcquiredConversation<T extends DisposableSession> {
  session: T;
  reused: boolean;
  persistent: boolean;
}

/**
 * Correlates explicit client conversation IDs with live ACP sessions.
 * Missing keys are intentionally ephemeral so unrelated callers never share
 * context by accident.
 */
export class ConversationRegistry<T extends DisposableSession> {
  private readonly entries = new Map<string, ConversationEntry<T>>();
  private readonly pending = new Map<string, Promise<AcquiredConversation<T>>>();

  get size(): number {
    return this.entries.size;
  }

  async acquire(options: AcquireConversationOptions<T>): Promise<AcquiredConversation<T>> {
    if (!options.key) {
      return { session: await options.create(), reused: false, persistent: false };
    }

    await this.removeExpired(options.idleTimeoutMs);

    let existing = this.entries.get(options.key);
    if (existing?.session.isUsable === false) {
      this.entries.delete(options.key);
      await existing.session.dispose().catch(() => {});
      existing = undefined;
    }
    const instructionsChanged = existing
      && options.fingerprint !== undefined
      && existing.fingerprint !== options.fingerprint;

    if (existing && !instructionsChanged) {
      existing.lastUsed = Date.now();
      return { session: existing.session, reused: true, persistent: true };
    }

    const inFlight = this.pending.get(options.key);
    if (inFlight) return inFlight;

    const acquisition = this.createEntry(options, existing, Boolean(instructionsChanged));
    this.pending.set(options.key, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.pending.get(options.key) === acquisition) {
        this.pending.delete(options.key);
      }
    }
  }

  private async createEntry(
    options: AcquireConversationOptions<T>,
    existing: ConversationEntry<T> | undefined,
    replaceExisting: boolean,
  ): Promise<AcquiredConversation<T>> {
    if (replaceExisting && existing) {
      this.entries.delete(options.key!);
      await existing.session.dispose().catch(() => {});
    }

    const session = await options.create();
    this.entries.set(options.key!, {
      session,
      fingerprint: options.fingerprint ?? existing?.fingerprint,
      lastUsed: Date.now(),
    });
    await this.enforceBound(options.maxEntries);
    return { session, reused: false, persistent: true };
  }

  private async removeExpired(idleTimeoutMs: number | undefined): Promise<void> {
    if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
    const cutoff = Date.now() - idleTimeoutMs;
    const expired = [...this.entries.entries()]
      .filter(([, entry]) => entry.lastUsed < cutoff);
    for (const [key, entry] of expired) {
      this.entries.delete(key);
      await entry.session.dispose().catch(() => {});
    }
  }

  private async enforceBound(maxEntries: number | undefined): Promise<void> {
    if (!maxEntries || maxEntries <= 0) return;
    while (this.entries.size > maxEntries) {
      const oldest = [...this.entries.entries()]
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      await oldest[1].session.dispose().catch(() => {});
    }
  }

  async clear(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.session.dispose().catch(() => {})));
  }

  async invalidate(key: string | undefined, expected?: T): Promise<void> {
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry || (expected && entry.session !== expected)) return;
    this.entries.delete(key);
    await entry.session.dispose().catch(() => {});
  }
}
