import { Notice, Platform, Plugin, TAbstractFile, debounce } from "obsidian";
import { AuthError, Credentials, TokenManager, verifyCredentials } from "./auth/oauth";
import { CredentialStore } from "./auth/credential-store";
import { LinkPayload, encryptSetupToken } from "./auth/setup-token";
import { DriveClient } from "./drive/client";
import { DEFAULT_SETTINGS, Settings, effectiveExcludes } from "./settings";
import { SyncEngine, SyncReport, notifyReport, summarize } from "./sync/engine";
import { Logger, describeError } from "./util/log";
import { PathFilter, canonical } from "./util/paths";
import { GDriveSyncSettingTab } from "./ui/settings-tab";
import { ConfirmModal, CopyTokenModal, PasteTokenModal } from "./ui/modals";

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
  /** All reads and writes of the client secret and refresh token go through this. */
  credentialStore!: CredentialStore;

  private status: HTMLElement | null = null;
  private running = false;
  private rerunRequested = false;
  private localDirty = false;
  private scheduleSync!: ReturnType<typeof debounce>;
  private missingSignInNoticeShown = false;
  /**
   * sessionStorage key: the missing-sign-in notice is shown once per app
   * session, across plugin reloads. Per vault, so one vault's notice never
   * silences another's.
   */
  private missingNoticeKey(): string {
    return `gdrive-vault-sync:sign-in-missing-notice:${this.app.vault.getName()}`;
  }

  /**
   * Vault-relative folder this plugin was installed into. Obsidian reports it
   * on the manifest; the fallback matches Obsidian's own default layout.
   */
  pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    this.log = new Logger(() => this.settings.verbose);
    this.credentialStore = new CredentialStore(
      this.app.secretStorage,
      this.settings,
      () => this.saveSettings(),
      this.log,
    );
    try {
      await this.credentialStore.migrate();
    } catch {
      // The legacy copy stays in data.json and is still used; retried next start.
      this.log.warn("Couldn't move the sign-in to secure storage; will retry on the next start");
    }

    this.tokens = new TokenManager(() => this.credentials());
    this.drive = new DriveClient(this.tokens, this.log);
    this.engine = new SyncEngine(this.app.vault.adapter, this.drive, this.log);

    if (this.settings.rootFolderId) this.drive.setRoot(this.settings.rootFolderId);

    this.status = this.addStatusBarItem();
    this.setStatus(this.isLinked() ? "Drive: idle" : "Drive: not signed in");

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
      callback: () => this.copySetupToken(),
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
      this.warnIfSignInMissing();
      if (this.settings.autoSync && this.isLinked()) void this.syncNow("startup");
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
    return this.credentialStore.credentials();
  }

  isLinked(): boolean {
    return this.credentials() !== null;
  }

  /**
   * A device that was linked but has lost its credentials (e.g. app storage
   * cleared) says so once per session instead of silently not syncing. A
   * device that was never linked, or signed out, stays quiet.
   */
  private warnIfSignInMissing(): void {
    if (!this.settings.linked || this.isLinked() || this.missingSignInNoticeShown) return;
    this.missingSignInNoticeShown = true;
    try {
      if (window.sessionStorage.getItem(this.missingNoticeKey()) === "1") return;
      window.sessionStorage.setItem(this.missingNoticeKey(), "1");
    } catch {
      /* no session storage: the per-instance flag above still limits it */
    }
    new Notice(
      Platform.isDesktopApp
        ? "This device's sign-in is missing. Sign in again."
        : "This device's sign-in is missing. Paste a new setup token.",
      15000,
    );
  }

  // -------------------------------------------------------------- device setup

  /** Opens the copy window; the token is encrypted under a fresh one-time code each time. */
  copySetupToken(): void {
    const creds = this.credentials();
    if (!creds) {
      new Notice("Sign in on this device first.");
      return;
    }
    new CopyTokenModal(this.app, () =>
      encryptSetupToken({
        ...creds,
        folderId: this.settings.rootFolderId,
        folderName: this.settings.rootFolderName,
      }),
    ).open();
  }

  /** `onChanged` runs when the sign-in state may have changed (linked, or a failed save that unlinked), e.g. to redraw settings. */
  promptForSetupToken(onChanged?: () => void): void {
    new PasteTokenModal(this.app, (payload, isAborted) => this.linkDevice(payload, isAborted), onChanged).open();
  }

  /**
   * Commits a decrypted setup token. Google is asked first, with the new
   * credentials, so a bad token or no network never overwrites a working link.
   * Resolves false (having saved nothing) if the paste window was closed
   * meanwhile; throws `VerifyError` or `CredentialSaveError` having saved nothing.
   */
  async linkDevice(payload: LinkPayload, isAborted: () => boolean): Promise<boolean> {
    // The one slow store step (persisting a new id suffix) happens before the
    // abort check, so nothing is awaited between that check and the writes.
    await this.credentialStore.ensureIds();
    await verifyCredentials(payload);
    if (isAborted()) return false;

    try {
      await this.credentialStore.savePair(
        { clientSecret: payload.clientSecret, refreshToken: payload.refreshToken },
      () =>
        this.commitSettings(() => {
          this.settings.clientId = payload.clientId;
          this.settings.linked = true;
          if (payload.folderId) this.settings.rootFolderId = payload.folderId;
          if (payload.folderName) this.settings.rootFolderName = payload.folderName;
          // A new link means a new device: nothing is agreed on yet.
          this.settings.index = {};
          this.settings.changeToken = "";
        }),
      );
    } catch (e) {
      // A failed rollback may have unlinked the device; show what is true now.
      this.refreshStatus();
      throw e;
    }
    this.signInRestored();
    this.tokens.invalidate();
    this.drive.resetCache();
    if (this.settings.rootFolderId) this.drive.setRoot(this.settings.rootFolderId);

    new Notice("Device linked. Running the first sync…");
    void this.syncNow("link");
    return true;
  }

  /**
   * Applies `change` to the settings and saves. If the save fails, the
   * settings are put back as they were before rethrowing, so a caller that
   * restores secrets on failure (`savePair`'s commit) leaves everything as it was.
   */
  async commitSettings(change: () => void): Promise<void> {
    const before = JSON.parse(JSON.stringify(this.settings)) as Settings;
    change();
    try {
      await this.saveSettings();
    } catch (e) {
      Object.assign(this.settings, before);
      throw e;
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

  /** Forgets the refresh token only; the client ID and secret stay for signing in again. */
  async signOut(): Promise<void> {
    try {
      // data.json is saved as signed out before the stored token is cleared,
      // so a failure part-way can never sign the device back in on next start.
      await this.credentialStore.clearRefreshToken(() =>
        this.commitSettings(() => {
          this.settings.linked = false;
          this.settings.index = {};
          this.settings.changeToken = "";
        }),
      );
    } catch {
      new Notice("Couldn't sign out on this device. Try again.");
      return;
    }
    this.tokens.invalidate();
    this.drive.resetCache();
    this.setStatus("Drive: not signed in");
  }

  // ----------------------------------------------------------------- watchers

  private registerVaultWatchers(): void {
    const filter = () => new PathFilter(effectiveExcludes(this.settings, this.pluginDir(), this.app.vault.configDir));

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

  /** Re-derives the status bar text from the current sign-in state. */
  refreshStatus(): void {
    if (!this.isLinked()) this.setStatus("Drive: not signed in");
  }

  /** After a successful link or sign-in, a later loss of sign-in may be announced again. */
  signInRestored(): void {
    this.missingSignInNoticeShown = false;
    try {
      window.sessionStorage.removeItem(this.missingNoticeKey());
    } catch {
      /* nothing remembered */
    }
  }

  private setStatus(text: string): void {
    this.status?.setText(text);
  }

  async syncNow(reason: string): Promise<void> {
    if (!this.isLinked()) {
      this.warnIfSignInMissing();
      if (!this.settings.linked && (reason === "ribbon" || reason === "command")) {
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
        exclude: effectiveExcludes(this.settings, this.pluginDir(), this.app.vault.configDir),
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
