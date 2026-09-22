import { Credentials } from "./oauth";

/**
 * The blob the Mac produces and the iPhone consumes. iOS cannot run the
 * interactive flow (no loopback listener), so the credentials travel as one
 * opaque paste instead.
 */
export interface SetupPayload extends Credentials {
  v: 1;
  folderId?: string;
  folderName?: string;
}

function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToUtf8(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const PREFIX = "gdvs1:";

export function encodeSetupToken(p: SetupPayload): string {
  return PREFIX + utf8ToB64(JSON.stringify(p));
}

export function decodeSetupToken(token: string): SetupPayload {
  const trimmed = token.trim();
  if (!trimmed.startsWith(PREFIX)) {
    throw new Error("That does not look like a setup token (expected it to start with 'gdvs1:').");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64ToUtf8(trimmed.slice(PREFIX.length)));
  } catch {
    throw new Error("The setup token is corrupt — copy it again from the desktop.");
  }
  const p = parsed as Partial<SetupPayload>;
  if (!p || p.v !== 1 || !p.clientId || !p.clientSecret || !p.refreshToken) {
    throw new Error("The setup token is missing fields — copy it again from the desktop.");
  }
  return p as SetupPayload;
}
