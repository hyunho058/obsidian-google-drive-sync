import { test, eq, assert, rejects, run } from "./harness";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  SetupTokenError,
  checkTokenStructure,
  decryptSetupToken,
  encryptSetupToken,
  formatCode,
  generateCode,
  looksLikeCode,
  normalizeCode,
  type LinkPayload,
  type SetupTokenErrorKind,
} from "../src/auth/setup-token";

// The UI shows these verbatim, so the tests pin the exact text.
const MESSAGES: Record<SetupTokenErrorKind, string> = {
  "old-token": "This is an old, unencrypted setup token — copy a new one from your other device.",
  damaged: "This setup token is damaged or not from this plugin — copy a new one.",
  "wrong-code": "That code doesn't match this token.",
};

const PAYLOAD: LinkPayload = {
  clientId: "123.apps.googleusercontent.com",
  clientSecret: "GOCSPX-secret",
  refreshToken: "1//refresh-토큰-value",
  folderId: "abc123",
  folderName: "노트 보관함",
};

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

// --- helpers (independent of the module under test) ---------------------------

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const unb64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));
const b64uText = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

type Envelope = Record<string, unknown>;

function envelopeOf(token: string): Envelope {
  assert(token.startsWith("gdvs2:"), "token starts with gdvs2:");
  return JSON.parse(Buffer.from(token.slice(6), "base64url").toString("utf8")) as Envelope;
}

function tokenOf(envelope: Envelope): string {
  return "gdvs2:" + b64uText(JSON.stringify(envelope));
}

function mutate(token: string, change: (e: Envelope) => void): string {
  const e = envelopeOf(token);
  change(e);
  return tokenOf(e);
}

/** Resolves when `fn` rejects with a SetupTokenError of `kind` and its fixed message. */
async function expectKind(fn: () => Promise<unknown>, kind: SetupTokenErrorKind, what: string): Promise<SetupTokenError> {
  const err = await rejects(fn, what);
  assert(err instanceof SetupTokenError, `${what}: expected a SetupTokenError, got ${err.name}`);
  const e = err as SetupTokenError;
  eq(e.kind, kind, `${what}: kind`);
  eq(e.message, MESSAGES[kind], `${what}: message`);
  eq(e.name, "SetupTokenError", `${what}: name`);
  return e;
}

/** Counts WebCrypto calls made while `fn` runs (0 means no key derivation happened). */
async function subtleCalls(fn: () => unknown): Promise<number> {
  const subtle = crypto.subtle as unknown as Record<string, unknown>;
  const names = ["importKey", "deriveKey", "deriveBits", "encrypt", "decrypt", "digest"];
  let calls = 0;
  for (const name of names) {
    const original = subtle[name] as (...args: unknown[]) => unknown;
    subtle[name] = (...args: unknown[]) => {
      calls++;
      return original.apply(crypto.subtle, args);
    };
  }
  try {
    await fn();
  } finally {
    for (const name of names) delete subtle[name];
  }
  return calls;
}

/**
 * Replaces crypto.getRandomValues until the returned restore function runs.
 * `fill` returns true when it has filled the request itself.
 */
function stubRandom(fill: (bytes: Uint8Array) => boolean): () => void {
  const target = crypto as unknown as { getRandomValues?: (a: ArrayBufferView) => ArrayBufferView };
  const original = crypto.getRandomValues;
  target.getRandomValues = (a: ArrayBufferView) => {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    if (!fill(bytes)) original.call(crypto, bytes);
    return a;
  };
  return () => {
    delete target.getRandomValues;
  };
}

async function pbkdf2AesKey(code: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// One encryption shared by the tests that only need "some valid token".
let shared: Promise<{ token: string; code: string }> | undefined;
const fixture = () => (shared ??= encryptSetupToken(PAYLOAD));

// Tokens crafted per the spec with an independent implementation, so the
// decoder can be fed plaintexts the encoder would never produce.
const CRAFT_CODE = "K7Q4ZP90";
const CRAFT_SALT = new Uint8Array(16).fill(7);
let craftKey: Promise<CryptoKey> | undefined;
async function craft(plaintext: string): Promise<string> {
  const key = await (craftKey ??= pbkdf2AesKey(CRAFT_CODE, CRAFT_SALT, 600000));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return tokenOf({ v: 2, kdf: "pbkdf2-sha256", iter: 600000, salt: b64u(CRAFT_SALT), iv: b64u(iv), ct: b64u(new Uint8Array(ct)) });
}

// --- R6: encrypted token format -----------------------------------------------

test("R6.1 encrypt then decrypt round-trips the payload", async () => {
  const { token, code } = await fixture();
  eq(await decryptSetupToken(token, code), PAYLOAD, "decrypted payload");
});

test("R6.1 undefined folder fields are left out of the payload", async () => {
  const bare = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };
  const { token, code } = await encryptSetupToken(bare);
  const out = await decryptSetupToken(token, code);
  eq(out, bare, "decrypted payload");
  eq(Object.keys(out).sort(), ["clientId", "clientSecret", "refreshToken"], "keys");
});

test("R6.2 the envelope uses the fixed parameters", async () => {
  const { token } = await fixture();
  assert(token.startsWith("gdvs2:"), "prefix gdvs2:");
  assert(/^[A-Za-z0-9_-]+$/.test(token.slice(6)), "body is unpadded base64url");
  const e = envelopeOf(token);
  eq(Object.keys(e).sort(), ["ct", "iter", "iv", "kdf", "salt", "v"], "envelope keys (no timestamp)");
  eq(e.v, 2, "v");
  eq(e.kdf, "pbkdf2-sha256", "kdf");
  eq(e.iter, 600000, "iter");
  for (const field of ["salt", "iv", "ct"]) {
    assert(typeof e[field] === "string" && /^[A-Za-z0-9_-]+$/.test(e[field] as string), `${field} is unpadded base64url`);
  }
  eq(unb64u(e.salt as string).length, 16, "salt bytes");
  eq(unb64u(e.iv as string).length, 12, "iv bytes");
  const plaintextLength = new TextEncoder().encode(JSON.stringify(PAYLOAD)).length;
  eq(unb64u(e.ct as string).length, plaintextLength + 16, "ciphertext = plaintext + 16-byte GCM tag");
});

test("R6.2 the ciphertext is AES-256-GCM under PBKDF2-SHA256(code, salt, 600000)", async () => {
  const { token, code } = await fixture();
  const e = envelopeOf(token);
  const key = await pbkdf2AesKey(code, unb64u(e.salt as string), 600000);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64u(e.iv as string) as Uint8Array<ArrayBuffer> },
    key,
    unb64u(e.ct as string) as Uint8Array<ArrayBuffer>,
  );
  eq(JSON.parse(new TextDecoder().decode(plain)), PAYLOAD, "independently decrypted payload (only the five fields)");
});

test("R6.3 1,000 generated codes are 8 Crockford characters shown as XXXX-XXXX", () => {
  eq(CODE_ALPHABET, "0123456789ABCDEFGHJKMNPQRSTVWXYZ", "alphabet");
  eq(CODE_LENGTH, 8, "code length");
  const seen = new Set<string>();
  const used = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const code = generateCode();
    assert(CODE_RE.test(code), `code ${i} is 8 alphabet characters`);
    const shown = formatCode(code);
    assert(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(shown), `code ${i} displays as XXXX-XXXX`);
    eq(shown.replace("-", ""), code, `code ${i} display keeps the characters`);
    seen.add(code);
    for (const ch of code) used.add(ch);
  }
  eq(seen.size, 1000, "distinct codes");
  eq(used.size, 32, "every alphabet character appears");
});

test("R6.3 codes come from crypto.getRandomValues (byte & 31)", () => {
  let calls = 0;
  const restore = stubRandom((bytes) => {
    calls++;
    [0, 33, 66, 99, 132, 165, 198, 255].forEach((b, i) => (bytes[i] = b));
    return true;
  });
  try {
    eq(generateCode(), "0123456Z", "code from stubbed bytes");
  } finally {
    restore();
  }
  eq(calls, 1, "getRandomValues calls");
});

test("R6.3 formatCode inserts the dash", () => {
  eq(formatCode("K7Q4ZP9M"), "K7Q4-ZP9M", "formatted");
});

test("R6.4 normalizeCode ignores case, spaces and dashes and maps look-alikes", () => {
  eq(normalizeCode("k7q4-zp9o"), "K7Q4ZP90", "lowercase, dash, o");
  eq(normalizeCode("K7Q4 ZP90"), "K7Q4ZP90", "space");
  eq(normalizeCode("K7Q4ZP9O"), "K7Q4ZP90", "O");
  eq(normalizeCode(" k7q4–zp90\n"), "K7Q4ZP90", "en dash and surrounding whitespace");
  eq(normalizeCode("iIlL-oO"), "111100", "I/L → 1, O → 0");
  eq(normalizeCode("ABCDEFGU"), "ABCDEFGU", "U is kept (and later refused)");
});

test("R6.4 a token made with K7Q4ZP90 decrypts with k7q4-zp9o, K7Q4 ZP90 and K7Q4ZP9O", async () => {
  // High bits set on purpose: only the low five bits pick the character.
  const indexes = Array.from("K7Q4ZP90", (ch, i) => CODE_ALPHABET.indexOf(ch) + 32 * i);
  let codeRequests = 0;
  const restore = stubRandom((bytes) => {
    if (bytes.length !== 8 || codeRequests > 0) return false;
    codeRequests++;
    indexes.forEach((b, i) => (bytes[i] = b));
    return true;
  });
  let made: { token: string; code: string };
  try {
    made = await encryptSetupToken(PAYLOAD);
  } finally {
    restore();
  }
  eq(made.code, "K7Q4ZP90", "generated code");
  for (const typed of ["k7q4-zp9o", "K7Q4 ZP90", "K7Q4ZP9O"]) {
    eq(await decryptSetupToken(made.token, typed), PAYLOAD, `decrypted with ${typed}`);
  }
});

test("R6.5 a wrong code fails with the fixed message", async () => {
  const { token, code } = await fixture();
  const wrong = (code[0] === "0" ? "1" : "0") + code.slice(1);
  const err = await expectKind(() => decryptSetupToken(token, wrong), "wrong-code", "wrong code");
  assert(err instanceof Error, "is an Error");
  assert(!err.message.includes(code) && !err.message.includes(wrong), "message does not echo a code");
  assert(!err.message.includes(token.slice(6, 20)), "message does not echo the token");
});

test("R6.5 a malformed code is a wrong code and runs no key derivation", async () => {
  const { token } = await fixture();
  for (const typed of ["", "K7Q4", "K7Q4ZP90X", "UUUUUUUU", "K7Q4-ZP9U", "########"]) {
    const calls = await subtleCalls(() => expectKind(() => decryptSetupToken(token, typed), "wrong-code", `code "${typed}"`));
    eq(calls, 0, `WebCrypto calls for code "${typed}"`);
  }
});

test("R6.6 a modified token fails exactly like a wrong code", async () => {
  const { token, code } = await fixture();
  const flip = (field: string, at: (n: number) => number) =>
    mutate(token, (e) => {
      const bytes = unb64u(e[field] as string);
      bytes[at(bytes.length)] ^= 0x01;
      e[field] = b64u(bytes);
    });
  const tampered: [string, string][] = [
    ["ciphertext byte", flip("ct", (n) => n >> 1)],
    ["GCM tag byte", flip("ct", (n) => n - 1)],
    ["IV byte", flip("iv", () => 0)],
    ["salt byte", flip("salt", () => 0)],
  ];
  for (const [what, t] of tampered) {
    eq(checkTokenStructure(t), "complete", `${what}: still structurally complete`);
    await expectKind(() => decryptSetupToken(t, code), "wrong-code", `changed ${what}`);
  }
});

test("R6.7 every copy has a fresh salt, IV and code", async () => {
  const a = await fixture();
  const b = await encryptSetupToken(PAYLOAD);
  assert(a.token !== b.token, "tokens differ");
  assert(a.code !== b.code, "codes differ");
  const ea = envelopeOf(a.token);
  const eb = envelopeOf(b.token);
  assert(ea.salt !== eb.salt, "salts differ");
  assert(ea.iv !== eb.iv, "IVs differ");
});

test("R6.8 a token made earlier still decrypts; nothing about time is stored", async () => {
  // Produced once by this module and frozen here; it must keep working forever.
  const frozen =
    "gdvs2:eyJ2IjoyLCJrZGYiOiJwYmtkZjItc2hhMjU2IiwiaXRlciI6NjAwMDAwLCJzYWx0Ijoic1RDRmU3aXVvZFVieFZTRzFjdlhrZyIsIml2IjoiclFqNjl2ZXB2RUdtR1I1dSIsImN0IjoiZm5oU3ZNTmxZYm9UMFgwNUEzLUhhcTM1bjNZOEQxN0FzaUhTYlJTY2dtekRMckpWc2FGekEwZTFvQ043TmRfQ05zYmZxWVE2QW9IaE0tQ0txZ1F2STJ2dXQ1bVZ6eG9jV20yNnFqcHVyYzNpZjVvQXpTTVhORG01dVE3SUxBRkx5LW9kdWRmT1M0Zy12c1RkWEFHc2x3dTA3VE5SUTBIYzhEZ0dxTXNoREJlYkMxOTdIdnVxR01FT1VIeVNpM09rTXZoZV9sRU4teXozWFdjeTh3RjlWN0hUX1NMalNhTkJTWWhZQ0gzTnB6QWxsdyJ9";
  eq(Object.keys(envelopeOf(frozen)).sort(), ["ct", "iter", "iv", "kdf", "salt", "v"], "envelope keys");
  eq(
    await decryptSetupToken(frozen, "3HPZ-1FK4"),
    {
      clientId: "frozen.apps.googleusercontent.com",
      clientSecret: "GOCSPX-frozen",
      refreshToken: "1//frozen-refresh",
      folderId: "frozen-folder",
      folderName: "Vault",
    },
    "frozen token payload",
  );
});

// --- R7: decoder validation -----------------------------------------------------

test("R7.1 gdvs1 tokens are refused as old tokens without key derivation", async () => {
  const v1 = "gdvs1:" + btoa(JSON.stringify({ v: 1, clientId: "a", clientSecret: "b", refreshToken: "c" }));
  for (const raw of [v1, `  ${v1}\n`, "gdvs1:", "gdvs1:!!!"]) {
    eq(checkTokenStructure(raw), "old-token", `structure of ${JSON.stringify(raw.slice(0, 12))}`);
    const calls = await subtleCalls(() => expectKind(() => decryptSetupToken(raw, "K7Q4ZP90"), "old-token", "v1 token"));
    eq(calls, 0, "WebCrypto calls for a v1 token");
  }
});

test("R7.2 out-of-range or malformed envelopes are damaged, before any key derivation", async () => {
  const { token, code } = await fixture();
  const set = (key: string, value: unknown) => mutate(token, (e) => (e[key] = value));
  const drop = (key: string) => mutate(token, (e) => delete e[key]);
  const bytes = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
  const cases: [string, string][] = [
    ["kdf pbkdf2-sha1", set("kdf", "pbkdf2-sha1")],
    ["kdf missing", drop("kdf")],
    ["iter 599999", set("iter", 599999)],
    ["iter 2000001", set("iter", 2000001)],
    ["iter 600000.5", set("iter", 600000.5)],
    ["iter as string", set("iter", "600000")],
    ["iter missing", drop("iter")],
    ["salt 15 bytes", set("salt", bytes(15))],
    ["salt 17 bytes", set("salt", bytes(17))],
    ["salt not base64url", set("salt", "!!!!!!!!!!!!!!!!!!!!!!")],
    ["salt as number", set("salt", 16)],
    ["iv 11 bytes", set("iv", bytes(11))],
    ["iv 13 bytes", set("iv", bytes(13))],
    ["iv missing", drop("iv")],
    ["ct 16 bytes", set("ct", bytes(16))],
    ["ct empty", set("ct", "")],
    ["v 1", set("v", 1)],
    ["v as string", set("v", "2")],
    ["v missing", drop("v")],
    ["body not base64url", "gdvs2:@@@@####"],
    ["body impossible base64 length", "gdvs2:abcde"],
    ["body not JSON", "gdvs2:" + b64uText("not json at all")],
    ["body JSON array", "gdvs2:" + b64uText("[2]")],
    ["body JSON null", "gdvs2:" + b64uText("null")],
    ["body not UTF-8", "gdvs2:" + b64u(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]))],
    ["unknown prefix", "gdvs3:" + token.slice(6)],
    ["uppercase prefix", "GDVS2:" + token.slice(6)],
    ["no prefix", token.slice(6)],
    ["plain text", "hello there"],
  ];
  for (const [what, raw] of cases) {
    eq(checkTokenStructure(raw), "damaged", `${what}: structure`);
    const calls = await subtleCalls(() => expectKind(() => decryptSetupToken(raw, code), "damaged", what));
    eq(calls, 0, `${what}: WebCrypto calls`);
  }
});

test("R7.2 boundary parameters are structurally accepted", async () => {
  const { token } = await fixture();
  eq(checkTokenStructure(mutate(token, (e) => (e.iter = 600000))), "complete", "iter 600000");
  eq(checkTokenStructure(mutate(token, (e) => (e.iter = 2000000))), "complete", "iter 2000000");
  eq(checkTokenStructure(mutate(token, (e) => (e.ct = b64u(new Uint8Array(17))))), "complete", "ct 17 bytes");
});

test("R7.3 a decrypted payload must hold non-empty credentials and string folder fields", async () => {
  const good = { clientId: "id", clientSecret: "secret", refreshToken: "refresh", folderId: "f", folderName: "n" };
  // Control: the crafting itself is right, and unknown inner fields are dropped.
  eq(await decryptSetupToken(await craft(JSON.stringify({ ...good, v: 1, extra: "x" })), CRAFT_CODE), good, "crafted payload");

  const without = (key: string) => {
    const copy: Record<string, unknown> = { ...good };
    delete copy[key];
    return JSON.stringify(copy);
  };
  const bad: [string, string][] = [
    ["refreshToken missing", without("refreshToken")],
    ["clientId missing", without("clientId")],
    ["clientSecret missing", without("clientSecret")],
    ["refreshToken empty", JSON.stringify({ ...good, refreshToken: "" })],
    ["refreshToken a number", JSON.stringify({ ...good, refreshToken: 7 })],
    ["folderId a number", JSON.stringify({ ...good, folderId: 5 })],
    ["folderName null", JSON.stringify({ ...good, folderName: null })],
    ["plaintext not JSON", "not json"],
    ["plaintext a JSON array", "[]"],
  ];
  for (const [what, plaintext] of bad) {
    const t = await craft(plaintext);
    eq(checkTokenStructure(t), "complete", `${what}: structurally complete`);
    await expectKind(() => decryptSetupToken(t, CRAFT_CODE), "damaged", what);
  }
});

test("R7.4 checkTokenStructure is synchronous and reports incomplete and complete", async () => {
  const { token } = await fixture();
  const calls = await subtleCalls(() => {
    for (const raw of ["", "   ", "g", "gdv", "gdvs", "gdvs2", "gdvs1", " gdvs2 "]) {
      eq(checkTokenStructure(raw), "incomplete", `structure of ${JSON.stringify(raw)}`);
    }
    const result = checkTokenStructure(token);
    eq(typeof result, "string", "returns a value, not a promise");
    eq(result, "complete", "real token");
    eq(checkTokenStructure(`\n ${token} \n`), "complete", "real token with surrounding whitespace");
  });
  eq(calls, 0, "WebCrypto calls");
});

test("line breaks picked up in transit do not break a token", async () => {
  const { token, code } = await fixture();
  const wrapped = "  " + (token.match(/.{1,40}/g) as string[]).join("\n") + "\n";
  eq(checkTokenStructure(wrapped), "complete", "structure");
  eq(await decryptSetupToken(wrapped, code), PAYLOAD, "decrypted payload");
});

test("a code typed into the token box is recognised as a code", async () => {
  const { token, code } = await fixture();
  for (const raw of [code, formatCode(code), "CWNH-0A1K", "cwnh 0a1k", " CWNH-0A1K\n", "cwnh-oa1k"]) {
    eq(looksLikeCode(raw), true, `looksLikeCode(${JSON.stringify(raw)})`);
  }
  for (const raw of [token, "", "   ", "CWNH-0A1", "CWNH-0A1KX", "CWNU-0A1K", "CWNH:0A1K", "CWNH_0A1K", "CWNH.0A1K", "gdvs2", "gdvs2:CWNH0A1K"]) {
    eq(looksLikeCode(raw), false, `looksLikeCode(${JSON.stringify(raw)})`);
  }
});

test("SetupTokenError carries its kind, name and fixed message", () => {
  for (const kind of ["old-token", "damaged", "wrong-code"] as SetupTokenErrorKind[]) {
    const e = new SetupTokenError(kind);
    assert(e instanceof Error && e instanceof SetupTokenError, `${kind}: instanceof`);
    eq([e.kind, e.name, e.message], [kind, "SetupTokenError", MESSAGES[kind]], kind);
  }
});

void run();
