/**
 * The one place the client secret and refresh token are read and written.
 *
 * Values live in Obsidian's SecretStorage (outside the vault, per device) under
 * ids that carry a random per-vault suffix, so two vaults never share secrets
 * even if the store turns out not to be keyed per vault. Older versions kept
 * both secrets in plaintext in data.json; while such a legacy copy is present
 * it wins over the store, and `migrate()` moves it across in two phases so the
 * only copy is never dropped.
 *
 * Pure logic: the store and the data.json save are passed in, so this module
 * never imports Obsidian and is unit-tested against an in-memory fake.
 */
import type { Credentials } from "./oauth";

/** The part of Obsidian's `SecretStorage` this module uses. Synchronous, no delete. */
export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/** The settings fields the store reads and writes. The object is mutated in place. */
export interface CredentialSettings {
  clientId: string;
  /** Legacy plaintext copy; non-empty only until migration finishes. */
  clientSecret: string;
  /** Legacy plaintext copy; non-empty only until migration finishes. */
  refreshToken: string;
  secretIdSuffix: string;
  linked: boolean;
}

export const CREDENTIAL_SAVE_ERROR = "Couldn't save the sign-in on this device";

export class CredentialSaveError extends Error {
  constructor() {
    super(CREDENTIAL_SAVE_ERROR);
    this.name = "CredentialSaveError";
  }
}

export type Field = "client-secret" | "refresh-token";

const LABEL: Record<Field, string> = {
  "client-secret": "client secret",
  "refresh-token": "refresh token",
};

const ID_PREFIX = "gdrive-vault-sync";

/** 8 lowercase hex digits — satisfies SecretStorage's lowercase/dash id rule. */
export function generateSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function secretId(suffix: string, field: Field): string {
  return `${ID_PREFIX}-${suffix}-${field}`;
}

/**
 * Remembers what happened to the store in this app session. Migration's erase
 * step must only trust a store value written by an earlier *process*; a plugin
 * reload (toggled off and on, or updated) without an app restart is the same
 * process, so per-instance flags are not enough. Both a generated suffix and
 * any value written under it in this session count as "not yet proven on disk".
 */
export interface SessionMarks {
  isGenerated(suffix: string): boolean;
  markGenerated(suffix: string): void;
  isWritten(suffix: string, field: Field): boolean;
  markWritten(suffix: string, field: Field): void;
}

const APP_SESSION_KEY = "__gdriveVaultSyncAppSession";

/**
 * A set that lives exactly as long as the app process: it hangs off the global
 * object, so a plugin reload (a fresh module in the same window) finds the
 * same set, and quitting the app discards it. `sessionStorage` is not used on
 * purpose — Obsidian's desktop app writes it to disk and restores it on the
 * next launch, so it would outlive the process it is meant to describe.
 */
export function appSessionSet(): Set<string> {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[APP_SESSION_KEY];
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  g[APP_SESSION_KEY] = created;
  return created;
}

/** The part of the Web Storage API `adoptPersistedMarks` uses. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/**
 * 0.2.0 kept its session marks in `sessionStorage`. Whether a mark found there
 * comes from an earlier launch or from this very process (0.2.0 → 0.2.1 by
 * plugin reload, without quitting) cannot be told apart, so each one is copied
 * into `appSessionSet()` before all of the plugin's keys are removed. That can
 * only delay an erase by one launch, never allow an early one.
 */
export function adoptPersistedMarks(storage: KeyValueStorage | undefined): void {
  if (!storage) return;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(`${ID_PREFIX}:`)) keys.push(key);
  }
  const marks = appSessionSet();
  // Every mark is taken over before anything is removed, without reading its
  // value: a storage that throws part-way must not leave a mark behind.
  for (const key of keys) {
    if (key.startsWith(`${ID_PREFIX}:generated:`) || key.startsWith(`${ID_PREFIX}:written:`)) marks.add(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/** Session marks backed by `appSessionSet()`. */
export function sessionMarks(): SessionMarks {
  const has = (key: string) => appSessionSet().has(key);
  const add = (key: string) => {
    appSessionSet().add(key);
  };
  const generated = (suffix: string) => `${ID_PREFIX}:generated:${suffix}`;
  const written = (suffix: string, field: Field) => `${ID_PREFIX}:written:${suffix}:${field}`;
  return {
    isGenerated: (suffix) => has(generated(suffix)),
    markGenerated: (suffix) => add(generated(suffix)),
    isWritten: (suffix, field) => has(written(suffix, field)),
    markWritten: (suffix, field) => add(written(suffix, field)),
  };
}

export class CredentialStore {
  /** Set once this instance generates the suffix; such a suffix never allows phase 2. */
  private suffixGeneratedHere = false;
  private readWarned = false;

  constructor(
    private store: SecretStore,
    private settings: CredentialSettings,
    private save: () => Promise<void>,
    private log: { warn(...a: unknown[]): void } = { warn: (...a) => console.warn("[gdrive-sync]", ...a) },
    private session: SessionMarks = sessionMarks(),
  ) {}

  // -------------------------------------------------------------------- reads

  getClientSecret(): string {
    return this.settings.clientSecret || this.readStore("client-secret");
  }

  getRefreshToken(): string {
    return this.settings.refreshToken || this.readStore("refresh-token");
  }

  /**
   * Null when the client ID, client secret or refresh token is missing — or
   * when the device is marked unlinked and no legacy token is in use. The
   * second rule is what makes "unlinked" stick: after a failed rollback or a
   * sign-out whose store write failed, the store may still hold a token, but it
   * must not be used. A legacy token keeps a device usable mid-migration, where
   * `linked` may not have been saved yet.
   */
  credentials(): Credentials | null {
    if (!this.settings.linked && !this.settings.refreshToken) return null;
    const clientId = this.settings.clientId;
    const clientSecret = this.getClientSecret();
    const refreshToken = this.getRefreshToken();
    if (!clientId || !clientSecret || !refreshToken) return null;
    return { clientId, clientSecret, refreshToken };
  }

  // ------------------------------------------------------------------- writes

  /**
   * The desktop client-secret field. A legacy copy, if still present, is
   * updated too so the two never diverge. A failed store write puts the
   * previous store value back and leaves the settings alone.
   */
  async setClientSecret(value: string): Promise<void> {
    await this.ensureIds();
    const fields: Field[] = ["client-secret"];
    const previous = this.readPrevious(fields);
    try {
      this.write("client-secret", value);
    } catch {
      this.log.warn(`Couldn't write the ${LABEL["client-secret"]} to secure storage`);
      if (!this.restore(fields, previous)) await this.markUnlinked();
      throw new CredentialSaveError();
    }
    if (this.settings.clientSecret) {
      const legacy = this.settings.clientSecret;
      this.settings.clientSecret = value;
      try {
        await this.save();
      } catch {
        this.log.warn("Couldn't save the settings; restoring the previous client secret");
        this.settings.clientSecret = legacy;
        if (!this.restore(fields, previous)) await this.markUnlinked();
        throw new CredentialSaveError();
      }
    }
  }

  /**
   * Writes a client secret and refresh token as one unit. If either write
   * throws, both ids get their previous values back and data.json is not
   * saved. If even that restore fails, the pair may be mismatched, so the
   * device is marked unlinked (and saved) to ask for a fresh link instead of
   * failing later with a confusing Google error.
   *
   * `commit` is the caller's settings update and save (client ID, `linked`,
   * index…). It runs after the pair is written; if it throws, the previous pair
   * and legacy copies are put back so the store and data.json never disagree.
   * A commit that fails must revert its own settings changes before throwing.
   * Without `commit`, nothing is saved on success.
   */
  async savePair(
    pair: { clientSecret: string; refreshToken: string },
    commit?: () => Promise<void>,
  ): Promise<void> {
    await this.ensureIds();
    const fields: Field[] = ["client-secret", "refresh-token"];
    const values = [pair.clientSecret, pair.refreshToken];
    const previous = this.readPrevious(fields);
    try {
      fields.forEach((field, i) => this.write(field, values[i]));
    } catch {
      this.log.warn("Couldn't write the sign-in to secure storage; restoring the previous one");
      if (!this.restore(fields, previous)) await this.markUnlinked();
      throw new CredentialSaveError();
    }
    // While a legacy copy is still present it wins on read, so keep it current.
    const legacy = { clientSecret: this.settings.clientSecret, refreshToken: this.settings.refreshToken };
    if (legacy.clientSecret) this.settings.clientSecret = pair.clientSecret;
    if (legacy.refreshToken) this.settings.refreshToken = pair.refreshToken;
    if (!commit) return;
    try {
      await commit();
    } catch {
      this.log.warn("Couldn't save the settings; restoring the previous sign-in");
      this.settings.clientSecret = legacy.clientSecret;
      this.settings.refreshToken = legacy.refreshToken;
      if (!this.restore(fields, previous)) await this.markUnlinked();
      throw new CredentialSaveError();
    }
  }

  /**
   * Sign-out: forgets the refresh token, keeps the client secret.
   *
   * data.json goes first: `commit` is the caller's settings change and save,
   * and must set `linked` to false. Once that is on disk the device is signed
   * out even if clearing the store fails below, because `credentials()` refuses
   * a stored token on an unlinked device. If the commit fails, nothing has
   * changed and `CredentialSaveError` is thrown; the commit must revert its own
   * settings changes.
   */
  async clearRefreshToken(commit: () => Promise<void>): Promise<void> {
    const legacy = this.settings.refreshToken;
    this.settings.refreshToken = "";
    try {
      await commit();
    } catch {
      this.settings.refreshToken = legacy;
      throw new CredentialSaveError();
    }
    if (!this.settings.secretIdSuffix) return;
    try {
      this.write("refresh-token", "");
    } catch {
      this.log.warn(`Couldn't clear the ${LABEL["refresh-token"]} in secure storage; it is no longer used`);
    }
  }

  // ---------------------------------------------------------------- migration

  /**
   * Two-phase move of legacy data.json secrets into the store.
   *
   * Phase 1 (no persisted suffix yet): generate the suffix and save it with
   * `linked` before any store write, so the next start looks under the same
   * ids; then copy each legacy value into the store and keep it in data.json.
   *
   * Phase 2 (suffix loaded from data.json): a legacy value that the store
   * already returns — and that was not written in this app session — was
   * persisted by an earlier process, so it leaves data.json. Any other legacy
   * value is written (again) to the store and kept. Store values are all read
   * before anything is written, and writes made earlier in this app session
   * (before a plugin reload) are remembered, so a value that may exist only in
   * memory is never mistaken for a persisted one.
   *
   * A throwing store is logged (without values) and retried on the next load.
   */
  async migrate(): Promise<void> {
    const s = this.settings;
    const legacy: Array<[Field, string]> = [];
    if (s.clientSecret) legacy.push(["client-secret", s.clientSecret]);
    if (s.refreshToken) legacy.push(["refresh-token", s.refreshToken]);
    if (legacy.length === 0) return;

    const hadToken = s.refreshToken !== "";

    if (!s.secretIdSuffix) {
      const before = { suffix: s.secretIdSuffix, linked: s.linked };
      s.secretIdSuffix = generateSuffix();
      s.linked = hadToken;
      try {
        await this.save();
      } catch (e) {
        s.secretIdSuffix = before.suffix;
        s.linked = before.linked;
        throw e;
      }
      this.suffixGeneratedHere = true;
      this.session.markGenerated(s.secretIdSuffix);
    }

    // A suffix made by this instance, or earlier in this app session (plugin
    // reloaded), proves nothing about what reached disk: copy, never erase.
    if (this.suffixGeneratedHere || this.session.isGenerated(s.secretIdSuffix)) {
      for (const [field, value] of legacy) this.tryCopy(field, value);
      return;
    }

    const stored = legacy.map(([field]) => this.readStore(field));
    let changed = false;
    legacy.forEach(([field, value], i) => {
      if (stored[i] === value && !this.session.isWritten(s.secretIdSuffix, field)) {
        if (field === "client-secret") s.clientSecret = "";
        else s.refreshToken = "";
        changed = true;
      } else if (stored[i] !== value) {
        this.tryCopy(field, value);
      }
      // Equal but written this session: leave both copies; a later app start erases.
    });
    // A device re-linked on an older version has a fresh legacy token but may
    // have been marked unlinked before the downgrade.
    if (hadToken && !s.linked) {
      s.linked = true;
      changed = true;
    }
    if (changed) await this.save();
  }

  // ------------------------------------------------------------------ helpers

  private id(field: Field): string {
    return secretId(this.settings.secretIdSuffix, field);
  }

  /**
   * Generates and persists the suffix the first time a write needs ids.
   * Public so a caller can do this slow step up front: linking calls it
   * before asking Google, so nothing is awaited between its "window still
   * open?" check and the secret writes.
   */
  async ensureIds(): Promise<void> {
    if (this.settings.secretIdSuffix) return;
    const suffix = generateSuffix();
    this.settings.secretIdSuffix = suffix;
    this.suffixGeneratedHere = true;
    try {
      await this.save();
    } catch {
      this.settings.secretIdSuffix = "";
      this.suffixGeneratedHere = false;
      throw new CredentialSaveError();
    }
    this.session.markGenerated(suffix);
  }

  /**
   * A store pair that may be mismatched: ask for a fresh link rather than fail
   * later with a Google error. The stored token is cleared as well (best
   * effort); `credentials()` already refuses it once `linked` is false. A legacy
   * copy, if any, is a consistent older pair and is left alone.
   */
  private async markUnlinked(): Promise<void> {
    if (this.settings.secretIdSuffix) {
      try {
        this.write("refresh-token", "");
      } catch {
        this.log.warn(`Couldn't clear the ${LABEL["refresh-token"]} in secure storage`);
      }
    }
    this.settings.linked = false;
    try {
      await this.save();
    } catch {
      this.log.warn("Couldn't save the unlinked state");
    }
  }

  /** Store value for the current id; "" when absent, empty, unreadable or there is no suffix yet. */
  private readStore(field: Field): string {
    if (!this.settings.secretIdSuffix) return "";
    try {
      return this.store.getSecret(this.id(field)) ?? "";
    } catch {
      if (!this.readWarned) {
        this.readWarned = true;
        this.log.warn(`Couldn't read the ${LABEL[field]} from secure storage`);
      }
      return "";
    }
  }

  /** Raw previous values for a rollback; a store that cannot be read cannot be written safely. */
  private readPrevious(fields: Field[]): string[] {
    try {
      return fields.map((field) => this.store.getSecret(this.id(field)) ?? "");
    } catch {
      this.log.warn("Couldn't read the current sign-in from secure storage");
      throw new CredentialSaveError();
    }
  }

  /**
   * The only place the store is written. A successful write is remembered for
   * this app session, so a plugin reload before the next app start never takes
   * a value that may exist only in memory as proof that it reached disk.
   */
  private write(field: Field, value: string): void {
    // Marked first: a mark only ever delays an erase, so a write that throws
    // part-way (and may or may not have landed) is treated as written.
    this.session.markWritten(this.settings.secretIdSuffix, field);
    this.store.setSecret(this.id(field), value);
  }

  /** Puts previous values back; false if any restore write failed. */
  private restore(fields: Field[], previous: string[]): boolean {
    let ok = true;
    fields.forEach((field, i) => {
      try {
        this.write(field, previous[i]);
      } catch {
        ok = false;
      }
    });
    if (!ok) this.log.warn("Couldn't restore the previous sign-in in secure storage");
    return ok;
  }

  private tryCopy(field: Field, value: string): void {
    try {
      this.write(field, value);
    } catch {
      this.log.warn(
        `Couldn't copy the ${LABEL[field]} to secure storage; keeping it in data.json and retrying on the next start`,
      );
    }
  }
}
