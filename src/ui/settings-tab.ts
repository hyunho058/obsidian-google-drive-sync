import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type GDriveSyncPlugin from "../main";
import { runLoopbackFlow } from "../auth/loopback";
import { describeError } from "../util/log";
import { effectiveExcludes } from "../settings";

export class GDriveSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: GDriveSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnection(containerEl);
    this.renderCredentials(containerEl);
    this.renderDevices(containerEl);
    this.renderSyncBehaviour(containerEl);
    this.renderScope(containerEl);
    this.renderAdvanced(containerEl);
  }

  private renderConnection(root: HTMLElement): void {
    const linked = this.plugin.isLinked();
    const last = this.plugin.settings.lastSync;

    new Setting(root)
      .setName("Status")
      .setDesc(
        linked
          ? `Linked. Last sync: ${last ? new Date(last).toLocaleString() : "never"}.`
          : "Not linked yet. Follow the setup steps below.",
      )
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .setDisabled(!linked)
          .onClick(() => void this.plugin.syncNow("command")),
      );
  }

  private renderCredentials(root: HTMLElement): void {
    if (!Platform.isDesktopApp) {
      this.renderMobileLink(root);
      return;
    }

    new Setting(root).setName("Google credentials").setHeading();

    const help = root.createEl("div", { cls: "setting-item-description" });
    help.createEl("p", {
      text:
        "Create your own OAuth client so no third-party server ever sees your notes. " +
        "In Google Cloud Console: enable the Drive API, then Credentials → Create " +
        "OAuth client ID → Application type: Desktop app.",
    });
    const warn = help.createEl("p");
    warn.createEl("strong", { text: "Important: " });
    warn.appendText(
      "set the OAuth consent screen to 'In production', not 'Testing'. Testing-mode " +
        "refresh tokens expire after 7 days and sync will break with an invalid_grant " +
        "error. The drive.file scope this plugin uses is non-sensitive, so publishing " +
        "needs no verification review.",
    );

    new Setting(root)
      .setName("Client ID")
      .addText((t) =>
        t
          .setPlaceholder("…apps.googleusercontent.com")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (v) => {
            this.plugin.settings.clientId = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Client secret")
      .setDesc(
        "Desktop-app client secrets are not treated as confidential by Google, but this " +
          "one still grants access to your Drive folder — keep it off shared vaults.",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.clientSecret).onChange(async (v) => {
          this.plugin.settings.clientSecret = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(root)
      .setName("Sign in with Google")
      .setDesc(
        "Opens your browser and listens on 127.0.0.1 for the redirect. Google rejects " +
          "obsidian:// redirects, so this step only works on desktop.",
      )
      .addButton((b) =>
        b
          .setButtonText(this.plugin.settings.refreshToken ? "Sign in again" : "Sign in")
          .setCta()
          .onClick(() => void this.signIn()),
      );

    this.renderSignOut(root);
  }

  /**
   * Phones cannot run the Google sign-in (no loopback listener), so the only way
   * in is a setup token from a desktop. The client ID and secret arrive inside
   * that token, so the fields for typing them are desktop-only.
   */
  private renderMobileLink(root: HTMLElement): void {
    new Setting(root).setName("Google account").setHeading();

    const linked = this.plugin.isLinked();
    new Setting(root)
      .setName(linked ? "Linked" : "Link this device")
      .setDesc(
        linked
          ? "This device syncs with your Google Drive folder. To link it again, paste a " +
              "new setup token."
          : "Phones cannot sign in to Google directly. On your computer, open this " +
              "plugin's settings and choose 'Copy setup token', then paste it here.",
      )
      .addButton((b) => {
        b.setButtonText(linked ? "Paste new token" : "Paste setup token").onClick(() =>
          this.plugin.promptForSetupToken(() => this.display()),
        );
        if (!linked) b.setCta();
      });

    this.renderSignOut(root);
  }

  private renderSignOut(root: HTMLElement): void {
    if (!this.plugin.settings.refreshToken) return;
    new Setting(root)
      .setName("Sign out")
      .setDesc("Clears the stored token on this device only.")
      .addButton((b) =>
        b
          .setButtonText("Sign out")
          .setWarning()
          .onClick(async () => {
            await this.plugin.signOut();
            this.display();
          }),
      );
  }

  private async signIn(): Promise<void> {
    const { clientId, clientSecret } = this.plugin.settings;
    if (!clientId || !clientSecret) {
      new Notice("Enter the client ID and client secret first.");
      return;
    }

    new Notice("Opening your browser to sign in…");
    try {
      const { refreshToken } = await runLoopbackFlow({ clientId, clientSecret });
      this.plugin.settings.refreshToken = refreshToken;
      this.plugin.settings.index = {};
      this.plugin.settings.changeToken = "";
      this.plugin.tokens.invalidate();
      this.plugin.drive.resetCache();
      await this.plugin.saveSettings();
      await this.plugin.ensureRoot();
      new Notice("Signed in to Google Drive.");
      this.display();
      void this.plugin.syncNow("command");
    } catch (e) {
      new Notice(`Sign-in failed: ${describeError(e)}`, 15000);
    }
  }

  private renderDevices(root: HTMLElement): void {
    new Setting(root).setName("Devices").setHeading();

    new Setting(root)
      .setName("Device name")
      .setDesc("Used to label conflict copies so two devices never write the same filename.")
      .addText((t) =>
        t.setValue(this.plugin.settings.deviceName).onChange(async (v) => {
          this.plugin.settings.deviceName = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Copy setup token")
      .setDesc(
        "Copies your credentials and refresh token as one string. It is encoded, not " +
          "encrypted — treat it like a password. It goes to the system clipboard, so " +
          "clipboard-history tools and Universal Clipboard may retain it; clear them " +
          "afterwards.",
      )
      .addButton((b) =>
        b
          .setButtonText("Copy")
          .setDisabled(!this.plugin.isLinked())
          .onClick(() => void this.plugin.copySetupToken()),
      );

    // On a phone this lives at the top of the page, where signing in would be.
    if (Platform.isDesktopApp) {
      new Setting(root)
        .setName("Paste setup token")
        .setDesc("Link this device using a token copied from another one.")
        .addButton((b) =>
          b.setButtonText("Paste").onClick(() => this.plugin.promptForSetupToken(() => this.display())),
        );
    }
  }

  private renderSyncBehaviour(root: HTMLElement): void {
    new Setting(root).setName("Sync").setHeading();

    new Setting(root)
      .setName("Drive folder name")
      .setDesc("Folder created at the root of your Drive. Changing this starts a fresh remote copy.")
      .addText((t) =>
        t.setValue(this.plugin.settings.rootFolderName).onChange(async (v) => {
          const name = v.trim();
          if (!name || name === this.plugin.settings.rootFolderName) return;
          this.plugin.settings.rootFolderName = name;
          this.plugin.settings.rootFolderId = "";
          this.plugin.settings.index = {};
          this.plugin.settings.changeToken = "";
          this.plugin.drive.resetCache();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Sync automatically")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSync).onChange(async (v) => {
          this.plugin.settings.autoSync = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Interval (minutes)")
      .addSlider((s) =>
        s
          .setLimits(1, 60, 1)
          .setValue(this.plugin.settings.intervalMinutes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.intervalMinutes = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Sync when Obsidian comes to the foreground")
      .setDesc(
        "iOS suspends apps in the background, so this is what makes the phone feel current " +
          "after you unlock it.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnFocus).onChange(async (v) => {
          this.plugin.settings.syncOnFocus = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Idle delay after an edit (seconds)")
      .setDesc("How long to wait after you stop typing before syncing.")
      .addSlider((s) =>
        s
          .setLimits(2, 120, 1)
          .setValue(this.plugin.settings.debounceSeconds)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.debounceSeconds = v;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderScope(root: HTMLElement): void {
    new Setting(root).setName("What gets synced").setHeading();

    new Setting(root)
      .setName(`Include the ${this.app.vault.configDir} settings folder`)
      .setDesc(
        "This plugin's own folder and per-device workspace layouts stay excluded either " +
          "way. Everything else is not: other plugins' data.json files, some of which " +
          "store API keys, are uploaded to Drive, and other plugins' code is synced too — " +
          "so any linked device can change the plugins running on every other one.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncConfigFolder).onChange(async (v) => {
          this.plugin.settings.syncConfigFolder = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Exclusions")
      .setDesc("One glob per line. Supports * and **; a trailing / matches a whole folder.")
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.inputEl.addClass("gdvs-full-width");
        t.setValue(this.plugin.settings.exclude.join("\n")).onChange(async (v) => {
          this.plugin.settings.exclude = v
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await this.plugin.saveSettings();
        });
      });

    const auto = effectiveExcludes(
      { ...this.plugin.settings, exclude: [] },
      this.plugin.pluginDir(),
      this.app.vault.configDir,
    );
    root.createEl("div", {
      cls: "setting-item-description",
      text: `Always excluded: ${auto.join(", ")}`,
    });
  }

  private renderAdvanced(root: HTMLElement): void {
    new Setting(root).setName("Advanced").setHeading();

    new Setting(root)
      .setName("Maximum file size (MB)")
      .setDesc(
        "Files above this are skipped. The iOS WebView has a much tighter memory ceiling " +
          "than desktop, so keep this modest on the phone.",
      )
      .addSlider((s) =>
        s
          .setLimits(5, 500, 5)
          .setValue(this.plugin.settings.maxFileMB)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxFileMB = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Parallel transfers")
      .addSlider((s) =>
        s
          .setLimits(1, 8, 1)
          .setValue(this.plugin.settings.concurrency)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.concurrency = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Deletion guard")
      .setDesc(
        "Stop the sync if more than this share of tracked files disappeared from one side. " +
          "Protects against a mass delete propagating.",
      )
      .addSlider((s) =>
        s
          .setLimits(5, 90, 5)
          .setValue(Math.round(this.plugin.settings.deletionGuardRatio * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.deletionGuardRatio = v / 100;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Verbose logging")
      .setDesc("Writes per-file detail to the developer console.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verbose).onChange(async (v) => {
          this.plugin.settings.verbose = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Reset sync state")
      .setDesc("Forget the agreed baseline and re-compare every file by content. Deletes nothing.")
      .addButton((b) =>
        b
          .setButtonText("Reset")
          .setWarning()
          .onClick(() => this.plugin.confirmResetState()),
      );
  }
}
