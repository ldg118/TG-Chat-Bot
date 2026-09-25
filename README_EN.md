# TG Chat Bot

[English](README_EN.md) | [中文](README.md)

A Telegram message forwarding bot running on Cloudflare Workers, with anti-spam and anti-scam protection.

## Features

- **Serverless**: Runs on Cloudflare Workers — low cost, high availability.
- **Message Forwarding**: Forwards user messages to the admin and replies back.
- **Operating Modes**:
  - **Private Chat Mode**: One-on-one forwarding, simple and lightweight.
  - **Topic Group Mode**: Creates a dedicated topic per user for organized management.
- **Anti-Spam & Anti-Scam**:
  - **Keyword Filtering**: Silently drops messages containing blacklisted keywords (e.g., 'scam', 'USDT').
  - **Dynamic Math Verification**: Unverified users solve a random math problem (e.g., 3+5=?) — configurable operators, range, and option count.
  - **Custom Q&A Verification**: maintain a bank of 1–20 questions instead of a single one; a random question is picked each time, and answers stay server-side.
  - **Security Levels**: Strict (mute), Standard (no media), Relaxed (no verification).
  - **Deduplication**: A user's identical content is not forwarded twice within 2 minutes.
  - **Block/Trust**: Shadowban (`/block`) or permanently trust (`/trust`) users.
- **Management Tools**:
  - **Broadcast**: Reply to a message to broadcast to all users (skips the blacklist).
  - **Visual Panel**: `/admin` menu with categorized, tap-to-run buttons.
  - **Bilingual UI**: Switch between Chinese and English.
  - **Multi-Bot**: Serve several bots from one Worker (shared D1, data isolated per bot), managed via `/bot` commands.
  - **Service Message Filtering**: Ignores join/leave and other system messages.

## Deploy to Cloudflare Workers

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ldg118/TG-Chat-Bot">
  <img src="https://camo.githubusercontent.com/aa3de9a0130879a84691a2286f5302105d5f3554c5d0af4e3f2f24174eeeea25/68747470733a2f2f6465706c6f792e776f726b6572732e636c6f7564666c6172652e636f6d2f627574746f6e" alt="Deploy to Cloudflare Workers" />
</a>

### Environment Variables

Configure in the Worker's Settings → Variables:

| Var | Required | Description |
|---|---|---|
| `BOT_TOKEN` | Yes | Your Telegram Bot Token (from @BotFather). Recommended as a Secret. |
| `ADMIN_UID` | Yes | Your Telegram User ID (from @userinfobot). |
| `TOPIC_MODE` | Yes | `true` for Topic Group mode, `false` for Private Chat mode (default). |
| `SUPERGROUP_ID` | Required for topic mode | Supergroup ID (starts with `-100`). |
| `WEBHOOK_SECRET` | Optional | Webhook security token; if empty, a UUID is auto-generated and stored in D1. |
| `MAX_MSG_PER_MIN` | Optional | Rate limit (msgs/min) that forces re-verification. Default `40`. |

### D1 Database

Create a D1 database (e.g. `tgchatbot`) and add a D1 binding in Settings → Bindings — **the binding name must be `D1`**. Tables are created automatically on the first request; no manual migration needed.

### Register the Webhook

After deploying, visit once: `https://your-worker.workers.dev/registerWebhook` — an `Ok (default)` response means it works (`default` is the bot id).

The webhook receive path is `/endpoint` for a single bot, or `/endpoint/{id}` per bot in multi-bot setups (registration entry: `/registerWebhook/{id}`).

## Operating Modes

### 1. Private Chat Mode (Default)
The bot forwards user messages directly to the admin's DM (`ADMIN_UID`).
- **Setup**: Just set `BOT_TOKEN` and `ADMIN_UID`; keep `TOPIC_MODE=false`.
- **Usage**: Reply to a forwarded message to respond to the user.

### 2. Topic Group Mode (Recommended for high volume)
The bot creates a separate **Forum Topic** per user in a Supergroup to keep conversations organized.

**Setup:**
1.  **Environment Variables**:
    - Set `TOPIC_MODE` to `true`.
    - Set `SUPERGROUP_ID` to your group ID (e.g. `-100xxxxxxx`).
2.  **Telegram Group Setup**:
    - Create a group (or reuse one), add the bot and promote it to **Administrator**.
    - **Crucial**: the bot needs **"Manage Topics"** permission.
    - Enable **Topics** in Group Settings (Group Info → Edit → Topics → Enable). *This converts the group to a Supergroup.*
3.  **Get Group ID**:
    - Add `@username_to_id_bot` to the group, or open it in Telegram Web — the URL contains the ID (e.g. `#/-100123456789`).

**Note**: Topics are created and bound by the bot automatically. A manually created topic is unknown to the bot — messages sent there are ignored; to use one, reply to a forwarded message from that user and it will be auto-bound.

## Multi-Bot Support

One Worker (one codebase + one D1 database) can serve multiple bots, with **fully isolated data per bot** (blacklist, keywords, verification state, message mappings and settings are kept separate — no interference).

### Only one bot?

**Nothing to configure.** Just use the `BOT_TOKEN`, `ADMIN_UID` environment variables; the bot is treated as id `default` with webhook path `/endpoint`.

### Adding more bots (from the admin panel, no Cloudflare needed)

Use `/bot` commands inside the admin panel (`/admin`) — configs are stored in D1 and the webhook is **auto-registered**:

```
/bot list                                         → list bots
/bot add support 123:ABC 222222222                → add (id token admin_uid)
/bot add vip 456:DEF 333333333 -100xxx topic 40   → topic mode + custom rate limit
/bot del support                                  → delete + unregister webhook
/bot set support token 789:GHI                    → update a field (token/admin/sg/max)
```

**Steps to add a bot:**

1. Create a bot at @BotFather and copy its token
2. Send `/bot add <id> <token> <admin_uid>` to your `default` bot (id: lowercase letters/digits/`-`/`_` only)
3. Done. The bot validates the token, registers the webhook and sets up the command menu.

**Parameters:**

| Param | Required | Description |
|---|---|---|
| `id` | Yes | Bot identifier, determines webhook path `/endpoint/{id}` |
| `token` | Yes | Bot Token from @BotFather |
| `admin_uid` | Yes | This bot's admin Telegram User ID |
| `sg` | No | Supergroup ID (starts with `-100`), only needed for topic mode |
| `topic` | No | Pass `topic` to enable topic mode by default, else private mode (switchable via `/mode`) |
| `max` | No | Rate limit (msgs/min). Default `40` |

**Notes:**

- Invalid tokens are not saved; messages containing tokens are auto-deleted.
- After changing a bot's `token`/`admin`, re-visit its `/registerWebhook/{id}`.
- The `default` bot still needs one manual visit to `/registerWebhook`.

## Anti-Spam Details

1.  **Keyword Blacklist**: Messages hitting suspicious keywords are silently dropped. Chinese words match as substrings; ASCII words match on **word boundaries** (case-insensitive) so short words like `av` don't false-positive inside passwords or account names. 12 defaults, managed via `/keyword`.
2.  **Verification** (pick one):
    - **Dynamic Math** (default): a randomly generated problem answered via option buttons; operators, range and option count are configurable (6 options by default).
    - **Custom Q&A**: an admin-maintained bank of 1–20 questions; the user answers with text and a random question is picked each time. Answers are stored server-side only.
    - **Off**: everyone is verified automatically.
    - **Wrong answer rotates the question**: the card is refreshed in place with a brand-new question and options; 3 wrong answers in a row require sending a new message.
    - Once passed, re-verification is skipped for **1 hour**; exceeding `MAX_MSG_PER_MIN` msgs/min forces re-verification. Blocked messages during verification are **stashed** and auto-sent after passing.
3.  **Security Levels** (apply to unverified users only):
    - **Strict (1)**: cannot send anything. **Standard (2)**: text only, no media (default). **Relaxed (3)**: no verification.
4.  **Shadowban**: `/block` drops a user's messages silently; they won't know.
5.  **Command Abuse Guard**: admin commands (`/admin`, `/bot`, `/help`, …) only work for the admin. When a stranger sends one it is **not executed and not forwarded** to the group/topic. The stranger gets a short hint ("this command is admin-only; just send your message to reach the admin"), throttled to **once per user per 10 minutes** — repeats are silently ignored, so the hint can't be used to flood the API. The command menu is visible to all private-chat users (Telegram can't hide it per user), and this guard covers accidental taps.

## Admin Commands

Send `/admin` for the visual panel (tap-to-run buttons):

- **/info** — user info (reply to their message or send in their topic).
- **/trust** / **/untrust** — permanently trust (skip all checks) / remove trust.
- **/block** / **/unblock** — shadowban / unban.
- **/blacklist** — view the blocked list.
- **/broadcast** — reply to a message to broadcast to all (skips blocked).
- **/security <1|2|3>** — set security level.
- **/verify <math|off|show>** — switch verification mode / show config.
- **/verify custom q | a** — replace the bank with a single question; **/verify add q | a** appends one (max 20).
- **/verify list** / **/verify del n** / **/verify clear** — list / delete / clear the custom bank (answers are never echoed).
- **/math ops +-*/** / **/math range 1 9** / **/math count 4** / **/math show** — configure the math bank.
- **/keyword list|add word|del word|reset** — manage keyword blacklist.
- **/lang <zh|en>** — switch UI language.
- **/welcome text** — custom `/start` welcome (supports `{uid}`).
- **/clear** — clear a user's mappings and topic binding; `/clear all` wipes everything.
- **/mode <private|topic>** — switch operating mode.
- **/bot list|add|del|set** — manage multiple bots (stored in D1, webhook auto-registered, no Cloudflare needed).
- **/help** — full command reference.

### Permission Model (/trust vs /block vs /unblock)

- **/block**: blacklists and clears trust/verification; messages dropped silently.
- **/unblock**: removes from blacklist only; the user returns to normal (still subject to security level).
- **/trust**: skips all checks (no verification/keyword/dedup) and auto-unblocks. Highest priority, mutually exclusive with block.

## Data Storage (D1)

All data lives in Cloudflare D1; tables are created/repaired on the first request:

- **user_states**: block/trust/verify/rate/pending-challenge/stashed-message/first-card state, permanent.
- **message_mappings**: routing map keyed by `(bot_id, admin_message_id)`; **permanent**, cleared via `/clear`.
- **chat_topic_mappings**: user ↔ topic bindings, permanent.
- **message_hashes**: dedupe hashes, isolated per user, valid for 2 minutes, expired rows cleaned by the daily Cron.
- **keywords**: keyword blacklist.
- **settings**: config (security level/verification mode/math bank/language/welcome/webhook secret).
- **bots**: multi-bot config (id/token/admin/sg/mode/rate limit/secret), maintained by `/bot` commands.

Every table uses `bot_id` as the first primary-key column to isolate data between bots.

**Automatic cleanup of obsolete tables**: on cold start the Worker compares the actual tables against the list used by the current code and **drops any table not in that list** (including leftover `_old_*` tables from an interrupted migration). Tables prefixed with `sqlite_` / `d1_` are exempt. So obsolete tables from older versions are cleaned automatically — and you should not keep unrelated tables in the same D1 database.

> Maintenance note: when adding a new table, you must also add it to the `TABLES` whitelist at the top of the code, otherwise it will be dropped as obsolete.

**Schema version (performance)**: on cold start the Worker compares `SCHEMA_VERSION` first; when it matches, all table/migration probes are skipped (18 queries → 1). **You must increment `SCHEMA_VERSION` after changing any table structure**, otherwise the new structure will not be applied (it looks like "the code updated but the schema didn't").

## Installation

1.  **Token**: get a Bot Token from @BotFather.
2.  **UID**: get your user ID from @userinfobot.
3.  **Create D1**: in the console (or `wrangler d1 create tgchatbot`).
4.  **Deploy**: click the "Deploy to Cloudflare Workers" button above, or create a Worker and paste `worker.js`.
5.  **Configure**: add the environment variables under Settings → Variables, and a D1 binding named **`D1`** under Settings → Bindings.
6.  **Register Webhook**: visit `https://your-domain.workers.dev/registerWebhook`.
7.  **(Optional) Cron**: add `0 0 * * *` under Triggers to clean expired dedupe hashes and reset expired verification state daily (permanent state such as blacklist/trust is never removed).

## Acknowledgements

This project is built upon two excellent open-source projects:

- **[tanaer/Telegram_MirroTalk](https://github.com/tanaer/Telegram_MirroTalk)** — the original base, providing the core message-forwarding bot (forwarding, anti-spam, admin commands, topic mode).
- **[iawooo/ctt (CFTeleTrans)](https://github.com/iawooo/ctt)** — we borrowed its fully D1-based storage approach and table design, verification-state persistence and rate-limit mechanism, webhook message/callback deduplication, and its topic-creation locking and fallback strategy.

Key improvements: storage fully migrated from KV to D1 (message mappings kept permanently, cleared manually via `/clear`), 1-hour verification persistence with rate-limit-triggered re-verification, stashing blocked messages and auto-resending them after passing, a configurable math bank (operators/range/option count), custom Q&A verification (answer stored server-side only), command-driven keyword/blacklist/language/welcome management, a categorized visual panel with tap-to-run buttons, panel-managed multi-bot support with data isolation, topic-creation cooldown with fallback to DM, and webhook deduplication against duplicate updates.
