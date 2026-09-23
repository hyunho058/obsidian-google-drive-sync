import {
  PathFilter,
  canonical,
  collisionKey,
  conflictPath,
  folderChain,
  isSafeVaultPath,
  mimeFor,
  nfc,
} from "../src/util/paths";
import { effectiveExcludes } from "../src/settings";
import { decodeSetupToken, encodeSetupToken } from "../src/auth/setup-token";
import { md5 } from "../src/util/md5";

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
}

function ok(name: string, cond: boolean): void {
  if (cond) passed++;
  else failures.push(name);
}

// --- Unicode normalization -------------------------------------------------
// macOS/iOS hand back NFD. Drive stores the bytes it is given. Without
// normalization these are two different files with identical-looking names.
const KOREAN_NFC = "회의록";
const KOREAN_NFD = KOREAN_NFC.normalize("NFD");

ok("precondition: NFD differs from NFC", KOREAN_NFD !== KOREAN_NFC);
ok("precondition: differing code point counts", KOREAN_NFD.length !== KOREAN_NFC.length);
check("canonical recomposes NFD", canonical(`notes/${KOREAN_NFD}.md`), `notes/${KOREAN_NFC}.md`);
check("nfc is idempotent", nfc(nfc(KOREAN_NFD)), KOREAN_NFC);
ok(
  "NFD and NFC paths collapse to one key",
  collisionKey(`A/${KOREAN_NFD}.md`) === collisionKey(`a/${KOREAN_NFC}.md`),
);

// --- path shaping -----------------------------------------------------------
check("strips leading slash", canonical("/a/b.md"), "a/b.md");
check("collapses repeats", canonical("a//b///c.md"), "a/b/c.md");
check("folderChain", folderChain("a/b/c.md"), ["a", "b"]);
check("folderChain at root", folderChain("c.md"), []);
check("mime for markdown", mimeFor("a/b.md"), "text/markdown");
check("mime fallback", mimeFor("a/b.unknownext"), "application/octet-stream");
check("mime without extension", mimeFor("LICENSE"), "application/octet-stream");

// --- conflict naming --------------------------------------------------------
const when = new Date(2026, 8, 22, 14, 30);
check(
  "conflict keeps extension and folder",
  conflictPath("notes/meeting.md", "iPhone", when),
  "notes/meeting (conflict 2026-09-22 1430 iPhone).md",
);
check(
  "conflict on extensionless file",
  conflictPath("notes/README", "Mac", when),
  "notes/README (conflict 2026-09-22 1430 Mac)",
);
ok(
  "two devices produce different conflict names",
  conflictPath("a.md", "Mac", when) !== conflictPath("a.md", "iPhone", when),
);

// --- exclusion globs --------------------------------------------------------
const filter = new PathFilter([".obsidian/", "*.tmp", "**/node_modules/", "Private/Journal/"]);
ok("folder rule matches descendants", filter.excludes(".obsidian/plugins/x/data.json"));
ok("folder rule matches the folder itself", filter.excludes(".obsidian"));
ok("extension rule matches", filter.excludes("scratch.tmp"));
ok("extension rule does not over-match", !filter.excludes("scratch.md"));
ok("** matches nested", filter.excludes("code/deep/node_modules/pkg/index.js"));
ok("nested folder rule", filter.excludes("Private/Journal/2026-01-01.md"));
ok("sibling folder not excluded", !filter.excludes("Private/Notes/2026-01-01.md"));
ok("unrelated path kept", !filter.excludes("notes/meeting.md"));

// --- path traversal ---------------------------------------------------------
// Drive is not a path-based store: a file's `name` may contain "/" and "..".
// Those names become vault paths and get written to disk.
for (const evil of [
  "../evil.md",
  "../../../etc/passwd",
  "notes/../../escape.md",
  "./x.md",
  "a/./b.md",
  "..",
  "",
  "C:/Windows/system32",
  "notes/\u0000.md",
  "bad\u001fname.md",
]) {
  ok(`rejects traversal or control chars: ${JSON.stringify(evil)}`, !isSafeVaultPath(evil));
}

for (const good of [
  "notes/meeting.md",
  `notes/${KOREAN_NFC}.md`,
  "a/b/c/d.md",
  "file.with.dots.md",
  "..hidden-but-fine.md",
  "folder..name/x.md",
]) {
  ok(`accepts ordinary path: ${JSON.stringify(good)}`, isSafeVaultPath(good));
}

ok("NFD input is judged after normalization", isSafeVaultPath(`notes/${KOREAN_NFD}.md`));
// Leading slashes are stripped before validation, so this is an ordinary
// relative path inside the vault rather than an escape.
check("repeated leading slashes collapse", canonical("//server/share/x"), "server/share/x");
ok("...and the result is accepted", isSafeVaultPath("//server/share/x"));

// --- credential exclusion ---------------------------------------------------
// data.json holds the refresh token and client secret. The exclusion must
// follow wherever the plugin was actually installed, not a hardcoded guess.
const settingsStub = {
  exclude: [],
  syncConfigFolder: true,
} as unknown as Parameters<typeof effectiveExcludes>[0];

for (const dir of [
  ".obsidian/plugins/gdrive-vault-sync",
  ".obsidian/plugins/obsidian-google-drive-sync",
  ".obsidian/plugins/gdrive-vault-sync-beta",
  "custom-config/plugins/gdrive-vault-sync",
]) {
  const f = new PathFilter(effectiveExcludes(settingsStub, dir));
  ok(`credentials excluded when installed at ${dir}`, f.excludes(`${dir}/data.json`));
}

ok(
  "a sibling plugin's data is not swept up by the rule",
  !new PathFilter(
    effectiveExcludes(settingsStub, ".obsidian/plugins/gdrive-vault-sync"),
  ).excludes(".obsidian/plugins/other-plugin/data.json"),
);

// --- setup token ------------------------------------------------------------
const payload = {
  v: 1 as const,
  clientId: "123.apps.googleusercontent.com",
  clientSecret: "GOCSPX-secret",
  refreshToken: "1//refresh-토큰-value",
  folderId: "abc123",
  folderName: KOREAN_NFC,
};
const round = decodeSetupToken(encodeSetupToken(payload));
check("setup token round-trips", round, payload);
ok("setup token is prefixed", encodeSetupToken(payload).startsWith("gdvs1:"));

let rejected = 0;
for (const bad of ["", "hello", "gdvs1:!!!!", "gdvs1:" + btoa('{"v":1}')]) {
  try {
    decodeSetupToken(bad);
  } catch {
    rejected++;
  }
}
check("malformed tokens are rejected", rejected, 4);

// --- md5 --------------------------------------------------------------------
const abc = new TextEncoder().encode("abc");
check("md5 of abc", md5(abc.buffer as ArrayBuffer), "900150983cd24fb0d6963f7d28e17f72");
check("md5 of empty", md5(new ArrayBuffer(0)), "d41d8cd98f00b204e9800998ecf8427e");

const big = new Uint8Array(5 * 1024 * 1024);
for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
ok("md5 chunks large buffers", /^[0-9a-f]{32}$/.test(md5(big.buffer as ArrayBuffer)));

// --- report -----------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
