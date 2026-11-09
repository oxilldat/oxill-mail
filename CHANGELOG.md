# Changelog

## 0.1.1 — Submission fixes

- Removed the redundant product name from the manifest description.
- Replaced direct style assignments with Obsidian CSS helpers.
- Adopted the Obsidian 1.13 declarative settings API.
- Fixed popout-compatible timers, typed IMAP chunks, IndexedDB errors, and plugin unload behavior.
- Removed unnecessary type assertions and `!important` declarations reported by the community-plugin scanner.

## 0.1.0 — Early Access

First public experimental build of Oxill Mail.

### Included

- Multiple direct IMAP and SMTP accounts.
- IMAP IDLE updates, reconnects, and a local IndexedDB cache.
- Reading sanitized HTML and plain-text messages.
- Compose, reply, reply all, forward, Bcc, drafts, and attachments.
- Read, unread, star, move, copy, delete, restore, and bulk actions.
- Incremental history loading and quick message filters.
- Server folder management and custom client labels.
- Saving messages and attachments into the Obsidian vault.
- Optional sender photos from Person Network.
- Russian and English interface.

### Known limitations

- This is an experimental build and has not been validated against a broad provider matrix.
- OAuth is not available; accounts must support password or application-password authentication.
- Search only filters locally loaded metadata and is not full-text or server-wide.
- Restoring from Trash moves a message to Inbox because IMAP does not retain its previous folder.
- Notifications, conversation threads, and automatic draft saving are not implemented.
- Desktop Obsidian 1.13.0 or later is required.
