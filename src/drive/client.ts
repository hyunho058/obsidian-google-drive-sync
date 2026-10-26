import { RequestUrlResponse, requestUrl } from "obsidian";
import { AuthError, TokenManager } from "../auth/oauth";
import { baseOf, canonical, folderChain, isSafeVaultPath, joinPath, nfc } from "../util/paths";
import { DriveFile, FILE_FIELDS, FOLDER_MIME, RemoteEntry } from "./types";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/**
 * Files at or above this size go through a resumable upload. The iOS WebView
 * has a much tighter memory ceiling than desktop, and a single-shot multipart
 * body has to hold metadata plus the whole file in one contiguous buffer.
 */
const RESUMABLE_THRESHOLD = 4 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024; // must be a multiple of 256 KiB

export class DriveError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DriveError";
  }
}

function header(res: RequestUrlResponse, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function concatBytes(parts: Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out.buffer;
}

/**
 * The resumable upload session URI comes from a response header and then
 * receives the file's contents, so it is pinned to Google over TLS rather than
 * followed wherever it points.
 */
function assertGoogleEndpoint(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DriveError("Drive returned an unparseable upload session URI.", 0);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = host === "googleapis.com" || host.endsWith(".googleapis.com");
  if (parsed.protocol !== "https:" || !allowed) {
    throw new DriveError(`Refusing to upload to an unexpected host: ${parsed.origin}`, 0);
  }
}

/** Drive query strings are single-quoted; escape backslashes and quotes. */
function q(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DriveClient {
  /** vault-relative folder path -> Drive folder id. "" is the vault root. */
  private folderIds = new Map<string, string>();
  /**
   * In-flight folder resolutions, keyed by path. Uploads run in parallel, and
   * without this two files landing in the same new folder each create their own
   * copy of it.
   */
  private folderWaits = new Map<string, Promise<string>>();
  private rootId: string | null = null;

  constructor(
    private tokens: TokenManager,
    private log: { debug(...a: unknown[]): void; warn(...a: unknown[]): void },
  ) {}

  resetCache(): void {
    this.folderIds.clear();
    this.folderWaits.clear();
    this.rootId = null;
  }

  setRoot(id: string): void {
    this.rootId = id;
    this.folderIds.clear();
    this.folderWaits.clear();
    this.folderIds.set("", id);
  }

  getRoot(): string | null {
    return this.rootId;
  }

  // ---------------------------------------------------------------- transport

  private async call(opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    contentType?: string;
    binary?: boolean;
  }): Promise<RequestUrlResponse> {
    let attempt = 0;

    for (;;) {
      const token = await this.tokens.getAccessToken();
      const res = await requestUrl({
        url: opts.url,
        method: opts.method ?? "GET",
        headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
        body: opts.body,
        contentType: opts.contentType,
        throw: false,
      });

      // 308 is "resume incomplete" on a resumable upload, not an error.
      if (res.status < 400 || res.status === 308) return res;

      // A 401 means the cached access token went stale; drop it and retry once.
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        attempt++;
        continue;
      }

      // Google reports rate limiting as 403 with a specific reason. A plain 403
      // is a permission problem and retrying it just stalls for 30 seconds.
      const body = res.text ?? "";
      const throttled =
        res.status === 429 ||
        (res.status === 403 && /rateLimitExceeded|quotaExceeded|backendError/i.test(body));
      const retryable = throttled || res.status >= 500;
      if (retryable && attempt < 5) {
        const backoff = Math.min(16000, 2 ** attempt * 500) + Math.random() * 400;
        this.log.warn(`Drive ${res.status} on ${opts.method ?? "GET"} — retrying in ${Math.round(backoff)}ms`);
        await sleep(backoff);
        attempt++;
        continue;
      }

      let detail = "";
      try {
        detail = (res.json as { error?: { message?: string } })?.error?.message ?? res.text;
      } catch {
        detail = res.text;
      }
      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`Google Drive refused the request (${res.status}): ${detail}`, false);
      }
      throw new DriveError(`Google Drive request failed (${res.status}): ${detail}`, res.status);
    }
  }

  private async json<T>(opts: Parameters<DriveClient["call"]>[0]): Promise<T> {
    const res = await this.call(opts);
    return res.json as T;
  }

  // ------------------------------------------------------------------ folders

  /**
   * Finds or creates the vault's root folder. `drive.file` only exposes files
   * this OAuth client created, so this search reliably finds our own folder and
   * nothing else the user owns.
   */
  async ensureRootFolder(name: string): Promise<string> {
    if (this.rootId) return this.rootId;

    const safe = q(nfc(name));
    const found = await this.json<{ files: DriveFile[] }>({
      url:
        `${API}/files?q=${encodeURIComponent(
          `name='${safe}' and mimeType='${FOLDER_MIME}' and trashed=false and 'root' in parents`,
        )}&fields=${encodeURIComponent("files(id,name)")}&pageSize=10`,
    });

    const id = found.files?.[0]?.id ?? (await this.createFolder(nfc(name), "root"));
    this.setRoot(id);
    return id;
  }

  private async createFolder(name: string, parentId: string): Promise<string> {
    const created = await this.json<DriveFile>({
      url: `${API}/files?fields=id`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        name: nfc(name),
        mimeType: FOLDER_MIME,
        parents: [parentId],
        appProperties: { gdvs: "1" },
      }),
    });
    return created.id;
  }

  /** Resolves (creating as needed) the Drive folder for a vault-relative dir. */
  async ensureFolder(dirPath: string): Promise<string> {
    const dir = canonical(dirPath);
    const cached = this.folderIds.get(dir);
    if (cached) return cached;
    if (!this.rootId) throw new DriveError("Drive root folder is not configured.", 0);
    if (dir === "") return this.rootId;

    let parentId = this.rootId;
    let soFar = "";
    for (const segment of dir.split("/")) {
      soFar = joinPath(soFar, segment);
      parentId = await this.resolveChild(soFar, segment, parentId);
    }
    return parentId;
  }

  private resolveChild(fullPath: string, name: string, parentId: string): Promise<string> {
    const hit = this.folderIds.get(fullPath);
    if (hit) return Promise.resolve(hit);

    const pending = this.folderWaits.get(fullPath);
    if (pending) return pending;

    const work = (async () => {
      const res = await this.json<{ files: DriveFile[] }>({
        url:
          `${API}/files?q=${encodeURIComponent(
            `name='${q(nfc(name))}' and mimeType='${FOLDER_MIME}' and trashed=false and '${parentId}' in parents`,
          )}&fields=${encodeURIComponent("files(id,name)")}&pageSize=10`,
      });
      const id = res.files?.[0]?.id ?? (await this.createFolder(name, parentId));
      this.folderIds.set(fullPath, id);
      return id;
    })().finally(() => this.folderWaits.delete(fullPath));

    this.folderWaits.set(fullPath, work);
    return work;
  }

  // -------------------------------------------------------------------- listing

  /**
   * Lists everything the app can see in one paged sweep and reconstructs vault
   * paths from the parent graph. One request per 1000 files beats walking the
   * tree folder by folder, and it rebuilds the path map from scratch on a fresh
   * device.
   */
  async listTree(): Promise<{
    files: RemoteEntry[];
    folders: Map<string, string>;
    rejected: string[];
  }> {
    if (!this.rootId) throw new DriveError("Drive root folder is not configured.", 0);

    const all: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const url =
        `${API}/files?q=${encodeURIComponent("trashed=false")}` +
        `&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}` +
        `&pageSize=1000&spaces=drive` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const page = await this.json<{ files: DriveFile[]; nextPageToken?: string }>({ url });
      all.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    const byId = new Map<string, DriveFile>();
    for (const f of all) byId.set(f.id, f);

    // Resolve each node's path by walking up to the root folder.
    const pathCache = new Map<string, string | null>([[this.rootId, ""]]);
    const pathOf = (id: string): string | null => {
      const seen: string[] = [];
      let cur: string | undefined = id;
      let resolved: string | null = null;

      while (cur) {
        const cached = pathCache.get(cur);
        if (cached !== undefined) {
          resolved = cached;
          break;
        }
        const node = byId.get(cur);
        if (!node) return null; // parent is outside our scope
        seen.push(cur);
        cur = node.parents?.[0];
        if (seen.length > 256) return null; // cycle guard
      }
      if (resolved === null && cur !== this.rootId) {
        for (const id2 of seen) pathCache.set(id2, null);
        return null;
      }

      let acc = resolved ?? "";
      for (let i = seen.length - 1; i >= 0; i--) {
        const node = byId.get(seen[i]);
        if (!node) return null;
        acc = joinPath(acc, nfc(node.name));
        pathCache.set(seen[i], acc);
      }
      return acc;
    };

    const files: RemoteEntry[] = [];
    const folders = new Map<string, string>([["", this.rootId]]);
    const rejected: string[] = [];

    for (const f of all) {
      const p = pathOf(f.id);
      if (p === null || p === "") continue;
      // A Drive name containing `/` or `..` would escape the vault on write.
      if (!isSafeVaultPath(p)) {
        rejected.push(p);
        continue;
      }
      if (f.mimeType === FOLDER_MIME) {
        folders.set(p, f.id);
        continue;
      }
      files.push({
        path: p,
        id: f.id,
        md5: f.md5Checksum ?? null,
        size: f.size ? Number(f.size) : 0,
        modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
      });
    }

    this.folderIds = folders;
    return { files, folders, rejected };
  }

  // -------------------------------------------------------------------- changes

  /** Cheap "did anything change remotely?" poll, so a full sweep is only run when needed. */
  async getStartPageToken(): Promise<string> {
    const res = await this.json<{ startPageToken: string }>({
      url: `${API}/changes/startPageToken`,
    });
    return res.startPageToken;
  }

  async hasChangesSince(pageToken: string): Promise<{ changed: boolean; nextToken: string }> {
    let token = pageToken;
    let changed = false;

    for (;;) {
      const page = await this.json<{
        changes?: unknown[];
        nextPageToken?: string;
        newStartPageToken?: string;
      }>({
        url:
          `${API}/changes?pageToken=${encodeURIComponent(token)}` +
          `&fields=${encodeURIComponent("nextPageToken,newStartPageToken,changes(fileId,removed)")}` +
          `&pageSize=100&spaces=drive&includeRemoved=true`,
      });

      if ((page.changes?.length ?? 0) > 0) changed = true;
      if (page.newStartPageToken) return { changed, nextToken: page.newStartPageToken };
      if (!page.nextPageToken) return { changed, nextToken: token };
      token = page.nextPageToken;
    }
  }

  // -------------------------------------------------------------------- content

  async download(fileId: string): Promise<ArrayBuffer> {
    const res = await this.call({ url: `${API}/files/${fileId}?alt=media` });
    return res.arrayBuffer;
  }

  async trash(fileId: string): Promise<void> {
    await this.call({
      url: `${API}/files/${fileId}`,
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }

  async upload(opts: {
    path: string;
    data: ArrayBuffer;
    mime: string;
    fileId?: string;
  }): Promise<DriveFile> {
    const name = nfc(baseOf(opts.path));
    const parentId = opts.fileId ? null : await this.ensureFolder(folderChain(opts.path).join("/"));

    if (opts.data.byteLength >= RESUMABLE_THRESHOLD) {
      return this.resumableUpload({ ...opts, name, parentId });
    }
    return this.multipartUpload({ ...opts, name, parentId });
  }

  private async multipartUpload(opts: {
    name: string;
    data: ArrayBuffer;
    mime: string;
    fileId?: string;
    parentId: string | null;
  }): Promise<DriveFile> {
    const boundary = `gdvs${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const metadata: Record<string, unknown> = { name: opts.name, appProperties: { gdvs: "1" } };
    if (opts.parentId) metadata.parents = [opts.parentId];

    const enc = new TextEncoder();
    const body = concatBytes([
      enc.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${opts.mime}\r\n\r\n`,
      ),
      new Uint8Array(opts.data),
      enc.encode(`\r\n--${boundary}--\r\n`),
    ]);

    const url = opts.fileId
      ? `${UPLOAD}/${opts.fileId}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`
      : `${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`;

    return this.json<DriveFile>({
      url,
      method: opts.fileId ? "PATCH" : "POST",
      contentType: `multipart/related; boundary=${boundary}`,
      body,
    });
  }

  private async resumableUpload(opts: {
    name: string;
    data: ArrayBuffer;
    mime: string;
    fileId?: string;
    parentId: string | null;
  }): Promise<DriveFile> {
    const metadata: Record<string, unknown> = { name: opts.name, appProperties: { gdvs: "1" } };
    if (opts.parentId) metadata.parents = [opts.parentId];

    const initUrl = opts.fileId
      ? `${UPLOAD}/${opts.fileId}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`
      : `${UPLOAD}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`;

    const init = await this.call({
      url: initUrl,
      method: opts.fileId ? "PATCH" : "POST",
      contentType: "application/json",
      headers: {
        "X-Upload-Content-Type": opts.mime,
        "X-Upload-Content-Length": String(opts.data.byteLength),
      },
      body: JSON.stringify(metadata),
    });

    const session = header(init, "location");
    if (!session) throw new DriveError("Drive did not return a resumable upload session.", init.status);
    assertGoogleEndpoint(session);

    const total = opts.data.byteLength;
    let offset = 0;

    for (;;) {
      const end = Math.min(offset + CHUNK_SIZE, total);
      const chunk = opts.data.slice(offset, end);

      const res = await this.call({
        url: session,
        method: "PUT",
        headers: {
          "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
        },
        contentType: opts.mime,
        body: chunk,
      });

      if (res.status === 200 || res.status === 201) return res.json as DriveFile;

      if (res.status === 308) {
        const range = header(res, "range");
        // No Range header means the server has nothing yet; resend from offset.
        const confirmed = range ? Number(range.split("-")[1]) + 1 : offset;
        offset = Number.isFinite(confirmed) && confirmed > offset ? confirmed : end;
        if (offset >= total) return this.queryUploadStatus(session, total);
        continue;
      }

      throw new DriveError(`Resumable upload stalled (${res.status}).`, res.status);
    }
  }

  /**
   * Drive acknowledged every byte without returning the resource. An empty PUT
   * with `bytes *\/total` asks it for the final status; a new file has no id yet,
   * so the session URI is the only handle we have.
   */
  private async queryUploadStatus(session: string, total: number): Promise<DriveFile> {
    const res = await this.call({
      url: session,
      method: "PUT",
      headers: { "Content-Range": `bytes */${total}` },
    });
    if (res.status === 200 || res.status === 201) return res.json as DriveFile;
    throw new DriveError(`Resumable upload did not finalize (${res.status}).`, res.status);
  }
}
