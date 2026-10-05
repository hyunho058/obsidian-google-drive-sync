import { App, ButtonComponent, Modal, Platform, Setting } from "obsidian";
import { CredentialSaveError } from "../auth/credential-store";
import { VerifyError } from "../auth/oauth";
import {
  CODE_LENGTH,
  LinkPayload,
  SetupTokenError,
  type TokenCheck,
  checkTokenStructure,
  decryptSetupToken,
  formatCode,
  looksLikeCode,
  normalizeCode,
} from "../auth/setup-token";
import { describeError } from "../util/log";

/**
 * Shows the encrypted token's one-time code, but only after the token itself is
 * on the clipboard. The copy runs in the button's own tap: WebKit can refuse a
 * clipboard write that happens after an `await` following the original tap,
 * and a code shown for a token that never got copied would only confuse.
 */
export class CopyTokenModal extends Modal {
  private result: { token: string; code: string } | null = null;
  private closed = false;
  private copyButton!: ButtonComponent;
  private errorEl!: HTMLElement;
  private codeEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    private makeToken: () => Promise<{ token: string; code: string }>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Copy setup token");
    contentEl.createEl("p", {
      text:
        "This makes an encrypted token for linking another device. Copy it, paste it on " +
        "the other device, then type the code that appears here.",
      cls: "setting-item-description",
    });
    const status = contentEl.createEl("p", { text: "Encrypting…", cls: "setting-item-description" });
    this.statusEl = status;

    new Setting(contentEl).addButton((b) => {
      this.copyButton = b;
      b.setButtonText("Copy token")
        .setCta()
        .setDisabled(true)
        .onClick(() => void this.copy());
    });
    this.errorEl = contentEl.createDiv({ cls: "gdvs-error" });
    this.codeEl = contentEl.createDiv();

    this.makeToken().then(
      (result) => {
        if (this.closed) return;
        this.result = result;
        status.setText("Ready. Tap Copy token.");
        this.copyButton.setDisabled(false);
      },
      (e) => {
        if (this.closed) return;
        status.setText("");
        this.errorEl.setText(`Couldn't create a setup token: ${describeError(e)}`);
      },
    );
  }

  private async copy(): Promise<void> {
    const result = this.result;
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.token);
    } catch {
      this.errorEl.setText("Couldn't copy the token — tap Copy token again");
      return;
    }
    if (this.closed) return;
    this.errorEl.setText("");
    this.statusEl.setText("Token copied. Paste it on your other device.");
    this.copyButton.setButtonText("Copy token again");
    this.codeEl.empty();
    this.codeEl.createEl("p", {
      text: "Type this code on your other device — it is not on the clipboard:",
    });
    this.codeEl.createDiv({ cls: "gdvs-code-display", text: formatCode(result.code) });
    new Setting(this.codeEl).addButton((b) => b.setButtonText("Done").onClick(() => this.close()));
  }

  onClose(): void {
    this.closed = true;
    this.result = null;
    this.contentEl.empty();
  }
}

/** Shown when the token box holds what is clearly the one-time code. */
const CODE_IN_TOKEN_BOX = "That looks like the code. Paste the setup token into box 1 and type the code into box 2.";
const CODE_MOVED = "That was the code, so it is now in box 2. Paste the setup token into box 1.";

/**
 * Takes a pasted token and its one-time code and owns the whole link attempt:
 * it decrypts, hands the payload to `link` (which verifies with Google and
 * saves), and closes only on success. Errors stay inside the window so a typo
 * in the code never costs the pasted token.
 */
export class PasteTokenModal extends Modal {
  private token = "";
  private code = "";
  private busy = false;
  /** Set on close; a link attempt still running afterwards must not save. */
  private aborted = false;
  /** The token box's last structural check, so focus moves on only once it becomes complete. */
  private lastTokenCheck: TokenCheck = "incomplete";
  private linkButton!: ButtonComponent;
  private tokenInput!: HTMLTextAreaElement;
  private codeInput!: HTMLInputElement;
  /** The window's only message area: under the Link button, above both boxes. */
  private errorEl!: HTMLElement;

  /**
   * @param link Verifies and saves the decrypted payload. Resolves true once
   *   saved, false if `isAborted()` turned true before saving. Throws
   *   `VerifyError` or `CredentialSaveError` on failure, having saved nothing.
   */
  constructor(
    app: App,
    private link: (payload: LinkPayload, isAborted: () => boolean) => Promise<boolean>,
    private onChanged?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Paste setup token");
    contentEl.createEl("p", {
      text:
        "On your other device, open this plugin's settings, choose 'Copy setup token' and " +
        "tap Copy token. Paste the token into box 1, then type the code it shows into box 2.",
      cls: "setting-item-description",
    });

    // The button and every message sit above both boxes, not below them: on a
    // phone the keyboard covers everything under the focused field.
    new Setting(contentEl).addButton((b) => {
      this.linkButton = b;
      b.setButtonText("Link this device")
        .setCta()
        .onClick(() => void this.submit());
    });
    this.errorEl = contentEl.createDiv({ cls: "gdvs-error" });

    contentEl.createEl("label", {
      text: "1. Setup token (paste it)",
      cls: "gdvs-input-label",
      attr: { for: "gdvs-paste-token" },
    });
    this.tokenInput = contentEl.createEl("textarea", {
      cls: "gdvs-token-input",
      attr: {
        id: "gdvs-paste-token",
        rows: "3",
        placeholder: "gdvs2:...",
        enterkeyhint: "next",
        autocapitalize: "off",
        autocorrect: "off",
        autocomplete: "off",
        spellcheck: "false",
      },
    });

    contentEl.createEl("label", {
      text: "2. Code from your other device (type it)",
      cls: "gdvs-input-label",
      attr: { for: "gdvs-paste-code" },
    });
    this.codeInput = contentEl.createEl("input", {
      cls: "gdvs-code-input",
      type: "text",
      attr: {
        id: "gdvs-paste-code",
        placeholder: "e.g. K7Q4-ZP9M",
        enterkeyhint: "go",
        autocapitalize: "characters",
        autocorrect: "off",
        autocomplete: "off",
        spellcheck: "false",
      },
    });

    this.tokenInput.addEventListener("input", (e) =>
      this.tokenChanged((e as InputEvent).inputType === "insertFromPaste"),
    );
    // Box 1 holds one token, so a paste replaces whatever is there (a code
    // typed by mistake, an earlier paste) instead of landing beside it and
    // reading as damaged. Without clipboard text the browser pastes as usual.
    this.tokenInput.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text || this.busy) return;
      e.preventDefault();
      this.tokenInput.value = text;
      this.tokenChanged(true);
    });
    // A token is one line, so Return moves to the code instead of a newline.
    this.tokenInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.codeInput.focus();
      }
    });

    this.codeInput.addEventListener("input", () => {
      this.code = this.codeInput.value;
      this.clearError();
      // Eight code characters (dashes and spaces aside) is the whole code.
      if (normalizeCode(this.code).length >= CODE_LENGTH) this.codeInput.blur();
    });
    this.codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });

    window.setTimeout(() => this.tokenInput.focus(), 0);
  }

  private tokenChanged(pasted: boolean): void {
    this.token = this.tokenInput.value;
    this.clearError();
    const check = checkTokenStructure(this.token);
    // A whole token needs nothing more typed: move on to the code when it
    // becomes complete or a new one is pasted, not on every later edit.
    if (check === "complete" && (this.lastTokenCheck !== "complete" || pasted)) this.moveToCode();
    else if (looksLikeCode(this.token)) this.showError(CODE_IN_TOKEN_BOX, this.tokenInput);
    else if (check === "old-token") this.showError(new SetupTokenError("old-token").message, this.tokenInput);
    this.lastTokenCheck = check;
  }

  /**
   * After a whole token arrives, go to the code box. iOS may ignore a focus()
   * that no tap started (suspected on 0.2.1: the keyboard stayed on the token
   * box and covered the code box), so close the keyboard first: if the focus
   * does not take, the labelled code box is at least in view.
   */
  private moveToCode(): void {
    this.tokenInput.blur();
    // A code already typed needs no keyboard: Link is next.
    if (normalizeCode(this.code).length < CODE_LENGTH) this.codeInput.focus();
  }

  private showError(message: string, input?: HTMLElement): void {
    this.errorEl.setText(message);
    input?.setAttr("aria-invalid", "true");
  }

  /**
   * Shows `message` and marks `input`. A phone closes its keyboard instead of
   * focusing the box: with the keyboard up the window scrolls to the focused
   * box, which can push the message above it out of sight.
   */
  private reject(message: string, input?: HTMLElement): void {
    this.showError(message, input);
    if (Platform.isMobile) (document.activeElement as HTMLElement | null)?.blur();
    else input?.focus();
  }

  private clearError(): void {
    this.errorEl.setText("");
    this.tokenInput.removeAttribute("aria-invalid");
    this.codeInput.removeAttribute("aria-invalid");
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    this.linkButton.setDisabled(on).setButtonText(on ? "Linking…" : "Link this device");
    this.tokenInput.readOnly = on;
    this.codeInput.readOnly = on;
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    this.clearError();
    // Say what is wrong with the token before asking for a code it may not
    // even have (an old token has none).
    if (looksLikeCode(this.token)) {
      // Into box 2 for them, unless something is typed there already.
      if (this.code.trim() !== "") {
        this.reject(CODE_IN_TOKEN_BOX, this.tokenInput);
        return;
      }
      this.code = this.codeInput.value = this.token.trim();
      this.token = this.tokenInput.value = "";
      this.lastTokenCheck = "incomplete";
      this.reject(CODE_MOVED, this.tokenInput);
      return;
    }
    const check = checkTokenStructure(this.token);
    if (check === "incomplete") {
      this.reject("Paste the whole setup token into box 1.", this.tokenInput);
      return;
    }
    if (check === "old-token" || check === "damaged") {
      this.reject(new SetupTokenError(check).message, this.tokenInput);
      return;
    }
    if (normalizeCode(this.code).length < CODE_LENGTH) {
      this.reject(`Type the ${CODE_LENGTH}-character code into box 2.`, this.codeInput);
      return;
    }
    this.setBusy(true);
    try {
      const payload = await decryptSetupToken(this.token, this.code);
      if (this.aborted) return;
      const saved = await this.link(payload, () => this.aborted);
      if (!saved) return;
      if (!this.aborted) this.close();
      // Saved is saved: refresh the caller even if the window was closed meanwhile.
      this.onChanged?.();
    } catch (e) {
      if (this.aborted) {
        // Closed meanwhile, but a failed save may still have unlinked the device.
        if (e instanceof CredentialSaveError) this.onChanged?.();
        return;
      }
      this.setBusy(false);
      if (e instanceof SetupTokenError && e.kind === "wrong-code") {
        this.code = "";
        this.codeInput.value = "";
        this.reject(e.message, this.codeInput);
      } else if (e instanceof SetupTokenError) {
        this.reject(e.message, this.tokenInput);
      } else if (e instanceof VerifyError) {
        this.reject(e.message);
      } else if (e instanceof CredentialSaveError) {
        this.reject(e.message);
        // A failed rollback may have unlinked the device: refresh the caller.
        this.onChanged?.();
      } else {
        this.reject(`Couldn't link this device: ${describeError(e)}`);
      }
    }
  }

  onClose(): void {
    this.aborted = true;
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private bodyText: string,
    private confirmLabel: string,
    private onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle(this.titleText);
    contentEl.createEl("p", { text: this.bodyText });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.confirmLabel)
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
