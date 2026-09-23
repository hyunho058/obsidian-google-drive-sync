import { App, Modal, Setting } from "obsidian";

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

    const input = contentEl.createEl("textarea", {
      cls: "gdvs-token-input",
      attr: { rows: "6", placeholder: "gdvs1:..." },
    });
    input.addEventListener("input", () => {
      this.value = input.value;
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Link this device")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit(this.value);
        }),
    );

    window.setTimeout(() => input.focus(), 0);
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
