/**
 * TT2 — acceptance tests for R2 (spec: specs/shared-folder-sync/spec.md;
 * decisions D2, D8, D14, D19, D20, D22). The Drive client is built with a fake
 * TokenManager, a silent logger and an instant sleep (D20); every requestUrl
 * call is answered and recorded here, and URLs are only ever inspected through
 * their decoded parameters (D20). No R2 sub-requirement is manual.
 */
import { AuthError, TokenManager } from "../src/auth/oauth";
import { DriveClient, DriveError } from "../src/drive/client";
import { setRequestUrlHandler } from "./obsidian-stub";
import { test, eq, assert, rejects, run } from "./harness";

const FOLDER = "application/vnd.google-apps.folder";
const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";

type Req = { url: string; method: string };
type Res = { status: number; json?: unknown; text?: string; headers?: Record<string, string>; arrayBuffer?: ArrayBuffer };

let seen: Req[] = [];

/** Routes every requestUrl call through `answer`, recording URL and method. */
function serve(answer: (req: Req, u: URL) => Res): void {
  seen = [];
  setRequestUrlHandler(async (raw) => {
    const r = raw as { url: string; method?: string };
    const req = { url: r.url, method: r.method ?? "GET" };
    seen.push(req);
    const res = answer(req, new URL(req.url));
    const json = res.json ?? {};
    return {
      status: res.status,
      json,
      text: res.text ?? JSON.stringify(json),
      headers: res.headers ?? {},
      arrayBuffer: res.arrayBuffer ?? new ArrayBuffer(0),
    };
  });
}

function client(): DriveClient {
  const tokens = { getAccessToken: async () => "t", invalidate() {} } as unknown as TokenManager;
  const log = { debug() {}, warn() {} };
  return new DriveClient(tokens, log, async () => {});
}

const param = (url: string, name: string) => new URL(url).searchParams.get(name);

// ------------------------------------------------------------------- R2.1

test("R2.1 inspectFolder returns the folder's name and write capability", async () => {
  serve(() => ({
    status: 200,
    json: { id: ID, name: "공동", mimeType: FOLDER, trashed: false, capabilities: { canAddChildren: true } },
  }));
  const result = await client().inspectFolder(ID);
  eq(seen.length, 1, "request count");
  const url = seen[0].url;
  assert(new URL(url).pathname.endsWith(`/files/${ID}`), `not a files.get of the id: ${new URL(url).pathname}`);
  eq(param(url, "supportsAllDrives"), "true", "supportsAllDrives");
  eq(param(url, "fields"), "id,name,mimeType,trashed,capabilities(canAddChildren)", "fields");
  eq(
    { id: result.id, name: result.name, isFolder: result.isFolder, trashed: result.trashed, writable: result.writable },
    { id: ID, name: "공동", isFolder: true, trashed: false, writable: true },
    "inspection",
  );
});

// ------------------------------------------------------------------- R2.2

test("R2.2 inspectFolder reports a file, a trashed folder and a view-only folder as such", async () => {
  const cases: { body: unknown; key: "isFolder" | "trashed" | "writable"; want: boolean }[] = [
    {
      body: { id: ID, name: "n.md", mimeType: "text/markdown", trashed: false, capabilities: { canAddChildren: false } },
      key: "isFolder",
      want: false,
    },
    {
      body: { id: ID, name: "old", mimeType: FOLDER, trashed: true, capabilities: { canAddChildren: true } },
      key: "trashed",
      want: true,
    },
    {
      body: { id: ID, name: "view", mimeType: FOLDER, trashed: false, capabilities: { canAddChildren: false } },
      key: "writable",
      want: false,
    },
  ];
  for (const c of cases) {
    serve(() => ({ status: 200, json: c.body }));
    const result = await client().inspectFolder(ID); // must not throw
    eq(result[c.key], c.want, c.key);
  }
});

// ------------------------------------------------------------------- R2.3

test("R2.3 a 404 from inspectFolder is a DriveError with status 404", async () => {
  const body = { error: { code: 404, message: `File not found: ${ID}.`, errors: [{ reason: "notFound" }] } };
  serve(() => ({ status: 404, json: body }));
  const err = await rejects(() => client().inspectFolder(ID), "inspectFolder");
  assert(err instanceof DriveError, `not a DriveError: ${err.name} ${err.message}`);
  eq((err as DriveError).status, 404, "status");
});

// ------------------------------------------------------------------- R2.4

test("R2.4 a permission 403 carries its status on the AuthError", async () => {
  const body = {
    error: {
      message: "The user does not have sufficient permissions",
      errors: [{ reason: "insufficientFilePermissions" }],
    },
  };
  serve(() => ({ status: 403, json: body }));
  const err = await rejects(() => client().trash(ID), "trash");
  assert(err instanceof AuthError, `not an AuthError: ${err.name} ${err.message}`);
  eq((err as AuthError).status, 403, "status");
  eq(seen.length, 1, "requests (no retry)");
});

// ------------------------------------------------------------------- R2.5

test("R2.5 a throttled 403 that exhausts its retries is a DriveError, not an AuthError", async () => {
  const body = { error: { message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } };
  serve(() => ({ status: 403, json: body }));
  const err = await rejects(() => client().download(ID), "download");
  assert(!(err instanceof AuthError), `an AuthError: ${err.message}`);
  assert(err instanceof DriveError, `not a DriveError: ${err.name} ${err.message}`);
  eq((err as DriveError).status, 403, "status");
  eq(seen.length, 6, "requestUrl calls");
});

// ------------------------------------------------------------------- R2.6

const SESSION =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&upload_id=session-1";

let created = 0;

/** Plausible Drive answers for every call R2.6 makes. */
function driveStub(req: Req, u: URL): Res {
  const path = u.pathname;
  const uploaded = { id: "up", name: "n.md", mimeType: "text/markdown", md5Checksum: "x", size: "1" };
  if (u.hostname === "www.googleapis.com" && path.startsWith("/upload/")) {
    if (u.searchParams.get("upload_id")) return { status: 200, json: uploaded };
    if (u.searchParams.get("uploadType") === "resumable") return { status: 200, headers: { Location: SESSION } };
    return { status: 200, json: uploaded };
  }
  if (path.endsWith("/changes")) return { status: 200, json: { changes: [], newStartPageToken: "next" } };
  if (path.endsWith("/files") && req.method === "POST") return { status: 200, json: { id: `new-${++created}` } };
  if (path.endsWith("/files")) {
    const q = u.searchParams.get("q") ?? "";
    // The walk: the root holds one subfolder, which is empty.
    if (q.startsWith("'root-id' in parents")) {
      return { status: 200, json: { files: [{ id: "sub-id", name: "sub", mimeType: FOLDER }] } };
    }
    return { status: 200, json: { files: [] } };
  }
  if (u.searchParams.get("alt") === "media") return { status: 200, arrayBuffer: new ArrayBuffer(3) };
  if (req.method === "PATCH") return { status: 200, json: {} };
  return {
    status: 200,
    json: { id: ID, name: "공동", mimeType: FOLDER, trashed: false, capabilities: { canAddChildren: true } },
  };
}

test("R2.6 every files request carries the all-drives flags", async () => {
  created = 0;
  serve(driveStub);
  const c = client();
  c.setRoot("root-id");
  await c.listTree();
  await c.inspectFolder(ID);
  await c.hasChangesSince("tok", () => true);
  await c.download(ID);
  await c.trash(ID);
  await c.ensureFolder("a/b");
  await c.upload({ path: "a/b/n.md", data: new TextEncoder().encode("hi").buffer as ArrayBuffer, mime: "text/markdown" });
  // A large file goes through the resumable path: init request, then the session URL.
  await c.upload({ path: "a/b/big.bin", data: new ArrayBuffer(4 * 1024 * 1024), mime: "application/octet-stream" });

  const filesOrChanges = seen.filter((r) => /\/(files|changes)(\/|$)/.test(new URL(r.url).pathname));
  assert(filesOrChanges.length === seen.length, "a request outside files/changes was made");
  for (const r of filesOrChanges) {
    eq(param(r.url, "supportsAllDrives"), "true", `supportsAllDrives on ${r.method} ${new URL(r.url).pathname}`);
  }

  const lists = seen.filter((r) => {
    const u = new URL(r.url);
    return (u.pathname.endsWith("/files") && u.searchParams.has("q")) || u.pathname.endsWith("/changes");
  });
  for (const r of lists) {
    eq(param(r.url, "includeItemsFromAllDrives"), "true", `includeItemsFromAllDrives on ${new URL(r.url).pathname}`);
  }

  // Every call kind was actually exercised.
  const kinds = {
    walk: lists.some((r) => (param(r.url, "q") ?? "").startsWith("'sub-id' in parents")),
    changes: lists.some((r) => new URL(r.url).pathname.endsWith("/changes")),
    inspect: seen.some((r) => new URL(r.url).pathname.endsWith(`/files/${ID}`) && param(r.url, "fields") !== null),
    download: seen.some((r) => param(r.url, "alt") === "media"),
    trash: seen.some((r) => r.method === "PATCH" && new URL(r.url).pathname.endsWith(`/files/${ID}`)),
    create: seen.some((r) => r.method === "POST" && new URL(r.url).pathname === "/drive/v3/files"),
    multipart: seen.some((r) => param(r.url, "uploadType") === "multipart"),
    resumableInit: seen.some((r) => param(r.url, "uploadType") === "resumable" && !param(r.url, "upload_id")),
    resumableSession: seen.some((r) => r.method === "PUT" && param(r.url, "upload_id") === "session-1"),
  };
  eq(kinds, Object.fromEntries(Object.keys(kinds).map((k) => [k, true])), "call kinds seen");
});

// ------------------------------------------------------------------- R2.7

test("R2.7 the name-based search only matches plugin-created folders and takes the oldest", async () => {
  serve((req, u) => {
    if (req.method === "POST") return { status: 200, json: { id: "created" } };
    if (u.searchParams.has("q")) {
      return {
        status: 200,
        json: {
          files: [
            { id: "older", name: "My Vault", createdTime: "2024-03-01T00:00:00.000Z" },
            { id: "newer", name: "My Vault", createdTime: "2025-03-01T00:00:00.000Z" },
          ],
        },
      };
    }
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });
  const id = await client().ensureRootFolder("My Vault");
  eq(id, "older", "chosen folder");
  eq(seen.length, 1, "requests (no create)");
  const search = seen[0].url;
  const q = param(search, "q") ?? "";
  assert(q.includes("appProperties has { key='gdvs' and value='1' }"), `q lacks the appProperties match: ${q}`);
  assert(q.includes("'root' in parents"), `q lacks 'root' in parents: ${q}`);
  eq(param(search, "orderBy"), "createdTime", "orderBy");
  eq(param(search, "supportsAllDrives"), "true", "supportsAllDrives");
});

test("R2.7 with no plugin-created folder found, a POST …/files create is made and its id returned", async () => {
  serve((req, u) => {
    if (req.method === "POST" && u.pathname === "/drive/v3/files") return { status: 200, json: { id: "created" } };
    if (u.searchParams.has("q")) return { status: 200, json: { files: [] } };
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });
  const id = await client().ensureRootFolder("My Vault");
  eq(id, "created", "returned id");
  const creates = seen.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/drive/v3/files");
  eq(creates.length, 1, "create requests");
});

void run().finally(() => setRequestUrlHandler(null));
