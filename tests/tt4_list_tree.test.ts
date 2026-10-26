import { DriveClient, DriveError } from "../src/drive/client";
import type { TokenManager } from "../src/auth/oauth";
import { setRequestUrlHandler } from "./obsidian-stub";
import { test, eq, assert, rejects, run } from "./harness";

const FOLDER = "application/vnd.google-apps.folder";

type Entry = {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime: string;
  parents: string[];
};

function file(id: string, name: string, parent: string, mimeType = "text/markdown"): Entry {
  return {
    id,
    name,
    mimeType,
    md5Checksum: `md5-${id}`,
    size: "10",
    modifiedTime: "2026-10-01T00:00:00.000Z",
    parents: [parent],
  };
}

function folder(id: string, name: string, parent: string): Entry {
  return { id, name, mimeType: FOLDER, modifiedTime: "2026-10-01T00:00:00.000Z", parents: [parent] };
}

function newClient(): DriveClient {
  const tokens = { getAccessToken: async () => "t", invalidate() {} } as unknown as TokenManager;
  const log = { debug() {}, warn() {} };
  const client = new DriveClient(tokens, log, async () => {});
  client.setRoot("R");
  return client;
}

function ok(json: unknown) {
  return { status: 200, json, text: JSON.stringify(json), headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

function fail(status: number) {
  const json = { error: { code: status, message: "backendError" } };
  return { status, json, text: JSON.stringify(json), headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

/** Decoded parameters of one request. */
function params(req: unknown): URLSearchParams {
  return new URL((req as { url: string }).url).searchParams;
}

/** The folder id a decoded `q` lists the children of, or null. */
function parentOf(q: string | null): string | null {
  const m = q ? /'([^']+)' in parents/.exec(q) : null;
  return m ? m[1] : null;
}

/** Answers each folder's listing from `tree`; records every request's decoded params. */
function serveTree(tree: Record<string, Entry[]>, seen: URLSearchParams[] = []): URLSearchParams[] {
  setRequestUrlHandler(async (req) => {
    const p = params(req);
    seen.push(p);
    const parent = parentOf(p.get("q"));
    if (parent === null || !(parent in tree)) throw new Error(`unexpected request q=${p.get("q")}`);
    return ok({ files: tree[parent] });
  });
  return seen;
}

function sortedPaths(files: { path: string }[]): string[] {
  return files.map((f) => f.path).sort();
}

test("R4.1 nested folders are walked and paths built from the root", async () => {
  const client = newClient();
  const seen = serveTree({
    R: [folder("a", "A", "R"), file("t", "top.md", "R")],
    a: [file("n", "n.md", "a"), folder("b", "B", "a")],
    b: [file("d", "deep.md", "b")],
  });
  const res = await client.listTree(2);

  eq(sortedPaths(res.files), ["A/B/deep.md", "A/n.md", "top.md"], "file paths");
  const byPath = new Map(res.files.map((f) => [f.path, f]));
  for (const [path, id] of [["top.md", "t"], ["A/n.md", "n"], ["A/B/deep.md", "d"]]) {
    const f = byPath.get(path) as unknown as { id: string; md5: string };
    eq(f.id, id, `${path} id`);
    eq(f.md5, `md5-${id}`, `${path} md5`);
  }
  const folders = [...res.folders.entries()].sort();
  eq(folders, [["", "R"], ["A", "a"], ["A/B", "b"]], "folders map");

  assert(seen.length >= 3, `expected at least 3 list requests, got ${seen.length}`);
  for (const p of seen) {
    const q = p.get("q") ?? "";
    assert(q.includes("in parents"), `q lacks "in parents": ${q}`);
    assert(q.includes("trashed=false"), `q lacks "trashed=false": ${q}`);
    eq(p.get("pageSize"), "1000", "pageSize");
    eq(p.get("includeItemsFromAllDrives"), "true", "includeItemsFromAllDrives");
    assert(q.trim() !== "trashed=false", "a request swept every file with q=trashed=false alone");
  }
});

test("R4.2 pagination within one folder is followed", async () => {
  const client = newClient();
  const seen: URLSearchParams[] = [];
  setRequestUrlHandler(async (req) => {
    const p = params(req);
    seen.push(p);
    if (parentOf(p.get("q")) !== "R") throw new Error(`unexpected request q=${p.get("q")}`);
    if (p.get("pageToken") === "p2") return ok({ files: [file("2", "two.md", "R")] });
    return ok({ files: [file("1", "one.md", "R")], nextPageToken: "p2" });
  });
  const res = await client.listTree();

  eq(seen.length, 2, "request count");
  eq(seen[1].get("pageToken"), "p2", "second request's pageToken");
  eq(sortedPaths(res.files), ["one.md", "two.md"], "files from both pages");
});

test("R4.3 a failing subfolder fails the whole listing and leaves the previous map", async () => {
  const client = newClient();
  serveTree({ R: [folder("a", "A", "R"), file("t", "top.md", "R")], a: [file("n", "n.md", "a")] });
  await client.listTree();
  const before = [...client.knownFolderIds()].sort();
  eq(before, ["R", "a"], "map after the successful listing");
  assert(client.hasListed(), "hasListed() after the successful listing");

  let failures = 0;
  setRequestUrlHandler(async (req) => {
    const parent = parentOf(params(req).get("q"));
    if (parent === "R") return ok({ files: [folder("a", "A", "R"), file("t", "top.md", "R")] });
    if (parent === "a" && failures < 6) {
      failures++;
      return fail(500);
    }
    if (parent === "a") return ok({ files: [file("n", "n.md", "a")] });
    throw new Error(`unexpected request q=${params(req).get("q")}`);
  });
  const err = await rejects(() => client.listTree(), "listTree with a failing subfolder");
  assert(err instanceof DriveError, `not a DriveError: ${err.constructor.name} ${err.message}`);
  eq([...client.knownFolderIds()].sort(), before, "knownFolderIds() after the failed listing");
  assert(client.hasListed(), "hasListed() after the failed listing");
});

test("R4.4 Google-native files and shortcuts are reported as unsupported, not as files", async () => {
  const client = newClient();
  serveTree({
    R: [
      file("g", "Plan", "R", "application/vnd.google-apps.document"),
      file("s", "Link", "R", "application/vnd.google-apps.shortcut"),
      file("m", "note.md", "R"),
    ],
  });
  const res = await client.listTree();
  eq(sortedPaths(res.files), ["note.md"], "files");
  eq(res.unsupported, ["Plan", "Link"], "unsupported");
  eq(res.rejected, [], "rejected");
});

test("R4.5 a root change during the walk discards the result", async () => {
  const client = newClient();
  setRequestUrlHandler(async (req) => {
    const parent = parentOf(params(req).get("q"));
    if (parent === "R") {
      client.setRoot("S");
      return ok({ files: [folder("a", "A", "R"), file("t", "top.md", "R")] });
    }
    if (parent === "a") return ok({ files: [] });
    throw new Error(`unexpected request q=${params(req).get("q")}`);
  });
  const err = await rejects(() => client.listTree(), "listTree across a root change");
  assert(err instanceof DriveError, `not a DriveError: ${err.constructor.name} ${err.message}`);
  eq(err.message, "The Drive folder changed during the sync; run it again.", "message");
  eq([...client.knownFolderIds()], ["S"], "knownFolderIds()");
});

test("R4.6 unsafe names are still rejected", async () => {
  const client = newClient();
  serveTree({ R: [file("x", "../escape.md", "R"), file("m", "note.md", "R")] });
  const res = await client.listTree();
  assert(res.rejected.includes("../escape.md"), `rejected lacks ../escape.md: ${JSON.stringify(res.rejected)}`);
  assert(
    !res.files.some((f) => f.path.includes("escape.md")),
    `files contains the unsafe name: ${JSON.stringify(sortedPaths(res.files))}`,
  );
});

void run().finally(() => setRequestUrlHandler(null));
