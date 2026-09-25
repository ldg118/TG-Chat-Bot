# TG Chat Bot

 [English](README_EN.md) | [中文](README.md)

基于 Cloudflare Workers 的 Telegram 消息转发机器人，集成防骚扰和反诈骗功能。

## 功能特点

- **无服务器架构**：运行在 Cloudflare Workers 上，低成本且高可用。
- **消息转发**：将用户发送给机器人的消息转发给管理员。
- **运行模式**：
  - **私聊模式**：一对一转发，轻量简单。
  - **话题群组模式**：为每个用户创建独立话题，多用户分房管理。
- **防骚扰与反诈骗**：
  - **关键词过滤**：自动丢弃包含黑名单关键词（如 '刷单', '兼职', 'USDT'）的消息。
  - **动态算术验证**：未验证用户需完成随机数学题（如 3+5=?）才允许发送媒体，有效拦截脚本攻击。
  - **多级安全策略**：支持严格（禁言）、标准（禁图）、宽松（免验证）三种安全级别动态切换。
  - **消息去重**：防止 7 天内的重复消息刷屏。
  - **屏蔽/信任系统**：支持暗屏蔽 (`/block`) 和永久信任 (`/trust`) 用户。
- **管理功能**：
  - **全员广播**：发送 `/broadcast` 即可全员广播（保留原格式/媒体）。
  - **可视化菜单**：提供 `/admin` 管理面板，快捷操作。
  - **服务消息过滤**：自动忽略系统消息干扰。

## 部署到 Cloudflare Workers

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ldg118/TG-Chat-Bot">
  <img src="https://camo.githubusercontent.com/aa3de9a0130879a84691a2286f5302105d5f3554c5d0af4e3f2f24174eeeea25/68747470733a2f2f6465706c6f792e776f726b6572732e636c6f7564666c6172652e636f6d2f627574746f6e" alt="Deploy to Cloudflare Workers" />
</a>

### 配置

需要以下环境变量（可以在 `wrangler.toml` 中填写或在部署时配置）：

- `ENV_BOT_TOKEN`: 你的 Telegram 机器人 Token (从 @BotFather 获取)。
- `ENV_BOT_SECRET`: (可选) 用于 Webhook 安全验证的随机字符串。如果留空，系统将自动生成 UUID 并保存在 D1 中。
- `ENV_ADMIN_UID`: 你的 Telegram 用户 ID (从 @userinfobot 获取)。用于接收通知。
- `ENV_SUPERGROUP_ID`: 你的超级群组 ID (以 `-100` 开头)。仅在 `ENV_ENABLE_TOPIC_GROUP` 为 `true` 时需要。
- `ENV_ENABLE_TOPIC_GROUP` (可选): 设置为 `true` 以开启话题群组模式。默认为 `false` (私聊模式)。
- `ENV_MAX_MSG_PER_MIN` (可选): 频率限制阈值（条/分钟），超限触发重新验证。默认为 `40`。

**D1 数据库**：
你需要创建一个 D1 数据库（如 `mirrotalk`），并将其 ID 填入 `wrangler.toml` 的 `[[d1_databases]]` 绑定（binding 名为 `DB`）。表结构在首次请求时自动创建，无需手动迁移。

## 多机器人支持

一个 Worker 可以同时挂多个机器人，共用同一个 D1 数据库，**每个机器人的数据完全隔离**（黑名单、关键词、验证状态、消息映射、配置等都按 bot 分开，互不影响）。

### 只有一个机器人？

**什么都不用配。** 直接沿用单机器人变量 `ENV_BOT_TOKEN`、`ENV_ADMIN_UID` 等即可，系统会自动把它当作 id 为 `default` 的机器人，webhook 路径仍是 `/endpoint`，与旧版行为完全一致。

### 要加第二个、第三个机器人？（管理面板操作，免 Cloudflare）

日常加机器人**不需要碰 Cloudflare**，直接在 bot 的管理面板（`/admin`）里用 `/bot` 指令操作。配置存入 D1 并**自动注册 webhook**，加完立刻能用：

```
/bot list                                        → 查看已添加的机器人
/bot add support 123:ABC 222222222                → 添加（id token 管理员UID）
/bot add vip 456:DEF 333333333 -100xxx topic 40   → 话题模式 + 自定义限流
/bot del support                                 → 删除并自动注销 webhook
/bot set support token 789:GHI                   → 修改字段（token/admin/sg/max）
```

**添加新机器人的完整步骤：**

1. 从 @BotFather 新建一个 bot，拿到 token
2. 给你的 default 机器人发送 `/bot add <id> <token> <管理员UID>`（id 只能用小写字母/数字/`-`/`_`）
3. 完成。bot 会自动验证 token、注册 webhook、配置命令菜单，新机器人立即可用

**参数说明：**

| 参数 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 机器人标识，决定 webhook 路径 `/endpoint/{id}` |
| `token` | 是 | 从 @BotFather 获取的 Bot Token |
| `管理员UID` | 是 | 该机器人的管理员 Telegram User ID |
| `sg` | 否 | 超级群组 ID（以 `-100` 开头），仅话题模式需要 |
| `topic` | 否 | 填 `topic` 则默认开启话题群组模式，默认私聊模式。运行后可用 `/mode` 切换 |
| `max` | 否 | 频率限制（条/分钟），默认 `40` |

**几个注意点：**

- 添加时自动验证 token 有效性，无效不会保存；含 token 的消息会被自动删除防泄露
- 每个机器人的数据（黑名单、关键词、验证、消息映射、配置）在 D1 中完全隔离，互不影响
- 管理员指令（`/admin`、`/block` 等）在每个机器人里独立可用
- 改了某个机器人的 `token`/`admin` 后（`/bot set`），重新访问它的 `/registerWebhook/{id}` 即可生效
- 首次部署的 default 机器人仍需手动访问一次 `/registerWebhook`（它无法自己注册自己）

## 运行模式

### 1. 私聊模式 (默认)
机器人直接将用户消息转发到管理员的私聊 (`ENV_ADMIN_UID`) 中。
- **设置**：只需配置 `ENV_BOT_TOKEN`, `ENV_BOT_SECRET`, 和 `ENV_ADMIN_UID`。
- **使用**：直接回复转发来的消息即可回复用户。

### 2. 话题群组模式 (推荐用于高并发)
机器人会在一个超级群组中为每个用户创建一个独立的 **Forum Topic (话题)**。这样可以井井有条地管理大量对话。

**设置步骤：**
1.  **环境变量**：
    - 设置 `ENV_ENABLE_TOPIC_GROUP` 为 `true`。
    - 设置 `ENV_SUPERGROUP_ID` 为你的群组 ID (如 `-100xxxxxxx`)。

2.  **Telegram 群组设置**：
    - 创建一个新的群组（或使用现有群组）。
    - 将机器人拉入群组并设为**管理员**。
    - **关键**：机器人必须拥有 **"Manage Topics/管理话题"** 权限。
    - 在群设置中开启 **Topics (话题)** 功能：
      - 群组信息 -> 编辑 -> 话题 -> 开启。
      - *注：这会将群组转换为超级群组。*

3.  **获取群组 ID**：
    - 将 `@username_to_id_bot` 拉入群组，它会告诉你 ID。
    - 或者在网页版打开群组，URL 中包含 ID (例如 `#/-100123456789`)。

## 防骚扰功能详解

本机器人包含一套强大的防骚扰系统，旨在保护管理员免受垃圾信息和诈骗的侵扰：

1.  **关键词黑名单**：
    - 包含可疑关键词（如“兼职”、“刷单”、“USDT”、“色情”等）的消息会被静默丢弃。

2.  **动态算术验证**：
    - 未验证用户必须通过一道动态生成的数学题（如 `3 + 5 = ?`）来证明自己是真人。
    - 题目动态生成，无法被简单脚本破解。

3.  **多级安全策略**：
    - 管理员可通过 `/admin` 菜单切换安全级别：
      - **Strict (严格)**：未验证用户禁言。
      - **Standard (标准)**：未验证用户可发纯文本，禁止发媒体（默认）。
      - **Relaxed (宽松)**：无需验证。

4.  **暗屏蔽 (Shadowban)**：
    - 管理员可以使用 `/block` 指令对用户进行暗屏蔽。
    - 用户不会知道自己被屏蔽了，但他们的消息将不再被转发。

## 管理员指令

在超级群组中发送 `/admin` 查看控制面板：

- **/info**：查看当前话题对应的用户信息。
- **/trust** / **/untrust**：永久信任当前用户（跳过验证）/ 取消信任。
- **/block**：屏蔽当前用户（Shadowban）。
- **/unblock**：解除屏蔽。
- **/blacklist**：查看当前黑名单用户列表。
- **/broadcast**：回复一条消息进行全员广播。
- **/security <1|2|3>**：设置安全级别。
- **/verify <math|off|show>** 或 **/verify custom 问题 | 答案**：切换验证方式（动态算术 / 自定义问答 / 关闭）。
- **/math ops +-*/** / **/math range 1 9** / **/math count 4** / **/math show**：配置算术题库（运算类型、操作数范围、选项按钮数）。
- **/keyword list|add 词|del 词|reset**：管理关键词黑名单。
- **/lang <zh|en>**：切换界面语言。
- **/welcome 文本**：自定义用户 `/start` 欢迎语（支持 `{uid}` 占位符）。
- **/clear**：清除指定用户的消息映射（回复其消息或在其话题内发送）；`/clear all` 清空全部映射
- **/mode <private|topic>**：切换运行模式。
- **/bot list|add|del|set**：在面板内管理多个机器人（存入 D1 并自动注册 webhook，免 Cloudflare 操作）。
- **/help**：查看全部指令说明。

### 权限系统深入理解 (/trust vs /block vs /unblock)

为了在安全与便利之间取得平衡，机器人设计了一套精细的权限控制逻辑：

*   **`/block` (暗屏蔽/黑名单)**：
    - **作用**：将用户加入黑名单并清除其信任/验证状态。
    - **效果**：用户发送的所有消息将被静默丢弃，管理员不会收到任何提醒。
*   **`/unblock` (解除屏蔽)**：
    - **作用**：仅将用户从黑名单中移除。
    - **效果**：用户恢复到**普通状态**。如果系统处于严格/标准模式，该用户发送消息仍需接受关键词过滤和算术验证。
*   **`/trust` (永久信任/白名单)**：
    - **作用**：设置用户为永久信任状态，并**自动执行解除屏蔽**。
    - **效果**：用户成为 **VIP/白名单** 成员。他将跳过所有安全检查（免验证、免关键词过滤、免去重），在任何模式（包括严格模式）下都能自由通行。

**优先级规则**：`trust` 具有最高优先级且与 `block` 状态互斥。执行 `/trust` 会自动覆盖并移除该用户的 `/block` 状态。

## 数据存储说明 (D1)

本系统使用 Cloudflare D1 数据库存储全部数据，表结构在首次请求时自动创建：

- **user_states**：用户状态（黑名单/信任/验证/频率限制/待答验证题），永久保存。验证通过后 **1 小时**内免重复验证；超过 `ENV_MAX_MSG_PER_MIN` 条/分钟触发重新验证。
- **message_mappings**：消息路由映射，**永久保存**（不再 7 天过期），可随时回复任意历史转发消息找回原用户；通过 `/clear` 手动删除。
- **chat_topic_mappings**：用户 ↔ 话题双向映射，永久保存。
- **message_hashes**：去重哈希，7 天后由每日 Cron 自动清理（防止误伤正常重复用语）。
- **keywords**：关键词黑名单，通过 `/keyword` 指令增删。
- **settings**：配置项（安全级别/验证模式/题库参数/语言/置顶卡片 ID 等）。

D1 免费版额度（10 万行写/天、5GB）远超原 KV 方案（1000 次写/天、1GB），日常使用无需升级付费套餐。

## 安装指南

1.  **获取 Token**：从 @BotFather 获取你的 Bot Token。
2.  **获取 UID**：从 @username_to_id_bot 或类似机器人获取你的用户 ID。
3.  **部署**：点击上方的 "Deploy with Workers" 按钮。
4.  **绑定 D1**：创建 D1 数据库（控制台或 `wrangler d1 create mirrotalk`），将 `database_id` 填入 `wrangler.toml`，并在 Worker 设置中添加 binding 名为 `DB` 的 D1 绑定。表结构首次请求时自动创建。
5.  **设置 Webhook**：部署完成后，访问以下链接注册 Webhook：`https://你的-worker-子域名.workers.dev/registerWebhook`

## 致谢与参考

本项目在以下两个优秀开源项目的基础上开发，特此感谢：

- **[tanaer/Telegram_MirroTalk](https://github.com/tanaer/Telegram_MirroTalk)** —— 本项目的原始基础，提供了 Telegram 消息转发机器人的核心架构（消息转发、防骚扰、管理指令等）。
- **[iawooo/ctt (CFTeleTrans)](https://github.com/iawooo/ctt)** —— 借鉴了其 D1 数据库表结构设计、验证状态持久化与频率限制机制、webhook 去重与话题创建锁，以及话题模式的用户信息卡设计。

主要改进：存储层由 KV 全面迁移至 D1（消息映射永久保存）、验证 1 小时持久化免重复、频率限制触发重验证、管理面板分类化与内联按钮、多机器人面板管理、双语界面、关键词/验证方式/题库/欢迎语指令化配置等。
