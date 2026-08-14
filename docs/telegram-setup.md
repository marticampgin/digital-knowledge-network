# Telegram setup

The application uses a dedicated Telegram **bot**, not a personal-account login. You do not need to send the bot token or group ID to anyone. Store both only in the repository's local `.env` file, which Git ignores.

The recommended long-term layout is a private supergroup with Topics enabled: General acts as an unclassified Inbox and each durable book/article/source has its own topic. See [Telegram capture workflow](telegram-user-workflow.md) for the complete user interaction.

## One-time preparation

1. In Telegram, open the verified **@BotFather** account.
2. Send `/newbot`, choose a display name such as `Digital Knowledge Inbox`, and choose a unique username ending in `bot`.
3. Copy the token BotFather returns. Anyone holding this token controls the bot, so do not paste it into chat, issues, commits, or screenshots.
4. In the project folder, copy `.env.example` to `.env` and set:

   ```dotenv
   TELEGRAM_BOT_TOKEN=the-token-from-botfather
   ```

5. Add the bot to the dedicated private group.
6. Choose one of these group visibility configurations:

   - Make the bot an administrator. This is simplest for a dedicated private capture group.
   - Or in BotFather run `/setprivacy`, choose the bot, select **Disable**, then remove and re-add the bot to the group so it receives ordinary messages.

The bot needs no permission to delete messages, add users, or change group settings.

## Discover the group ID

After the bot has joined, send a **new** text message such as `DKN connection test` in the group, then run:

```powershell
npm run dev -- telegram discover
```

The command prints the title, type, pending message count, and numeric chat ID. Group IDs are often negative. Copy the matching ID into `.env`:

```dotenv
TELEGRAM_CHAT_ID=-1001234567890
```

You can also provide it once with `--chat-id`; successful sync stores it in the local database:

```powershell
npm run dev -- telegram sync --chat-id -1001234567890
```

## Upload and synchronize test captures

Upload fresh examples only after the bot is connected:

- one text or Markdown message;
- one clear screenshot of an English book page;
- one short English Telegram voice note or audio file.

Then run:

```powershell
npm run dev -- telegram sync
npm run dev -- process --provider openai
npm run dev -- status
```

Sync is idempotent: source content is hashed, the Telegram update cursor is stored locally, and rerunning the command does not intentionally duplicate previously imported material.

For the capture-time and multi-page grouping test, also upload the same older screenshot twice: once as a normal compressed photo and once as a file/document. Keep its original filename. This lets the metadata importer verify what the actual phone and Telegram client preserve before chronology rules are enabled.

## Telegram limitations that affect testing

- Bot API updates are retained for at most 24 hours. A polling bot is not a historical group export tool.
- A bot cannot retrieve messages from before it was added. Upload the samples again after setup.
- Standard Bot API file downloads are limited to 20 MB. Keep initial audio samples below this size.
- Calling `discover` does not advance the saved application cursor; `sync` does.
- Telegram transports the files through Telegram's servers. Processing after download remains local, but Telegram capture itself is not end-to-end local storage.
- Telegram's message date is the send/upload time, not proof of when a screenshot was originally taken. The planned timeline model and fallbacks are documented in [Capture time, source context, grouping, and summaries](capture-context-and-summaries.md).

For a future always-on workflow, the local app can poll regularly or use a webhook. Polling is preferable for this local-first version because it requires no public endpoint.
