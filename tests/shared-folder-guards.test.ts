// Regression tests for the three defects the verification loop's Gate-3 checker
// found after the shared-folder build (specs/shared-folder-sync/loop.md, lessons L1–L3).

import { DataAdapter } from "obsidian";
import { AuthError, TokenManager } from "../src/auth/oauth";
import { DriveClient, DriveError } from "../src/drive/client";
import { SyncEngine } from "../src/sync/engine";
import { SyncIndex } from "../src/sync/state";
import { Logger } from "../src/util/log";
import { md5 } from "../src/util/md5";
import { setRequestUrlHandler } from "./obsidian-stub";
import { test, eq, assert, rejects, run } from "./harness";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const log = new Logger(() => false);
const silent = { debug() {}, warn() {} };

function client(tokens: unknown = { getAccessToken: async () => "t", invalidate() {} }): DriveClient {
  return new DriveClient(tokens as TokenManager, silent, async () => {});
}

test("L1 listTree refuses to list a root other than the one the sync started with", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return { status: 200, json: { files: [] }, text: "", headers: {} };
  });
  const c = client();
  c.setRoot("NEW");
  const err = await rejects(() => c.listTree(4, "OLD"), "listTree with a stale expected root");
  assert(err instanceof DriveError, `not a DriveError: ${err.name}`);
  eq(err.message, "The Drive folder changed during the sync; run it again.", "message");
  eq(requests, 0, "requests made");
  eq(c.hasListed(), false, "hasListed");
});

test("L1 the engine passes the root it started with to listTree", async () => {
  const seen: unknown[] = [];
  const drive = {
    async listTree(...args: unknown[]) {
      seen.push(...args);
      return { files: [], folders: new Map(), rejected: [], unsupported: [] };
    },
  };
  const adapter = { async list() { return { files: [], folders: [] }; } };
  const engine = new SyncEngine(adapter as unknown as DataAdapter, drive as unknown as DriveClient, log);
  await engine.run({}, {
    deviceName: "Mac",
    exclude: [],
    maxFileBytes: 1e9,
    deletionGuardRatio: 0.2,
    concurrency: 3,
    expectedRoot: "ROOT1",
  });
  eq(seen, [3, "ROOT1"], "listTree arguments");
});

test("L2 a tracked note whose Drive path now holds a Google Doc is not trashed locally", async () => {
  const index: SyncIndex = { "Plan.md": { id: "p1", md5: md5(enc("x")), size: 1, mtime: 1 } };
  const trashedLocal: string[] = [];
  const adapter = {
    async list(dir: string) {
      return { files: dir === "/" || dir === "" ? ["Plan.md"] : [], folders: [] };
    },
    async stat() {
      return { type: "file", size: 1, mtime: 1, ctime: 1 };
    },
    async exists() {
      return true;
    },
    async readBinary() {
      return enc("x");
    },
    async trashLocal(p: string) {
      trashedLocal.push(p);
    },
  };
  const drive = {
    async listTree() {
      return { files: [], folders: new Map(), rejected: [], unsupported: ["Plan.md"] };
    },
    async trash() {
      throw new Error("must not trash remotely");
    },
  };
  const engine = new SyncEngine(adapter as unknown as DataAdapter, drive as unknown as DriveClient, log);
  const { report, index: next } = await engine.run(index, {
    deviceName: "Mac",
    exclude: [],
    maxFileBytes: 1e9,
    deletionGuardRatio: 0.2,
    concurrency: 4,
  });
  eq(trashedLocal, [], "local trash");
  eq(report.deletedLocal, 0, "deletedLocal");
  eq(report.errors, [], "errors");
  assert(next["Plan.md"] !== undefined, "index entry kept");
});

test("L4 tracked files under a folder whose name this device refuses are held, not trashed", async () => {
  // Twelve tracked files, more than the deletion guard's floor of 10, so only
  // the hold keeps them from being read as deleted in Drive.
  const index: SyncIndex = {};
  const files: string[] = [];
  for (let i = 0; i < 12; i++) {
    const p = `bad./n${i}.md`;
    index[p] = { id: `b${i}`, md5: md5(enc("x")), size: 1, mtime: 1 };
    files.push(p);
  }
  const trashedLocal: string[] = [];
  const adapter = {
    async list(dir: string) {
      if (dir === "/" || dir === "") return { files: [], folders: ["bad."] };
      return { files, folders: [] };
    },
    async stat() {
      return { type: "file", size: 1, mtime: 1, ctime: 1 };
    },
    async exists() {
      return true;
    },
    async readBinary() {
      return enc("x");
    },
    async trashLocal(p: string) {
      trashedLocal.push(p);
    },
  };
  const drive = {
    async listTree() {
      // The walk refuses the folder itself and never lists its children.
      return { files: [], folders: new Map(), rejected: ["bad."], unsupported: [] };
    },
    async trash() {
      throw new Error("must not trash remotely");
    },
  };
  const engine = new SyncEngine(adapter as unknown as DataAdapter, drive as unknown as DriveClient, log);
  const { report, index: next } = await engine.run(index, {
    deviceName: "Mac",
    exclude: [],
    maxFileBytes: 1e9,
    deletionGuardRatio: 0.2,
    concurrency: 4,
  });
  eq(report.aborted, undefined, "aborted");
  eq(trashedLocal, [], "local trash");
  eq(report.uploaded, 0, "uploaded");
  eq(Object.keys(next).sort(), Object.keys(index).sort(), "index kept");
});

test("L3 a token-endpoint 403 never reaches Drive callers as a permission 403", async () => {
  setRequestUrlHandler(async () => {
    throw new Error("Drive must not be called without a token");
  });
  const tokens = {
    async getAccessToken() {
      throw new AuthError("Token request failed (403): access_denied", false, 403);
    },
    invalidate() {},
  };
  const err = await rejects(() => client(tokens).trash("f1"), "trash with a refused token");
  assert(err instanceof AuthError, `not an AuthError: ${err.name}`);
  eq((err as AuthError).status, undefined, "status");
  eq(err.message, "Token request failed (403): access_denied", "message");
});

void run().finally(() => setRequestUrlHandler(null));
