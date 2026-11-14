import { silentLogger, type Logger } from "./logger";
import type { ClaimResult } from "./api-client";

/** Persists the long-lived device token between runs. */
export interface TokenStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

export function memoryTokenStore(initial: string | null = null): TokenStore {
  let value = initial;
  return {
    load: async () => value,
    save: async (token) => {
      value = token;
    },
    clear: async () => {
      value = null;
    },
  };
}

export interface KeyValueStorage {
  getItem(k: string): string | null | Promise<string | null>;
  setItem(k: string, v: string): void | Promise<void>;
  removeItem(k: string): void | Promise<void>;
}

/** Works with `localStorage` or an async host storage. */
export function keyValueTokenStore(kv: KeyValueStorage, key = "cue.deviceToken"): TokenStore {
  return {
    load: async () => {
      const value = await kv.getItem(key);
      return value !== null && value.length > 0 ? value : null;
    },
    save: async (token) => {
      await kv.setItem(key, token);
    },
    clear: async () => {
      await kv.removeItem(key);
    },
  };
}

export type ClaimFn = (input: {
  code: string;
  deviceLabel?: string;
  mentraUserId?: string | null;
}) => Promise<ClaimResult>;

export type LinkResult = { ok: true; deviceId: string } | Extract<ClaimResult, { ok: false }>;

export interface AccountLinkOptions {
  store: TokenStore;
  claim: ClaimFn;
  logger?: Logger;
  deviceLabel?: string;
  mentraUserId?: () => string | null;
}

/**
 * Pairing-code flow: the wearer reads a 6-character code off the web app, the
 * bridge claims it and keeps the returned device token. The token and the code
 * are registered as logger secrets as soon as they are known.
 */
export class AccountLink {
  private token: string | null = null;
  private readonly log: Logger;

  constructor(private readonly options: AccountLinkOptions) {
    this.log = options.logger ?? silentLogger;
  }

  async init(): Promise<void> {
    let stored: string | null = null;
    try {
      stored = await this.options.store.load();
    } catch {
      this.log.warn("token store unreadable");
    }
    this.token = stored;
    if (stored !== null) this.log.addSecret(stored);
  }

  getToken(): string | null {
    return this.token;
  }

  isLinked(): boolean {
    return this.token !== null;
  }

  async link(code: string): Promise<LinkResult> {
    this.log.addSecret(code);
    this.log.addSecret(code.trim().toUpperCase());

    const input: Parameters<ClaimFn>[0] = {
      code,
      mentraUserId: this.options.mentraUserId?.() ?? null,
    };
    if (this.options.deviceLabel !== undefined) input.deviceLabel = this.options.deviceLabel;

    const res = await this.options.claim(input);
    if (!res.ok) {
      this.log.warn("device link failed", { error: res.error });
      return res; // existing token (if any) untouched
    }

    const token = res.result.deviceToken;
    this.log.addSecret(token);
    try {
      await this.options.store.save(token);
    } catch {
      // Still usable for this run; the wearer will have to pair again next time.
      this.log.warn("token not persisted");
    }
    this.token = token;
    this.log.info("device linked", { deviceId: res.result.deviceId });
    return { ok: true, deviceId: res.result.deviceId };
  }

  /** Clears store and memory. Call when the server answers unauthorized. */
  async unlink(): Promise<void> {
    this.token = null;
    try {
      await this.options.store.clear();
    } catch {
      this.log.warn("token store not cleared");
    }
    this.log.info("device unlinked");
  }
}
