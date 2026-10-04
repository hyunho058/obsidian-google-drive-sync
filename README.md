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

1. On the Mac: settings → **Copy setup token** → **Copy token**. Only after the token
   is on the clipboard does the window show a one-time code such as `K7Q4-ZP9M`.
   Leave that window open.
2. Get the token to your phone (Universal Clipboard or AirDrop). It is encrypted, so
   it is useless without the code, but there is no reason to post it anywhere.
3. On the iPhone: install and enable the plugin, then settings → **Paste setup
   token**. Paste the token, type the code (case, spaces and dashes don't matter),
   and tap **Link this device**. The plugin checks the sign-in with Google, saves
   it, and runs a first sync. A mistyped code just asks you to type it again.

After this the phone is a full peer — it refreshes its own access tokens directly
against Google. It just could not do the initial handshake.

Both devices must run version 0.2.0 or later: older versions cannot read the
encrypted token, and the new version refuses the old unencrypted kind.

### Updating the plugin on the iPhone

Without BRAT, updating the phone means replacing its vault folder, which also
replaces this plugin's settings file, so the phone has to be linked again:

1. Update the Mac first and restart Obsidian on it once.
2. Copy a folder that contains only the plugin
   (`.obsidian/plugins/gdrive-vault-sync/` with `main.js`, `manifest.json` and
   `styles.css`, plus `.obsidian/community-plugins.json`) onto the phone. Never copy
   the Mac's own vault folder: for one start after an update its settings file can
   still hold the old plaintext sign-in.
3. Link again with a new setup token and code, as above. Your notes come back down
   from Drive; nothing is deleted.

The previous sign-in stays behind in Obsidian's app storage on the phone, outside the
vault. Obsidian offers no way to delete it, and the plugin never reads it again.

## Installing

Requires Obsidian 1.11.4 or later (for its secure storage) on every device.

**From a release (recommended).** Install
[BRAT](https://github.com/TfTHacker/obsidian42-brat), then *Add beta plugin* →
`hyunho058/obsidian-google-drive-sync`. BRAT pulls `main.js`, `manifest.json` and `styles.css` from
the latest [GitHub release](https://github.com/hyunho058/obsidian-google-drive-sync/releases)
and keeps them updated. This works the same on Mac and iPhone.

**From source.** Copy the build into your vault:

```bash
npm install
npm run build

PLUGIN="$HOME/path/to/YourVault/.obsidian/plugins/gdrive-vault-sync"
mkdir -p "$PLUGIN"
cp main.js manifest.json styles.css "$PLUGIN/"
```

Then enable it under Settings → Community plugins. On iOS without BRAT, put the same
files in the vault's plugin folder via the Files app.

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
- **Credentials are never synced.** The client secret and refresh token are kept in
  Obsidian's secure storage, outside the vault, on each device. This plugin's own
  folder is also permanently excluded, since its `data.json` still holds the Drive
  folder id and sync records.
- **Local deletes go to the vault's `.trash`**, not straight to oblivion. Remote
  deletes go to the Drive trash.

## Security model

**What holds your credentials.** The client secret and refresh token are kept in
Obsidian's secure storage (`SecretStorage`, Obsidian 1.11.4 and later): per device and
outside the vault folder, so copying, backing up or syncing the vault never carries
them. Obsidian does not document whether that storage is encrypted on disk, so treat
it as "out of the vault", not as "encrypted". It is also shared with other installed
plugins, which could already read this plugin's settings file before. The client ID
is not a secret and stays in `data.json`. Anyone who gets the refresh token has access
to the Drive folder; revoke it at <https://myaccount.google.com/permissions>.

Older versions kept these secrets in plaintext in `data.json`. Updating moves them in
two steps: the first start copies them into secure storage, and the next start
removes them from `data.json` once it finds them stored. Until then the old copy is
still used, so sync never stops.

This plugin's folder is permanently excluded from sync anyway, resolved from its
actual install directory at runtime rather than a hardcoded name.

**The setup token is encrypted.** It is AES-256-GCM, keyed by PBKDF2-SHA256 (600,000
rounds) from an 8-character one-time code. The code is shown only on the copying
device's screen and never goes to the clipboard, so a token left in clipboard history
or a message is useless on its own. Trying every code against a leaked token takes
roughly two years on one high-end GPU, less with more GPUs. Tokens do not expire: if
one leaks together with its code, revoke access at
<https://myaccount.google.com/permissions> and link again. Old unencrypted tokens
(`gdvs1:`) are refused.

**Remote filenames are untrusted input.** Google Drive is not a path-based store, and a
file's `name` may contain `/`, `..` or control characters. Those names become vault
paths and get written to disk, so every remote path is validated before use; anything
containing a traversal segment, a control character or a drive letter is skipped and
reported rather than silently renamed.

**File access goes through the adapter API.** Obsidian's Vault API only sees files it
indexes, which leaves out dotfolders such as the config folder. Syncing those when
asked to means reading and writing through `vault.adapter` instead.

**Downloads are verified** against Drive's `md5Checksum` before they touch the vault.

**Uploads are pinned** to `https://*.googleapis.com`. The resumable session URI arrives
in a response header and then receives your file contents, so it is checked rather than
followed wherever it points.

**Sign-in.** PKCE (S256) with a random `state` that is verified on return. The loopback
listener binds to `127.0.0.1` only, on an OS-assigned port, and shuts down as soon as
the code arrives or after five minutes.

**Enabling config-folder sync has a cost.** This plugin's folder stays excluded, but other
plugins' `data.json` files do not — several community plugins keep API keys there, and
turning this on uploads them. Plugin code syncs too, so any linked device can change
the plugins that run on every other one. The config folder is read from the vault
rather than assumed to be `.obsidian`, so a renamed one is excluded the same way.

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
| "This device's sign-in is missing" | Obsidian's app storage was cleared (e.g. a reinstall). Notes are untouched; sign in again on desktop, or paste a new setup token on the phone. |
| "That code doesn't match this token" | The code was mistyped, or it belongs to a different copy. Type it again, or copy a new token. |
| "This is an old, unencrypted setup token" | The copying device runs a version before 0.2.0. Update it and copy a new token. |

Turn on **Verbose logging** in Advanced for per-file detail in the developer console.

## Development

```bash
npm run dev     # watch build
npm test        # pure-logic tests (paths, globs, conflicts, setup token, credential store, md5)
npm run check   # typecheck + tests
```

The iOS bundle must never statically reference a Node builtin. `http` and `electron`
are reached only through `window.require` inside a desktop-only branch; verify with:

```bash
grep -oE 'require\("[a-z_]+"\)' main.js | sort -u   # expect only require("obsidian")
```

### Releasing

```bash
npm version patch   # or minor / major
git push --follow-tags
```

`npm version` bumps `package.json`, copies the version into `manifest.json`, records it
in `versions.json`, commits, and creates a bare tag like `0.1.1` (no `v` — Obsidian
requires that). Pushing the tag runs `.github/workflows/release.yml`, which checks that
the tag matches the manifest, runs the tests, builds, checks the bundle for Node
builtins, and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css` attached.
