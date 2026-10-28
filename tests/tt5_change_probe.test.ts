/**
 * TT5: acceptance tests for R5 (specs/shared-folder-sync/spec.md) — the change
 * probe only fires for the synced tree and yields to a full walk when it
 * cannot judge (D5, D19, D20).
 *
 * Covered here: R5.1, R5.2, R5.3, R5.4.
 * Deferred to the user (manual, no test):
 *   R5.5 syncNow walks on the first sync of a session and probes afterwards —
 *        check with verbose logging that the startup sync logs one
 *        `listing folder <path>` line per folder, and a quiet interval sync
 *        logs only `probing changes` then `no relevant changes`.
 */
import type { TokenManager } from "../src/auth/oauth";
import { DriveClient, type DriveChange } from "../src/drive/client";
import { QuietProbes, relevantChange } from "../src/sync/probe";
import { setRequestUrlHandler } from "./obsidian-stub";
import { test, eq, assert, run } from "./harness";

function newClient(): DriveClient {
  return new DriveClient(
    { getAccessToken: async () => "t", invalidate() {} } as unknown as TokenManager,
    { debug() {}, warn() {} },
    async () => {},
  );
}

function reply(json: unknown) {
  return { status: 200, json, text: JSON.stringify(json), headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

const CHANGES = [
  { fileId: "x", file: { id: "x", parents: ["p"] } },
  { fileId: "y", removed: true },
];

/** Answers every request with the R5.1 change page and records the URLs. */
function answerChanges(urls: string[]): void {
  setRequestUrlHandler(async (req) => {
    urls.push((req as { url: string }).url);
    return reply({ changes: CHANGES, newStartPageToken: "n" });
  });
}

test("R5.1 hasChangesSince passes each change to the relevance predicate and requests parents", async () => {
  for (const verdict of [(c: DriveChange) => c.fileId === "y", (_c: DriveChange) => false]) {
    const urls: string[] = [];
    answerChanges(urls);
    const seen: DriveChange[] = [];
    const isRelevant = (c: DriveChange): boolean => {
      seen.push(c);
      return verdict(c);
    };
    const res = await newClient().hasChangesSince("t", isRelevant);

    assert(urls.length > 0, "no request was made");
    const params = new URL(urls[0]).searchParams;
    const fields = params.get("fields") ?? "";
    assert(
      fields.includes("changes(fileId,removed,file(id,parents,trashed))"),
      `fields does not name changes(fileId,removed,file(id,parents,trashed)): ${fields}`,
    );
    eq(params.get("includeItemsFromAllDrives"), "true", "includeItemsFromAllDrives");
    eq(seen, CHANGES, "changes the predicate saw");
    eq(res, { changed: CHANGES.some(verdict), nextToken: "n" }, "result");
  }
});

test("R5.2 relevantChange recognises edits, removals, moves and new children", () => {
  const knownIds = new Set(["f1"]);
  const knownFolders = new Set(["root", "sub"]);
  const cases: [DriveChange, boolean][] = [
    [{ fileId: "f1" }, true],
    [{ fileId: "f1", removed: true }, true],
    [{ fileId: "new", file: { parents: ["sub"] } }, true],
    [{ fileId: "sub", file: { trashed: true } }, true],
    [{ fileId: "other", file: { parents: ["elsewhere"] } }, false],
  ];
  for (const [change, expected] of cases) {
    eq(relevantChange(change, knownIds, knownFolders), expected, JSON.stringify(change));
  }
});

test("R5.3 hasListed is false until a walk completes and after a reset", async () => {
  // A minimal successful walk: the root has no children.
  setRequestUrlHandler(async () => reply({ files: [] }));
  const drive = newClient();
  drive.setRoot("R");
  const readings: boolean[] = [];
  readings.push(drive.hasListed());
  await drive.listTree();
  readings.push(drive.hasListed());
  drive.resetCache();
  readings.push(drive.hasListed());
  drive.setRoot("R");
  await drive.listTree();
  drive.setRoot("R");
  readings.push(drive.hasListed());
  eq(readings, [false, true, false, false], "readings");
});

test("R5.4 QuietProbes forces a sweep on every 12th consecutive quiet probe", () => {
  const q = new QuietProbes();
  for (let i = 0; i < 11; i++) q.quiet();
  eq(q.forceSweep(), false, "after the 11th quiet probe");
  q.quiet();
  eq(q.forceSweep(), true, "after the 12th quiet probe");
  q.changed();
  eq(q.forceSweep(), false, "right after changed()");
  for (let i = 0; i < 12; i++) q.quiet();
  eq(q.forceSweep(), true, "after the next 12th quiet probe");
});

void run().finally(() => setRequestUrlHandler(null));
