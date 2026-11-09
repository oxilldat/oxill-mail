# Oxill Mail 0.1.0 — Early Access

Oxill Mail brings a direct IMAP and SMTP mail client into Obsidian. The first public build can read, write, reply, forward, organize, and locally cache mail without an external proxy or telemetry service.

This release is intentionally marked **Early Access**. It is functional, but still raw: provider compatibility is incomplete, some workflows need refinement, and IMAP edge cases may produce unexpected behavior. Use a non-critical mailbox for initial testing and verify destructive actions in another client.

## Highlights

- Native three-column desktop mail interface.
- Direct IMAP IDLE synchronization and SMTP sending.
- Replies, forwarding, drafts, Bcc, and file attachments.
- Folder operations, quick filters, multi-selection, and bulk actions.
- Local cache for immediate reopening and incremental history loading.
- Save messages and attachments into the vault.
- Credentials stored through Obsidian SecretStorage.
- No telemetry, advertising, third-party proxy, or Oxill cloud account.

## Not ready yet

- OAuth authentication.
- Full-text and server-wide search.
- New-message notifications.
- Conversation view and automatic draft saving.
- Broad compatibility testing across mail providers.

Please report the provider, affected action, and exact error text without including credentials or private email content.
