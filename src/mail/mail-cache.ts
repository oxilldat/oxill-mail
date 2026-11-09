import type { MailMessage, MailMessageSummary, MailboxSummary } from "../types";

export interface CachedMailbox {
  mailbox: MailboxSummary;
  messages: MailMessageSummary[];
  uidValidity?: string;
  updatedAt: number;
}

interface MailboxRecord extends CachedMailbox { key: string; accountId: string; path: string }
interface MessageRecord { key: string; accountId: string; lastAccess: number; message: MailMessage }

export class MailCache {
  private database?: Promise<IDBDatabase>;

  constructor(private readonly namespace: string) {}

  async loadAccount(accountId: string): Promise<CachedMailbox[]> {
    try {
      const records = await this.getAll<MailboxRecord>("mailboxes");
      return records.filter((record) => record.accountId === accountId).map(({ mailbox, messages, uidValidity, updatedAt }) => ({ mailbox, messages, uidValidity, updatedAt }));
    } catch { return []; }
  }

  async saveMailbox(accountId: string, mailbox: MailboxSummary, messages: MailMessageSummary[], uidValidity?: bigint): Promise<void> {
    try {
      await this.put("mailboxes", { key: this.mailboxKey(accountId, mailbox.path), accountId, path: mailbox.path, mailbox, messages, uidValidity: uidValidity?.toString(), updatedAt: Date.now() } satisfies MailboxRecord);
    } catch { /* Cache failures must never break mail. */ }
  }

  async deleteMailbox(accountId: string, path: string): Promise<void> {
    try {
      await this.delete("mailboxes", this.mailboxKey(accountId, path));
      const prefix = `${accountId}\u0000${path}\u0000`;
      const messages = await this.getAll<MessageRecord>("messages");
      await Promise.all(messages.filter((record) => record.key.startsWith(prefix)).map((record) => this.delete("messages", record.key)));
    } catch { /* noop */ }
  }

  async loadMessage(accountId: string, mailbox: string, uid: number): Promise<MailMessage | undefined> {
    try {
      const key = this.messageKey(accountId, mailbox, uid);
      const record = await this.get<MessageRecord>("messages", key);
      if (!record) return undefined;
      record.lastAccess = Date.now();
      await this.put("messages", record);
      return record.message;
    } catch { return undefined; }
  }

  async saveMessage(accountId: string, message: MailMessage): Promise<void> {
    try {
      await this.put("messages", { key: this.messageKey(accountId, message.mailbox, message.uid), accountId, lastAccess: Date.now(), message } satisfies MessageRecord);
      const records = (await this.getAll<MessageRecord>("messages")).filter((record) => record.accountId === accountId).sort((a, b) => b.lastAccess - a.lastAccess);
      await Promise.all(records.slice(20).map((record) => this.delete("messages", record.key)));
    } catch { /* noop */ }
  }

  async deleteMessage(accountId: string, mailbox: string, uid: number): Promise<void> {
    try { await this.delete("messages", this.messageKey(accountId, mailbox, uid)); } catch { /* noop */ }
  }

  private mailboxKey(accountId: string, path: string): string { return `${accountId}\u0000${path}`; }
  private messageKey(accountId: string, mailbox: string, uid: number): string { return `${accountId}\u0000${mailbox}\u0000${uid}`; }

  private async open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(`oxill-mail-cache:${this.namespace}`, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("mailboxes")) database.createObjectStore("mailboxes", { keyPath: "key" });
        if (!database.objectStoreNames.contains("messages")) database.createObjectStore("messages", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(this.requestError(request.error));
    });
    return this.database;
  }

  private async get<T>(storeName: string, key: string): Promise<T | undefined> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(this.requestError(request.error));
    });
  }

  private async getAll<T>(storeName: string): Promise<T[]> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(this.requestError(request.error));
    });
  }

  private async put(storeName: string, value: unknown): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(storeName, "readwrite").objectStore(storeName).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(this.requestError(request.error));
    });
  }

  private async delete(storeName: string, key: string): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(storeName, "readwrite").objectStore(storeName).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(this.requestError(request.error));
    });
  }

  private requestError(error: DOMException | null): Error {
    return error ?? new Error("IndexedDB request failed");
  }
}
