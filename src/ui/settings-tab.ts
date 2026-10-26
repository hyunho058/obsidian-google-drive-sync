import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type GDriveSyncPlugin from "../main";
import { runLoopbackFlow } from "../auth/loopback";
import { CredentialSaveError } from "../auth/credential-store";
import { describeError } from "../util/log";
import { effectiveExcludes } from "../settings";
import { MSG_ROOT_CHANGED } from "../drive/client";
import { FolderLinkPlan, MSG_SYNC_RUNNING, parseFolderRef, planFolderLink, rootProblem } from "../drive/folder-ref";

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
        "error. Because the client is your own and unverified, Google shows " +
        "\"Google hasn't verified this app\" when you sign in: choose Advanced, then " +
        "continue to your app.",
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
          "one, together with your sign-in, grants access to your whole Google Drive — keep it off shared vaults.",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.credentialStore.getClientSecret()).onChange(async (v) => {
          try {
            await this.plugin.credentialStore.setClientSecret(v.trim());
          } catch (e) {
            new Notice(e instanceof CredentialSaveError ? e.message : describeError(e));
            if (e instanceof CredentialSaveError) {
              // A failed rollback may have unlinked the device; show what is true now.
              this.plugin.refreshStatus();
              this.display();
            }
          }
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
          .setButtonText(this.plugin.isLinked() ? "Sign in again" : "Sign in")
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
              "plugin's settings and choose 'Copy setup token', then paste the token here " +
              "and type the code it shows.",
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
    if (!this.plugin.isLinked()) return;
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
    const clientId = this.plugin.settings.clientId;
    const clientSecret = this.plugin.credentialStore.getClientSecret();
    if (!clientId || !clientSecret) {
      new Notice("Enter the client ID and client secret first.");
      return;
    }

    new Notice("Opening your browser to sign in…");
    try {
      const { refreshToken } = await runLoopbackFlow({ clientId, clientSecret });
      try {
        // The settings save is the commit: if it fails, the previous sign-in is restored.
        await this.plugin.credentialStore.savePair({ clientSecret, refreshToken }, () =>
          this.plugin.commitSettings(() => {
            this.plugin.settings.linked = true;
            this.plugin.settings.index = {};
            this.plugin.settings.changeToken = "";
          }),
        );
      } catch (e) {
        if (!(e instanceof CredentialSaveError)) throw e;
        new Notice(e.message);
        this.plugin.refreshStatus();
        this.display();
        return;
      }
      this.plugin.signInRestored();
      this.plugin.tokens.invalidate();
      this.plugin.drive.resetCache();
      this.plugin.forgetVerifiedRoot();
      // A folder edit during this wait is not a failed sign-in; the sync below finds the new folder.
      await this.plugin.ensureRoot().catch((e: unknown) => {
        if (!(e instanceof Error && e.message === MSG_ROOT_CHANGED)) throw e;
      });
      new Notice("Signed in to Google Drive.");
      this.display();
      // The first sync verifies a folder pinned before sign-in; show its name or the old-sign-in hint.
      void this.plugin.syncNow("command").then(() => this.display());
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
        "Makes an encrypted token for linking another device. After you copy it, a " +
          "one-time code appears here; type it on the other device. The code never goes " +
          "to the clipboard, so a copied token is useless on its own.",
      )
      .addButton((b) =>
        b
          .setButtonText("Copy")
          .setDisabled(!this.plugin.isLinked())
          .onClick(() => this.plugin.copySetupToken()),
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

    const nameSetting = new Setting(root)
      .setName("Drive folder name")
      .addText((t) =>
        t.setValue(this.plugin.settings.rootFolderName).onChange(async (v) => {
          const name = v.trim();
          if (!name || name === this.plugin.settings.rootFolderName) return;
          this.plugin.settings.rootFolderName = name;
          // While a link is pinned the name is only kept for a later unpin; the root is unchanged.
          if (!this.plugin.settings.rootFolderLink) {
            this.plugin.settings.rootFolderId = "";
            this.plugin.settings.index = {};
            this.plugin.settings.changeToken = "";
            this.plugin.drive.resetCache();
            this.plugin.forgetVerifiedRoot();
          }
          await this.plugin.saveSettings();
        }),
      );
    const describeName = () =>
      nameSetting.setDesc(
        this.plugin.settings.rootFolderLink
          ? "Not used while a Drive folder link is set below. Clear the link to sync with this folder again."
          : "Folder created at the root of your Drive. Changing this starts a fresh remote copy.",
      );
    describeName();

    this.renderFolderLink(root, describeName);

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

  /**
   * The folder link commits on blur or Enter, never per keystroke: each
   * commit may ask Google about the folder and may reset the baseline.
   */
  private renderFolderLink(root: HTMLElement, describeName: () => void): void {
    const setting = new Setting(root).setName("Drive folder link or ID");

    const describe = (refusal: string | null) => {
      const s = this.plugin.settings;
      const desc = setting.descEl;
      desc.empty();
      if (refusal !== null) {
        desc.createDiv({ cls: "gdvs-error-text", text: refusal });
      } else if (s.rootFolderLinkName) {
        desc.createDiv({ text: `Linked to "${s.rootFolderLinkName}"` });
      } else if (s.rootFolderLink) {
        desc.createDiv({ text: "Will be checked at the first sync" });
      } else {
        desc.createDiv({
          text:
            "Paste a drive.google.com folder link to sync with a folder shared with you. " +
            "Leave empty to use the folder name above.",
        });
      }
      const hint = this.plugin.scopeHint();
      // A 404 refusal already ends with the hint.
      if (hint !== null && !(refusal ?? "").endsWith(hint)) desc.createDiv({ text: hint });
    };
    describe(null);

    setting.addText((t) => {
      t.setPlaceholder("https://drive.google.com/drive/folders/…").setValue(this.plugin.settings.rootFolderLink);
      const input = t.inputEl;
      input.addClass("gdvs-full-width");
      // Enter is followed by a blur when the user leaves the field; that blur
      // must not check (or refuse) the same text again. Enter itself may
      // retry, e.g. after a network failure.
      let lastCommitted: string | null = null;
      let busy = false;
      // A commit that arrives while a check is in flight runs once that check
      // ends, so text edited during the check is never silently left unsaved.
      let pending = false;
      const commit = async (retry: boolean): Promise<void> => {
        const text = input.value.trim();
        if (busy) {
          pending = true;
          return;
        }
        if (!retry && text === lastCommitted) return;
        lastCommitted = text;
        busy = true;
        try {
          const refusal = await this.commitFolderLink(text);
          describe(refusal);
          describeName();
        } finally {
          busy = false;
          if (pending) {
            pending = false;
            void commit(false);
          }
        }
      };
      input.addEventListener("input", () => {
        lastCommitted = null;
      });
      input.addEventListener("blur", () => void commit(false));
      input.addEventListener("keydown", (e) => {
        // isComposing: Enter that confirms an IME syllable is not a commit.
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          void commit(true);
        }
      });
    });
  }

  /** Decides and applies a committed folder link. Returns the refusal shown under the field, or null. */
  private async commitFolderLink(text: string): Promise<string | null> {
    const s = this.plugin.settings;
    const current = { rootFolderLink: s.rootFolderLink, rootFolderId: s.rootFolderId };
    const linked = this.plugin.isLinked();

    // Everything but "ask Google" is decided without a call: unchanged text,
    // unparseable text, an empty field, or no sign-in to ask with.
    let plan: FolderLinkPlan = planFolderLink(current, text, null, linked);
    if (plan.kind === "defer" && linked) {
      const id = plan.id;
      try {
        const inspection = await this.plugin.drive.inspectFolder(id);
        plan = planFolderLink(current, text, inspection, true);
      } catch (error) {
        plan = {
          kind: "refuse",
          message: rootProblem({ error }, false, this.plugin.scopeHint()) ?? "Couldn't check this folder.",
        };
      }
      // A setup token linked meanwhile replaced the root; this answer is about the old state.
      if (s.rootFolderLink !== current.rootFolderLink || s.rootFolderId !== current.rootFolderId) return null;
    }

    // Anything that moves the root waits for a running sync to finish; its index
    // describes the old folder and would otherwise be written over the new one.
    const movesRoot =
      plan.kind === "unpin" ||
      (plan.kind === "pin" && plan.resetBaseline) ||
      (plan.kind === "defer" && plan.id !== current.rootFolderId);
    if (movesRoot && this.plugin.isSyncing()) plan = { kind: "refuse", message: MSG_SYNC_RUNNING };

    try {
      switch (plan.kind) {
        case "noop":
          return null;
        case "refuse":
          new Notice(plan.message);
          return plan.message;
        case "pin": {
          const { id, name, resetBaseline } = plan;
          await this.plugin.commitSettings(() => {
            s.rootFolderLink = text;
            s.rootFolderId = id;
            s.rootFolderLinkName = name;
            if (resetBaseline) {
              s.index = {};
              s.changeToken = "";
            }
          });
          if (resetBaseline) {
            this.plugin.drive.resetCache();
            this.plugin.drive.setRoot(id);
          }
          // Verified just now; the next sync checks again anyway, which costs one call.
          this.plugin.forgetVerifiedRoot();
          return null;
        }
        case "unpin":
          await this.plugin.commitSettings(() => {
            s.rootFolderLink = "";
            s.rootFolderId = "";
            s.rootFolderLinkName = "";
            s.index = {};
            s.changeToken = "";
          });
          this.plugin.drive.resetCache();
          this.plugin.forgetVerifiedRoot();
          return null;
        case "defer": {
          const { id } = plan;
          // The folder already in use keeps its baseline, as a pin of it does (D2).
          const sameRoot = id === current.rootFolderId;
          await this.plugin.commitSettings(() => {
            s.rootFolderLink = text;
            s.rootFolderId = id;
            s.rootFolderLinkName = "";
            if (!sameRoot) {
              s.index = {};
              s.changeToken = "";
            }
          });
          if (!sameRoot) {
            this.plugin.drive.resetCache();
            this.plugin.drive.setRoot(id);
          }
          this.plugin.forgetVerifiedRoot();
          return null;
        }
      }
    } catch (e) {
      // The save failed and the settings were put back; the client was not touched.
      const message = `Couldn't save the folder: ${describeError(e)}`;
      new Notice(message);
      return message;
    }
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
