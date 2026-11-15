import type { ClaimResult } from "./api-client";
import { STORAGE_KEYS } from "./config";
import { silentLogger, type Logger } from "./logger";

/**
 * Synchronous key-value storage. The Lens adapter backs it with
 * `global.persistentStorageSystem.store` (getString/putString/remove), which
 * is private to this Lens on this device.
 */
export interface KeyValueStore {
  getString(key: string): string | null;
  putString(key: string, value: string): void;
  remove(key: string): void;
}

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getString: (k) => data[k] ?? null,
    putString: (k, v) => {
      data[k] = v;
    },
    remove: (k) => {
      delete data[k];
    },
  };
}

export type LinkResult =
  | { ok: true; deviceId: string; error?: undefined }
  | { ok: false; error: Extract<ClaimResult, { ok: false }>["error"]; deviceId?: undefined };

/**
 * Pairing-code flow: the wearer reads a 6-character code off the Cue web app,
 * the Lens claims it and keeps the returned device token. The token and the
 * code are registered as logger secrets as soon as they are known.
 */
export class AccountLink {
  private token: string | null = null;

  constructor(
    private readonly store: KeyValueStore,
    private readonly claim: (code: string) => Promise<ClaimResult>,
    private readonly log: Logger = silentLogger,
  ) {}

  init(): void {
    let stored: string | null = null;
    try {
      stored = this.store.getString(STORAGE_KEYS.deviceToken);
    } catch {
      this.log.warn("token store unreadable");
    }
    this.token = stored !== null && stored.length > 0 ? stored : null;
    if (this.token !== null) this.log.addSecret(this.token);
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
    const res = await this.claim(code);
    if (!res.ok) {
      this.log.warn("device link failed", { error: res.error });
      return { ok: false, error: res.error }; // existing token (if any) untouched
    }
    const token = res.result.deviceToken;
    this.log.addSecret(token);
    try {
      this.store.putString(STORAGE_KEYS.deviceToken, token);
    } catch {
      // Still usable for this run; the wearer will have to pair again next time.
      this.log.warn("token not persisted");
    }
    this.token = token;
    this.log.info("device linked", { deviceId: res.result.deviceId });
    return { ok: true, deviceId: res.result.deviceId };
  }

  /** Clears storage and memory. Called when the server answers unauthorized (unlinked or revoked). */
  unlink(): void {
    this.token = null;
    try {
      this.store.remove(STORAGE_KEYS.deviceToken);
    } catch {
      this.log.warn("token store not cleared");
    }
    this.log.info("device unlinked");
  }
}
