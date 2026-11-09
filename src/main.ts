import { Notice, Plugin } from "obsidian";

import { setMailLocale, t } from "./i18n";
import { PersonNetworkConnector } from "./integrations/person-network";
import { ImapMailService } from "./mail/imap-mail-service";
import type { MailService } from "./mail/mail-service";
import { MailModal } from "./mail-view";
import { DEFAULT_SETTINGS, MailSettingTab } from "./settings";
import type { ConnectionState, OxillMailSettings } from "./types";

export default class OxillMailPlugin extends Plugin {
  settings: OxillMailSettings = structuredClone(DEFAULT_SETTINGS);
  private service!: MailService;
  private avatarConnector!: PersonNetworkConnector;
  private fallbackTimer?: number;

  async onload(): Promise<void> {
    this.settings = this.normalizeSettings(await this.loadData() as Partial<OxillMailSettings> | null);
    setMailLocale(this.settings.language);
    this.service = this.createService();
    this.avatarConnector = new PersonNetworkConnector(this.app);
    this.registerEvent(this.app.metadataCache.on("changed", () => this.avatarConnector.clear()));
    this.addSettingTab(new MailSettingTab(this.app, this));
    this.addRibbonIcon("mail", "Oxill Mail", () => this.openMail());
    this.addCommand({ id: "open-mail", name: t("Открыть почту", "Open mail"), callback: () => this.openMail() });
    this.addCommand({ id: "sync-mail", name: t("Обновить почту", "Refresh mail"), callback: () => void this.syncNow() });
    this.app.workspace.onLayoutReady(() => {
      void this.service.start();
      this.scheduleFallbackSync();
    });
  }

  onunload(): void {
    if (this.fallbackTimer !== undefined) window.clearInterval(this.fallbackTimer);
    void this.service.stop();
  }

  async saveSettings(): Promise<void> {
    setMailLocale(this.settings.language);
    await this.saveData(this.settings);
    this.scheduleFallbackSync();
  }

  async restartMailService(onStarting?: () => void): Promise<void> {
    await this.service.stop();
    const start = this.service.start();
    onStarting?.();
    await start;
  }

  getAccountState(accountId: string): ConnectionState {
    if (!this.settings.accounts.find((account) => account.id === accountId)?.enabled) return "disabled";
    return this.service.snapshots().find((snapshot) => snapshot.account.id === accountId)?.state ?? "offline";
  }

  getAccountMailboxes(accountId: string) {
    return this.service.snapshots().find((snapshot) => snapshot.account.id === accountId)?.mailboxes ?? [];
  }

  private createService(): MailService {
    return new ImapMailService(
      () => this.settings.accounts,
      (secretId) => this.app.secretStorage.getSecret(secretId),
      this.app.vault.getName(),
    );
  }

  private openMail(): void { new MailModal(this.app, this.service, async () => this.saveSettings(), this.avatarConnector).open(); }

  private async syncNow(): Promise<void> {
    try {
      await this.service.sync();
      new Notice(t("Почта обновлена", "Mail refreshed"));
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("Не удалось обновить почту", "Could not refresh mail"));
    }
  }

  private scheduleFallbackSync(): void {
    if (this.fallbackTimer !== undefined) window.clearInterval(this.fallbackTimer);
    this.fallbackTimer = window.setInterval(() => void this.service.sync(), this.settings.fallbackSyncMinutes * 60_000);
  }

  private normalizeSettings(value: Partial<OxillMailSettings> | null): OxillMailSettings {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), ...(value ?? {}) };
    settings.language = settings.language === "en" ? "en" : "ru";
    settings.accounts = Array.isArray(settings.accounts) ? settings.accounts.map((account) => ({
      ...account,
      name: account.name?.trim() ?? "",
      email: account.email?.trim() ?? "",
      username: account.username?.trim() ?? "",
      imapHost: account.imapHost?.trim() ?? "",
      smtpHost: account.smtpHost?.trim() ?? "",
    })) : [];
    settings.fallbackSyncMinutes = Number.isFinite(settings.fallbackSyncMinutes) && settings.fallbackSyncMinutes > 0 ? settings.fallbackSyncMinutes : 5;
    return settings;
  }
}
