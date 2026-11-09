import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

import type { AccountSnapshot, ComposeMessage, MailAccount, MailMessage, MailMessageSummary, MailboxSummary, MessageLoadProgress } from "../types";
import { MailCache } from "./mail-cache";
import type { MailService, MailServiceEvents } from "./mail-service";

type Listener = (...args: never[]) => void;

interface AccountRuntime {
  client: ImapFlow;
  snapshot: AccountSnapshot;
  stopping: boolean;
  reconnectTimer?: number;
  messagesByMailbox: Map<string, MailMessageSummary[]>;
  messageCache: Map<string, MailMessage>;
  mailboxSyncs: Map<string, Promise<void>>;
  uidValidityByMailbox: Map<string, string>;
  windowSizeByMailbox: Map<string, number>;
}

export class ImapMailService implements MailService {
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly listeners = new Map<keyof MailServiceEvents, Set<Listener>>();
  private readonly persistentCache: MailCache;

  constructor(
    private readonly getAccounts: () => MailAccount[],
    private readonly getPassword: (secretId: string) => string | null,
    cacheNamespace = "default",
  ) { this.persistentCache = new MailCache(cacheNamespace); }

  async start(): Promise<void> {
    await Promise.all(this.getAccounts().filter((account) => account.enabled).map((account) => this.connect(account)));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async (runtime) => {
      runtime.stopping = true;
      if (runtime.reconnectTimer) window.clearTimeout(runtime.reconnectTimer);
      try { await runtime.client.logout(); } catch { runtime.client.close(); }
    }));
    this.runtimes.clear();
  }

  async sync(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => this.syncMailbox(runtime, runtime.snapshot.activeMailboxPath ?? "INBOX")));
  }

  async openMailbox(accountId: string, mailbox: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) throw new Error("Аккаунт не подключён");
    runtime.snapshot.activeMailboxPath = mailbox;
    runtime.snapshot.messages = runtime.messagesByMailbox.get(mailbox) ?? [];
    runtime.snapshot.loadingMailboxPath = mailbox;
    this.emit("changed");
    await this.syncMailbox(runtime, mailbox);
  }

  async loadMore(accountId: string, mailbox: string): Promise<void> {
    const runtime = this.runtime(accountId);
    const current = runtime.windowSizeByMailbox.get(mailbox) ?? Math.max(100, runtime.messagesByMailbox.get(mailbox)?.length ?? 0);
    runtime.windowSizeByMailbox.set(mailbox, current + 100);
    runtime.snapshot.loadingOlderMailboxPath = mailbox;
    this.emit("changed");
    try { await this.syncMailbox(runtime, mailbox); }
    finally {
      if (runtime.snapshot.loadingOlderMailboxPath === mailbox) runtime.snapshot.loadingOlderMailboxPath = undefined;
      this.emit("changed");
    }
  }

  snapshots(): AccountSnapshot[] {
    return [...this.runtimes.values()].map(({ snapshot }) => snapshot);
  }

  async loadMessage(accountId: string, mailbox: string, uid: number, onProgress?: (progress: MessageLoadProgress) => void): Promise<MailMessage> {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) throw new Error("Аккаунт не подключён");
    if (!Number.isInteger(uid) || uid <= 0) throw new Error("У письма отсутствует корректный UID. Обновите папку и попробуйте снова.");
    const cacheKey = this.messageCacheKey(mailbox, uid);
    const cached = runtime.messageCache.get(cacheKey);
    if (cached) {
      runtime.messageCache.delete(cacheKey);
      const normalized = this.normalizeMessage(cached);
      runtime.messageCache.set(cacheKey, normalized);
      onProgress?.({ stage: "ready" });
      return normalized;
    }
    onProgress?.({ stage: "fetching" });
    const persisted = await this.persistentCache.loadMessage(accountId, mailbox, uid);
    if (persisted) {
      const normalized = this.normalizeMessage(persisted);
      this.cacheMessage(runtime, cacheKey, normalized);
      onProgress?.({ stage: "ready" });
      return normalized;
    }
    const lock = await runtime.client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const item = await runtime.client.fetchOne(String(uid), { uid: true, envelope: true, flags: true }, { uid: true });
      if (!item) throw new Error("Письмо не найдено");
      const download = await runtime.client.download(String(uid), undefined, { uid: true, maxBytes: 25 * 1024 * 1024 });
      const chunks: Buffer[] = [];
      let loadedBytes = 0;
      let lastReportedBytes = 0;
      const totalBytes = download.meta.expectedSize;
      onProgress?.({ stage: "downloading", loadedBytes, totalBytes });
      for await (const rawChunk of download.content) {
        const chunk: unknown = rawChunk;
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : typeof chunk === "string"
              ? Buffer.from(chunk)
              : undefined;
        if (!buffer) throw new Error("Почтовый сервер вернул неизвестный формат данных");
        chunks.push(buffer);
        loadedBytes += buffer.length;
        if (loadedBytes - lastReportedBytes >= 64 * 1024 || loadedBytes >= totalBytes) {
          lastReportedBytes = loadedBytes;
          onProgress?.({ stage: "downloading", loadedBytes, totalBytes });
        }
      }
      onProgress?.({ stage: "parsing", loadedBytes, totalBytes });
      const message = await this.toMessage(runtime.snapshot.account, mailbox, item, Buffer.concat(chunks));
      this.cacheMessage(runtime, cacheKey, message);
      void this.persistentCache.saveMessage(accountId, message);
      onProgress?.({ stage: "ready", loadedBytes, totalBytes });
      return message;
    } finally { lock.release(); }
  }

  async setSeen(accountId: string, mailbox: string, uid: number, seen: boolean): Promise<void> {
    await this.setMessageFlag(accountId, mailbox, uid, "\\Seen", seen);
  }

  async setSeenMany(accountId: string, mailbox: string, uids: number[], seen: boolean): Promise<void> {
    await this.setMessageFlags(accountId, mailbox, uids, "\\Seen", seen);
  }

  async setFlagged(accountId: string, mailbox: string, uid: number, flagged: boolean): Promise<void> {
    await this.setMessageFlag(accountId, mailbox, uid, "\\Flagged", flagged);
  }

  async setFlaggedMany(accountId: string, mailbox: string, uids: number[], flagged: boolean): Promise<void> {
    await this.setMessageFlags(accountId, mailbox, uids, "\\Flagged", flagged);
  }

  async moveMessage(accountId: string, mailbox: string, uid: number, destination: string): Promise<void> {
    await this.moveMessages(accountId, mailbox, [uid], destination);
  }

  async moveMessages(accountId: string, mailbox: string, uids: number[], destination: string): Promise<void> {
    if (!uids.length) return;
    const runtime = this.runtime(accountId);
    await this.withMailbox(runtime, mailbox, async () => {
      const moved = await runtime.client.messageMove(uids, destination, { uid: true });
      if (!moved) throw new Error("Сервер не подтвердил перемещение письма");
    });
    for (const uid of uids) {
      runtime.messageCache.delete(this.messageCacheKey(mailbox, uid));
      void this.persistentCache.deleteMessage(accountId, mailbox, uid);
    }
    await this.refreshAfterMessageChange(runtime, mailbox, destination);
  }

  async copyMessage(accountId: string, mailbox: string, uid: number, destination: string): Promise<void> {
    const runtime = this.runtime(accountId);
    await this.withMailbox(runtime, mailbox, async () => {
      const copied = await runtime.client.messageCopy([uid], destination, { uid: true });
      if (!copied) throw new Error("Сервер не подтвердил копирование письма");
    });
    await this.syncMailbox(runtime, destination);
  }

  async deleteMessage(accountId: string, mailbox: string, uid: number): Promise<void> {
    await this.deleteMessages(accountId, mailbox, [uid]);
  }

  async deleteMessages(accountId: string, mailbox: string, uids: number[]): Promise<void> {
    if (!uids.length) return;
    const runtime = this.runtime(accountId);
    const trash = this.specialMailbox(runtime, "trash");
    if (trash && trash.path !== mailbox) {
      await this.moveMessages(accountId, mailbox, uids, trash.path);
      return;
    }
    await this.withMailbox(runtime, mailbox, async () => {
      const deleted = await runtime.client.messageDelete(uids, { uid: true });
      if (!deleted) throw new Error("Сервер не подтвердил удаление письма");
    });
    for (const uid of uids) {
      runtime.messageCache.delete(this.messageCacheKey(mailbox, uid));
      void this.persistentCache.deleteMessage(accountId, mailbox, uid);
    }
    await this.syncMailbox(runtime, mailbox);
  }

  async restoreMessage(accountId: string, mailbox: string, uid: number): Promise<void> {
    const runtime = this.runtime(accountId);
    const inbox = this.specialMailbox(runtime, "inbox")?.path ?? "INBOX";
    await this.moveMessage(accountId, mailbox, uid, inbox);
  }

  async createMailbox(accountId: string, path: string): Promise<void> {
    const runtime = this.runtime(accountId);
    const normalized = this.requiredPath(path);
    await runtime.client.mailboxCreate(normalized);
    await this.loadMailboxes(runtime);
    this.emit("changed");
  }

  async renameMailbox(accountId: string, path: string, newPath: string): Promise<void> {
    const runtime = this.runtime(accountId);
    const normalized = this.requiredPath(newPath);
    await runtime.client.mailboxRename(path, normalized);
    runtime.messagesByMailbox.delete(path);
    this.clearMailboxCache(runtime, path);
    void this.persistentCache.deleteMailbox(accountId, path);
    await this.loadMailboxes(runtime);
    if (runtime.snapshot.activeMailboxPath === path) await this.openMailbox(accountId, normalized);
    else this.emit("changed");
  }

  async deleteMailbox(accountId: string, path: string): Promise<void> {
    const runtime = this.runtime(accountId);
    await runtime.client.mailboxDelete(path);
    runtime.messagesByMailbox.delete(path);
    this.clearMailboxCache(runtime, path);
    void this.persistentCache.deleteMailbox(accountId, path);
    await this.loadMailboxes(runtime);
    if (runtime.snapshot.activeMailboxPath === path) {
      const inbox = this.specialMailbox(runtime, "inbox")?.path ?? "INBOX";
      await this.openMailbox(accountId, inbox);
    } else this.emit("changed");
  }

  async saveDraft(accountId: string, message: ComposeMessage): Promise<void> {
    const runtime = this.runtime(accountId);
    const drafts = this.specialMailbox(runtime, "drafts");
    if (!drafts) throw new Error("Сервер не сообщил папку черновиков");
    const raw = await this.buildRawMessage(runtime.snapshot.account, message);
    const appended = await runtime.client.append(drafts.path, raw, ["\\Draft"], new Date());
    if (!appended) throw new Error("Сервер не сохранил черновик");
    if (message.draftSource) await this.discardDraft(runtime, message.draftSource.mailbox, message.draftSource.uid);
    await this.syncMailbox(runtime, drafts.path);
  }

  async sendMessage(accountId: string, message: ComposeMessage): Promise<void> {
    const runtime = this.runtime(accountId);
    if (!message.to.length) throw new Error("Укажите хотя бы одного получателя");
    const password = this.getPassword(runtime.snapshot.account.secretId);
    if (!password) throw new Error("Не найден пароль приложения");
    const account = runtime.snapshot.account;
    const transport = nodemailer.createTransport({
      host: account.smtpHost.trim(),
      port: account.smtpPort,
      secure: account.smtpPort === 465,
      auth: { user: account.username.trim(), pass: password },
    });
    const raw = await this.buildRawMessage(account, message);
    await transport.sendMail({
      raw,
      envelope: { from: account.email, to: [...message.to, ...message.cc, ...message.bcc] },
    });
    const sent = this.specialMailbox(runtime, "sent");
    if (sent) {
      const appended = await runtime.client.append(sent.path, raw, ["\\Seen"], new Date());
      if (!appended) throw new Error("Письмо отправлено, но сервер не сохранил копию в отправленных");
      await this.syncMailbox(runtime, sent.path);
    }
    if (message.draftSource) await this.discardDraft(runtime, message.draftSource.mailbox, message.draftSource.uid);
  }

  on<K extends keyof MailServiceEvents>(event: K, listener: MailServiceEvents[K]): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  private async connect(account: MailAccount): Promise<void> {
    const password = this.getPassword(account.secretId);
    const snapshot: AccountSnapshot = { account, state: "connecting", mailboxes: [], messages: [] };
    const runtime: AccountRuntime = { client: this.createClient(account, password ?? ""), snapshot, stopping: !password, messagesByMailbox: new Map(), messageCache: new Map(), mailboxSyncs: new Map(), uidValidityByMailbox: new Map(), windowSizeByMailbox: new Map() };
    const cachedMailboxes = await this.persistentCache.loadAccount(account.id);
    for (const cached of cachedMailboxes) {
      runtime.snapshot.mailboxes.push({ ...cached.mailbox });
      runtime.messagesByMailbox.set(cached.mailbox.path, cached.messages);
      runtime.windowSizeByMailbox.set(cached.mailbox.path, Math.max(100, cached.messages.length));
      if (cached.uidValidity) runtime.uidValidityByMailbox.set(cached.mailbox.path, cached.uidValidity);
    }
    const cachedInbox = runtime.snapshot.mailboxes.find((mailbox) => mailbox.role === "inbox")?.path ?? runtime.snapshot.mailboxes[0]?.path;
    if (cachedInbox) {
      runtime.snapshot.activeMailboxPath = cachedInbox;
      runtime.snapshot.messages = runtime.messagesByMailbox.get(cachedInbox) ?? [];
    }
    this.runtimes.set(account.id, runtime);
    this.emit("changed");
    if (!password) {
      snapshot.state = "error";
      snapshot.error = "Не найден пароль в Keychain";
      this.emit("changed");
      return;
    }
    this.bindConnectionEvents(runtime);
    try {
      await runtime.client.connect();
      runtime.snapshot.state = "online";
      await this.loadMailboxes(runtime);
      const inbox = runtime.snapshot.mailboxes.find((box) => box.role === "inbox")?.path ?? "INBOX";
      runtime.snapshot.activeMailboxPath = inbox;
      runtime.snapshot.messages = runtime.messagesByMailbox.get(inbox) ?? [];
      runtime.snapshot.loadingMailboxPath = inbox;
      this.emit("changed");
      await this.syncMailbox(runtime, inbox);
      this.emit("changed");
    } catch (error) {
      runtime.snapshot.state = "error";
      runtime.snapshot.error = this.errorText(error);
      this.emit("changed");
      this.scheduleReconnect(runtime);
    }
  }

  private runtime(accountId: string): AccountRuntime {
    const runtime = this.runtimes.get(accountId);
    if (!runtime || !runtime.client.usable) throw new Error("Аккаунт не подключён");
    return runtime;
  }

  private async withMailbox(runtime: AccountRuntime, mailbox: string, action: () => Promise<void>): Promise<void> {
    const lock = await runtime.client.getMailboxLock(mailbox);
    try { await action(); } finally { lock.release(); }
  }

  private async setMessageFlag(accountId: string, mailbox: string, uid: number, flag: string, enabled: boolean): Promise<void> {
    await this.setMessageFlags(accountId, mailbox, [uid], flag, enabled);
  }

  private async setMessageFlags(accountId: string, mailbox: string, uids: number[], flag: string, enabled: boolean): Promise<void> {
    if (!uids.length) return;
    const runtime = this.runtime(accountId);
    await this.withMailbox(runtime, mailbox, async () => {
      const changed = enabled
        ? await runtime.client.messageFlagsAdd(uids, [flag], { uid: true })
        : await runtime.client.messageFlagsRemove(uids, [flag], { uid: true });
      if (!changed) throw new Error("Сервер не подтвердил изменение письма");
    });
    await this.syncMailbox(runtime, mailbox);
  }

  private async refreshAfterMessageChange(runtime: AccountRuntime, source: string, destination: string): Promise<void> {
    await this.syncMailbox(runtime, source);
    if (destination !== source) await this.syncMailbox(runtime, destination);
  }

  private specialMailbox(runtime: AccountRuntime, role: MailboxSummary["role"]): MailboxSummary | undefined {
    return runtime.snapshot.mailboxes.find((mailbox) => mailbox.role === role);
  }

  private requiredPath(path: string): string {
    const normalized = path.trim();
    if (!normalized) throw new Error("Введите название папки");
    return normalized;
  }

  private messageOptions(account: MailAccount, message: ComposeMessage) {
    return {
      from: account.email,
      to: message.to.join(", "),
      cc: message.cc.length ? message.cc.join(", ") : undefined,
      bcc: message.bcc.length ? message.bcc.join(", ") : undefined,
      subject: message.subject,
      text: message.text,
      inReplyTo: message.inReplyTo,
      references: message.references,
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: Buffer.from(attachment.content),
        cid: attachment.contentId,
      })),
    };
  }

  private async discardDraft(runtime: AccountRuntime, mailbox: string, uid: number): Promise<void> {
    await this.withMailbox(runtime, mailbox, async () => {
      await runtime.client.messageDelete([uid], { uid: true });
    });
    runtime.messageCache.delete(this.messageCacheKey(mailbox, uid));
    void this.persistentCache.deleteMessage(runtime.snapshot.account.id, mailbox, uid);
  }

  private async buildRawMessage(account: MailAccount, message: ComposeMessage): Promise<Buffer> {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
    const info = await transport.sendMail(this.messageOptions(account, message));
    if (!Buffer.isBuffer(info.message)) throw new Error("Не удалось сформировать письмо");
    return info.message;
  }

  private createClient(account: MailAccount, password: string): ImapFlow {
    return new ImapFlow({
      host: account.imapHost.trim(),
      port: account.imapPort,
      secure: account.imapPort === 993,
      auth: { user: account.username.trim(), pass: password },
      logger: false,
      emitLogs: false,
      maxIdleTime: 25 * 60 * 1000,
    });
  }

  private bindConnectionEvents(runtime: AccountRuntime): void {
    runtime.client.on("exists", () => void this.syncMailbox(runtime, runtime.snapshot.activeMailboxPath ?? "INBOX"));
    runtime.client.on("flags", () => void this.syncMailbox(runtime, runtime.snapshot.activeMailboxPath ?? "INBOX"));
    runtime.client.on("close", () => {
      if (runtime.stopping) return;
      runtime.snapshot.state = "offline";
      this.emit("changed");
      this.scheduleReconnect(runtime);
    });
    runtime.client.on("error", (error) => {
      runtime.snapshot.error = this.errorText(error);
      this.emit("changed");
    });
  }

  private scheduleReconnect(runtime: AccountRuntime): void {
    if (runtime.stopping || runtime.reconnectTimer) return;
    runtime.reconnectTimer = window.setTimeout(() => {
      runtime.reconnectTimer = undefined;
      this.runtimes.delete(runtime.snapshot.account.id);
      void this.connect(runtime.snapshot.account);
    }, 15_000);
  }

  private async loadMailboxes(runtime: AccountRuntime): Promise<void> {
    const boxes = await runtime.client.list();
    const previous = new Map(runtime.snapshot.mailboxes.map((mailbox) => [mailbox.path, mailbox]));
    const serverPaths = new Set(boxes.map((box) => box.path));
    for (const path of previous.keys()) if (!serverPaths.has(path)) {
      runtime.messagesByMailbox.delete(path);
      runtime.uidValidityByMailbox.delete(path);
      this.clearMailboxCache(runtime, path);
      void this.persistentCache.deleteMailbox(runtime.snapshot.account.id, path);
    }
    runtime.snapshot.mailboxes = boxes.map((box): MailboxSummary => ({
      path: box.path,
      name: box.name,
      unread: previous.get(box.path)?.unread ?? 0,
      total: previous.get(box.path)?.total ?? 0,
      role: this.role(box.specialUse),
    }));
  }

  private async syncMailbox(runtime: AccountRuntime, mailboxPath: string): Promise<void> {
    if (!runtime.client.usable) return;
    const existing = runtime.mailboxSyncs.get(mailboxPath);
    if (existing) return existing;
    const sync = this.performMailboxSync(runtime, mailboxPath).finally(() => {
      runtime.mailboxSyncs.delete(mailboxPath);
      if (runtime.snapshot.loadingMailboxPath === mailboxPath) runtime.snapshot.loadingMailboxPath = undefined;
      this.emit("changed");
    });
    runtime.mailboxSyncs.set(mailboxPath, sync);
    return sync;
  }

  private async performMailboxSync(runtime: AccountRuntime, mailboxPath: string): Promise<void> {
    const mailbox = runtime.snapshot.mailboxes.find((box) => box.path === mailboxPath)
      ?? { path: mailboxPath, name: mailboxPath, unread: 0, total: 0 };
    const lock = await runtime.client.getMailboxLock(mailbox.path, { readOnly: true });
    try {
      const status = await runtime.client.status(mailbox.path, { messages: true, unseen: true, uidValidity: true });
      mailbox.total = status.messages ?? 0;
      mailbox.unread = status.unseen ?? 0;
      if (!runtime.snapshot.mailboxes.some((box) => box.path === mailbox.path)) runtime.snapshot.mailboxes.unshift(mailbox);
      let cached = runtime.messagesByMailbox.get(mailbox.path) ?? [];
      const windowSize = runtime.windowSizeByMailbox.get(mailbox.path) ?? Math.max(100, cached.length);
      runtime.windowSizeByMailbox.set(mailbox.path, windowSize);
      const start = Math.max(1, mailbox.total - windowSize + 1);
      const validity = status.uidValidity?.toString();
      const cachedValidity = runtime.uidValidityByMailbox.get(mailbox.path);
      if (validity && cachedValidity && validity !== cachedValidity) {
        cached = [];
        runtime.messagesByMailbox.delete(mailbox.path);
        this.clearMailboxCache(runtime, mailbox.path);
        void this.persistentCache.deleteMailbox(runtime.snapshot.account.id, mailbox.path);
      }
      const ordered = mailbox.total <= 0 ? [] : cached.length
        ? await this.refreshCachedMessages(runtime, mailbox.path, start, cached)
        : await this.fetchInitialMessages(runtime, mailbox.path, start, mailbox.total);
      if (validity) runtime.uidValidityByMailbox.set(mailbox.path, validity);
      runtime.messagesByMailbox.set(mailbox.path, ordered);
      if (runtime.snapshot.activeMailboxPath === mailbox.path) runtime.snapshot.messages = ordered;
      if (runtime.snapshot.loadingMailboxPath === mailbox.path) runtime.snapshot.loadingMailboxPath = undefined;
      runtime.snapshot.state = "online";
      runtime.snapshot.error = undefined;
      this.emit("changed");
      void this.persistentCache.saveMailbox(runtime.snapshot.account.id, mailbox, ordered, status.uidValidity);
    } finally { lock.release(); }
  }

  private async fetchInitialMessages(runtime: AccountRuntime, mailboxPath: string, start: number, total: number): Promise<MailMessageSummary[]> {
    const messages: MailMessageSummary[] = [];
    if (total > 0) for await (const item of runtime.client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true, bodyStructure: true })) {
      messages.push(this.toSummary(runtime.snapshot.account, mailboxPath, item));
    }
    return messages.reverse();
  }

  private async refreshCachedMessages(runtime: AccountRuntime, mailboxPath: string, start: number, cached: MailMessageSummary[]): Promise<MailMessageSummary[]> {
    const byUid = new Map(cached.map((message) => [message.uid, message]));
    const orderedUids: number[] = [];
    if (start > 0) for await (const item of runtime.client.fetch(`${start}:*`, { uid: true, flags: true })) {
      orderedUids.push(item.uid);
      const existing = byUid.get(item.uid);
      if (existing) {
        existing.unread = !item.flags?.has("\\Seen");
        existing.flagged = item.flags?.has("\\Flagged") ?? false;
      }
    }
    const missing = orderedUids.filter((uid) => !byUid.has(uid));
    if (missing.length) for await (const item of runtime.client.fetch(missing, { uid: true, envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
      byUid.set(item.uid, this.toSummary(runtime.snapshot.account, mailboxPath, item));
    }
    return orderedUids.reverse().flatMap((uid) => {
      const message = byUid.get(uid);
      return message ? [message] : [];
    });
  }

  private toSummary(account: MailAccount, mailbox: string, item: FetchMessageObject): MailMessageSummary {
    const from = item.envelope?.from?.[0];
    return {
      id: `${account.id}:${mailbox}:${item.uid}`,
      accountId: account.id,
      mailbox,
      uid: item.uid,
      messageId: item.envelope?.messageId,
      subject: item.envelope?.subject || "(без темы)",
      fromName: from?.name || from?.address || "Неизвестный отправитель",
      fromAddress: from?.address || "",
      preview: "",
      receivedAt: item.envelope?.date?.getTime() ?? Date.now(),
      unread: !item.flags?.has("\\Seen"),
      flagged: item.flags?.has("\\Flagged") ?? false,
      hasAttachments: this.hasAttachment(item.bodyStructure),
    };
  }

  private async toMessage(account: MailAccount, mailbox: string, item: FetchMessageObject, source: Buffer): Promise<MailMessage> {
    const parsed = await simpleParser(source);
    const summary = this.toSummary(account, mailbox, item);
    return {
      ...summary,
      preview: (parsed.text ?? "").replace(/\s+/g, " ").slice(0, 180),
      to: parsed.to ? [parsed.to].flat().flatMap((value) => value.value.map((address) => address.address || "")) : [],
      cc: parsed.cc ? [parsed.cc].flat().flatMap((value) => value.value.map((address) => address.address || "")) : [],
      bcc: parsed.bcc ? [parsed.bcc].flat().flatMap((value) => value.value.map((address) => address.address || "")) : [],
      replyTo: parsed.replyTo?.value[0]?.address || undefined,
      references: parsed.references ? [parsed.references].flat() : [],
      text: parsed.text ?? "",
      html: typeof parsed.html === "string" ? parsed.html : undefined,
      hasAttachments: parsed.attachments.length > 0,
      attachments: parsed.attachments.map((attachment) => ({
        filename: attachment.filename || "attachment",
        contentType: attachment.contentType || "application/octet-stream",
        size: attachment.size,
        content: new Uint8Array(attachment.content),
        contentId: attachment.cid,
      })),
    };
  }

  private hasAttachment(node: FetchMessageObject["bodyStructure"]): boolean {
    if (!node) return false;
    if (node.disposition === "attachment") return true;
    return node.childNodes?.some((child) => this.hasAttachment(child)) ?? false;
  }

  private messageCacheKey(mailbox: string, uid: number): string { return `${mailbox}\u0000${uid}`; }

  private normalizeMessage(message: MailMessage): MailMessage {
    return {
      ...message,
      to: Array.isArray(message.to) ? message.to : [],
      cc: Array.isArray(message.cc) ? message.cc : [],
      bcc: Array.isArray(message.bcc) ? message.bcc : [],
      references: Array.isArray(message.references) ? message.references : [],
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
    };
  }

  private cacheMessage(runtime: AccountRuntime, key: string, message: MailMessage): void {
    runtime.messageCache.set(key, message);
    while (runtime.messageCache.size > 20) {
      const oldest = runtime.messageCache.keys().next().value;
      if (!oldest) break;
      runtime.messageCache.delete(oldest);
    }
  }

  private clearMailboxCache(runtime: AccountRuntime, mailbox: string): void {
    const prefix = `${mailbox}\u0000`;
    for (const key of runtime.messageCache.keys()) if (key.startsWith(prefix)) runtime.messageCache.delete(key);
  }

  private role(specialUse?: string): MailboxSummary["role"] {
    const roles: Record<string, MailboxSummary["role"]> = {
      "\\Inbox": "inbox", "\\Sent": "sent", "\\Drafts": "drafts", "\\Archive": "archive", "\\Trash": "trash", "\\Junk": "junk",
    };
    return specialUse ? roles[specialUse] : undefined;
  }

  private emit(event: keyof MailServiceEvents, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  private errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
