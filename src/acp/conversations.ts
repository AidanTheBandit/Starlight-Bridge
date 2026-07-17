interface DisposableSession {
  readonly isUsable?: boolean;
  dispose(): Promise<void>;
}

interface ConversationEntry<T extends DisposableSession> {
  session: T;
  fingerprint: string;
  lastUsed: number;
  leases: number;
  retired: boolean;
  counted: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export interface AcquireConversationOptions<T extends DisposableSession> {
  key?: string;
  fingerprint: string;
  maxEntries?: number;
  idleTimeoutMs?: number;
  create(): Promise<T>;
}

export interface AcquiredConversation<T extends DisposableSession> {
  session: T;
  reused: boolean;
  persistent: boolean;
  release(): Promise<void>;
}

/**
 * Correlates explicit client conversation IDs with live ACP sessions.
 * Missing keys are intentionally ephemeral so unrelated callers never share
 * context by accident. Persistent acquisitions are leased until release(), so
 * cleanup and rotation never dispose sessions with active or queued prompts.
 */
export class ConversationRegistry<T extends DisposableSession> {
  private readonly entries = new Map<string, ConversationEntry<T>>();
  private readonly pending = new Map<string, Promise<AcquiredConversation<T>>>();
  private liveCount = 0;

  get size(): number {
    return this.entries.size;
  }

  get liveSessions(): number {
    return this.liveCount;
  }

  async acquire(options: AcquireConversationOptions<T>): Promise<AcquiredConversation<T>> {
    if (!options.key) {
      await this.reserveSlot(options.maxEntries);
      let session: T;
      try {
        session = await options.create();
      } catch (err) {
        this.liveCount -= 1;
        throw err;
      }
      const entry: ConversationEntry<T> = {
        session,
        fingerprint: options.fingerprint,
        lastUsed: Date.now(),
        leases: 1,
        retired: true,
        counted: true,
      };
      let released = false;
      return {
        session,
        reused: false,
        persistent: false,
        release: async () => {
          if (released) return;
          released = true;
          entry.leases = 0;
          await this.disposeEntry(entry);
        },
      };
    }

    let existing = this.entries.get(options.key);
    if (existing?.session.isUsable === false) {
      await this.retire(options.key, existing);
      existing = undefined;
    }

    if (existing && existing.fingerprint === options.fingerprint) {
      this.lease(options.key, existing, options.idleTimeoutMs);
      return this.acquired(options.key, existing, true, options.idleTimeoutMs);
    }

    const inFlight = this.pending.get(options.key);
    if (inFlight) {
      await inFlight;
      return this.acquire(options);
    }

    if (existing) {
      await this.retire(options.key, existing);
    }

    const acquisition = this.createEntry(options);
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
  ): Promise<AcquiredConversation<T>> {
    await this.reserveSlot(options.maxEntries);

    let session: T;
    try {
      session = await options.create();
    } catch (err) {
      this.liveCount -= 1;
      throw err;
    }

    const entry: ConversationEntry<T> = {
      session,
      fingerprint: options.fingerprint,
      lastUsed: Date.now(),
      leases: 1,
      retired: false,
      counted: true,
    };
    this.entries.set(options.key!, entry);
    return this.acquired(options.key!, entry, false, options.idleTimeoutMs);
  }

  private async reserveSlot(maxEntries: number | undefined): Promise<void> {
    if (maxEntries && maxEntries > 0) {
      while (this.liveCount >= maxEntries) {
        const oldestIdle = [...this.entries.entries()]
          .filter(([, entry]) => entry.leases === 0 && !entry.retired)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!oldestIdle) {
          throw new Error(`Conversation capacity reached (${maxEntries} live sessions)`);
        }
        await this.retire(oldestIdle[0], oldestIdle[1]);
      }
    }
    // Reserve before create() starts so concurrent creations count toward the cap.
    this.liveCount += 1;
  }

  private lease(
    key: string,
    entry: ConversationEntry<T>,
    idleTimeoutMs: number | undefined,
  ): void {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = undefined;
    entry.leases += 1;
    entry.lastUsed = Date.now();
    // Keep the arguments paired for readability at call sites. The timeout is
    // scheduled when the final lease is released, not while work is active.
    void key;
    void idleTimeoutMs;
  }

  private acquired(
    key: string,
    entry: ConversationEntry<T>,
    reused: boolean,
    idleTimeoutMs: number | undefined,
  ): AcquiredConversation<T> {
    let released = false;
    return {
      session: entry.session,
      reused,
      persistent: true,
      release: async () => {
        if (released) return;
        released = true;
        entry.leases = Math.max(0, entry.leases - 1);
        entry.lastUsed = Date.now();
        if (entry.leases > 0) return;
        if (entry.retired) {
          await this.disposeEntry(entry);
          return;
        }
        this.scheduleExpiry(key, entry, idleTimeoutMs);
      },
    };
  }

  private scheduleExpiry(
    key: string,
    entry: ConversationEntry<T>,
    idleTimeoutMs: number | undefined,
  ): void {
    if (!idleTimeoutMs || idleTimeoutMs <= 0 || entry.retired) return;
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = setTimeout(() => {
      if (this.entries.get(key) !== entry || entry.leases > 0) return;
      void this.retire(key, entry);
    }, idleTimeoutMs);
    entry.expiryTimer.unref?.();
  }

  private async retire(key: string, entry: ConversationEntry<T>): Promise<void> {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    entry.retired = true;
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = undefined;
    if (entry.leases === 0) await this.disposeEntry(entry);
  }

  private async disposeEntry(entry: ConversationEntry<T>): Promise<void> {
    if (!entry.counted) return;
    entry.counted = false;
    this.liveCount = Math.max(0, this.liveCount - 1);
    await entry.session.dispose().catch(() => {});
  }

  async clear(): Promise<void> {
    const entries = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(entries.map(async ([, entry]) => {
      entry.retired = true;
      if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
      if (entry.leases === 0) await this.disposeEntry(entry);
    }));
  }

  async invalidate(key: string | undefined, expected?: T): Promise<void> {
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry || (expected && entry.session !== expected)) return;
    await this.retire(key, entry);
  }
}
