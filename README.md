# Vault Sync for Google Drive

Two-way sync between an Obsidian vault and Google Drive, using **your own** Google
credentials. No third-party server is involved: your devices talk to Google directly.

Tested on macOS and iOS. Windows and Linux use the same desktop sign-in as macOS.
Android should work the same way as iOS but has not been tested yet.

## Disclosures

- **Account required.** You need a Google account and your own (free) Google Cloud
  project with an OAuth client; setup is described below.
- **Network use.** The plugin talks only to Google: `accounts.google.com` and
  `oauth2.googleapis.com` to sign in and refresh access, and `www.googleapis.com` to
  read and write your notes in Google Drive. It contacts no other server.
- **No telemetry, no ads, no payments.** Nothing about you or your vault is collected.
- **Files outside the vault.** The client secret and refresh token are stored in
  Obsidian's secure storage, outside the vault, on each device. If Obsidian's
  "Deleted files" setting uses the system trash, files removed by sync go there.
  Nothing else outside the vault is read or written. Desktop sign-in briefly listens
  on `127.0.0.1` for Google's redirect.

## How it works

- **Scope:** full Google Drive access (`https://www.googleapis.com/auth/drive`).
  The narrower `drive.file` scope only sees files the app itself created or opened,
  so it cannot see a folder someone shared with you, nor files a collaborator adds
  to it later, and the Google Picker that would widen it file by file does not run
  inside Obsidian on iOS. Full Drive is a Google *restricted* scope. The cost is the
  blast radius: a leaked refresh token, or a setup token leaked together with its
  code, can reach your whole Drive rather than one folder. It is still only ever
  your own OAuth client; the plugin ships none and no one else's app holds the
  permission.
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
   `invalid_grant` error a week after it starts working.

   Your client is not verified by Google, and it does not need to be. On the first
   sign-in Google shows "Google hasn't verified this app". Choose **Advanced → Go to
   <app name> (unsafe)** to continue; that is expected for a client only you use.
   Verification and the 100-user cap only matter if you share your client ID with
   many people. If Google blocks the sign-in outright instead of warning, that is
   decided on Google's side and nothing in the plugin can change it.
5. **Credentials → Create credentials → OAuth client ID → Application type:
   Desktop app.** Copy the client ID and client secret.

   No redirect URI needs registering: Desktop-app clients accept any
   `http://127.0.0.1:<port>` loopback, and the plugin picks a free port at runtime.

### 2. Desktop

1. Install the plugin (see below) and enable it.
2. Paste the client ID and client secret into the plugin settings.
3. Click **Sign in**. Your browser opens; approve access and return to Obsidian.
4. The vault syncs to a Drive folder named after your vault.

Every desktop signs in this way. To link a phone, you need one desktop that is
already signed in.

### 3. Mobile

A phone cannot complete an OAuth sign-in. There is no way around this: Google rejects
`obsidian://` redirect URIs for every client type, and the mobile app cannot open the
loopback listener that the desktop flow uses. So the credentials travel from a signed-in
desktop instead. These steps are tested on iOS; Android has not been tested yet.

1. On the desktop: settings → **Copy setup token** → **Copy token**. Only after the
   token is on the clipboard does the window show a one-time code such as
   `K7Q4-ZP9M`. Leave that window open.
2. Get the token to your phone any way you like, such as Universal Clipboard,
   AirDrop or a note to yourself. It is encrypted, so it is useless without the code,
   but there is no reason to post it anywhere.
3. On the phone: install and enable the plugin, then settings → **Paste setup
   token**. Paste the token into box 1, type the code into box 2 (case, spaces and
   dashes don't matter), and tap **Link this device**. The plugin checks the sign-in
   with Google, saves it, and runs a first sync. A mistyped code just asks you to
   type it again.

After this the phone is a full peer — it refreshes its own access tokens directly
against Google. It just could not do the initial handshake.

### Syncing a shared folder

To sync with a folder someone shared with you, or any other folder in your Drive:

1. Open the folder on drive.google.com and copy its link from the address bar (the
   folder ID on its own works too).
2. On the desktop, paste it into **Drive folder link or ID** in the plugin settings.
3. Check that `Linked to "<name>"` appears under the field with the folder's name.
4. Click **Sync now**.
5. Copy a new setup token to the phone and link it again as above. The token carries
   the folder, so the phone syncs the same one.

Notes:

- You need edit access. A folder you can only view is refused, since sync writes
  both ways.
- Clearing the field goes back to the folder named in **Drive folder name**.
- Pasting the link of a folder the plugin created earlier keeps using that folder.
  This is how to keep your old folder after recreating your OAuth client: a new
  client cannot recognise the old folder by name, so it would otherwise create a
  fresh one.
- Folders in Shared Drives work too.

## Installing

Requires Obsidian 1.11.4 or later (for its secure storage) on every device.

**From Community plugins (recommended).** In Obsidian, open Settings → Community
plugins → Browse, search for **Vault Sync for Google Drive**, then install and enable
it. Obsidian keeps it updated on every device.

**Beta versions.** Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then
*Add beta plugin* → `hyunho058/obsidian-google-drive-sync`. BRAT pulls `main.js`,
`manifest.json` and `styles.css` from the latest
[GitHub release](https://github.com/hyunho058/obsidian-google-drive-sync/releases)
and keeps them updated.

**From source.** Copy the build into your vault:

```bash
npm install
npm run build

PLUGIN="$HOME/path/to/YourVault/.obsidian/plugins/gdrive-vault-sync"
mkdir -p "$PLUGIN"
cp main.js manifest.json styles.css "$PLUGIN/"
```

Then enable it under Settings → Community plugins. On a phone, put the same files in
the vault's plugin folder, for example via the Files app on iOS.

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
- **Local deletes are never permanent.** They follow Obsidian's "Deleted files"
  setting when it is the system trash or the vault's `.trash`. When it is set to
  "Permanently delete", sync still moves the file to the vault's `.trash`. Files in
  the config folder, which Obsidian does not index, always go to the vault's
  `.trash`. Remote deletes go to the Drive trash.

## Security model

**What holds your credentials.** The client secret and refresh token are kept in
Obsidian's secure storage (`SecretStorage`, Obsidian 1.11.4 and later): per device and
outside the vault folder, so copying, backing up or syncing the vault never carries
them. Obsidian does not document whether that storage is encrypted on disk, so treat
it as "out of the vault", not as "encrypted". It is also shared with other installed
plugins, which can read this plugin's settings file as well. The client ID
is not a secret and stays in `data.json`. Anyone who gets the refresh token has access
to your whole Google Drive; revoke it at <https://myaccount.google.com/permissions>.

This plugin's folder is permanently excluded from sync anyway, resolved from its
actual install directory at runtime rather than a hardcoded name.

**The setup token is encrypted.** It is AES-256-GCM, keyed by PBKDF2-SHA256 (600,000
rounds) from an 8-character one-time code. The code is shown only on the copying
device's screen and never goes to the clipboard, so a token left in clipboard history
or a message is useless on its own. Trying every code against a leaked token takes
roughly two years on one high-end GPU, less with more GPUs. Tokens do not expire: if
one leaks together with its code, revoke access at
<https://myaccount.google.com/permissions> and link again.

**Remote filenames are untrusted input.** Google Drive is not a path-based store, and a
file's `name` may contain `/`, `..` or control characters. Those names become vault
paths and get written to disk, so every remote path is validated before use; anything
containing a traversal segment, a control character or a drive letter is skipped and
reported rather than silently renamed. On Windows, names it would silently rewrite
(a trailing dot or space, device names like `CON`, or `<>:"|?*`) are skipped too.
Each skipped name is listed in the developer console once per session. A file
skipped this way is left alone: it is not treated as deleted, so it stays in Google
Drive and on the devices that can hold it.

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

- **Google Docs, Sheets and Slides are skipped.** These files (and Drive shortcuts)
  have no file content to download, so sync leaves them alone in Drive. A notice counts
  them as skipped, and the developer console names each one once per session.
- **Files owned by someone else cannot be deleted from Drive by you.** In a shared
  folder, deleting such a file here does not remove it from Drive; the next sync
  brings it back. Ask its owner to delete it.
- **A view-only folder is refused.** Sync needs edit access to the folder.
- **Android is untested.** It is expected to behave like iOS, with the setup token
  for linking. Reports are welcome.
- **No background sync on mobile.** The phone suspends the app, so sync runs on
  launch, on returning to the foreground, after an idle delay following an edit, and
  on demand.
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
| "unusable name(s) skipped" | A Google Drive file's name cannot be a vault path on this device, such as `Plan?.md` on Windows. The developer console lists it. Rename it on a device that can hold it. |
| Sync stopped with a deletion warning | The guard fired. Check both sides; if it was intentional, run **Reset sync state**. |
| Duplicate-looking Korean/Japanese filenames | Should not happen — paths are normalized to NFC on both sides. Report it if it does. |
| "This device's sign-in is missing" | Obsidian's app storage was cleared (e.g. a reinstall). Notes are untouched; sign in again on desktop, or paste a new setup token on the phone. |
| "That looks like the code" | The code went into the token box. Paste the setup token into box 1 and type the code into box 2. |
| "That code doesn't match this token" | The code was mistyped, or it belongs to a different copy. Type it again, or copy a new token. |
Skipped files, unusable names and conflict copies are named in the developer console
by default. Turn on **Verbose logging** in Advanced for per-file detail of every sync.

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

Changes reach `main` through pull requests. After the version bump is merged, tag the
merge commit on `main` and push the tag:

```bash
npm version patch   # or minor / major
git push origin main
git push origin <version>
```

`npm version` bumps `package.json`, copies the version into `manifest.json`, records it
in `versions.json`, commits, and creates a bare tag like `1.0.1` (no `v` — Obsidian
requires that). Pushing the tag runs `.github/workflows/release.yml`, which checks that
the tag matches the manifest, runs the tests, builds, checks the bundle for Node
builtins, and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css` attached.
