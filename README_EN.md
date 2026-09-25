# TG Chat Bot

[English](README_EN.md) | [中文](README.md)

A Telegram message forwarding bot running on Cloudflare Workers, with anti-spam and anti-scam protection.

| 未验证用户联系你，要求验证                                   | 实际不会收到图片                               |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| <img width="381" height="192" alt="image" src="https://github.com/user-attachments/assets/74b987f1-61b1-472c-be8f-cf46562ceb46" />| <img width="200" height="500" alt="image" src="https://github.com/user-attachments/assets/759301be-b1a3-4fcb-a263-22cccca83e46" /> |







## Features

- **Serverless Architecture**: Runs on Cloudflare Workers, low cost and high availability.
- **Message Forwarding**: Forwards messages from users to admins and vice versa.
- **Operating Modes**:
  - **Private Chat Mode**: One-on-one forwarding, simple and lightweight.
  - **Topic Group Mode**: Creates separate topics for each user, supporting high-volume management.
- **Anti-Spam & Anti-Scam**:
  - **Keyword Filtering**: Automatically drops messages containing blacklisted keywords (e.g., 'scam', 'USDT').
  - **Dynamic Math Verification**: Unverified users must solve a random math problem (e.g., 3+5=?) to send media, effectively blocking bots.
  - **Security Levels**: Supports dynamic switching between Strict (mute), Standard (no media), and Relaxed (no verification) modes.
  - **Deduplication**: Prevents duplicate messages within 7 days.
  - **Block/Trust System**: Admins can shadowban (`/block`) or whitelist (`/trust`) users.
- **Management Tools**:
  - **Broadcast**: Reply to a message to broadcast it to all users.
  - **Admin Menu**: Visual `/admin` panel for quick operations.
  - **Service Message Filtering**: Automatically ignores system messages like join/leave events.

## Deploy to Cloudflare Workers

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ldg118/TG-Chat-Bot">
  <img src="https://camo.githubusercontent.com/aa3de9a0130879a84691a2286f5302105d5f3554c5d0af4e3f2f24174eeeea25/68747470733a2f2f6465706c6f792e776f726b6572732e636c6f7564666c6172652e636f6d2f627574746f6e" alt="Deploy to Cloudflare Workers" />
</a>

### 配置

需要以下环境变量（可以在 `wrangler.toml` 中填写或在部署时配置）：

- `ENV_BOT_TOKEN`: Your Telegram Bot Token (from @BotFather).
- `ENV_BOT_SECRET`: (Optional) A random string for Webhook security. If left empty, the system will automatically generate a UUID and store it in D1.
- `ENV_ADMIN_UID`: Your Telegram User ID (from @userinfobot). Used for receiving admin notifications.
- `ENV_SUPERGROUP_ID`: The ID of the Supergroup where the bot will create topics (starts with `-100`). Required only if `ENV_ENABLE_TOPIC_GROUP` is `true`.
- `ENV_ENABLE_TOPIC_GROUP` (Optional): Set to `true` to enable Topic Group mode. Default is `false` (Private Chat mode).
- `ENV_MAX_MSG_PER_MIN` (Optional): Rate limit threshold (messages/minute) that forces re-verification. Default is `40`.

**D1 Database**:
Create a D1 database (e.g. `mirrotalk`) and put its `database_id` in the `[[d1_databases]]` binding (`DB`) in `wrangler.toml`. Tables are created automatically on first request — no manual migration needed.

## Multi-Bot Support

One Worker can serve multiple bots at the same time, sharing a single D1 database. **Each bot's data is fully isolated** (blacklist, keywords, verification state, message mappings, settings — all kept separate per bot, no interference).

### Only one bot?

**Nothing to configure.** Just keep using the single-bot vars (`ENV_BOT_TOKEN`, `ENV_ADMIN_UID`, etc.). The system treats it as a bot with id `default`, the webhook path stays `/endpoint`, and behavior is identical to the old version.

### Adding a second, third bot? (from the admin panel, no Cloudflare)

Adding bots no longer requires touching Cloudflare. Use `/bot` commands in the admin panel (`/admin`) — configs are stored in D1 and the webhook is **auto-registered**, ready immediately:

```
/bot list                                        → show added bots
/bot add support 123:ABC 222222222                → add (id token admin_uid)
/bot add vip 456:DEF 333333333 -100xxx topic 40   → topic mode + custom rate limit
/bot del support                                 → delete + auto-unregister webhook
/bot set support token 789:GHI                   → update field (token/admin/sg/max)
```

**Steps to add a new bot:**

1. Create a new bot at @BotFather, get its token
2. Send `/bot add <id> <token> <admin_uid>` to your default bot (id: lowercase letters/digits/`-`/`_` only)
3. Done. The bot validates the token, registers the webhook and sets up the command menu automatically.

**Parameter reference:**

| Param | Required | Description |
|---|---|---|
| `id` | Yes | Bot identifier, determines webhook path `/endpoint/{id}` |
| `token` | Yes | Bot Token from @BotFather |
| `admin_uid` | Yes | This bot's admin Telegram User ID |
| `sg` | No | Supergroup ID (starts with `-100`), only needed for topic mode |
| `topic` | No | Pass `topic` to enable topic-group mode by default, else private mode. Switchable via `/mode` |
| `max` | No | Rate limit (msgs/min). Default `40` |

**Notes:**

- Token validity is checked on add; invalid tokens are not saved. Messages containing tokens are auto-deleted.
- Each bot's data (blacklist, keywords, verification, message mappings, settings) is fully isolated in D1.
- Admin commands (`/admin`, `/block`, etc.) work independently in each bot.
- After changing a bot's `token`/`admin` via `/bot set`, re-visit its `/registerWebhook/{id}` to apply.
- The initial `default` bot still needs one manual visit to `/registerWebhook` (it can't register itself).

## Operating Modes

### 1. Private Chat Mode (Default)
The bot forwards user messages directly to the admin's private chat (`ENV_ADMIN_UID`).
- **Setup**: Just set `ENV_BOT_TOKEN`, `ENV_BOT_SECRET`, and `ENV_ADMIN_UID`.
- **Usage**: Reply to the forwarded message to send a response back to the user.

### 2. Topic Group Mode (Recommended for high volume)
The bot creates a separate **Forum Topic** for each user in a Supergroup. This keeps conversations organized.

**Setup Instructions:**
1.  **Environment Variables**:
    - Set `ENV_ENABLE_TOPIC_GROUP` to `true`.
    - Set `ENV_SUPERGROUP_ID` to your group ID (e.g., `-100xxxxxxx`).

2.  **Telegram Group Setup**:
    - Create a new Group (or use an existing one).
    - Add the bot to the group and promote it to **Administrator**.
    - **Crucial**: The bot must have **"Manage Topics"** permission.
    - Enable **Topics** in Group Settings:
      - Go to Group Info -> Edit -> Topics -> Enable.
      - *Note: This converts the group to a Supergroup.*

3.  **Get Group ID**:
    - Add `@username_to_id_bot` to your group, it will tell you the ID.
    - Or open the group in Telegram Web, the URL will contain the ID (e.g., `#/-100123456789`).

## Anti-Spam Features

This bot includes a powerful anti-spam system designed to protect admins from spam and scams:

1.  **Keyword Blacklist**:
    - Messages containing suspicious keywords (e.g., 'scam', 'USDT', 'porn') are silently discarded.

2.  **Verification Challenge (Math)**:
    - Unverified users must solve a dynamic math problem (e.g., `3 + 5 = ?`) to prove they are human.
    - Questions are generated dynamically to prevent replay attacks.

3.  **Security Levels**:
    - Admins can toggle security levels via `/admin` menu:
      - **Strict**: Unverified users cannot send anything.
      - **Standard**: Unverified users can send text but NO media.
      - **Relaxed**: No verification required.

4.  **Shadowban**:
    - Admins can shadowban users using `/block`.
    - Users won't know they are blocked, but their messages are dropped.

## Admin Commands

Send `/admin` in the Supergroup to see the control panel:

- **/info**: View user info in a topic.
- **/trust** / **/untrust**: Permanently trust a user (skip verification) / remove trust.
- **/block**: Shadowban a user.
- **/unblock**: Unban a user.
- **/blacklist**: View the blocked users list.
- **/broadcast**: Reply to a message to broadcast it to all users.
- **/security <1|2|3>**: Set security level.
- **/verify <math|off|show>** or **/verify custom <question> | <answer>**: Switch verification mode (dynamic math / custom Q&A / disabled).
- **/math ops +-*/** / **/math range 1 9** / **/math count 4** / **/math show**: Configure the math question bank (operators, operand range, option buttons).
- **/keyword list|add <word>|del <word>|reset**: Manage the keyword blacklist.
- **/lang <zh|en>**: Switch UI language.
- **/welcome <text>**: Custom `/start` welcome message (supports `{uid}` placeholder).
- **/clear**: Clear message mappings for a user (reply to their message or send in their topic); `/clear all` wipes all mappings.
- **/mode <private|topic>**: Switch operating mode.
- **/bot list|add|del|set**: Manage multiple bots from the admin panel (stored in D1, webhook auto-registered, no Cloudflare needed).
- **/help**: Show the full command reference.

## Data Storage (D1)

All data is persisted in Cloudflare D1; tables are created automatically on first request:

- **user_states**: user status (blocked/trusted/verified/rate-limited/pending challenge), permanent. Verification is valid for **1 hour**; exceeding `ENV_MAX_MSG_PER_MIN` messages/minute forces re-verification.
- **message_mappings**: message routing map, **kept permanently** (no more 7-day expiry) — you can reply to any historical forwarded message to reach the original user; delete manually via `/clear`.
- **chat_topic_mappings**: user ↔ topic binding, permanent.
- **message_hashes**: dedupe hashes, cleaned by a daily cron after 7 days (prevents false positives on common repeated phrases).
- **keywords**: keyword blacklist, managed via `/keyword`.
- **settings**: config (security level / verify mode / math params / language / pinned card IDs).

The D1 free tier (100k writes/day, 5GB) far exceeds the old KV limits (1,000 writes/day, 1GB); no paid plan needed for typical use.

## Setup Instructions

1.  **Get Token**: Get your bot token from @BotFather.
2.  **Get UID**:
    *   **Method A (Recommended)**: Before deployment, fill in a dummy UID (e.g., `123`) and deploy. Then send `/start` to your bot, and it will reply with your real UID.
    *   **Method B**: Get your user ID from a third-party bot like @username_to_id_bot.
3.  **Deploy**: Click the "Deploy with Workers" button above.
4.  **Bind D1**: Create a D1 database (console or `wrangler d1 create mirrotalk`), fill the `database_id` into `wrangler.toml`, and add a D1 binding named `DB` in your Worker settings. Tables are created automatically on first request.
5.  **Set Webhook**: After deployment, visit `https://your-worker-subdomain.workers.dev/registerWebhook` to register the webhook.

## Acknowledgements

This project is built upon and inspired by the following excellent open-source projects:

- **[tanaer/Telegram_MirroTalk](https://github.com/tanaer/Telegram_MirroTalk)** — the original base of this project, providing the core architecture of the Telegram message forwarding bot (forwarding, anti-spam, admin commands, etc.).
- **[iawooo/ctt (CFTeleTrans)](https://github.com/iawooo/ctt)** — from which we adopted the D1 database schema design, verification persistence & rate-limiting mechanism, webhook dedupe with topic-creation locks, and the topic-mode user info card.

Key improvements: full migration from KV to D1 (permanent message mappings), 1-hour verification persistence, rate-limit-triggered re-verification, categorized admin panel with inline buttons, multi-bot management from the panel, bilingual UI, and command-driven configuration for keywords / verification / math bank / welcome message.
