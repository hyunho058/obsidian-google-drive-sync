import { RequestUrlResponse, requestUrl } from "obsidian";
import { AuthError, TokenManager } from "../auth/oauth";
import { baseOf, canonical, folderChain, isSafeVaultPath, joinPath, nfc } from "../util/paths";
import { DriveFile, FILE_FIELDS, FOLDER_MIME, FolderInspection, GOOGLE_APPS_PREFIX, RemoteEntry } from "./types";

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

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Without these Google hides Shared Drive content even under full scope, so
 * every files and changes request carries them; lists also need the second.
 */
/** The sync root moved (pin, unpin, rename) while a sync was using it. */
export const MSG_ROOT_CHANGED = "The Drive folder changed during the sync; run it again.";

const ALL_DRIVES = "supportsAllDrives=true";
const ALL_DRIVES_LIST = "supportsAllDrives=true&includeItemsFromAllDrives=true";

/** One entry of the Drive change feed, as `hasChangesSince` requests it. */
export interface DriveChange {
  fileId?: string;
  removed?: boolean;
  file?: { id?: string; parents?: string[]; trashed?: boolean };
}

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
  /**
   * Until a walk completes the folder map holds only the root, so the change
   * probe cannot tell whether a change is inside the tree.
   */
  private listed = false;

  constructor(
    private tokens: TokenManager,
    private log: { debug(...a: unknown[]): void; warn(...a: unknown[]): void },
    private sleep: (ms: number) => Promise<void> = wait,
  ) {}

  resetCache(): void {
    // Replaced, not cleared: a finished walk hands this map to its caller.
    this.folderIds = new Map();
    this.folderWaits.clear();
    this.rootId = null;
    this.listed = false;
  }

  setRoot(id: string): void {
    this.rootId = id;
    this.folderIds = new Map([["", id]]);
    this.folderWaits.clear();
    this.listed = false;
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
      let token: string;
      try {
        token = await this.tokens.getAccessToken();
      } catch (e) {
        // A token-endpoint refusal carries the token endpoint's HTTP status.
        // Drop it, so an AuthError with status 403 always means Drive refused a
        // file or folder (D14) and never a failed token refresh.
        if (e instanceof AuthError && e.status !== undefined) throw new AuthError(e.message, e.fatal);
        throw e;
      }
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
        await this.sleep(backoff);
        attempt++;
        continue;
      }

      let detail = "";
      try {
        detail = (res.json as { error?: { message?: string } })?.error?.message ?? res.text;
      } catch {
        detail = res.text;
      }
      // A throttled 403 is not a permission refusal; keeping it out of AuthError
      // lets callers read `status === 403` as "not allowed" without the body.
      if (res.status === 401 || (res.status === 403 && !throttled)) {
        throw new AuthError(`Google Drive refused the request (${res.status}): ${detail}`, false, res.status);
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
   * Finds or creates the vault's root folder by name. The token can see the
   * user's whole Drive, so a folder that merely shares the vault's name must
   * not be adopted: the search only matches folders carrying the `gdvs`
   * appProperty that `createFolder` stamps, which only this OAuth client can
   * see. Two matches can only come from an earlier creation race; the oldest
   * is the one other devices already sync with.
   */
  async ensureRootFolder(name: string): Promise<string> {
    if (this.rootId) return this.rootId;

    const safe = q(nfc(name));
    const found = await this.json<{ files: DriveFile[] }>({
      url:
        `${API}/files?q=${encodeURIComponent(
          `name='${safe}' and mimeType='${FOLDER_MIME}' and trashed=false and 'root' in parents` +
            ` and appProperties has { key='gdvs' and value='1' }`,
        )}&fields=${encodeURIComponent("files(id,name,createdTime)")}` +
        `&orderBy=createdTime&pageSize=10&${ALL_DRIVES_LIST}`,
    });

    const matches = found.files ?? [];
    if (matches.length > 1) {
      this.log.warn(`Found ${matches.length} plugin folders with this name in Drive; using the oldest.`);
    }
    const id = matches[0]?.id ?? (await this.createFolder(nfc(name), "root"));
    this.setRoot(id);
    return id;
  }

  private async createFolder(name: string, parentId: string): Promise<string> {
    const created = await this.json<DriveFile>({
      url: `${API}/files?fields=id&${ALL_DRIVES}`,
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
          )}&fields=${encodeURIComponent("files(id,name)")}&pageSize=10&${ALL_DRIVES_LIST}`,
      });
      const id = res.files?.[0]?.id ?? (await this.createFolder(name, parentId));
      this.folderIds.set(fullPath, id);
      return id;
    })().finally(() => this.folderWaits.delete(fullPath));

    this.folderWaits.set(fullPath, work);
    return work;
  }

  /**
   * One `files.get` of a folder someone wants to sync with. Deliberately
   * uncached: the settings tab checks arbitrary ids and needs a fresh answer.
   */
  async inspectFolder(id: string): Promise<FolderInspection> {
    const f = await this.json<DriveFile & { capabilities?: { canAddChildren?: boolean } }>({
      url:
        `${API}/files/${encodeURIComponent(id)}` +
        `?fields=${encodeURIComponent("id,name,mimeType,trashed,capabilities(canAddChildren)")}&${ALL_DRIVES}`,
    });
    return {
      id: f.id,
      name: f.name,
      isFolder: f.mimeType === FOLDER_MIME,
      trashed: !!f.trashed,
      writable: f.capabilities?.canAddChildren === true,
    };
  }

  // -------------------------------------------------------------------- listing

  /** True once a walk has completed since the root was last set. */
  hasListed(): boolean {
    return this.listed;
  }

  knownFolderIds(): Set<string> {
    return new Set(this.folderIds.values());
  }

  /**
   * Walks the tree down from the root folder, breadth first. The token can see
   * the whole Drive, so sweeping everything and filtering would page through
   * the user's entire account. Any failed folder listing fails the walk: a
   * partial tree returned as success would read as remote deletions.
   */
  async listTree(concurrency = 4, expectedRoot?: string): Promise<{
    files: RemoteEntry[];
    folders: Map<string, string>;
    rejected: string[];
    unsupported: string[];
  }> {
    const rootId = this.rootId;
    if (!rootId) throw new DriveError("Drive root folder is not configured.", 0);
    // The caller's index belongs to the root it started with; listing another
    // folder against it would read every tracked file as deleted remotely.
    if (expectedRoot !== undefined && rootId !== expectedRoot) {
      throw new DriveError(MSG_ROOT_CHANGED, 0);
    }

    const files: RemoteEntry[] = [];
    const folders = new Map<string, string>([["", rootId]]);
    const rejected: string[] = [];
    const unsupported: string[] = [];
    const queue: { path: string; id: string }[] = [{ path: "", id: rootId }];

    const listFolder = async (dir: { path: string; id: string }): Promise<void> => {
      this.log.debug("listing folder", dir.path || "/");
      let pageToken: string | undefined;
      do {
        const url =
          `${API}/files?q=${encodeURIComponent(`'${q(dir.id)}' in parents and trashed=false`)}` +
          `&fields=${encodeURIComponent(`nextPageToken,incompleteSearch,files(${FILE_FIELDS})`)}` +
          `&pageSize=1000&${ALL_DRIVES_LIST}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
        const page = await this.json<{
          files?: DriveFile[];
          nextPageToken?: string;
          incompleteSearch?: boolean;
        }>({ url });
        // A partial page would read the missing files as deleted in Drive.
        if (page.incompleteSearch) {
          throw new DriveError("Google Drive returned an incomplete folder listing; nothing was changed. Try again.", 0);
        }

        for (const f of page.files ?? []) {
          const p = joinPath(dir.path, nfc(f.name));
          // A Drive name containing `/` or `..` would escape the vault on write;
          // nothing below such a folder is walked either.
          if (!isSafeVaultPath(p)) {
            rejected.push(p);
            continue;
          }
          if (f.mimeType === FOLDER_MIME) {
            folders.set(p, f.id);
            queue.push({ path: p, id: f.id });
            continue;
          }
          // Docs, Sheets and shortcuts have no bytes; `alt=media` would fail every sync.
          if (f.mimeType?.startsWith(GOOGLE_APPS_PREFIX)) {
            unsupported.push(p);
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
        pageToken = page.nextPageToken;
      } while (pageToken);
    };

    const limit = Math.max(1, Math.floor(concurrency) || 1);
    await new Promise<void>((resolve, reject) => {
      let active = 0;
      let failed = false;
      const pump = (): void => {
        if (failed) return;
        if (queue.length === 0 && active === 0) {
          resolve();
          return;
        }
        while (active < limit && queue.length > 0) {
          const next = queue.shift()!;
          active++;
          listFolder(next).then(
            () => {
              active--;
              pump();
            },
            (e) => {
              failed = true;
              reject(e);
            },
          );
        }
      };
      pump();
    });

    // A pin or unpin committed mid-walk: this map belongs to the old root.
    if (this.rootId !== rootId) {
      throw new DriveError(MSG_ROOT_CHANGED, 0);
    }
    this.folderIds = folders;
    this.listed = true;
    return { files, folders, rejected, unsupported };
  }

  // -------------------------------------------------------------------- changes

  /** Cheap "did anything change remotely?" poll, so a full sweep is only run when needed. */
  async getStartPageToken(): Promise<string> {
    const res = await this.json<{ startPageToken: string }>({
      url: `${API}/changes/startPageToken?${ALL_DRIVES}`,
    });
    return res.startPageToken;
  }

  /**
   * The feed covers the whole account, so `isRelevant` decides which changes
   * touch the synced tree. It sees every change, not just until the first hit.
   * Without a predicate any change counts, as before the scope widened.
   */
  async hasChangesSince(
    pageToken: string,
    isRelevant: (change: DriveChange) => boolean = () => true,
  ): Promise<{ changed: boolean; nextToken: string }> {
    this.log.debug("probing changes");
    let token = pageToken;
    let changed = false;

    const done = (nextToken: string) => {
      this.log.debug(changed ? "relevant change seen" : "no relevant changes");
      return { changed, nextToken };
    };

    for (;;) {
      const page = await this.json<{
        changes?: DriveChange[];
        nextPageToken?: string;
        newStartPageToken?: string;
      }>({
        url:
          `${API}/changes?pageToken=${encodeURIComponent(token)}` +
          `&fields=${encodeURIComponent(
            "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,parents,trashed))",
          )}` +
          `&pageSize=100&spaces=drive&includeRemoved=true&${ALL_DRIVES_LIST}`,
      });

      for (const change of page.changes ?? []) {
        if (isRelevant(change)) changed = true;
      }
      if (page.newStartPageToken) return done(page.newStartPageToken);
      if (!page.nextPageToken) return done(token);
      token = page.nextPageToken;
    }
  }

  // -------------------------------------------------------------------- content

  async download(fileId: string): Promise<ArrayBuffer> {
    const res = await this.call({ url: `${API}/files/${fileId}?alt=media&${ALL_DRIVES}` });
    return res.arrayBuffer;
  }

  async trash(fileId: string): Promise<void> {
    await this.call({
      url: `${API}/files/${fileId}?${ALL_DRIVES}`,
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
      ? `${UPLOAD}/${opts.fileId}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&${ALL_DRIVES}`
      : `${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&${ALL_DRIVES}`;

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
      ? `${UPLOAD}/${opts.fileId}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}&${ALL_DRIVES}`
      : `${UPLOAD}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}&${ALL_DRIVES}`;

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
