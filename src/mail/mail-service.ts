import type { AccountSnapshot, ComposeMessage, MailMessage, MessageLoadProgress } from "../types";

export interface MailServiceEvents {
  changed: () => void;
  newMessage: (message: MailMessage) => void;
}

export interface MailService {
  start(): Promise<void>;
  stop(): Promise<void>;
  sync(): Promise<void>;
  openMailbox(accountId: string, mailbox: string): Promise<void>;
  loadMore(accountId: string, mailbox: string): Promise<void>;
  snapshots(): AccountSnapshot[];
  loadMessage(accountId: string, mailbox: string, uid: number, onProgress?: (progress: MessageLoadProgress) => void): Promise<MailMessage>;
  setSeen(accountId: string, mailbox: string, uid: number, seen: boolean): Promise<void>;
  setSeenMany(accountId: string, mailbox: string, uids: number[], seen: boolean): Promise<void>;
  setFlagged(accountId: string, mailbox: string, uid: number, flagged: boolean): Promise<void>;
  setFlaggedMany(accountId: string, mailbox: string, uids: number[], flagged: boolean): Promise<void>;
  moveMessage(accountId: string, mailbox: string, uid: number, destination: string): Promise<void>;
  moveMessages(accountId: string, mailbox: string, uids: number[], destination: string): Promise<void>;
  copyMessage(accountId: string, mailbox: string, uid: number, destination: string): Promise<void>;
  deleteMessage(accountId: string, mailbox: string, uid: number): Promise<void>;
  deleteMessages(accountId: string, mailbox: string, uids: number[]): Promise<void>;
  restoreMessage(accountId: string, mailbox: string, uid: number): Promise<void>;
  createMailbox(accountId: string, path: string): Promise<void>;
  renameMailbox(accountId: string, path: string, newPath: string): Promise<void>;
  deleteMailbox(accountId: string, path: string): Promise<void>;
  saveDraft(accountId: string, message: ComposeMessage): Promise<void>;
  sendMessage(accountId: string, message: ComposeMessage): Promise<void>;
  on<K extends keyof MailServiceEvents>(event: K, listener: MailServiceEvents[K]): () => void;
}
