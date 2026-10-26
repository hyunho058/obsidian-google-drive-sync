/**
 * TT8 — acceptance tests for R8 (spec: specs/shared-folder-sync/spec.md, D18).
 *
 *   R8.1  folderLink and folderLinkName round-trip through the encrypted token
 *   R8.2  Payloads without the new fields still decode
 *   R8.3  applyLinkedFolder overwrites id, link and name from the payload, including to empty
 *   R8.4  Copy setup token includes the pinned folder — (manual) no test here: pin a folder
 *         on the Mac, copy a setup token, link the phone; the phone's field shows the Mac's
 *         link and `Linked to "<name>"` without any typing.
 */
import { test, eq, assert, run } from "./harness";
import { decryptSetupToken, encryptSetupToken, type LinkPayload } from "../src/auth/setup-token";
import { DEFAULT_SETTINGS, applyLinkedFolder, cloneSettings } from "../src/settings";

const CREDS = {
  clientId: "123.apps.googleusercontent.com",
  clientSecret: "GOCSPX-secret",
  refreshToken: "1//refresh-token-value",
};

/** Payload as D18 defines it; `LinkPayload` gains these fields in T5. */
type FolderPayload = LinkPayload & { folderLink?: string; folderLinkName?: string };

/** Same object with keys sorted, so `eq` compares content, not key order. */
function sorted(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = (o as Record<string, unknown>)[k];
  return out;
}

test("R8.1 folderLink and folderLinkName round-trip through the encrypted token", async () => {
  const payload: FolderPayload = {
    ...CREDS,
    folderId: "X1234567890",
    folderName: "My Vault",
    folderLink: "https://drive.google.com/drive/folders/X1234567890",
    folderLinkName: "공동",
  };
  const { token, code } = await encryptSetupToken(payload as LinkPayload);
  const decrypted = await decryptSetupToken(token, code);
  eq(sorted(decrypted), sorted(payload), "decrypted payload");
});

test("R8.2 Payloads without the new fields still decode", async () => {
  const payload: LinkPayload = { ...CREDS, folderId: "X1234567890" };
  const { token, code } = await encryptSetupToken(payload);
  const decrypted = await decryptSetupToken(token, code);
  assert(!("folderLink" in decrypted), "decrypted payload has no folderLink key");
  assert(!("folderLinkName" in decrypted), "decrypted payload has no folderLinkName key");
  eq(sorted(decrypted), sorted(payload), "decrypted payload");
});

test("R8.3 applyLinkedFolder overwrites id, link and name from the payload, including to empty", () => {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.rootFolderLink = "<old>";
  settings.rootFolderLinkName = "Old";
  settings.rootFolderId = "old";
  settings.rootFolderName = "Vault";

  applyLinkedFolder(settings, { ...CREDS, folderId: "", folderName: "Vault" });
  eq(
    {
      rootFolderId: settings.rootFolderId,
      rootFolderLink: settings.rootFolderLink,
      rootFolderLinkName: settings.rootFolderLinkName,
      rootFolderName: settings.rootFolderName,
    },
    { rootFolderId: "", rootFolderLink: "", rootFolderLinkName: "", rootFolderName: "Vault" },
    "after the first call",
  );

  const second: FolderPayload = {
    ...CREDS,
    folderId: "n1",
    folderLink: "<new>",
    folderLinkName: "New",
    folderName: "",
  };
  applyLinkedFolder(settings, second as LinkPayload);
  eq(
    {
      rootFolderId: settings.rootFolderId,
      rootFolderLink: settings.rootFolderLink,
      rootFolderLinkName: settings.rootFolderLinkName,
      rootFolderName: settings.rootFolderName,
    },
    { rootFolderId: "n1", rootFolderLink: "<new>", rootFolderLinkName: "New", rootFolderName: "Vault" },
    "after the second call",
  );
});

void run();
