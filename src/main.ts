import { Notice, Platform, Plugin, TAbstractFile, debounce } from "obsidian";
import { AuthError, Credentials, TokenManager } from "./auth/oauth";
import { decodeSetupToken, encodeSetupToken } from "./auth/setup-token";
import { DriveClient } from "./drive/client";
import { DEFAULT_SETTINGS, Settings, effectiveExcludes } from "./settings";
import { SyncEngine, SyncReport, notifyReport, summarize } from "./sync/engine";
import { Logger, describeError } from "./util/log";
import { PathFilter, canonical } from "./util/paths";
import { GDriveSyncSettingTab } from "./ui/settings-tab";
import { ConfirmModal, PasteTokenModal } from "./ui/modals";

function defaultDeviceName(): string {
  if (Platform.isIosApp) return "iPhone";
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isMacOS) return "Mac";
  if (Platform.isWin) return "Windows";
  return "Desktop";
}

export default class GDriveSyncPlugin extends Plugin {
  settings!: Settings;
  tokens!: TokenManager;
  drive!: DriveClient;
  engine!: SyncEngine;
  log!: Logger;

  private status: HTMLElement | null = null;
  private running = false;
  private rerunRequested = false;
  private localDirty = false;
  private scheduleSync!: ReturnType<typeof debounce>;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.log = new Logger(() => this.settings.verbose);
    this.tokens = new TokenManager(() => this.credentials());
    this.drive = new DriveClient(this.tokens, this.log);
    this.engine = new SyncEngine(this.app.vault.adapter, this.drive, this.log);

    if (this.settings.rootFolderId) this.drive.setRoot(this.settings.rootFolderId);

    this.status = this.addStatusBarItem();
    this.setStatus(this.settings.refreshToken ? "Drive: idle" : "Drive: not signed in");

    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => void this.syncNow("ribbon"));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow("command"),
    });

    this.addCommand({
      id: "paste-setup-token",
      name: "Paste setup token from another device",
      callback: () => this.promptForSetupToken(),
    });

    this.addCommand({
      id: "copy-setup-token",
      name: "Copy setup token for another device",
      callback: () => void this.copySetupToken(),
    });

    this.addCommand({
      id: "reset-sync-state",
      name: "Reset sync state (re-compare everything)",
      callback: () => this.confirmResetState(),
    });

    this.scheduleSync = debounce(
      () => void this.syncNow("auto"),
      Math.max(2, this.settings.debounceSeconds) * 1000,
      true,
    );

    this.registerVaultWatchers();
    this.registerForegroundSync();

    // Checked every minute; the interval setting decides whether it acts.
    this.registerInterval(
      window.setInterval(() => {
        if (!this.settings.autoSync) return;
        const due = this.settings.lastSync + this.settings.intervalMinutes * 60_000;
        if (Date.now() >= due) void this.syncNow("interval");
      }, 60_000),
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoSync && this.settings.refreshToken) void this.syncNow("startup");
    });
  }

  // ------------------------------------------------------------------ settings

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<Settings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
    if (!this.settings.deviceName) this.settings.deviceName = defaultDeviceName();
    if (!this.settings.rootFolderName) this.settings.rootFolderName = this.app.vault.getName();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  credentials(): Credentials | null {
    const { clientId, clientSecret, refreshToken } = this.settings;
    if (!clientId || !clientSecret || !refreshToken) return null;
    return { clientId, clientSecret, refreshToken };
  }

  isLinked(): boolean {
    return this.credentials() !== null;
  }

  // -------------------------------------------------------------- device setup

  async copySetupToken(): Promise<void> {
    const creds = this.credentials();
    if (!creds) {
      new Notice("Sign in on this device first.");
      return;
    }
    const token = encodeSetupToken({
      v: 1,
      ...creds,
      folderId: this.settings.rootFolderId,
      folderName: this.settings.rootFolderName,
    });
    await navigator.clipboard.writeText(token);
    new Notice("Setup token copied. Paste it into this plugin's settings on your other device.");
  }

  promptForSetupToken(): void {
    new PasteTokenModal(this.app, (raw) => void this.applySetupToken(raw)).open();
  }

  async applySetupToken(raw: string): Promise<void> {
    try {
      const payload = decodeSetupToken(raw);
      this.settings.clientId = payload.clientId;
      this.settings.clientSecret = payload.clientSecret;
      this.settings.refreshToken = payload.refreshToken;
      if (payload.folderId) this.settings.rootFolderId = payload.folderId;
      if (payload.folderName) this.settings.rootFolderName = payload.folderName;
      // A new link means a new device: nothing is agreed on yet.
      this.settings.index = {};
      this.settings.changeToken = "";
      this.tokens.invalidate();
      this.drive.resetCache();
      if (this.settings.rootFolderId) this.drive.setRoot(this.settings.rootFolderId);
      await this.saveSettings();

      await this.tokens.getAccessToken();
      new Notice("Device linked. Running the first sync…");
      await this.syncNow("link");
    } catch (e) {
      new Notice(describeError(e), 12000);
      this.log.error("setup token failed", e);
    }
  }

  confirmResetState(): void {
    new ConfirmModal(
      this.app,
      "Reset sync state?",
      "This forgets what the last agreed state was and re-compares every file against " +
        "Google Drive by content. Nothing is deleted. Files that differ on both sides " +
        "will produce conflict copies.",
      "Reset",
      () => {
        this.settings.index = {};
        this.settings.changeToken = "";
        void this.saveSettings().then(() => new Notice("Sync state reset."));
      },
    ).open();
  }

  async signOut(): Promise<void> {
    this.settings.refreshToken = "";
    this.settings.index = {};
    this.settings.changeToken = "";
    this.tokens.invalidate();
    this.drive.resetCache();
    await this.saveSettings();
    this.setStatus("Drive: not signed in");
  }

  // ----------------------------------------------------------------- watchers

  private registerVaultWatchers(): void {
    const filter = () => new PathFilter(effectiveExcludes(this.settings));

    const touched = (file: TAbstractFile | string) => {
      const path = canonical(typeof file === "string" ? file : file.path);
      if (this.engine.suppressed.has(path)) return;
      if (filter().excludes(path)) return;
      this.localDirty = true;
      if (this.settings.autoSync && this.isLinked()) this.scheduleSync();
    };

    this.registerEvent(this.app.vault.on("create", touched));
    this.registerEvent(this.app.vault.on("modify", touched));
    this.registerEvent(this.app.vault.on("delete", touched));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        touched(file);
        touched(oldPath);
      }),
    );
  }

  /**
   * iOS suspends the app, so nothing runs in the background. Syncing when the
   * app returns to the foreground is the closest equivalent.
   */
  private registerForegroundSync(): void {
    const onForeground = () => {
      if (!this.settings.syncOnFocus || !this.settings.autoSync) return;
      if (!this.isLinked()) return;
      if (Date.now() - this.settings.lastSync < 15_000) return;
      void this.syncNow("foreground");
    };

    this.registerDomEvent(window, "focus", onForeground);
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) onForeground();
    });
  }

  // --------------------------------------------------------------------- sync

  private setStatus(text: string): void {
    this.status?.setText(text);
  }

  async syncNow(reason: string): Promise<void> {
    if (!this.isLinked()) {
      if (reason === "ribbon" || reason === "command") {
        new Notice("Not signed in to Google Drive yet — open the plugin settings.");
      }
      return;
    }

    if (this.running) {
      this.rerunRequested = true;
      return;
    }

    this.running = true;
    this.setStatus("Drive: syncing…");
    this.log.debug("sync started", { reason });

    try {
      await this.ensureRoot();

      // Cheap probe first: if nothing changed on either side, skip the sweep.
      const explicit = reason === "ribbon" || reason === "command" || reason === "link";
      if (!explicit && !this.localDirty && this.settings.changeToken) {
        const probe = await this.drive.hasChangesSince(this.settings.changeToken);
        this.settings.changeToken = probe.nextToken;
        if (!probe.changed) {
          this.settings.lastSync = Date.now();
          await this.saveSettings();
          this.setStatus("Drive: up to date");
          return;
        }
      }

      const wasDirty = this.localDirty;
      this.localDirty = false;

      const { report, index } = await this.engine.run(this.settings.index, {
        deviceName: this.settings.deviceName,
        exclude: effectiveExcludes(this.settings),
        maxFileBytes: Math.max(1, this.settings.maxFileMB) * 1024 * 1024,
        deletionGuardRatio: this.settings.deletionGuardRatio,
        concurrency: Math.max(1, this.settings.concurrency),
      });

      if (report.aborted) {
        this.localDirty = wasDirty;
        new Notice(report.aborted, 15000);
        this.setStatus("Drive: stopped");
        return;
      }

      this.settings.index = index;
      this.settings.lastSync = Date.now();
      // Re-baseline so this run's own writes are not seen as remote changes.
      this.settings.changeToken = await this.drive.getStartPageToken();
      await this.saveSettings();

      this.reportOutcome(report, explicit);
      this.setStatus(`Drive: ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      this.localDirty = true;
      this.setStatus("Drive: error");
      this.log.error("sync failed", e);
      const fatal = e instanceof AuthError && e.fatal;
      new Notice(`Google Drive sync failed: ${describeError(e)}`, fatal ? 20000 : 8000);
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.syncNow("queued");
      }
    }
  }

  private reportOutcome(report: SyncReport, explicit: boolean): void {
    const changed =
      report.uploaded + report.downloaded + report.deletedLocal + report.deletedRemote > 0;
    if (explicit || changed || report.errors.length || report.conflicts.length) {
      notifyReport(report);
    }
    this.log.debug(summarize(report), report);
    for (const c of report.conflicts) this.log.info("conflict copy kept at", c);
    for (const s of report.skipped) this.log.info("skipped", s);
    for (const err of report.errors) this.log.warn(err);
  }

  async ensureRoot(): Promise<void> {
    if (this.drive.getRoot()) return;
    const id = this.settings.rootFolderId
      ? this.settings.rootFolderId
      : await this.drive.ensureRootFolder(this.settings.rootFolderName);
    this.drive.setRoot(id);
    if (this.settings.rootFolderId !== id) {
      this.settings.rootFolderId = id;
      await this.saveSettings();
    }
  }
}
