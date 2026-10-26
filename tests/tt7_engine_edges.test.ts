/**
 * TT7: acceptance tests for R7 (specs/shared-folder-sync/spec.md) — the engine
 * skips what cannot be synced and does not retry a delete it cannot make
 * (D9, D11, D14).
 *
 * R7.1 Unsupported remote entries are reported as skipped and never indexed.
 * R7.2 A 403 on a remote delete drops the entry and reports it once as skipped.
 * R7.3 Any other delete failure keeps today's error path.
 * R7.4 A collaborator's edit is an ordinary remote change — MANUAL, not tested
 *      here: with the shared folder linked (R0.1), another person edits a note
 *      on drive.google.com; the next sync on the Mac updates the note, and if
 *      the Mac had also edited it a `(conflict … Mac)` copy appears beside it
 *      and in Drive.
 */
import { DataAdapter } from "obsidian";
import { AuthError } from "../src/auth/oauth";
import { DriveClient, DriveError } from "../src/drive/client";
import { RemoteEntry } from "../src/drive/types";
import { SyncEngine } from "../src/sync/engine";
import { SyncIndex } from "../src/sync/state";
import { Logger } from "../src/util/log";
import { md5 } from "../src/util/md5";
import { test, eq, assert, run } from "./harness";

// ------------------------------------------------------------------ fakes

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

/** A flat in-memory vault: path → contents. Folders are implied by paths. */
function fakeAdapter(files: Record<string, string>): DataAdapter {
  const data = new Map(Object.entries(files).map(([p, c]) => [p, enc(c)]));
  const adapter = {
    async list(dir: string) {
      const prefix = dir === "/" || dir === "" ? "" : `${dir}/`;
      const out: string[] = [];
      const folders = new Set<string>();
      for (const p of data.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) out.push(p);
        else folders.add(prefix + rest.slice(0, slash));
      }
      return { files: out, folders: [...folders] };
    },
    async stat(p: string) {
      const d = data.get(p);
      return d ? { type: "file", size: d.byteLength, mtime: 1, ctime: 1 } : null;
    },
    async exists(p: string) {
      return data.has(p);
    },
    async readBinary(p: string) {
      return data.get(p) as ArrayBuffer;
    },
    async trashLocal(p: string) {
      data.delete(p);
    },
  };
  return adapter as unknown as DataAdapter;
}

/** A drive whose listing carries `unsupported` and whose `trash` runs `onTrash`. */
function fakeDrive(
  files: RemoteEntry[],
  unsupported: string[],
  onTrash: (id: string) => Promise<void> = async () => {},
): { drive: DriveClient; trashCalls: string[] } {
  const trashCalls: string[] = [];
  const drive = {
    async listTree() {
      return { files, folders: new Map<string, string>(), rejected: [] as string[], unsupported };
    },
    async trash(id: string) {
      trashCalls.push(id);
      await onTrash(id);
    },
  };
  return { drive: drive as unknown as DriveClient, trashCalls };
}

const log = new Logger(() => false);
const OPTS = { deviceName: "Mac", exclude: [], maxFileBytes: 1e9, deletionGuardRatio: 0.2, concurrency: 4 };

/** R7.2/R7.3 Given: indexed and unchanged in Drive, gone from the vault. */
function deletedHere(onTrash: (id: string) => Promise<void>) {
  const body = "shared note";
  const sum = md5(enc(body));
  const index: SyncIndex = { "shared.md": { id: "s1", md5: sum, size: body.length, mtime: 1 } };
  const { drive, trashCalls } = fakeDrive(
    [{ path: "shared.md", id: "s1", md5: sum, size: body.length, modifiedTime: 1 }],
    [],
    onTrash,
  );
  return { index, adapter: fakeAdapter({}), drive, trashCalls };
}

// ------------------------------------------------------------------ R7

test("R7.1 Unsupported remote entries are reported as skipped and never indexed", async () => {
  const { drive } = fakeDrive([], ["Plan"]);
  const engine = new SyncEngine(fakeAdapter({}), drive, log);
  const { report, index: next } = await engine.run({}, OPTS);
  assert(
    report.skipped.includes("Plan (Google Docs, Sheets and similar files are not synced)"),
    `report.skipped names Plan as unsupported; got ${JSON.stringify(report.skipped)}`,
  );
  eq(report.errors, [], "report.errors");
  assert(!("Plan" in next), "returned index has no Plan key");
});

test("R7.2 A 403 on a remote delete drops the entry and reports it once as skipped", async () => {
  const { index, adapter, drive, trashCalls } = deletedHere(async () => {
    throw new AuthError("refused", false, 403);
  });
  const engine = new SyncEngine(adapter, drive, log);
  const { report, index: next } = await engine.run(index, OPTS);
  eq(trashCalls, ["s1"], "engine attempted the remote delete");
  const msg = "shared.md (can't delete in Drive: you don't own this file; it will come back on the next sync)";
  eq(
    report.skipped.filter((s) => s === msg).length,
    1,
    `report.skipped names shared.md once; got ${JSON.stringify(report.skipped)}`,
  );
  eq(report.errors, [], "report.errors");
  eq(report.deletedRemote, 0, "report.deletedRemote");
  assert(!("shared.md" in next), "returned index has no shared.md");
});

test("R7.3 Any other delete failure keeps today's error path", async () => {
  const { index, adapter, drive, trashCalls } = deletedHere(async () => {
    throw new DriveError("boom", 500);
  });
  const engine = new SyncEngine(adapter, drive, log);
  const { report, index: next } = await engine.run(index, OPTS);
  eq(trashCalls, ["s1"], "engine attempted the remote delete");
  eq(report.errors.length, 1, `report.errors has one entry; got ${JSON.stringify(report.errors)}`);
  assert(report.errors[0].startsWith("shared.md:"), `error starts with "shared.md:"; got ${report.errors[0]}`);
  assert("shared.md" in next, "returned index still has shared.md");
});

void run();
