# Google Drive Vault Sync

Two-way sync between an Obsidian vault and Google Drive, using **your own** Google
credentials. No third-party server is involved: your devices talk to Google directly.

Built for a Mac + iPhone pair, which is the combination that shapes most of the design.

## How it works

- **Scope:** `drive.file` only. The plugin can see the files it created and nothing
  else in your Drive. This is a *non-sensitive* scope, so it needs no Google
  verification review and no paid CASA security assessment.
- **Identity:** your vault's folder tree is mirrored as real Drive folders, so the
  remote copy is browsable in drive.google.com.
- **Comparison:** content hashes (Drive's `md5Checksum`), not timestamps.
- **Baseline:** a local index records the last state both sides agreed on, which is
  what lets "deleted here" be told apart from "not uploaded yet".

## Setup

### 1. Google Cloud (once, ~10 minutes)

1. Create a project at <https://console.cloud.google.com>.
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen →** User type **External**. Fill in the
   app name, your support email, and your developer contact email.
4. **Publish the consent screen — set the status to `In production`.**

   This step is not optional. A consent screen left in `Testing` issues refresh
   tokens that **expire after exactly 7 days**, and sync will die with an
   `invalid_grant` error a week after it starts working. Because `drive.file` is a
   non-sensitive scope, publishing goes through immediately with no review.
5. **Credentials → Create credentials → OAuth client ID → Application type:
   Desktop app.** Copy the client ID and client secret.

   No redirect URI needs registering: Desktop-app clients accept any
   `http://127.0.0.1:<port>` loopback, and the plugin picks a free port at runtime.

### 2. Mac

1. Install the plugin (see below) and enable it.
2. Paste the client ID and client secret into the plugin settings.
3. Click **Sign in**. Your browser opens; approve access and return to Obsidian.
4. The vault syncs to a Drive folder named after your vault.

### 3. iPhone

iOS cannot complete an OAuth sign-in. There is no way around this: Google rejects
`obsidian://` redirect URIs for every client type, and iOS cannot open the loopback
listener that the desktop flow uses. So the credentials travel from the Mac instead.

1. On the Mac: settings → **Copy setup token**.
2. Get that string to your phone (AirDrop, Notes, a password manager — it grants
   access to the Drive folder, so do not put it somewhere public).
3. On the iPhone: install and enable the plugin, then settings → **Paste setup
   token**. It links and runs a first sync.

After this the phone is a full peer — it refreshes its own access tokens directly
against Google. It just could not do the initial handshake.

## Installing

No release pipeline yet; copy the build into your vault:

```bash
npm install
npm run build

PLUGIN="$HOME/path/to/YourVault/.obsidian/plugins/gdrive-vault-sync"
mkdir -p "$PLUGIN"
cp main.js manifest.json "$PLUGIN/"
```

Then enable it under Settings → Community plugins. On iOS, the easiest route is
[BRAT](https://github.com/TfTHacker/obsidian42-brat), or put the same three files in
the vault's plugin folder via the Files app.

## Conflicts

Markdown is never merged automatically. When a note changed on both sides since the
last sync and the content differs:

- the remote version is written to the original path,
- this device's version is kept as
  `note (conflict 2026-09-22 1430 iPhone).md`,
- the conflict copy is uploaded, so the other device sees both.

The device name is part of the filename so two devices resolving the same conflict
never overwrite each other. Set it under **Devices → Device name**.

## Safety

- **Deletion guard.** If more than 20% of tracked files vanish from one side, the
  sync stops without changing anything and tells you. This is what stops a folder
  trashed in Drive, or a vault that has not finished hydrating on the phone, from
  propagating as a mass delete. Adjustable under Advanced.
- **Credentials are never synced.** `.obsidian/plugins/gdrive-vault-sync/` is
  permanently excluded, so the refresh token in `data.json` stays on each device.
- **Local deletes go to the vault's `.trash`**, not straight to oblivion. Remote
  deletes go to the Drive trash.

## Security model

**What holds your credentials.** The client ID, client secret and refresh token live
in plaintext in this plugin's `data.json`, inside your vault. Obsidian has no secret
store, and the phone needs the refresh token locally to mint access tokens. Anyone
with read access to that file, or to a backup of it, has access to the Drive folder.
Revoke at <https://myaccount.google.com/permissions>.

That folder is permanently excluded from sync, resolved from the plugin's actual
install directory at runtime rather than a hardcoded name — a stale guess would
upload the credentials to Drive and to every linked device.

**The setup token is encoded, not encrypted.** It is base64 and trivially reversible.
It is a password in transit: it goes through the system clipboard, so clipboard-history
tools (Raycast, Alfred, Maccy) and macOS Universal Clipboard may retain it. Clear them
after linking a device.

**Remote filenames are untrusted input.** Google Drive is not a path-based store, and a
file's `name` may contain `/`, `..` or control characters. Those names become vault
paths and get written to disk, so every remote path is validated before use; anything
containing a traversal segment, a control character or a drive letter is skipped and
reported rather than silently renamed.

**Downloads are verified** against Drive's `md5Checksum` before they touch the vault.

**Uploads are pinned** to `https://*.googleapis.com`. The resumable session URI arrives
in a response header and then receives your file contents, so it is checked rather than
followed wherever it points.

**Sign-in.** PKCE (S256) with a random `state` that is verified on return. The loopback
listener binds to `127.0.0.1` only, on an OS-assigned port, and shuts down as soon as
the code arrives or after five minutes.

**Enabling `.obsidian` sync has a cost.** This plugin's folder stays excluded, but other
plugins' `data.json` files do not — several community plugins keep API keys there, and
turning this on uploads them.

## Known limits

- **`drive.file` cannot see files it did not create.** A file you upload by hand to
  the Drive folder through drive.google.com is invisible to the plugin. Add files
  through Obsidian.
- **No background sync on iOS.** Apple suspends the app, so sync runs on launch, on
  returning to the foreground, after an idle delay following an edit, and on demand.
- **Renames re-upload.** A file's identity is its path, so renaming a large
  attachment costs a fresh upload.
- **Case collisions.** APFS is case-insensitive and Drive is not. If `Note.md` and
  `note.md` both exist remotely, one is skipped and reported rather than guessed at.
- **Do not stack sync engines.** If the vault lives in iCloud Drive *and* this plugin
  is running, two systems fight over the same files. Keep the iPhone vault in
  "On My iPhone" storage.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `invalid_grant` after about a week | The consent screen is still in `Testing`. Set it to `In production` and sign in again. |
| "Google returned no refresh token" | The app is already authorized. Revoke it at <https://myaccount.google.com/permissions> and sign in again. |
| Sync stopped with a deletion warning | The guard fired. Check both sides; if it was intentional, run **Reset sync state**. |
| Duplicate-looking Korean/Japanese filenames | Should not happen — paths are normalized to NFC on both sides. Report it if it does. |

Turn on **Verbose logging** in Advanced for per-file detail in the developer console.

## Development

```bash
npm run dev     # watch build
npm test        # pure-logic tests (paths, globs, conflicts, setup token, md5)
npm run check   # typecheck + tests
```

The iOS bundle must never statically reference a Node builtin. `http` and `electron`
are reached only through `window.require` inside a desktop-only branch; verify with:

```bash
grep -oE 'require\("[a-z_]+"\)' main.js | sort -u   # expect only require("obsidian")
```
