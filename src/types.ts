export type MailLocale = "ru" | "en";
export type ConnectionState = "disabled" | "connecting" | "online" | "offline" | "error";

export interface MailAccount {
  id: string;
  name: string;
  email: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  secretId: string;
  enabled: boolean;
  folders?: Record<string, { label?: string; hidden?: boolean }>;
}

export interface OxillMailSettings {
  language: MailLocale;
  accounts: MailAccount[];
  fallbackSyncMinutes: number;
}

export interface MailMessageSummary {
  id: string;
  accountId: string;
  mailbox: string;
  uid: number;
  messageId?: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  preview: string;
  receivedAt: number;
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface MailMessage extends MailMessageSummary {
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  references: string[];
  text: string;
  html?: string;
  attachments: MailAttachment[];
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Uint8Array;
  contentId?: string;
}

export interface DraftSource {
  mailbox: string;
  uid: number;
}

export interface MessageLoadProgress {
  stage: "fetching" | "downloading" | "parsing" | "ready";
  loadedBytes?: number;
  totalBytes?: number;
}

export interface ComposeMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: MailAttachment[];
  inReplyTo?: string;
  references?: string[];
  draftSource?: DraftSource;
}

export interface MailboxSummary {
  path: string;
  name: string;
  unread: number;
  total: number;
  role?: "inbox" | "sent" | "drafts" | "archive" | "trash" | "junk";
}

export interface AccountSnapshot {
  account: MailAccount;
  state: ConnectionState;
  error?: string;
  mailboxes: MailboxSummary[];
  activeMailboxPath?: string;
  loadingMailboxPath?: string;
  loadingOlderMailboxPath?: string;
  messages: MailMessageSummary[];
}
