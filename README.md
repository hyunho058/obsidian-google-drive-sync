# Vault Sync for Google Drive

Keep your Obsidian notes the same on all your devices by saving them in your own
Google Drive.

- Edit a note on your computer and it shows up on your phone, and the other way around.
- Your notes go straight from your device to Google. No other company or server is
  involved.
- You can open and browse the synced notes on drive.google.com like normal folders.

Tested on Mac and iPhone. Windows and Linux sign in the same way as a Mac. Android
should work like iPhone, but nobody has tested it yet.

## Before you start

You need:

- **Obsidian 1.11.4 or later** on every device.
- **A Google account.**
- **About 15 minutes** for the one-time setup. Most of that is step 2 below, where
  you create a free "key" in Google's settings that lets the plugin use your Drive.
  You do this only once, and you don't need to know how to code.

## Disclosures

- **Account required.** You need a Google account and your own free Google Cloud
  project. Step 2 below shows how to set it up.
- **Network use.** The plugin only talks to Google: `accounts.google.com` and
  `oauth2.googleapis.com` to sign in, and `www.googleapis.com` to read and write your
  notes in Google Drive. It contacts no other server.
- **No tracking, no ads, no payments.** Nothing about you or your notes is collected.
- **Files outside the vault.** Your sign-in details are kept in Obsidian's secure
  storage on each device, outside your vault. If Obsidian's "Deleted files" setting
  uses the system trash, files removed by sync go there. Nothing else outside the
  vault is read or written. While you sign in on a computer, the plugin briefly
  listens on `127.0.0.1` to receive Google's reply.

## Setup

### Step 1. Install the plugin

In Obsidian, open **Settings → Community plugins → Browse**, search for
**Vault Sync for Google Drive**, then click **Install** and **Enable**.

Do this on every device you want to sync. Obsidian keeps the plugin updated for you.

### Step 2. Create your Google key (once, on a computer)

Google only lets apps into your Drive if they have a key. Instead of sharing one key
among all users, you make your own, so only you control it. You need it once; all
your devices use the same key.

1. Go to <https://console.cloud.google.com> and create a new project. Any name is
   fine, for example "Obsidian Sync".
2. In the menu, open **APIs & Services → Library**, search for **Google Drive API**,
   and click **Enable**.
3. Open **APIs & Services → OAuth consent screen** (or **Google Auth Platform →
   Audience**). Choose **External**, then fill in an app name and your email address
   where asked.
4. **Set the publishing status to `In production`.** Don't skip this. If it stays
   in `Testing`, Google signs you out after exactly 7 days and sync stops with an
   `invalid_grant` error.
5. Open **Credentials → Create credentials → OAuth client ID** (or **Google Auth
   Platform → Clients → Create client**), and choose **Desktop app** as the
   application type. Google then shows a **client ID** and a **client secret**. Keep
   this page open; you need both in the next step.

> **"Google hasn't verified this app"** — when you sign in for the first time,
> Google shows this warning. That's normal, because the "app" is the key you just
> made for yourself. Click **Advanced → Go to (your app name) (unsafe)** to continue.
> If Google blocks the sign-in completely instead of warning, that is Google's
> decision and the plugin can't change it.

### Step 3. Sign in on your computer

1. In Obsidian, open **Settings → Vault Sync for Google Drive**.
2. Paste the **client ID** and **client secret** from step 2.
3. Click **Sign in**. Your web browser opens. Choose your Google account, allow
   access, then go back to Obsidian.
4. Your notes now sync to a Google Drive folder with the same name as your vault.

If you have more than one computer, repeat this step on each one.

### Step 4. Link your phone

Phones can't use Google's sign-in page for this kind of key, so you send the sign-in
from your computer to your phone instead. It's like scanning a code to log in.

1. **On the computer:** in the plugin settings, next to **Copy setup token**, click
   **Copy**, then **Copy token**. A short one-time code appears, such as `K7Q4-ZP9M`.
   Leave that window open.
2. **Send the token to your phone** any way you like: AirDrop, Universal Clipboard,
   or a note to yourself. The token is locked, so it's useless without the code. Still,
   don't post it anywhere public.
3. **On the phone:** open the plugin settings and tap **Paste setup token**.
   - Paste the token into box 1.
   - Type the code from your computer screen into box 2. Capital letters, spaces and
     dashes don't matter.
   - Tap **Link this device**.

The phone checks the sign-in with Google, saves it, and syncs for the first time.
If you mistype the code, it just asks again. After this, the phone works on its own;
it doesn't need the computer anymore.

## Everyday use

- Sync runs automatically. You can also click **Sync now** in the settings, or run
  the **Sync now** command from the command palette.
- On a phone, sync runs when you open Obsidian, when you switch back to it, and a
  short time after you stop typing. Phones pause apps in the background, so it can't
  sync while Obsidian is closed.
- **Give each device a name** under **Devices → Device name**, such as "Laptop" or
  "iPhone". The name is used when two versions of a note have to be kept (see below).

### When a note changes on two devices

If you edit the same note on two devices before they sync, the plugin keeps both
versions instead of guessing which one is right:

- The version from Google Drive stays under the original name.
- Your device's version is saved next to it with the device name and time, for
  example `note (conflict 2026-09-22 1430 iPhone).md`.
- Both files sync, so every device sees them. Compare them, keep what you want, and
  delete the extra copy.

### Syncing a folder someone shared with you

You can sync with a folder someone shared with you, or any other folder in your Drive
(for example, a class or group project):

1. Open the folder on drive.google.com and copy the link from the address bar.
2. On your computer, paste it into **Drive folder link or ID** in the plugin settings.
3. Check that `Linked to "<folder name>"` appears under the box.
4. Click **Sync now**.
5. Link your phone again (step 4, tapping **Paste new token** on the phone) with a new
   setup token, so it uses the same folder.

Good to know:

- You need permission to **edit** the folder. A folder you can only view won't work.
- To go back to your own folder, clear the box.
- Folders in Shared Drives work too.
- Made a new Google key (step 2) and want to keep using your old folder? Paste the
  old folder's link here. Otherwise the plugin creates a new, empty folder.

## How your notes stay safe

- **No mass deletions.** If more than 20% of your notes disappear from one side at
  once, for example because a folder was deleted in Drive by mistake, sync stops
  without changing anything and tells you. You can change the limit under
  **Advanced**.
- **Deleted notes can be recovered.** Notes that sync deletes on your device go to
  the trash (Obsidian's `.trash` folder or your system trash), never deleted forever.
  Notes deleted in Google Drive go to the Drive trash.
- **Your sign-in never leaves the device.** It's stored in Obsidian's secure storage,
  outside your vault, so it is never uploaded to Drive, even if you copy or back up
  your vault.
- **Downloads are checked.** Every file downloaded from Drive is compared to Google's
  checksum before it's saved, so a broken download can't damage your note.

If you think someone else got access to your Google Drive through this plugin, remove
its access at <https://myaccount.google.com/permissions>, then sign in again.

## Things it can't do

- **Google Docs, Sheets and Slides are skipped.** They aren't regular files, so they
  stay in Drive untouched.
- **Files someone else owns can't be deleted from a shared folder.** If you delete one
  in Obsidian, it comes back at the next sync. Ask the owner to delete it.
- **Renaming a file uploads it again.** Renaming a large file, such as a video, takes
  as long as uploading it the first time.
- **`Note.md` and `note.md` can't both exist.** Macs and iPhones treat them as the
  same name. If both are in Drive, one is skipped and you're told about it.
- **Don't use two sync services on the same vault.** If your vault is in iCloud Drive
  *and* this plugin is running, they fight over the same files. On iPhone, keep the
  vault in **On My iPhone**.
- **Android is untested.** It should work like iPhone. Reports are welcome.

## Troubleshooting

| What you see | What to do |
|---|---|
| `invalid_grant` about a week after setup | Your Google project is still in `Testing`. Set it to `In production` (step 2.4) and sign in again. |
| "Google returned no refresh token" | Remove the app at <https://myaccount.google.com/permissions> and sign in again. |
| Sync stopped with a deletion warning | The safety check found many deleted files. Look at both your vault and Drive. If you really meant to delete them, click **Reset** next to **Reset sync state** (under **Advanced**). |
| "This device's sign-in is missing" | Obsidian's storage was cleared, for example after reinstalling. Your notes are fine. Sign in again on a computer, or paste a new setup token on a phone. |
| "That looks like the code" | You typed the code into the token box. Paste the token into box 1 and type the code into box 2. |
| "That code doesn't match this token" | The code was mistyped, or it's from a different token. Type it again, or copy a new token. |
| "unusable name(s) skipped" | A file in Drive has a name your device can't use, such as `Plan?.md` on Windows. Rename it on a device that can open it. |
| Korean or Japanese file names appear twice | This shouldn't happen. Please report it. |

To see more detail, open Obsidian's developer console. Skipped files and conflict
copies are listed there. For a full log of every sync, turn on **Verbose logging**
under **Advanced**, and set the console's log level to include "Verbose".

---

## Technical details

This section is for readers who want to know how the plugin works inside. You don't
need it to use the plugin.

### How it works

- **Drive access:** full Google Drive access (`https://www.googleapis.com/auth/drive`).
  The narrower `drive.file` scope only sees files the app itself created or opened,
  so it cannot see a folder someone shared with you, or files a collaborator adds
  later. The Google Picker, which would widen it file by file, does not run inside
  Obsidian on iOS. Full Drive is a Google *restricted* scope. The cost is the blast
  radius: a leaked refresh token, or a setup token leaked together with its code, can
  reach your whole Drive rather than one folder. It is still only ever your own OAuth
  client; the plugin ships none and no one else's app holds the permission.
- **Folders:** your vault's folder tree is mirrored as real Drive folders.
- **Comparison:** content hashes (Drive's `md5Checksum`), not timestamps.
- **Baseline:** a local index records the last state both sides agreed on. This is
  what tells "deleted here" apart from "not uploaded yet".
- **Why phones need a setup token:** Google rejects `obsidian://` redirect URIs for
  every client type, and the mobile app cannot open the loopback listener that the
  desktop sign-in uses. After linking, the phone refreshes its own access tokens
  directly with Google.
- **No redirect URI to register:** Desktop-app clients accept any
  `http://127.0.0.1:<port>` loopback, and the plugin picks a free port at runtime.
- **Unverified client:** verification and the 100-user cap only matter if you share
  your client ID with many people.
- **Conflict copies** include the device name so two devices resolving the same
  conflict never overwrite each other.

### Security model

**What holds your credentials.** The client secret and refresh token are kept in
Obsidian's secure storage (`SecretStorage`, Obsidian 1.11.4 and later): per device and
outside the vault folder, so copying, backing up or syncing the vault never carries
them. Obsidian does not document whether that storage is encrypted on disk, so treat
it as "out of the vault", not as "encrypted". It is also shared with other installed
plugins, which can read this plugin's settings file as well. The client ID is not a
secret and stays in `data.json`. Anyone who gets the refresh token has access to your
whole Google Drive; revoke it at <https://myaccount.google.com/permissions>.

This plugin's own folder is permanently excluded from sync, since its `data.json`
still holds the Drive folder id and sync records. It is resolved from the actual
install directory at runtime rather than a hardcoded name.

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

**Local deletes are never permanent.** They follow Obsidian's "Deleted files" setting
when it is the system trash or the vault's `.trash`. When it is set to "Permanently
delete", sync still moves the file to the vault's `.trash`. Files in the config
folder, which Obsidian does not index, always go to the vault's `.trash`.

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

## For developers

### Other ways to install

**From a release.** Download `main.js`, `manifest.json` and `styles.css` from the
latest [GitHub release](https://github.com/hyunho058/obsidian-google-drive-sync/releases)
into `.obsidian/plugins/vault-sync-for-google-drive/` in your vault, then enable it under
Settings → Community plugins.

**From source.** Copy the build into your vault:

```bash
npm install
npm run build

PLUGIN="$HOME/path/to/YourVault/.obsidian/plugins/vault-sync-for-google-drive"
mkdir -p "$PLUGIN"
cp main.js manifest.json styles.css "$PLUGIN/"
```

Then enable it under Settings → Community plugins. On a phone, put the same files in
the vault's plugin folder, for example via the Files app on iOS.

### Development

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
