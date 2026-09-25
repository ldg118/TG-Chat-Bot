// Telegram MirroTalk Bot - Cloudflare Worker (D1 存储版, ES module 格式, 多机器人)
// 数据持久化在 D1 (绑定名: DB)，首次请求自动建表/迁移，无需手动操作。
//
// 多机器人配置 (ENV_BOTS, JSON 数组):
//   [{"id":"default","token":"123:ABC","admin":"111111","sg":"-100xxx","topic":true,"max":40},
//    {"id":"support","token":"456:DEF","admin":"222222"}]
//   - id: webhook 路径标识 (/endpoint/{id})，建议只用字母数字-_
//   - token: Bot Token; admin: 管理员 UID; sg: 超级群组 ID; topic: 默认话题模式
//   - max: 频率限制(条/分钟, 默认40); secret: webhook 密钥(可选); 均可省略走默认
// 兼容旧配置：若未设置 ENV_BOTS 但设置了 ENV_BOT_TOKEN，自动作为 id="default" 的单机器人。

const WEBHOOK = '/endpoint';
const DEFAULT_BOT_ID = 'default';

// --- 常量配置 ---
const VERIFY_TTL_SECONDS = 3600; // 验证通过后 1 小时内免重复验证
const CODE_TTL_SECONDS = 300;    // 验证码/题目有效期 5 分钟
const DEDUPE_TTL_SECONDS = 7 * 24 * 3600; // 去重哈希 7 天过期
const DEFAULT_LANG = 'zh';

// 安全级别定义
const SECURITY_STRICT = 1;   // 未验证 -> 不转发任何信息
const SECURITY_STANDARD = 2; // 未验证 -> 可发文字，不可发媒体 (默认)
const SECURITY_RELAXED = 3;  // 未验证 -> 可发图文视频 (无需验证)
const DEFAULT_SECURITY_LEVEL = SECURITY_STANDARD;

// 默认关键词黑名单（可被 /keyword 指令增删覆盖，存于 keywords 表）
const DEFAULT_KEYWORDS = [
  '炸鱼', '微信', '加我', '兼职', '刷单', '日结',
  '裸聊', '同城', 'av', '博彩', 'USDT', '跑分'
];

// --- 双语词条 ---
const STRINGS = {
  'welcome.user': {
    zh: '请直接发送信息给我，我会转发给技术。\n\nYour UID: {uid}',
    en: 'Send me a message directly and I will forward it to the admin.\n\nYour UID: {uid}'
  },
  'welcome.admin': {
    zh: '<b>Admin Control Panel</b>\nUID: {uid}\nMode: {mode}\n{sgWarn}\n发送 /admin 或 /help 查看完整管理菜单。',
    en: '<b>Admin Control Panel</b>\nUID: {uid}\nMode: {mode}\n{sgWarn}\nSend /admin or /help for the full menu.'
  },
  'mode.topic': { zh: '话题群组模式', en: 'Topic Group' },
  'mode.private': { zh: '私聊模式', en: 'Private Chat' },
  'mode.warn.nosg': {
    zh: '⚠️ <b>配置警告</b>: 已开启话题模式但未设置 sg (超级群组 ID)。',
    en: '⚠️ <b>Config warning</b>: topic mode enabled but sg (supergroup id) is not set.'
  },
  'verify.title': { zh: '🔒 <b>身份验证</b>', en: '🔒 <b>Verification</b>' },
  'verify.math_text': { zh: '问题：{q}\n\n(验证通过后请重新发送刚才的消息)', en: 'Question: {q}\n\n(Please resend your message after verification)' },
  'verify.custom_text': { zh: '请回答以下问题以继续：\n\n{q}\n\n直接回复答案文本即可（验证通过后请重新发送刚才的消息）', en: 'Please answer the following to continue:\n\n{q}\n\nReply with the answer text (resend your message after verification)' },
  'verify.passed': { zh: '✅ <b>验证通过！</b>\n\n请重新发送您的消息。', en: '✅ <b>Verification passed!</b>\n\nPlease resend your message.' },
  'verify.wrong': { zh: '❌ 答案错误，请重试。', en: '❌ Wrong answer, please try again.' },
  'verify.expired': { zh: '❌ 验证已过期，请重新发送消息触发验证。', en: '❌ Verification expired. Resend a message to trigger it again.' },
  'verify.already': { zh: '✅ 您已通过验证。', en: '✅ You are already verified.' },
  'verify.custom_notset': { zh: '⚠️ 管理员尚未设置自定义验证问题，已临时按算术题验证。', en: '⚠️ Custom question not configured; using math challenge instead.' },
  'rate.limited': { zh: '⚠️ 发送过于频繁，请完成验证后继续。', en: '⚠️ Too many messages. Please complete verification to continue.' },
  'block.done': { zh: '🚫 <b>已屏蔽用户</b>\n用户 <code>{uid}</code> 已进入黑名单并清除信任状态。', en: '🚫 <b>User blocked</b>\nUser <code>{uid}</code> is blacklisted and trust cleared.' },
  'unblock.done': { zh: '✅ <b>已解除屏蔽</b>\n用户 <code>{uid}</code> 已恢复正常状态。', en: '✅ <b>User unblocked</b>\nUser <code>{uid}</code> is restored to normal.' },
  'trust.done': { zh: '🌟 <b>已设置永久信任</b>\n用户 <code>{uid}</code> 将免除验证并移出黑名单。', en: '🌟 <b>Trusted</b>\nUser <code>{uid}</code> skips all checks and is removed from blacklist.' },
  'untrust.done': { zh: '↩️ 已取消用户 <code>{uid}</code> 的永久信任。', en: '↩️ Permanent trust removed for user <code>{uid}</code>.' },
  'target.unknown': { zh: '⚠️ 无法识别目标用户。请在话题内发送，或在私聊中回复一条转发的消息。', en: '⚠️ Cannot identify target user. Send inside a topic, or reply to a forwarded message.' },
  'info.title': { zh: 'ℹ️ <b>用户信息</b>', en: 'ℹ️ <b>User Info</b>' },
  'info.status.unverified': { zh: '❌ 未验证', en: '❌ Unverified' },
  'info.status.verified': { zh: '✅ 已验证', en: '✅ Verified' },
  'info.status.trusted': { zh: '🌟 永久信任', en: '🌟 Trusted' },
  'info.status.blocked': { zh: '🚫 已屏蔽', en: '🚫 Blocked' },
  'info.status.limited': { zh: '🚦 频率限制中', en: '🚦 Rate-limited' },
  'info.link': { zh: '点击私聊', en: 'Open DM' },
  'blacklist.empty': { zh: '📃 黑名单为空。', en: '📃 Blacklist is empty.' },
  'blacklist.title': { zh: '📃 <b>黑名单</b> (共 {n} 人)', en: '📃 <b>Blacklist</b> ({n} users)' },
  'clear.user.done': { zh: '🗑 已清除用户 <code>{uid}</code> 的消息映射与话题绑定。', en: '🗑 Cleared message mappings and topic binding for user <code>{uid}</code>.' },
  'clear.all.done': { zh: '🗑 已清空全部消息映射、话题绑定与置顶卡片记录。', en: '🗑 Cleared all message mappings, topic bindings and pinned-card records.' },
  'pin.card': {
    zh: '🪪 <b>新用户接入</b>\n昵称: {name}\n用户名: {username}\nUserID: <code>{uid}</code>\n发起时间: {time}',
    en: '🪪 <b>New user</b>\nName: {name}\nUsername: {username}\nUserID: <code>{uid}</code>\nFirst seen: {time}'
  },
  'notice.default': {
    zh: '请友善沟通，禁止发送广告、诈骗及违规内容，违规将被屏蔽。',
    en: 'Be respectful. Ads, scams and prohibited content will get you blocked.'
  },
  'notice.user': {
    zh: '👋 <b>欢迎</b>\n\n{notice}',
    en: '👋 <b>Welcome</b>\n\n{notice}'
  },
  'notice.usage': {
    zh: '用法: <code>/notice 通知内容</code>\n当前通知:\n{notice}',
    en: 'Usage: <code>/notice &lt;text&gt;</code>\nCurrent notice:\n{notice}'
  },
  'notice.set': { zh: '✅ 接入须知已更新。', en: '✅ Welcome notice updated.' },
  'welcome.usage': {
    zh: '用法: <code>/welcome 欢迎语</code>（可用 <code>{uid}</code> 占位符显示用户ID）\n当前欢迎语:\n{welcome}',
    en: 'Usage: <code>/welcome &lt;text&gt;</code> (use <code>{uid}</code> placeholder)\nCurrent welcome:\n{welcome}'
  },
  'welcome.set': { zh: '✅ 用户欢迎语已更新。', en: '✅ User welcome message updated.' },
  'keyword.usage': {
    zh: '用法:\n<code>/keyword list</code> 查看关键词\n<code>/keyword add 词</code> 添加\n<code>/keyword del 词</code> 删除\n<code>/keyword reset</code> 恢复默认',
    en: 'Usage:\n<code>/keyword list</code> list keywords\n<code>/keyword add &lt;word&gt;</code> add\n<code>/keyword del &lt;word&gt;</code> delete\n<code>/keyword reset</code> restore defaults'
  },
  'keyword.list_empty': { zh: '📃 关键词黑名单为空。', en: '📃 Keyword blacklist is empty.' },
  'keyword.list_title': { zh: '📃 <b>关键词黑名单</b> (共 {n} 个，含默认 {d} 个)', en: '📃 <b>Keyword blacklist</b> ({n} total, {d} defaults)' },
  'keyword.legend': { zh: '\n<i>带 * 为系统默认词，/keyword del 词 可移除</i>', en: '\n<i>* = built-in default, remove with /keyword del &lt;word&gt;</i>' },
  'keyword.added': { zh: '✅ 已添加关键词: <code>{w}</code>', en: '✅ Keyword added: <code>{w}</code>' },
  'keyword.exists': { zh: 'ℹ️ 关键词 <code>{w}</code> 已存在。', en: 'ℹ️ Keyword <code>{w}</code> already exists.' },
  'keyword.deleted': { zh: '🗑 已删除关键词: <code>{w}</code>', en: '🗑 Keyword deleted: <code>{w}</code>' },
  'keyword.notfound': { zh: '⚠️ 未找到关键词: <code>{w}</code>', en: '⚠️ Keyword not found: <code>{w}</code>' },
  'keyword.reset': { zh: '✅ 关键词已恢复为默认列表。', en: '✅ Keywords restored to defaults.' },
  'mode.switched.private': { zh: '✅ 已切换为：<b>私聊模式</b>', en: '✅ Switched to: <b>Private Chat mode</b>' },
  'mode.switched.topic': { zh: '✅ 已切换为：<b>话题群组模式</b>', en: '✅ Switched to: <b>Topic Group mode</b>' },
  'mode.usage': { zh: '当前模式：<b>{mode}</b>\n\n切换：\n<code>/mode private</code>\n<code>/mode topic</code>', en: 'Current mode: <b>{mode}</b>\n\nSwitch:\n<code>/mode private</code>\n<code>/mode topic</code>' },
  'mode.param_err': { zh: '⚠️ 参数错误：请使用 /mode private 或 /mode topic', en: '⚠️ Bad argument: use /mode private or /mode topic' },
  'mode.no_sg': { zh: '⚠️ 该机器人未配置 sg (超级群组 ID)，无法开启话题群组模式。', en: '⚠️ No sg (supergroup id) configured for this bot; cannot enable topic mode.' },
  'security.usage': {
    zh: '当前安全级别: {lv}\n\n设置方法: /security <1|2|3>\n1: 严格 (未验证禁言)\n2: 标准 (未验证仅文本)\n3: 宽松 (未验证可发媒体)',
    en: 'Current level: {lv}\n\nUsage: /security <1|2|3>\n1: Strict (mute unverified)\n2: Standard (text only)\n3: Relaxed (media allowed)'
  },
  'security.set': { zh: '✅ 安全级别已设置为: <b>{name}</b>', en: '✅ Security level set to: <b>{name}</b>' },
  'security.invalid': { zh: '无效级别。请使用 1, 2, 或 3。', en: 'Invalid level. Use 1, 2, or 3.' },
  'security.name.1': { zh: '严格模式', en: 'Strict' },
  'security.name.2': { zh: '标准模式', en: 'Standard' },
  'security.name.3': { zh: '宽松模式', en: 'Relaxed' },
  'verify.usage': {
    zh: '用法:\n<code>/verify math</code> 动态算术验证\n<code>/verify custom 问题 | 答案</code> 自定义问答\n<code>/verify off</code> 关闭验证\n<code>/verify show</code> 查看当前配置',
    en: 'Usage:\n<code>/verify math</code> dynamic math\n<code>/verify custom &lt;question&gt; | &lt;answer&gt;</code> custom Q&A\n<code>/verify off</code> disable\n<code>/verify show</code> show config'
  },
  'verify.set.math': { zh: '✅ 验证方式已切换为：<b>动态算术</b>', en: '✅ Verification mode: <b>dynamic math</b>' },
  'verify.set.custom': { zh: '✅ 验证方式已切换为：<b>自定义问答</b>\n问题: {q}', en: '✅ Verification mode: <b>custom Q&A</b>\nQuestion: {q}' },
  'verify.set.off': { zh: '✅ 已关闭验证（所有用户免验证）。', en: '✅ Verification disabled (all users pass).' },
  'verify.show': {
    zh: '🛡 <b>验证配置</b>\n模式: {mode}\n{detail}\n有效期: 1 小时\n频率限制: 超过 {limit} 条/分钟 触发重新验证',
    en: '🛡 <b>Verification config</b>\nMode: {mode}\n{detail}\nValidity: 1 hour\nRate limit: re-verify after {limit} msgs/min'
  },
  'verify.show.mode.math': { zh: '动态算术', en: 'Dynamic math' },
  'verify.show.mode.custom': { zh: '自定义问答', en: 'Custom Q&A' },
  'verify.show.mode.off': { zh: '已关闭', en: 'Disabled' },
  'math.usage': {
    zh: '用法:\n<code>/math ops +-*/</code> 运算类型（可组合）\n<code>/math range 1 20</code> 操作数范围\n<code>/math count 4</code> 选项按钮数(2-6)\n<code>/math show</code> 查看当前配置',
    en: 'Usage:\n<code>/math ops +-*/</code> operations (combinable)\n<code>/math range 1 20</code> operand range\n<code>/math count 4</code> option buttons (2-6)\n<code>/math show</code> show config'
  },
  'math.set.ops': { zh: '✅ 运算类型已设置为: <code>{ops}</code>', en: '✅ Operations set to: <code>{ops}</code>' },
  'math.set.range': { zh: '✅ 操作数范围已设置为: {min} ~ {max}', en: '✅ Operand range set to: {min} ~ {max}' },
  'math.set.count': { zh: '✅ 选项按钮数已设置为: {n}', en: '✅ Option buttons set to: {n}' },
  'math.show': { zh: '🧮 <b>算术题库配置</b>\n运算: {ops}\n范围: {min} ~ {max}\n按钮数: {count}', en: '🧮 <b>Math config</b>\nOps: {ops}\nRange: {min} ~ {max}\nButtons: {count}' },
  'math.err.ops': { zh: '⚠️ 无效运算符号，仅支持 + - * / 的组合。', en: '⚠️ Invalid operators. Use combination of + - * /.' },
  'math.err.range': { zh: '⚠️ 范围参数无效，示例: /math range 1 20', en: '⚠️ Invalid range. Example: /math range 1 20' },
  'math.err.count': { zh: '⚠️ 按钮数需为 2~6 的整数。', en: '⚠️ Button count must be an integer 2~6.' },
  'lang.set': { zh: '✅ 界面语言已切换为：中文', en: '✅ UI language switched to: English' },
  'lang.usage': { zh: '用法: <code>/lang zh</code> 或 <code>/lang en</code>', en: 'Usage: <code>/lang zh</code> or <code>/lang en</code>' },
  'lang.invalid': { zh: '⚠️ 无效参数，仅支持 zh / en。', en: '⚠️ Invalid argument. Only zh / en supported.' },
  'menu.admin': {
    zh: '🛠 <b>管理面板</b>\n\n🧭 {mode} | 🛡 {sec} | 🔐 {verify}\n📃 关键词 {kw} | 🌐 {lang}\n\n点击下方按钮直接执行；输入 <code>/</code> 可唤起命令菜单；<code>/help</code> 查看全部指令说明。',
    en: '🛠 <b>Admin Panel</b>\n\n🧭 {mode} | 🛡 {sec} | 🔐 {verify}\n📃 Keywords {kw} | 🌐 {lang}\n\nTap buttons below to execute; type <code>/</code> for the command menu; <code>/help</code> for the full list.'
  },
  'help.text': {
    zh: '📖 <b>指令说明</b>\n\n<b>用户管理</b>（回复目标消息或在其话题内发送）\n<code>/info</code> 用户信息 | <code>/trust</code> 永久信任 | <code>/untrust</code> 取消信任\n<code>/block</code> 屏蔽 | <code>/unblock</code> 解除 | <code>/blacklist</code> 黑名单列表\n<code>/clear</code> 清除该用户映射 | <code>/clear all</code> 清空全部\n\n<b>系统设置</b>\n<code>/mode private|topic</code> 运行模式\n<code>/security 1|2|3</code> 严格|标准|宽松\n<code>/verify math|custom 问题|答案|off|show</code> 验证方式\n<code>/math ops +-*/ | range 1 9 | count 4 | show</code> 题库\n<code>/keyword list|add 词|del 词|reset</code> 关键词黑名单\n<code>/lang zh|en</code> 界面语言\n<code>/welcome 文本</code> 用户欢迎语（支持 {uid}）\n<code>/notice 文本</code> 用户接入须知\n\n<b>机器人管理</b>\n<code>/bot list</code> 机器人列表\n<code>/bot add id token UID [sg] [topic] [max]</code> 添加并自动注册\n<code>/bot del id</code> 删除并注销 | <code>/bot set id token|admin|sg|max 值</code>\n\n<b>广播</b>\n<code>/broadcast</code> 回复一条消息全员广播（自动跳过黑名单）',
    en: '� <b>Command Reference</b>\n\n<b>Users</b> (reply to their msg or send in their topic)\n<code>/info</code> | <code>/trust</code> | <code>/untrust</code>\n<code>/block</code> | <code>/unblock</code> | <code>/blacklist</code>\n<code>/clear</code> user mappings | <code>/clear all</code>\n\n<b>System</b>\n<code>/mode private|topic</code>\n<code>/security 1|2|3</code> strict|standard|relaxed\n<code>/verify math|custom q|a|off|show</code>\n<code>/math ops +-*/ | range 1 9 | count 4 | show</code>\n<code>/keyword list|add w|del w|reset</code>\n<code>/lang zh|en</code>\n<code>/welcome text</code> (supports {uid})\n<code>/notice text</code>\n\n<b>Bots</b>\n<code>/bot list</code>\n<code>/bot add id token UID [sg] [topic] [max]</code>\n<code>/bot del id</code> | <code>/bot set id token|admin|sg|max value</code>\n\n<b>Broadcast</b>\n<code>/broadcast</code> reply to a msg (skips blocked users)'
  },
  'bot.usage': {
    zh: '用法:\n<code>/bot list</code> 查看机器人\n<code>/bot add id token UID [sg] [topic] [max]</code> 添加\n<code>/bot del id</code> 删除\n<code>/bot set id token|admin|sg|max 值</code> 修改',
    en: 'Usage:\n<code>/bot list</code>\n<code>/bot add id token UID [sg] [topic] [max]</code>\n<code>/bot del id</code>\n<code>/bot set id token|admin|sg|max value</code>'
  },
  'bot.list.title': { zh: '机器人列表', en: 'Bot list' },
  'bot.list.empty': { zh: '（D1 中暂无记录，当前仅环境变量配置的机器人）', en: '(no bots in D1; env-configured bots only)' },
  'bot.list.usage': { zh: '<i>添加: /bot add id token UID [sg] [topic] [max]</i>', en: '<i>Add: /bot add id token UID [sg] [topic] [max]</i>' },
  'bot.add.usage': { zh: '用法: <code>/bot add id token 管理员UID [群组ID] [topic] [max]</code>', en: 'Usage: <code>/bot add id token ADMIN_UID [sg] [topic] [max]</code>' },
  'bot.add.exists': { zh: '⚠️ 机器人 <code>{id}</code> 已存在。', en: '⚠️ Bot <code>{id}</code> already exists.' },
  'bot.add.ok': { zh: '✅ 机器人 <code>{id}</code> ({name}) 已添加并自动注册 webhook，可直接使用。', en: '✅ Bot <code>{id}</code> ({name}) added and webhook auto-registered. Ready to use.' },
  'bot.add.fail': { zh: '❌ 添加失败（token 无效？）: {err}', en: '❌ Add failed (invalid token?): {err}' },
  'bot.add.webhook_fail': { zh: '⚠️ 机器人 <code>{id}</code> 已保存，但 webhook 注册失败: {err}\n请稍后手动访问 /registerWebhook/{id}', en: '⚠️ Bot <code>{id}</code> saved but webhook registration failed: {err}\nVisit /registerWebhook/{id} manually later.' },
  'bot.del.usage': { zh: '用法: <code>/bot del id</code>', en: 'Usage: <code>/bot del id</code>' },
  'bot.del.self': { zh: '⚠️ 不能删除当前正在使用的机器人。', en: '⚠️ Cannot delete the bot you are using now.' },
  'bot.del.ok': { zh: '🗑 机器人 <code>{id}</code> 已删除并注销 webhook。', en: '🗑 Bot <code>{id}</code> deleted and webhook unregistered.' },
  'bot.notfound': { zh: '⚠️ 未找到机器人 <code>{id}</code>。', en: '⚠️ Bot <code>{id}</code> not found.' },
  'bot.set.usage': { zh: '用法: <code>/bot set id token|admin|sg|max 值</code>', en: 'Usage: <code>/bot set id token|admin|sg|max value</code>' },
  'bot.set.ok': { zh: '✅ 已更新机器人 <code>{id}</code> 的 <code>{f}</code>。如改 token/admin 请重新注册 webhook。', en: '✅ Updated <code>{f}</code> for bot <code>{id}</code>. Re-register webhook if token/admin changed.' },
  'topic.reply_hint': {
    zh: '⚠️ 该话题尚未绑定用户或映射异常。请先在本话题里回复一条“来自该用户的转发消息”发送任意内容，系统会自动完成绑定。',
    en: '⚠️ This topic has no bound user. Reply to a forwarded message from that user to auto-bind.'
  },
  'map.notfound': { zh: '⚠️ 无法找到该消息的原始发送者 (可能已被清除)', en: '⚠️ Original sender not found for this message (mapping cleared?)' },
  'topic.create_fail': {
    zh: '⚠️ <b>话题创建失败</b>\nUID: {uid}\nError: {err}\n\n请检查机器人是否为群组管理员，且拥有"管理话题"权限。',
    en: '⚠️ <b>Topic creation failed</b>\nUID: {uid}\nError: {err}\n\nEnsure the bot is a group admin with "Manage Topics" permission.'
  },
  'forward.fail': { zh: '❌ <b>消息转发失败</b>\n目标 UID: {uid}\n原因: {err}', en: '❌ <b>Forward failed</b>\nTarget UID: {uid}\nReason: {err}' },
  'broadcast.usage': { zh: '⚠️ <b>使用错误</b>\n\n请回复一条您想要广播的消息，并输入 <code>/broadcast</code>', en: '⚠️ <b>Usage error</b>\n\nReply to a message you want to broadcast with <code>/broadcast</code>' },
  'broadcast.start': { zh: '📢 <b>正在开始广播...</b>\n\n目标：所有用户', en: '📢 <b>Broadcasting...</b>\n\nTarget: all users' },
  'broadcast.done': { zh: '✅ <b>广播完成</b>\n\n成功发送: {ok} 人\n失败: {fail} 人\n跳过(黑名单): {skip} 人', en: '✅ <b>Broadcast done</b>\n\nSent: {ok}\nFailed: {fail}\nSkipped (blocked): {skip}' },
  'broadcast.error': { zh: '❌ <b>广播过程中出错</b>\n\n{err}', en: '❌ <b>Broadcast error</b>\n\n{err}' }
};

function t(bot, key, vars = {}) {
  const entry = STRINGS[key];
  if (!entry) return key;
  const lang = bot.lang || DEFAULT_LANG;
  let s = entry[lang] !== undefined ? entry[lang] : entry[DEFAULT_LANG];
  for (const [k, v] of Object.entries(vars)) {
    s = s.split('{' + k + '}').join(String(v));
  }
  return s;
}

// ---------------- 机器人配置解析 ----------------

function parseBots(env) {
  let list = [];
  try { list = JSON.parse(env.ENV_BOTS || '[]'); } catch (e) { console.error('ENV_BOTS parse error:', e); }
  const bots = {};
  for (const b of list) {
    if (b && b.id && b.token) bots[String(b.id)] = b;
  }
  // 兼容旧单机器人配置
  if (env.ENV_BOT_TOKEN && !bots[DEFAULT_BOT_ID]) {
    bots[DEFAULT_BOT_ID] = {
      id: DEFAULT_BOT_ID,
      token: env.ENV_BOT_TOKEN,
      admin: env.ENV_ADMIN_UID,
      sg: env.ENV_SUPERGROUP_ID,
      topic: env.ENV_ENABLE_TOPIC_GROUP === 'true',
      secret: env.ENV_BOT_SECRET,
      max: env.ENV_MAX_MSG_PER_MIN
    };
  }
  return bots;
}

// Worker 自身域名（用于面板内自动注册 webhook）
let WORKER_ORIGIN = '';

// 构建带机器人上下文与已加载配置的 bot 对象。优先读 D1 bots 表（面板管理），回退到 ENV_BOTS 环境变量。
async function resolveBot(env, botId) {
  let cfg = null;
  if (env.DB) {
    cfg = await env.DB.prepare('SELECT * FROM bots WHERE bot_id = ?').bind(botId).first();
  }
  if (!cfg) {
    const fromEnv = parseBots(env)[botId];
    if (!fromEnv) return null;
    cfg = { bot_id: fromEnv.id, token: fromEnv.token, admin_uid: String(fromEnv.admin || ''), sg: String(fromEnv.sg || ''), topic: (fromEnv.topic === true || fromEnv.topic === 'true') ? 1 : 0, max: fromEnv.max, secret: fromEnv.secret || '' };
  }
  const bot = {
    id: botId,
    db: env.DB,
    token: cfg.token,
    adminUid: String(cfg.admin_uid || ''),
    supergroupId: String(cfg.sg || ''),
    defaultTopicMode: !!cfg.topic,
    maxPerMin: cfg.max ? (parseInt(cfg.max) || 40) : 40,
    secretEnv: cfg.secret || '',
    lang: DEFAULT_LANG,
    security: DEFAULT_SECURITY_LEVEL,
    verifyMode: 'math',
    topicMode: false,
    math: { ops: '+-*/', min: 1, max: 9, count: 4 }
  };
  bot.lang = (await settingGet(bot, 'config:lang')) || DEFAULT_LANG;
  const sec = await settingGet(bot, 'config:security_level');
  bot.security = sec === null ? DEFAULT_SECURITY_LEVEL : parseInt(sec);
  bot.verifyMode = (await settingGet(bot, 'config:verify_mode')) || 'math';
  const tm = await settingGet(bot, 'config:enable_topic_group');
  bot.topicMode = tm === null ? bot.defaultTopicMode : (tm === 'true');
  bot.math = {
    ops: (await settingGet(bot, 'config:math_ops')) || '+-*/',
    min: parseInt((await settingGet(bot, 'config:math_min')) || '1'),
    max: parseInt((await settingGet(bot, 'config:math_max')) || '9'),
    count: parseInt((await settingGet(bot, 'config:math_count')) || '4')
  };
  return bot;
}

// ---------------- D1 存储层 ----------------

const TABLES = ['user_states', 'message_mappings', 'chat_topic_mappings', 'message_hashes', 'keywords', 'settings'];

async function createTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_states (
    bot_id TEXT NOT NULL DEFAULT 'default',
    chat_id TEXT NOT NULL,
    is_blocked INTEGER DEFAULT 0,
    is_trusted INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    verified_expiry INTEGER DEFAULT 0,
    is_rate_limited INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    window_start INTEGER DEFAULT 0,
    pending_question TEXT,
    pending_answer TEXT,
    pending_code_expiry INTEGER DEFAULT 0,
    pending_attempts INTEGER DEFAULT 0,
    first_card_sent INTEGER DEFAULT 0,
    PRIMARY KEY (bot_id, chat_id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS message_mappings (
    bot_id TEXT NOT NULL DEFAULT 'default',
    admin_message_id TEXT NOT NULL,
    guest_chat_id TEXT NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (bot_id, admin_message_id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS chat_topic_mappings (
    bot_id TEXT NOT NULL DEFAULT 'default',
    chat_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    PRIMARY KEY (bot_id, chat_id)
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_ctm_topic ON chat_topic_mappings(bot_id, topic_id)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS message_hashes (
    bot_id TEXT NOT NULL DEFAULT 'default',
    hash TEXT NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (bot_id, hash)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS keywords (
    bot_id TEXT NOT NULL DEFAULT 'default',
    word TEXT NOT NULL,
    PRIMARY KEY (bot_id, word)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS settings (
    bot_id TEXT NOT NULL DEFAULT 'default',
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (bot_id, key)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS bots (
    bot_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    admin_uid TEXT NOT NULL DEFAULT '',
    sg TEXT NOT NULL DEFAULT '',
    topic INTEGER DEFAULT 0,
    max INTEGER DEFAULT 40,
    secret TEXT NOT NULL DEFAULT '',
    created_at INTEGER
  )`).run();
}

// 检测旧表结构（无 bot_id 列）并自动迁移，旧数据归入 default 机器人
let tablesReady = false;
let tablesPromise = null;
async function ensureTables(db) {
  if (tablesReady) return;
  if (!tablesPromise) {
    tablesPromise = doEnsureTables(db).then(() => { tablesReady = true; }).catch(e => { tablesPromise = null; throw e; });
  }
  return tablesPromise;
}

async function doEnsureTables(db) {
  const toMigrate = [];
  for (const name of TABLES) {
    const info = await db.prepare(`PRAGMA table_info(${name})`).all();
    if (info.results.length && !info.results.some(c => c.name === 'bot_id')) {
      toMigrate.push(name);
    }
  }
  for (const name of toMigrate) {
    await db.exec(`ALTER TABLE ${name} RENAME TO _old_${name}`);
  }
  await createTables(db);
  for (const name of toMigrate) {
    await db.exec(`INSERT INTO ${name} SELECT 'default', * FROM _old_${name}`);
    await db.exec(`DROP TABLE _old_${name}`);
  }
}

async function settingGet(bot, key, dflt = null) {
  const row = await bot.db.prepare('SELECT value FROM settings WHERE bot_id = ? AND key = ?').bind(bot.id, key).first();
  if (!row) return dflt;
  return row.value;
}

async function settingSet(bot, key, value) {
  await bot.db.prepare('INSERT OR REPLACE INTO settings (bot_id, key, value) VALUES (?, ?, ?)').bind(bot.id, key, String(value)).run();
}

async function settingDel(bot, key) {
  await bot.db.prepare('DELETE FROM settings WHERE bot_id = ? AND key = ?').bind(bot.id, key).run();
}

async function getUserState(bot, chatId) {
  const row = await bot.db.prepare('SELECT * FROM user_states WHERE bot_id = ? AND chat_id = ?').bind(bot.id, String(chatId)).first();
  if (row) return row;
  const def = {
    bot_id: bot.id, chat_id: String(chatId), is_blocked: 0, is_trusted: 0, is_verified: 0, verified_expiry: 0,
    is_rate_limited: 0, message_count: 0, window_start: 0,
    pending_question: null, pending_answer: null, pending_code_expiry: 0, pending_attempts: 0,
    first_card_sent: 0
  };
  await bot.db.prepare(`INSERT INTO user_states (bot_id, chat_id, is_blocked, is_trusted, is_verified, verified_expiry,
    is_rate_limited, message_count, window_start, pending_code_expiry, pending_attempts, first_card_sent)
    VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`).bind(bot.id, def.chat_id).run();
  return def;
}

async function setUserState(bot, chatId, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const sets = cols.map(c => `${c} = ?`).join(', ');
  const vals = cols.map(c => fields[c]);
  await bot.db.prepare(`UPDATE user_states SET ${sets} WHERE bot_id = ? AND chat_id = ?`).bind(...vals, bot.id, String(chatId)).run();
}

async function getBotSecret(bot) {
  if (bot.secretEnv) return bot.secretEnv;
  const s = await settingGet(bot, 'system:bot_secret');
  if (s) return s;
  const newSecret = crypto.randomUUID().replace(/-/g, '');
  await settingSet(bot, 'system:bot_secret', newSecret);
  return newSecret;
}

async function setTopicModeEnabled(bot, enabled) {
  await settingSet(bot, 'config:enable_topic_group', enabled ? 'true' : 'false');
  bot.topicMode = enabled;
}

async function getKeywords(bot) {
  const res = await bot.db.prepare('SELECT word FROM keywords WHERE bot_id = ?').bind(bot.id).all();
  return res.results.map(r => r.word);
}

async function ensureKeywordsSeeded(bot) {
  const c = await bot.db.prepare('SELECT COUNT(*) AS n FROM keywords WHERE bot_id = ?').bind(bot.id).first();
  if (c.n === 0) {
    const stmt = bot.db.prepare('INSERT OR IGNORE INTO keywords (bot_id, word) VALUES (?, ?)');
    await bot.db.batch(DEFAULT_KEYWORDS.map(w => stmt.bind(bot.id, w)));
  }
}

// ---------------- 题库生成 ----------------

function generateMathChallenge(math) {
  const ops = (math.ops || '+-*/').split('');
  const op = ops[secureRandomInt(0, ops.length)];
  const min = math.min, max = math.max;
  let questionText = '', answer = 0;

  if (op === '+') {
    const a = secureRandomInt(min, max + 1), b = secureRandomInt(min, max + 1);
    questionText = `${a} + ${b} = ?`;
    answer = a + b;
  } else if (op === '-') {
    let a = secureRandomInt(min, max + 1), b = secureRandomInt(min, max + 1);
    if (a < b) [a, b] = [b, a];
    questionText = `${a} - ${b} = ?`;
    answer = a - b;
  } else if (op === '*') {
    const a = secureRandomInt(2, 13), b = secureRandomInt(2, 13);
    questionText = `${a} × ${b} = ?`;
    answer = a * b;
  } else {
    const b = secureRandomInt(2, 9), q = secureRandomInt(2, 9);
    const a = b * q;
    questionText = `${a} ÷ ${b} = ?`;
    answer = q;
  }

  const incorrect = new Set();
  let guard = 0;
  while (incorrect.size < Math.max(1, math.count - 1) && guard < 200) {
    guard++;
    const offset = secureRandomInt(1, Math.max(5, Math.floor(answer / 2) + 2));
    const wrong = secureRandomInt(0, 2) === 0 ? answer + offset : answer - offset;
    if (wrong !== answer && wrong >= 0) incorrect.add(String(wrong));
  }
  while (incorrect.size < math.count - 1) {
    incorrect.add(String(answer + incorrect.size + 1));
  }

  return {
    question: questionText,
    correct_answer: String(answer),
    incorrect_answers: Array.from(incorrect).slice(0, Math.max(1, math.count - 1))
  };
}

// ---------------- 工具函数 ----------------

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function secureRandomInt(min, max) {
  const range = max - min;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return min + (bytes[0] % range);
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = secureRandomInt(0, i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function apiUrl(bot, methodName, params = null) {
  let query = '';
  if (params) query = '?' + new URLSearchParams(params).toString();
  return `https://api.telegram.org/bot${bot.token}/${methodName}${query}`;
}

function requestTelegram(bot, methodName, body, params = null) {
  return fetch(apiUrl(bot, methodName, params), body).then(r => r.json());
}

function makeReqBody(body) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function sendMessage(bot, msg = {}) { return requestTelegram(bot, 'sendMessage', makeReqBody(msg)); }
function copyMessage(bot, msg = {}) { return requestTelegram(bot, 'copyMessage', makeReqBody(msg)); }
function forwardMessage(bot, msg) { return requestTelegram(bot, 'forwardMessage', makeReqBody(msg)); }
function createForumTopic(bot, chat_id, name) { return requestTelegram(bot, 'createForumTopic', makeReqBody({ chat_id, name })); }
function editForumTopic(bot, chat_id, message_thread_id, name) { return requestTelegram(bot, 'editForumTopic', makeReqBody({ chat_id, message_thread_id, name })); }
function answerCallbackQuery(bot, callback_query_id, text, show_alert = false) { return requestTelegram(bot, 'answerCallbackQuery', makeReqBody({ callback_query_id, text, show_alert })); }
function deleteMessage(bot, chat_id, message_id) { return requestTelegram(bot, 'deleteMessage', makeReqBody({ chat_id, message_id })); }
function pinMessage(bot, chat_id, message_id) { return requestTelegram(bot, 'pinChatMessage', makeReqBody({ chat_id, message_id })); }
function unpinMessage(bot, chat_id, message_id) { return requestTelegram(bot, 'unpinChatMessage', makeReqBody({ chat_id, message_id })); }

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------- 路由入口 ----------------

export default {
  async fetch(request, env, ctx) {
    // 先确保表结构就绪（建表/旧表迁移），否则 registerWebhook 读 settings 会因缺表/缺列抛异常
    if (env.DB) {
      await ensureTables(env.DB);
    }
    const url = new URL(request.url);
    WORKER_ORIGIN = `${url.protocol}//${url.hostname}`;
    const p = url.pathname;
    let m;

    if (p === WEBHOOK || (m = p.match(/^\/endpoint\/([A-Za-z0-9_-]+)$/))) {
      const bot = await resolveBot(env, m ? m[1] : DEFAULT_BOT_ID);
      if (!bot) return new Response('Unknown bot', { status: 404 });
      return handleWebhook(bot, request, ctx);
    }
    if (p === '/registerWebhook' || (m = p.match(/^\/registerWebhook\/([A-Za-z0-9_-]+)$/))) {
      const bot = await resolveBot(env, m ? m[1] : DEFAULT_BOT_ID);
      if (!bot) return new Response('Unknown bot', { status: 404 });
      const secret = await getBotSecret(bot);
      return registerWebhook(bot, url, WEBHOOK, secret);
    }
    if (p === '/unRegisterWebhook' || (m = p.match(/^\/unRegisterWebhook\/([A-Za-z0-9_-]+)$/))) {
      const bot = await resolveBot(env, m ? m[1] : DEFAULT_BOT_ID);
      if (!bot) return new Response('Unknown bot', { status: 404 });
      return unRegisterWebhook(bot);
    }
    return new Response('No handler for this request');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env, event));
  }
};

async function handleScheduled(env, event) {
  const db = env.DB;
  await ensureTables(db);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare('DELETE FROM message_hashes WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now).run();
  await db.prepare('DELETE FROM user_states WHERE pending_code_expiry > 0 AND pending_code_expiry < ?').bind(now).run();
  console.log('Cron cleanup done at', event ? event.scheduledTime : Date.now());
}

async function handleWebhook(bot, request, ctx) {
  const secret = await getBotSecret(bot);
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    return new Response('Unauthorized', { status: 403 });
  }
  const update = await request.json();
  ctx.waitUntil(onUpdate(bot, update));
  return new Response('Ok');
}

async function onUpdate(bot, update) {
  await ensureTables(bot.db);
  await ensureKeywordsSeeded(bot);

  if ('message' in update) {
    await onMessage(bot, update.message);
  } else if ('callback_query' in update) {
    await handleCallback(bot, update.callback_query);
  }
}

async function onMessage(bot, message) {
  // 忽略服务消息
  if (message.new_chat_members || message.left_chat_member || message.group_chat_created ||
      message.supergroup_chat_created || message.channel_chat_created || message.pinned_message) {
    return new Response('Ok');
  }

  if (message.text === '/start') {
    let startMsg;
    if (message.chat.id.toString() === bot.adminUid) {
      startMsg = t(bot, 'welcome.admin', {
        uid: message.chat.id,
        mode: bot.topicMode ? t(bot, 'mode.topic') : t(bot, 'mode.private'),
        sgWarn: (bot.topicMode && !bot.supergroupId) ? t(bot, 'mode.warn.nosg') : ''
      });
    } else {
      const customWelcome = await settingGet(bot, 'config:welcome');
      if (customWelcome) {
        // 支持 {uid} 占位符
        startMsg = escapeHtml(customWelcome).split('{uid}').join(String(message.chat.id));
      } else {
        startMsg = t(bot, 'welcome.user', { uid: message.chat.id });
      }
    }
    return sendMessage(bot, { chat_id: message.chat.id, text: startMsg, parse_mode: 'HTML' });
  }

  if (bot.supergroupId && message.chat.id.toString() === bot.supergroupId) {
    const fromAdmin = message.from && message.from.id && message.from.id.toString() === bot.adminUid;
    const anonymousAdmin = message.sender_chat && message.sender_chat.id && message.sender_chat.id.toString() === bot.supergroupId;
    if (fromAdmin || anonymousAdmin) return handleAdminMessage(bot, message);
    return new Response('Ok');
  }

  if (message.chat.id.toString() === bot.adminUid) {
    return handleAdminMessage(bot, message);
  }

  return handleGuestMessage(bot, message);
}

// ---------------- 管理员逻辑 ----------------

// 指令分发：文本指令与内联按钮共用。返回 Response 表示已处理，返回 undefined 表示非指令。
async function dispatchAdminCommand(bot, text, message) {
  if (text.startsWith('/help')) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'help.text'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  if (text.startsWith('/admin')) return handleAdminMenu(bot, message);
  if (text.startsWith('/mode')) return handleModeCommand(bot, message);
  if (text.startsWith('/info')) return handleInfoCommand(bot, message);
  if (text.startsWith('/trust')) return handleTrustCommand(bot, message);
  if (text.startsWith('/untrust')) return handleUntrustCommand(bot, message);
  if (text.startsWith('/block')) return handleBlockCommand(bot, message);
  if (text.startsWith('/unblock')) return handleUnblockCommand(bot, message);
  if (text.startsWith('/blacklist')) return handleBlacklistCommand(bot, message);
  if (text.startsWith('/security')) return handleSecurityCommand(bot, message);
  if (text.startsWith('/broadcast')) return handleBroadcastCommand(bot, message);
  if (text.startsWith('/verify')) return handleVerifyCommand(bot, message);
  if (text.startsWith('/math')) return handleMathCommand(bot, message);
  if (text.startsWith('/keyword')) return handleKeywordCommand(bot, message);
  if (text.startsWith('/lang')) return handleLangCommand(bot, message);
  if (text.startsWith('/clear')) return handleClearCommand(bot, message);
  if (text.startsWith('/notice')) return handleNoticeCommand(bot, message);
  if (text.startsWith('/welcome')) return handleWelcomeCommand(bot, message);
  if (text.startsWith('/bot')) return handleBotCommand(bot, message);
  return undefined;
}

async function handleAdminMessage(bot, message) {
  if (message.text) {
    const r = await dispatchAdminCommand(bot, message.text.trim(), message);
    if (r !== undefined) return r;
  }

  // 话题模式：在超级群组话题中回复 -> 转回绑定用户
  if (bot.topicMode && bot.supergroupId && message.chat.id.toString() === bot.supergroupId && message.message_thread_id) {
    const topicId = message.message_thread_id;
    const row = await bot.db.prepare('SELECT chat_id FROM chat_topic_mappings WHERE bot_id = ? AND topic_id = ?').bind(bot.id, String(topicId)).first();
    let userId = row ? row.chat_id : null;

    if ((!userId || userId.toString() === bot.adminUid) && message.reply_to_message) {
      const map = await bot.db.prepare('SELECT guest_chat_id FROM message_mappings WHERE bot_id = ? AND admin_message_id = ?')
        .bind(bot.id, String(message.reply_to_message.message_id)).first();
      if (map) {
        userId = map.guest_chat_id;
        await bot.db.prepare('INSERT OR REPLACE INTO chat_topic_mappings (bot_id, chat_id, topic_id) VALUES (?, ?, ?)')
          .bind(bot.id, String(userId), String(topicId)).run();
      }
    }

    if (userId && userId.toString() !== bot.adminUid) {
      return copyMessage(bot, { chat_id: userId, from_chat_id: message.chat.id, message_id: message.message_id });
    }

    return sendMessage(bot, {
      chat_id: message.chat.id,
      text: t(bot, 'topic.reply_hint'),
      message_thread_id: topicId
    });
  } else {
    // 私聊模式：回复转发的消息
    if (message.reply_to_message) {
      const map = await bot.db.prepare('SELECT guest_chat_id FROM message_mappings WHERE bot_id = ? AND admin_message_id = ?')
        .bind(bot.id, String(message.reply_to_message.message_id)).first();
      if (map) {
        return copyMessage(bot, { chat_id: map.guest_chat_id, from_chat_id: message.chat.id, message_id: message.message_id });
      }
      if (message.chat.id.toString() === bot.adminUid) {
        return sendMessage(bot, {
          chat_id: message.chat.id,
          text: t(bot, 'map.notfound'),
          reply_to_message_id: message.message_id
        });
      }
    }
  }
}

// ---------------- 普通用户逻辑 ----------------

async function handleGuestMessage(bot, message) {
  const chatId = message.chat.id;
  const state = await getUserState(bot, chatId);
  const now = Math.floor(Date.now() / 1000);

  // 1. 黑名单检查（trusted 权限高于 blocked）
  if (state.is_blocked && !state.is_trusted) {
    return new Response('Ok');
  }

  // 2. 自定义问答等待中（仅 custom 模式拦截文本作答；已验证/信任用户不受影响）
  const stillVerified = state.is_verified && state.verified_expiry > now;
  if (bot.verifyMode === 'custom' && state.pending_answer && state.pending_code_expiry > now && !state.is_trusted && !stillVerified) {
    const isText = !!message.text;
    if (isText) {
      const answerGiven = message.text.trim().toLowerCase();
      if (answerGiven === state.pending_answer.trim().toLowerCase()) {
        await setUserState(bot, chatId, {
          is_verified: 1, verified_expiry: now + VERIFY_TTL_SECONDS,
          pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0,
          is_rate_limited: 0, message_count: 0, window_start: 0
        });
        await sendMessage(bot, { chat_id: chatId, text: t(bot, 'verify.passed'), parse_mode: 'HTML' });
        return new Response('Ok');
      } else {
        const attempts = (state.pending_attempts || 0) + 1;
        await setUserState(bot, chatId, { pending_attempts: attempts });
        if (attempts >= 3) {
          await setUserState(bot, chatId, { pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0 });
          return sendMessage(bot, { chat_id: chatId, text: t(bot, 'verify.wrong') + '\n' + t(bot, 'rate.limited') });
        }
        return sendMessage(bot, { chat_id: chatId, text: t(bot, 'verify.wrong') });
      }
    }
    // 媒体消息在等待答案时不允许
    await sendVerificationChallenge(bot, chatId, message.message_id);
    return new Response('Ok');
  }

  // 3. 频率限制（60 秒固定窗口）
  let newCount, newWindow;
  if (!state.window_start || (now - state.window_start) >= 60) {
    newCount = 1;
    newWindow = now;
  } else {
    newCount = state.message_count + 1;
    newWindow = state.window_start;
  }
  await setUserState(bot, chatId, { message_count: newCount, window_start: newWindow });

  const rateLimited = newCount > bot.maxPerMin;
  if (rateLimited && !state.is_rate_limited) {
    await setUserState(bot, chatId, { is_rate_limited: 1, is_verified: 0, verified_expiry: 0 });
    await sendMessage(bot, { chat_id: chatId, text: t(bot, 'rate.limited') });
  }
  if (rateLimited) {
    return sendVerificationChallenge(bot, chatId, message.message_id);
  }

  // 4. 验证状态判定
  const isTrusted = !!state.is_trusted;
  const isVerified = !isTrusted && state.is_verified && state.verified_expiry > now;
  const securityLevel = bot.security;

  let allowed = false;
  const isText = !!message.text;

  if (isTrusted || bot.verifyMode === 'off') {
    allowed = true;
  } else if (isVerified) {
    allowed = true;
  } else if (securityLevel === SECURITY_RELAXED) {
    allowed = true;
  } else if (securityLevel === SECURITY_STANDARD) {
    allowed = isText;
  } else if (securityLevel === SECURITY_STRICT) {
    allowed = false;
  }

  // 5. 被拦截 -> 验证挑战
  if (!allowed) {
    return sendVerificationChallenge(bot, chatId, message.message_id);
  }

  // 6. 放行 -> 关键词/去重检查（仅文本，trusted 豁免）
  if (message.text && !isTrusted) {
    const keywords = await getKeywords(bot);
    const hit = keywords.some(k => message.text.includes(k));
    if (hit) return new Response('Ok');

    const hash = await sha256(message.text.trim());
    const dup = await bot.db.prepare('SELECT hash FROM message_hashes WHERE bot_id = ? AND hash = ? AND (expires_at IS NULL OR expires_at > ?)')
      .bind(bot.id, hash, now).first();
    if (dup) return new Response('Ok');
    await bot.db.prepare('INSERT OR REPLACE INTO message_hashes (bot_id, hash, expires_at) VALUES (?, ?, ?)')
      .bind(bot.id, hash, now + DEDUPE_TTL_SECONDS).run();
  }

  let topicId = null;
  let forwardChatId = bot.adminUid;

  if (bot.topicMode && bot.supergroupId) {
    forwardChatId = bot.supergroupId;
    const row = await bot.db.prepare('SELECT topic_id FROM chat_topic_mappings WHERE bot_id = ? AND chat_id = ?').bind(bot.id, String(chatId)).first();
    topicId = row ? row.topic_id : null;

    if (!topicId) {
      let title = `${message.chat.first_name || ''} ${message.chat.last_name || ''}`.trim();
      if (message.chat.username) title += ` (@${message.chat.username})`;
      if (!title) title = `User ${chatId}`;
      if (title.length > 128) title = title.substring(0, 125) + '...';

      const topicRes = await createForumTopic(bot, bot.supergroupId, title);
      if (topicRes.ok) {
        topicId = String(topicRes.result.message_thread_id);
        await bot.db.prepare('INSERT OR REPLACE INTO chat_topic_mappings (bot_id, chat_id, topic_id) VALUES (?, ?, ?)')
          .bind(bot.id, String(chatId), topicId).run();
        await sendFirstCard(bot, { chatId, message, topicMode: true, topicId });
      } else {
        console.error('Create topic failed:', JSON.stringify(topicRes));
        await sendMessage(bot, {
          chat_id: bot.supergroupId,
          text: t(bot, 'topic.create_fail', { uid: chatId, err: topicRes.description || 'Unknown error' }),
          parse_mode: 'HTML'
        });
      }
    }
  }

  // 7. 转发（copyMessage 穿透隐私设置）
  const forwardBody = {
    chat_id: forwardChatId,
    from_chat_id: chatId,
    message_id: message.message_id
  };
  if (topicId) forwardBody.message_thread_id = parseInt(topicId);

  const forwardReq = await copyMessage(bot, forwardBody);
  if (forwardReq.ok) {
    const adminMsgId = String(forwardReq.result.message_id);
    await bot.db.prepare('INSERT OR REPLACE INTO message_mappings (bot_id, admin_message_id, guest_chat_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(bot.id, adminMsgId, String(chatId), now).run();
    await settingSet(bot, 'last_guest', String(chatId));

    if (!bot.topicMode && !topicId && !state.first_card_sent) {
      // 私聊模式首次消息 -> 管理员私聊置顶信息卡
      await sendFirstCard(bot, { chatId, message, topicMode: false });
    }
  } else {
    console.error('Forward/Copy message failed:', JSON.stringify(forwardReq));
    await sendMessage(bot, {
      chat_id: bot.adminUid,
      text: t(bot, 'forward.fail', { uid: chatId, err: forwardReq.description || 'Unknown' }),
      parse_mode: 'HTML'
    });
  }
}

// 首次置顶信息卡：昵称/用户名/UserID/发起时间；发新卡前自动 unpin 上一张。同时给用户发接入须知。
async function sendFirstCard(bot, { chatId, message, topicMode, topicId = null }) {
  try {
    const state = await getUserState(bot, chatId);
    if (state.first_card_sent) return;

    const notice = (await settingGet(bot, 'config:notification')) || t(bot, 'notice.default');

    // 1. 给管理员端发置顶信息卡
    const targetChat = topicMode ? bot.supergroupId : bot.adminUid;
    const body = {
      chat_id: targetChat,
      text: t(bot, 'pin.card', {
        name: escapeHtml(`${message.chat.first_name || ''} ${message.chat.last_name || ''}`.trim() || '—'),
        username: message.chat.username ? '@' + message.chat.username : '—',
        uid: chatId,
        time: new Date().toLocaleString(bot.lang === 'zh' ? 'zh-CN' : 'en-US')
      }),
      parse_mode: 'HTML'
    };
    if (topicMode && topicId) body.message_thread_id = parseInt(topicId);

    // 2. 给用户本人发送接入须知
    await sendMessage(bot, {
      chat_id: chatId,
      text: t(bot, 'notice.user', { notice }),
      parse_mode: 'HTML'
    });

    const res = await sendMessage(bot, body);
    if (res.ok) {
      const msgId = res.result.message_id;
      const pinKey = topicMode ? `pin:topic:${topicId}` : 'pin:private';
      const prev = await settingGet(bot, pinKey);
      if (prev) {
        try { await unpinMessage(bot, targetChat, parseInt(prev)); } catch (e) { /* 旧消息可能已删除 */ }
      }
      await pinMessage(bot, targetChat, msgId);
      await settingSet(bot, pinKey, String(msgId));
      await setUserState(bot, chatId, { first_card_sent: 1 });
    }
  } catch (e) {
    console.error('sendFirstCard error:', e);
  }
}

// ---------------- 验证逻辑 ----------------

async function sendVerificationChallenge(bot, chatId, pendingMsgId) {
  if (bot.verifyMode === 'custom') {
    const q = await settingGet(bot, 'config:custom_question');
    const a = await settingGet(bot, 'config:custom_answer');
    if (q && a) {
      const now = Math.floor(Date.now() / 1000);
      await setUserState(bot, chatId, {
        pending_question: q, pending_answer: a,
        pending_code_expiry: now + CODE_TTL_SECONDS, pending_attempts: 0
      });
      return sendMessage(bot, {
        chat_id: chatId,
        text: `${t(bot, 'verify.title')}\n\n${t(bot, 'verify.custom_text', { q })}`,
        parse_mode: 'HTML',
        reply_to_message_id: pendingMsgId
      });
    }
    // 未配置自定义题目时降级为算术题
    await sendMessage(bot, { chat_id: chatId, text: t(bot, 'verify.custom_notset') });
  }

  const challenge = generateMathChallenge(bot.math);
  const options = [
    { text: challenge.correct_answer, isCorrect: true },
    ...challenge.incorrect_answers.map(ans => ({ text: ans, isCorrect: false }))
  ];
  shuffleArray(options);

  const correctIndex = options.findIndex(o => o.isCorrect);
  const now = Math.floor(Date.now() / 1000);
  await setUserState(bot, chatId, {
    pending_answer: String(correctIndex),
    pending_question: challenge.question,
    pending_code_expiry: now + CODE_TTL_SECONDS,
    pending_attempts: 0
  });

  const keyboard = options.map((opt, idx) => ({
    text: opt.text,
    callback_data: `verify:${chatId}:${idx}`
  }));

  const rows = [];
  for (let i = 0; i < keyboard.length; i += 2) {
    rows.push(keyboard.slice(i, i + 2));
  }

  return sendMessage(bot, {
    chat_id: chatId,
    text: `${t(bot, 'verify.title')}\n\n${t(bot, 'verify.math_text', { q: challenge.question })}`,
    parse_mode: 'HTML',
    reply_to_message_id: pendingMsgId,
    reply_markup: { inline_keyboard: rows }
  });
}

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data;

  // 管理面板内联按钮：点击即执行指令（仅管理员）
  if (data.startsWith('cmd:')) {
    const fromAdmin = callbackQuery.from && callbackQuery.from.id && callbackQuery.from.id.toString() === bot.adminUid;
    if (!fromAdmin) {
      return answerCallbackQuery(bot, callbackQuery.id, '⛔ Admin only', true);
    }
    const cmdText = data.slice(4);
    const fakeMessage = {
      chat: { id: callbackQuery.message.chat.id },
      message_id: callbackQuery.message.message_id,
      message_thread_id: callbackQuery.message.message_thread_id,
      text: cmdText,
      allowLastGuest: true
    };
    await dispatchAdminCommand(bot, cmdText, fakeMessage);
    return answerCallbackQuery(bot, callbackQuery.id, '✅');
  }

  if (!data.startsWith('verify:')) return;

  const [_, uidStr, answerIdxStr] = data.split(':');
  const answerIdx = parseInt(answerIdxStr);
  const chatId = callbackQuery.message.chat.id;
  const now = Math.floor(Date.now() / 1000);

  const state = await getUserState(bot, chatId);

  if (!state.pending_answer || state.pending_code_expiry <= now) {
    return answerCallbackQuery(bot, callbackQuery.id, t(bot, 'verify.expired'), true);
  }

  const correctIdx = parseInt(state.pending_answer);

  if (answerIdx === correctIdx) {
    await setUserState(bot, chatId, {
      is_verified: 1, verified_expiry: now + VERIFY_TTL_SECONDS,
      pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0,
      is_rate_limited: 0, message_count: 0, window_start: 0
    });
    await requestTelegram(bot, 'editMessageText', makeReqBody({
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: t(bot, 'verify.passed'),
      parse_mode: 'HTML'
    }));
    return answerCallbackQuery(bot, callbackQuery.id, '✅');
  } else {
    const attempts = (state.pending_attempts || 0) + 1;
    await setUserState(bot, chatId, { pending_attempts: attempts });
    if (attempts >= 3) {
      await setUserState(bot, chatId, { pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0 });
      return answerCallbackQuery(bot, callbackQuery.id, t(bot, 'verify.wrong'), true);
    }
    return answerCallbackQuery(bot, callbackQuery.id, t(bot, 'verify.wrong'), true);
  }
}

// ---------------- 指令处理 ----------------

async function getTargetUserId(bot, message) {
  // 1. 话题模式：优先从话题绑定关系中获取
  const topicId = message.message_thread_id;
  if (topicId) {
    const row = await bot.db.prepare('SELECT chat_id FROM chat_topic_mappings WHERE bot_id = ? AND topic_id = ?').bind(bot.id, String(topicId)).first();
    if (row) return row.chat_id;
  }
  // 2. 通用/私聊模式：通过回复转发的消息来获取
  if (message.reply_to_message) {
    const row = await bot.db.prepare('SELECT guest_chat_id FROM message_mappings WHERE bot_id = ? AND admin_message_id = ?')
      .bind(bot.id, String(message.reply_to_message.message_id)).first();
    if (row) return row.guest_chat_id;
  }
  // 3. 内联按钮场景（无回复上下文）：回退到最近一个来消息的用户
  if (message.allowLastGuest) {
    const last = await settingGet(bot, 'last_guest');
    if (last) return last;
  }
  return null;
}

async function handleInfoCommand(bot, message) {
  const userId = await getTargetUserId(bot, message);
  if (!userId) {
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'target.unknown'), message_thread_id: message.message_thread_id });
  }
  const state = await getUserState(bot, userId);
  const now = Math.floor(Date.now() / 1000);

  let statusText;
  if (state.is_blocked) statusText = t(bot, 'info.status.blocked');
  else if (state.is_trusted) statusText = t(bot, 'info.status.trusted');
  else if (state.is_verified && state.verified_expiry > now) statusText = t(bot, 'info.status.verified');
  else statusText = t(bot, 'info.status.unverified');
  if (state.is_rate_limited) statusText += ' / ' + t(bot, 'info.status.limited');

  const text = `${t(bot, 'info.title')}\nUID: <code>${userId}</code>\nStatus: ${statusText}\nLink: <a href="tg://user?id=${userId}">${t(bot, 'info.link')}</a>`;
  return sendMessage(bot, { chat_id: message.chat.id, text, parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleTrustCommand(bot, message) {
  const userId = await getTargetUserId(bot, message);
  if (!userId) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'target.unknown'), message_thread_id: message.message_thread_id });
  await setUserState(bot, userId, { is_trusted: 1, is_blocked: 0, is_verified: 1, verified_expiry: Math.floor(Date.now() / 1000) + VERIFY_TTL_SECONDS });
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'trust.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleUntrustCommand(bot, message) {
  const userId = await getTargetUserId(bot, message);
  if (!userId) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'target.unknown'), message_thread_id: message.message_thread_id });
  await setUserState(bot, userId, { is_trusted: 0 });
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'untrust.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleBlockCommand(bot, message) {
  const userId = await getTargetUserId(bot, message);
  if (!userId) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'target.unknown'), message_thread_id: message.message_thread_id });
  await setUserState(bot, userId, { is_blocked: 1, is_trusted: 0, is_verified: 0, verified_expiry: 0 });
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'block.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleUnblockCommand(bot, message) {
  const userId = await getTargetUserId(bot, message);
  if (!userId) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'target.unknown'), message_thread_id: message.message_thread_id });
  await setUserState(bot, userId, { is_blocked: 0 });
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'unblock.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleBlacklistCommand(bot, message) {
  const res = await bot.db.prepare('SELECT chat_id FROM user_states WHERE bot_id = ? AND is_blocked = 1 ORDER BY chat_id').bind(bot.id).all();
  if (!res.results.length) {
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'blacklist.empty'), message_thread_id: message.message_thread_id });
  }
  const list = res.results.map(r => `<code>${r.chat_id}</code>`).join(', ');
  return sendMessage(bot, {
    chat_id: message.chat.id,
    text: `${t(bot, 'blacklist.title', { n: res.results.length })}\n${list}`,
    parse_mode: 'HTML',
    message_thread_id: message.message_thread_id
  });
}

async function handleClearCommand(bot, message) {
  const text = message.text.trim();
  if (text === '/clear all') {
    await bot.db.prepare('DELETE FROM message_mappings WHERE bot_id = ?').bind(bot.id).run();
    await bot.db.prepare('DELETE FROM chat_topic_mappings WHERE bot_id = ?').bind(bot.id).run();
    await settingDel(bot, 'pin:private');
    const pins = await bot.db.prepare("SELECT key FROM settings WHERE bot_id = ? AND key LIKE 'pin:topic:%'").bind(bot.id).all();
    for (const p of pins.results) await settingDel(bot, p.key);
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'clear.all.done'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  const userId = await getTargetUserId(bot, message);
  if (!userId) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'target.unknown'), message_thread_id: message.message_thread_id });
  await bot.db.prepare('DELETE FROM message_mappings WHERE bot_id = ? AND guest_chat_id = ?').bind(bot.id, String(userId)).run();
  await bot.db.prepare('DELETE FROM chat_topic_mappings WHERE bot_id = ? AND chat_id = ?').bind(bot.id, String(userId)).run();
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'clear.user.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleKeywordCommand(bot, message) {
  const parts = message.text.trim().split(/\s+/);
  const action = (parts[1] || '').toLowerCase();

  if (!action || action === 'list') {
    if (!action) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    const words = await getKeywords(bot);
    if (!words.length) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.list_empty'), message_thread_id: message.message_thread_id });
    const defaultSet = new Set(DEFAULT_KEYWORDS);
    const defaultCount = words.filter(w => defaultSet.has(w)).length;
    const list = words.map(w => `<code>${escapeHtml(w)}</code>${defaultSet.has(w) ? '*' : ''}`).join('  ');
    return sendMessage(bot, {
      chat_id: message.chat.id,
      text: `${t(bot, 'keyword.list_title', { n: words.length, d: defaultCount })}\n${list}${t(bot, 'keyword.legend')}`,
      parse_mode: 'HTML',
      message_thread_id: message.message_thread_id
    });
  }

  if (action === 'add') {
    const word = parts.slice(2).join(' ');
    if (!word) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    const exists = await bot.db.prepare('SELECT word FROM keywords WHERE bot_id = ? AND word = ?').bind(bot.id, word).first();
    if (exists) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.exists', { w: escapeHtml(word) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    await bot.db.prepare('INSERT INTO keywords (bot_id, word) VALUES (?, ?)').bind(bot.id, word).run();
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.added', { w: escapeHtml(word) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  if (action === 'del') {
    const word = parts.slice(2).join(' ');
    if (!word) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    const res = await bot.db.prepare('DELETE FROM keywords WHERE bot_id = ? AND word = ?').bind(bot.id, word).run();
    if (!res.meta.changes) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.notfound', { w: escapeHtml(word) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.deleted', { w: escapeHtml(word) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  if (action === 'reset') {
    await bot.db.prepare('DELETE FROM keywords WHERE bot_id = ?').bind(bot.id).run();
    await ensureKeywordsSeeded(bot);
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.reset'), message_thread_id: message.message_thread_id });
  }

  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'keyword.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleModeCommand(bot, message) {
  const parts = message.text.trim().split(/\s+/);

  if (parts.length === 1) {
    const modeText = bot.topicMode ? t(bot, 'mode.topic') : t(bot, 'mode.private');
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'mode.usage', { mode: modeText }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  const v = parts[1].toLowerCase();
  if (v === 'private') {
    await setTopicModeEnabled(bot, false);
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'mode.switched.private'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (v === 'topic') {
    if (!bot.supergroupId) {
      return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'mode.no_sg'), message_thread_id: message.message_thread_id });
    }
    await setTopicModeEnabled(bot, true);
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'mode.switched.topic'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'mode.param_err'), message_thread_id: message.message_thread_id });
}

async function handleSecurityCommand(bot, message) {
  const args = message.text.trim().split(/\s+/);
  if (args.length !== 2) {
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'security.usage', { lv: bot.security }), message_thread_id: message.message_thread_id });
  }
  const level = parseInt(args[1]);
  if (![1, 2, 3].includes(level)) {
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'security.invalid'), message_thread_id: message.message_thread_id });
  }
  await settingSet(bot, 'config:security_level', level);
  bot.security = level;
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'security.set', { name: t(bot, 'security.name.' + level) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleVerifyCommand(bot, message) {
  const text = message.text.trim();
  const parts = text.split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();

  if (!sub) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'verify.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });

  if (sub === 'math') {
    await settingSet(bot, 'config:verify_mode', 'math');
    bot.verifyMode = 'math';
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'verify.set.math'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (sub === 'off') {
    await settingSet(bot, 'config:verify_mode', 'off');
    bot.verifyMode = 'off';
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'verify.set.off'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (sub === 'custom') {
    const rest = text.slice(parts[0].length + parts[1].length + 2);
    const sep = rest.indexOf('|');
    if (sep < 0) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'verify.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    const q = rest.slice(0, sep).trim();
    const a = rest.slice(sep + 1).trim();
    if (!q || !a) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'verify.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    await settingSet(bot, 'config:custom_question', q);
    await settingSet(bot, 'config:custom_answer', a);
    await settingSet(bot, 'config:verify_mode', 'custom');
    bot.verifyMode = 'custom';
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'verify.set.custom', { q: escapeHtml(q) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (sub === 'show') {
    let detail = '';
    if (bot.verifyMode === 'custom') {
      const q = await settingGet(bot, 'config:custom_question');
      detail = q ? `Q: ${escapeHtml(q)}` : '(未设置)';
    } else if (bot.verifyMode === 'math') {
      detail = t(bot, 'math.show', { ops: bot.math.ops, min: bot.math.min, max: bot.math.max, count: bot.math.count });
    }
    return sendMessage(bot, {
      chat_id: message.chat.id,
      text: t(bot, 'verify.show', { mode: t(bot, 'verify.show.mode.' + bot.verifyMode), detail, limit: bot.maxPerMin }),
      parse_mode: 'HTML',
      message_thread_id: message.message_thread_id
    });
  }
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'verify.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleMathCommand(bot, message) {
  const parts = message.text.trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();

  if (!sub) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'math.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });

  if (sub === 'ops') {
    const ops = parts[2];
    if (!ops || !/^[+\-*\/]{1,4}$/.test(ops) || new Set(ops).size !== ops.length) {
      return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'math.err.ops'), message_thread_id: message.message_thread_id });
    }
    await settingSet(bot, 'config:math_ops', ops);
    bot.math.ops = ops;
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'math.set.ops', { ops: escapeHtml(ops) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (sub === 'range') {
    const min = parseInt(parts[2]), max = parseInt(parts[3]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max > 99 || min >= max) {
      return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'math.err.range'), message_thread_id: message.message_thread_id });
    }
    await settingSet(bot, 'config:math_min', min);
    await settingSet(bot, 'config:math_max', max);
    bot.math.min = min;
    bot.math.max = max;
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'math.set.range', { min, max }), message_thread_id: message.message_thread_id });
  }
  if (sub === 'count') {
    const n = parseInt(parts[2]);
    if (!Number.isFinite(n) || n < 2 || n > 6) {
      return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'math.err.count'), message_thread_id: message.message_thread_id });
    }
    await settingSet(bot, 'config:math_count', n);
    bot.math.count = n;
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'math.set.count', { n }), message_thread_id: message.message_thread_id });
  }
  if (sub === 'show') {
    return sendMessage(bot, {
      chat_id: message.chat.id,
      text: t(bot, 'math.show', { ops: bot.math.ops, min: bot.math.min, max: bot.math.max, count: bot.math.count }),
      parse_mode: 'HTML',
      message_thread_id: message.message_thread_id
    });
  }
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'math.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleLangCommand(bot, message) {
  const parts = message.text.trim().split(/\s+/);
  const v = (parts[1] || '').toLowerCase();
  if (!v) {
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'lang.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (v !== 'zh' && v !== 'en') {
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'lang.invalid'), message_thread_id: message.message_thread_id });
  }
  await settingSet(bot, 'config:lang', v);
  bot.lang = v;
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'lang.set'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleNoticeCommand(bot, message) {
  const text = message.text.trim();
  const content = text.replace(/^\/notice\s*/, '').trim();
  if (!content) {
    const cur = (await settingGet(bot, 'config:notification')) || t(bot, 'notice.default');
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'notice.usage', { notice: escapeHtml(cur) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  await settingSet(bot, 'config:notification', content);
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'notice.set'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleWelcomeCommand(bot, message) {
  const text = message.text.trim();
  const content = text.replace(/^\/welcome\s*/, '').trim();
  if (!content) {
    const cur = (await settingGet(bot, 'config:welcome')) || t(bot, 'welcome.user', { uid: '{uid}' });
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'welcome.usage', { welcome: escapeHtml(cur) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  await settingSet(bot, 'config:welcome', content);
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'welcome.set'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleAdminMenu(bot, message) {
  const modeText = bot.topicMode ? t(bot, 'mode.topic') : t(bot, 'mode.private');
  const secText = `${t(bot, 'security.name.' + bot.security)} (${bot.security})`;
  const verifyText = t(bot, 'verify.show.mode.' + bot.verifyMode);
  const langText = bot.lang === 'zh' ? '中文' : 'English';

  // 关键词概要：总数 + 默认数
  const words = await getKeywords(bot);
  const defaultSet = new Set(DEFAULT_KEYWORDS);
  const defaultCount = words.filter(w => defaultSet.has(w)).length;
  const kwText = bot.lang === 'zh' ? `${words.length}(默认${defaultCount})` : `${words.length}(${defaultCount} def)`;

  // 纯按钮面板：点击即执行（用户管理指令需回复目标消息，或作用于最近来消息的用户）
  const inline_keyboard = [
    [
      { text: 'ℹ️ 信息', callback_data: 'cmd:/info' },
      { text: '🌟 信任', callback_data: 'cmd:/trust' },
      { text: '🚫 屏蔽', callback_data: 'cmd:/block' },
      { text: '✅ 解屏', callback_data: 'cmd:/unblock' }
    ],
    [
      { text: '📃 黑名单', callback_data: 'cmd:/blacklist' },
      { text: '📃 关键词', callback_data: 'cmd:/keyword list' },
      { text: '🗑 清除', callback_data: 'cmd:/clear' },
      { text: '📢 广播', callback_data: 'cmd:/broadcast' }
    ],
    [
      { text: '🧭 私聊模式', callback_data: 'cmd:/mode private' },
      { text: '🧭 话题模式', callback_data: 'cmd:/mode topic' },
      { text: '🔐 验证配置', callback_data: 'cmd:/verify show' },
      { text: '🧮 题库配置', callback_data: 'cmd:/math show' }
    ],
    [
      { text: '🛡 严格', callback_data: 'cmd:/security 1' },
      { text: '🛡 标准', callback_data: 'cmd:/security 2' },
      { text: '🛡 宽松', callback_data: 'cmd:/security 3' },
      { text: '🔐 关闭验证', callback_data: 'cmd:/verify off' }
    ],
    [
      { text: '💬 欢迎语', callback_data: 'cmd:/welcome' },
      { text: '📣 接入须知', callback_data: 'cmd:/notice' },
      { text: '🌐 中文', callback_data: 'cmd:/lang zh' },
      { text: '🌐 EN', callback_data: 'cmd:/lang en' }
    ],
    [
      { text: '🤖 机器人管理', callback_data: 'cmd:/bot list' },
      { text: '📖 帮助', callback_data: 'cmd:/help' },
      { text: '🔄 刷新', callback_data: 'cmd:/admin' }
    ]
  ];

  return sendMessage(bot, {
    chat_id: message.chat.id,
    text: t(bot, 'menu.admin', { mode: modeText, sec: secText, verify: verifyText, lang: langText, kw: kwText }),
    parse_mode: 'HTML',
    message_thread_id: message.message_thread_id,
    reply_markup: { inline_keyboard }
  });
}

// ---------------- 机器人管理（/bot） ----------------

async function autoRegisterWebhook(bot) {
  const secret = await getBotSecret(bot);
  const path = bot.id === DEFAULT_BOT_ID ? WEBHOOK : `${WEBHOOK}/${bot.id}`;
  const webhookUrl = `${WORKER_ORIGIN}${path}`;
  const r = await (await fetch(apiUrl(bot, 'setWebhook', { url: webhookUrl, secret_token: secret }))).json();
  await requestTelegram(bot, 'setMyCommands', makeReqBody({
    commands: [
      { command: 'admin', description: '管理面板 / Admin panel' },
      { command: 'info', description: '用户信息 / User info' },
      { command: 'block', description: '屏蔽用户 / Block user' },
      { command: 'unblock', description: '解除屏蔽 / Unblock' },
      { command: 'blacklist', description: '黑名单 / Blacklist' },
      { command: 'clear', description: '清除映射 / Clear mappings' },
      { command: 'notice', description: '接入须知 / Welcome notice' },
      { command: 'welcome', description: '用户欢迎语 / Welcome msg' },
      { command: 'mode', description: '切换模式 / Switch mode' },
      { command: 'security', description: '安全级别 / Security level' },
      { command: 'verify', description: '验证设置 / Verification' },
      { command: 'math', description: '题库设置 / Math config' },
      { command: 'keyword', description: '关键词 / Keywords' },
      { command: 'lang', description: '语言 / Language' },
      { command: 'broadcast', description: '广播 / Broadcast' },
      { command: 'bot', description: '机器人管理 / Bot manager' },
      { command: 'start', description: '开始 / Start' }
    ]
  }));
  return r;
}

async function handleBotCommand(bot, message) {
  const parts = message.text.trim().split(/\s+/);
  const sub = (parts[1] || 'list').toLowerCase();

  if (sub === 'list') {
    const res = await bot.db.prepare('SELECT bot_id, admin_uid, sg, topic, max FROM bots ORDER BY bot_id').all();
    let text = `🤖 <b>${t(bot, 'bot.list.title')}</b>\n`;
    const rows = [];
    for (const r of res.results) {
      rows.push(`<code>${escapeHtml(r.bot_id)}</code> — ${r.topic ? t(bot, 'mode.topic') : t(bot, 'mode.private')}${r.sg ? ` | sg: <code>${escapeHtml(r.sg)}</code>` : ''}`);
    }
    if (!rows.length) text += t(bot, 'bot.list.empty');
    else text += rows.join('\n');
    text += `\n${t(bot, 'bot.list.usage')}`;
    return sendMessage(bot, { chat_id: message.chat.id, text, parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  if (sub === 'add') {
    // /bot add <id> <token> <admin_uid> [sg] [topic] [max]
    const [, , id, token, admin, sg, topicFlag, maxStr] = message.text.trim().split(/\s+/);
    if (!id || !token || !admin || !/^[a-z0-9_-]{1,32}$/.test(id)) {
      return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.add.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    }
    const exists = await bot.db.prepare('SELECT bot_id FROM bots WHERE bot_id = ?').bind(id).first();
    if (exists) {
      return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.add.exists', { id }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    }
    const secret = crypto.randomUUID().replace(/-/g, '');
    const topic = (topicFlag === 'topic' || topicFlag === 'true') ? 1 : 0;
    const max = parseInt(maxStr) || 40;
    await bot.db.prepare('INSERT INTO bots (bot_id, token, admin_uid, sg, topic, max, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, token, String(admin), sg || '', topic, max, secret, Math.floor(Date.now() / 1000)).run();
    // 验证 token 有效性并自动注册 webhook
    const newBot = await resolveBot({ DB: bot.db }, id);
    let resultText;
    if (!newBot) {
      resultText = t(bot, 'bot.add.fail', { err: 'resolve error' });
    } else {
      const me = await requestTelegram(newBot, 'getMe', makeReqBody({}));
      if (!me.ok) {
        await bot.db.prepare('DELETE FROM bots WHERE bot_id = ?').bind(id).run();
        resultText = t(bot, 'bot.add.fail', { err: me.description || 'invalid token' });
      } else {
        const r = await autoRegisterWebhook(newBot);
        resultText = r.ok
          ? t(bot, 'bot.add.ok', { id, name: '@' + (me.result.username || id) })
          : t(bot, 'bot.add.webhook_fail', { id, err: r.description || 'unknown' });
      }
    }
    // 删除含 token 的原始消息（防泄露）
    try { await deleteMessage(bot, message.chat.id, message.message_id); } catch (e) { /* ignore */ }
    return sendMessage(bot, { chat_id: message.chat.id, text: resultText, parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  if (sub === 'del') {
    const id = parts[2];
    if (!id) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.del.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    if (id === bot.id) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.del.self'), message_thread_id: message.message_thread_id });
    const row = await bot.db.prepare('SELECT token FROM bots WHERE bot_id = ?').bind(id).first();
    if (!row) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.notfound', { id }), message_thread_id: message.message_thread_id });
    try {
      const fake = { id, token: row.token };
      await fetch(apiUrl(fake, 'setWebhook', { url: '' }));
    } catch (e) { /* ignore */ }
    await bot.db.prepare('DELETE FROM bots WHERE bot_id = ?').bind(id).run();
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.del.ok', { id }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  if (sub === 'set') {
    const id = parts[2], field = (parts[3] || '').toLowerCase();
    const value = parts.slice(4).join(' ');
    if (!id || !field || !value) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.set.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    const row = await bot.db.prepare('SELECT bot_id FROM bots WHERE bot_id = ?').bind(id).first();
    if (!row) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.notfound', { id }), message_thread_id: message.message_thread_id });
    const colMap = { token: 'token', admin: 'admin_uid', sg: 'sg', max: 'max' };
    const col = colMap[field];
    if (!col) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.set.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    let v = value;
    if (col === 'max') { v = parseInt(value); if (!Number.isFinite(v) || v < 1) return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.set.usage'), message_thread_id: message.message_thread_id }); }
    await bot.db.prepare(`UPDATE bots SET ${col} = ? WHERE bot_id = ?`).bind(v, id).run();
    try { await deleteMessage(bot, message.chat.id, message.message_id); } catch (e) { /* ignore */ }
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.set.ok', { id, f: field }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'bot.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleBroadcastCommand(bot, message) {
  if (!message.reply_to_message) {
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'broadcast.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  const broadcastMsg = message.reply_to_message;

  await sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'broadcast.start'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });

  let sentCount = 0, failCount = 0, skipCount = 0;
  try {
    const res = await bot.db.prepare('SELECT chat_id FROM chat_topic_mappings WHERE bot_id = ?').bind(bot.id).all();
    const ids = res.results.map(r => r.chat_id);
    // 兼容私聊模式用户：从消息映射中提取去重
    const maps = await bot.db.prepare('SELECT DISTINCT guest_chat_id AS chat_id FROM message_mappings WHERE bot_id = ?').bind(bot.id).all();
    for (const m of maps.results) {
      if (!ids.includes(m.chat_id)) ids.push(m.chat_id);
    }

    // 排除黑名单用户
    const blocked = await bot.db.prepare('SELECT chat_id FROM user_states WHERE bot_id = ? AND is_blocked = 1 AND is_trusted = 0').bind(bot.id).all();
    const blockedSet = new Set(blocked.results.map(r => String(r.chat_id)));

    for (const userId of ids) {
      if (String(userId) === String(bot.adminUid)) continue;
      if (blockedSet.has(String(userId))) { skipCount++; continue; }
      try {
        await copyMessage(bot, {
          chat_id: userId,
          from_chat_id: broadcastMsg.chat.id,
          message_id: broadcastMsg.message_id
        });
        sentCount++;
      } catch (e) {
        console.error(`Broadcast failed for ${userId}:`, e);
        failCount++;
      }
    }

    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'broadcast.done', { ok: sentCount, fail: failCount, skip: skipCount }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  } catch (e) {
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'broadcast.error', { err: e.message }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
}

// ---------------- Webhook 注册 ----------------

async function registerWebhook(bot, requestUrl, suffix, secret) {
  // 带 bot id 的路径：/endpoint/{id}；default 保持旧路径 /endpoint 兼容
  const path = bot.id === DEFAULT_BOT_ID ? suffix : `${suffix}/${bot.id}`;
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${path}`;
  const r = await (await fetch(apiUrl(bot, 'setWebhook', { url: webhookUrl, secret_token: secret }))).json();
  // 注册 Telegram 官方命令菜单：输入 / 时弹出可点击的命令列表
  await requestTelegram(bot, 'setMyCommands', makeReqBody({
    commands: [
      { command: 'admin', description: '管理面板 / Admin panel' },
      { command: 'info', description: '用户信息 / User info' },
      { command: 'trust', description: '永久信任 / Trust user' },
      { command: 'untrust', description: '取消信任 / Remove trust' },
      { command: 'block', description: '屏蔽用户 / Block user' },
      { command: 'unblock', description: '解除屏蔽 / Unblock' },
      { command: 'blacklist', description: '黑名单 / Blacklist' },
      { command: 'clear', description: '清除映射 / Clear mappings' },
      { command: 'notice', description: '接入须知 / Welcome notice' },
      { command: 'welcome', description: '用户欢迎语 / Welcome msg' },
      { command: 'mode', description: '切换模式 / Switch mode' },
      { command: 'security', description: '安全级别 / Security level' },
      { command: 'verify', description: '验证设置 / Verification' },
      { command: 'math', description: '题库设置 / Math config' },
      { command: 'keyword', description: '关键词 / Keywords' },
      { command: 'lang', description: '语言 / Language' },
      { command: 'broadcast', description: '广播 / Broadcast' },
      { command: 'start', description: '开始 / Start' }
    ]
  }));
  return new Response('ok' in r && r.ok ? `Ok (${bot.id})` : JSON.stringify(r, null, 2));
}

async function unRegisterWebhook(bot) {
  const r = await (await fetch(apiUrl(bot, 'setWebhook', { url: '' }))).json();
  return new Response('ok' in r && r.ok ? `Ok (${bot.id})` : JSON.stringify(r, null, 2));
}
