# loop.md — Loop Contract

> Supervisor document for verifying `specs/shared-folder-sync/spec.md`
> (shared-folder sync: folder link field + full `drive` scope). Implementation was built by
> agent-orchestrate (Parallel Subagent) on 2026-10-25; this loop verifies it and fixes within
> the Auto-fix boundary.

## Goal
Verify that the working tree on `feat/full-drive-scope` implements Requirements R0–R9 of `specs/shared-folder-sync/spec.md` without violating its Decisions (D1–D22) or Constraints.

## Scope & non-goals
- In: src/settings.ts, src/drive/types.ts, src/drive/folder-ref.ts, src/sync/probe.ts, src/drive/client.ts, src/auth/oauth.ts, src/auth/setup-token.ts, src/sync/engine.ts, src/main.ts, src/ui/settings-tab.ts, styles.css, README.md.
- Read-only: every `tests/tt*.test.ts` (acceptance tests written by separate agents; never modified by this loop) and `tests/engine.test.ts` (unchanged from main).
- Out: committing, pushing, tagging, version bumps, releases; anything needing a real device or Google account (the `(manual)` sub-requirements are deferred to the user and only judged by reading code).

---

## Gate 1 — Pass/Fail  (100% required, binary)

| Check | Command |
|-------|---------|
| build (incl. tsc over src) | `npm run build` |
| tests | `npm test` |
| test-file typecheck | `npx tsc --noEmit --skipLibCheck --strict --target ES2020 --module ESNext --moduleResolution node --esModuleInterop --lib DOM,ES2020 --types node $(ls tests/*.ts \| grep -v '^tests/engine.test.ts$')` — `tests/engine.test.ts` is excluded: its 3 errors (OPTS missing `deviceName`) predate this branch and the file is out of scope |
| lint | N/A — the project has no linter configured |
| iPhone-safe bundle | `test "$(grep -oE 'require\("[a-z_]+"\)' main.js \| sort -u)" = 'require("obsidian")'` |
| acceptance tests untouched since the build | `git status --short tests/ \| grep -v '^?? tests/tt[1-9]_' \| grep -v '^?? tests/shared-folder-guards' \| grep -q . && exit 1 \|\| exit 0` (no tracked test file modified; the only other new test file is the loop's own regression file, added in iteration 1) |
| no folder-ref/probe dependency on obsidian | `! grep -nE "from \"obsidian\"\|from 'obsidian'" src/drive/folder-ref.ts src/sync/probe.ts` |
| scope constant | `grep -q 'DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"' src/auth/oauth.ts` |

## Gate 2 — Quantitative  (measured vs threshold)

| Metric | Threshold | How measured |
|--------|-----------|--------------|
| Code-verifiable sub-requirements without a passing test | 0 of 42 (53 total − 11 `(manual)`) | Traceability table: each non-manual sub-req → passing test name in `tests/tt*.test.ts` |
| Test cases | ≥ 220 | sum of "N passed" lines from `npm test` |
| main.js size | ≤ 80 KB (81920 bytes) | `stat -f%z main.js` after `npm run build` |

## Gate 3 — Qualitative  (score + grounds + action; each ≥ 8/10, scored by a separate checker)

- **Spec alignment** — Decisions D1–D22 honoured in code. Includes judging the five deviations reported by the workers: (1) `syncNow` discards a sync whose root changed mid-run; (2) `verifyPinnedRoot` lets network/sign-in errors keep their original error instead of wrapping every problem in `DriveError(message, 0)` (D15); (3) `hasChangesSince`'s `isRelevant` is optional with default `() => true`; (4) `planFolderLink` returns `defer` when linked but `inspect` is null; (5) extra wording changes in README Security model, oauth.ts:3 and the client-secret description.
- **Data safety** — no path can turn a failed or partial remote listing, a root change, or a refused delete into lost files: deletion guard intact, partial walks throw, the D14 403 branch only drops an index entry, no new deletes.
- **Manual-requirement readiness** — reading `src/ui/settings-tab.ts` and `src/main.ts`, R3.11–R3.15, R5.5, R0.1, R0.2 and R8.4 would hold on a real device.
- **README and UI copy accuracy** — README and settings text match what the code does (scope, unverified-app step, shared-folder steps, Known limits, 0.3.0 note) and make no stale `drive.file` claim.

---

## Lessons

### L1 — Root changes are checked against a running sync
- cause: escalation
- source: human-approved
- form: gate3-item
- status: active
- check: Root-change safety — every path that changes the sync root (pin, unpin, deferred pin, folder-name change, setup-token link, sign-in, sign-out) is traced against a running or saving sync, and none lets an index built for the old root be written back or compared against the new root.
- note: iterations 1–2 found two windows (pin during the vault scan; settings saved before the client switched) where a small vault's files could be trashed; fixed by the listTree expected-root check, the settings comparison in syncNow, and refusing root changes while syncing.

### L2 — Items the remote walk does not list as files are held
- cause: gate-fail
- source: human-approved
- form: gate3-item
- status: active
- check: Held remote items — anything the remote walk does not return as a file (Google-native items, refused names, everything under a refused folder) is held by the engine, never counted by the deletion guard or reconciled as "deleted in Drive".
- note: Google Docs at a tracked path, and files under a folder whose name the device refuses, were read as remote deletions until engine.ts held them (tests/shared-folder-guards.test.ts L2, L4).

### L3 — Token-endpoint errors never look like Drive refusals
- cause: gate-fail
- source: human-approved
- form: context
- status: active
- check: —
- note: An AuthError with status 403 must only ever mean Drive refused a file or folder; DriveClient.call strips the status from token-endpoint errors, otherwise a refused refresh would drop index entries (D14) or show "folder unreachable".
