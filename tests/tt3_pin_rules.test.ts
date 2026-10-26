/**
 * Acceptance tests for R3 of specs/shared-folder-sync/spec.md: pinning,
 * unpinning and verifying the root folder (D2, D3, D10, D12, D13, D15, D16,
 * D17, D19). Each case asserts exactly one GWT; expected messages are written
 * out literally so the user-facing text is pinned by the test.
 *
 * Deferred to a person (manual, no tests here):
 *   R3.11 The settings tab commits the field on blur or Enter, never per keystroke
 *   R3.12 Pinning resets the baseline and the name field stops resetting it
 *   R3.13 Clearing the link reverts to the name-based folder
 *   R3.14 A pin made before sign-in shows "Will be checked at the first sync" and is verified then
 *   R3.15 The old-scope hint appears only when a token response proves the scope is narrow
 */

import { planFolderLink, rootProblem } from "../src/drive/folder-ref";
import type { FolderInspection } from "../src/drive/types";
import { DriveError } from "../src/drive/client";
import { AuthError } from "../src/auth/oauth";
import { DEFAULT_SETTINGS, cloneSettings } from "../src/settings";
import { test, eq, run } from "./harness";

function folder(id: string, name: string, over: Partial<FolderInspection> = {}): FolderInspection {
  return { id, name, isFolder: true, trashed: false, writable: true, ...over };
}

const LINK = "https://drive.google.com/drive/folders/NEW1234567890";

test("R3.1 unparseable input is refused without touching settings", () => {
  const current = { rootFolderLink: "", rootFolderId: "old" };
  eq(planFolderLink(current, "not a link", null, true), {
    kind: "refuse",
    message: "That is not a Google Drive folder link or ID.",
  });
  eq(current, { rootFolderLink: "", rootFolderId: "old" }, "current is untouched");
});

test("R3.2 re-committing the stored link is a no-op", () => {
  const current = {
    rootFolderLink: "https://drive.google.com/drive/folders/X1234567890",
    rootFolderId: "X1234567890",
  };
  const inspect = folder("X1234567890", "My Vault");
  eq(
    planFolderLink(current, " https://drive.google.com/drive/folders/X1234567890 ", inspect, true),
    { kind: "noop" },
  );
});

test("R3.3 pinning the folder the plugin created by name keeps the baseline", () => {
  const current = { rootFolderLink: "", rootFolderId: "X1234567890" };
  const inspect = folder("X1234567890", "My Vault");
  eq(planFolderLink(current, "X1234567890", inspect, true), {
    kind: "pin",
    id: "X1234567890",
    name: "My Vault",
    resetBaseline: false,
  });
});

test("R3.4 pinning a different writable folder resets the baseline", () => {
  const current = { rootFolderLink: "", rootFolderId: "old" };
  const inspect = folder("NEW1234567890", "공동");
  eq(planFolderLink(current, LINK, inspect, true), {
    kind: "pin",
    id: "NEW1234567890",
    name: "공동",
    resetBaseline: true,
  });
});

test("R3.5 a file, a trashed folder and a view-only folder are refused with their own messages", () => {
  const current = { rootFolderLink: "", rootFolderId: "old" };
  eq(
    planFolderLink(current, LINK, folder("NEW1234567890", "f", { isFolder: false }), true),
    { kind: "refuse", message: "That link points to a file, not a folder." },
    "file",
  );
  eq(
    planFolderLink(current, LINK, folder("NEW1234567890", "t", { trashed: true }), true),
    { kind: "refuse", message: "That folder is in the Drive trash." },
    "trashed",
  );
  eq(
    planFolderLink(current, LINK, folder("NEW1234567890", "v", { writable: false }), true),
    {
      kind: "refuse",
      message: "You can only view this folder. Ask its owner for edit access, or pick another folder.",
    },
    "view-only",
  );
});

test("R3.6 a 404 is refused with the not-found message, plus the hint when the scope is known to be old", () => {
  const inspect = { error: new DriveError("…", 404) };
  const hint = "This sign-in can only see folders the plugin created. Sign in again to use a shared folder.";
  eq(rootProblem(inspect, false, null), "Google can't find this folder with this sign-in.", "no hint");
  eq(
    rootProblem(inspect, false, hint),
    "Google can't find this folder with this sign-in. " + hint,
    "with hint",
  );
});

test("R3.7 empty input unpins; input while not linked defers", () => {
  const current = { rootFolderLink: "https://drive.google.com/drive/folders/X1234567890", rootFolderId: "X1234567890" };
  eq(planFolderLink(current, "", null, true), { kind: "unpin" }, "empty input");
  eq(
    planFolderLink({ rootFolderLink: "", rootFolderId: "" }, "Y1234567890", null, false),
    { kind: "defer", id: "Y1234567890" },
    "not linked",
  );
});

test("R3.8 a root lost after verification gets the gone message; one never verified gets D12's", () => {
  const inspect = { error: new AuthError("…", false, 403) };
  eq(
    rootProblem(inspect, true, null),
    "The Drive folder this vault syncs with is gone or no longer shared with you. Pick another folder in the plugin settings.",
    "verified before",
  );
  eq(rootProblem(inspect, false, null), "Google can't find this folder with this sign-in.", "never verified");
});

test("R3.9 a viewer downgrade after the pin stops the sync with its own message; a healthy root returns null", () => {
  const downgraded = folder("X1234567890", "Shared", { writable: false });
  eq(
    rootProblem(downgraded, true, null),
    "You can only view this folder now. Ask its owner for edit access, or pick another folder. Sync stopped.",
    "viewer downgrade",
  );
  eq(rootProblem(folder("X1234567890", "Shared"), true, null), null, "healthy");
});

test("R3.10 settings carry the three root fields with empty defaults", () => {
  // A 0.2.2 data.json: every key the defaults had then, minus the two new ones.
  const stored: Record<string, unknown> = { ...cloneSettings(DEFAULT_SETTINGS) };
  delete stored.rootFolderLink;
  delete stored.rootFolderLinkName;
  stored.rootFolderName = "My Vault";
  stored.rootFolderId = "stored1234567";
  const s = Object.assign(cloneSettings(DEFAULT_SETTINGS), stored);
  eq(s.rootFolderLink, "", "rootFolderLink");
  eq(s.rootFolderLinkName, "", "rootFolderLinkName");
  eq(s.rootFolderName, "My Vault", "rootFolderName");
  eq(s.rootFolderId, "stored1234567", "rootFolderId");
});

void run();
