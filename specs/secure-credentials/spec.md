# Spec: secure-credentials

## Meta
- **Created**: 2026-10-02
- **Type**: dev
- **Status**: approved
- **Approved by**: user
- **Approved at**: 2026-10-03

## Goal
Implement two security improvements: (1) move the sign-in information out of the vault into Obsidian's secure storage, and (2) encrypt the setup token with a one-time code.

## Non-goals
- A built-in OAuth client shared by all users ("option 4").
- Renaming the plugin, making the repository public, or submitting to the community directory.
- Any change to the Google sign-in flow itself (loopback + PKCE stays as is).
- Encrypting non-secret settings in `data.json` (folder ID, sync index, preferences).

## Confirmed Goal
Change how the plugin holds and transfers credentials, without changing how sync works:

1. **Secret storage.** The client secret and refresh token are kept in Obsidian's `SecretStorage` (outside the vault, per device) instead of in plaintext in the plugin's `data.json` inside the vault. Devices that are already linked (the user's Mac and iPhone) migrate automatically on first load of the new version — no re-linking.
2. **Encrypted setup token.** "Copy setup token" produces an encrypted token and shows a short one-time code on the copying device's screen. The receiving device needs both the token and the code to link. The code never goes to the clipboard.

Scope includes: automatic migration of existing installs; the new token format with code display (copying device) and code entry (receiving device), keeping the phone-friendly modal layout from 0.1.2; tests; README and security-model updates; a version bump and release.

Done when:
- A device updated in place (only the plugin files replaced, as on the Mac) keeps syncing without re-linking, and from the second app start after the update its `data.json` no longer contains the client secret or refresh token (two-phase migration, D1).
- A device updated by re-copying its vault folder (the phone) is re-linked once with a new encrypted token and code (D22), after which its `data.json` holds no secret.
- A copied token is useless without its code: the right code links the device; a wrong code is refused with a clear message and changes nothing.
- All tests pass and the release workflow builds and publishes.

Open points carried to L2 (from the mirror): whether the client ID (not a secret) stays in `data.json`; whether old unencrypted `gdvs1:` tokens are still accepted; the consequence that Obsidian 1.11.4+ becomes the minimum app version.

## Research

**Where credentials live today**
- `clientId`, `clientSecret` and `refreshToken` are plain fields of `Settings` (`src/settings.ts:4-6`, defaults `src/settings.ts:53-55`), and the whole object is persisted with `saveData` into `data.json` (`src/main.ts:107-116`).
- A single accessor, `credentials()` (`src/main.ts:118-122`), feeds both `TokenManager` (`src/main.ts:45`, `src/auth/oauth.ts:118-150`) and `isLinked()` (`src/main.ts:124-126`) — a natural chokepoint for swapping the storage backend.
- Secrets are written directly in four places: `applySetupToken` (`src/main.ts:154-156`), `signOut` (`src/main.ts:193`), desktop sign-in (`src/ui/settings-tab.ts:166-167`), and the client-secret input (`src/ui/settings-tab.ts:84-92`, `type=password`).
- `refreshToken` is also read directly for UI state: status bar (`src/main.ts:52`), startup sync (`src/main.ts:101`), button label (`src/ui/settings-tab.ts:105`), sign-out visibility (`src/ui/settings-tab.ts:142`).

**Setup token today**
- Format `gdvs1:` + base64(JSON) with payload `{v:1, clientId, clientSecret, refreshToken, folderId?, folderName?}` (`src/auth/setup-token.ts:1-50`). Encoded, not encrypted.
- Produced by `copySetupToken` → `navigator.clipboard.writeText` (`src/main.ts:130-143`); consumed by `applySetupToken`, which resets index and change token, saves, fetches an access token and runs the first sync (`src/main.ts:151-173`).
- `PasteTokenModal` (`src/ui/modals.ts:13-72`) — after 0.1.2: button above the textarea, keyboard auto-dismiss once `decodeSetupToken` succeeds synchronously (`src/ui/modals.ts:4-10, 56`), Enter submits outside IME composition (`src/ui/modals.ts:58-64`). Any code-entry step must keep this phone-friendly behaviour.
- Tests cover round-trip, prefix and malformed tokens (`tests/logic.test.ts:171-190`).

**Crypto available on both platforms**
- `src/auth/pkce.ts:1-18` already relies on `crypto.getRandomValues` and `crypto.subtle.digest` in both Electron and the iOS WebView, so WebCrypto (PBKDF2, AES-GCM) is available on every target.
- The test runtime is Node v24 with `globalThis.crypto.subtle`, and `tests/run.mjs` bundles `tests/logic.test.ts` with `tests/obsidian-stub.ts` aliased for `obsidian` — encryption can be unit-tested without Obsidian.

**Obsidian SecretStorage**
- `App.secretStorage: SecretStorage` since 1.11.4 (`node_modules/obsidian/obsidian.d.ts:458`). Installed typings are 1.13.1, the latest, so no dependency bump is needed.
- API is `setSecret(id, secret)`, `getSecret(id): string | null`, `listSecrets(): string[]` (`node_modules/obsidian/obsidian.d.ts:5635-5661`). Synchronous. **There is no delete** — clearing means setting an empty value. IDs must be lowercase alphanumeric with optional dashes, or `setSecret` throws.
- `SecretComponent` (`node_modules/obsidian/obsidian.d.ts:5613-5631`) is a settings UI for picking a user-named secret; Obsidian's guide recommends storing the secret's *name* in settings and the value in SecretStorage.
- Per Obsidian's developer docs (docs.obsidian.md, "Secret storage" guide), the value lives in the app's local storage keyed to the vault: per device and outside the vault folder. Encryption at rest is not documented. A forum report (forum.obsidian.md, 2026-08-29; unverified) says that on mobile the store is shared across vaults, contradicting the docs, so per-vault keying cannot be relied on (see D3). The store is shared across plugins (any plugin can `getSecret` a known id or `listSecrets`), so it protects against copies, backups and other sync tools picking up the vault — not against other installed plugins, which can already read `data.json` today.

**Versioning and docs**
- `manifest.json:5` has `minAppVersion: "1.4.0"`; `version-bump.mjs` records `minAppVersion` into `versions.json` on every `npm version`, so raising it is a one-line change that flows into the release.
- README security model states "Obsidian has no secret store" (`README.md:109-111`), "Credentials are never synced… refresh token in `data.json`" (`README.md:102-103`) and "The setup token is encoded, not encrypted" (`README.md:119`) — all become outdated.
- The plugin-folder sync exclusion (`src/settings.ts`, `effectiveExcludes`) stays necessary: `data.json` will still hold the Drive folder id and sync index.

## Decisions

### D1: Two-phase migration: copy on one load, erase only after a later load confirms it persisted
- **Status**: assumed (from Confirmed Goal: automatic, no re-linking; revised after L2-review #1, #7)
- **Rationale**: `getSecret` is synchronous and Obsidian does not document when the store reaches disk, so a read-back in the same process only proves the value is in memory. Migration therefore runs per secret on every load, *before* anything is written to the store in that process. Phase 2 (erase) runs only when the secret-id suffix (D3) was **loaded from `data.json`**, not generated in this process — and "process" means the app session: the suffix, and every value written to the store, is also recorded in `sessionStorage`, which survives a plugin reload but not an app restart; a field is erased only if the store returns the legacy value **and** that field was not written in this app session, so a reload never treats an in-memory value as persisted (verification loop fix 2 and post-loop fix 1, user-approved, 2026-10-04): if `data.json` holds a non-empty legacy value V and `getSecret` already returns V, the value was persisted by an earlier process → blank the field in `data.json` and save. Otherwise phase 1 runs: if no suffix exists yet, generate it and save `data.json` with the suffix and the `linked` flag (D14) — legacy values kept — **before** the first `setSecret`, so the next start looks under the same ids (review round 2, #1: an unsaved suffix would make phase 1 repeat forever); then `setSecret(V)` and leave the legacy values in place; the next app start completes phase 2. If `setSecret` throws, treat it as a mismatch: keep `data.json`, log a warning without the value, retry next load. Precedence (review #7): while a legacy value is present in `data.json`, it wins over whatever SecretStorage holds, and migration always overwrites SecretStorage with it, so stale store values (e.g. after downgrade → re-link → upgrade, D17) cannot shadow the current credentials. Consequence: on the first start after updating, the secrets are in both places; they leave `data.json` on the next start. Rejected: same-process read-back then erase (could drop the only copy if iOS kills the app before the store flushes); blanking first and writing second (a crash in between leaves the device unlinked); a one-off "migrate" button (the user asked for no manual steps).

### D2: Both desktop and iOS use SecretStorage
- **Status**: assumed (from Confirmed Goal)
- **Rationale**: The user's Mac and iPhone are both linked and both must move their secrets. SecretStorage is part of the shared `App` API, not desktop-only. Rejected: desktop-only (leaves the phone's `data.json` with the token, half the goal).

### D3: Secret ids carry a random per-vault suffix; clearing means writing an empty value
- **Status**: assumed (from L1: API shape and id rules; revised after L2-review #2)
- **Rationale**: Obsidian's docs say the store is keyed to the vault, but a forum report (2026-08-29) says it is shared across vaults on mobile, so per-vault keying is not relied on. On first need, the plugin generates an 8-hex-digit suffix with `crypto.getRandomValues`, saves it in `data.json` as `secretIdSuffix`, and uses ids `gdrive-vault-sync-<suffix>-client-secret` and `gdrive-vault-sync-<suffix>-refresh-token` (lowercase/dash rule satisfied). Two vaults on one device therefore never overwrite each other's refresh token, whichever way Obsidian keys the store. If `data.json` is lost (e.g. the vault folder is replaced), the suffix goes with it and the device is simply unlinked; the orphaned values stay in app storage, outside any vault. The API has no delete, so clearing writes `""`, and an empty value counts as absent. Rejected: fixed ids (cross-vault overwrite if the store is shared); a user-chosen secret name (Obsidian's pattern for user-typed API keys; these values are machine-managed); deriving the suffix from the vault name (not unique, changes on rename).

### D4: Encrypted token envelope `gdvs2:` using WebCrypto PBKDF2 + AES-256-GCM
- **Status**: assumed (agent decides; parameters may be tuned by the code-length decision)
- **Rationale**: `gdvs2:` + base64url(JSON `{v:2, kdf:"pbkdf2-sha256", iter, salt, iv, ct}`), with a random 16-byte salt, 12-byte IV, and PBKDF2-SHA256 at 600,000 iterations (the current OWASP figure for PBKDF2-SHA256) deriving a 256-bit AES-GCM key from the code. The plaintext is the same JSON payload as v1 (`clientId`, `clientSecret`, `refreshToken`, `folderId`, `folderName`). GCM authentication makes a wrong code or a modified token fail cleanly instead of yielding garbage. Rejected: a third-party crypto library (adds a dependency; WebCrypto exists on every target per L1); AES-CBC (no integrity check); a fast hash as KDF (makes offline guessing cheap).

### D5: The code exists only on screen
- **Status**: assumed (from Confirmed Goal)
- **Rationale**: The code is never written to the clipboard, a file, the console log, or settings. It is shown once on the copying device and typed on the receiving one. Rejected: copying token and code together (defeats the split — anyone with the clipboard would have both).

### D6: Desktop client-secret field keeps its own password input, bound to SecretStorage
- **Status**: assumed (agent decides)
- **Rationale**: The existing `type=password` field (`src/ui/settings-tab.ts:84-92`) reads and writes the fixed SecretStorage id instead of `settings.clientSecret`. Rejected: Obsidian's `SecretComponent` (a picker for user-named shared secrets; it would expose an extra "choose a secret" step for a value the plugin manages itself).

### D7: Crypto and migration are pure, unit-tested modules
- **Status**: assumed (from L1: Node 24 webcrypto + obsidian stub test harness)
- **Rationale**: Token encryption/decryption and the migration step are written as functions that take their inputs (and a minimal secret-store interface) explicitly, so `tests/logic.test.ts` can cover round-trip, wrong code, tampered token and migration against an in-memory fake store. Rejected: testing only through the Obsidian UI (no automated coverage of the security-critical paths).

### D8: 8-character one-time code from a look-alike-free alphabet
- **Status**: resolved (user, round 1)
- **Rationale**: 8 characters from Crockford base32 (digits plus A–Z without I, L, O, U), generated with `crypto.getRandomValues` and shown as `XXXX-XXXX`. That is 40 bits: with D4's PBKDF2 at 600,000 iterations, trying every code takes roughly 2.3 years on one high-end gaming GPU (about 15,000 guesses/s; on average half that, about 1.2 years), and the time falls linearly with GPU count — an 8-GPU rental needs about 3.5 months worst case. That is ample for the threat: a leaked token can also be made useless at any time by revoking the app's access in the Google account. Input is forgiving: case-insensitive, spaces and dashes ignored, `O`→`0` and `I`/`L`→`1` as Crockford specifies, so a mistyped look-alike still works. Rejected by the user: 6 digits (cracked in about a minute), 6 characters (about 20 hours), 10 characters (more typing than the threat needs).

### D9: Code shown in a window on the copying device; one form on the receiving device
- **Status**: resolved (user, round 1)
- **Rationale**: Copying device (revised after L2-review #5): pressing "Copy setup token" generates the code, encrypts the token (async PBKDF2) and opens a modal with a **Copy token** button; the code is not shown yet. Tapping Copy token writes the token to the clipboard as a fresh user gesture — WebKit can refuse `clipboard.writeText` when it runs after an `await` that followed the original tap. Only after the write succeeds does the modal reveal the code in large monospace letters with "Type this code on your other device — it is not on the clipboard", and it stays until the user closes it. If the write fails, the modal shows "Couldn't copy the token — tap Copy token again" and keeps the code hidden, so a code is never shown for a token that never reached the clipboard. The same flow runs on desktop and mobile (Copy is offered on both, `src/ui/settings-tab.ts:195-208`, plus the command). Each press of "Copy setup token" makes a new salt and code; closing the window without linking just means copying again. The "encoded, not encrypted" description of the Copy setting (`src/ui/settings-tab.ts:196-202`) is rewritten to match. Receiving device: `PasteTokenModal` gains a code field below the token box, with the Link button above both (0.1.2 layout). When a structurally complete token is pasted, focus moves to the code field instead of dismissing the keyboard; once 8 code characters are present the keyboard is dismissed; Return in the code field submits (outside IME composition). The code field disables autocorrect, spellcheck and autocomplete and auto-capitalizes. The token box placeholder changes from `gdvs1:...` (`src/ui/modals.ts:46`) to `gdvs2:...`. Rejected by the user: a temporary corner notice (the code can vanish before it is typed).

### D10: All secret reads and writes go through one credential store
- **Status**: assumed (from Tier-2 implication check of D1, D3, D6)
- **Rationale**: Today secrets are written in four places and `refreshToken` is read for UI state in four more (L1). One small wrapper over `app.secretStorage` (get/set/clear for the two suffixed ids of D3, empty = absent) is used by `credentials()`, `isLinked()`, linking, `signOut`, desktop sign-in, the client-secret field and the UI checks. Reads apply D1's precedence: the legacy `data.json` value while present, else the store. "Absent" for the device as a whole means `credentials()` returns null: client ID, client secret or refresh token missing, **or** the device is marked unlinked (`linked` false) and no legacy token is in use — so a token the store still holds after a failed rollback or a half-failed sign-out is never used, while a device mid-migration (legacy token present, `linked` not yet saved) keeps syncing (verification loop iteration 3, user-approved). Writes made while a legacy value is still present (e.g. editing the D6 field during a failed migration) update both copies, so the two never diverge (review #7). Rejected: calling `secretStorage` directly at each site (easy to miss one and leave a stale plaintext path).

### D11: Old unencrypted `gdvs1:` tokens are refused
- **Status**: resolved (user, round 2)
- **Rationale**: Only `gdvs2:` tokens link a device. A pasted `gdvs1:` token is refused with "This is an old, unencrypted setup token — copy a new one from your other device." Accepting it would leave a path that needs no code, undoing D8. Both of the user's devices are already linked and migrate in place (D1), so no legitimate flow needs a v1 token. Consequence: the receiving device must run the new version before linking; an old version shown a `gdvs2:` token fails with its existing "does not look like a setup token" message, so the README tells users to update both devices first. Rejected by the user: accept with a warning (keeps the no-code loophole open).

### D12: Setup tokens do not expire
- **Status**: resolved (user, round 2)
- **Rationale**: A token works whenever it is pasted with its code. An expiry would be enforced only by this plugin's own check; anyone holding both token and code could decrypt with their own tool, so it adds little protection while risking "copy again" friction. The real controls are the code (D8) and revoking the app's access in the Google account, which the README already documents. Rejected by the user: 1-hour and 10-minute expiry.

### D13: Minimum Obsidian version becomes 1.11.4
- **Status**: resolved (user, round 3)
- **Rationale**: `manifest.json` `minAppVersion` is raised to `1.11.4` (the first version with `app.secretStorage`); `version-bump.mjs` then records it in `versions.json`, so Obsidian keeps offering the previous plugin version to older apps. One storage path, no plaintext fallback by app version. The user's devices run 1.12+. Rejected by the user: a `data.json` fallback on older apps (two code paths, and those apps keep plaintext secrets).

### D14: A lost sign-in stops sync and asks to re-link
- **Status**: resolved (user, round 3; detection revised after L2-review #3)
- **Rationale**: `data.json` gains a boolean `linked`, set to true when a device links by token or completes desktop sign-in, and set to false by sign-out (D20). On migration (D1) it is set to *whether the legacy `refreshToken` was non-empty*, in the same save that stores the suffix — a 0.1.x desktop that had signed out keeps its client secret but has no refresh token, and must not start warning that its sign-in is missing (review round 2, #2). A Drive folder id is not used as the signal: `signOut` keeps `rootFolderId` (`src/main.ts:192-200`), so a deliberate sign-out would otherwise look like a lost sign-in every session. If `linked` is true but `credentials()` returns null (D10), the plugin treats the device as unlinked: sync does not run, and a notice appears once per app session — "This device's sign-in is missing. Paste a new setup token." on mobile, "…Sign in again." on desktop. Notes and the sync index are not touched; re-linking resets the index as today, so files are compared by content and nothing is deleted. A device that was never linked shows no notice. Rejected: silently showing "Not linked" (the user would not know why sync stopped).

### D15: A wrong code keeps the window open for unlimited retries
- **Status**: resolved (user, round 4)
- **Rationale** (async handling added after L2-review #4): the modal now owns the whole link attempt instead of closing first and reporting through a Notice (`src/ui/modals.ts` `submit()` today). On Link, it enters a busy state — Link disabled and labelled "Linking…", inputs read-only — while it decrypts (PBKDF2) and then runs D18's verification. It closes only on success. Closing the window while busy (X, Esc, back gesture) abandons the attempt: an `aborted` flag is set on close and checked immediately before D18's save, so a late success after close saves nothing, links nothing and starts no sync (review round 2, #4). If decryption fails, it leaves the busy state, keeps the pasted token, clears the code field, refocuses it and shows "That code doesn't match this token." beneath it. Nothing is saved or changed. No retry limit: an attacker guesses offline against the token, never through this window, so a limit would only inconvenience the user. A malformed or v1 token (D11) is reported the same way, inline, with its own message. Rejected by the user: closing the window with a notice (forces re-pasting the token for a typo).

### D16: Only the client secret and refresh token move; the client ID stays in `data.json`
- **Status**: resolved (user, round 4)
- **Rationale**: The client ID is not a secret — Google puts it in every sign-in URL — so it stays a plain setting and the desktop settings page keeps showing it. After migration `data.json` holds the client ID, Drive folder id/name, sync index, change token and preferences, and no secret. Rejected by the user: moving the client ID as well (more code, no security gain).

### D17: Downgrading a migrated device shows "Not linked"; no plaintext copy is kept for old versions
- **Status**: resolved (user, round 4, inversion probe scenario b)
- **Rationale**: An older plugin version copied onto a device that has migrated reads secrets from `data.json`, finds none, and reports "Not linked" until the new version is restored. No notes are lost. Keeping a plaintext copy in `data.json` for old versions would defeat D1. Rejected: dual-writing secrets to both stores.

### D22: Phone updates by re-copying the vault folder re-link afterwards
- **Status**: resolved (user, after L2-review round 2, #3)
- **Rationale**: The user updates the phone by re-copying the whole vault folder (the iOS Files app cannot reach `.obsidian/`, and BRAT needs a public repo, which is out of scope). That replaces `data.json` and with it the secret-id suffix (D3), so after each phone update the user links again: Mac → Copy setup token, iPhone → paste and type the code. This is no worse than today, where re-copying also wipes the phone's sign-in. It also settles the first update: the phone's plaintext `data.json` is replaced rather than migrated, so the Mac must be updated first (it migrates in place and produces `gdvs2:` tokens, D11). The README's phone-update steps say this explicitly, and say to copy the plugin-only skeleton folder (no `data.json`), never the Mac's own vault folder: between the Mac's first and second start after updating, its `data.json` still holds plaintext secrets (D1), and copying that vault would carry them to the phone (L2-review round 3, note 1). Rejected by the user: making the repo public and switching the phone to BRAT for in-place updates (scope expansion).

### D18: Linking verifies the new credentials with Google before saving anything
- **Status**: assumed (L2-review #4)
- **Rationale**: Today `applySetupToken` saves the pasted secrets first and only then requests an access token (`src/main.ts:151-173`), so a bad token or no network overwrites credentials that were working. New order: decrypt → persist the secret-id suffix if this device has none (so nothing is awaited between the abort check and the writes; user-approved fix 4) → request an access token with the *decrypted* credentials directly (a one-off refresh grant, not the stored `TokenManager`) → only on success save (D21), set `linked` and reset the index and change token as today → close the modal → run the first sync. `requestUrl` has no timeout, so the verification gives up after 30 seconds and is treated as a network failure. Failures keep the modal open with token and code, change nothing, and say why: network failure or timeout → "Couldn't reach Google — check your connection and try again."; Google answers 4xx → "Google rejected this sign-in. On your other device, sign in again and copy a new token."; Google answers 429 or 5xx → "Google is temporarily unavailable — try again in a minute." (an outage says nothing about the token; user-approved fix 3) Rejected: save-then-verify (today's order; can destroy a working link).

### D19: The token decoder accepts only fixed parameters
- **Status**: assumed (L2-review #6)
- **Rationale**: `iter`, `kdf`, `salt` and `iv` come from the token itself, so they are checked before any key derivation runs. First, a `gdvs1:` prefix is reported with D11's own message ("This is an old, unencrypted setup token…"), not the generic one (review round 2, #5). Then: prefix `gdvs2:`; base64url JSON with `v === 2`; `kdf === "pbkdf2-sha256"`; integer `iter` from 600,000 to 2,000,000; salt exactly 16 bytes; IV exactly 12 bytes; ciphertext at least 17 bytes (16-byte GCM tag plus data). Anything else is refused with "This setup token is damaged or not from this plugin — copy a new one." This stops a huge `iter` from freezing the phone and stops a downgraded, weakened token. The same synchronous structural check drives D9's "token complete → focus the code field". After decryption the inner payload must hold non-empty `clientId`, `clientSecret` and `refreshToken` strings, as v1 required. Rejected: trusting the token's parameters (denial of service and silent weakening).

### D20: Sign-out clears the refresh token only
- **Status**: assumed (L2-review #8)
- **Rationale**: Sign-out first saves `data.json` with `linked` false, the legacy token blanked and the index and change token reset; only then does it write `""` to the refresh-token id. If that save fails, nothing changes and "Couldn't sign out on this device. Try again." is shown; if the store write fails afterwards, the device is still signed out, because an unlinked device never uses a stored token (D10). (Order revised in verification loop iteration 3, user-approved.) It keeps the client ID and client secret, matching today's behaviour (`src/main.ts:192-200`) so the desktop can sign in again without retyping them; without the refresh token nothing can reach Drive. Same rule on mobile. Rejected: clearing the client secret too (forces re-entry on desktop for no security gain once the refresh token is gone).

### D21: A failed secret write leaves the device exactly as it was
- **Status**: assumed (L2-review #9 checkpoint: partial store write)
- **Rationale**: Linking, desktop sign-in and the D6 field write the client secret and/or refresh token through the store (D10). If any `setSecret` throws, both ids are restored to their previous values, `data.json` is not saved, and the user sees "Couldn't save the sign-in on this device" (inline in the modal when linking, as a notice otherwise). A half-written pair — new secret with old token — therefore never persists. The settings save that follows a successful pair write is part of the same unit: if it throws, the settings revert and the previous pair is restored (user-approved fix 5). The desktop client-secret field follows the same rule, including unlinking when its restore fails (user-approved fix 1). If the restore itself also throws, the stored refresh token is cleared (best effort), `linked` is set to false and saved, and the same error is shown, so the device asks to be re-linked (D14 stays quiet because `linked` is false; the status shows "Not linked") instead of failing later with a confusing Google error (L2-review round 3, note 2). Migration failures follow D1 instead (keep `data.json`, retry next load). Rejected: writing one id and continuing (a mismatched pair fails on the next refresh with a confusing Google error).

## Constraints
- Sync behaviour, the Google sign-in flow (loopback + PKCE) and the Drive client do not change; only where credentials are stored and how the setup token is transferred.
- Devices updated in place keep syncing after the update without re-linking (D1); devices updated by re-copying the vault folder re-link once (D22).
- Migration never removes the only copy of a secret: a value leaves `data.json` only after a later app start finds it already in the store (D1).
- Linking never overwrites working credentials until the new ones have been verified with Google (D18), and a failed secret write never leaves a half-written pair (D21).
- The token decoder refuses out-of-range parameters before running any key derivation (D19).
- Secrets, setup tokens and codes are never written to logs, the console, notices or error messages; the code is never put on the clipboard (D5).
- No new runtime dependencies; WebCrypto only (D4).
- The iOS bundle must not statically require any Node builtin (existing release-workflow check).
- The phone-friendly modal layout from 0.1.2 is kept: the primary button sits above every input so the keyboard never covers it (D9).
- The plugin's own folder stays excluded from sync, since `data.json` still holds the folder id and sync index.
- Minimum Obsidian version 1.11.4 (D13).

## Known Gaps
- After a phone re-copy (D22), the previous suffix's values stay orphaned in app storage (outside any vault) because the API has no delete. They are never read again; noted in the README rather than solved.
- How SecretStorage is keyed (per vault per the docs, shared on mobile per a forum report) is unverified. D3's suffix makes the design correct either way; note the observed behaviour during the on-device test.
- SecretStorage encryption at rest is undocumented by Obsidian. The README must describe it as "outside the vault, per device", not as "encrypted".
- PBKDF2 at 600,000 iterations has not been timed on an iPhone. Expected well under a second with native WebCrypto; measure during the on-device test and record the result.

## L2 Checkpoint Summary
Complexity: **Complex** (4 signals, reclassified after L2-review: multi-stage flow, multi-actor (copying + receiving device), data format design, async key derivation driving UI state). Brownfield weights: Core 30 / Scope 20 / Error 25 / Data 15 / Impl 10.

| Dimension | Checkpoints → decisions | Score |
|---|---|---|
| Core Behavior (7) | values moved → D16; code format → D8; code display → D9; code entry → D9; migration → D1; copy flow / clipboard gesture → D9; link commit order → D18 | 1.00 |
| Scope (6) | v1 tokens → D11; min version → D13; desktop + iOS → D2; non-goals; several vaults per device → D3; phone update method → D22 | 1.00 |
| Error/Edge (8) | wrong code → D15; lost sign-in → D14; migration crash safety → D1; expiry → D12; offline guessing → D8/D4; clipboard failure → D9; network failure / timeout / close while busy → D18/D15; partial secret write → D21 | 1.00 |
| Data Model (7) | secret ids → D3; envelope → D4; what stays in `data.json` → D16; payload → D4/D19; accepted token parameters → D19; `linked` flag → D14; which copy wins → D1/D10 | 1.00 |
| Implementation (6) | WebCrypto → D4; code only on screen → D5; secret field → D6; pure tested modules → D7; single credential store → D10; busy state → D15 | 1.00 |

Composite 1.00; inversion probe run (scenarios: phone re-copy → D22, downgrade → D17); no unresolved or provisional checkpoints.

## Requirements

Traceability: D1→R2 · D2→R0, R12 · D3→R1 · D4→R6 · D5→R8 · D6→R11 · D7→R14 · D8→R6 · D9→R8, R9 · D10→R1, R11 · D11→R7 · D12→R6 · D13→R12 · D14→R3 · D15→R9 · D16→R1 · D17→R12 · D18→R10 · D19→R7 · D20→R4 · D21→R5 · D22→R0, R13

### R0: Credentials live outside the vault and travel only encrypted

#### R0.1: Mac updated in place keeps syncing and sheds its plaintext secrets
- **Given**: The Mac is linked on 0.1.2 with the client secret and refresh token in `data.json`
- **When**: Only the plugin files are replaced with the new version and Obsidian is started twice
- **Then**: Sync runs after each start without re-linking, and after the second start `data.json` contains no client secret or refresh token value

#### R0.2: Phone updated by re-copying links once with an encrypted token
- **Given**: The Mac runs the new version and the phone's vault folder was replaced with the plugin-only skeleton
- **When**: The user copies a setup token on the Mac and pastes it with its code on the phone
- **Then**: The phone syncs, and its `data.json` contains no client secret or refresh token value

#### R0.3: On-device checks are recorded
- **Given**: The new version runs on the user's Mac and iPhone
- **When**: The phone links with a `gdvs2:` token
- **Then**: The time from tapping Link to "Linking…" ending on the iPhone, and whether SecretStorage values are shared between two vaults on iOS, are written into the spec's Known Gaps

### R1: One credential store over SecretStorage

#### R1.1: Secret ids get a persisted random suffix
- **Given**: `data.json` has no `secretIdSuffix`
- **When**: The store first needs its ids
- **Then**: An 8-hex-digit suffix is generated with `crypto.getRandomValues`, saved in `data.json`, and the ids are `gdrive-vault-sync-<suffix>-client-secret` and `gdrive-vault-sync-<suffix>-refresh-token`

#### R1.2: A legacy `data.json` value wins over the store
- **Given**: `data.json` holds client secret "A" and the store holds "B" under the current id
- **When**: `credentials()` is called
- **Then**: It returns client secret "A"

#### R1.3: Empty means absent
- **Given**: The store holds `""` for the refresh token and `data.json` has no legacy value
- **When**: `credentials()` and `isLinked()` are called
- **Then**: `credentials()` returns null and `isLinked()` returns false

#### R1.4: Writes during fallback update both copies
- **Given**: A legacy client secret is still present in `data.json`
- **When**: The desktop client-secret field is changed to "C"
- **Then**: Both `data.json` and the store hold "C"

#### R1.5: The client ID stays a plain setting
- **Given**: A device has finished migration
- **When**: Settings are saved
- **Then**: `data.json` holds `clientId`, folder id/name, sync index, change token, `linked` and `secretIdSuffix`, and its `clientSecret` and `refreshToken` are empty

#### R1.6: Two vaults on one device stay independent
- **Given**: Vaults A and B on one device each have their own suffix, and A is linked
- **When**: Vault B links with a different account's token
- **Then**: Vault A's `credentials()` still returns its original refresh token

### R2: Two-phase migration of existing secrets

#### R2.1: Phase 1 saves suffix and flag before writing the store
- **Given**: `data.json` has a legacy client secret and refresh token and no suffix
- **When**: The plugin loads
- **Then**: `data.json` is saved with a new suffix, `linked: true` and the legacy values still present, *before* the first `setSecret`; afterwards the store holds both values and sync runs

#### R2.2: Phase 2 erases only what an earlier process persisted
- **Given**: The suffix was loaded from `data.json` and the store already returns the same values as the legacy fields at load
- **When**: The plugin loads
- **Then**: The legacy fields are blanked and `data.json` is saved

#### R2.3: No erase in the process that generated the suffix
- **Given**: `data.json` had no suffix at load
- **When**: Migration runs
- **Then**: No legacy field is blanked during that process

#### R2.4: A throwing store keeps the legacy copy
- **Given**: Legacy values are present and `setSecret` throws
- **When**: The plugin loads
- **Then**: The legacy values stay in `data.json`, a warning without the secret value is logged, sync keeps using the legacy values, and the next load retries

#### R2.5: The legacy value overwrites a stale store value
- **Given**: `data.json` holds refresh token "A" and the store holds "B"
- **When**: The plugin loads
- **Then**: The store is set to "A", the legacy field is kept, and it is erased on a later load once the store returns "A"

#### R2.6: A signed-out legacy desktop is not marked linked
- **Given**: `data.json` holds a client secret but an empty refresh token and no suffix
- **When**: Migration runs
- **Then**: `linked` is saved as false and no "sign-in is missing" notice appears

### R3: Lost sign-in detection

#### R3.1: A linked device without credentials stops and asks to re-link
- **Given**: `linked` is true and `credentials()` returns null
- **When**: The plugin loads or a sync is triggered
- **Then**: No sync request is made and a notice says "This device's sign-in is missing. Paste a new setup token." on mobile or "…Sign in again." on desktop

#### R3.2: The notice appears once per session
- **Given**: The sign-in is missing
- **When**: Three sync triggers occur in one app session, including across a plugin reload
- **Then**: The notice is shown exactly once; after the device links again, a later loss is announced again

#### R3.3: A never-linked device stays quiet
- **Given**: `linked` is false and there are no credentials
- **When**: The plugin loads
- **Then**: No "sign-in is missing" notice is shown and the status reads "Not linked"

#### R3.4: Notes and index are untouched
- **Given**: The sign-in is missing and the sync index has N entries
- **When**: The plugin loads and sync triggers fire
- **Then**: The index still has N entries and no vault or Drive file is created, changed or deleted

### R4: Sign-out

#### R4.1: Sign-out removes only the refresh token
- **Given**: A linked device
- **When**: The user presses Sign out
- **Then**: `data.json` is saved first with `linked` false and the index and change token reset; then the store's refresh token is set to `""`; the client ID and client secret are kept (desktop shows the masked secret). If that save fails nothing changes; if only the store write fails the device is still signed out

#### R4.2: A signed-out device shows no missing-sign-in notice
- **Given**: The device was signed out
- **When**: Obsidian restarts
- **Then**: No "sign-in is missing" notice appears and the status reads "Not linked"

### R5: Failed secret writes

#### R5.1: A partial write is rolled back
- **Given**: The store holds secret "S0" and token "T0"
- **When**: Saving a new pair throws on the second `setSecret`
- **Then**: Both ids hold "S0"/"T0" again, `data.json` is not saved, and "Couldn't save the sign-in on this device" is shown

#### R5.2: A failed rollback unlinks the device
- **Given**: Saving a new pair throws, and restoring the previous values also throws
- **When**: The failure is handled
- **Then**: The stored refresh token is cleared (best effort), `linked` is saved as false, the same error is shown, `credentials()` returns null and the status reads "Not linked"

#### R5.3: A failed settings save restores the previous pair
- **Given**: The store holds "S0"/"T0" and a new pair is written successfully
- **When**: Saving the settings that go with it throws
- **Then**: The settings revert, both ids hold "S0"/"T0" again and the save error is shown; if that restore also fails, `linked` is saved as false

#### R5.4: A plugin reload in the same app session does not erase legacy copies
- **Given**: In this app session, migration phase 1 ran, or a value was (re-)written to the store (phase-2 re-copy, link, sign-in, client-secret edit)
- **When**: The plugin is reloaded without restarting the app
- **Then**: The affected legacy values stay in `data.json`; they are erased only on a load after an app restart

### R6: Encrypted token format

#### R6.1: Encrypt then decrypt round-trips the payload
- **Given**: A payload with `clientId`, `clientSecret`, `refreshToken`, `folderId`, `folderName` and a generated code
- **When**: The payload is encrypted and then decrypted with the same code
- **Then**: The decrypted payload equals the original

#### R6.2: The envelope uses the fixed parameters
- **Given**: A freshly encrypted token
- **When**: Its envelope is parsed
- **Then**: It starts with `gdvs2:` and holds `v: 2`, `kdf: "pbkdf2-sha256"`, `iter: 600000`, a 16-byte salt, a 12-byte IV, and AES-256-GCM ciphertext

#### R6.3: Codes are 8 Crockford characters
- **Given**: The code generator
- **When**: 1,000 codes are generated
- **Then**: Each has 8 characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, is displayed as `XXXX-XXXX`, and comes from `crypto.getRandomValues`

#### R6.4: Code entry is forgiving
- **Given**: A token encrypted with code `K7Q4ZP90`
- **When**: It is decrypted with `k7q4-zp9o`, `K7Q4 ZP90` or `K7Q4ZP9O`
- **Then**: Each decrypts successfully (case, spaces and dashes ignored; `O`→`0`, `I`/`L`→`1`)

#### R6.5: A wrong code fails cleanly
- **Given**: A valid token
- **When**: It is decrypted with a different code
- **Then**: Decryption fails with "That code doesn't match this token." and returns no payload

#### R6.6: A modified token fails like a wrong code
- **Given**: A valid token with one ciphertext byte changed
- **When**: It is decrypted with the right code
- **Then**: Decryption fails with the same message as a wrong code

#### R6.7: Every copy is unique
- **Given**: The same payload
- **When**: It is encrypted twice
- **Then**: The two tokens differ (salt and IV) and the two codes differ

#### R6.8: Tokens have no expiry
- **Given**: A token created at any earlier time
- **When**: It is decrypted with its code
- **Then**: Decryption succeeds; no timestamp is stored or checked

### R7: Token decoder validation

#### R7.1: Old tokens get their own message
- **Given**: A pasted string starting with `gdvs1:`
- **When**: It is validated
- **Then**: It is refused with "This is an old, unencrypted setup token — copy a new one from your other device." without running key derivation

#### R7.2: Out-of-range parameters are refused before key derivation
- **Given**: A `gdvs2:` token whose `kdf` is not `pbkdf2-sha256`, or `iter` is below 600,000 or above 2,000,000 or not an integer, or salt is not 16 bytes, or IV is not 12 bytes, or ciphertext is under 17 bytes, or base64url/JSON is invalid, or `v` is not 2
- **When**: It is validated
- **Then**: It is refused with "This setup token is damaged or not from this plugin — copy a new one." and no PBKDF2 runs

#### R7.3: A decrypted payload must be complete
- **Given**: A token that decrypts to a payload missing `clientId`, `clientSecret` or `refreshToken`
- **When**: It is decrypted
- **Then**: It is refused with the damaged-token message

#### R7.4: A synchronous structural check reports completeness
- **Given**: Text in the token box
- **When**: The structural check runs on each input event
- **Then**: It returns "complete" only for a well-formed `gdvs2:` envelope, without any async work

### R8: Copying device

#### R8.1: Copy opens a window with the code hidden
- **Given**: A linked device
- **When**: The user presses Copy setup token (settings button or command)
- **Then**: The token is encrypted with a new code and a modal opens with a Copy token button; the code is not shown

#### R8.2: A successful copy reveals the code
- **Given**: The Copy token modal is open
- **When**: The user taps Copy token and the clipboard write succeeds
- **Then**: The clipboard holds only the `gdvs2:` token and the modal shows the code as large `XXXX-XXXX` text with "Type this code on your other device — it is not on the clipboard", until closed

#### R8.3: A failed copy keeps the code hidden
- **Given**: The Copy token modal is open
- **When**: The clipboard write fails
- **Then**: The modal shows "Couldn't copy the token — tap Copy token again" and the code stays hidden

#### R8.4: An unlinked device cannot copy
- **Given**: A device that is not linked
- **When**: The user runs the Copy setup token command
- **Then**: A notice says to sign in first and no modal opens (the settings button stays disabled)

#### R8.5: The code is never persisted or logged
- **Given**: A copy flow has completed
- **When**: The console output, `data.json` and the clipboard are inspected
- **Then**: The code string appears in none of them

#### R8.6: The Copy setting describes encryption
- **Given**: The settings page
- **When**: It renders the Copy setup token setting
- **Then**: The description says the token is encrypted and needs the code shown after copying, and no longer says "encoded, not encrypted"

### R9: Receiving device form

#### R9.1: Link sits above both inputs
- **Given**: The Paste setup token modal opens
- **When**: It renders
- **Then**: The Link button is above the token box (placeholder `gdvs2:...`) and the code box below it

#### R9.2: A complete token moves focus to the code
- **Given**: The token box is focused
- **When**: A complete `gdvs2:` token is pasted
- **Then**: Focus moves to the code box

#### R9.3: The keyboard hides after eight code characters
- **Given**: The code box is focused
- **When**: The eighth valid code character is entered (dashes and spaces not counted)
- **Then**: The code box loses focus, dismissing the keyboard

#### R9.4: Return submits from the code box
- **Given**: The code box is focused and no IME composition is in progress
- **When**: The user presses Return
- **Then**: The link attempt starts as if Link was tapped

#### R9.5: The modal is busy during an attempt
- **Given**: A token and code are entered
- **When**: The user taps Link
- **Then**: Link is disabled and reads "Linking…", both inputs are read-only, until the attempt succeeds or fails

#### R9.6: A wrong code allows unlimited retries
- **Given**: A valid token and a wrong code
- **When**: The attempt fails at decryption
- **Then**: The modal stays open, keeps the token, clears and refocuses the code box, and shows "That code doesn't match this token." under it; this repeats for any number of attempts

#### R9.7: Token errors are shown inline
- **Given**: A `gdvs1:` or damaged token
- **When**: The user taps Link
- **Then**: The R7 message appears under the token box, nothing is saved, and the modal stays open

#### R9.8: Closing while busy abandons the attempt
- **Given**: An attempt is in progress
- **When**: The user closes the modal (X, Esc or back gesture) and the attempt later succeeds
- **Then**: Nothing is saved, `linked` is unchanged and no sync starts

#### R9.9: The code box is typing-friendly
- **Given**: The modal renders
- **When**: The code box is inspected
- **Then**: It has autocapitalization on and autocorrect, spellcheck and autocomplete off

#### R9.10: Missing input gets its own message
- **Given**: The token box is empty or holds only part of the prefix, or the code has fewer than 8 characters
- **When**: The user taps Link
- **Then**: "Paste the whole setup token." or "Type the 8-character code." is shown, and no decryption runs

### R10: Link commit order

#### R10.1: Google is asked before anything is saved
- **Given**: A token decrypted with the right code
- **When**: The link proceeds
- **Then**: A refresh-token grant using the decrypted credentials is sent to Google before any store write or `data.json` save

#### R10.2: A verified link is saved and starts sync
- **Given**: Google returns an access token for the decrypted credentials
- **When**: The link completes
- **Then**: The secrets are saved to the store; `data.json` is saved with the client ID, folder id/name, `linked: true`, an empty index and change token; the modal closes, the first sync starts and settings show "Linked"

#### R10.3: No network or a timeout changes nothing
- **Given**: The request fails or no answer arrives within 30 seconds
- **When**: The link attempt ends
- **Then**: The modal shows "Couldn't reach Google — check your connection and try again.", keeps token and code, and nothing is saved

#### R10.4: A rejected grant changes nothing
- **Given**: Google answers `invalid_grant`
- **When**: The link attempt ends
- **Then**: The modal shows "Google rejected this sign-in. On your other device, sign in again and copy a new token." and nothing is saved

#### R10.5: A working link survives a failed attempt
- **Given**: The device is linked with refresh token "T0"
- **When**: A link attempt fails at decryption, verification or saving
- **Then**: The store still holds "T0" and the next sync succeeds with it

#### R10.6: An outage is not reported as a bad token
- **Given**: Google answers 429 or a 5xx status
- **When**: The link attempt ends
- **Then**: The modal shows "Google is temporarily unavailable — try again in a minute." and nothing is saved

### R11: Desktop sign-in and secret field

#### R11.1: Desktop sign-in stores the token outside the vault
- **Given**: Client ID and secret are set on desktop
- **When**: Sign in completes the Google flow
- **Then**: The refresh token is in the store, `linked` is true, and `data.json` contains no refresh token value

#### R11.2: The secret field is bound to the store
- **Given**: The desktop settings page
- **When**: It renders and the user edits the client secret
- **Then**: The masked field shows the store's value and the edit is written to the store, not to `data.json` (except R1.4's fallback)

#### R11.3: Sign-in reads the secret from the store
- **Given**: The client secret exists only in the store
- **When**: The user presses Sign in
- **Then**: The Google flow starts with that secret and does not ask for it again

### R12: Platform and versions

#### R12.1: Minimum app version is 1.11.4
- **Given**: The release commit
- **When**: `manifest.json` and `versions.json` are read
- **Then**: `minAppVersion` is `1.11.4` and the new version maps to `1.11.4` in `versions.json`

#### R12.2: The bundle stays iOS-safe
- **Given**: The production build
- **When**: The release workflow's Node-builtin check runs
- **Then**: `main.js` statically requires only `obsidian`

#### R12.3: A downgraded device reports "Not linked" without data loss
- **Given**: A device that has completed migration
- **When**: An older plugin version (0.1.2) is started on it
- **Then**: It reports "Not linked" and no vault or Drive file is changed

### R13: Documentation

#### R13.1: The security model describes the new storage and token
- **Given**: README's security section
- **When**: It is read
- **Then**: It says secrets are kept outside the vault per device (without claiming encryption at rest), the setup token is encrypted and needs a one-time code, old tokens are refused, tokens do not expire, and leaked tokens are revoked in the Google account

#### R13.2: Phone update steps include re-linking
- **Given**: README's phone section
- **When**: It is read
- **Then**: It says to update the Mac first, copy the plugin-only folder (never the Mac's vault), and link again with a new token and code; and it mentions that old values remain in app storage

#### R13.3: Setup steps include the code
- **Given**: README's iPhone setup steps
- **When**: They are read
- **Then**: They describe Copy token on the Mac, then pasting the token and typing the code on the phone

### R14: Automated tests run without Obsidian

#### R14.1: Crypto, decoder, store and migration are covered by `npm test`
- **Given**: The test suite with an in-memory fake secret store
- **When**: `npm test` runs under Node
- **Then**: Cases for R1.1–R1.6, R2.1–R2.6, R5.1–R5.4, R6.1–R6.8, R7.1–R7.4 and R10.1/R10.3/R10.4/R10.6 (verifyCredentials) pass without loading Obsidian

## Tasks

### T0: Shared groundwork — test runner, settings fields, minimum app version [infra]
- **Fulfills**: R12.1, R14 (runner)
- **Depends on**: (none)
- **Files**: `tests/run.mjs` (run every `tests/*.test.ts`, keeping the obsidian stub alias), `src/settings.ts` (add `linked: boolean` and `secretIdSuffix: string` with defaults; keep `clientSecret`/`refreshToken` as legacy fields), `manifest.json` (`minAppVersion` → `1.11.4`)

### T1: Encrypted setup-token module [infra]
- **Fulfills**: R6, R7, R14 (token cases)
- **Depends on**: T0 — parallel with T2 and T3
- **Files**: `src/auth/setup-token.ts`, new `tests/setup-token.test.ts`
- **Notes**: Add `generateCode`, `normalizeCode`, `formatCode`, async `encryptSetupToken(payload) → {token, code}`, async `decryptSetupToken(token, code)`, and a synchronous `checkTokenStructure(raw)` returning complete / `old-token` / `damaged` / incomplete. Keep the existing v1 `encodeSetupToken`/`decodeSetupToken` exports untouched so their current callers still compile; T1 edits no other source file, and T4 removes the v1 path.

### T2: Credential store and two-phase migration module [infra]
- **Fulfills**: R1, R2, R5, R14 (store cases)
- **Depends on**: T0 — parallel with T1
- **Files**: new `src/auth/credential-store.ts`, new `tests/credential-store.test.ts`
- **Notes**: Pure logic over a minimal `SecretStore` interface (`get/set`), with an in-memory fake in tests: suffix generation and ids, read precedence, empty = absent, dual-write during fallback, two-phase migration (suffix + `linked` saved before the first `setSecret`, phase 2 only for a loaded suffix), atomic pair write with rollback and the unlink-on-failed-rollback rule. Takes a `save()` callback for `data.json` so it never imports Obsidian.

### T3: Wire the store into the plugin — load, sign-in, sign-out, lost sign-in [vertical]
- **Fulfills**: R1 (integration), R2 (integration), R3, R4, R5 (desktop field), R11
- **Depends on**: T2 — parallel with T1
- **Files**: `src/main.ts` (`onload` runs migration; `credentials()`/`isLinked()` via the store; `signOut` per D20; once-per-session missing-sign-in notice and sync guard), `src/ui/settings-tab.ts` (secret field bound to the store; desktop sign-in saves through the store and sets `linked`; sign-out visibility and UI checks use `isLinked()`/`linked` instead of `settings.refreshToken`)

### T4: Copy and link flow with the one-time code [vertical]
- **Fulfills**: R8, R9, R10
- **Depends on**: T1, T3
- **Files**: `src/ui/modals.ts` (new copy-token modal; paste modal gains the code box, busy state, inline errors, `aborted` flag), `src/main.ts` (`copySetupToken` opens the copy modal; linking verifies with Google, then saves through the store), `src/auth/oauth.ts` (one-off refresh-grant check with a 30-second timeout, distinguishing network failure from `invalid_grant`), `src/ui/settings-tab.ts` (Copy description), `src/auth/setup-token.ts` and `tests/logic.test.ts` (remove the v1 encode/decode path and its old tests)

### T5: Documentation and release [vertical]
- **Fulfills**: R13, R12.2
- **Depends on**: T4
- **Files**: `README.md` (security model, phone update steps, setup steps with the code); then `npm version minor` → push `main` and the tag over the `github.com-personal` SSH remote → watch the release workflow (its Node-builtin check is R12.2) → download the release into the Mac vault's plugin folder (keeping `data.json`) and into the phone skeleton `~/Downloads/Notes`

### T6: On-device verification with the user [manual]
- **Fulfills**: R0, R12.3
- **Depends on**: T5
- **Notes**: Guided with the user: Mac restarted twice and its `data.json` checked for empty secret fields (field names only, never values) (R0.1); phone re-copied and linked with token + code (R0.2); link time and cross-vault behaviour recorded in Known Gaps (R0.3); downgrade check (R12.3) only if the user wants to run it.

## External Dependencies

### Pre-work
- Confirm the iPhone's Obsidian version is 1.11.4 or newer (Settings → About). The Mac shows 1.12.4.

### Post-work
- Mac: quit and reopen Obsidian twice after the plugin files are replaced, so the two-phase migration completes.
- iPhone: after the Mac is updated, re-copy the plugin-only folder `~/Downloads/Notes`, then link with a new token and code.
- Both devices: copy any other text afterwards so the token leaves the clipboard.
