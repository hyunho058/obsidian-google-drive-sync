import { DataAdapter } from "obsidian";
import { DriveClient } from "../src/drive/client";
import { RemoteEntry } from "../src/drive/types";
import { SyncEngine, SyncReport, summarize } from "../src/sync/engine";
import { SyncIndex } from "../src/sync/state";
import { Logger } from "../src/util/log";
import { md5 } from "../src/util/md5";
import { keepsDeletedCopy } from "../src/util/trash";
import { test, eq, assert, run } from "./harness";

// ------------------------------------------------------------------ fakes

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

/** A flat in-memory vault: path → contents. Folders are implied by paths. */
function fakeAdapter(files: Record<string, string>): { adapter: DataAdapter; trashed: string[] } {
  const trashed: string[] = [];
  const data = new Map(Object.entries(files).map(([p, c]) => [p, enc(c)]));
  const adapter = {
    async list(dir: string) {
      const prefix = dir === "/" || dir === "" ? "" : `${dir}/`;
      const files: string[] = [];
      const folders = new Set<string>();
      for (const p of data.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) files.push(p);
        else folders.add(prefix + rest.slice(0, slash));
      }
      return { files, folders: [...folders] };
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
      trashed.push(p);
      data.delete(p);
    },
  };
  return { adapter: adapter as unknown as DataAdapter, trashed };
}

function fakeDrive(files: RemoteEntry[], rejected: string[]): { drive: DriveClient; trashed: string[] } {
  const trashed: string[] = [];
  const drive = {
    async listTree() {
      return { files, folders: new Map<string, string>(), rejected };
    },
    async trash(id: string) {
      trashed.push(id);
    },
  };
  return { drive: drive as unknown as DriveClient, trashed };
}

const log = new Logger(() => false);
const OPTS = { exclude: [], maxFileBytes: 1e9, deletionGuardRatio: 0.2, concurrency: 4 };

// ------------------------------------------------- names refused on this device

test("Drive files refused on this device are not counted by the deletion guard", async () => {
  // Twelve files an earlier version indexed under names Windows now refuses.
  const index: SyncIndex = {};
  const rejected: string[] = [];
  for (let i = 0; i < 12; i++) {
    const p = `notes/report${i}.`;
    index[p] = { id: `r${i}`, md5: md5(enc("x")), size: 1, mtime: 1 };
    rejected.push(p);
  }
  const { adapter } = fakeAdapter({});
  const { drive } = fakeDrive([], rejected);
  const engine = new SyncEngine(adapter, drive, log);
  const { report, index: next } = await engine.run(index, OPTS);
  eq(report.aborted, undefined, "aborted");
  eq(Object.keys(next).sort(), Object.keys(index).sort(), "index entries kept");
  eq(report.rejected.length, 12, "rejected reported");
});

test("A refused Drive name is never acted on as a delete on either side", async () => {
  const body = "same";
  const index: SyncIndex = {
    "Plan?.md": { id: "p1", md5: md5(enc(body)), size: 4, mtime: 1 },
    "keep.md": { id: "k1", md5: md5(enc(body)), size: 4, mtime: 1 },
  };
  const { adapter, trashed: localTrash } = fakeAdapter({ "keep.md": body });
  const { drive, trashed: remoteTrash } = fakeDrive(
    [{ path: "keep.md", id: "k1", md5: md5(enc(body)), size: 4, modifiedTime: 1 }],
    ["Plan?.md"],
  );
  const engine = new SyncEngine(adapter, drive, log);
  const { report, index: next } = await engine.run(index, OPTS);
  eq(remoteTrash, [], "nothing trashed in Drive");
  eq(localTrash, [], "nothing trashed locally");
  eq(report.deletedLocal + report.deletedRemote, 0, "no deletes counted");
  assert(next["Plan?.md"], "index entry for the refused name is kept");
});

test("A remote delete goes through the supplied trash function", async () => {
  const body = "gone remotely";
  const index: SyncIndex = { "a.md": { id: "a1", md5: md5(enc(body)), size: 13, mtime: 1 } };
  const { adapter, trashed: adapterTrash } = fakeAdapter({ "a.md": body });
  const { drive } = fakeDrive([], []);
  const viaHook: string[] = [];
  const engine = new SyncEngine(adapter, drive, log, async (p) => {
    viaHook.push(p);
  });
  const { report } = await engine.run(index, OPTS);
  eq(viaHook, ["a.md"], "trash hook called");
  eq(adapterTrash, [], "adapter not called directly");
  eq(report.deletedLocal, 1, "deletedLocal");
});

test("The summary calls refused names skipped, not blocked", () => {
  const report: SyncReport = {
    uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0,
    conflicts: [], skipped: [], rejected: ["Plan?.md"], errors: [],
  };
  eq(summarize(report), "Sync: 1 unusable name(s) skipped", "summary");
});

// ---------------------------------------------------- Deleted files setting

test("Only the system and vault trash settings count as keeping a copy", () => {
  const vault = (option: unknown) => ({ getConfig: (k: string) => (k === "trashOption" ? option : undefined) });
  eq(keepsDeletedCopy(vault("system")), true, "system");
  eq(keepsDeletedCopy(vault("local")), true, "local");
  eq(keepsDeletedCopy(vault("none")), false, "permanently delete");
  eq(keepsDeletedCopy(vault(undefined)), false, "unset");
  eq(keepsDeletedCopy({}), false, "no getConfig");
  eq(keepsDeletedCopy(null), false, "no vault");
  eq(
    keepsDeletedCopy({ getConfig: () => { throw new Error("boom"); } }),
    false,
    "getConfig throws",
  );
});

void run();
