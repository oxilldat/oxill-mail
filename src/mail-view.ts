import { App, Menu, Modal, Notice, Setting, normalizePath, sanitizeHTMLToDom, setIcon } from "obsidian";

import { t } from "./i18n";
import type { PersonNetworkConnector } from "./integrations/person-network";
import type { MailService } from "./mail/mail-service";
import type { AccountSnapshot, ComposeMessage, MailAccount, MailAttachment, MailMessage, MailMessageSummary, MailboxSummary, MessageLoadProgress } from "./types";

export class MailModal extends Modal {
  private disposeChanged?: () => void;
  private activeAccountId?: string;
  private selectedMessageId?: string;
  private readonly selectedMessageIds = new Set<string>();
  private listFilter: "all" | "unread" | "flagged" | "attachments" = "all";
  private searchQuery = "";
  private readonly loadedMessages = new Map<string, MailMessage>();
  private readonly objectUrls: string[] = [];

  constructor(app: App, private readonly service: MailService, private readonly saveSettings: () => Promise<void>, private readonly avatars: PersonNetworkConnector) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("oxm-mail-modal");
    this.titleEl.empty();
    this.contentEl.addClass("oxm-root");
    this.disposeChanged = this.service.on("changed", () => this.render());
    this.render();
  }

  onClose(): void {
    this.disposeChanged?.();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.length = 0;
    this.contentEl.empty();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    const snapshots = this.service.snapshots();
    const active = snapshots.find((item) => item.account.id === this.activeAccountId) ?? snapshots[0];
    this.activeAccountId = active?.account.id;
    if (!active) {
      const empty = container.createDiv({ cls: "oxm-empty" });
      setIcon(empty.createSpan(), "mail-plus");
      empty.createEl("h2", { text: t("Подключите почту", "Connect your mailbox") });
      empty.createEl("p", { text: t("Добавьте аккаунт в настройках Oxill Mail.", "Add an account in Oxill Mail settings.") });
      return;
    }

    const layout = container.createDiv({ cls: "oxm-layout" });
    this.renderSidebar(layout, snapshots, active);
    this.renderList(layout, active);
    this.renderReader(layout, active);
    this.renderBottomBar(container);
  }

  private renderSidebar(parent: HTMLElement, snapshots: AccountSnapshot[], active: AccountSnapshot): void {
    const sidebar = parent.createDiv({ cls: "oxm-sidebar" });
    const select = sidebar.createEl("select", { cls: "dropdown oxm-account-select" });
    for (const snapshot of snapshots) select.createEl("option", { value: snapshot.account.id, text: snapshot.account.name || snapshot.account.email });
    select.value = active.account.id;
    select.addEventListener("change", () => { this.activeAccountId = select.value; this.selectedMessageId = undefined; this.selectedMessageIds.clear(); this.render(); });
    const state = sidebar.createDiv({ cls: `oxm-state is-${active.state}` });
    state.createSpan({ cls: "oxm-state-dot" });
    state.createSpan({ text: this.stateLabel(active) });
    if (active.error) state.title = active.error;
    const folderHeader = sidebar.createDiv({ cls: "oxm-folder-header" });
    folderHeader.createSpan({ text: t("Папки", "Folders") });
    const manageFolders = folderHeader.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Управление папками", "Manage folders"), title: t("Управление папками", "Manage folders") } });
    setIcon(manageFolders, "settings-2");
    manageFolders.addEventListener("click", () => new FolderManagerModal(this.app, active.account, this.service, this.saveSettings).open());
    const folders = sidebar.createDiv({ cls: "oxm-folders" });
    for (const mailbox of active.mailboxes.filter((box) => !active.account.folders?.[box.path]?.hidden)) {
      const preference = active.account.folders?.[mailbox.path];
      const row = folders.createEl("button", { cls: `oxm-folder ${mailbox.path === active.activeMailboxPath ? "is-active" : ""}` });
      setIcon(row.createSpan(), this.folderIcon(mailbox.role));
      row.createSpan({ cls: "oxm-folder-name", text: preference?.label?.trim() || mailbox.name });
      if (mailbox.unread) row.createSpan({ cls: "oxm-count", text: String(mailbox.unread) });
      row.addEventListener("click", () => void this.openMailbox(active, mailbox, row));
      row.addEventListener("contextmenu", (event) => this.showFolderMenu(event, active, mailbox));
    }
  }

  private showFolderMenu(event: MouseEvent, active: AccountSnapshot, mailbox: MailboxSummary): void {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle(t("Обновить папку", "Refresh folder"))
      .setIcon("refresh-cw")
      .onClick(() => void this.runAction(() => this.service.openMailbox(active.account.id, mailbox.path))));
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle(t("Скрыть из списка", "Hide from list"))
      .setIcon("eye-off")
      .onClick(() => void this.hideMailbox(active.account, mailbox.path)));
    if (!mailbox.role) {
      menu.addItem((item) => item
        .setTitle(t("Переименовать папку", "Rename folder"))
        .setIcon("pencil")
        .onClick(() => this.renameMailbox(active.account, mailbox)));
      menu.addItem((item) => item
        .setTitle(t("Удалить папку", "Delete folder"))
        .setIcon("trash-2")
        .onClick(() => this.deleteMailbox(active.account, mailbox)));
    }
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle(t("Управление папками", "Manage folders"))
      .setIcon("settings-2")
      .onClick(() => new FolderManagerModal(this.app, active.account, this.service, this.saveSettings).open()));
    menu.showAtMouseEvent(event);
  }

  private async hideMailbox(account: MailAccount, path: string): Promise<void> {
    account.folders ??= {};
    account.folders[path] ??= {};
    account.folders[path].hidden = true;
    await this.runAction(this.saveSettings);
    this.render();
  }

  private renameMailbox(account: MailAccount, mailbox: MailboxSummary): void {
    new TextPromptModal(this.app, t("Переименовать папку", "Rename folder"), t("Новое название", "New name"), mailbox.path, async (value) => {
      await this.service.renameMailbox(account.id, mailbox.path, value);
      const nextPath = value.trim();
      const preference = account.folders?.[mailbox.path];
      if (nextPath && preference && account.folders) {
        account.folders[nextPath] = preference;
        delete account.folders[mailbox.path];
        await this.saveSettings();
      }
    }).open();
  }

  private deleteMailbox(account: MailAccount, mailbox: MailboxSummary): void {
    new ConfirmModal(this.app, t("Удалить папку?", "Delete folder?"), t("Письма в этой папке могут быть удалены сервером.", "Messages in this folder may be deleted by the server."), async () => {
      await this.service.deleteMailbox(account.id, mailbox.path);
      if (account.folders) delete account.folders[mailbox.path];
      await this.saveSettings();
    }).open();
  }

  private async openMailbox(active: AccountSnapshot, mailbox: MailboxSummary, row: HTMLButtonElement): Promise<void> {
    row.disabled = true;
    this.selectedMessageId = undefined;
    this.selectedMessageIds.clear();
    try { await this.service.openMailbox(active.account.id, mailbox.path); }
    catch (error) { new Notice(this.errorText(error)); }
  }

  private renderList(parent: HTMLElement, active: AccountSnapshot): void {
    const column = parent.createDiv({ cls: "oxm-list-column" });
    const mailbox = active.mailboxes.find((box) => box.path === active.activeMailboxPath);
    const header = column.createDiv({ cls: "oxm-list-header" });
    header.createEl("h2", { text: active.account.folders?.[mailbox?.path ?? ""]?.label?.trim() || mailbox?.name || t("Письма", "Messages") });
    if (active.loadingMailboxPath === active.activeMailboxPath) {
      const loading = header.createSpan({ cls: "oxm-mailbox-loading" });
      loading.createSpan({ cls: "oxm-reader-spinner" });
      loading.createSpan({ text: t("Получаем письма", "Loading messages") });
    } else header.createSpan({ text: `${active.messages.length} ${t("писем", "messages")}` });
    const search = column.createEl("input", { cls: "oxm-search", attr: { type: "search", placeholder: t("Поиск по письмам", "Search mail") } });
    search.value = this.searchQuery;
    const filters = column.createDiv({ cls: "oxm-list-filters" });
    const filterItems: Array<[typeof this.listFilter, string]> = [
      ["all", t("Все", "All")],
      ["unread", t("Непрочитанные", "Unread")],
      ["flagged", t("Со звёздочкой", "Starred")],
      ["attachments", t("С файлами", "With files")],
    ];
    for (const [value, label] of filterItems) {
      const button = filters.createEl("button", { cls: this.listFilter === value ? "is-active" : "", text: label, attr: { type: "button" } });
      button.addEventListener("click", () => { this.listFilter = value; this.render(); });
    }
    if (this.selectedMessageIds.size) this.renderBulkToolbar(column, active);
    const list = column.createDiv({ cls: "oxm-message-list" });
    const isLoading = active.loadingMailboxPath === active.activeMailboxPath;
    const draw = (query = ""): void => {
      list.empty();
      const normalized = query.trim().toLocaleLowerCase();
      const messages = this.filteredMessages(active.messages, normalized);
      if (!messages.length && isLoading && !normalized) {
        const skeleton = list.createDiv({ cls: "oxm-message-skeletons", attr: { "aria-label": t("Загрузка писем", "Loading messages") } });
        for (let index = 0; index < 6; index += 1) {
          const row = skeleton.createDiv({ cls: "oxm-message-skeleton" });
          row.createSpan({ cls: "oxm-skeleton-line is-short" });
          row.createSpan({ cls: "oxm-skeleton-line" });
          row.createSpan({ cls: "oxm-skeleton-line is-medium" });
        }
      } else if (!messages.length) list.createDiv({ cls: "oxm-list-empty", text: t("В этой папке нет писем", "This folder is empty") });
      for (const message of messages) this.renderMessageRow(list, message, active);
      if (!normalized && mailbox && active.messages.length < mailbox.total) {
        const more = list.createEl("button", { cls: "oxm-load-more", attr: { type: "button" } });
        if (active.loadingOlderMailboxPath === mailbox.path) {
          more.disabled = true;
          more.createSpan({ cls: "oxm-reader-spinner" });
          more.createSpan({ text: t("Загружаем…", "Loading…") });
        } else {
          setIcon(more.createSpan(), "chevrons-down");
          more.createSpan({ text: t("Загрузить ещё", "Load more") });
          more.addEventListener("click", () => void this.runAction(() => this.service.loadMore(active.account.id, mailbox.path)));
        }
      }
    };
    search.addEventListener("input", () => { this.searchQuery = search.value; draw(search.value); });
    draw(this.searchQuery);
  }

  private filteredMessages(messages: MailMessageSummary[], normalizedQuery = this.searchQuery.trim().toLocaleLowerCase()): MailMessageSummary[] {
    return messages.filter((message) => {
      const matchesQuery = !normalizedQuery || `${message.fromName} ${message.fromAddress} ${message.subject} ${message.preview}`.toLocaleLowerCase().includes(normalizedQuery);
      const matchesFilter = this.listFilter === "all"
        || (this.listFilter === "unread" && message.unread)
        || (this.listFilter === "flagged" && message.flagged)
        || (this.listFilter === "attachments" && message.hasAttachments);
      return matchesQuery && matchesFilter;
    });
  }

  private renderBulkToolbar(container: HTMLElement, active: AccountSnapshot): void {
    const selected = active.messages.filter((message) => this.selectedMessageIds.has(message.id));
    if (!selected.length) {
      this.selectedMessageIds.clear();
      return;
    }
    const mailbox = selected[0]?.mailbox;
    if (!mailbox) return;
    const toolbar = container.createDiv({ cls: "oxm-bulk-toolbar" });
    const selectionMenu = toolbar.createEl("button", { cls: "oxm-bulk-selection-menu", attr: { type: "button", "aria-label": t("Управление выделением", "Selection options") } });
    selectionMenu.createSpan({ text: `${t("Выбрано", "Selected")}: ${selected.length}` });
    setIcon(selectionMenu.createSpan(), "chevron-down");
    selectionMenu.addEventListener("click", (event) => this.showSelectionMenu(event, active));
    this.bulkButton(toolbar, "mail-open", t("Прочитано", "Mark read"), () => this.service.setSeenMany(active.account.id, mailbox, selected.map((message) => message.uid), true));
    this.bulkButton(toolbar, "mail", t("Не прочитано", "Mark unread"), () => this.service.setSeenMany(active.account.id, mailbox, selected.map((message) => message.uid), false));
    this.bulkButton(toolbar, "star", t("Поставить звёздочку", "Add star"), () => this.service.setFlaggedMany(active.account.id, mailbox, selected.map((message) => message.uid), true));
    this.bulkButton(toolbar, "star-off", t("Снять звёздочку", "Remove star"), () => this.service.setFlaggedMany(active.account.id, mailbox, selected.map((message) => message.uid), false));
    this.bulkButton(toolbar, "folder-input", t("Переместить", "Move"), async () => this.moveSelected(active, selected));
    this.bulkButton(toolbar, "trash-2", t("Удалить", "Delete"), async () => this.confirmDeleteSelected(active, selected));
    const clear = toolbar.createEl("button", { cls: "clickable-icon oxm-bulk-clear", attr: { type: "button", "aria-label": t("Снять выделение", "Clear selection"), title: t("Снять выделение", "Clear selection") } });
    setIcon(clear, "x");
    clear.addEventListener("click", () => { this.selectedMessageIds.clear(); this.render(); });
  }

  private showSelectionMenu(event: MouseEvent, active: AccountSnapshot): void {
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle(t("Выбрать все показанные", "Select all visible"))
      .setIcon("list-checks")
      .onClick(() => {
        for (const message of this.filteredMessages(active.messages)) this.selectedMessageIds.add(message.id);
        this.render();
      }));
    menu.addItem((item) => item
      .setTitle(t("Снять выделение", "Clear selection"))
      .setIcon("x")
      .onClick(() => { this.selectedMessageIds.clear(); this.render(); }));
    menu.showAtMouseEvent(event);
  }

  private bulkButton(container: HTMLElement, icon: string, label: string, action: () => Promise<void>): void {
    const button = container.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": label, title: label } });
    setIcon(button, icon);
    button.addEventListener("click", () => void this.runAction(async () => {
      await action();
      this.selectedMessageIds.clear();
      this.render();
    }));
  }

  private async moveSelected(active: AccountSnapshot, messages: MailMessageSummary[]): Promise<void> {
    const mailbox = messages[0]?.mailbox;
    if (!mailbox) return;
    new MailboxPickerModal(this.app, active.mailboxes.filter((item) => item.path !== mailbox), t("Переместить письма", "Move messages"), async (destination) => {
      await this.service.moveMessages(active.account.id, mailbox, messages.map((message) => message.uid), destination);
      this.selectedMessageIds.clear();
      this.selectedMessageId = undefined;
    }).open();
  }

  private async confirmDeleteSelected(active: AccountSnapshot, messages: MailMessageSummary[]): Promise<void> {
    const mailbox = messages[0]?.mailbox;
    if (!mailbox) return;
    new ConfirmModal(this.app, t("Удалить выбранные письма?", "Delete selected messages?"), `${t("Количество писем", "Messages")}: ${messages.length}`, async () => {
      await this.service.deleteMessages(active.account.id, mailbox, messages.map((message) => message.uid));
      this.selectedMessageIds.clear();
      this.selectedMessageId = undefined;
    }).open();
  }

  private renderMessageRow(parent: HTMLElement, message: MailMessageSummary, active: AccountSnapshot): void {
    const row = parent.createDiv({ cls: `oxm-message ${message.unread ? "is-unread" : ""} ${message.id === this.selectedMessageId ? "is-selected" : ""} ${this.selectedMessageIds.has(message.id) ? "is-checked" : ""}` });
    const top = row.createDiv({ cls: "oxm-message-top" });
    const check = top.createEl("input", { cls: "oxm-message-check", attr: { type: "checkbox", "aria-label": t("Выбрать письмо", "Select message") } });
    check.checked = this.selectedMessageIds.has(message.id);
    check.addEventListener("click", (event) => event.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) this.selectedMessageIds.add(message.id);
      else this.selectedMessageIds.delete(message.id);
      this.render();
    });
    this.renderAvatar(top, message.fromAddress, message.fromName, true);
    top.createSpan({ cls: "oxm-sender", text: message.fromName });
    const flag = top.createEl("button", { cls: `clickable-icon oxm-message-flag ${message.flagged ? "is-active" : ""}`, attr: { "aria-label": message.flagged ? t("Снять звёздочку", "Remove star") : t("Поставить звёздочку", "Add star") } });
    setIcon(flag, "star");
    flag.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.runAction(() => this.service.setFlagged(message.accountId, message.mailbox, message.uid, !message.flagged));
    });
    top.createSpan({ cls: "oxm-date", text: this.formatDate(message.receivedAt) });
    row.createDiv({ cls: "oxm-subject", text: message.subject });
    if (message.preview) row.createDiv({ cls: "oxm-preview", text: message.preview });
    row.addEventListener("click", () => void this.selectMessage(message));
    row.addEventListener("contextmenu", (event) => this.showMessageMenu(event, active, message));
  }

  private showMessageMenu(event: MouseEvent, active: AccountSnapshot, message: MailMessageSummary): void {
    event.preventDefault();
    const menu = new Menu();
    const mailbox = active.mailboxes.find((item) => item.path === message.mailbox);
    if (mailbox?.role === "drafts") {
      menu.addItem((item) => item.setTitle(t("Продолжить черновик", "Edit draft")).setIcon("file-pen-line").onClick(() => void this.runAction(() => this.openComposer(active, message, "draft"))));
    } else {
      menu.addItem((item) => item.setTitle(t("Ответить", "Reply")).setIcon("reply").onClick(() => void this.runAction(() => this.openComposer(active, message, "reply"))));
      menu.addItem((item) => item.setTitle(t("Ответить всем", "Reply all")).setIcon("reply-all").onClick(() => void this.runAction(() => this.openComposer(active, message, "reply-all"))));
      menu.addItem((item) => item.setTitle(t("Переслать", "Forward")).setIcon("forward").onClick(() => void this.runAction(() => this.openComposer(active, message, "forward"))));
    }
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle(message.unread ? t("Отметить прочитанным", "Mark as read") : t("Отметить непрочитанным", "Mark as unread"))
      .setIcon(message.unread ? "mail-open" : "mail")
      .onClick(() => void this.runAction(() => this.service.setSeen(message.accountId, message.mailbox, message.uid, message.unread))));
    menu.addItem((item) => item
      .setTitle(message.flagged ? t("Снять звёздочку", "Remove star") : t("Поставить звёздочку", "Add star"))
      .setIcon("star")
      .onClick(() => void this.runAction(() => this.service.setFlagged(message.accountId, message.mailbox, message.uid, !message.flagged))));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Переместить", "Move")).setIcon("folder-input").onClick(() => void this.pickMailbox(active, message, "move")));
    menu.addItem((item) => item.setTitle(t("Копировать", "Copy")).setIcon("copy").onClick(() => void this.pickMailbox(active, message, "copy")));
    menu.addItem((item) => item.setTitle(t("Сохранить в заметки", "Save to notes")).setIcon("file-down").onClick(() => void this.runAction(() => this.saveMessageToNote(message))));
    menu.addSeparator();
    const currentMailbox = mailbox;
    if (currentMailbox?.role === "trash") {
      menu.addItem((item) => item
        .setTitle(t("Восстановить", "Restore"))
        .setIcon("undo-2")
        .onClick(() => void this.runAction(() => this.service.restoreMessage(message.accountId, message.mailbox, message.uid))));
      menu.addItem((item) => item
        .setTitle(t("Удалить навсегда", "Delete permanently"))
        .setIcon("trash-2")
        .onClick(() => new ConfirmModal(this.app, t("Удалить письмо навсегда?", "Delete message permanently?"), t("Это действие нельзя отменить.", "This action cannot be undone."), async () => {
          await this.service.deleteMessage(message.accountId, message.mailbox, message.uid);
          if (this.selectedMessageId === message.id) this.selectedMessageId = undefined;
        }).open()));
    } else {
      menu.addItem((item) => item
        .setTitle(t("Удалить", "Delete"))
        .setIcon("trash-2")
        .onClick(() => void this.runAction(async () => {
          await this.service.deleteMessage(message.accountId, message.mailbox, message.uid);
          if (this.selectedMessageId === message.id) this.selectedMessageId = undefined;
        })));
    }
    menu.showAtMouseEvent(event);
  }

  private async selectMessage(message: MailMessageSummary): Promise<void> {
    this.selectedMessageId = message.id;
    this.render();
    try {
      if (message.unread) await this.service.setSeen(message.accountId, message.mailbox, message.uid, true);
      if (!this.loadedMessages.has(message.id)) await this.loadSelected(message);
    } catch (error) { new Notice(this.errorText(error)); }
  }

  private renderReader(parent: HTMLElement, active: AccountSnapshot): void {
    const reader = parent.createDiv({ cls: "oxm-reader" });
    const message = active.messages.find((item) => item.id === this.selectedMessageId);
    if (!message) {
      const placeholder = reader.createDiv({ cls: "oxm-reader-empty" });
      const icon = placeholder.createSpan({ cls: "oxm-reader-empty-icon" });
      setIcon(icon, "mail-open");
      placeholder.createEl("h3", { text: t("Выберите письмо", "Select a message") });
      placeholder.createEl("p", { text: t("Содержимое появится здесь", "Its contents will appear here") });
      return;
    }
    const toolbar = reader.createDiv({ cls: "oxm-reader-toolbar" });
    const currentMailbox = active.mailboxes.find((mailbox) => mailbox.path === message.mailbox);
    if (currentMailbox?.role === "drafts") {
      this.actionButton(toolbar, "file-pen-line", t("Продолжить черновик", "Edit draft"), () => this.openComposer(active, message, "draft"));
    } else {
      this.actionButton(toolbar, "reply", t("Ответить", "Reply"), () => this.openComposer(active, message, "reply"));
      this.actionButton(toolbar, "reply-all", t("Ответить всем", "Reply all"), () => this.openComposer(active, message, "reply-all"));
      this.actionButton(toolbar, "forward", t("Переслать", "Forward"), () => this.openComposer(active, message, "forward"));
    }
    this.actionButton(toolbar, message.unread ? "mail-open" : "mail", message.unread ? t("Отметить прочитанным", "Mark as read") : t("Отметить непрочитанным", "Mark as unread"), () => this.service.setSeen(message.accountId, message.mailbox, message.uid, message.unread));
    this.actionButton(toolbar, "star", message.flagged ? t("Снять звёздочку", "Remove star") : t("Поставить звёздочку", "Add star"), () => this.service.setFlagged(message.accountId, message.mailbox, message.uid, !message.flagged), message.flagged);
    this.actionButton(toolbar, "folder-input", t("Переместить", "Move"), async () => this.pickMailbox(active, message, "move"));
    this.actionButton(toolbar, "copy", t("Копировать", "Copy"), async () => this.pickMailbox(active, message, "copy"));
    this.actionButton(toolbar, "file-down", t("Сохранить в заметки", "Save to notes"), async () => this.saveMessageToNote(message));
    if (currentMailbox?.role === "trash") {
      this.actionButton(toolbar, "undo-2", t("Восстановить", "Restore"), () => this.service.restoreMessage(message.accountId, message.mailbox, message.uid));
      this.actionButton(toolbar, "trash-2", t("Удалить навсегда", "Delete permanently"), async () => {
        new ConfirmModal(this.app, t("Удалить письмо навсегда?", "Delete message permanently?"), t("Это действие нельзя отменить.", "This action cannot be undone."), async () => {
          await this.service.deleteMessage(message.accountId, message.mailbox, message.uid);
        }).open();
      });
    } else this.actionButton(toolbar, "trash-2", t("Удалить", "Delete"), () => this.service.deleteMessage(message.accountId, message.mailbox, message.uid));
    reader.createEl("h1", { text: message.subject });
    const sender = reader.createDiv({ cls: "oxm-reader-sender" });
    const avatar = this.renderAvatar(sender, message.fromAddress, message.fromName, false);
    avatar.title = message.fromAddress;
    const details = sender.createDiv();
    details.createDiv({ cls: "oxm-reader-name", text: message.fromName });
    details.createDiv({ cls: "oxm-reader-address", text: message.fromAddress });
    sender.createSpan({ cls: "oxm-reader-date", text: new Date(message.receivedAt).toLocaleString() });
    const loaded = this.loadedMessages.get(message.id);
    if (loaded) this.renderMessageBody(reader, loaded);
    else {
      const loading = reader.createDiv({ cls: "oxm-reader-loading" });
      loading.createDiv({ cls: "oxm-reader-spinner" });
      const copy = loading.createDiv({ cls: "oxm-reader-loading-copy" });
      copy.createDiv({ cls: "oxm-reader-loading-status", text: t("Запрашиваем письмо…", "Requesting message…") });
      copy.createDiv({ cls: "oxm-reader-loading-detail", text: t("Ожидаем ответ почтового сервера", "Waiting for the mail server") });
      const progress = loading.createDiv({ cls: "oxm-reader-progress is-indeterminate" });
      progress.createDiv({ cls: "oxm-reader-progress-value" });
    }
  }

  private async loadSelected(message: MailMessageSummary): Promise<void> {
    const slowTimer = window.setTimeout(() => {
      if (this.selectedMessageId !== message.id) return;
      const detail = this.contentEl.querySelector<HTMLElement>(".oxm-reader-loading-detail");
      if (detail) detail.setText(t("Большие письма и медленные серверы могут загружаться дольше", "Large messages and slow servers may take longer"));
    }, 4_000);
    try {
      const full = await this.service.loadMessage(message.accountId, message.mailbox, message.uid, (progress) => this.updateMessageProgress(message.id, progress));
      if (this.selectedMessageId !== message.id) return;
      const reader = this.contentEl.querySelector<HTMLElement>(".oxm-reader");
      const loading = reader?.querySelector<HTMLElement>(".oxm-reader-loading");
      if (!reader || !loading) return;
      this.loadedMessages.set(message.id, full);
      while (this.loadedMessages.size > 20) {
        const oldest = this.loadedMessages.keys().next().value as string | undefined;
        if (!oldest) break;
        this.loadedMessages.delete(oldest);
      }
      loading.remove();
      this.renderMessageBody(reader, full);
    } catch (error) {
      const loading = this.contentEl.querySelector<HTMLElement>(".oxm-reader-loading");
      if (loading) {
        loading.empty();
        loading.addClass("is-error");
        setIcon(loading.createSpan(), "circle-alert");
        loading.createSpan({ text: this.errorText(error) });
      }
    } finally { window.clearTimeout(slowTimer); }
  }

  private updateMessageProgress(messageId: string, progress: MessageLoadProgress): void {
    if (this.selectedMessageId !== messageId) return;
    const loading = this.contentEl.querySelector<HTMLElement>(".oxm-reader-loading");
    const status = loading?.querySelector<HTMLElement>(".oxm-reader-loading-status");
    const detail = loading?.querySelector<HTMLElement>(".oxm-reader-loading-detail");
    const track = loading?.querySelector<HTMLElement>(".oxm-reader-progress");
    const value = track?.querySelector<HTMLElement>(".oxm-reader-progress-value");
    if (!loading || !status || !detail || !track || !value) return;
    if (progress.stage === "fetching") {
      status.setText(t("Запрашиваем письмо…", "Requesting message…"));
      detail.setText(t("Ожидаем ответ почтового сервера", "Waiting for the mail server"));
      track.addClass("is-indeterminate");
      return;
    }
    if (progress.stage === "downloading") {
      status.setText(t("Загружаем письмо…", "Downloading message…"));
      const loaded = progress.loadedBytes ?? 0;
      const total = progress.totalBytes ?? 0;
      detail.setText(total > 0 ? `${this.formatBytes(loaded)} ${t("из", "of")} ${this.formatBytes(total)}` : this.formatBytes(loaded));
      track.removeClass("is-indeterminate");
      value.style.width = total > 0 ? `${Math.min(100, loaded / total * 100)}%` : "15%";
      return;
    }
    if (progress.stage === "parsing") {
      status.setText(t("Обрабатываем содержимое…", "Processing content…"));
      detail.setText(t("Подготавливаем безопасное отображение письма", "Preparing a safe message preview"));
      track.addClass("is-indeterminate");
      return;
    }
    status.setText(t("Готово", "Ready"));
    detail.empty();
    track.removeClass("is-indeterminate");
    value.style.width = "100%";
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  private renderAvatar(container: HTMLElement, email: string, name: string, compact: boolean): HTMLElement {
    const resolved = this.avatars.resolve(email, name);
    const avatar = container.createSpan({ cls: `oxm-avatar ${compact ? "is-compact" : ""}`, text: resolved.imageUrl ? "" : resolved.initial });
    avatar.style.backgroundColor = resolved.color;
    if (resolved.imageUrl) {
      const image = avatar.createEl("img", { attr: { src: resolved.imageUrl, alt: "" } });
      if (resolved.imagePosition) image.style.objectPosition = resolved.imagePosition;
      if (resolved.imageScale && resolved.imageScale !== 1) image.style.transform = `scale(${resolved.imageScale})`;
    }
    return avatar;
  }

  private renderMessageBody(reader: HTMLElement, message: MailMessage): void {
    if (message.attachments?.length) this.renderAttachments(reader, message.attachments);
    if (!message.html) {
      reader.createEl("pre", { cls: "oxm-reader-body", text: message.text || t("В письме нет отображаемого содержимого.", "This message has no displayable content.") });
      return;
    }
    const safe = sanitizeHTMLToDom(message.html);
    const blockedImages: HTMLImageElement[] = [];
    for (const image of Array.from(safe.querySelectorAll("img"))) {
      const src = image.getAttribute("src") ?? "";
      if (/^cid:/i.test(src)) {
        const contentId = src.slice(4).replace(/^<|>$/g, "");
        const attachment = message.attachments.find((item) => item.contentId?.replace(/^<|>$/g, "") === contentId);
        if (attachment) {
          const url = URL.createObjectURL(new Blob([attachment.content.slice().buffer as ArrayBuffer], { type: attachment.contentType }));
          this.objectUrls.push(url);
          image.setAttribute("src", url);
        }
      } else if (/^https?:/i.test(src)) {
        image.dataset.oxmRemoteSrc = src;
        image.removeAttribute("src");
        blockedImages.push(image);
      }
      const srcset = image.getAttribute("srcset") ?? "";
      if (/https?:/i.test(srcset)) {
        image.dataset.oxmRemoteSrcset = srcset;
        image.removeAttribute("srcset");
        if (!blockedImages.includes(image)) blockedImages.push(image);
      }
    }
    for (const link of Array.from(safe.querySelectorAll("a"))) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
    if (blockedImages.length) {
      const remoteBar = reader.createDiv({ cls: "oxm-remote-images" });
      setIcon(remoteBar.createSpan(), "image-off");
      remoteBar.createSpan({ text: t("Внешние изображения заблокированы", "Remote images are blocked") });
      const load = remoteBar.createEl("button", { text: t("Загрузить изображения", "Load images") });
      load.addEventListener("click", () => {
        for (const image of blockedImages) {
          if (image.dataset.oxmRemoteSrc) image.setAttribute("src", image.dataset.oxmRemoteSrc);
          if (image.dataset.oxmRemoteSrcset) image.setAttribute("srcset", image.dataset.oxmRemoteSrcset);
          delete image.dataset.oxmRemoteSrc;
          delete image.dataset.oxmRemoteSrcset;
        }
        remoteBar.remove();
      });
    }
    const body = reader.createDiv({ cls: "oxm-reader-body oxm-reader-html" });
    body.appendChild(safe);
  }

  private renderAttachments(reader: HTMLElement, attachments: MailAttachment[]): void {
    const section = reader.createDiv({ cls: "oxm-attachments" });
    section.createDiv({ cls: "oxm-attachments-title", text: `${t("Вложения", "Attachments")} · ${attachments.length}` });
    const list = section.createDiv({ cls: "oxm-attachment-list" });
    for (const attachment of attachments) {
      const item = list.createDiv({ cls: "oxm-attachment" });
      const icon = item.createSpan({ cls: "oxm-attachment-icon" });
      setIcon(icon, "paperclip");
      const copy = item.createDiv({ cls: "oxm-attachment-copy" });
      copy.createDiv({ cls: "oxm-attachment-name", text: attachment.filename });
      copy.createDiv({ cls: "oxm-attachment-meta", text: `${attachment.contentType} · ${this.formatBytes(attachment.size)}` });
      const save = item.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Сохранить в vault", "Save to vault"), title: t("Сохранить в vault", "Save to vault") } });
      setIcon(save, "download");
      save.addEventListener("click", () => void this.runAction(() => this.saveAttachment(attachment)));
    }
  }

  private async saveAttachment(attachment: MailAttachment): Promise<void> {
    const folder = normalizePath("Почта/Вложения");
    if (!this.app.vault.getAbstractFileByPath("Почта")) await this.app.vault.createFolder("Почта");
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const filename = this.safeFileName(attachment.filename) || t("Вложение", "Attachment");
    let path = normalizePath(`${folder}/${filename}`);
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : "";
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${stem} ${suffix++}${extension}`);
    await this.app.vault.createBinary(path, attachment.content.slice().buffer as ArrayBuffer);
    new Notice(`${t("Вложение сохранено", "Attachment saved")}: ${path}`);
  }

  private async openComposer(active: AccountSnapshot, summary: MailMessageSummary, mode: "reply" | "reply-all" | "forward" | "draft"): Promise<void> {
    const message = this.loadedMessages.get(summary.id) ?? await this.service.loadMessage(summary.accountId, summary.mailbox, summary.uid);
    this.loadedMessages.set(summary.id, message);
    const accountEmail = active.account.email.toLocaleLowerCase();
    const replyAddress = message.replyTo || message.fromAddress;
    const unique = (addresses: string[]): string[] => [...new Map(addresses.filter(Boolean).map((address) => [address.toLocaleLowerCase(), address])).values()];
    const quote = `\n\n---\n${t("Исходное письмо", "Original message")}\n${t("От", "From")}: ${message.fromName} <${message.fromAddress}>\n${t("Дата", "Date")}: ${new Date(message.receivedAt).toLocaleString()}\n${t("Тема", "Subject")}: ${message.subject}\n\n${message.text}`;
    let initial: ComposeMessage;
    let heading: string;
    if (mode === "draft") {
      initial = { to: message.to, cc: message.cc, bcc: message.bcc, subject: message.subject, text: message.text, attachments: message.attachments, references: message.references, draftSource: { mailbox: message.mailbox, uid: message.uid } };
      heading = t("Черновик", "Draft");
    } else if (mode === "forward") {
      initial = { to: [], cc: [], bcc: [], subject: this.prefixedSubject(message.subject, "Fwd:"), text: quote, attachments: message.attachments, references: [] };
      heading = t("Переслать письмо", "Forward message");
    } else {
      const all = mode === "reply-all" ? unique([replyAddress, ...message.to, ...message.cc]).filter((address) => address.toLocaleLowerCase() !== accountEmail) : [replyAddress];
      initial = { to: all.slice(0, 1), cc: all.slice(1), bcc: [], subject: this.prefixedSubject(message.subject, "Re:"), text: quote, attachments: [], inReplyTo: message.messageId, references: unique([...message.references, ...(message.messageId ? [message.messageId] : [])]) };
      heading = mode === "reply-all" ? t("Ответить всем", "Reply all") : t("Ответить", "Reply");
    }
    new ComposeModal(this.app, active, this.service, initial, heading).open();
  }

  private prefixedSubject(subject: string, prefix: string): string {
    return new RegExp(`^${prefix.replace(":", "")}:`, "i").test(subject.trim()) ? subject : `${prefix} ${subject}`;
  }

  private renderBottomBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "oxm-bottom-bar" });
    const refresh = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Обновить", "Refresh") } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.service.sync());
    const compose = bar.createEl("button", { cls: "mod-cta oxm-compose", text: t("Написать", "Compose") });
    compose.addEventListener("click", () => {
      const snapshot = this.service.snapshots().find((item) => item.account.id === this.activeAccountId);
      if (snapshot) new ComposeModal(this.app, snapshot, this.service).open();
    });
  }

  private actionButton(container: HTMLElement, icon: string, label: string, action: () => Promise<void>, active = false): void {
    const button = container.createEl("button", { cls: `clickable-icon ${active ? "is-active" : ""}`, attr: { "aria-label": label, title: label } });
    setIcon(button, icon);
    button.addEventListener("click", () => void this.runAction(action));
  }

  private async pickMailbox(active: AccountSnapshot, message: MailMessageSummary, mode: "move" | "copy"): Promise<void> {
    new MailboxPickerModal(this.app, active.mailboxes.filter((mailbox) => mailbox.path !== message.mailbox), mode === "move" ? t("Переместить письмо", "Move message") : t("Копировать письмо", "Copy message"), async (destination) => {
      if (mode === "move") {
        await this.service.moveMessage(message.accountId, message.mailbox, message.uid, destination);
        this.selectedMessageId = undefined;
      } else await this.service.copyMessage(message.accountId, message.mailbox, message.uid, destination);
    }).open();
  }

  private async saveMessageToNote(message: MailMessageSummary): Promise<void> {
    const full = await this.service.loadMessage(message.accountId, message.mailbox, message.uid);
    const folder = normalizePath("Почта");
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const stem = this.safeFileName(full.subject || t("Без темы", "No subject"));
    let path = normalizePath(`${folder}/${stem}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${stem} ${suffix++}.md`);
    await this.app.vault.create(path, this.noteContent(full));
    new Notice(t("Письмо сохранено в заметки", "Message saved to notes"));
  }

  private noteContent(message: MailMessage): string {
    const yaml = (value: string): string => JSON.stringify(value);
    return `---\ntype: email\naccount: ${yaml(message.accountId)}\nfolder: ${yaml(message.mailbox)}\nmessage-id: ${yaml(message.messageId ?? "")}\nfrom: ${yaml(message.fromAddress)}\nto:\n${message.to.map((address) => `  - ${yaml(address)}`).join("\n")}\ndate: ${yaml(new Date(message.receivedAt).toISOString())}\nsubject: ${yaml(message.subject)}\n---\n\n${message.text || t("В письме нет текстового содержимого.", "This message has no text content.")}\n`;
  }

  private safeFileName(value: string): string {
    return value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || t("Без темы", "No subject");
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) { new Notice(this.errorText(error)); }
  }

  private stateLabel(snapshot: AccountSnapshot): string {
    if (snapshot.state === "online") return t("В сети · IDLE", "Online · IDLE");
    if (snapshot.state === "connecting") return t("Подключение…", "Connecting…");
    if (snapshot.state === "error") return t("Ошибка", "Error");
    return t("Не в сети", "Offline");
  }
  private folderIcon(role: string | undefined): string {
    return ({ inbox: "inbox", sent: "send", drafts: "file-pen-line", archive: "archive", trash: "trash-2", junk: "shield-alert" } as Record<string, string>)[role ?? ""] ?? "folder";
  }
  private formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const today = new Date();
    return date.toDateString() === today.toDateString() ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString([], { day: "2-digit", month: "short" });
  }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : t("Не удалось выполнить действие", "The action failed"); }
}

class ComposeModal extends Modal {
  private to: string;
  private cc: string;
  private bcc: string;
  private subject: string;
  private body: string;
  private attachments: MailAttachment[];
  private busy = false;

  constructor(
    app: App,
    private readonly snapshot: AccountSnapshot,
    private readonly service: MailService,
    private readonly initial: ComposeMessage = { to: [], cc: [], bcc: [], subject: "", text: "", attachments: [], references: [] },
    private readonly heading = t("Новое письмо", "New message"),
  ) {
    super(app);
    this.to = initial.to.join(", ");
    this.cc = initial.cc.join(", ");
    this.bcc = initial.bcc.join(", ");
    this.subject = initial.subject;
    this.body = initial.text;
    this.attachments = [...initial.attachments];
  }

  onOpen(): void {
    this.modalEl.addClass("oxm-compose-modal");
    this.titleEl.setText(this.heading);
    new Setting(this.contentEl).setName(t("От", "From")).setDesc(this.snapshot.account.email);
    new Setting(this.contentEl).setName(t("Кому", "To")).addText((input) => input.setPlaceholder("name@example.com").setValue(this.to).onChange((value) => { this.to = value; }));
    new Setting(this.contentEl).setName(t("Копия", "Cc")).addText((input) => input.setPlaceholder("copy@example.com").setValue(this.cc).onChange((value) => { this.cc = value; }));
    new Setting(this.contentEl).setName(t("Скрытая копия", "Bcc")).addText((input) => input.setPlaceholder("hidden@example.com").setValue(this.bcc).onChange((value) => { this.bcc = value; }));
    new Setting(this.contentEl).setName(t("Тема", "Subject")).addText((input) => input.setValue(this.subject).onChange((value) => { this.subject = value; }));
    new Setting(this.contentEl).setName(t("Сообщение", "Message")).addTextArea((input) => {
      input.inputEl.rows = 12;
      input.setValue(this.body);
      input.onChange((value) => { this.body = value; });
    });
    const attachmentSection = this.contentEl.createDiv({ cls: "oxm-compose-attachments" });
    const attachmentHeader = attachmentSection.createDiv({ cls: "oxm-compose-attachments-header" });
    attachmentHeader.createSpan({ text: t("Вложения", "Attachments") });
    const picker = attachmentHeader.createEl("input", { cls: "oxm-file-input", attr: { type: "file", multiple: "" } });
    const pickButton = attachmentHeader.createEl("button", { attr: { type: "button" } });
    setIcon(pickButton.createSpan({ cls: "oxm-button-icon" }), "paperclip");
    pickButton.createSpan({ text: t("Добавить файлы", "Add files") });
    pickButton.addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => void this.addFiles(picker.files, attachmentSection));
    this.renderComposeAttachments(attachmentSection);
    const actions = this.contentEl.createDiv({ cls: "oxm-modal-actions" });
    actions.createEl("button", { text: t("Сохранить черновик", "Save draft") }).addEventListener("click", () => void this.submit("draft"));
    actions.createEl("button", { cls: "mod-cta", text: t("Отправить", "Send") }).addEventListener("click", () => void this.submit("send"));
  }

  onClose(): void { this.contentEl.empty(); }

  private async submit(mode: "draft" | "send"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.contentEl.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      const message = this.message();
      if (mode === "draft") await this.service.saveDraft(this.snapshot.account.id, message);
      else await this.service.sendMessage(this.snapshot.account.id, message);
      new Notice(mode === "draft" ? t("Черновик сохранён", "Draft saved") : t("Письмо отправлено", "Message sent"));
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("Не удалось выполнить действие", "The action failed"));
      this.busy = false;
      this.contentEl.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  }

  private message(): ComposeMessage {
    return {
      to: this.addresses(this.to),
      cc: this.addresses(this.cc),
      bcc: this.addresses(this.bcc),
      subject: this.subject.trim(),
      text: this.body,
      attachments: this.attachments,
      inReplyTo: this.initial.inReplyTo,
      references: this.initial.references,
      draftSource: this.initial.draftSource,
    };
  }

  private async addFiles(files: FileList | null, section: HTMLElement): Promise<void> {
    if (!files?.length) return;
    const additions: MailAttachment[] = [];
    for (const file of Array.from(files)) additions.push({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      size: file.size,
      content: new Uint8Array(await file.arrayBuffer()),
    });
    const total = [...this.attachments, ...additions].reduce((sum, attachment) => sum + attachment.size, 0);
    if (total > 25 * 1024 * 1024) {
      new Notice(t("Общий размер вложений не должен превышать 25 МБ", "Total attachment size must not exceed 25 MB"));
      return;
    }
    this.attachments.push(...additions);
    this.renderComposeAttachments(section);
  }

  private renderComposeAttachments(section: HTMLElement): void {
    section.querySelector(".oxm-compose-attachment-list")?.remove();
    const list = section.createDiv({ cls: "oxm-compose-attachment-list" });
    if (!this.attachments.length) {
      list.createSpan({ cls: "oxm-compose-attachment-empty", text: t("Файлы не прикреплены", "No files attached") });
      return;
    }
    this.attachments.forEach((attachment, index) => {
      const row = list.createDiv({ cls: "oxm-compose-attachment" });
      setIcon(row.createSpan(), "file");
      row.createSpan({ cls: "oxm-compose-attachment-name", text: attachment.filename });
      row.createSpan({ cls: "oxm-compose-attachment-size", text: this.formatBytes(attachment.size) });
      const remove = row.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": t("Убрать вложение", "Remove attachment") } });
      setIcon(remove, "x");
      remove.addEventListener("click", () => { this.attachments.splice(index, 1); this.renderComposeAttachments(section); });
    });
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  private addresses(value: string): string[] {
    return value.split(/[;,]/).map((address) => address.trim()).filter(Boolean);
  }
}

class FolderManagerModal extends Modal {
  private readonly folders: NonNullable<MailAccount["folders"]>;

  constructor(app: App, private readonly account: MailAccount, private readonly service: MailService, private readonly saveSettings: () => Promise<void>) {
    super(app);
    this.folders = structuredClone(account.folders ?? {});
  }

  onOpen(): void {
    this.modalEl.addClass("oxm-folder-manager-modal");
    this.titleEl.empty();
    this.render();
  }

  onClose(): void { this.contentEl.empty(); }

  private render(): void {
    const snapshot = this.service.snapshots().find((item) => item.account.id === this.account.id);
    this.contentEl.empty();
    if (!snapshot) {
      this.contentEl.createDiv({ cls: "oxm-list-empty", text: t("Аккаунт не подключён", "Account is not connected") });
      return;
    }
    const intro = this.contentEl.createDiv({ cls: "oxm-folder-manager-intro" });
    const introCopy = intro.createDiv();
    introCopy.createDiv({ cls: "oxm-folder-manager-heading", text: t("Папки аккаунта", "Account folders") });
    introCopy.createDiv({ cls: "oxm-folder-manager-description", text: t("Настройте названия и видимость папок в почтовом клиенте.", "Choose folder names and visibility in the mail client.") });
    const create = intro.createEl("button", { cls: "mod-cta", attr: { type: "button" } });
    setIcon(create.createSpan({ cls: "oxm-button-icon" }), "folder-plus");
    create.createSpan({ text: t("Создать папку", "Create folder") });
    create.addEventListener("click", () => new TextPromptModal(this.app, t("Создать папку", "Create folder"), t("Название папки", "Folder name"), "", async (value) => {
      await this.service.createMailbox(this.account.id, value);
      this.render();
    }).open());
    const hiddenCount = snapshot.mailboxes.filter((mailbox) => this.folders[mailbox.path]?.hidden).length;
    const summary = this.contentEl.createDiv({ cls: "oxm-folder-manager-summary" });
    summary.createSpan({ text: `${snapshot.mailboxes.length} ${t("папок", "folders")}` });
    if (hiddenCount) summary.createSpan({ text: `${hiddenCount} ${t("скрыто", "hidden")}` });
    const list = this.contentEl.createDiv({ cls: "oxm-folder-manager-list" });
    for (const mailbox of snapshot.mailboxes) this.renderMailbox(list, mailbox);
    const actions = this.contentEl.createDiv({ cls: "oxm-folder-manager-footer" });
    actions.createEl("button", { text: t("Отмена", "Cancel") }).addEventListener("click", () => this.close());
    actions.createEl("button", { cls: "mod-cta", text: t("Сохранить", "Save") }).addEventListener("click", () => void this.save());
  }

  private renderMailbox(container: HTMLElement, mailbox: MailboxSummary): void {
    const preference = this.folders[mailbox.path] ??= {};
    const row = container.createDiv({ cls: `oxm-folder-manager-row ${preference.hidden ? "is-hidden" : ""}` });
    const icon = row.createSpan({ cls: "oxm-folder-manager-icon" });
    setIcon(icon, mailbox.role ? "folder-lock" : "folder");
    const copy = row.createDiv({ cls: "oxm-folder-manager-copy" });
    const nameLine = copy.createDiv({ cls: "oxm-folder-manager-name-line" });
    nameLine.createSpan({ cls: "oxm-folder-manager-name", text: preference.label?.trim() || mailbox.name });
    if (mailbox.role) nameLine.createSpan({ cls: "oxm-folder-manager-badge", text: t("Системная", "System") });
    const metadata = copy.createDiv({ cls: "oxm-folder-manager-metadata" });
    metadata.createSpan({ text: mailbox.path });
    if (preference.label?.trim()) metadata.createSpan({ text: t("Своё название", "Custom name") });
    const visibility = row.createEl("button", { cls: `oxm-folder-visibility ${preference.hidden ? "" : "is-active"}`, attr: { type: "button", "aria-label": preference.hidden ? t("Показать папку", "Show folder") : t("Скрыть папку", "Hide folder") } });
    setIcon(visibility, preference.hidden ? "eye-off" : "eye");
    visibility.createSpan({ text: preference.hidden ? t("Скрыта", "Hidden") : t("Показана", "Visible") });
    visibility.addEventListener("click", () => { preference.hidden = !preference.hidden; this.render(); });
    const more = row.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": t("Действия с папкой", "Folder actions"), title: t("Действия с папкой", "Folder actions") } });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (event) => this.showMailboxActions(event, mailbox));
  }

  private showMailboxActions(event: MouseEvent, mailbox: MailboxSummary): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(t("Изменить название в клиенте", "Change name in client")).setIcon("pencil-line").onClick(() => this.editClientLabel(mailbox)));
    if (this.folders[mailbox.path]?.label) menu.addItem((item) => item.setTitle(t("Вернуть исходное название", "Restore original name")).setIcon("rotate-ccw").onClick(() => {
      const preference = this.folders[mailbox.path];
      if (preference) preference.label = undefined;
      this.render();
    }));
    if (!mailbox.role) {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(t("Переименовать на сервере", "Rename on server")).setIcon("folder-pen").onClick(() => this.renameServerMailbox(mailbox)));
      menu.addItem((item) => item.setTitle(t("Удалить папку", "Delete folder")).setIcon("trash-2").onClick(() => this.removeServerMailbox(mailbox)));
    }
    menu.showAtMouseEvent(event);
  }

  private editClientLabel(mailbox: MailboxSummary): void {
    new TextPromptModal(this.app, t("Название в клиенте", "Name in client"), t("Название папки", "Folder name"), this.folders[mailbox.path]?.label ?? mailbox.name, async (value) => {
      const preference = this.folders[mailbox.path] ??= {};
      preference.label = value.trim() || undefined;
      this.render();
    }).open();
  }

  private renameServerMailbox(mailbox: MailboxSummary): void {
    new TextPromptModal(this.app, t("Переименовать папку", "Rename folder"), t("Новое название", "New name"), mailbox.path, async (value) => {
      await this.service.renameMailbox(this.account.id, mailbox.path, value);
      const nextPath = value.trim();
      const preference = this.folders[mailbox.path];
      if (nextPath && preference) {
        this.folders[nextPath] = preference;
        delete this.folders[mailbox.path];
      }
      this.render();
    }).open();
  }

  private removeServerMailbox(mailbox: MailboxSummary): void {
    new ConfirmModal(this.app, t("Удалить папку?", "Delete folder?"), t("Письма в этой папке могут быть удалены сервером.", "Messages in this folder may be deleted by the server."), async () => {
      await this.service.deleteMailbox(this.account.id, mailbox.path);
      delete this.folders[mailbox.path];
      this.render();
    }).open();
  }

  private async save(): Promise<void> {
    try {
      await this.persistFolders();
      new Notice(t("Настройки папок сохранены", "Folder settings saved"));
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("Не удалось сохранить настройки папок", "Could not save folder settings"));
    }
  }

  private async persistFolders(): Promise<void> {
    this.account.folders = this.folders;
    await this.saveSettings();
  }
}

class MailboxPickerModal extends Modal {
  constructor(app: App, private readonly mailboxes: MailboxSummary[], private readonly heading: string, private readonly onPick: (path: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.heading);
    const list = this.contentEl.createDiv({ cls: "oxm-mailbox-picker" });
    for (const mailbox of this.mailboxes) {
      const button = list.createEl("button", { text: mailbox.name });
      button.addEventListener("click", () => void this.pick(mailbox.path));
    }
  }
  onClose(): void { this.contentEl.empty(); }
  private async pick(path: string): Promise<void> {
    try { await this.onPick(path); this.close(); }
    catch (error) { new Notice(error instanceof Error ? error.message : t("Не удалось выполнить действие", "The action failed")); }
  }
}

class TextPromptModal extends Modal {
  private value: string;
  constructor(app: App, private readonly heading: string, private readonly label: string, initialValue: string, private readonly onSubmit: (value: string) => Promise<void>) {
    super(app);
    this.value = initialValue;
  }
  onOpen(): void {
    this.titleEl.setText(this.heading);
    new Setting(this.contentEl).setName(this.label).addText((input) => input.setValue(this.value).onChange((value) => { this.value = value; }));
    const actions = this.contentEl.createDiv({ cls: "oxm-modal-actions" });
    actions.createEl("button", { text: t("Отмена", "Cancel") }).addEventListener("click", () => this.close());
    actions.createEl("button", { cls: "mod-cta", text: t("Сохранить", "Save") }).addEventListener("click", () => void this.submit());
  }
  onClose(): void { this.contentEl.empty(); }
  private async submit(): Promise<void> {
    try { await this.onSubmit(this.value); this.close(); }
    catch (error) { new Notice(error instanceof Error ? error.message : t("Не удалось выполнить действие", "The action failed")); }
  }
}

class ConfirmModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly description: string, private readonly onConfirm: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.description });
    const actions = this.contentEl.createDiv({ cls: "oxm-modal-actions" });
    actions.createEl("button", { text: t("Отмена", "Cancel") }).addEventListener("click", () => this.close());
    actions.createEl("button", { cls: "mod-warning", text: t("Удалить", "Delete") }).addEventListener("click", () => void this.confirm());
  }
  onClose(): void { this.contentEl.empty(); }
  private async confirm(): Promise<void> {
    try { await this.onConfirm(); this.close(); }
    catch (error) { new Notice(error instanceof Error ? error.message : t("Не удалось выполнить действие", "The action failed")); }
  }
}
