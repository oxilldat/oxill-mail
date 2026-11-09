import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";

import type OxillMailPlugin from "./main";
import { t } from "./i18n";
import type { ConnectionState, MailAccount, OxillMailSettings } from "./types";

export const DEFAULT_SETTINGS: OxillMailSettings = { language: "ru", accounts: [], fallbackSyncMinutes: 5 };

export class MailSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly mailPlugin: OxillMailPlugin) { super(app, mailPlugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("oxm-settings");

    new Setting(containerEl).setName(t("Почтовые аккаунты", "Mail accounts"))
      .setHeading().addButton((button) => button.setButtonText(t("Добавить аккаунт", "Add account")).setIcon("plus").setCta().onClick(() => this.openAccountModal()));
    const accountList = containerEl.createDiv({ cls: "oxm-account-list" });
    if (this.mailPlugin.settings.accounts.length === 0) this.renderEmptyAccounts(accountList);
    for (const account of this.mailPlugin.settings.accounts) this.renderAccount(accountList, account);

    new Setting(containerEl).setName(t("Поведение", "Behavior"))
      .setHeading();
    new Setting(containerEl).setName(t("Язык интерфейса", "Interface language"))
      .setDesc(t("Применяется к настройкам и почтовому представлению.", "Applies to settings and the mail view."))
      .addDropdown((dropdown) => dropdown.addOption("ru", "Русский").addOption("en", "English")
        .setValue(this.mailPlugin.settings.language).onChange(async (value) => {
          this.mailPlugin.settings.language = value === "en" ? "en" : "ru";
          await this.mailPlugin.saveSettings();
          this.display();
        }));
    new Setting(containerEl).setName(t("Резервная проверка почты", "Fallback mail check"))
      .setDesc(t("Страховочная синхронизация, если сервер не прислал событие IMAP IDLE.", "Fallback sync when the server misses an IMAP IDLE event."))
      .addDropdown((dropdown) => {
        for (const minutes of [1, 2, 5, 10, 15]) dropdown.addOption(String(minutes), t(`${minutes} мин`, `${minutes} min`));
        dropdown.setValue(String(this.mailPlugin.settings.fallbackSyncMinutes)).onChange(async (value) => {
          this.mailPlugin.settings.fallbackSyncMinutes = Number(value);
          await this.mailPlugin.saveSettings();
        });
      });
  }

  private renderEmptyAccounts(container: HTMLElement): void {
    const empty = container.createDiv({ cls: "oxm-account-empty" });
    setIcon(empty.createSpan(), "mail-plus");
    empty.createDiv({ cls: "oxm-account-empty-title", text: t("Почта ещё не подключена", "No mailbox connected") });
    empty.createEl("p", { text: t("Добавьте первый почтовый аккаунт.", "Add your first mail account.") });
  }

  private renderAccount(container: HTMLElement, account: MailAccount): void {
    const state = this.mailPlugin.getAccountState(account.id);
    const card = container.createDiv({ cls: `oxm-account-card is-${state}` });
    const identity = card.createDiv({ cls: "oxm-account-identity" });
    identity.createSpan({ cls: "oxm-account-avatar", text: (account.name || account.email || "?").slice(0, 1).toLocaleUpperCase() });
    const copy = identity.createDiv({ cls: "oxm-account-copy" });
    copy.createDiv({ cls: "oxm-account-name", text: account.name || account.email || t("Без названия", "Untitled") });
    copy.createDiv({ cls: "oxm-account-email", text: account.email || t("Адрес не указан", "No address") });
    const statusState = account.enabled ? state : "disabled";
    const status = identity.createEl("button", {
      cls: `oxm-account-status is-${statusState}`,
      attr: {
        type: "button",
        "aria-pressed": String(account.enabled),
        "aria-label": account.enabled ? t("Отключить аккаунт", "Disable account") : t("Включить аккаунт", "Enable account"),
        title: account.enabled ? t("Отключить аккаунт", "Disable account") : t("Включить аккаунт", "Enable account"),
      },
    });
    status.createSpan({ cls: "oxm-account-status-dot" });
    status.createSpan({ text: this.stateLabel(state, account.enabled) });
    status.addEventListener("click", async () => {
      status.disabled = true;
      const enabling = !account.enabled;
      account.enabled = enabling;
      await this.mailPlugin.saveSettings();
      await this.mailPlugin.restartMailService(enabling ? () => this.display() : undefined);
      this.display();
    });
    const meta = card.createDiv({ cls: "oxm-account-meta" });
    this.metaItem(meta, "server", "IMAP", `${account.imapHost.trim()}:${account.imapPort}`);
    this.metaItem(meta, "send", "SMTP", `${account.smtpHost.trim()}:${account.smtpPort}`);
    const actions = card.createDiv({ cls: "oxm-account-actions" });
    actions.createEl("button", { text: t("Изменить", "Edit") }).addEventListener("click", () => this.openAccountModal(account));
    const remove = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Удалить аккаунт", "Delete account") } });
    setIcon(remove, "trash-2");
    remove.addEventListener("click", () => new DeleteAccountModal(this.app, account, async () => {
      this.app.secretStorage.setSecret(account.secretId, "");
      this.mailPlugin.settings.accounts = this.mailPlugin.settings.accounts.filter((item) => item.id !== account.id);
      await this.mailPlugin.saveSettings();
      await this.mailPlugin.restartMailService();
      this.display();
    }).open());
  }

  private metaItem(container: HTMLElement, iconName: string, label: string, value: string): void {
    const item = container.createDiv({ cls: "oxm-account-meta-item" });
    setIcon(item.createSpan(), iconName);
    const copy = item.createDiv();
    copy.createSpan({ cls: "oxm-account-meta-label", text: label });
    copy.createSpan({ cls: "oxm-account-meta-value", text: value });
  }

  private openAccountModal(account?: MailAccount): void {
    new AccountModal(this.app, account, async (next) => {
      const index = this.mailPlugin.settings.accounts.findIndex((item) => item.id === next.id);
      if (index >= 0) this.mailPlugin.settings.accounts[index] = next;
      else this.mailPlugin.settings.accounts.push(next);
      await this.mailPlugin.saveSettings();
      await this.mailPlugin.restartMailService();
      this.display();
    }).open();
  }

  private stateLabel(state: ConnectionState, enabled: boolean): string {
    if (!enabled) return t("Выключен", "Disabled");
    if (state === "online") return t("В сети", "Online");
    if (state === "connecting") return t("Подключение", "Connecting");
    if (state === "error") return t("Ошибка", "Error");
    return t("Не в сети", "Offline");
  }
}

class AccountModal extends Modal {
  private readonly draft: MailAccount;
  private password = "";
  private readonly hasStoredPassword: boolean;
  private errorEl?: HTMLElement;

  constructor(
    app: App,
    account: MailAccount | undefined,
    private readonly onSave: (account: MailAccount) => Promise<void>,
  ) {
    super(app);
    const id = account?.id ?? crypto.randomUUID();
    this.draft = account ? { ...account } : { id, name: "", email: "", username: "", imapHost: "", imapPort: 0, smtpHost: "", smtpPort: 0, secretId: `oxill-mail-${id.toLowerCase()}`, enabled: true };
    this.hasStoredPassword = Boolean(this.app.secretStorage.getSecret(this.draft.secretId));
  }

  onOpen(): void {
    this.modalEl.addClass("oxm-account-modal");
    this.titleEl.empty();
    this.render();
  }
  onClose(): void { this.contentEl.empty(); }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    this.text(container, t("Название", "Name"), t("Например, Рабочая почта", "For example, Work mail"), this.draft.name, (value) => { this.draft.name = value; });
    this.text(container, "Email", "name@example.com", this.draft.email, (value) => {
      const oldEmail = this.draft.email;
      this.draft.email = value;
      if (!this.draft.username || this.draft.username === oldEmail) this.draft.username = value;
    }, "email");
    this.text(container, t("Логин", "Username"), t("Обычно совпадает с полным email", "Usually the full email address"), this.draft.username, (value) => { this.draft.username = value; });
    new Setting(container).setName(t("Пароль приложения", "App password")).addText((input) => {
      input.inputEl.type = "password";
      input.inputEl.autocomplete = "new-password";
      input.setPlaceholder(this.hasStoredPassword ? t("Пароль сохранён", "Password saved") : t("Введите пароль приложения", "Enter app password"));
      input.onChange((value) => { this.password = value; });
    });
    this.serverRow(container, "IMAP", this.draft.imapHost, this.draft.imapPort, (host, port) => { this.draft.imapHost = host; this.draft.imapPort = port; });
    this.serverRow(container, "SMTP", this.draft.smtpHost, this.draft.smtpPort, (host, port) => { this.draft.smtpHost = host; this.draft.smtpPort = port; });
    this.errorEl = container.createDiv({ cls: "oxm-form-error" });
    const actions = container.createDiv({ cls: "oxm-modal-actions" });
    actions.createEl("button", { text: t("Отмена", "Cancel") }).addEventListener("click", () => this.close());
    actions.createEl("button", { cls: "mod-cta", text: t("Сохранить", "Save") }).addEventListener("click", () => void this.submit());
  }

  private text(container: HTMLElement, name: string, placeholder: string, value: string, update: (value: string) => void, type: "text" | "email" = "text"): void {
    new Setting(container).setName(name).addText((text) => {
      text.inputEl.type = type;
      text.setPlaceholder(placeholder).setValue(value).onChange(update);
    });
  }

  private serverRow(container: HTMLElement, label: string, host: string, port: number, update: (host: string, port: number) => void): void {
    let currentHost = host;
    let currentPort = port;
    const row = new Setting(container).setName(label);
    row.settingEl.addClass("oxm-server-row");
    row.addText((text) => text.setPlaceholder(`${label.toLocaleLowerCase()}.example.com`).setValue(host).onChange((value) => { currentHost = value; update(currentHost, currentPort); }));
    row.addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "1";
      text.inputEl.max = "65535";
      text.setPlaceholder(t("Порт", "Port")).setValue(port > 0 ? String(port) : "").onChange((value) => { currentPort = Number(value); update(currentHost, currentPort); });
    });
  }

  private async submit(): Promise<void> {
    this.cleanDraft();
    const error = this.validate();
    if (error) {
      this.errorEl?.setText(error);
      this.errorEl?.addClass("is-visible");
      return;
    }
    try {
      if (this.password) this.app.secretStorage.setSecret(this.draft.secretId, this.password);
      await this.onSave({ ...this.draft });
      new Notice(t("Аккаунт сохранён. Подключаемся к серверу…", "Account saved. Connecting to the server…"));
      this.close();
    } catch (error) {
      this.errorEl?.setText(error instanceof Error ? error.message : t("Не удалось сохранить аккаунт", "Could not save the account"));
      this.errorEl?.addClass("is-visible");
    }
  }

  private cleanDraft(): void {
    this.draft.name = this.draft.name.trim(); this.draft.email = this.draft.email.trim(); this.draft.username = this.draft.username.trim();
    this.draft.imapHost = this.draft.imapHost.trim(); this.draft.smtpHost = this.draft.smtpHost.trim();
  }

  private validate(): string | undefined {
    if (!this.draft.email || !/^\S+@\S+\.\S+$/.test(this.draft.email)) return t("Введите корректный email.", "Enter a valid email address.");
    if (!this.draft.username) return t("Укажите логин.", "Enter a username.");
    if (!this.password && !this.hasStoredPassword) return t("Введите пароль приложения.", "Enter an app password.");
    if (!this.draft.imapHost || !this.validPort(this.draft.imapPort)) return t("Проверьте адрес и порт IMAP.", "Check the IMAP host and port.");
    if (!this.draft.smtpHost || !this.validPort(this.draft.smtpPort)) return t("Проверьте адрес и порт SMTP.", "Check the SMTP host and port.");
    return undefined;
  }
  private validPort(port: number): boolean { return Number.isInteger(port) && port > 0 && port <= 65535; }
}

class DeleteAccountModal extends Modal {
  constructor(app: App, private readonly account: MailAccount, private readonly onConfirm: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("oxm-delete-account-modal");
    this.titleEl.setText(t("Удалить почтовый аккаунт?", "Delete mail account?"));
    this.contentEl.createEl("p", { text: t(`Аккаунт «${this.account.name || this.account.email}» будет удалён из Oxill Mail. Письма на сервере не изменятся.`, `“${this.account.name || this.account.email}” will be removed from Oxill Mail. Messages on the server will not be changed.`) });
    const actions = this.contentEl.createDiv({ cls: "oxm-modal-actions" });
    actions.createEl("button", { text: t("Отмена", "Cancel") }).addEventListener("click", () => this.close());
    actions.createEl("button", { cls: "mod-warning", text: t("Удалить", "Delete") }).addEventListener("click", () => void this.remove());
  }
  onClose(): void { this.contentEl.empty(); }
  private async remove(): Promise<void> { await this.onConfirm(); this.close(); }
}
