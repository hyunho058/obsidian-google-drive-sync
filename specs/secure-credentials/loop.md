# loop.md — Loop Contract

> Supervisor document for verifying `specs/secure-credentials/spec.md`
> (secret storage + encrypted setup token). Approved by the user on 2026-10-04.

## Goal
Verify that the working tree implements the Requirements R0–R14 of `specs/secure-credentials/spec.md` without violating its Decisions (D1–D22) or Constraints.

## Scope & non-goals
- In: src/auth/setup-token.ts, src/auth/credential-store.ts, src/auth/oauth.ts, src/main.ts, src/ui/modals.ts, src/ui/settings-tab.ts, src/settings.ts, styles.css, manifest.json, README.md, tests/*.
- Out: committing, pushing, tagging, publishing; the sync engine and Drive client; anything requiring a real device or the release workflow (deferred to T5/T6 and reported as deferred).

---

## Gate 1 — Pass/Fail  (100% required, binary)

| Check | Command |
|-------|---------|
| build (incl. tsc over src) | `npm run build` |
| tests | `npm test` |
| test-file typecheck | `npx tsc --noEmit --skipLibCheck --strict --target ES2020 --module ESNext --moduleResolution node --esModuleInterop --lib DOM,ES2020 --types node tests/*.ts` (every test file, including ones added during the loop) |
| lint | N/A — the project has no linter configured |
| iPhone-safe bundle | `test "$(grep -oE 'require\("[a-z_]+"\)' main.js \| sort -u)" = 'require("obsidian")'` |
| no direct legacy-secret access | `! grep -rnE 'settings\.(clientSecret\|refreshToken)' src --include='*.ts' \| grep -v 'src/auth/credential-store.ts'` |
| no v1 token path | `! grep -rnE 'encodeSetupToken\|decodeSetupToken' src tests` |
| no logging in token/window code | `! grep -nE 'console\.\|this\.log\.' src/auth/setup-token.ts src/ui/modals.ts` |
| minimum app version | `node -e "process.exit(require('./manifest.json').minAppVersion === '1.11.4' ? 0 : 1)"` |

## Gate 2 — Quantitative  (measured vs threshold)

| Metric | Threshold | How measured |
|--------|-----------|--------------|
| Code-verifiable sub-requirements unverified or failing | 0 of 67 (65 + R9.11, R9.12 added for 0.2.2) | Traceability table: each sub-req → passing test name or cited `file:line` |
| Sub-requirements deferred to release/device | only R0.1–R0.3, R12.2, R12.3 and the versions.json part of R12.1 | Same table |
| Test cases | ≥ 109 | `npm test` totals |
| main.js size | ≤ 80 KB | `stat -f%z main.js` after `npm run build` |

## Gate 3 — Qualitative  (score + grounds + action; each ≥ 8/10, scored by a separate checker)

- **Spec alignment** — decisions D1–D22 honoured in code.
- **Secret handling** — no leak paths (logs, notices, error text, clipboard), save ordering, rollback.
- **Phone flow** — keyboard, focus and messages in both windows.
- **Architecture fit & readability.**

```
<item>: <score>/10
  grounds: <specific, checkable observation>
  action: <change that raises it | "none — meets bar" + why>
```

---

## Autonomy Boundary

**✅ Auto-fix (stay in the loop):** missing in-scope tests, docs/comments, user-facing wording that does not change behaviour, type errors, local renames, behaviour-preserving refactors.

**🛑 STOP — call a human (escalate):**
- Any change to crypto parameters or primitives (PBKDF2/AES-GCM, code format, decoder bounds)
- Any change to how secrets are stored, migrated, rolled back or cleared
- Any change to the sign-in or link flow (verification order, save order, abort handling)
- Anything conflicting with the spec's Decisions or Constraints
- Committing, pushing, tagging or publishing

## Exit criteria
The loop exits only when every gate above passes and the Evidence Report is emitted. Hitting a 🛑 boundary ends the loop in escalation, not completion.

---

## Lessons  (self-learning — carried across runs of THIS contract)

### L1 — Unlink must stick
- cause: gate-fail
- source: human-approved
- form: gate3-item
- status: active
- check: Every rollback / unlink / sign-out failure path leaves the secret store, data.json and `isLinked()` / `credentials()` consistent — setting a `linked` flag alone is not enough; name the test that proves each path.
- note: Iteration 2 found a failed rollback that set linked=false while the device kept syncing with a mismatched pair (D21).

### L2 — "This process" means the app session
- cause: gate-fail
- source: human-approved
- form: gate3-item
- status: active
- check: Any proof that a value is already persisted (before erasing another copy) must survive a plugin reload within the same app session, for every value written to the store in that session — not only for generated ids.
- note: Iterations 1 and 3 each found a plugin-reload path where migration could erase the only on-disk copy (D1).

### L3 — Security fixes come with a test that catches their revert
- cause: gate-fail
- source: human-approved
- form: gate3-item
- status: active
- check: For each security fix in the change, a named test fails when that fix is reverted (re-introduce the bug from a backup copy, run `npm test`, restore and confirm the source is byte-identical); UI-only fixes that unit tests cannot reach are listed as such.
- note: Kept as a Gate-3 item rather than a Gate-1 command because the revert differs per fix and cannot be one fixed command.
