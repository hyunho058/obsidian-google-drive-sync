import type { Credentials } from "./oauth";

/**
 * Setup tokens carry a desktop's credentials to a device that cannot run the
 * Google sign-in itself (iOS has no loopback listener). Only the encrypted v2
 * format below is produced or accepted; a pasted v1 (`gdvs1:`) token is
 * refused with its own message.
 */

// --- v2: encrypted setup token -----------------------------------------------
//
// "gdvs2:" + base64url(JSON envelope). The envelope carries the PBKDF2 salt,
// the AES-GCM IV and the ciphertext; the key comes from a short one-time code
// that is shown on the copying device and never travels with the token.
// Everything here uses only WebCrypto, TextEncoder/TextDecoder and btoa/atob,
// which exist in Electron and in the iOS WebView. Nothing is ever logged.

/** Crockford base32: digits and A–Z without I, L, O and U. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;

const V2_PREFIX = "gdvs2:";
const V1_PREFIX = "gdvs1:";
const KDF = "pbkdf2-sha256";
const ITERATIONS = 600000;
const MIN_ITERATIONS = 600000;
const MAX_ITERATIONS = 2000000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** What a setup token carries from one device to another. */
export interface LinkPayload extends Credentials {
  folderId?: string;
  folderName?: string;
}

export type TokenCheck = "complete" | "incomplete" | "old-token" | "damaged";

export type SetupTokenErrorKind = "old-token" | "damaged" | "wrong-code";

const MESSAGES: Record<SetupTokenErrorKind, string> = {
  "old-token": "This is an old, unencrypted setup token — copy a new one from your other device.",
  damaged: "This setup token is damaged or not from this plugin — copy a new one.",
  "wrong-code": "That code doesn't match this token.",
};

/** Its message is the fixed user-facing text for `kind`; it never contains token or code. */
export class SetupTokenError extends Error {
  readonly kind: SetupTokenErrorKind;
  constructor(kind: SetupTokenErrorKind) {
    super(MESSAGES[kind]);
    this.name = "SetupTokenError";
    this.kind = kind;
  }
}

/** 8 random code characters. 256 % 32 == 0, so `byte & 31` is unbiased. */
export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  for (let i = 0; i < bytes.length; i++) code += CODE_ALPHABET[bytes[i] & 31];
  return code;
}

/**
 * Forgiving code entry: drops spaces, dashes and anything else that is not an
 * ASCII letter or digit, uppercases, and maps the Crockford look-alikes
 * O→0 and I/L→1. The result may still be the wrong length or contain U.
 */
export function normalizeCode(input: string): string {
  return input
    .replace(/[^0-9A-Za-z]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** "K7Q4ZP9M" → "K7Q4-ZP9M". */
export function formatCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function isCode(normalized: string): boolean {
  if (normalized.length !== CODE_LENGTH) return false;
  for (let i = 0; i < normalized.length; i++) {
    if (CODE_ALPHABET.indexOf(normalized[i]) < 0) return false;
  }
  return true;
}

/**
 * True when text in the token box is shaped like a one-time code instead:
 * only letters, digits, spaces and dashes, normalizing to a valid code. A
 * token never qualifies, since its prefix carries a colon.
 */
export function looksLikeCode(raw: string): boolean {
  return /^[0-9A-Za-z\s-]+$/.test(raw) && isCode(normalizeCode(raw));
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict unpadded base64url; null for anything else. */
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  let bin: string;
  try {
    // Re-pad explicitly rather than rely on atob accepting unpadded input.
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(bytes: Uint8Array<ArrayBuffer>): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function decodeField(value: unknown, minBytes: number, maxBytes: number): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string") return null;
  const bytes = b64urlToBytes(value);
  if (!bytes || bytes.length < minBytes || bytes.length > maxBytes) return null;
  return bytes;
}

interface Envelope {
  iter: number;
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  ct: Uint8Array<ArrayBuffer>;
}

type Inspection = { check: "incomplete" | "old-token" | "damaged" } | { check: "complete"; envelope: Envelope };

/**
 * The single structural check (D19), shared by `checkTokenStructure` and
 * `decryptSetupToken`. Synchronous and crypto-free: every parameter that
 * would steer key derivation is range-checked here, before any PBKDF2 runs.
 * Whitespace anywhere is ignored, so a token that picked up line breaks in
 * transit still reads as the same token.
 */
function inspect(raw: string): Inspection {
  const s = raw.replace(/\s+/g, "");
  const properPrefix = (p: string) => s.length < p.length && p.startsWith(s);
  if (properPrefix(V2_PREFIX) || properPrefix(V1_PREFIX)) return { check: "incomplete" };
  if (s.startsWith(V1_PREFIX)) return { check: "old-token" };
  const damaged = { check: "damaged" } as const;
  if (!s.startsWith(V2_PREFIX)) return damaged;

  const json = b64urlToBytes(s.slice(V2_PREFIX.length));
  const e = json && parseJsonObject(utf8(json));
  if (!e || e.v !== 2 || e.kdf !== KDF) return damaged;
  const iter = e.iter;
  if (typeof iter !== "number" || !Number.isInteger(iter) || iter < MIN_ITERATIONS || iter > MAX_ITERATIONS) {
    return damaged;
  }
  const salt = decodeField(e.salt, SALT_BYTES, SALT_BYTES);
  const iv = decodeField(e.iv, IV_BYTES, IV_BYTES);
  const ct = decodeField(e.ct, GCM_TAG_BYTES + 1, Infinity);
  if (!salt || !iv || !ct) return damaged;
  return { check: "complete", envelope: { iter, salt, iv, ct } };
}

/**
 * Synchronous, crypto-free check for the paste box: "complete" means the text
 * is a well-formed `gdvs2:` envelope (its code can only be checked by decrypting).
 */
export function checkTokenStructure(raw: string): TokenCheck {
  return inspect(raw).check;
}

async function deriveKey(
  code: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** Only the five known fields; null unless the three credentials are non-empty strings. */
function toLinkPayload(obj: Record<string, unknown> | null): LinkPayload | null {
  if (!obj) return null;
  const { clientId, clientSecret, refreshToken, folderId, folderName } = obj;
  const filled = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!filled(clientId) || !filled(clientSecret) || !filled(refreshToken)) return null;
  if (folderId !== undefined && typeof folderId !== "string") return null;
  if (folderName !== undefined && typeof folderName !== "string") return null;
  const p: LinkPayload = { clientId, clientSecret, refreshToken };
  if (folderId !== undefined) p.folderId = folderId;
  if (folderName !== undefined) p.folderName = folderName;
  return p;
}

/**
 * Encrypts the payload under a fresh code, salt and IV. `code` is the bare
 * 8-character string (use `formatCode` for display); show it, never store it.
 */
export async function encryptSetupToken(payload: LinkPayload): Promise<{ token: string; code: string }> {
  const code = generateCode();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const inner: Record<string, string> = {
    clientId: payload.clientId,
    clientSecret: payload.clientSecret,
    refreshToken: payload.refreshToken,
  };
  if (typeof payload.folderId === "string") inner.folderId = payload.folderId;
  if (typeof payload.folderName === "string") inner.folderName = payload.folderName;

  const key = await deriveKey(code, salt, ITERATIONS, "encrypt");
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(inner)),
  );
  const envelope = {
    v: 2,
    kdf: KDF,
    iter: ITERATIONS,
    salt: bytesToB64url(salt),
    iv: bytesToB64url(iv),
    ct: bytesToB64url(new Uint8Array(ct)),
  };
  const token = V2_PREFIX + bytesToB64url(new TextEncoder().encode(JSON.stringify(envelope)));
  return { token, code };
}

/**
 * Decrypts a pasted token with the typed code. Throws `SetupTokenError`:
 * "old-token" for `gdvs1:`, "damaged" for a malformed envelope (checked before
 * any key derivation) or an incomplete payload, and "wrong-code" for a code
 * that is malformed or fails AES-GCM authentication — a tampered token is
 * deliberately indistinguishable from a wrong code.
 */
export async function decryptSetupToken(raw: string, code: string): Promise<LinkPayload> {
  const inspection = inspect(raw);
  if (inspection.check === "old-token") throw new SetupTokenError("old-token");
  if (inspection.check !== "complete") throw new SetupTokenError("damaged");
  const { iter, salt, iv, ct } = inspection.envelope;

  const normalized = normalizeCode(code);
  if (!isCode(normalized)) throw new SetupTokenError("wrong-code");

  const key = await deriveKey(normalized, salt, iter, "decrypt");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch {
    throw new SetupTokenError("wrong-code");
  }
  const payload = toLinkPayload(parseJsonObject(utf8(new Uint8Array(plain))));
  if (!payload) throw new SetupTokenError("damaged");
  return payload;
}
