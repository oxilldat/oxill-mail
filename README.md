# Oxill Mail

Desktop email client for Obsidian. Oxill Mail connects directly to IMAP and SMTP servers, keeps mail current through IMAP IDLE events, and provides a native three-column mail view.

> [!WARNING]
> **Early Access / experimental release.** Oxill Mail 0.1.0 is an early public build intended for testing. It may contain bugs, incomplete workflows, provider-specific incompatibilities, and destructive IMAP edge cases. Start with a non-critical mailbox and verify important actions in your regular mail client.

## Current milestone

- multiple IMAP account configuration;
- passwords stored through Obsidian `SecretStorage`, never in `data.json`;
- automatic IMAP IDLE updates with a periodic fallback sync;
- vault-scoped IndexedDB cache that restores folders and messages immediately and refreshes only UID/flag changes in the background;
- mailbox discovery, inbox counters and the latest 100 messages;
- sanitized HTML and plain-text message reading;
- read/unread and flagged message state;
- moving, copying, deleting and restoring messages;
- creating, renaming and deleting custom mailboxes;
- SMTP composing with IMAP copies in Drafts and Sent;
- reply, reply-all and forward flows with thread headers;
- Bcc, outgoing file attachments and attachment saving into `Почта/Вложения`;
- reopening and replacing existing drafts instead of creating duplicate copies;
- incremental loading of older messages in batches of 100;
- quick filters for unread, starred and attachment-bearing messages;
- multi-selection with bulk read, unread, star, unstar, move and delete actions;
- saving a message as a Markdown note in the `Почта` vault folder;
- deterministic sender initials and optional local photos from Person Network notes matched by the `email` property;
- Russian and English UI;
- desktop-only operation without telemetry or third-party proxy servers.

OAuth and local full-text indexing are not implemented yet. Remote images in HTML messages are blocked by default. Restoring a message from Trash moves it to Inbox because standard IMAP does not preserve its previous mailbox. The local cache is device-only and is not written to Markdown, plugin `data.json`, or vault sync files.

## Installation

Oxill Mail is currently distributed as an Early Access build and is not yet listed in the Obsidian community directory.

Manual installation:

1. Download the release archive.
2. Extract `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/oxill-mail/`.
3. Restart Obsidian or reload community plugins.
4. Enable **Oxill Mail** under **Settings → Community plugins**.
5. Add an account in the plugin settings. Many providers require a separate application password.

## Privacy and security

- Connections go directly from the desktop plugin to the configured IMAP and SMTP servers.
- Passwords are stored through Obsidian `SecretStorage`, not in `data.json` or Markdown.
- There is no telemetry, advertising, external proxy, or Oxill cloud service.
- Email bodies and recent mailbox metadata are cached locally in vault-scoped IndexedDB storage on the current device.

## Feedback

When reporting a problem, include the provider, the affected action, the visible error message, and whether the same action works in the provider's regular mail client. Never include passwords, application passwords, or private message contents.

## Development

```sh
npm run check
npm test
npm run build
```

The plugin requires Obsidian 1.13.0 or newer because credentials use the public `SecretStorage` API.
