/**
 * Path handling.
 *
 * Every path that crosses the boundary between the vault and Google Drive is
 * normalized to NFC first. macOS and iOS hand back decomposed (NFD) filenames,
 * Drive stores whatever bytes it is given, and the two forms are visually
 * identical — so skipping this produces silent duplicates for any non-ASCII
 * filename.
 */

import { Platform } from "obsidian";

export function nfc(s: string): string {
  return s.normalize("NFC");
}

/** Canonical vault-relative path: NFC, forward slashes, no leading/trailing slash. */
export function canonical(path: string): string {
  return nfc(path)
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * Key used for collision detection only. APFS is case-insensitive by default
 * while Drive is case-sensitive, so `Note.md` and `note.md` are one file here
 * and two there.
 */
export function collisionKey(path: string): string {
  return canonical(path).toLowerCase();
}

export function dirOf(path: string): string {
  const i = canonical(path).lastIndexOf("/");
  return i < 0 ? "" : canonical(path).slice(0, i);
}

export function baseOf(path: string): string {
  const p = canonical(path);
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

export function joinPath(...parts: string[]): string {
  return canonical(parts.filter((p) => p.length > 0).join("/"));
}

/** Split `a/b/c.md` into ["a", "b"] — the folder chain that must exist. */
export function folderChain(path: string): string[] {
  const d = dirOf(path);
  return d === "" ? [] : d.split("/");
}

/**
 * Google Drive is not a path-based filesystem: a file's `name` may contain `/`,
 * `..` or control characters. Those names are turned into vault paths and
 * written to disk, so an unvetted name is a write outside the vault. Anything
 * that is not a plain, self-contained relative path is rejected rather than
 * rewritten — silently renaming an attacker's file would hide the attempt.
 *
 * `windows` adds the Windows naming rules. It defaults to the platform this
 * runs on, so every caller applies the same rule without passing it.
 */
export function isSafeVaultPath(path: string, windows = Platform.isWin): boolean {
  const p = canonical(path);
  if (p === "" || p.length > 1024) return false;
  // Control characters, including NUL. Windows drive letters and UNC prefixes.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith("//")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && (!windows || isWindowsSafeSegment(seg)));
}

/**
 * Names Windows cannot hold as written. It drops a trailing dot or space (so
 * `.obsidian.` would land in `.obsidian`), maps `CON`, `NUL` and the like to
 * devices whatever the extension, and reads `:` as a stream separator. Only
 * applied on Windows: elsewhere these are ordinary names, and rejecting a name
 * that exists locally would read as a remote delete.
 */
function isWindowsSafeSegment(seg: string): boolean {
  if (/[<>:"|?*]/.test(seg)) return false;
  if (/[. ]$/.test(seg)) return false;
  return !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i.test(seg);
}

/**
 * Glob matcher supporting `*`, `**` and a trailing `/` to mean "this folder
 * and everything under it". Deliberately small — this is user-facing config,
 * not a build tool.
 */
function globToRegExp(pattern: string): RegExp {
  const p = canonical(pattern);
  let out = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (p[i] === "/") i++;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  // The trailing group is what makes a folder pattern cover its descendants.
  return new RegExp(`^${out}(/.*)?$`, "i");
}

export class PathFilter {
  private readonly rules: RegExp[];

  constructor(patterns: string[]) {
    this.rules = patterns
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !p.startsWith("#"))
      .map(globToRegExp);
  }

  excludes(path: string): boolean {
    const p = canonical(path);
    return this.rules.some((r) => r.test(p));
  }
}

/**
 * `notes/meeting.md` -> `notes/meeting (conflict 2026-09-22 1430 iPhone).md`
 * The device name matters: without it, two devices resolving the same conflict
 * produce the same filename and clobber each other.
 */
export function conflictPath(path: string, device: string, when: Date): string {
  const p = canonical(path);
  const dot = baseOf(p).lastIndexOf(".");
  const stem = dot > 0 ? p.slice(0, p.length - (baseOf(p).length - dot)) : p;
  const ext = dot > 0 ? baseOf(p).slice(dot) : "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}${pad(when.getMinutes())}`;
  const safeDevice = device.replace(/[\\/:*?"<>|]/g, "-").trim() || "device";
  return `${stem} (conflict ${stamp} ${safeDevice})${ext}`;
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  canvas: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  zip: "application/zip",
};

export function mimeFor(path: string): string {
  const b = baseOf(path);
  const dot = b.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXT[b.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
