import { App, Modal, Setting } from "obsidian";
import { decodeSetupToken } from "../auth/setup-token";

function isCompleteToken(raw: string): boolean {
  try {
    decodeSetupToken(raw);
    return true;
  } catch {
    return false;
  }
}

export class PasteTokenModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private onSubmit: (token: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Paste setup token");
    contentEl.createEl("p", {
      text:
        "On your Mac, open this plugin's settings and choose 'Copy setup token'. " +
        "Paste it here to link this device.",
      cls: "setting-item-description",
    });

    // Above the box, not below it: on a phone the keyboard covers everything
    // under the text field, and a textarea gives iOS no key to dismiss it.
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Link this device")
        .setCta()
        .onClick(() => this.submit()),
    );

    const input = contentEl.createEl("textarea", {
      cls: "gdvs-token-input",
      attr: {
        rows: "4",
        placeholder: "gdvs1:...",
        enterkeyhint: "done",
        autocapitalize: "off",
        autocorrect: "off",
        spellcheck: "false",
      },
    });
    input.addEventListener("input", () => {
      this.value = input.value;
      // A whole token needs nothing more typed, so put the keyboard away.
      if (isCompleteToken(this.value)) input.blur();
    });
    // A token is one line, so Return can mean "done" instead of a newline.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });

    window.setTimeout(() => input.focus(), 0);
  }

  private submit(): void {
    this.close();
    this.onSubmit(this.value);
  }

  onClose(): void {
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
