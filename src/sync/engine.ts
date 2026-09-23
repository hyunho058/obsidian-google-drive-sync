import { DataAdapter, Notice } from "obsidian";
import { DriveClient } from "../drive/client";
import { RemoteEntry } from "../drive/types";
import { md5 } from "../util/md5";
import { Logger, describeError } from "../util/log";
import {
  PathFilter,
  canonical,
  collisionKey,
  conflictPath,
  isSafeVaultPath,
  mimeFor,
} from "../util/paths";
import { IndexEntry, SyncIndex } from "./state";

export interface EngineOptions {
  deviceName: string;
  exclude: string[];
  maxFileBytes: number;
  /** Abort rather than apply a deletion wave larger than this fraction of the index. */
  deletionGuardRatio: number;
  concurrency: number;
}

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  skipped: string[];
  /** Remote names that could not be trusted as vault paths. */
  rejected: string[];
  errors: string[];
  aborted?: string;
}

interface LocalEntry {
  path: string;
  size: number;
  mtime: number;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

export class SyncEngine {
  /** Paths the engine is writing, so vault events do not re-trigger a sync. */
  readonly suppressed = new Set<string>();

  constructor(
    private adapter: DataAdapter,
    private drive: DriveClient,
    private log: Logger,
  ) {}

  async scanLocal(filter: PathFilter): Promise<Map<string, LocalEntry>> {
    const out = new Map<string, LocalEntry>();

    const walk = async (dir: string): Promise<void> => {
      const listing = await this.adapter.list(dir);

      for (const folder of listing.folders) {
        const p = canonical(folder);
        if (filter.excludes(p)) continue;
        await walk(p);
      }

      for (const file of listing.files) {
        const p = canonical(file);
        if (filter.excludes(p)) continue;
        const stat = await this.adapter.stat(p);
        if (!stat || stat.type !== "file") continue;
        out.set(p, { path: p, size: stat.size, mtime: stat.mtime });
      }
    };

    await walk("/");
    return out;
  }

  private async localHash(path: string): Promise<string> {
    const data = await this.adapter.readBinary(path);
    return md5(data);
  }

  async run(index: SyncIndex, opts: EngineOptions): Promise<{ report: SyncReport; index: SyncIndex }> {
    const filter = new PathFilter(opts.exclude);
    const report: SyncReport = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: [],
      skipped: [],
      rejected: [],
      errors: [],
    };

    const local = await this.scanLocal(filter);
    const { files, rejected } = await this.drive.listTree();
    report.rejected.push(...rejected);

    const remote = new Map<string, RemoteEntry>();
    const collisions = new Map<string, string>();
    for (const r of files) {
      if (filter.excludes(r.path)) continue;
      const key = collisionKey(r.path);
      const prior = collisions.get(key);
      if (prior && prior !== r.path) {
        // Two Drive files differing only by case cannot both exist on APFS.
        report.skipped.push(`${r.path} (case collision with ${prior})`);
        continue;
      }
      collisions.set(key, r.path);
      remote.set(r.path, r);
    }

    const next: SyncIndex = { ...index };
    const paths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(index)]);

    // --- deletion guard -----------------------------------------------------
    // A vault that vanished locally (wrong folder opened, iCloud not yet
    // hydrated) or a folder trashed in Drive would otherwise propagate as a
    // mass delete. Bail out and let a human look first.
    const indexed = Object.keys(index).length;
    if (indexed > 0) {
      let vanishedLocal = 0;
      let vanishedRemote = 0;
      for (const p of Object.keys(index)) {
        if (!local.has(p)) vanishedLocal++;
        if (!remote.has(p)) vanishedRemote++;
      }
      const limit = Math.max(10, Math.floor(indexed * opts.deletionGuardRatio));
      if (vanishedLocal > limit || vanishedRemote > limit) {
        const side = vanishedLocal > limit ? "locally" : "in Google Drive";
        const count = Math.max(vanishedLocal, vanishedRemote);
        report.aborted =
          `${count} of ${indexed} tracked files disappeared ${side}. Sync stopped without ` +
          `changing anything. If this was intentional, run "Reset sync state" and sync again.`;
        return { report, index };
      }
    }

    const tasks = [...paths].sort();

    await pool(tasks, opts.concurrency, async (path) => {
      try {
        await this.reconcile(path, { local, remote, index, next, report, opts });
      } catch (e) {
        this.log.error(`sync failed for ${path}:`, e);
        report.errors.push(`${path}: ${describeError(e)}`);
      }
    });

    return { report, index: next };
  }

  private async reconcile(
    path: string,
    ctx: {
      local: Map<string, LocalEntry>;
      remote: Map<string, RemoteEntry>;
      index: SyncIndex;
      next: SyncIndex;
      report: SyncReport;
      opts: EngineOptions;
    },
  ): Promise<void> {
    const { local, remote, index, next, report, opts } = ctx;
    const L = local.get(path);
    const R = remote.get(path);
    const B: IndexEntry | undefined = index[path];

    if (L && L.size > opts.maxFileBytes) {
      report.skipped.push(`${path} (${(L.size / 1048576).toFixed(1)} MB over the size limit)`);
      return;
    }
    if (R && R.size > opts.maxFileBytes) {
      report.skipped.push(`${path} (remote copy over the size limit)`);
      return;
    }

    // Both gone — the tombstone has served its purpose.
    if (!L && !R) {
      delete next[path];
      return;
    }

    // --- one side only ------------------------------------------------------
    if (L && !R) {
      if (!B) return this.upload(path, next, report);
      // Known to both before, now missing remotely: deleted there.
      const localMd5 = await this.localHash(path);
      if (localMd5 === B.md5) {
        await this.deleteLocal(path, next, report);
      } else {
        // Edited here since the last sync — re-upload rather than lose the edit.
        await this.upload(path, next, report);
      }
      return;
    }

    if (!L && R) {
      if (!B) return this.download(path, R, next, report);
      if (R.md5 && R.md5 === B.md5) {
        await this.deleteRemote(path, R, next, report);
      } else {
        // Changed remotely after being deleted here — bring it back.
        await this.download(path, R, next, report);
      }
      return;
    }

    if (!L || !R) return;

    // --- present on both ----------------------------------------------------
    const cheapUnchanged = B !== undefined && L.size === B.size && L.mtime === B.mtime;
    const localMd5 = cheapUnchanged ? B.md5 : await this.localHash(path);
    const remoteMd5 = R.md5;

    if (remoteMd5 && localMd5 === remoteMd5) {
      // Identical content; just make sure the index reflects reality.
      next[path] = { id: R.id, md5: localMd5, size: L.size, mtime: L.mtime };
      return;
    }

    const localChanged = !B || localMd5 !== B.md5;
    // Drive omits md5Checksum for its own native types; fall back to size so a
    // missing checksum does not read as "changed" on every pass.
    const remoteChanged = !B || (remoteMd5 ? remoteMd5 !== B.md5 : R.size !== B.size);

    if (localChanged && !remoteChanged) return this.upload(path, next, report);
    if (remoteChanged && !localChanged) return this.download(path, R, next, report);

    // Both sides moved and the content differs. Never merge Markdown silently:
    // keep this device's version beside the remote one and let the user decide.
    const side = conflictPath(path, opts.deviceName, new Date());
    const mine = await this.adapter.readBinary(path);

    this.suppressed.add(side);
    try {
      await this.adapter.writeBinary(side, mine);
    } finally {
      this.suppressed.delete(side);
    }

    await this.download(path, R, next, report);
    await this.upload(side, next, report);
    report.conflicts.push(side);
  }

  private async upload(path: string, next: SyncIndex, report: SyncReport): Promise<void> {
    const data = await this.adapter.readBinary(path);
    const existingId = next[path]?.id;
    const file = await this.drive.upload({
      path,
      data,
      mime: mimeFor(path),
      fileId: existingId,
    });
    const stat = await this.adapter.stat(path);
    next[path] = {
      id: file.id,
      md5: file.md5Checksum ?? md5(data),
      size: stat?.size ?? data.byteLength,
      mtime: stat?.mtime ?? Date.now(),
    };
    report.uploaded++;
    this.log.debug("uploaded", path);
  }

  private async download(
    path: string,
    remote: RemoteEntry,
    next: SyncIndex,
    report: SyncReport,
  ): Promise<void> {
    if (!isSafeVaultPath(path)) {
      throw new Error(`refusing to write an unsafe path from Drive: ${JSON.stringify(path)}`);
    }

    const data = await this.drive.download(remote.id);

    // Verify what arrived is what Drive said it had, before it touches the vault.
    const actual = md5(data);
    if (remote.md5 && actual !== remote.md5) {
      throw new Error(
        `checksum mismatch downloading ${path} (expected ${remote.md5}, got ${actual})`,
      );
    }

    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

    this.suppressed.add(path);
    try {
      // adapter.mkdir creates a single level, so walk the chain.
      let built = "";
      for (const segment of dir ? dir.split("/") : []) {
        built = built ? `${built}/${segment}` : segment;
        if (!(await this.adapter.exists(built))) await this.adapter.mkdir(built);
      }
      await this.adapter.writeBinary(path, data);
    } finally {
      this.suppressed.delete(path);
    }

    const stat = await this.adapter.stat(path);
    next[path] = {
      id: remote.id,
      md5: actual,
      size: stat?.size ?? data.byteLength,
      mtime: stat?.mtime ?? Date.now(),
    };
    report.downloaded++;
    this.log.debug("downloaded", path);
  }

  private async deleteLocal(path: string, next: SyncIndex, report: SyncReport): Promise<void> {
    this.suppressed.add(path);
    try {
      if (await this.adapter.exists(path)) await this.adapter.trashLocal(path);
    } finally {
      this.suppressed.delete(path);
    }
    delete next[path];
    report.deletedLocal++;
    this.log.debug("deleted locally", path);
  }

  private async deleteRemote(
    path: string,
    remote: RemoteEntry,
    next: SyncIndex,
    report: SyncReport,
  ): Promise<void> {
    await this.drive.trash(remote.id);
    delete next[path];
    report.deletedRemote++;
    this.log.debug("trashed remotely", path);
  }
}

export function summarize(report: SyncReport): string {
  if (report.aborted) return report.aborted;
  const bits: string[] = [];
  if (report.uploaded) bits.push(`${report.uploaded} up`);
  if (report.downloaded) bits.push(`${report.downloaded} down`);
  if (report.deletedRemote) bits.push(`${report.deletedRemote} removed remotely`);
  if (report.deletedLocal) bits.push(`${report.deletedLocal} removed locally`);
  if (report.conflicts.length) bits.push(`${report.conflicts.length} conflict(s)`);
  if (report.skipped.length) bits.push(`${report.skipped.length} skipped`);
  if (report.rejected.length) bits.push(`${report.rejected.length} unsafe name(s) blocked`);
  if (report.errors.length) bits.push(`${report.errors.length} error(s)`);
  return bits.length ? `Sync: ${bits.join(", ")}` : "Sync: already up to date";
}

export function notifyReport(report: SyncReport): void {
  new Notice(summarize(report), report.errors.length || report.aborted ? 10000 : 4000);
}
