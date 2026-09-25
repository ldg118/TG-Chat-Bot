# Telegram MirroTalk Bot

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

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/tanaer/Telegram_MirroTalk">
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

One Worker can serve multiple bots sharing a single D1 (data isolated per bot). Set the `ENV_BOTS` env var (JSON array):

```json
[
  {"id":"default","token":"123:ABC","admin":"111111"},
  {"id":"support","token":"456:DEF","admin":"222222","sg":"-100xxx","topic":true,"max":40}
]
```

- `id`: webhook path tag -> `/endpoint/{id}`
- `token`/`admin`: required; `sg`/`topic`/`max`/`secret`: optional
- Register each bot's webhook: visit `https://<worker-domain>/registerWebhook/{id}`
- Without `ENV_BOTS`, the legacy single-bot vars (`ENV_BOT_TOKEN` etc.) are used as bot id `default`
- Security level, verification, keywords, language and welcome messages are independent per bot

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
- **/clear**: Clear message mappings for a user (reply to their message or send in their topic); `/clear all` wipes all mappings.
- **/mode <private|topic>**: Switch operating mode.

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
