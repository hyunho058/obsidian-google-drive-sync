/**
 * Folder links and the rules for pinning the sync root to one.
 *
 * Kept free of `obsidian` (and of the modules that import it) so the rules can
 * be tested in node. The settings tab and the sync start only wire these: they
 * make the `files.get` call and act on the answer.
 */

import { describeError } from "../util/log";
import type { FolderInspection } from "./types";

/** A Drive item ID. Real ones are longer; 10 keeps typos like "short" out. */
export const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

const ID = "([A-Za-z0-9_-]{10,})";
const HOST = "^(?:https?://)?(?:www\\.)?drive\\.google\\.com";
const LINK_FORMS: RegExp[] = [
  // /drive/folders/<id>, /drive/u/<n>/folders/<id>, /drive/mobile/folders/<id>
  new RegExp(`${HOST}/drive/(?:u/\\d+/|mobile/)?folders/${ID}/?(?:[?#].*)?$`, "i"),
  // /open?id=<id> and the legacy /folderview?id=<id>
  new RegExp(`${HOST}/(?:open|folderview)\\?(?:[^#]*&)?id=${ID}(?:[&#].*)?$`, "i"),
];

export const MSG_NOT_A_LINK = "That is not a Google Drive folder link or ID.";
export const MSG_NOT_FOUND = "Google can't find this folder with this sign-in.";
export const MSG_NOT_A_FOLDER = "That link points to a file, not a folder.";
export const MSG_TRASHED = "That folder is in the Drive trash.";
export const MSG_VIEW_ONLY = "You can only view this folder. Ask its owner for edit access, or pick another folder.";
export const MSG_GONE =
  "The Drive folder this vault syncs with is gone or no longer shared with you. Pick another folder in the plugin settings.";
export const MSG_VIEW_ONLY_NOW =
  "You can only view this folder now. Ask its owner for edit access, or pick another folder. Sync stopped.";
/**
 * Changing the sync root while a sync runs would let that sync's index, which
 * describes the old folder, land on the new one; so the change waits.
 */
export const MSG_SYNC_RUNNING = "A sync is running. Try again when it finishes.";

/**
 * The folder ID in a drive.google.com folder link or a bare ID, or `null`.
 * File links are refused rather than read for their ID: the root must be a
 * folder, and saying so beats a confusing "not a folder" after a lookup.
 */
export function parseFolderRef(input: string): string | null {
  const text = input.trim();
  // A link never contains whitespace; text with spaces is a name or a typo.
  if (text === "" || /\s/.test(text)) return null;
  if (FOLDER_ID_PATTERN.test(text)) return text;
  for (const form of LINK_FORMS) {
    const m = form.exec(text);
    if (m) return m[1];
  }
  return null;
}

export type FolderLinkPlan =
  | { kind: "noop" }
  | { kind: "unpin" }
  | { kind: "defer"; id: string }
  | { kind: "pin"; id: string; name: string; resetBaseline: boolean }
  | { kind: "refuse"; message: string };

/**
 * What committing the folder link field should do. `inspect` is the caller's
 * `files.get` of the parsed ID, or `null` when it could not make one; lookup
 * errors go through `rootProblem` instead.
 */
export function planFolderLink(
  current: { rootFolderLink: string; rootFolderId: string },
  input: string,
  inspect: FolderInspection | null,
  linked: boolean,
): FolderLinkPlan {
  const text = input.trim();
  // Blur fires on every focus change; re-committing what is stored must not reset anything.
  if (text === current.rootFolderLink) return { kind: "noop" };
  if (text === "") return { kind: "unpin" };
  const id = parseFolderRef(text);
  if (id === null) return { kind: "refuse", message: MSG_NOT_A_LINK };
  if (id === current.rootFolderId && current.rootFolderLink !== "") return { kind: "noop" };
  // Without a sign-in (or an answer) Google cannot be asked; the first sync verifies it.
  if (!linked || inspect === null) return { kind: "defer", id };
  const problem = rootProblem(inspect, false, null);
  if (problem !== null) return { kind: "refuse", message: problem };
  // Pasting the link of the folder already in use (found by name) changes no files.
  return { kind: "pin", id, name: inspect.name, resetBaseline: id !== current.rootFolderId };
}

/**
 * Why the root cannot be synced with, or `null` when it can. `verifiedBefore`
 * picks the wording: a folder that was reachable once is "gone", while one
 * never verified gets the same message as a refused pin.
 */
export function rootProblem(
  inspect: FolderInspection | { error: unknown },
  verifiedBefore: boolean,
  hint: string | null,
): string | null {
  if ("error" in inspect) {
    if (isUnreachable(inspect.error)) {
      if (verifiedBefore) return MSG_GONE;
      return hint === null ? MSG_NOT_FOUND : `${MSG_NOT_FOUND} ${hint}`;
    }
    return describeError(inspect.error);
  }
  if (!inspect.isFolder) return verifiedBefore ? MSG_GONE : MSG_NOT_A_FOLDER;
  if (inspect.trashed) return verifiedBefore ? MSG_GONE : MSG_TRASHED;
  if (!inspect.writable) return verifiedBefore ? MSG_VIEW_ONLY_NOW : MSG_VIEW_ONLY;
  return null;
}

/**
 * Google answers 404 for an item the token cannot see and 403 for one it can
 * see but not open; to the user both mean "not reachable with this sign-in".
 * Matched by shape, not `instanceof`: the error classes live in modules that
 * import `obsidian`, which this one must not.
 */
function isUnreachable(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { name, status } = e as { name?: unknown; status?: unknown };
  if (typeof status !== "number") return false;
  return (name === "DriveError" && status === 404) || (name === "AuthError" && status === 403);
}
