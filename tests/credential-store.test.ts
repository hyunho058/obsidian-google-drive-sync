import {
  CREDENTIAL_SAVE_ERROR,
  CredentialSaveError,
  CredentialSettings,
  CredentialStore,
  SecretStore,
  SessionMarks,
  secretId,
} from "../src/auth/credential-store";
import { test, eq, assert, rejects, run } from "./harness";

// ------------------------------------------------------------------ fakes

/** In-memory SecretStorage with failure switches and a shared event log. */
class FakeStore implements SecretStore {
  data = new Map<string, string>();
  /** "set:<id>" and "save" entries in the order they happened. */
  events: string[] = [];
  setCalls = 0;
  getCalls = 0;
  throwAlways = false;
  throwGet = false;
  private failingCalls = new Set<number>();
  private failingIds = new Set<string>();

  getSecret(id: string): string | null {
    this.getCalls++;
    if (this.throwGet) throw new Error("store unreadable");
    return this.data.has(id) ? (this.data.get(id) as string) : null;
  }

  setSecret(id: string, secret: string): void {
    this.setCalls++;
    this.events.push(`set:${id}`);
    if (this.throwAlways || this.failingCalls.has(this.setCalls) || this.failingIds.has(id)) {
      throw new Error("store write failed");
    }
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("invalid id");
    this.data.set(id, secret);
  }

  /** Make the Nth upcoming setSecret calls throw (1 = the next call). */
  failNext(...nth: number[]): void {
    for (const n of nth) this.failingCalls.add(this.setCalls + n);
  }

  failFor(id: string): void {
    this.failingIds.add(id);
  }

  heal(): void {
    this.throwAlways = false;
    this.throwGet = false;
    this.failingCalls.clear();
    this.failingIds.clear();
  }
}

interface Fixture {
  settings: CredentialSettings;
  /** The data.json save handed to the store; also usable as a commit step. */
  save: () => Promise<void>;
  /** Set `on` to make every save throw, as a full or read-only disk would. */
  failSaves: { on: boolean };
  saves: CredentialSettings[];
  warnings: unknown[][];
  store: FakeStore;
  cs: CredentialStore;
}

const BLANK: CredentialSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  secretIdSuffix: "",
  linked: false,
};

/** One "process": a CredentialStore over `store` with its own settings object. */
function open(initial: Partial<CredentialSettings>, store = new FakeStore(), session?: SessionMarks): Fixture {
  const settings: CredentialSettings = { ...BLANK, ...initial };
  const saves: CredentialSettings[] = [];
  const warnings: unknown[][] = [];
  const failSaves = { on: false };
  const save = async () => {
    if (failSaves.on) throw new Error("disk full");
    saves.push(JSON.parse(JSON.stringify(settings)) as CredentialSettings);
    store.events.push("save");
  };
  const cs = new CredentialStore(store, settings, save, { warn: (...a) => warnings.push(a) }, session);
  return { settings, save, failSaves, saves, warnings, store, cs };
}

/**
 * The next plugin load: a fresh store instance over what the last one saved.
 * Pass the previous `session` to model a plugin reload within the same app
 * session; omit it (or pass a new one) to model an app restart.
 */
function restart(prev: Fixture, session?: SessionMarks): Fixture {
  const persisted = prev.saves.length ? prev.saves[prev.saves.length - 1] : prev.settings;
  return open(JSON.parse(JSON.stringify(persisted)) as CredentialSettings, prev.store, session);
}

/** In-memory stand-in for sessionStorage: one per simulated app session. */
function fakeSession(): SessionMarks {
  const marks = new Set<string>();
  return {
    isGenerated: (suffix) => marks.has(`g:${suffix}`),
    markGenerated: (suffix) => {
      marks.add(`g:${suffix}`);
    },
    isWritten: (suffix, field) => marks.has(`w:${suffix}:${field}`),
    markWritten: (suffix, field) => {
      marks.add(`w:${suffix}:${field}`);
    },
  };
}

const CS = (f: Fixture) => secretId(f.settings.secretIdSuffix, "client-secret");
const RT = (f: Fixture) => secretId(f.settings.secretIdSuffix, "refresh-token");

function noSecretsIn(warnings: unknown[][], ...secrets: string[]): void {
  const text = JSON.stringify(warnings);
  for (const s of secrets) assert(!text.includes(s), `a warning contains the secret value ${s}`);
}

const legacyDesktop = (): Partial<CredentialSettings> => ({
  clientId: "id.apps.googleusercontent.com",
  clientSecret: "legacy-secret-A",
  refreshToken: "legacy-token-A",
});

// ------------------------------------------------------- R1: the store itself

test("R1.1 the first write generates an 8-hex suffix and saves it before writing", async () => {
  const f = open({ clientId: "cid" });
  await f.cs.setClientSecret("sec-1");
  const suffix = f.settings.secretIdSuffix;
  assert(/^[0-9a-f]{8}$/.test(suffix), `suffix ${suffix} is not 8 lowercase hex digits`);
  eq(f.saves.length, 1, "saves");
  eq(f.saves[0].secretIdSuffix, suffix, "saved suffix");
  eq(f.store.events, ["save", `set:gdrive-vault-sync-${suffix}-client-secret`], "order");
  eq(f.store.data.get(`gdrive-vault-sync-${suffix}-client-secret`), "sec-1", "stored secret");
});

test("R1.1 savePair uses both documented ids", async () => {
  const f = open({ clientId: "cid" });
  await f.cs.savePair({ clientSecret: "sec-1", refreshToken: "tok-1" });
  const s = f.settings.secretIdSuffix;
  eq(f.store.data.get(`gdrive-vault-sync-${s}-client-secret`), "sec-1", "secret id");
  eq(f.store.data.get(`gdrive-vault-sync-${s}-refresh-token`), "tok-1", "token id");
  eq(f.store.events[0], "save", "suffix saved first");
});

test("R1.1 reads never generate a suffix", () => {
  const f = open({ clientId: "cid" });
  eq(f.cs.getClientSecret(), "", "client secret");
  eq(f.cs.getRefreshToken(), "", "refresh token");
  eq(f.cs.credentials(), null, "credentials");
  eq(f.settings.secretIdSuffix, "", "suffix");
  eq(f.saves.length, 0, "saves");
  eq(f.store.getCalls + f.store.setCalls, 0, "store calls");
});

test("R1.1 the suffix is generated once and reused", async () => {
  const f = open({ clientId: "cid" });
  await f.cs.setClientSecret("a");
  const s = f.settings.secretIdSuffix;
  await f.cs.setClientSecret("b");
  await f.cs.savePair({ clientSecret: "c", refreshToken: "d" });
  eq(f.settings.secretIdSuffix, s, "suffix unchanged");
  eq(f.saves.length, 1, "only the suffix save");
  assert(open({}).settings.secretIdSuffix === "", "fresh settings have no suffix");
  const other = open({ clientId: "cid" });
  await other.cs.setClientSecret("x");
  assert(other.settings.secretIdSuffix !== s, "two installs got the same suffix");
});

test("R1.2 a legacy data.json value wins over the store", () => {
  const f = open({ clientId: "cid", clientSecret: "A", refreshToken: "TA", secretIdSuffix: "0a1b2c3d" });
  f.store.data.set(CS(f), "B");
  f.store.data.set(RT(f), "TB");
  eq(f.cs.credentials(), { clientId: "cid", clientSecret: "A", refreshToken: "TA" }, "credentials");
  eq(f.cs.getClientSecret(), "A", "client secret");
  eq(f.cs.getRefreshToken(), "TA", "refresh token");
});

test("R1.2 without a legacy value the store is used", () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "B");
  f.store.data.set(RT(f), "TB");
  eq(f.cs.credentials(), { clientId: "cid", clientSecret: "B", refreshToken: "TB" }, "credentials");
});

test("R1.3 an empty or missing value means absent", () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d" });
  f.store.data.set(CS(f), "B");
  f.store.data.set(RT(f), "");
  eq(f.cs.credentials(), null, "empty refresh token");
  eq(f.cs.credentials() !== null, false, "isLinked");
  f.store.data.delete(RT(f));
  eq(f.cs.credentials(), null, "null refresh token");
  f.store.data.set(RT(f), "TB");
  f.store.data.set(CS(f), "");
  eq(f.cs.credentials(), null, "empty client secret");
  f.store.data.set(CS(f), "B");
  f.settings.clientId = "";
  eq(f.cs.credentials(), null, "missing client id");
});

test("R1.3 an unreadable store counts as absent and warns once", () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.throwGet = true;
  eq(f.cs.credentials(), null, "credentials");
  eq(f.cs.credentials(), null, "credentials again");
  eq(f.warnings.length, 1, "warnings");
});

test("R1.4 editing the secret during fallback updates both copies", async () => {
  const f = open({ clientId: "cid", clientSecret: "A", secretIdSuffix: "0a1b2c3d" });
  await f.cs.setClientSecret("C");
  eq(f.settings.clientSecret, "C", "data.json copy");
  eq(f.store.data.get(CS(f)), "C", "store copy");
  eq(f.saves[f.saves.length - 1].clientSecret, "C", "saved copy");
  eq(f.cs.getClientSecret(), "C", "read back");
});

test("R1.4 without a legacy copy the secret goes to the store only", async () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d" });
  await f.cs.setClientSecret("C");
  eq(f.settings.clientSecret, "", "data.json copy");
  eq(f.store.data.get(CS(f)), "C", "store copy");
  eq(f.saves.length, 0, "no save");
});

test("R1.5 after migration data.json keeps only non-secret fields", async () => {
  const store = new FakeStore();
  const initial = { ...legacyDesktop(), rootFolderId: "folder-1", rootFolderName: "Notes", index: { "a.md": 1 }, changeToken: "42" };
  const first = open(initial, store);
  await first.cs.migrate();
  const second = restart(first);
  await second.cs.migrate();
  const saved = second.saves[second.saves.length - 1] as CredentialSettings & Record<string, unknown>;
  eq(saved.clientId, "id.apps.googleusercontent.com", "client id");
  eq(saved.clientSecret, "", "client secret");
  eq(saved.refreshToken, "", "refresh token");
  eq(saved.linked, true, "linked");
  assert(/^[0-9a-f]{8}$/.test(saved.secretIdSuffix), "suffix");
  eq([saved.rootFolderId, saved.rootFolderName, saved.index, saved.changeToken], ["folder-1", "Notes", { "a.md": 1 }, "42"], "other fields");
  const text = JSON.stringify(saved);
  assert(!text.includes("legacy-secret-A") && !text.includes("legacy-token-A"), "a secret is still in data.json");
});

test("R1.6 two vaults on one device stay independent", async () => {
  const store = new FakeStore();
  const a = open({ clientId: "cid-a", linked: true }, store);
  const b = open({ clientId: "cid-b", linked: true }, store);
  await a.cs.savePair({ clientSecret: "sec-a", refreshToken: "tok-a" });
  await b.cs.savePair({ clientSecret: "sec-b", refreshToken: "tok-b" });
  assert(a.settings.secretIdSuffix !== b.settings.secretIdSuffix, "vaults share a suffix");
  eq(a.cs.credentials(), { clientId: "cid-a", clientSecret: "sec-a", refreshToken: "tok-a" }, "vault A");
  eq(b.cs.credentials(), { clientId: "cid-b", clientSecret: "sec-b", refreshToken: "tok-b" }, "vault B");
  await b.cs.clearRefreshToken(async () => {
    b.settings.linked = false;
    await b.save();
  });
  eq(a.cs.getRefreshToken(), "tok-a", "vault A after B signs out");
});

// ------------------------------------------------------ R2: two-phase migration

test("R2.1 phase 1 saves suffix, linked and legacy values before the first setSecret", async () => {
  const f = open(legacyDesktop());
  await f.cs.migrate();
  eq(f.saves.length, 1, "saves");
  const first = f.saves[0];
  assert(/^[0-9a-f]{8}$/.test(first.secretIdSuffix), "suffix saved");
  eq(first.linked, true, "linked");
  eq([first.clientSecret, first.refreshToken], ["legacy-secret-A", "legacy-token-A"], "legacy values kept");
  eq(f.store.events[0], "save", "save comes first");
  eq(f.store.events.slice(1), [`set:${CS(f)}`, `set:${RT(f)}`], "then both writes");
  eq([f.store.data.get(CS(f)), f.store.data.get(RT(f))], ["legacy-secret-A", "legacy-token-A"], "store");
  eq(f.cs.credentials(), { clientId: "id.apps.googleusercontent.com", clientSecret: "legacy-secret-A", refreshToken: "legacy-token-A" }, "credentials");
});

test("R2.2 phase 2 erases only what an earlier process persisted", async () => {
  const first = open(legacyDesktop());
  await first.cs.migrate();
  const second = restart(first);
  const setsBefore = second.store.setCalls;
  await second.cs.migrate();
  eq([second.settings.clientSecret, second.settings.refreshToken], ["", ""], "legacy blanked");
  eq(second.saves.length, 1, "saved once");
  eq([second.saves[0].clientSecret, second.saves[0].refreshToken], ["", ""], "saved blank");
  eq(second.store.setCalls, setsBefore, "no store writes in phase 2");
  eq(second.cs.credentials(), { clientId: "id.apps.googleusercontent.com", clientSecret: "legacy-secret-A", refreshToken: "legacy-token-A" }, "credentials from store");
  const third = restart(second);
  await third.cs.migrate();
  eq(third.saves.length, 0, "nothing left to migrate");
});

test("R2.3 the process that generated the suffix never blanks", async () => {
  const f = open(legacyDesktop());
  await f.cs.migrate();
  await f.cs.migrate();
  eq([f.settings.clientSecret, f.settings.refreshToken], ["legacy-secret-A", "legacy-token-A"], "in memory");
  for (const s of f.saves) {
    eq([s.clientSecret, s.refreshToken], ["legacy-secret-A", "legacy-token-A"], "every save keeps legacy");
  }
});

test("R2.4 a throwing store keeps the legacy copy and retries next load", async () => {
  const first = open(legacyDesktop());
  first.store.throwAlways = true;
  await first.cs.migrate();
  eq([first.settings.clientSecret, first.settings.refreshToken], ["legacy-secret-A", "legacy-token-A"], "legacy kept");
  eq(first.saves[0].linked, true, "linked saved");
  eq(first.warnings.length, 2, "one warning per field");
  noSecretsIn(first.warnings, "legacy-secret-A", "legacy-token-A");
  eq(first.cs.credentials(), { clientId: "id.apps.googleusercontent.com", clientSecret: "legacy-secret-A", refreshToken: "legacy-token-A" }, "sync uses legacy");

  const second = restart(first);
  const before = second.store.setCalls;
  await second.cs.migrate();
  eq(second.store.setCalls - before, 2, "retried both writes");
  eq([second.settings.clientSecret, second.settings.refreshToken], ["legacy-secret-A", "legacy-token-A"], "still kept");
  eq(second.saves.length, 0, "nothing changed, nothing saved");
  noSecretsIn(second.warnings, "legacy-secret-A", "legacy-token-A");

  second.store.heal();
  const third = restart(second);
  await third.cs.migrate();
  eq([third.settings.clientSecret, third.settings.refreshToken], ["legacy-secret-A", "legacy-token-A"], "copied, not yet erased");
  const fourth = restart(third);
  await fourth.cs.migrate();
  eq([fourth.settings.clientSecret, fourth.settings.refreshToken], ["", ""], "erased once persisted");
});

test("R2.4 a failed suffix save writes nothing to the store", async () => {
  const store = new FakeStore();
  const settings: CredentialSettings = { ...BLANK, ...legacyDesktop() };
  const cs = new CredentialStore(store, settings, async () => {
    throw new Error("disk full");
  }, { warn: () => undefined });
  await rejects(() => cs.migrate(), "migrate");
  eq(store.setCalls, 0, "no store writes");
  eq([settings.secretIdSuffix, settings.linked], ["", false], "settings reverted");
  eq(cs.getRefreshToken(), "legacy-token-A", "legacy still used");
});

test("R2.5 the legacy value overwrites a stale store value", async () => {
  const f = open({ clientId: "cid", refreshToken: "A", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(RT(f), "B");
  await f.cs.migrate();
  eq(f.store.data.get(RT(f)), "A", "store overwritten");
  eq(f.settings.refreshToken, "A", "legacy kept");
  eq(f.cs.getRefreshToken(), "A", "legacy wins");
  const next = restart(f);
  await next.cs.migrate();
  eq(next.settings.refreshToken, "", "erased once the store returns A");
});

test("R2.5 store values are compared before anything is written", async () => {
  const f = open({ clientId: "cid", clientSecret: "S", refreshToken: "A", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S");
  f.store.data.set(RT(f), "B");
  await f.cs.migrate();
  eq(f.settings.clientSecret, "", "matching secret erased");
  eq(f.settings.refreshToken, "A", "mismatched token kept");
  eq(f.store.events, [`set:${RT(f)}`, "save"], "only the token rewritten, then saved");
  eq(f.cs.credentials(), { clientId: "cid", clientSecret: "S", refreshToken: "A" }, "credentials");
});

test("R2.6 a signed-out legacy desktop is not marked linked", async () => {
  const f = open({ clientId: "cid", clientSecret: "legacy-secret-A" });
  await f.cs.migrate();
  eq(f.saves[0].linked, false, "saved linked");
  eq(f.cs.credentials(), null, "no credentials");
  const next = restart(f);
  await next.cs.migrate();
  eq(next.settings.linked, false, "still unlinked after phase 2");
  eq(next.settings.clientSecret, "", "secret migrated");
  eq(next.cs.getClientSecret(), "legacy-secret-A", "secret kept for signing in again");
});

test("D17 a legacy token with a loaded suffix marks the device linked", async () => {
  const f = open({ clientId: "cid", clientSecret: "S", refreshToken: "T", secretIdSuffix: "0a1b2c3d", linked: false });
  await f.cs.migrate();
  eq(f.settings.linked, true, "linked");
  eq(f.saves[f.saves.length - 1].linked, true, "saved");
});

test("R2 nothing to migrate does nothing", async () => {
  const f = open({ clientId: "cid" });
  await f.cs.migrate();
  eq([f.saves.length, f.store.setCalls, f.settings.secretIdSuffix], [0, 0, ""], "untouched");
});

// ------------------------------------------------------- R5: failed writes

test("R5.1 a failed second write rolls the pair back without saving", async () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  f.store.failNext(2);
  const err = await rejects(() => f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }), "savePair");
  assert(err instanceof CredentialSaveError, "not a CredentialSaveError");
  eq(err.message, "Couldn't save the sign-in on this device", "message");
  eq(CREDENTIAL_SAVE_ERROR, err.message, "exported message");
  eq([f.store.data.get(CS(f)), f.store.data.get(RT(f))], ["S0", "T0"], "store restored");
  eq(f.saves.length, 0, "data.json not saved");
  eq(f.settings.linked, true, "linked unchanged");
  noSecretsIn(f.warnings, "S0", "T0", "S1", "T1");
});

test("R5.1 a failed first write also leaves the pair as it was", async () => {
  const f = open({ clientId: "cid", clientSecret: "S0", refreshToken: "T0", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  f.store.failNext(1);
  await rejects(() => f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }), "savePair");
  eq([f.store.data.get(CS(f)), f.store.data.get(RT(f))], ["S0", "T0"], "store");
  eq([f.settings.clientSecret, f.settings.refreshToken], ["S0", "T0"], "legacy unchanged");
  eq(f.saves.length, 0, "not saved");
});

test("R5.1 restoring an absent value writes it back as empty", async () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d" });
  f.store.failNext(2);
  await rejects(() => f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }), "savePair");
  eq(f.cs.getClientSecret(), "", "client secret absent again");
  eq(f.cs.credentials(), null, "credentials");
});

test("R5.2 a failed rollback unlinks the device and saves that", async () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  f.store.failNext(2, 3);
  const err = await rejects(() => f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }), "savePair");
  assert(err instanceof CredentialSaveError, "not a CredentialSaveError");
  eq(err.message, "Couldn't save the sign-in on this device", "message");
  eq(f.settings.linked, false, "linked in memory");
  eq(f.saves.length, 1, "saved once");
  eq(f.saves[0].linked, false, "saved linked");
  noSecretsIn(f.warnings, "S0", "T0", "S1", "T1");
});

test("R5 a successful pair write does not save and keeps legacy copies current", async () => {
  const plain = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true });
  await plain.cs.savePair({ clientSecret: "S1", refreshToken: "T1" });
  eq(plain.saves.length, 0, "no save on success");
  eq([plain.settings.clientSecret, plain.settings.refreshToken], ["", ""], "no plaintext written");
  eq(plain.cs.credentials(), { clientId: "cid", clientSecret: "S1", refreshToken: "T1" }, "credentials");

  const fallback = open({ clientId: "cid", clientSecret: "S0", refreshToken: "T0", secretIdSuffix: "0a1b2c3d" });
  await fallback.cs.savePair({ clientSecret: "S1", refreshToken: "T1" });
  eq([fallback.settings.clientSecret, fallback.settings.refreshToken], ["S1", "T1"], "legacy updated");
  eq(fallback.cs.credentials(), { clientId: "cid", clientSecret: "S1", refreshToken: "T1" }, "credentials");
});

test("R5 a failed client-secret write restores the store and leaves settings alone", async () => {
  const f = open({ clientId: "cid", clientSecret: "sec-old", secretIdSuffix: "0a1b2c3d" });
  f.store.data.set(CS(f), "sec-old");
  f.store.failNext(1);
  const err = await rejects(() => f.cs.setClientSecret("sec-new"), "setClientSecret");
  assert(err instanceof CredentialSaveError, "not a CredentialSaveError");
  eq(err.message, "Couldn't save the sign-in on this device", "message");
  eq(f.store.data.get(CS(f)), "sec-old", "store restored");
  eq(f.settings.clientSecret, "sec-old", "settings unchanged");
  eq(f.saves.length, 0, "not saved");
  noSecretsIn(f.warnings, "sec-old", "sec-new");
});

// ------------------------------------------------------------- sign-out

/** The plugin's sign-out commit: mark unlinked and save data.json. */
const signOutCommit = (f: Fixture) => async () => {
  f.settings.linked = false;
  await f.save();
};

test("R4.1 sign-out saves data.json first, then clears the token, keeping the secret", async () => {
  const f = open({ clientId: "cid", refreshToken: "T0", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  await f.cs.clearRefreshToken(signOutCommit(f));
  eq(f.store.events, ["save", `set:${RT(f)}`], "data.json saved before the store is touched");
  eq([f.saves[0].linked, f.saves[0].refreshToken], [false, ""], "saved as signed out");
  eq(f.store.data.get(RT(f)), "", "store token cleared");
  eq(f.store.data.get(CS(f)), "S0", "secret kept");
  eq(f.cs.getClientSecret(), "S0", "secret still readable");
  eq(f.cs.credentials(), null, "credentials");
});

test("R4.1 sign-out without a suffix touches no store id", async () => {
  const f = open({ clientId: "cid", clientSecret: "S0", refreshToken: "T0" });
  await f.cs.clearRefreshToken(signOutCommit(f));
  eq([f.settings.refreshToken, f.settings.secretIdSuffix, f.store.setCalls], ["", "", 0], "state");
  eq(f.cs.getClientSecret(), "S0", "secret kept");
  eq(f.cs.credentials(), null, "credentials");
});

test("R4.1 a sign-out whose save fails changes nothing", async () => {
  const f = open({ clientId: "cid", refreshToken: "T0", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  f.failSaves.on = true;
  const err = await rejects(
    () =>
      f.cs.clearRefreshToken(async () => {
        await f.save(); // throws; the plugin's commitSettings reverts its own changes
      }),
    "clearRefreshToken",
  );
  assert(err instanceof CredentialSaveError, "not a CredentialSaveError");
  eq(f.settings.refreshToken, "T0", "legacy kept");
  eq(f.store.data.get(RT(f)), "T0", "store token kept");
  eq(f.store.setCalls, 0, "store not touched");
  eq(f.cs.credentials(), { clientId: "cid", clientSecret: "S0", refreshToken: "T0" }, "still signed in");
  noSecretsIn(f.warnings, "S0", "T0");
});

test("R4.1 a store that cannot clear the token still signs the device out", async () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  f.store.failFor(RT(f));
  await f.cs.clearRefreshToken(signOutCommit(f));
  eq(f.store.data.get(RT(f)), "T0", "the store still holds the token");
  eq(f.cs.credentials(), null, "but an unlinked device never uses it");
  noSecretsIn(f.warnings, "S0", "T0");
});

// ------------------------------------------- loop iteration 2 (Gate-3 fixes)

test("D21 a failed client-secret restore unlinks the device and saves that", async () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "sec-old");
  f.store.failNext(1, 2);
  const err = await rejects(() => f.cs.setClientSecret("sec-new"), "setClientSecret");
  assert(err instanceof CredentialSaveError, "not a CredentialSaveError");
  eq(f.settings.linked, false, "linked in memory");
  eq(f.saves.length, 1, "saved once");
  eq(f.saves[0].linked, false, "saved linked");
  noSecretsIn(f.warnings, "sec-old", "sec-new");
});

test("D1 a plugin reload in the same app session never erases the legacy copy", async () => {
  const session = fakeSession();
  const first = open(legacyDesktop(), new FakeStore(), session);
  await first.cs.migrate();
  const reloaded = restart(first, session);
  await reloaded.cs.migrate();
  eq(
    [reloaded.settings.clientSecret, reloaded.settings.refreshToken],
    ["legacy-secret-A", "legacy-token-A"],
    "legacy kept after a reload in the same session",
  );
  const restarted = restart(reloaded, fakeSession());
  await restarted.cs.migrate();
  eq([restarted.settings.clientSecret, restarted.settings.refreshToken], ["", ""], "erased after an app restart");
  eq(restarted.cs.credentials(), {
    clientId: "id.apps.googleusercontent.com",
    clientSecret: "legacy-secret-A",
    refreshToken: "legacy-token-A",
  }, "credentials served from the store");
});

test("D1 a suffix made by ensureIds is also remembered for the session", async () => {
  const session = fakeSession();
  const f = open({ clientId: "cid" }, new FakeStore(), session);
  await f.cs.ensureIds();
  assert(f.settings.secretIdSuffix !== "", "suffix generated");
  assert(session.isGenerated(f.settings.secretIdSuffix), "suffix marked for this session");
  eq(f.saves.length, 1, "suffix saved");
});

test("D21 a failed commit restores the previous pair and legacy copies", async () => {
  const f = open({ clientId: "cid", clientSecret: "S0", refreshToken: "T0", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  const err = await rejects(
    () =>
      f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }, async () => {
        throw new Error("disk full");
      }),
    "savePair",
  );
  assert(err instanceof CredentialSaveError, "not a CredentialSaveError");
  eq([f.store.data.get(CS(f)), f.store.data.get(RT(f))], ["S0", "T0"], "store restored");
  eq([f.settings.clientSecret, f.settings.refreshToken], ["S0", "T0"], "legacy restored");
  eq(f.settings.linked, true, "still linked");
  eq(f.saves.length, 0, "nothing saved");
  noSecretsIn(f.warnings, "S0", "T0", "S1", "T1");
});

test("D21 a failed commit whose restore also fails unlinks the device", async () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  f.store.failNext(3);
  await rejects(
    () =>
      f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }, async () => {
        throw new Error("disk full");
      }),
    "savePair",
  );
  eq(f.settings.linked, false, "linked in memory");
  eq(f.saves.length, 1, "unlinked state saved");
  eq(f.saves[0].linked, false, "saved linked");
});

test("D21 the commit runs only after both secrets are written", async () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d" });
  await f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }, async () => {
    f.store.events.push("commit");
  });
  eq(f.store.events, [`set:${CS(f)}`, `set:${RT(f)}`, "commit"], "order");
});

// ------------------------------------------- loop iteration 3 (Gate-3 fixes)

test("D21 a failed rollback leaves the device not linked and clears the token", async () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  f.store.failNext(2, 3); // refresh-token write fails, then restoring the secret fails
  await rejects(() => f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }), "savePair");
  eq(f.store.data.get(CS(f)), "S1", "the store pair is mismatched");
  eq(f.store.data.get(RT(f)), "", "the stored token is cleared");
  eq(f.cs.credentials(), null, "the mismatched pair is never used");
  eq(f.saves[f.saves.length - 1].linked, false, "saved as not linked");
});

test("D21 an unlinked device never uses a token the store still holds", () => {
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: false });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  eq(f.cs.credentials(), null, "credentials");
});

test("D21 a failed rollback mid-migration keeps the consistent legacy pair in use", async () => {
  const f = open({ clientId: "cid", clientSecret: "S0", refreshToken: "T0", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "S0");
  f.store.data.set(RT(f), "T0");
  f.store.failNext(2, 3);
  await rejects(() => f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }), "savePair");
  eq(f.settings.linked, false, "marked unlinked");
  eq(f.cs.credentials(), { clientId: "cid", clientSecret: "S0", refreshToken: "T0" }, "legacy pair still used");
});

test("R2.4 a legacy token keeps an unsaved-linked device usable", () => {
  const f = open({ clientId: "cid", clientSecret: "S0", refreshToken: "T0", linked: false });
  eq(f.cs.credentials(), { clientId: "cid", clientSecret: "S0", refreshToken: "T0" }, "credentials");
});

test("D21 a client-secret edit whose save fails reverts both copies", async () => {
  const f = open({ clientId: "cid", clientSecret: "sec-old", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "sec-old");
  f.failSaves.on = true;
  const err = await rejects(() => f.cs.setClientSecret("sec-new"), "setClientSecret");
  assert(err instanceof CredentialSaveError, "not a CredentialSaveError");
  eq(f.settings.clientSecret, "sec-old", "legacy reverted");
  eq(f.store.data.get(CS(f)), "sec-old", "store restored");
  noSecretsIn(f.warnings, "sec-old", "sec-new");
});

// -------------------------------------------- after the loop (checker round 3)

test("D1 a value re-copied this session survives a plugin reload until the next app start", async () => {
  // Earlier app start: suffix persisted, but the store holds a stale token.
  const store = new FakeStore();
  const before = open({ ...legacyDesktop(), secretIdSuffix: "0a1b2c3d", linked: true }, store);
  store.data.set(CS(before), "legacy-secret-A");
  store.data.set(RT(before), "stale-token");
  // This app start re-copies the token (phase 2, mismatch) ...
  const session = fakeSession();
  const start = restart(before, session);
  await start.cs.migrate();
  eq(store.data.get(RT(start)), "legacy-token-A", "token re-copied");
  eq(start.settings.refreshToken, "legacy-token-A", "legacy token kept");
  // ... then the plugin reloads in the same app session: the re-copied value
  // may exist only in memory, so it must not justify erasing the legacy copy.
  const reloaded = restart(start, session);
  await reloaded.cs.migrate();
  eq(reloaded.settings.refreshToken, "legacy-token-A", "legacy token kept after a same-session reload");
  // The next real app start erases it.
  const next = restart(reloaded, fakeSession());
  await next.cs.migrate();
  eq(next.settings.refreshToken, "", "erased after an app restart");
});

test("D1 a dual-written value is not erased by a reload in the same session", async () => {
  const session = fakeSession();
  const store = new FakeStore();
  const f = open({ ...legacyDesktop(), secretIdSuffix: "0a1b2c3d", linked: true }, store, session);
  await f.cs.savePair({ clientSecret: "S1", refreshToken: "T1" }, f.save);
  const reloaded = restart(f, session);
  await reloaded.cs.migrate();
  eq([reloaded.settings.clientSecret, reloaded.settings.refreshToken], ["S1", "T1"], "legacy copies kept");
  const next = restart(reloaded, fakeSession());
  await next.cs.migrate();
  eq([next.settings.clientSecret, next.settings.refreshToken], ["", ""], "erased after an app restart");
});

test("D1 every store write is remembered for the session", async () => {
  const session = fakeSession();
  const f = open({ clientId: "cid", secretIdSuffix: "0a1b2c3d", linked: true }, new FakeStore(), session);
  await f.cs.setClientSecret("S1");
  assert(session.isWritten("0a1b2c3d", "client-secret"), "client secret write remembered");
  assert(!session.isWritten("0a1b2c3d", "refresh-token"), "refresh token not marked without a write");
});

test("D21 a client-secret edit whose save and restore both fail unlinks the device", async () => {
  const f = open({ clientId: "cid", clientSecret: "sec-old", secretIdSuffix: "0a1b2c3d", linked: true });
  f.store.data.set(CS(f), "sec-old");
  f.store.data.set(RT(f), "T0");
  f.failSaves.on = true;
  f.store.failNext(2); // the store write succeeds, the save fails, then restoring the secret fails
  const err = await rejects(() => f.cs.setClientSecret("sec-new"), "setClientSecret");
  assert(err instanceof CredentialSaveError, "not a CredentialSaveError");
  eq(f.settings.linked, false, "marked unlinked");
  eq(f.store.data.get(RT(f)), "", "stored token cleared");
  eq(f.cs.credentials(), null, "the possibly mismatched pair is never used");
  noSecretsIn(f.warnings, "sec-old", "sec-new", "T0");
});

void run();
