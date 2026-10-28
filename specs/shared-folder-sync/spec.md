# Spec: shared-folder-sync

## Meta
- **Created**: 2026-10-25
- **Type**: dev
- **Status**: implemented and verified (loop passed after 3 iterations, 2026-10-25); uncommitted
- **Approved by**: user (via /harness-ops:agent-orchestrate, Proceed)
- **Approved at**: 2026-10-25
- **Mode**: unattended
- **Branch**: feat/full-drive-scope

## Goal
Let the plugin sync a vault with a Google Drive folder that the user did not create through the plugin — in particular a folder someone else owns and shared with them ("Shared with me") — by adding a "Drive folder link or ID" setting next to the existing folder-name setting and switching the OAuth scope from `drive.file` to full `drive`. The user chose this direction over the Google Picker because the Picker does not work inside Obsidian on iOS.

## Non-goals
- Google Picker integration (rejected by the user: does not work inside Obsidian on iOS).
- Keeping `drive.file` as an alternative or selectable scope. The plugin requests one scope: full `drive`.
- Multi-account or multi-folder sync. One vault still syncs with exactly one Drive folder.
- A read-only / one-way sync mode for folders the user can only view.
- Syncing Google-native documents (Docs, Sheets, Slides, shortcuts). They have no downloadable bytes and no checksum; they are skipped and named once, not converted.
- Google app verification, CASA assessment, or any change to the user's Google Cloud project beyond what the README tells them to do themselves.
- Releasing: bumping `manifest.json` / `versions.json`, tagging, publishing a GitHub release. The deliverable is the branch and a PR (project rule since 2026-10-05: every change goes on a branch with a PR; tag only after merge).
- Changes to the setup-token encryption, the credential store, or how secrets are kept (the secure-credentials spec owns those).

## Confirmed Goal
Build, on branch `feat/full-drive-scope`, shared-folder sync for the Obsidian "Vault Sync for Google Drive" plugin:

1. A new "Drive folder link or ID" text setting in the Sync section, next to "Drive folder name". The user pastes a drive.google.com folder link or a bare folder ID. The plugin resolves it to an ID, checks with Google that it is a folder the signed-in account can write into, pins it as the sync root (`setRoot(id)` path instead of `ensureRootFolder(name)`), and shows the folder's real name. Clearing the field goes back to the old name-based "find or create in My Drive" behaviour. (inferred: validation and the clear-to-revert path are not in the request, but a field that silently accepts a bad ID would make the first sync fail with a bare Drive error.)
2. The OAuth scope becomes `https://www.googleapis.com/auth/drive`, requested at desktop sign-in; the phone keeps getting its credentials through the setup token and needs no change to the link flow. (inferred: the refresh token issued on the Mac carries the scope, so the phone inherits full Drive once the Mac has signed in again.)
3. Everything the Drive client does that silently relied on `drive.file` seeing only the plugin's own files is reworked so full-Drive access does not make it list or react to the user's whole Drive: the tree listing walks down from the root folder instead of sweeping every non-trashed file, and the cheap change probe only reports a change when it touches the synced tree. (inferred from the code: `listTree` queries `trashed=false` across the account and `hasChangesSince` counts any change anywhere.)
4. Edge cases that only exist once the folder is not the plugin's own are handled: read-only folders are refused when pinned, Google-native files are skipped, files owned by someone else that cannot be trashed are reported instead of retried forever, and a sign-in made under the old scope is explained when it cannot see a folder.
5. The setup token carries the pinned folder to the other device so a phone linked from the Mac syncs the same shared folder without typing the link again. (inferred: the token already carries `folderId`/`folderName`.)
6. README and the settings copy stop claiming the scope is non-sensitive and explain what full Drive access means for the user's own OAuth client (unverified-app warning at sign-in) and what the new limits are.

Done when:
- `npm run check` (typecheck + the test runner) passes with new tests covering link parsing, root pinning, the scoped tree listing, the filtered change probe, the skip rules, and the setup-token field.
- With a built `main.js`, a user can paste the link of a folder shared with them, see its name appear in the setting, run "Sync now", and have the vault's files appear in that folder and the folder's files appear in the vault (manual check by the user on Mac, then iPhone via a new setup token).
- `grep drive.file src README.md` finds only historical or "no longer" wording, never a claim that it is the scope in use.

## Research

### Scope and sign-in
- The scope is one constant, `DRIVE_SCOPE = ".../auth/drive.file"`, used only when building the desktop auth URL (`src/auth/oauth.ts:3`, `src/auth/oauth.ts:161`). The refresh-token path (`postToken`, `TokenManager.refresh`) never names a scope, so a phone linked with a token minted on a Mac uses whatever scope the Mac's refresh token was granted (`src/auth/oauth.ts:33`, `src/auth/oauth.ts:204`).
- `TokenResponse` is typed as `access_token`, `expires_in`, optional `refresh_token`; Google's token responses also carry a `scope` field that is currently dropped (`src/auth/oauth.ts:27`).
- The settings tab tells the user the scope is non-sensitive and needs no verification (`src/ui/settings-tab.ts:68`); the README says the same in "How it works" and in the Cloud setup steps (`README.md:24-26`, `README.md:45-46`) and lists "drive.file cannot see files it did not create" under Known limits (`README.md:212-214`).

### Root folder resolution and settings
- Settings hold `rootFolderName` and `rootFolderId` (`src/settings.ts:23-24`, defaults at `src/settings.ts:73-74`). `loadSettings` fills an empty name with the vault name (`src/main.ts` `loadSettings`).
- `ensureRoot` prefers a stored `rootFolderId` and only falls back to `ensureRootFolder(name)` when it is empty; it persists whichever id it ends up with (`src/main.ts:493-498`). On load and after linking, a stored id is pushed into the client with `setRoot` (`src/main.ts:78`, `src/main.ts:235`).
- `ensureRootFolder` searches `name=… and 'root' in parents` and creates the folder when nothing is found; the doc comment says the search is reliable only because `drive.file` hides everything else (`src/drive/client.ts:171-188`). `setRoot` resets the folder cache and seeds `""` → id (`src/drive/client.ts:91`).
- The only folder setting is the "Drive folder name" text; changing it blanks `rootFolderId`, the index and the change token, and resets the client cache (`src/ui/settings-tab.ts:248-260`).
- The setup token payload already carries optional `folderId` and `folderName` (`src/auth/setup-token.ts:35`); `toLinkPayload` accepts only those five keys and ignores unknown ones (`src/auth/setup-token.ts:216-225`); `encryptSetupToken` copies them into the encrypted inner JSON (`src/auth/setup-token.ts:241-242`). `copySetupToken` fills them from settings and `linkDevice` applies them (`src/main.ts:189-190`, `src/main.ts:220-221`).

### Listing, change detection and per-file calls that assumed drive.file
- `listTree` lists every non-trashed file the token can see (`q=trashed=false`, `spaces=drive`, 1000 per page) and reconstructs paths by walking parents up to the root id, dropping anything whose chain leaves the root (`src/drive/client.ts:254-335`). Under full `drive` this sweep would page through the user's entire Drive on every sync.
- `hasChangesSince` pages `changes.list` and returns `changed: true` as soon as any change exists, requesting only `fileId,removed` (`src/drive/client.ts:351-372`). Under full `drive` any edit anywhere in the account would force a full sweep.
- `getStartPageToken`, `download` (`alt=media`), `trash` (PATCH `trashed: true`), and both upload paths exist (`src/drive/client.ts:344`, `:376`, `:381`, `:395-`). None pass `supportsAllDrives` / `includeItemsFromAllDrives`, so folders inside a Shared Drive are invisible even with full scope.
- Uploads stamp `appProperties: { gdvs: "1" }` (`src/drive/client.ts:200`, `:413`, `:445`); nothing reads it back.
- Drive error handling: `call` turns 401/403 into `AuthError(fatal=false)` and other failures into `DriveError(status)`; a plain 403 is not retried (`src/drive/client.ts:132-165`). 404 therefore surfaces as `DriveError` with status 404.
- `FILE_FIELDS` requests `id,name,mimeType,md5Checksum,size,modifiedTime,parents,trashed`; `FOLDER_MIME` is the only mime type the code knows (`src/drive/types.ts:1-14`).

### Sync engine behaviour that the new root exposes
- The engine takes `listTree()`'s files, skips excluded and case-colliding paths, and reconciles by md5 (`src/sync/engine.ts:117-130`). A remote entry with no md5 is compared by size (`src/sync/engine.ts:254-256`) and a download of it goes through `alt=media` (`src/sync/engine.ts` `download`), which Google refuses for its native types — so a Google Doc in a shared folder would error on every sync.
- `deleteRemote` calls `drive.trash`; a thrown error lands in `report.errors` and the index entry stays, so the same delete is retried every run (`src/sync/engine.ts` `deleteRemote`, `run` catch at `:170-176`).
- The deletion guard, conflict copies and `suppressed` paths are independent of who owns the folder (`src/sync/engine.ts:150-168`).

### Tests and tooling
- `npm run check` = `tsc --noEmit --skipLibCheck && node tests/run.mjs`; the runner bundles every `tests/*.test.ts` with esbuild, aliasing `obsidian` to `tests/obsidian-stub.ts` (`package.json` scripts, `tests/run.mjs`). New test files are picked up by name pattern alone.
- `tests/obsidian-stub.ts` exposes `setRequestUrlHandler` so a test can answer `requestUrl` calls with status/json/headers (`tests/obsidian-stub.ts:7`); `tests/oauth.test.ts` shows the pattern. `Platform` in the stub only has `isWin`.
- `tests/engine.test.ts` builds the engine with a fake `DriveClient` exposing `listTree` and `trash` (`tests/engine.test.ts:51-62`); `DriveClient` itself has no tests yet, but it only depends on `requestUrl` and a `TokenManager`, both stubbable.
- `tests/harness.ts` provides `test/eq/assert/rejects/run`. The previous spec's loop also typechecked tests with an explicit `tsc` command (`specs/secure-credentials/loop.md` Gate 1).
- No linter is configured. `main.js` must bundle only `require("obsidian")` (iPhone-safe check in the prior loop contract).

### Project conventions
- Prior spec `specs/secure-credentials/spec.md` uses D/R/T numbering with `Status` and rejected alternatives, and records lessons; tests name the sub-requirement they cover (`R10.1 …`).
- Manifest version is 0.2.2, `minAppVersion` 1.11.4 (`manifest.json:4-5`). Releases are separate "Release x.y.z" commits; the branch/PR rule applies (memory: branches-and-prs).
- Google facts relied on (not in the repo; to be confirmed by the user's own sign-in): `https://www.googleapis.com/auth/drive` is a *restricted* scope. For an OAuth client in "In production" status that is unverified, Google shows the "Google hasn't verified this app" screen with an "Advanced → Go to … (unsafe)" link, caps the app at 100 users, and still issues long-lived refresh tokens (the 7-day expiry is tied to Testing status, not to the scope). Drive v3 `files.list` with `'<id>' in parents` works on folders shared with the user; folders inside Shared Drives additionally need `supportsAllDrives=true&includeItemsFromAllDrives=true`. Non-owners cannot trash a file in another user's My Drive (403).

## Decisions

Complexity: Complex (5 signals) — external resource (Drive API, OAuth token endpoint); multi-actor (Mac, iPhone linked by token, folder owner and other collaborators, Google); async paged network calls; data schema change (settings fields, setup-token payload); multi-stage flow (paste → verify → pin → sync; sign-in scope upgrade). Brownfield weights: Core 30%, Scope 20%, Error/Edge 25%, Data 15%, Implementation 10%.

Status legend: `resolved (request)` = settled by the user's own request; `resolved (L1)` = settled by an existing pattern in the code; `assumed` = agent's choice, with the rejected alternatives named.

### D1: The folder setting accepts a drive.google.com folder link or a bare folder ID
- **Status**: resolved (request) — "Drive folder link or ID" setting; the accepted forms are assumed.
- **Rationale**: A pure function `parseFolderRef(input)` in a new module `src/drive/folder-ref.ts` returns the folder ID or `null`. Accepted: `https://drive.google.com/drive/folders/<id>`, `https://drive.google.com/drive/u/<n>/folders/<id>`, `https://drive.google.com/drive/mobile/folders/<id>` (what a phone browser emits), `https://drive.google.com/open?id=<id>`, the legacy `https://drive.google.com/folderview?id=<id>`, the same without a scheme or with `www.`, any query string or fragment after the ID, and a bare ID. An ID is 10 or more characters from `[A-Za-z0-9_-]`. Whitespace around the input is trimmed. Anything else (a file link `/file/d/<id>`, another host, text with spaces) is `null`. Rejected: accepting a bare folder *name* in this field (ambiguous with the existing name field, and names are not unique in Drive); accepting file links (the root must be a folder, and a wrong kind of link should be told apart from a wrong ID).

### D2: Setting the link verifies the folder with Google, then pins it and starts a fresh baseline
- **Status**: assumed
- **Rationale**: The field commits on blur or Enter of its `inputEl` (listeners on the input, not `onChange`, which Obsidian fires per keystroke); while the user is editing nothing is called or shown, and a commit whose trimmed text equals the stored `rootFolderLink` does nothing. On a committed non-empty parse, the plugin (when linked) calls `files.get` on the ID with `fields=id,name,mimeType,trashed,capabilities(canAddChildren)` and `supportsAllDrives=true` (D8). It is accepted only when the mime type is `application/vnd.google-apps.folder`, `trashed` is false and `canAddChildren` is true. On accept: `rootFolderLink` = the input as typed (trimmed), `rootFolderId` = the ID, `rootFolderLinkName` = the folder's name (D17), the index and change token are cleared, `drive.resetCache()` then `setRoot(id)` — the same reset the name field does today (`src/ui/settings-tab.ts:248-260`). The setting's description then reads `Linked to "<name>"`. On refusal nothing is saved and the reason is shown (D12). When the input parses to the ID already in `rootFolderId` *and* `rootFolderLink` is already non-empty, nothing happens (no second reset). When it parses to the current `rootFolderId` but `rootFolderLink` is empty — the user pasted the link of the folder the plugin created by name — the verification still runs and on success `rootFolderLink` and `rootFolderLinkName` are saved, but the index and change token are kept, because the root did not change. Rejected: saving first and verifying at the next sync (the user would learn about a typo only from a failed sync); verifying by listing the folder's children (a `files.get` is one cheap call and also yields the name and the write capability).

### D3: Root precedence is link, then stored ID, then name; clearing the link reverts to the name
- **Status**: resolved (L1, `src/main.ts:493-498`) for the stored-ID-before-name order; assumed for the link and clear paths.
- **Rationale**: `ensureRoot` keeps its shape: a non-empty `rootFolderId` is used as is, otherwise `ensureRootFolder(rootFolderName)` finds or creates a My Drive folder. The link only decides *how* `rootFolderId` got its value (D2). Clearing the link field (empty input) sets `rootFolderLink`, `rootFolderLinkName` and `rootFolderId` to `""`, clears index and change token, and resets the client, so the next sync goes back to the name-based folder. While a link is pinned, editing the name field changes `rootFolderName` only — it must not blank `rootFolderId` or reset the index, because the name is not in use; its description says so. Rejected: removing the name path (users who never share need no link; also keeps 0.2.x data.json working untouched); a mode toggle between "by name" and "by link" (one more control for the same information).

### D4: The tree listing walks down from the root folder instead of sweeping every file the token can see
- **Status**: assumed (forced by the scope change; the current sweep at `src/drive/client.ts:254-335` would page through the whole account)
- **Rationale**: `listTree` becomes a breadth-first walk: starting with `{"" → rootId}`, list the children of each known folder with `q='<id>' in parents and trashed=false`, `fields=nextPageToken,files(FILE_FIELDS)`, `pageSize=1000`, `supportsAllDrives=true&includeItemsFromAllDrives=true` (D8), following `nextPageToken`. Child paths are `joinPath(parentPath, nfc(name))`; folders are queued, files become `RemoteEntry`s; the `isSafeVaultPath` rejection and the `folders` map are kept as today. Up to `concurrency` folder listings run at once (a new optional `listTree(concurrency = 4)` argument; the engine passes `opts.concurrency` at its one call site, `src/sync/engine.ts:117`). The walk builds a fresh local map and swaps it into `this.folderIds` only after every folder listed; a walk that throws leaves the previous map and `hasListed()` (D5) untouched. The walk remembers the root id it started from and, if `this.rootId` differs when it finishes (a pin or unpin committed during a sync), throws `DriveError("The Drive folder changed during the sync; run it again.", 0)` instead of swapping a map keyed to the old root — today's `listTree` has the same race (`src/drive/client.ts:337`), unaddressed. **Any failed folder listing throws and fails the whole `listTree`** — a partial tree returned as success would read as remote deletions, and below the deletion guard's floor of 10 files (`src/sync/engine.ts:159`) those deletions would propagate. The parent-graph reconstruction and its cycle guard are deleted with the sweep. Rejected: keeping the sweep and filtering by ancestor (lists the user's entire Drive every sync); one query OR-ing many parents (fewer requests, but Drive caps query length and the gain is small next to a 1000-item page size); walking depth-first (same request count, worse parallelism).

### D5: The change probe reports a change only when it touches the synced tree, and a full sweep still happens at least hourly
- **Status**: assumed (forced by the scope change; `hasChangesSince` at `src/drive/client.ts:351-372` fires on any change in the account)
- **Rationale**: `hasChangesSince(pageToken, isRelevant)` requests `changes(fileId,removed,file(id,parents,trashed))` plus `supportsAllDrives=true&includeItemsFromAllDrives=true` and returns `changed: true` when any change passes `isRelevant`, which `main.ts` builds from the current `index` (every `id`) and the client's known folder IDs (a new `knownFolderIds(): Set<string>` on `DriveClient` exposing `folderIds` values): a change is relevant when `removed` is true for a known id, or `fileId` is a known id, or any of `file.parents` is a known folder id. That covers edits, trashing, renames, moves in or out, and new files or folders created under the tree — but only once the folder map is filled, and it is in-memory: on launch `setRoot` seeds just the root (`src/drive/client.ts:91-95`) and the map is complete only after a `listTree`. So the probe is used only after a `listTree` has completed in this app session (`DriveClient.hasListed(): boolean`, set true at the end of a successful walk, false by `resetCache`/`setRoot`); the first sync of every app session — including the iOS launch sync, which is where changes made while the app was closed arrive — always does the full walk. As a safety valve against change feeds that omit events for files owned by someone else (not confirmed either way — Known Gaps), a `QuietProbes` counter (`src/sync/probe.ts`, D19; one instance on the plugin) forces the full sweep on every 12th consecutive probe that reported no change (about an hour at the 5-minute default): `syncNow` calls `quiet.quiet()` after a probe that found nothing and `quiet.changed()` after every full walk — forced, probe-triggered, first-of-session or explicit — so the streak restarts once a walk has happened and the forced sweep never repeats on consecutive intervals; explicit syncs (ribbon, command, link) already skip the probe. Rejected: no filter (every edit anywhere in the account would trigger a folder walk of the whole vault); dropping the probe entirely (a full walk every interval on both devices); persisting the counter (it only needs to survive within a session).

### D6: The requested scope is full `drive`; existing sign-ins keep working and are asked to sign in again only when they try to use a folder they cannot see
- **Status**: resolved (request) — "I'd like to go with the folder ID field and full drive scope".
- **Rationale**: `DRIVE_SCOPE` becomes `https://www.googleapis.com/auth/drive` (`src/auth/oauth.ts:3`). Only the desktop auth URL uses it; refresh grants carry no scope, so a phone linked afterwards with a new setup token inherits full Drive from the Mac's refresh token, and a device still holding a `drive.file` refresh token keeps syncing its own folder (D4's `'<id>' in parents` listing works under either scope for files the token can see). No forced re-sign-in at upgrade: the user re-signs in on the Mac when they want to pin a folder the plugin did not create, and D13 tells them so when a lookup fails for that reason. Steelman against full `drive`, and the answer: (a) it is a *restricted* scope — the plugin loses its "non-sensitive, no review" story, every user of the plugin sees Google's unverified-app warning once at sign-in, and a leaked refresh token now exposes the whole Drive rather than one folder; (b) `drive.file` plus the Google Picker would keep the narrow scope. The user weighed (b) and rejected it because the Picker cannot run inside Obsidian on iOS. The sharper variant of (b) — a desktop-only Picker in the system browser plus the setup-token handoff that D18 builds anyway — fails for a different reason: `drive.file` is per-file consent, so a Picker grant covers the items opened at that moment, and a file that a collaborator adds to the shared folder *later* was never created or opened by this app and stays invisible to it; a two-way sync of a folder other people write into cannot be built on it from either platform. The Picker would also need a hosted page with an API key, against the README's "no third-party server" promise. The remaining narrow-scope option — `drive.readonly` — is also restricted and cannot write. (a) is therefore the accepted cost, and it is a cost each user carries on *their own* OAuth client (this plugin never ships one), so the 100-user cap and verification never apply to anyone but the person who created the client; the README and settings copy must state the blast-radius change plainly (D21). Fence check: this is an auth/permission change, and it is settled by the request in the user's own words, so it is a decision here, not an `L2 fenced:` gap.

### D7: Both desktop and phone show the folder link field; the phone can paste a link too
- **Status**: assumed
- **Rationale**: The Sync section is shared by both platforms (`renderSyncBehaviour`), and verifying a link is one `files.get` through `requestUrl`, which the phone can do. Normally the phone receives the pinned folder inside the setup token (D18) and never types it. Rejected: desktop-only field (a phone-only user with a link from a collaborator would have no way in).

### D8: Folders inside Shared Drives are supported by passing the all-drives flags on every file call
- **Status**: assumed
- **Rationale**: Every `files.*` request gains `supportsAllDrives=true`; every `files.list` and `changes.list` also gains `includeItemsFromAllDrives=true`. Without them Google hides Shared Drive content even under full scope, and a Korean "공동" folder may well live in a Shared Drive. The upload metadata is unchanged (a parent id inside a Shared Drive works once the flag is on). Rejected: My Drive only (cheap to support, and the user's screenshot does not say which kind of sharing it is).

### D9: Google-native files and shortcuts are skipped and named once
- **Status**: assumed
- **Rationale**: In `listTree`, a child whose `mimeType` starts with `application/vnd.google-apps.` and is not the folder mime is not added to `files`; its path goes into a new `unsupported: string[]` return value. The engine copies them into `report.skipped` as `<path> (Google Docs, Sheets and similar files are not synced)` so the existing once-per-session console naming in `main.ts` applies, and nothing in the index refers to them. Rejected: exporting them (format choices, one-way only, out of scope); letting them hit `alt=media` (a Drive error on every sync).

### D10: A folder the account can only view is refused at pin time
- **Status**: assumed
- **Rationale**: Sync is two-way; an upload into a view-only folder fails with 403 on every run. D2's `capabilities.canAddChildren === false` refuses with "You can only view this folder. Ask its owner for edit access, or pick another folder." Rejected: pinning anyway with a warning (the user would get an error wall at the first sync); a read-only mode (Non-goal).

### D11: Other collaborators are just more "remote"; conflict copies keep this device's name
- **Status**: resolved (L1, `src/sync/engine.ts` conflict path and `deviceName`)
- **Rationale**: Edits by other people arrive as remote md5 changes exactly like edits from the user's other device, so the engine needs no concept of a collaborator. Conflict copies are still named after this device, which is unique among the user's devices; two different people conflicting on the same note at the same minute on devices both named "Mac" is accepted (the README's advice to set a device name covers it). Rejected: including the Drive owner's email in conflict names (leaks addresses into shared folders).

### D12: Folder refusals have fixed, specific messages
- **Status**: assumed
- **Rationale**: Shown as a `Notice` and, while the field keeps the rejected text, under the field: unparseable input → "That is not a Google Drive folder link or ID."; `files.get` 404, or an `AuthError` with `status === 403` (Google answers 404 for items a token cannot see and 403 for ones it can see but not open; to the user both are "not reachable with this sign-in") → "Google can't find this folder with this sign-in." followed by D13's hint when the sign-in is known to lack full Drive; not a folder → "That link points to a file, not a folder."; trashed → "That folder is in the Drive trash."; view-only → D10's text; any other Drive/auth error → `describeError(e)` as today. Messages never include the folder ID (it is not secret, but it adds nothing). Rejected: one generic "Couldn't use this folder" (the user cannot tell a typo from a permission problem).

### D13: The granted scope is read from Google's token response; a sign-in without full Drive is explained, never blocked
- **Status**: assumed
- **Rationale**: `TokenResponse` gains `scope?: string`; `TokenManager.refresh` records the response's scope and exposes `hasFullDrive(): boolean | null` (`null` until a token has been fetched; Google includes `scope` in refresh-grant responses). `invalidate()` resets the recorded scope to `null` — sign-in, token link and sign-out all call it (`src/ui/settings-tab.ts:194`, `src/main.ts:233`, `:304`), so a hint from the previous sign-in is never shown against a new one; the hint stays hidden until the next token fetch, which the first sync performs. The settings tab, when `hasFullDrive() === false`, shows under the folder link field: on desktop "This sign-in can only see folders the plugin created. Sign in again to use a shared folder."; on the phone "… Sign in again on your computer and paste a new setup token here." D12's 404 message appends the same hint. Nothing else changes — syncing the plugin's own folder keeps working under the old scope (D6). Rejected: persisting a `grantedScope` setting written at sign-in (misses migrated 0.2.x sign-ins, which have no such record, and the token response is the ground truth anyway); forcing a sign-out at upgrade (breaks working setups on both devices for a feature the user may not use).

### D14: A remote delete that Google refuses with 403 is reported once and the file is allowed to come back
- **Status**: assumed
- **Rationale**: A non-owner cannot trash a file in someone else's My Drive. Today `call` throws `AuthError(message, false)` for 401/403 without the status (`src/drive/client.ts:157`) although `AuthError` has an optional `status` (`src/auth/oauth.ts:15`); `call` now passes `res.status` as the third argument — a `client.ts` change, not an auth-module one — so callers can tell 403 from 401. A 403 whose body matched the throttle pattern (`rateLimitExceeded|quotaExceeded|backendError`, `src/drive/client.ts:139-143`) and ran out of retries is thrown as a `DriveError` with status 403, not an `AuthError`, so an `AuthError` with `status === 403` always means a permission refusal. Tests assert both shapes. In `deleteRemote`, an `AuthError` with `status === 403` drops the index entry, adds `<path> (can't delete in Drive: you don't own this file; it will come back on the next sync)` to `report.skipped`, and does not count as an error. The next sync sees remote-only with no baseline and downloads it again — no data is lost, and the console names it once. Any other failure keeps today's behaviour (error, entry kept, retried). Rejected: `removeParents` to pull the file out of the folder (whether a non-owner editor may do that is not confirmed, and it would move the owner's file to an orphaned place in *their* Drive); retrying forever (an error on every sync with no way out); deleting the local file's trash copy or anything else destructive.

### D15: Losing the root later (access revoked, folder trashed or deleted) stops the sync with a clear message and changes nothing
- **Status**: assumed
- **Rationale**: A new `verifyPinnedRoot()` in `main.ts` runs in `syncNow` right after `await this.ensureRoot()` (`src/main.ts:400`) — not inside `ensureRoot`, which `signIn` also awaits inside its "Sign-in failed" try block (`src/ui/settings-tab.ts:198-203`), so a root problem is never reported as a failed sign-in. When `rootFolderLink` is non-empty it runs the D2 `files.get` check once per session: `inspectFolder` itself is uncached (the settings tab and R2.2 call it for arbitrary ids and need a fresh answer each time). The once-per-session memo lives in `main.ts`: `verifyPinnedRoot` stores the root id it last verified as healthy (`isFolder && !trashed && writable`) in a private field, skips the call while that equals `drive.getRoot()`, and clears it whenever the plugin calls `drive.resetCache()` or `drive.setRoot()` (sign-in, link, sign-out, pin, unpin), so a new sign-in or a new pin always re-checks. A 404, an `AuthError` with `status === 403`, or `trashed=true` there throws a `DriveError` whose message is "The Drive folder this vault syncs with is gone or no longer shared with you. Pick another folder in the plugin settings."; `writable === false` (the owner downgraded the user to viewer after the pin) throws "You can only view this folder now. Ask its owner for edit access, or pick another folder. Sync stopped." — the "gone" message only when `rootFolderLinkName` is non-empty, i.e. the folder was verified before; a never-verified pin (D16, `rootFolderLinkName === ""`) gets D12's messages instead. Index and settings are untouched, so restoring access resumes where it left off. Rejected: auto-clearing the link (the user would silently fall back to a fresh My Drive folder and upload their vault there); treating the empty listing as "everything was deleted" (D4 already fails a listing that errors, so this cannot happen by accident).

### D16: A link can be pinned before the device is linked; verification then happens at the first sync
- **Status**: assumed
- **Rationale**: When the user is not signed in, D2 cannot call Google. The parsed ID is saved into `rootFolderLink`/`rootFolderId` with `rootFolderLinkName = ""`, the field shows `Will be checked at the first sync`, and D15's `verifyPinnedRoot()` in `syncNow` performs the verification then: while `rootFolderLinkName === ""` a failure uses D12's messages (D15's "gone" message is reserved for a folder that was verified once); on success the check writes `rootFolderLinkName` from the folder's name and saves settings, so the field then shows `Linked to "<name>"`. The same applies on a phone that received a link through the setup token (D18) with an empty name. Rejected: refusing input until signed in (setup order should not matter; on a phone the token arrives first anyway).

### D17: Three settings fields describe the root: `rootFolderLink`, `rootFolderId`, `rootFolderLinkName`
- **Status**: assumed
- **Rationale**: `rootFolderLink: string` (default `""`) holds the user's input as typed so the field redisplays it; `rootFolderId` keeps its role as the effective root (also filled by the name path, as today); `rootFolderLinkName: string` (default `""`) holds the verified folder name for display. `rootFolderName` is unchanged. Existing 0.2.x `data.json` files load with the defaults and behave exactly as before (link empty → name path). Rejected: reusing `rootFolderName` for the verified name (it is the *create-by-name* input and must survive a later unpin); a boolean `pinned` flag next to `rootFolderId` (loses the typed input).

### D18: The setup token carries the pinned link and verified name; the receiving device trusts them
- **Status**: assumed
- **Rationale**: `LinkPayload` gains optional `folderLink` and `folderLinkName`; `encryptSetupToken` copies them into the inner JSON when present and `toLinkPayload` accepts them when they are strings (`src/auth/setup-token.ts:216-243`). `copySetupToken` fills them from settings; `linkDevice` always overwrites `rootFolderLink`, `rootFolderLinkName` *and* `rootFolderId` from the payload — `""` when the field is absent or empty, so a phone re-linked from a Mac that is not pinned, or that unpinned and has not synced since (its `rootFolderId` is `""`, D3), stops syncing into the old shared folder and falls back to the name path like the Mac; `folderName` keeps today's keep-if-absent rule (`src/main.ts:221`) because an empty name would only be refilled with the vault name at the next load — and does not re-verify (the Mac already did, and the first sync's D15 check will). The envelope (`gdvs2:`, PBKDF2, AES-GCM) is untouched; a 0.2.x device ignores the extra keys and still gets `folderId`, so cross-version linking keeps working — though a 0.2.x device must not be left on the old `listTree` sweep with a full-Drive token (README, D21). Rejected: sending only `folderId` and letting the phone show the bare ID (confusing to read, and the phone would show the vault name under "Drive folder name" for a folder that is not it).

### D19: Link parsing lives in a new pure module; the Drive client keeps all HTTP
- **Status**: resolved (L1 convention — pure logic in small modules such as `src/util/paths.ts`, HTTP only in `src/drive/client.ts`)
- **Rationale**: `src/drive/folder-ref.ts` exports `parseFolderRef` and the ID pattern, with no imports from `obsidian`, so it is testable without the stub. The same module holds the two pure decision helpers the Obsidian-coupled code calls, so the rules in D2, D3, D10, D12, D15 and D16 are unit-testable: `planFolderLink(current: { rootFolderLink, rootFolderId }, input: string, inspect: FolderInspection | null, linked: boolean)` returns one of `{ kind: "noop" }`, `{ kind: "unpin" }`, `{ kind: "defer", id }` (not linked), `{ kind: "pin", id, name, resetBaseline: boolean }` or `{ kind: "refuse", message }` (the settings tab performs the `files.get` and passes its result in); and `rootProblem(inspect: FolderInspection | { error: unknown }, verifiedBefore: boolean, hint: string | null)` returns the D12/D15 message string or `null`. `src/sync/probe.ts` holds `relevantChange(change, knownIds: Set<string>, knownFolders: Set<string>): boolean` and `QuietProbes` (counts consecutive no-change probes; `forceSweep()` is true on every 12th) for D5. `src/settings.ts` gains `applyLinkedFolder(settings, payload: LinkPayload): void` for D18's overwrite rules. Obsidian-coupled code (`main.ts`, `settings-tab.ts`) only wires these. The `files.get` verification is `DriveClient.inspectFolder(id)` returning `{ id, name, writable, isFolder, trashed }` or throwing a `DriveError` (404 and other non-auth failures, with `status`) or an `AuthError` that now carries `status` (D14); the settings tab (D2) and `verifyPinnedRoot` in `main.ts` (D15) share it — never `ensureRoot`. Rejected: parsing inside the settings tab (untestable in node, Obsidian-coupled).

### D20: New behaviour is covered by node tests through the existing stub and harness
- **Status**: resolved (L1, `tests/run.mjs`, `tests/obsidian-stub.ts:7`, `tests/harness.ts`)
- **Rationale**: `parseFolderRef` is tested directly. `DriveClient` is tested for the first time by constructing it with a fake `TokenManager` (`{ getAccessToken: async () => "t", invalidate() {} }`) and answering `requestUrl` through `setRequestUrlHandler`, asserting on the query strings (`'<id>' in parents`, `supportsAllDrives`) — always on decoded parameters, `new URL(url).searchParams.get("q")` / `.get("fields")` / `.get("supportsAllDrives")`, never on the raw URL text, because the client builds `q` and `fields` with `encodeURIComponent`; every quoted query or field string in the Requirements is the decoded form — on the walk (nested folders, pagination, a failing subfolder throwing), on the probe filter, and on `inspectFolder`'s field handling. Engine tests extend `fakeDrive` with `unsupported` and a `trash` that throws a 403. Engine tests for the new branches build their own fake drive in their own file (the existing `fakeDrive` stays as is). Setup-token tests round-trip the two new fields and check that old payloads still decode. Test files follow the acceptance-test naming the L4 tasks set (`tests/tt<n>_*.test.ts`), which `tests/run.mjs` collects by its `*.test.ts` filter. Rejected: adding a mocking library (no new dev dependency needed).

### D21: README and settings copy describe the new scope honestly and the new limits
- **Status**: assumed (the request names the verification consequence; the wording is the agent's)
- **Rationale**: README "How it works → Scope" says the plugin asks for full Google Drive access (`drive`), why (`drive.file` cannot see folders shared with you; the Picker does not run on iOS), that this is a Google *restricted* scope, and what a leaked refresh token could reach. The Cloud setup section replaces "publishing goes through immediately with no review" with: the consent screen still must be In production; on the first sign-in Google shows "Google hasn't verified this app" — choose Advanced → Go to <app name> (unsafe), which is expected for a client only you use; the 100-user cap and verification apply only if you share your client ID with many people. Setup gains a "Syncing a shared folder" subsection (paste link on Mac → name appears → Sync now → copy a new setup token to the phone), which also says that pasting the link of a folder the plugin created earlier keeps using it — the way to keep an old folder after recreating the OAuth client (D22). Known limits: replace the `drive.file` limit with "Google Docs, Sheets and Slides are skipped", "Files owned by someone else cannot be deleted from Drive by you; a delete here brings them back", "A view-only folder is refused", and "Both devices must run version 1.0.0 or later: older versions list your entire Drive under the new permission". `src/ui/settings-tab.ts:68` loses the non-sensitive claim and gains the unverified-app sentence. Rejected: leaving verification unmentioned (the user hits the warning screen on the first sign-in and would think something broke).

### D22: The name-based search only finds folders this plugin created
- **Status**: assumed (found by the L2 review: under full `drive` the old query matches any My Drive folder with the vault's name)
- **Rationale**: `ensureRootFolder`'s query (`src/drive/client.ts:181-183`) gains `and appProperties has { key='gdvs' and value='1' }` — `createFolder` has stamped every plugin folder with that property since the first commit (`src/drive/client.ts:200`) — plus `supportsAllDrives=true` (D8), and `orderBy=createdTime` with `fields=files(id,name,createdTime)`. Zero matches → create, as today. More than one → use the oldest and log a warning naming the count (two plugin folders with the same name can only come from an earlier race; the oldest is the one other devices already hold). An unrelated user folder named like the vault is therefore never adopted, so its contents are never pulled into the vault nor the vault pushed into it. Known cost: `appProperties` are visible only to the OAuth client that wrote them, so a user who recreated their Cloud project would get a fresh plugin folder rather than the old one — the README's new "Syncing a shared folder" subsection (D21, T7) tells them to paste the old folder's link to keep using it. Rejected: keeping the name-only query (adopts an arbitrary folder); matching on name and asking the user (a new UI for a case the property already decides).

## Constraints
- The scope string is the only auth change: no edits to the loopback flow, PKCE, the token manager's refresh logic beyond recording `scope`, the credential store, or the setup-token envelope and KDF.
- Nothing destructive is added: no new deletes, no auto-clearing of the pinned folder, no index wipe except the explicit pin/unpin reset the name field already does today.
- `main.js` keeps bundling only `require("obsidian")`; no new runtime or dev dependencies.
- Existing 0.2.x `data.json` files load unchanged and behave as before when `rootFolderLink` is empty.
- Tests run offline through `tests/obsidian-stub.ts`; no test may call Google.
- The folder ID, link and names are never written to the console at `warn`/`error` level inside the auth modules; tokens and secrets are never logged anywhere (unchanged rule).
- All work stays on `feat/full-drive-scope`; nothing is pushed, tagged or released by this run. `manifest.json` / `versions.json` are not bumped (release step).
- README text refers to the next release as 1.0.0 (the user chose 1.0.0 for this release on 2026-10-26).

## Known Gaps
- Google behaviour to confirm by the user at the first sign-in (manual): the exact unverified-app screen for a restricted scope on an In-production, unverified client, and that the refresh token issued there does not expire after 7 days. If Google blocks the sign-in outright instead of warning, the only remedies are outside this plugin (verification, or an Internal-type Workspace client).
- Whether `changes.list` reports changes made by *other people* to files in a folder shared with the user (manual, on the real shared folder). D5's hourly forced sweep bounds the damage if it does not.
- Whether a non-owner editor may remove another owner's file from a shared folder via `removeParents`; D14 chose the conservative path and does not depend on the answer.
- Fence check: the one auth/permission change (D6) is settled by the request in the user's own words, so there are no `L2 fenced:` entries. The run is still on its own branch and nothing is pushed.
- L2-reviewer: three rounds, each NEEDS_FIX with fewer and narrower findings (4 → 8 → 6, the last round's being lifecycle and consistency details plus the D22 gap). The retry budget allowed two re-reviews, so the third round's six issues were applied to D4, D6, D15, D18, D19 and new D22 without a fourth L2 review; the fresh-context Spec Review at L4 is the check that they hold together.

## L2 Checkpoint Summary

| Dimension | Checkpoints | Resolved | Score |
|-----------|-------------|----------|-------|
| Core Behavior (30%) | link forms (D1); set/verify/pin (D2); precedence + clear (D3); tree listing (D4); change probe (D5); scope + upgrade path (D6); name search under full scope (D22) | 7/7 | 1.00 |
| Scope Boundaries (20%) | platforms (D7); Shared Drives (D8); Google-native files (D9); view-only folders (D10); collaborators as actors (D11); Non-goals listed | 6/6 | 1.00 |
| Error/Edge (25%) | refusal messages (D12); old-scope sign-in (D13); refused remote delete (D14); root lost later (D15); pin before sign-in (D16); partial listing must fail whole (D4) | 6/6 | 1.00 |
| Data Model (15%) | settings fields (D17); token payload (D18); granted scope not persisted (D13); reset on root change (D2); all-drives flags on requests (D8) | 5/5 | 1.00 |
| Implementation (10%) | parse module (D19); tests via stub (D20); docs (D21); listing concurrency (D4) | 4/4 | 1.00 |

Composite 1.00 (threshold 0.80; every dimension ≥ 0.60). Unknown/unknowns: Tier 1 actors — user, linked phone, collaborators/owner, Google, plugin itself: all covered. Tier 2 implications — D4 ⇒ partial-failure rule (added to D4); D6 ⇒ upgrade path (D6, D13); D18 ⇒ cross-version linking (D18, D21). Tier 3 pair tensions — D4×deletion guard (partial tree → in D4); D5×startup (empty folder map before the first `listTree` → first sync of a session always walks, in D5); D2×D3 (link of the name-created folder → saved without a reset, in D2); D15×D16 (one check, two message sets → discriminated by `rootFolderLinkName`, in D15/D16); D12/D14/D15×error shape (`AuthError` without status → `call` passes `res.status`; throttled 403 → `DriveError`, in D14/D19); D13×sign-in flows (stale scope after re-sign-in → `invalidate()` clears it, in D13); D18×D17 (token without a link must unpin, in D18); D15×`signIn` (root check moved out of `ensureRoot` into `syncNow`, in D15); D2×`onChange` (verify on blur/Enter only, in D2); D4×D15 cache lifecycle (map swapped after success; verified flag cleared with `hasListed`, in D4/D15); D2×D4 (pin during an in-flight walk → walk discards itself, in D4); D10×D15 (viewer downgrade after pin → own message, in D15); D18×D3 (unpinned Mac sends `folderId: ""` → phone's `rootFolderId` overwritten, in D18); D6 steelman (desktop Picker + token handoff → per-file consent misses collaborators' later files, in D6); D13×D18 (phone receives a link from a Mac that has not re-signed-in → D13's phone message); D6×0.2.x devices (old `listTree` under a full-Drive token → D21 README limit). Status at round end: 0 pending.

## Requirements

### R0: A vault syncs two-way with a Google Drive folder the plugin did not create — D1, D2, D4, D6

#### R0.1: Shared folder pinned on the Mac syncs both ways (manual)
- **Given**: A Mac signed in with the new scope, and a folder someone else owns shared with this account as editor, containing a few Markdown files
- **When**: The user pastes the folder's link into "Drive folder link or ID", sees `Linked to "<name>"`, and clicks Sync now
- **Then**: The folder's files appear in the vault, the vault's files appear in the folder on drive.google.com, and the status bar shows the sync time

#### R0.2: A phone linked afterwards syncs the same folder (manual)
- **Given**: R0.1 done; a new setup token copied from the Mac
- **When**: The phone pastes the token and code and links
- **Then**: The phone's "Drive folder link or ID" field shows the same link and `Linked to "<name>"`, and its first sync downloads the shared folder's files

#### R0.3: No claim that drive.file is in use remains
- **Given**: The finished branch
- **When**: Running `grep -rn "drive\.file" src README.md`
- **Then**: Every hit is a sentence about what the plugin *no longer* uses or could not do under it; none describes the current scope

### R1: Folder links and IDs are parsed by one pure function — D1, D19

#### R1.1: Folder links in every documented form yield the ID
- **Given**: The inputs `https://drive.google.com/drive/folders/1AbC_d-9xyz`, `https://drive.google.com/drive/u/1/folders/1AbC_d-9xyz?usp=sharing`, `https://drive.google.com/drive/mobile/folders/1AbC_d-9xyz`, `https://www.drive.google.com/open?id=1AbC_d-9xyz#x`, `https://drive.google.com/folderview?id=1AbC_d-9xyz`, `drive.google.com/drive/folders/1AbC_d-9xyz`, and `  1AbC_d-9xyz  `
- **When**: Each is passed to `parseFolderRef` from `src/drive/folder-ref.ts`
- **Then**: Each returns `"1AbC_d-9xyz"`

#### R1.2: Anything that is not a folder link or ID yields null
- **Given**: The inputs `https://drive.google.com/file/d/1AbC_d-9xyz/view`, `https://example.com/drive/folders/1AbC_d-9xyz`, `my notes folder`, `short`, `1AbC_d-9xyz extra`, and `""`
- **When**: Each is passed to `parseFolderRef`
- **Then**: Each returns `null`

### R2: The Drive client inspects folders, reports permission errors with their status, and asks Google for all drives — D2, D8, D14, D19, D20, D22

#### R2.1: inspectFolder returns the folder's name and write capability
- **Given**: `requestUrl` answers `GET …/files/<id>` with `{ id, name: "공동", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canAddChildren: true } }`
- **When**: `DriveClient.inspectFolder("<id>")` is called
- **Then**: The request URL contains `supportsAllDrives=true` and `fields=` naming `id,name,mimeType,trashed,capabilities(canAddChildren)`, and the result is `{ id, name: "공동", isFolder: true, trashed: false, writable: true }`

#### R2.2: inspectFolder reports a file, a trashed folder and a view-only folder as such
- **Given**: Three answers: `mimeType: "text/markdown"`; a folder with `trashed: true`; a folder with `capabilities.canAddChildren: false`
- **When**: `inspectFolder` is called for each
- **Then**: The results have `isFolder: false`, `trashed: true`, and `writable: false` respectively; none throws

#### R2.3: A 404 from inspectFolder is a DriveError with status 404
- **Given**: `requestUrl` answers 404 with a Drive error body
- **When**: `inspectFolder` is called
- **Then**: It rejects with a `DriveError` whose `status` is 404

#### R2.4: A permission 403 carries its status on the AuthError
- **Given**: `requestUrl` answers 403 with body `{ error: { message: "The user does not have sufficient permissions", errors: [{ reason: "insufficientFilePermissions" }] } }`
- **When**: Any `DriveClient` call, e.g. `trash("<id>")`, is made
- **Then**: It rejects without retrying with an `AuthError` whose `status` is 403

#### R2.5: A throttled 403 that exhausts its retries is a DriveError, not an AuthError
- **Given**: `requestUrl` answers every call with 403 and body containing `rateLimitExceeded`, and timers are short enough for the test
- **When**: `download("<id>")` is called
- **Then**: After the retries it rejects with a `DriveError` whose `status` is 403, and `requestUrl` was called 6 times

#### R2.6: Every files request carries the all-drives flags
- **Given**: A client with a root set and `requestUrl` recording every URL
- **When**: `listTree()`, `inspectFolder(id)`, `hasChangesSince(token, () => true)`, `download(id)`, `trash(id)`, `ensureFolder("a/b")` and `upload({ path: "a/b/n.md", … })` are each called with stub answers
- **Then**: Every `…/files…` and `…/changes…` URL contains `supportsAllDrives=true`, and every `files?q=` list and `changes?` URL also contains `includeItemsFromAllDrives=true`

#### R2.7: The name-based search only matches plugin-created folders and takes the oldest
- **Given**: A client with no root; `requestUrl` answers the search with two folders in the order Google would return for `orderBy=createdTime`: id `older` (`createdTime` 2024) then id `newer` (2025)
- **When**: `ensureRootFolder("My Vault")` is called
- **Then**: The query contains `appProperties has { key='gdvs' and value='1' }`, `'root' in parents`, `orderBy=createdTime`, and `supportsAllDrives=true`; the client trusts the order and returns `older` (the first entry); no create request was made; and with an empty answer a `POST …/files` create is made and its id returned

### R3: Pinning, unpinning and verifying the root follow fixed rules, surfaced in the settings tab — D2, D3, D7, D10, D12, D13, D15, D16, D17, D19

#### R3.1: Unparseable input is refused without touching settings
- **Given**: `current = { rootFolderLink: "", rootFolderId: "old" }`, `linked = true`
- **When**: `planFolderLink(current, "not a link", null, true)` is called
- **Then**: It returns `{ kind: "refuse", message: "That is not a Google Drive folder link or ID." }`

#### R3.2: Re-committing the stored link is a no-op
- **Given**: `current = { rootFolderLink: "https://drive.google.com/drive/folders/X1234567890", rootFolderId: "X1234567890" }` and an inspection of X1234567890 as a writable folder
- **When**: `planFolderLink(current, " https://drive.google.com/drive/folders/X1234567890 ", inspect, true)` is called
- **Then**: It returns `{ kind: "noop" }`

#### R3.3: Pinning the folder the plugin created by name keeps the baseline
- **Given**: `current = { rootFolderLink: "", rootFolderId: "X1234567890" }` and an inspection of X1234567890 as a writable folder named "My Vault"
- **When**: `planFolderLink(current, "X1234567890", inspect, true)` is called
- **Then**: It returns `{ kind: "pin", id: "X1234567890", name: "My Vault", resetBaseline: false }`

#### R3.4: Pinning a different writable folder resets the baseline
- **Given**: `current = { rootFolderLink: "", rootFolderId: "old" }` and an inspection of `NEW1234567890` as a writable, untrashed folder named "공동"
- **When**: `planFolderLink(current, "https://drive.google.com/drive/folders/NEW1234567890", inspect, true)` is called
- **Then**: It returns `{ kind: "pin", id: "NEW1234567890", name: "공동", resetBaseline: true }`

#### R3.5: A file, a trashed folder and a view-only folder are refused with their own messages
- **Given**: Inspections with `isFolder: false`; `trashed: true`; `writable: false`
- **When**: `planFolderLink(current, "<link>", inspect, true)` is called for each
- **Then**: It returns `refuse` with, respectively, "That link points to a file, not a folder.", "That folder is in the Drive trash.", and "You can only view this folder. Ask its owner for edit access, or pick another folder."

#### R3.6: A 404 is refused with the not-found message, plus the hint when the scope is known to be old
- **Given**: `inspect = { error: new DriveError("…", 404) }`
- **When**: `rootProblem(inspect, false, null)` and `rootProblem(inspect, false, "This sign-in can only see folders the plugin created. Sign in again to use a shared folder.")` are called
- **Then**: The first returns "Google can't find this folder with this sign-in." and the second returns that sentence followed by a space and the hint

#### R3.7: Empty input unpins; input while not linked defers
- **Given**: `current = { rootFolderLink: "<link>", rootFolderId: "X1234567890" }`
- **When**: `planFolderLink(current, "", null, true)` and `planFolderLink({ rootFolderLink: "", rootFolderId: "" }, "Y1234567890", null, false)` are called
- **Then**: The first returns `{ kind: "unpin" }` and the second `{ kind: "defer", id: "Y1234567890" }`

#### R3.8: A root lost after verification gets the "gone" message; one never verified gets D12's
- **Given**: `inspect = { error: new AuthError("…", false, 403) }`
- **When**: `rootProblem(inspect, true, null)` and `rootProblem(inspect, false, null)` are called
- **Then**: The first returns "The Drive folder this vault syncs with is gone or no longer shared with you. Pick another folder in the plugin settings." and the second returns "Google can't find this folder with this sign-in."

#### R3.9: A viewer downgrade after the pin stops the sync with its own message; a healthy root returns null
- **Given**: `inspect = { id, name, isFolder: true, trashed: false, writable: false }` and a healthy inspection
- **When**: `rootProblem(inspect, true, null)` is called for each
- **Then**: The first returns "You can only view this folder now. Ask its owner for edit access, or pick another folder. Sync stopped." and the second returns `null`

#### R3.10: Settings carry the three root fields with empty defaults
- **Given**: `DEFAULT_SETTINGS` from `src/settings.ts` and a 0.2.2-shaped stored object without the new keys
- **When**: `Object.assign(cloneSettings(DEFAULT_SETTINGS), stored)` is evaluated, as `loadSettings` does
- **Then**: `rootFolderLink` and `rootFolderLinkName` are `""`, `rootFolderName` and `rootFolderId` keep the stored values

#### R3.11: The settings tab commits the field on blur or Enter, never per keystroke (manual)
- **Given**: A linked desktop with the settings tab open
- **When**: The user types a 12-character ID one character at a time, then presses Enter
- **Then**: No Notice appears while typing; one `files.get` is made on Enter; the description under the field changes to `Linked to "<name>"` or to the refusal message

#### R3.12: Pinning resets the baseline and the name field stops resetting it (manual)
- **Given**: A pinned link
- **When**: The user edits "Drive folder name"
- **Then**: `rootFolderId`, the index and the change token are unchanged in data.json, and the name field's description says the name is not used while a link is set

#### R3.13: Clearing the link reverts to the name-based folder (manual)
- **Given**: A pinned link and a completed sync
- **When**: The user clears the field and presses Enter, then syncs
- **Then**: data.json shows `rootFolderLink`, `rootFolderLinkName` and `rootFolderId` empty, and the sync uses or creates the My Drive folder named in "Drive folder name"

#### R3.14: A pin made before sign-in shows "Will be checked at the first sync" and is verified then (manual)
- **Given**: A desktop that is not linked
- **When**: The user pastes a valid link, then signs in and the first sync runs
- **Then**: The field first shows `Will be checked at the first sync`; after the sync it shows `Linked to "<name>"`, or the sync stops with the D12 message and the sign-in itself still reports success

#### R3.15: The old-scope hint appears only when a token response proves the scope is narrow (manual)
- **Given**: A desktop still holding a `drive.file` refresh token after upgrading
- **When**: The settings tab is opened before any sync, then after a sync
- **Then**: Before: no hint; after: "This sign-in can only see folders the plugin created. Sign in again to use a shared folder." under the link field; after signing in again and syncing, the hint is gone

### R4: The tree listing walks down from the root and never returns a partial tree — D4, D9

#### R4.1: Nested folders are walked and paths built from the root
- **Given**: A client with root `R`; `requestUrl` answers `'R' in parents` with folder `A` (id a) and file `top.md`, `'a' in parents` with file `n.md` and folder `B` (id b), `'b' in parents` with file `deep.md`
- **When**: `listTree(2)` is called
- **Then**: `files` has paths `top.md`, `A/n.md`, `A/B/deep.md` with their ids and md5s; `folders` maps `""→R`, `A→a`, `A/B→b`; every list request's decoded `q` contains `in parents` and `trashed=false`, and its `pageSize` is `1000` and `includeItemsFromAllDrives` is `true`; no request's decoded `q` equals `trashed=false` alone

#### R4.2: Pagination within one folder is followed
- **Given**: `'R' in parents` answers two pages, the first with `nextPageToken: "p2"`
- **When**: `listTree()` is called
- **Then**: The second request carries `pageToken=p2` and `files` contains the entries from both pages

#### R4.3: A failing subfolder fails the whole listing and leaves the previous map
- **Given**: A client whose earlier `listTree()` succeeded; now `'a' in parents` answers 500 six times
- **When**: `listTree()` is called again
- **Then**: It rejects with a `DriveError`, `knownFolderIds()` still equals the earlier successful map's ids, and `hasListed()` is still true

#### R4.4: Google-native files and shortcuts are reported as unsupported, not as files
- **Given**: `'R' in parents` answers a Google Doc (`application/vnd.google-apps.document`), a shortcut (`application/vnd.google-apps.shortcut`) and `note.md`
- **When**: `listTree()` is called
- **Then**: `files` has only `note.md`; `unsupported` equals `["Plan", "Link"]` (their names as paths); `rejected` is empty

#### R4.5: A root change during the walk discards the result
- **Given**: `requestUrl`'s answer for `'R' in parents` calls `client.setRoot("S")` before returning
- **When**: `listTree()` is called
- **Then**: It rejects with a `DriveError` whose message is "The Drive folder changed during the sync; run it again." and `knownFolderIds()` is `{"S"}` only

#### R4.6: Unsafe names are still rejected
- **Given**: `'R' in parents` answers a file named `../escape.md`
- **When**: `listTree()` is called
- **Then**: `rejected` contains `../escape.md` and `files` does not

### R5: The change probe only fires for the synced tree and yields to a full walk when it cannot judge — D5, D19

#### R5.1: hasChangesSince passes each change to the relevance predicate and requests parents
- **Given**: `requestUrl` answers `changes` with `[{ fileId: "x", file: { id: "x", parents: ["p"] } }, { fileId: "y", removed: true }]` and `newStartPageToken: "n"`
- **When**: `hasChangesSince("t", isRelevant)` is called with a recording predicate
- **Then**: The URL's `fields` names `changes(fileId,removed,file(id,parents,trashed))` and contains `includeItemsFromAllDrives=true`; the predicate saw both changes; the result is `{ changed: <predicate's OR>, nextToken: "n" }`

#### R5.2: relevantChange recognises edits, removals, moves and new children
- **Given**: `knownIds = {"f1"}`, `knownFolders = {"root", "sub"}`
- **When**: `relevantChange` from `src/sync/probe.ts` is called with `{ fileId: "f1" }`, `{ fileId: "f1", removed: true }`, `{ fileId: "new", file: { parents: ["sub"] } }`, `{ fileId: "sub", file: { trashed: true } }`, and `{ fileId: "other", file: { parents: ["elsewhere"] } }`
- **Then**: The first four return `true` and the last `false`

#### R5.3: hasListed is false until a walk completes and after a reset
- **Given**: A fresh client with `setRoot("R")`
- **When**: `hasListed()` is read; `listTree()` succeeds and it is read again; `resetCache()` and read; then `setRoot("R")`, `listTree()` succeeds, `setRoot("R")` again, and read
- **Then**: The readings are `false`, `true`, `false`, `false`

#### R5.4: QuietProbes forces a sweep on every 12th consecutive quiet probe
- **Given**: `const q = new QuietProbes()`
- **When**: `q.quiet()` is called 11 times, then a 12th; then `q.changed()` and 12 more `quiet()` calls
- **Then**: `q.forceSweep()` is `false` after the 11th, `true` after the 12th, `false` right after `changed()`, and `true` again after the next 12th quiet probe

#### R5.5: syncNow walks on the first sync of a session and probes afterwards (manual)
- **Given**: A linked device with a stored change token, restarted
- **When**: The startup sync runs, then an interval sync with no changes
- **Then**: With verbose logging on, the developer console shows one `listing folder <path>` debug line per folder for the first sync, and for the second only `probing changes` followed by `no relevant changes` and no `listing folder` lines

### R6: The plugin asks for full Drive and knows what scope a sign-in has — D6, D13

#### R6.1: The auth URL requests the drive scope
- **Given**: `buildAuthUrl({ clientId, redirectUri, state, codeChallenge })` from `src/auth/oauth.ts`
- **When**: Its `scope` query parameter is decoded
- **Then**: It equals `https://www.googleapis.com/auth/drive`, and `DRIVE_SCOPE` exports the same string

#### R6.2: hasFullDrive reflects the last token response and resets on invalidate
- **Given**: A `TokenManager` whose credentials are set and `requestUrl` answers the token endpoint with `{ access_token, expires_in: 3600, scope: "https://www.googleapis.com/auth/drive.file" }`
- **When**: `hasFullDrive()` is read before any call, after `getAccessToken()`, after `invalidate()`, and after another `getAccessToken()` whose answer's scope is `"https://www.googleapis.com/auth/drive"`
- **Then**: The readings are `null`, `false`, `null`, `true`

#### R6.3: A response without a scope field leaves the scope unknown
- **Given**: A token response with no `scope`
- **When**: `getAccessToken()` resolves and `hasFullDrive()` is read
- **Then**: It is `null`

### R7: The engine skips what cannot be synced and does not retry a delete it cannot make — D9, D11, D14

#### R7.1: Unsupported remote entries are reported as skipped and never indexed
- **Given**: A fake drive whose `listTree()` returns `unsupported: ["Plan"]` and no files; an empty vault and index
- **When**: `SyncEngine.run(index, opts)` runs
- **Then**: `report.skipped` contains `Plan (Google Docs, Sheets and similar files are not synced)`, `report.errors` is empty and the returned index has no `Plan` key

#### R7.2: A 403 on a remote delete drops the entry and reports it once as skipped
- **Given**: Index has `shared.md` with id `s1`; the vault no longer has it; the fake drive lists it unchanged and its `trash` rejects with `new AuthError("refused", false, 403)`
- **When**: `run` executes
- **Then**: `report.skipped` contains `shared.md (can't delete in Drive: you don't own this file; it will come back on the next sync)`, `report.errors` is empty, `report.deletedRemote` is 0 and the returned index has no `shared.md`

#### R7.3: Any other delete failure keeps today's error path
- **Given**: Same as R7.2 but `trash` rejects with `new DriveError("boom", 500)`
- **When**: `run` executes
- **Then**: `report.errors` has one entry starting with `shared.md:` and the returned index still has `shared.md`

#### R7.4: A collaborator's edit is an ordinary remote change (manual)
- **Given**: R0.1 done; another person edits a note in the shared folder on drive.google.com
- **When**: The next sync runs on the Mac
- **Then**: The note updates in the vault; if the Mac had also edited it, a `(conflict … Mac)` copy appears beside it and in Drive

### R8: The setup token carries the pinned folder and the receiving device applies it exactly — D18

#### R8.1: folderLink and folderLinkName round-trip through the encrypted token
- **Given**: A payload with `folderId: "X1234567890"`, `folderName: "My Vault"`, `folderLink: "https://drive.google.com/drive/folders/X1234567890"`, `folderLinkName: "공동"`
- **When**: `encryptSetupToken(payload)` then `decryptSetupToken(token, code)` from `src/auth/setup-token.ts`
- **Then**: The decrypted payload equals the input, including both new fields

#### R8.2: Payloads without the new fields still decode
- **Given**: A payload with only the three credentials and `folderId`
- **When**: Encrypted and decrypted
- **Then**: The result has no `folderLink` or `folderLinkName` key and is otherwise equal

#### R8.3: applyLinkedFolder overwrites id, link and name from the payload, including to empty
- **Given**: Settings with `rootFolderLink: "<old>"`, `rootFolderLinkName: "Old"`, `rootFolderId: "old"`, `rootFolderName: "Vault"`
- **When**: `applyLinkedFolder(settings, { …creds, folderId: "", folderName: "Vault" })` from `src/settings.ts`, then with `{ …creds, folderId: "n1", folderLink: "<new>", folderLinkName: "New", folderName: "" }`
- **Then**: After the first call `rootFolderId`, `rootFolderLink`, `rootFolderLinkName` are all `""`; after the second they are `"n1"`, `"<new>"`, `"New"`, and `rootFolderName` is still `"Vault"` both times

#### R8.4: Copy setup token includes the pinned folder (manual)
- **Given**: A pinned Mac
- **When**: The user copies a setup token and links a phone with it
- **Then**: The phone's field shows the Mac's link and `Linked to "<name>"` without any typing

### R9: README and settings copy describe full Drive access and the new limits — D21

#### R9.1: No text claims the scope is non-sensitive or review-free
- **Given**: The finished branch
- **When**: Running `grep -rn -i "non-sensitive\|no verification review\|with no review" README.md src`
- **Then**: No matches

#### R9.2: README documents the restricted scope, the unverified-app step, and the shared-folder setup
- **Given**: `README.md`
- **When**: Running `grep -n "auth/drive\b\|hasn't verified\|Shared folder\|shared folder\|1.0.0" README.md`
- **Then**: Hits exist in "How it works", in the Cloud setup section, in a "Syncing a shared folder" subsection and in Known limits

#### R9.3: Known limits list the four new limits
- **Given**: `README.md` Known limits section
- **When**: Read
- **Then**: It names Google Docs/Sheets/Slides being skipped, files owned by others coming back after a delete, view-only folders being refused, and both devices needing 1.0.0 or later; it no longer says `drive.file` cannot see files it did not create

#### R9.4: The settings tab's credentials help names the unverified-app warning (manual)
- **Given**: A desktop settings tab
- **When**: The Google credentials section is read
- **Then**: It says Google shows "Google hasn't verified this app" at sign-in and how to continue, and no longer mentions a non-sensitive scope

## Tasks

Fence check: no task is marked `Fenced`. The only auth/permission change (the scope constant, T3) is settled by the request in the user's own words (D6); nothing touches secrets, crypto, schema migrations or billing. Acceptance-test tasks follow D20: each creates only new files `tests/tt<n>_*.test.ts`, which `tests/run.mjs` collects, and asserts the GWTs of its requirement; `(manual)` sub-requirements are listed in the test file's header comment as deferred to the user and get no test.

### T1: Settings fields and the pure decision modules [infra]
- **Fulfills**: R1, R3 (R3.1–R3.10), R5 (R5.2, R5.4), R8 (R8.3)
- **Depends on**: (none)
- **Files**: `src/settings.ts` (D17 fields + defaults, `applyLinkedFolder` per D18), `src/drive/types.ts` (`FolderInspection`, `GOOGLE_APPS_PREFIX = "application/vnd.google-apps."`), new `src/drive/folder-ref.ts` (`parseFolderRef`, `planFolderLink`, `rootProblem`, the fixed D12/D15 message strings exported as constants), new `src/sync/probe.ts` (`relevantChange`, `QuietProbes`). No imports from `obsidian` in the two new modules.

### T2: Drive client: inspection, error shapes, all-drives flags, scoped walk, filtered probe, restricted name search [infra]
- **Fulfills**: R2, R4, R5 (R5.1, R5.3)
- **Depends on**: T1
- **Files**: `src/drive/client.ts` only. `call` passes `res.status` to `AuthError` and throws a `DriveError(status 403)` for a throttled 403 that ran out of retries (D14); an optional third constructor argument `sleep: (ms) => Promise<void>` (default: the existing `sleep`) so tests skip the backoff; `supportsAllDrives=true` on every request and `includeItemsFromAllDrives=true` on every list/changes request (D8); `inspectFolder(id)` (D2/D19); `listTree(concurrency = 4)` rewritten as the D4 breadth-first walk returning `{ files, folders, rejected, unsupported }` with the root-change guard and the swap-after-success rule, `hasListed()` and `knownFolderIds()` (D5), the parent-graph reconstruction deleted; `hasChangesSince(pageToken, isRelevant)` with the D5 fields; `log.debug` lines through the existing logger — `listing folder <vault path or "/">` once per folder in the walk, `probing changes` at the start of `hasChangesSince` and `no relevant changes` / `relevant change seen` at its end — so R5.5 is observable in the console at verbose level (the logger already gates `debug` on the verbose setting, `src/util/log.ts`); `ensureRootFolder` query per D22, and its doc comment at `src/drive/client.ts:170-174` rewritten to describe the `appProperties` match instead of `drive.file` (R0.3 greps for it). `setRoot`/`resetCache` clear `hasListed` (D5); `inspectFolder` keeps no cache (D15 puts the memo in `main.ts`).

### T3: Request the drive scope and track the granted scope [vertical]
- **Fulfills**: R6
- **Depends on**: TT6
- **Files**: `src/auth/oauth.ts` only — `DRIVE_SCOPE`, `TokenResponse.scope?`, `TokenManager.hasFullDrive()`, `invalidate()` clearing it (D6, D13). Nothing else in the auth modules changes.

### T4: Engine: skip unsupported entries, stop retrying refused deletes [vertical]
- **Fulfills**: R7
- **Depends on**: T2, TT7
- **Files**: `src/sync/engine.ts` — pass `opts.concurrency` to `listTree`, copy `unsupported ?? []` into `report.skipped` with the D9 text (the existing `fakeDrive` in `tests/engine.test.ts:51-62` returns no `unsupported`, and those tests must keep passing unchanged), D14's 403 branch in `deleteRemote`. `tests/engine.test.ts` is NOT edited here (TT7 builds its own fake in its new file).

### T5: Setup token carries the pinned folder; linking applies it [vertical]
- **Fulfills**: R8
- **Depends on**: T1, TT8
- **Files**: `src/auth/setup-token.ts` (`LinkPayload.folderLink?`, `folderLinkName?`; `toLinkPayload` and `encryptSetupToken` handle them — envelope unchanged), `src/main.ts` (`copySetupToken` fills the two fields from settings; `linkDevice` replaces the two `if (payload.…)` lines at `src/main.ts:220-221` with `applyLinkedFolder(this.settings, payload)` inside the same `commitSettings`). Keep the `main.ts` edit to those two spots so T6 can follow.

### T6: Pin a folder from the settings tab and verify it at sync time [vertical]
- **Fulfills**: R0 (R0.1, R0.2), R3 (R3.11–R3.15), R5 (R5.5)
- **Depends on**: T1, T2, T3, T5, TT3, TT5
- **Files**: `src/ui/settings-tab.ts` — new "Drive folder link or ID" setting under "Drive folder name" in `renderSyncBehaviour` for both platforms (D7), committing on blur/Enter (D2) with this wiring: trimmed text equal to `rootFolderLink` → nothing; else `parseFolderRef` → `null` and non-empty → `planFolderLink(…, input, null, linked)` returns the refusal (no `files.get`); empty → unpin; an ID while not linked → defer; an ID while linked → `await drive.inspectFolder(id)`, on success `planFolderLink(current, input, inspection, true)`, on a throw `rootProblem({ error }, false, hint)` for the refusal text (R3.6) — then applying the plan (pin: save the three fields, optional baseline reset + `resetCache` + `setRoot`; unpin: blank the three fields + reset; defer: save id/link, name empty; refuse: Notice + description text), description states `Linked to "<name>"` / `Will be checked at the first sync`, the D13 hint when `tokens.hasFullDrive() === false`; the name field no longer blanks `rootFolderId`/index while `rootFolderLink` is set and says so (D3). `src/main.ts` — `verifyPinnedRoot()` called in `syncNow` right after `ensureRoot()` (D15/D16, using `rootProblem`, writing `rootFolderLinkName` on first success); the probe runs only when `drive.hasListed()` and `!quiet.forceSweep()`, with `isRelevant` built from the index ids and `drive.knownFolderIds()` via `relevantChange` (D5); `quiet.quiet()` after a probe that found nothing, `quiet.changed()` after every full walk (D5); `syncNow`'s explicit-sync rule unchanged. `styles.css` only if the description needs a class.

### T7: README and settings copy for the new scope and limits [vertical]
- **Fulfills**: R0 (R0.3), R9
- **Depends on**: T6, TT9
- **Files**: `README.md` (D21: "How it works → Scope", Cloud setup step 4 and the unverified-app step, new "Syncing a shared folder" subsection under Setup, Known limits rewritten, "1.0.0 or later" wording), `src/ui/settings-tab.ts:60-70` credentials help text (after T6 so the two edits to that file never run at once).

### TT1: acceptance tests for R1's GWTs
- **Fulfills**: R1 (tests)
- **Depends on**: T1
- **File**: new `tests/tt1_folder_ref.test.ts`

### TT2: acceptance tests for R2's GWTs
- **Fulfills**: R2 (tests)
- **Depends on**: T1, T2
- **File**: new `tests/tt2_drive_client.test.ts` — builds `DriveClient` with a fake `TokenManager` (`{ getAccessToken: async () => "t", invalidate() {} }`), a silent logger and an instant `sleep`, answering `requestUrl` via `setRequestUrlHandler` and recording URLs

### TT3: acceptance tests for R3's GWTs
- **Fulfills**: R3 (tests)
- **Depends on**: T1, T2
- **File**: new `tests/tt3_pin_rules.test.ts` (R3.1–R3.10; R3.11–R3.15 are manual)

### TT4: acceptance tests for R4's GWTs
- **Fulfills**: R4 (tests)
- **Depends on**: T1, T2
- **File**: new `tests/tt4_list_tree.test.ts`

### TT5: acceptance tests for R5's GWTs
- **Fulfills**: R5 (tests)
- **Depends on**: T1, T2
- **File**: new `tests/tt5_change_probe.test.ts` (R5.1–R5.4; R5.5 is manual)

### TT6: acceptance tests for R6's GWTs
- **Fulfills**: R6 (tests)
- **Depends on**: (none)
- **File**: new `tests/tt6_scope.test.ts`

### TT7: acceptance tests for R7's GWTs
- **Fulfills**: R7 (tests)
- **Depends on**: T1, T2
- **File**: new `tests/tt7_engine_edges.test.ts` (its own fake adapter and fake drive, modelled on `tests/engine.test.ts:16-62`; R7.4 is manual)

### TT8: acceptance tests for R8's GWTs
- **Fulfills**: R8 (tests)
- **Depends on**: T1
- **File**: new `tests/tt8_setup_token_folder.test.ts` (R8.1–R8.3; R8.4 is manual)

### TT9: acceptance tests for R9's GWTs
- **Fulfills**: R9 (tests)
- **Depends on**: T1, T2
- **File**: new `tests/tt9_docs.test.ts` — reads `README.md` and `src/ui/settings-tab.ts` from disk and asserts the R9.1–R9.3 greps as string checks (R9.4 is manual)

Parallelism: TT6 then T3, both independent of T1; T2 ∥ TT1 ∥ TT8 after T1; TT2–TT5, TT7, TT9 ∥ after T2; T4 ∥ T5 after their TTs; T6 after T3, T5 and TT3/TT5; T7 last. No two parallel tasks edit the same file (`src/main.ts` is T5 then T6; `src/ui/settings-tab.ts` is T6 then T7; `src/drive/client.ts` is T2 only).

## External Dependencies

### Pre-work
- (none) — the user's Google Cloud project needs no change: scopes are requested at runtime, and the consent screen stays "In production".

### Post-work
- On the Mac: build, install, open settings, click **Sign in again**, and note what Google shows for the restricted scope (expected: "Google hasn't verified this app" → Advanced → continue). If Google blocks the sign-in instead, that is the Known Gap and the README's wording must be corrected before release.
- Paste the shared folder's link, run Sync now (R0.1); copy a new setup token to the iPhone and link it (R0.2, R8.4); check R3.11–R3.15, R5.5, R7.4 and R9.4 by hand.
- Confirm on the real shared folder whether interval syncs pick up another person's edit within one interval (changes feed) or only within the hour (D5's forced sweep); record the answer in the spec's Known Gaps.
- Open a PR from `feat/full-drive-scope` to `main` (branch-and-PR rule; nothing is pushed by this run). Release 1.0.0 only after merge, with the usual "Release 1.0.0" commit bumping `manifest.json` and `versions.json`.

## Spec Review
- **Verdict**: NEEDS_FIX
- **Reviews**: 3
- **Fixed**:
  - [Coverage] T2 — the stale `drive.file` doc comment on `ensureRootFolder` is now rewritten in T2, so R0.3's grep passes.
  - [Consistency] D12 / R3.8 — a 403 on a folder that was never verified now gets the "can't find" message, which matches R3.8.
  - [Readiness] T4 / D20 — the engine reads `unsupported ?? []`, so the existing `fakeDrive` tests stay untouched.
  - [Readiness] D5 / T6 — `QuietProbes` restarts its count after every full walk, and its location now matches D19.
  - [Testability] R2.7 — the stub order and the expected id now agree.
  - [Grounding] D22 / D21 — the README advice D22 relied on did not exist; T7 now adds it to the new shared-folder subsection.
  - [Task order] Parallelism note — "TT6 then T3" replaces the false "T3 ∥ TT6".
  - [Testability] R5.3 — the call sequence is written out in full.
  - [Readiness] T6 — the parse, inspect, plan or refuse wiring is spelled out step by step.
  - [Testability] R5.5 / T2 — T2 adds debug lines, so the manual check has console output to look at.
  - [Testability] D20 / R4.1 — applied after the third review and not re-reviewed: URL assertions now use decoded parameters through `URLSearchParams`.
  - [Readiness] D15 / T2 — applied after the third review and not re-reviewed: `inspectFolder` is uncached, and the once-per-session memo lives in `main.ts`.
- **Open**:
  - The last two fixes above have not been checked by a reviewer. The re-review budget of 3 reviews was used up, so the unattended run stops here and does not execute.
