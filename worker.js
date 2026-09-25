// TG Chat Bot - Cloudflare Worker (D1 存储版, ES module 格式)
// 数据持久化在 D1 (绑定名: D1)，首次请求自动建表/迁移，无需手动操作。
//
// 机器人配置：
//   - 单机器人（默认）：设置 BOT_TOKEN / ADMIN_UID / SUPERGROUP_ID / TOPIC_MODE /
//     WEBHOOK_SECRET / MAX_MSG_PER_MIN，id 为 "default"。
//   - 多机器人：一律通过管理面板 /bot add 指令存入 D1（免 Cloudflare 操作），webhook 路径 /endpoint/{id}。
//     每个机器人需单独访问 /registerWebhook/{id} 注册。

const WEBHOOK = '/endpoint';
const DEFAULT_BOT_ID = 'default';

// --- 常量配置 ---
const VERIFY_TTL_SECONDS = 3600; // 验证通过后 1 小时内免重复验证
const CODE_TTL_SECONDS = 300;    // 验证码/题目有效期 5 分钟
const MAX_VERIFY_ATTEMPTS = 3;   // 同一轮验证允许答错的次数，超限需重新发消息触发
const MAX_CUSTOM_ITEMS = 20;     // 自定义问答题库条数上限
const DEDUPE_TTL_SECONDS = 120; // 去重哈希 2 分钟过期（仅防短时刷屏，正常复述/确认不受影响）
const TOPIC_CREATE_COOLDOWN = 600; // 同一用户建话题失败后冷却 10 分钟（防群级限流）
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
    zh: '请友善沟通，禁止发送广告、诈骗及违规内容，违规将被屏蔽。\n\nYour UID: <code>{uid}</code>',
    en: 'Please keep the conversation friendly. Advertising, scams and other prohibited content are not allowed and will result in a block.\n\nYour UID: <code>{uid}</code>'
  },
  'welcome.admin': {
    zh: '<b>Admin Control Panel</b>\nUID: {uid}\nMode: {mode}\n{sgWarn}\n发送 /admin 或 /help 查看完整管理菜单。',
    en: '<b>Admin Control Panel</b>\nUID: {uid}\nMode: {mode}\n{sgWarn}\nSend /admin or /help for the full menu.'
  },
  'mode.topic': { zh: '话题群组模式', en: 'Topic Group' },
  'mode.private': { zh: '私聊模式', en: 'Private Chat' },
  'mode.warn.nosg': {
    zh: '⚠️ <b>配置警告</b>: 话题模式已开启，但未配置超级群组 ID（sg）。请在面板用 <code>/bot set default sg -100xxx</code> 或设置 SUPERGROUP_ID，或发送 <code>/mode private</code> 切换私聊模式。',
    en: '⚠️ <b>Config warning</b>: topic mode is on but supergroup id (sg) is not set. Use <code>/bot set default sg -100xxx</code> in the panel or set SUPERGROUP_ID, or send <code>/mode private</code>.'
  },
  'verify.title': { zh: '🔒 <b>身份验证</b>', en: '🔒 <b>Verification</b>' },
  'verify.math_text': { zh: '问题：{q}\n\n(验证通过后您的消息将自动发送)', en: 'Question: {q}\n\n(Your message will be sent automatically after verification)' },
  'verify.custom_text': { zh: '请回答以下问题以继续：\n\n{q}\n\n直接回复答案文本即可（验证通过后您的消息将自动发送）', en: 'Please answer the following to continue:\n\n{q}\n\nReply with the answer text (your message will be sent automatically after verification)' },
  'verify.passed': { zh: '✅ <b>验证通过！</b>\n\n您的消息已发送。', en: '✅ <b>Verification passed!</b>\n\nYour message has been sent.' },
  'verify.wrong': { zh: '❌ 答案错误，请重试。', en: '❌ Wrong answer, please try again.' },
  'verify.expired': { zh: '❌ 验证已过期，请重新发送消息触发验证。', en: '❌ Verification expired. Resend a message to trigger it again.' },
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
  'clear.all.done': { zh: '🗑 已清空全部消息映射、话题绑定与历史卡片记录。', en: '🗑 Cleared all message mappings, topic bindings and legacy card records.' },
  'pin.card': {
    zh: '🪪 <b>新用户接入</b>\n昵称: {name}\n用户名: {username}\nUserID: <code>{uid}</code>\n发起时间: {time}',
    en: '🪪 <b>New user</b>\nName: {name}\nUsername: {username}\nUserID: <code>{uid}</code>\nFirst seen: {time}'
  },
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
    zh: '用法:\n<code>/verify math</code> 动态算术验证\n<code>/verify custom 问题 | 答案</code> 设为唯一自定义题\n<code>/verify add 问题 | 答案</code> 追加自定义题\n<code>/verify list</code> 查看题库\n<code>/verify del 编号</code> 删除某题\n<code>/verify clear</code> 清空题库\n<code>/verify off</code> 关闭验证\n<code>/verify show</code> 查看当前配置',
    en: 'Usage:\n<code>/verify math</code> dynamic math\n<code>/verify custom &lt;q&gt; | &lt;a&gt;</code> set one custom question\n<code>/verify add &lt;q&gt; | &lt;a&gt;</code> add a custom question\n<code>/verify list</code> list questions\n<code>/verify del &lt;n&gt;</code> delete one\n<code>/verify clear</code> clear all\n<code>/verify off</code> disable\n<code>/verify show</code> show config'
  },
  'verify.set.math': { zh: '✅ 验证方式已切换为：<b>动态算术</b>', en: '✅ Verification mode: <b>dynamic math</b>' },
  'verify.set.custom': { zh: '✅ 验证方式已切换为：<b>自定义问答</b>\n题库已设为 1 题: {q}', en: '✅ Verification mode: <b>custom Q&A</b>\nQuestion bank set to 1 item: {q}' },
  'verify.set.off': { zh: '✅ 已关闭验证（所有用户免验证）。', en: '✅ Verification disabled (all users pass).' },
  'verify.show': {
    zh: '🛡 <b>验证配置</b>\n模式: {mode}\n{detail}\n有效期: 1 小时\n频率限制: 超过 {limit} 条/分钟 触发重新验证',
    en: '🛡 <b>Verification config</b>\nMode: {mode}\n{detail}\nValidity: 1 hour\nRate limit: re-verify after {limit} msgs/min'
  },
  'verify.show.mode.math': { zh: '动态算术', en: 'Dynamic math' },
  'verify.show.mode.custom': { zh: '自定义问答', en: 'Custom Q&A' },
  'verify.show.mode.off': { zh: '已关闭', en: 'Disabled' },
  'verify.show.custom_detail': { zh: '题库: {n} 题（验证时随机抽取）', en: 'Question bank: {n} item(s), picked at random' },
  'verify.list.title': { zh: '📚 <b>自定义问答题库</b>（{n}/{max} 题，答案仅存服务端不回显）', en: '📚 <b>Custom question bank</b> ({n}/{max}, answers stay server-side)' },
  'verify.list.item': { zh: '\n<b>{i}.</b> {q}', en: '\n<b>{i}.</b> {q}' },
  'verify.list.empty': { zh: '📚 题库为空，用 <code>/verify add 问题 | 答案</code> 添加。', en: '📚 The question bank is empty. Add one with <code>/verify add &lt;q&gt; | &lt;a&gt;</code>.' },
  'verify.add.done': { zh: '✅ 已添加第 {i} 题（共 {n} 题）: {q}', en: '✅ Added question #{i} ({n} total): {q}' },
  'verify.add.limit': { zh: '⚠️ 题库已达上限 {max} 题，请先 <code>/verify del 编号</code> 删除后再添加。', en: '⚠️ Question bank is full ({max}). Delete one with <code>/verify del &lt;n&gt;</code> first.' },
  'verify.del.done': { zh: '🗑 已删除第 {i} 题（剩余 {n} 题）: {q}', en: '🗑 Deleted question #{i} ({n} left): {q}' },
  'verify.del.invalid': { zh: '⚠️ 编号无效，题库共 {n} 题。', en: '⚠️ Invalid index. The bank has {n} item(s).' },
  'verify.clear.done': { zh: '🗑 题库已清空。', en: '🗑 Question bank cleared.' },
  'verify.need.pipe': { zh: '⚠️ 格式错误，需用 <code>|</code> 分隔问题与答案，例如：<code>/verify add 你最喜欢的颜色？ | 蓝色</code>', en: '⚠️ Wrong format. Separate question and answer with <code>|</code>, e.g. <code>/verify add Favourite colour? | Blue</code>' },
  'verify.retry.new_question': { zh: '❌ 答案错误，已更换题目。', en: '❌ Wrong answer — question changed.' },
  'verify.attempts.over': { zh: '❌ 答错次数过多，请重新发送一条消息获取新题目。', en: '❌ Too many wrong answers. Send a new message to get a fresh challenge.' },
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
    zh: '🛠 <b>管理面板</b>\n\n🧭 {mode} | 🛡 {sec} | 🔐 {verify}\n📃 关键词 {kw} | 🌐 {lang}\n🤖 Bot: <code>{botId}</code> | SG: <code>{sg}</code>\n\n点击下方按钮直接执行；输入 <code>/</code> 可唤起命令菜单；<code>/help</code> 查看全部指令说明。',
    en: '🛠 <b>Admin Panel</b>\n\n🧭 {mode} | 🛡 {sec} | 🔐 {verify}\n📃 Keywords {kw} | 🌐 {lang}\n🤖 Bot: <code>{botId}</code> | SG: <code>{sg}</code>\n\nTap buttons below to execute; type <code>/</code> for the command menu; <code>/help</code> for the full list.'
  },
  'help.text': {
    zh: '📖 <b>指令说明</b>\n\n<b>用户管理</b>（回复目标消息或在其话题内发送）\n<code>/info</code> 用户信息 | <code>/trust</code> 永久信任 | <code>/untrust</code> 取消信任\n<code>/block</code> 屏蔽 | <code>/unblock</code> 解除 | <code>/blacklist</code> 黑名单列表\n<code>/clear</code> 清除该用户映射 | <code>/clear all</code> 清空全部\n\n<b>系统设置</b>\n<code>/mode private|topic</code> 运行模式\n<code>/security 1|2|3</code> 严格|标准|宽松\n<code>/verify math|off|show</code> 验证方式\n<code>/verify custom 问题|答案</code> 设为唯一题 | <code>/verify add 问题|答案</code> 追加\n<code>/verify list</code> 题库 | <code>/verify del 编号</code> 删除 | <code>/verify clear</code> 清空\n<code>/math ops +-*/ | range 1 9 | count 4 | show</code> 题库\n<code>/keyword list|add 词|del 词|reset</code> 关键词黑名单\n<code>/lang zh|en</code> 界面语言\n<code>/welcome 文本</code> 用户欢迎语（支持 {uid}）\n\n<b>机器人管理</b>\n<code>/bot list</code> 机器人列表\n<code>/bot add id token UID [sg] [topic] [max]</code> 添加并自动注册\n<code>/bot del id</code> 删除并注销 | <code>/bot set id token|admin|sg|max 值</code>\n\n<b>广播</b>\n<code>/broadcast</code> 回复一条消息全员广播（自动跳过黑名单）',
    en: '📖 <b>Command Reference</b>\n\n<b>Users</b> (reply to their msg or send in their topic)\n<code>/info</code> | <code>/trust</code> | <code>/untrust</code>\n<code>/block</code> | <code>/unblock</code> | <code>/blacklist</code>\n<code>/clear</code> user mappings | <code>/clear all</code>\n\n<b>System</b>\n<code>/mode private|topic</code>\n<code>/security 1|2|3</code> strict|standard|relaxed\n<code>/verify math|off|show</code>\n<code>/verify custom q|a</code> set one | <code>/verify add q|a</code> add\n<code>/verify list</code> | <code>/verify del n</code> | <code>/verify clear</code>\n<code>/math ops +-*/ | range 1 9 | count 4 | show</code>\n<code>/keyword list|add w|del w|reset</code>\n<code>/lang zh|en</code>\n<code>/welcome text</code> (supports {uid})\n\n<b>Bots</b>\n<code>/bot list</code>\n<code>/bot add id token UID [sg] [topic] [max]</code>\n<code>/bot del id</code> | <code>/bot set id token|admin|sg|max value</code>\n\n<b>Broadcast</b>\n<code>/broadcast</code> reply to a msg (skips blocked users)'
  },
  'bot.usage': {
    zh: '用法:\n<code>/bot list</code> 查看机器人\n<code>/bot add id token UID [sg] [topic] [max]</code> 添加\n<code>/bot del id</code> 删除\n<code>/bot set id token|admin|sg|max 值</code> 修改',
    en: 'Usage:\n<code>/bot list</code>\n<code>/bot add id token UID [sg] [topic] [max]</code>\n<code>/bot del id</code>\n<code>/bot set id token|admin|sg|max value</code>'
  },
  'bot.list.title': { zh: '机器人列表', en: 'Bot list' },
  'bot.list.empty': { zh: '（D1 中暂无记录，当前仅环境变量配置的机器人）', en: '(no bots in D1; env-configured bots only)' },
  'bot.list.env': { zh: '环境变量', en: 'ENV' },
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
  'map.notfound': { zh: '⚠️ 无法找到该消息的原始发送者 (可能已被清除)', en: '⚠️ Original sender not found for this message (mapping cleared?)' },
  'topic.create_fail': {
    zh: '⚠️ <b>话题创建失败</b>\nUID: {uid}\nError: {err}\n\n{hint}',
    en: '⚠️ <b>Topic creation failed</b>\nUID: {uid}\nError: {err}\n\n{hint}'
  },
  'topic.hint.kicked': {
    zh: '机器人不在该群组中（或群组 ID 已变更）。\n请确认 sg/SUPERGROUP_ID 指向当前群组的最新 ID（以 -100 开头），并将机器人重新拉入群设为管理员（需"管理话题"权限）。',
    en: 'The bot is not in this group (or the group ID changed).\nVerify sg/SUPERGROUP_ID matches the current group id (starts with -100), and re-add the bot as admin with "Manage Topics" permission.'
  },
  'topic.hint.perm': {
    zh: '请检查机器人是否为群组管理员，且拥有"管理话题"权限。',
    en: 'Ensure the bot is a group admin with "Manage Topics" permission.'
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
  // 仅保留 default 机器人的旧版独立变量兼容；多机器人一律通过面板 /bot 存入 D1
  const bots = {};
  if (env.BOT_TOKEN) {
    bots[DEFAULT_BOT_ID] = {
      id: DEFAULT_BOT_ID,
      token: env.BOT_TOKEN,
      admin: env.ADMIN_UID,
      sg: env.SUPERGROUP_ID,
      topic: env.TOPIC_MODE === 'true',
      secret: env.WEBHOOK_SECRET,
      max: env.MAX_MSG_PER_MIN
    };
  }
  return bots;
}

// Worker 自身域名（用于面板内自动注册 webhook）
let WORKER_ORIGIN = '';

// Isolate 级去重与锁（防 Telegram webhook 重复推送导致重复处理/重复建话题，参考 CTT 实现）
const processedMessages = new Set();
const processedCallbacks = new Set();
const topicCreationLocks = new Map();

// 构建带机器人上下文与已加载配置的 bot 对象。优先读 D1 bots 表（面板管理），回退到 default 独立变量。
async function resolveBot(env, botId) {
  // bots 行与 settings 批量查询合并为一次 D1 往返
  const keys = ['config:lang', 'config:security_level', 'config:verify_mode', 'config:enable_topic_group',
    'config:math_ops', 'config:math_min', 'config:math_max', 'config:math_count', 'system:keywords_seeded'];
  let cfg = null;
  const m = {};
  if (env.D1) {
    const [botRes, setRes] = await env.D1.batch([
      env.D1.prepare('SELECT * FROM bots WHERE bot_id = ?').bind(botId),
      env.D1.prepare(`SELECT key, value FROM settings WHERE bot_id = ? AND key IN (${keys.map(() => '?').join(',')})`)
        .bind(botId, ...keys)
    ]);
    cfg = (botRes.results && botRes.results[0]) || null;
    for (const r of (setRes.results || [])) m[r.key] = r.value;
  }
  if (!cfg) {
    const fromEnv = parseBots(env)[botId];
    if (!fromEnv) return null;
    cfg = { bot_id: fromEnv.id, token: fromEnv.token, admin_uid: String(fromEnv.admin || ''), sg: String(fromEnv.sg || ''), topic: (fromEnv.topic === true || fromEnv.topic === 'true') ? 1 : 0, max: fromEnv.max, secret: fromEnv.secret || '' };
  }
  // default 机器人：缺失字段用独立环境变量补齐
  if (botId === DEFAULT_BOT_ID) {
    if (!cfg.admin_uid) cfg.admin_uid = env.ADMIN_UID || '';
    if (!cfg.sg) cfg.sg = env.SUPERGROUP_ID || '';
    if (!cfg.topic && env.TOPIC_MODE === 'true') cfg.topic = 1;
    if (!cfg.secret) cfg.secret = env.WEBHOOK_SECRET || '';
    if (!cfg.max) cfg.max = env.MAX_MSG_PER_MIN || '';
  }
  const bot = {
    id: botId,
    db: env.D1,
    env: env,
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
    keywordsSeeded: m['system:keywords_seeded'] === 'true',
    math: { ops: '+-*/', min: 1, max: 9, count: 6 }
  };
  bot.lang = m['config:lang'] || DEFAULT_LANG;
  bot.security = m['config:security_level'] === undefined || m['config:security_level'] === null ? DEFAULT_SECURITY_LEVEL : parseInt(m['config:security_level']);
  bot.verifyMode = m['config:verify_mode'] || 'math';
  bot.topicMode = m['config:enable_topic_group'] === undefined || m['config:enable_topic_group'] === null ? bot.defaultTopicMode : (m['config:enable_topic_group'] === 'true');
  bot.math = {
    ops: m['config:math_ops'] || '+-*/',
    min: parseInt(m['config:math_min'] || '1'),
    max: parseInt(m['config:math_max'] || '9'),
    count: parseInt(m['config:math_count'] || '6')
  };
  return bot;
}

// ---------------- D1 存储层 ----------------

// 表结构版本：任何表结构变更（新增表/列、改主键）后必须 +1。
// 否则冷启动会因版本号一致而跳过建表与迁移，表现为“代码更新了但表结构没变”。
const SCHEMA_VERSION = 1;

// 当前版本使用的全部表（白名单）。
// 维护约定：新增表必须同步加进这里，否则冷启动时会被当作废弃表自动清理。
const TABLES = ['user_states', 'message_mappings', 'chat_topic_mappings', 'message_hashes', 'keywords', 'settings', 'bots'];

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
    pending_msg_id INTEGER DEFAULT 0,
    pending_forward TEXT,
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
    chat_id TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (bot_id, chat_id, hash)
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
  // 版本号一致说明表结构已就绪，跳过全部建表/迁移探测（冷启动 18 个查询降为 1 个）
  let ver = null;
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE bot_id = ? AND key = ?')
      .bind(DEFAULT_BOT_ID, 'system:schema_version').first();
    ver = row ? row.value : null;
  } catch (e) {
    ver = null; // 全新库：settings 表还不存在，走完整初始化
  }
  if (ver === String(SCHEMA_VERSION)) return;

  const colInfo = {};
  const toMigrate = [];
  for (const name of TABLES) {
    const info = await db.prepare(`PRAGMA table_info(${name})`).all();
    colInfo[name] = info.results;
    if (info.results.length && !info.results.some(c => c.name === 'bot_id')) {
      toMigrate.push(name);
    }
  }
  for (const name of toMigrate) {
    await db.exec(`ALTER TABLE ${name} RENAME TO _old_${name}`);
  }
  // message_hashes 旧结构主键为 (bot_id, hash)，缺 chat_id 列；去重哈希是纯缓存，直接重建
  const mhCols = colInfo['message_hashes'] || [];
  if (mhCols.length && !mhCols.some(c => c.name === 'chat_id')) {
    await db.exec('DROP TABLE message_hashes');
  }
  await createTables(db);
  for (const name of toMigrate) {
    const oldCols = await db.prepare(`PRAGMA table_info(_old_${name})`).all();
    const colList = oldCols.results.map(c => c.name).join(', ');
    await db.exec(`INSERT INTO ${name} (bot_id, ${colList}) SELECT 'default', ${colList} FROM _old_${name}`);
    await db.exec(`DROP TABLE _old_${name}`);
  }
  // 为已存在的表补充后续新增的列（user_states 刚被重建时已含全部列，跳过）
  const usInfo = toMigrate.includes('user_states') ? null : colInfo['user_states'];
  if (usInfo && usInfo.length) {
    if (!usInfo.some(c => c.name === 'pending_msg_id')) {
      await db.exec('ALTER TABLE user_states ADD COLUMN pending_msg_id INTEGER DEFAULT 0');
    }
    if (!usInfo.some(c => c.name === 'pending_forward')) {
      await db.exec('ALTER TABLE user_states ADD COLUMN pending_forward TEXT');
    }
  }
  await dropUnusedTables(db);

  // 记录已完成本版本的表结构初始化，供下次冷启动短路
  await db.prepare('INSERT OR REPLACE INTO settings (bot_id, key, value) VALUES (?, ?, ?)')
    .bind(DEFAULT_BOT_ID, 'system:schema_version', String(SCHEMA_VERSION)).run();
}

// 清理当前版本已不再使用的表（含迁移中断残留的 _old_* 临时表）。
// 白名单为 TABLES；sqlite_/d1_ 前缀的系统表豁免，其余一律清理。
async function dropUnusedTables(db) {
  const keep = new Set(TABLES);
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const row of rows.results) {
    const name = row.name;
    if (keep.has(name)) continue;
    if (name.startsWith('sqlite_') || name.startsWith('d1_')) continue;
    try {
      await db.exec(`DROP TABLE IF EXISTS \`${name}\``);
      console.log('Dropped unused table:', name);
    } catch (e) {
      console.log('Drop unused table failed:', name, e && e.message);
    }
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
    pending_question: null, pending_answer: null, pending_code_expiry: 0, pending_attempts: 0, pending_msg_id: 0,
    pending_forward: null,
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

// webhook secret 一经生成不再变化，按 bot 缓存在实例内，避免每次请求都查 D1
const botSecretCache = new Map();
async function getBotSecret(bot) {
  if (bot.secretEnv) return bot.secretEnv;
  const cached = botSecretCache.get(bot.id);
  if (cached) return cached;
  let s = await settingGet(bot, 'system:bot_secret');
  if (!s) {
    s = crypto.randomUUID().replace(/-/g, '');
    await settingSet(bot, 'system:bot_secret', s);
  }
  botSecretCache.set(bot.id, s);
  return s;
}

async function setTopicModeEnabled(bot, enabled) {
  await settingSet(bot, 'config:enable_topic_group', enabled ? 'true' : 'false');
  bot.topicMode = enabled;
}

async function getKeywords(bot) {
  const res = await bot.db.prepare('SELECT word FROM keywords WHERE bot_id = ?').bind(bot.id).all();
  return res.results.map(r => r.word);
}

// 默认关键词只在首次为机器人播种一次，标记存 D1 并在 resolveBot 的批量查询里带回，
// 避免每条消息都做一次 COUNT（也让管理员可以清空关键词而不被自动补回）。
async function ensureKeywordsSeeded(bot) {
  if (bot.keywordsSeeded) return;
  const c = await bot.db.prepare('SELECT COUNT(*) AS n FROM keywords WHERE bot_id = ?').bind(bot.id).first();
  if (c.n === 0) {
    const stmt = bot.db.prepare('INSERT OR IGNORE INTO keywords (bot_id, word) VALUES (?, ?)');
    await bot.db.batch(DEFAULT_KEYWORDS.map(w => stmt.bind(bot.id, w)));
  }
  await settingSet(bot, 'system:keywords_seeded', 'true');
  bot.keywordsSeeded = true;
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

// 生成一道算术题的卡片（题目文本 + 选项按钮 + 正确项下标）。
// 首次发卡与答错换题共用，保证两处逻辑一致。
function buildMathCard(bot, chatId) {
  const challenge = generateMathChallenge(bot.math);
  const options = [
    { text: challenge.correct_answer, isCorrect: true },
    ...challenge.incorrect_answers.map(ans => ({ text: ans, isCorrect: false }))
  ];
  shuffleArray(options);
  const buttons = options.map((opt, idx) => ({
    text: opt.text,
    callback_data: `verify:${chatId}:${idx}`
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return {
    question: challenge.question,
    correctIndex: options.findIndex(o => o.isCorrect),
    rows
  };
}

// ---------------- 工具函数 ----------------

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 关键词命中判定：纯 ASCII 词按词边界匹配（大小写不敏感），避免被裹进密码/账号等长串中误杀；
// 中文词无词边界概念，仍按子串匹配。
function keywordHit(text, word) {
  if (/^[\x21-\x7e]+$/.test(word)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}\\b`, 'i').test(text);
  }
  return text.includes(word);
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
function createForumTopic(bot, chat_id, name) { return requestTelegram(bot, 'createForumTopic', makeReqBody({ chat_id, name })); }
function answerCallbackQuery(bot, callback_query_id, text, show_alert = false) { return requestTelegram(bot, 'answerCallbackQuery', makeReqBody({ callback_query_id, text, show_alert })); }
function deleteMessage(bot, chat_id, message_id) { return requestTelegram(bot, 'deleteMessage', makeReqBody({ chat_id, message_id })); }
function editMessageText(bot, msg = {}) { return requestTelegram(bot, 'editMessageText', makeReqBody(msg)); }

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Telegram 官方命令菜单（输入 / 时弹出可点击列表），注册 webhook 与自动注册共用
const BOT_COMMANDS = [
  { command: 'admin', description: '管理面板 / Admin panel' },
  { command: 'info', description: '用户信息 / User info' },
  { command: 'trust', description: '永久信任 / Trust user' },
  { command: 'untrust', description: '取消信任 / Remove trust' },
  { command: 'block', description: '屏蔽用户 / Block user' },
  { command: 'unblock', description: '解除屏蔽 / Unblock' },
  { command: 'blacklist', description: '黑名单 / Blacklist' },
  { command: 'clear', description: '清除映射 / Clear mappings' },
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
];

// ---------------- 路由入口 ----------------

export default {
  async fetch(request, env, ctx) {
    // 配置自检：缺少 D1 绑定或 Bot Token 时给出明确提示，而不是抛 1101
    if (!env.D1) {
      return new Response('Config error: D1 binding "D1" is missing. Add it in Workers settings -> Bindings.', { status: 500 });
    }
    if (!env.BOT_TOKEN) {
      const hasBots = await env.D1.prepare('SELECT COUNT(*) AS n FROM bots').first().catch(() => null);
      if (!hasBots || !hasBots.n) {
        return new Response('Config error: BOT_TOKEN is missing. Set it in Workers settings -> Variables.', { status: 500 });
      }
    }
    // 先确保表结构就绪（建表/旧表迁移），否则 registerWebhook 读 settings 会因缺表/缺列抛异常
    await ensureTables(env.D1);
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
      const r = await autoRegisterWebhook(bot);
      return new Response('ok' in r && r.ok ? `Ok (${bot.id})` : JSON.stringify(r, null, 2));
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
  const db = env.D1;
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
    // 消息去重：Telegram 偶发重复推送同一 update
    const m = update.message;
    const key = `${bot.id}:${m.chat.id}:${m.message_id}`;
    if (processedMessages.has(key)) return;
    processedMessages.add(key);
    if (processedMessages.size > 10000) processedMessages.clear();
    await onMessage(bot, m);
  } else if ('callback_query' in update) {
    const cq = update.callback_query;
    const key = `${bot.id}:${cq.id}`;
    if (processedCallbacks.has(key)) return;
    processedCallbacks.add(key);
    if (processedCallbacks.size > 10000) processedCallbacks.clear();
    await handleCallback(bot, cq);
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
        // 支持 {uid} 占位符；注入的 UID 包成 <code> 以便用户点击复制，
        // 自定义文案本身仍整体转义，避免 HTML 注入
        startMsg = escapeHtml(customWelcome).split('{uid}').join(`<code>${message.chat.id}</code>`);
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

    // 未绑定话题：静默忽略（不转发、不提示）
    return;
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
  const now = Math.floor(Date.now() / 1000);
  // 用户状态 / 关键词 / 去重哈希三个读操作互不依赖，并行执行省两次串行往返
  const textHash = message.text ? await sha256(message.text.trim()) : null;
  const [state, keywords, dup] = await Promise.all([
    getUserState(bot, chatId),
    message.text ? getKeywords(bot) : Promise.resolve(null),
    textHash
      ? bot.db.prepare('SELECT hash FROM message_hashes WHERE bot_id = ? AND chat_id = ? AND hash = ? AND (expires_at IS NULL OR expires_at > ?)')
        .bind(bot.id, String(chatId), textHash, now).first()
      : Promise.resolve(null)
  ]);

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
          pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0, pending_msg_id: 0,
          is_rate_limited: 0, message_count: 0, window_start: 0
        });
        await sendMessage(bot, { chat_id: chatId, text: t(bot, 'verify.passed'), parse_mode: 'HTML' });
        await deliverPendingForward(bot, chatId, state);
        return new Response('Ok');
      } else {
        const attempts = (state.pending_attempts || 0) + 1;
        if (attempts >= MAX_VERIFY_ATTEMPTS) {
          await setUserState(bot, chatId, { pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0, pending_msg_id: 0 });
          return sendMessage(bot, { chat_id: chatId, text: t(bot, 'verify.attempts.over') });
        }
        // 答错即换题：重新随机抽一题，原地替换旧卡
        const pick = await pickCustomItem(bot);
        if (pick) {
          await setUserState(bot, chatId, {
            pending_question: pick.q, pending_answer: pick.a,
            pending_code_expiry: now + CODE_TTL_SECONDS, pending_attempts: attempts
          });
          await editVerifyCard(
            bot, chatId, state.pending_msg_id,
            `${t(bot, 'verify.title')}\n\n${t(bot, 'verify.retry.new_question')}\n\n${t(bot, 'verify.custom_text', { q: escapeHtml(pick.q) })}`,
            null
          );
          return new Response('Ok');
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
    // 暂存被拦截的消息，验证通过后自动补转发，用户无需重发
    return sendVerificationChallenge(bot, chatId, message.message_id, {
      message_id: message.message_id,
      first_name: message.chat.first_name || '',
      last_name: message.chat.last_name || '',
      username: message.chat.username || ''
    });
  }

  // 6. 放行 -> 关键词/去重检查（仅文本，trusted 豁免；两者已在入口并行预取）
  if (message.text && !isTrusted) {
    const words = keywords || await getKeywords(bot);
    const hit = words.some(k => keywordHit(message.text, k));
    if (hit) return new Response('Ok');

    // 去重结果已在入口并行取回（textHash/dup）
    if (dup) return new Response('Ok');
    await bot.db.prepare('INSERT OR REPLACE INTO message_hashes (bot_id, chat_id, hash, expires_at) VALUES (?, ?, ?, ?)')
      .bind(bot.id, String(chatId), textHash, now + DEDUPE_TTL_SECONDS).run();
  }

  return forwardGuestMessage(bot, chatId, message, state, now);
}

// 获取/创建用户话题（加锁防并发重复创建；失败进入冷却并降级）。返回 { topicId, degraded }
async function ensureTopicFor(bot, chatId, message, now) {
  const lockKey = `${bot.id}:${chatId}`;
  const prev = topicCreationLocks.get(lockKey) || Promise.resolve();
  const task = prev.then(() => ensureTopicInner(bot, chatId, message, now));
  topicCreationLocks.set(lockKey, task.catch(() => {}));
  try {
    return await task;
  } finally {
    if (topicCreationLocks.get(lockKey) === task) topicCreationLocks.delete(lockKey);
  }
}

async function ensureTopicInner(bot, chatId, message, now) {
  const row = await bot.db.prepare('SELECT topic_id FROM chat_topic_mappings WHERE bot_id = ? AND chat_id = ?').bind(bot.id, String(chatId)).first();
  if (row) return { topicId: row.topic_id, degraded: false };

  // 冷却期内不再尝试建话题（防群级限流），本条降级到管理员私聊
  const lastTry = parseInt((await settingGet(bot, `topic:last:${chatId}`)) || '0');
  if (now - lastTry < TOPIC_CREATE_COOLDOWN) {
    return { topicId: null, degraded: true };
  }
  await settingSet(bot, `topic:last:${chatId}`, String(now));

  let title = `${message.chat.first_name || ''} ${message.chat.last_name || ''}`.trim();
  if (message.chat.username) title += ` (@${message.chat.username})`;
  if (!title) title = `User ${chatId}`;
  if (title.length > 128) title = title.substring(0, 125) + '...';

  const topicRes = await createForumTopic(bot, bot.supergroupId, title);
  if (topicRes.ok) {
    const topicId = String(topicRes.result.message_thread_id);
    await bot.db.prepare('INSERT OR REPLACE INTO chat_topic_mappings (bot_id, chat_id, topic_id) VALUES (?, ?, ?)')
      .bind(bot.id, String(chatId), topicId).run();
    await settingDel(bot, `topic:last:${chatId}`);
    await sendFirstCard(bot, { chatId, message, topicMode: true, topicId });
    return { topicId, degraded: false };
  }

  console.error('Create topic failed:', JSON.stringify(topicRes));
  const errDesc = topicRes.description || 'Unknown error';
  const kicked = /kicked|not a member|chat not found/i.test(errDesc);
  const hint = kicked ? t(bot, 'topic.hint.kicked') : t(bot, 'topic.hint.perm');
  // 失败告警每小时最多一次，避免刷屏；本条消息降级转发到管理员私聊
  const lastAlert = parseInt((await settingGet(bot, 'topic:last_alert')) || '0');
  if (now - lastAlert > 3600) {
    await settingSet(bot, 'topic:last_alert', String(now));
    await sendMessage(bot, {
      chat_id: bot.adminUid,
      text: t(bot, 'topic.create_fail', { uid: chatId, err: errDesc, hint }),
      parse_mode: 'HTML'
    });
  }
  return { topicId: null, degraded: true };
}

// 转发用户消息到管理端（话题/私聊模式通用），供正常流程与验证后补发复用
async function forwardGuestMessage(bot, chatId, message, state, now) {
  let topicId = null;
  let forwardChatId = bot.adminUid;

  // 话题模式开启但未配置 sg：警告管理员（每小时最多一次），并降级走私聊
  if (bot.topicMode && !bot.supergroupId) {
    const lastWarn = parseInt((await settingGet(bot, 'last_sg_warn')) || '0');
    if (now - lastWarn > 3600) {
      await settingSet(bot, 'last_sg_warn', String(now));
      await sendMessage(bot, {
        chat_id: bot.adminUid,
        text: t(bot, 'mode.warn.nosg'),
        parse_mode: 'HTML'
      });
    }
  }

  if (bot.topicMode && bot.supergroupId) {
    forwardChatId = bot.supergroupId;
    // 话题创建加锁 + 冷却（参考 CTT topicCreationLocks）：并发消息只建一次话题
    const r = await ensureTopicFor(bot, chatId, message, now);
    topicId = r.topicId;
    if (r.degraded) forwardChatId = bot.adminUid;
  }

  // 转发（copyMessage 穿透隐私设置）
  const forwardBody = {
    chat_id: forwardChatId,
    from_chat_id: chatId,
    message_id: message.message_id
  };
  if (topicId) forwardBody.message_thread_id = parseInt(topicId);

  let forwardReq = await copyMessage(bot, forwardBody);

  // 话题模式下转发失败且带话题映射：话题可能已被手动删除 -> 清映射（下次消息按冷却规则重建），本条降级到管理员私聊
  if (!forwardReq.ok && bot.topicMode && bot.supergroupId && topicId) {
    await bot.db.prepare('DELETE FROM chat_topic_mappings WHERE bot_id = ? AND chat_id = ?').bind(bot.id, String(chatId)).run();
    await setUserState(bot, chatId, { first_card_sent: 0 });
    forwardChatId = bot.adminUid;
    topicId = null;
    delete forwardBody.message_thread_id;
    forwardBody.chat_id = forwardChatId;
    forwardReq = await copyMessage(bot, forwardBody);
  }

  if (forwardReq.ok) {
    const adminMsgId = String(forwardReq.result.message_id);
    // 映射写入与 last_guest 记录合并为一次 D1 往返
    await bot.db.batch([
      bot.db.prepare('INSERT OR REPLACE INTO message_mappings (bot_id, admin_message_id, guest_chat_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(bot.id, adminMsgId, String(chatId), now),
      bot.db.prepare('INSERT OR REPLACE INTO settings (bot_id, key, value) VALUES (?, ?, ?)')
        .bind(bot.id, 'last_guest', String(chatId))
    ]);

    if (!state.first_card_sent) {
      if (bot.topicMode && topicId) {
        // 话题模式：首次接入或话题重建后 -> 话题内信息卡
        await sendFirstCard(bot, { chatId, message, topicMode: true, topicId });
      } else if (!bot.topicMode && !topicId) {
        // 私聊模式首次消息 -> 管理员私聊信息卡
        await sendFirstCard(bot, { chatId, message, topicMode: false });
      }
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

// 验证通过后补转发暂存的消息
async function deliverPendingForward(bot, chatId, state) {
  if (!state.pending_forward) return;
  let stash = null;
  try { stash = JSON.parse(state.pending_forward); } catch (e) { /* ignore */ }
  await setUserState(bot, chatId, { pending_forward: null });
  if (!stash || !stash.message_id) return;

  const now = Math.floor(Date.now() / 1000);
  const fakeMessage = {
    message_id: stash.message_id,
    text: null,
    chat: { id: Number(chatId) || chatId, first_name: stash.first_name || '', last_name: stash.last_name || '', username: stash.username || '' }
  };
  const freshState = await getUserState(bot, chatId);
  await forwardGuestMessage(bot, chatId, fakeMessage, freshState, now);
}

// 首次信息卡：昵称/用户名/UserID/发起时间（不置顶，仅发送）
// 注意：这里必须每次都重新读库判断 first_card_sent，不能复用调用方的状态快照。
// 建话题流程会在 ensureTopicInner 里先发一次卡，调用方持有的旧快照仍是 0，复用会导致重复发卡。
async function sendFirstCard(bot, { chatId, message, topicMode, topicId = null }) {
  try {
    const s = await getUserState(bot, chatId);
    if (s.first_card_sent) return;

    // 给管理员端发信息卡
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

    const res = await sendMessage(bot, body);
    if (res.ok) {
      await setUserState(bot, chatId, { first_card_sent: 1 });
    }
  } catch (e) {
    console.error('sendFirstCard error:', e);
  }
}

// ---------------- 验证逻辑 ----------------

// ---------------- 自定义问答题库 ----------------

// 题库存于 settings 的 config:custom_items（JSON 数组）。
// 兼容旧的单题配置 config:custom_question / config:custom_answer，首次读取时自动迁移。
async function getCustomItems(bot) {
  const raw = await settingGet(bot, 'config:custom_items');
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter(it => it && it.q && it.a);
    } catch (e) { /* 数据损坏则回落到旧配置 */ }
  }
  const q = await settingGet(bot, 'config:custom_question');
  const a = await settingGet(bot, 'config:custom_answer');
  if (q && a) {
    const items = [{ q, a }];
    await setCustomItems(bot, items);
    return items;
  }
  return [];
}

async function setCustomItems(bot, items) {
  await settingSet(bot, 'config:custom_items', JSON.stringify(items));
}

// 从题库随机抽一题；题库为空返回 null
async function pickCustomItem(bot) {
  const items = await getCustomItems(bot);
  if (!items.length) return null;
  return items[secureRandomInt(0, items.length)];
}

// 原地替换验证卡（文本 + 按钮）。消息已删除等失败时降级为发一张新卡。
async function editVerifyCard(bot, chatId, msgId, text, rows) {
  if (msgId) {
    const res = await editMessageText(bot, {
      chat_id: chatId,
      message_id: msgId,
      text,
      parse_mode: 'HTML',
      // rows 为空时显式清空按钮，避免失效卡片残留可点击的选项
      reply_markup: rows ? { inline_keyboard: rows } : { inline_keyboard: [] }
    });
    if (res && res.ok) return res;
  }
  const res = await sendMessage(bot, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: rows ? { inline_keyboard: rows } : undefined
  });
  if (res.ok) await setUserState(bot, chatId, { pending_msg_id: res.result.message_id });
  return res;
}

async function sendVerificationChallenge(bot, chatId, pendingMsgId, stash = null) {
  const now = Math.floor(Date.now() / 1000);

  // 原子占位：并发请求中只有一个能成功 claim（解决连发消息重复弹卡竞态）
  const claim = await bot.db.prepare(
    `UPDATE user_states SET pending_code_expiry = ?, pending_answer = 'CLAIMED', pending_forward = ?
     WHERE bot_id = ? AND chat_id = ?
       AND (pending_answer IS NULL OR pending_answer = '' OR pending_code_expiry <= ?)`
  ).bind(now + CODE_TTL_SECONDS, stash ? JSON.stringify(stash) : null, bot.id, String(chatId), now).run();
  if (!claim.meta.changes) {
    // 已有验证卡在等待作答（或并发请求已占位），不重复发送
    return new Response('Ok');
  }

  // 旧卡已过期 -> 删除失效的旧卡再发新卡
  const state = await getUserState(bot, chatId);
  if (state.pending_msg_id) {
    try { await deleteMessage(bot, chatId, state.pending_msg_id); } catch (e) { /* 已被删除 */ }
  }

  if (bot.verifyMode === 'custom') {
    const pick = await pickCustomItem(bot);
    if (pick) {
      await setUserState(bot, chatId, {
        pending_question: pick.q, pending_answer: pick.a,
        pending_code_expiry: now + CODE_TTL_SECONDS, pending_attempts: 0
      });
      const res = await sendMessage(bot, {
        chat_id: chatId,
        text: `${t(bot, 'verify.title')}\n\n${t(bot, 'verify.custom_text', { q: escapeHtml(pick.q) })}`,
        parse_mode: 'HTML',
        reply_to_message_id: pendingMsgId
      });
      if (res.ok) await setUserState(bot, chatId, { pending_msg_id: res.result.message_id });
      else await setUserState(bot, chatId, { pending_answer: null, pending_code_expiry: 0 });
      return res;
    }
    // 未配置自定义题目时降级为算术题
    await sendMessage(bot, { chat_id: chatId, text: t(bot, 'verify.custom_notset') });
  }

  const card = buildMathCard(bot, chatId);
  await setUserState(bot, chatId, {
    pending_answer: String(card.correctIndex),
    pending_question: card.question,
    pending_code_expiry: now + CODE_TTL_SECONDS,
    pending_attempts: 0
  });

  const res = await sendMessage(bot, {
    chat_id: chatId,
    text: `${t(bot, 'verify.title')}\n\n${t(bot, 'verify.math_text', { q: card.question })}`,
    parse_mode: 'HTML',
    reply_to_message_id: pendingMsgId,
    reply_markup: { inline_keyboard: card.rows }
  });
  if (res.ok) await setUserState(bot, chatId, { pending_msg_id: res.result.message_id });
  else await setUserState(bot, chatId, { pending_answer: null, pending_code_expiry: 0 });
  return res;
}

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data;

  // 子面板导航：menu:main|users|security|verify|keywords|bots
  if (data.startsWith('menu:')) {
    const fromAdmin = callbackQuery.from && callbackQuery.from.id && callbackQuery.from.id.toString() === bot.adminUid;
    if (!fromAdmin) {
      return answerCallbackQuery(bot, callbackQuery.id, '⛔ Admin only', true);
    }
    // 应答按钮与渲染面板并行，省一次 Telegram 往返
    const ack = answerCallbackQuery(bot, callbackQuery.id);
    const r = await showMenuPanel(bot, callbackQuery.message.chat.id, callbackQuery.message.message_thread_id, data.slice(5), callbackQuery.message.message_id);
    await ack;
    return r;
  }

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
    // 应答按钮与执行指令并行，省一次 Telegram 往返
    const ack = answerCallbackQuery(bot, callbackQuery.id, '✅');
    const r = await dispatchAdminCommand(bot, cmdText, fakeMessage);
    await ack;
    return r;
  }

  if (!data.startsWith('verify:')) return;

  const [_, __, answerIdxStr] = data.split(':');
  const answerIdx = parseInt(answerIdxStr);
  const chatId = callbackQuery.message.chat.id;
  const now = Math.floor(Date.now() / 1000);

  const state = await getUserState(bot, chatId);

  if (!state.pending_answer || state.pending_answer === 'CLAIMED' || state.pending_code_expiry <= now) {
    return answerCallbackQuery(bot, callbackQuery.id, t(bot, 'verify.expired'), true);
  }

  const correctIdx = parseInt(state.pending_answer);

  if (answerIdx === correctIdx) {
    await setUserState(bot, chatId, {
      is_verified: 1, verified_expiry: now + VERIFY_TTL_SECONDS,
      pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0, pending_msg_id: 0,
      is_rate_limited: 0, message_count: 0, window_start: 0
    });
    await requestTelegram(bot, 'editMessageText', makeReqBody({
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: t(bot, 'verify.passed'),
      parse_mode: 'HTML'
    }));
    await deliverPendingForward(bot, chatId, state);
    return answerCallbackQuery(bot, callbackQuery.id, '✅');
  } else {
    const attempts = (state.pending_attempts || 0) + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await setUserState(bot, chatId, { pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0, pending_msg_id: 0 });
      await editVerifyCard(bot, chatId, callbackQuery.message.message_id, t(bot, 'verify.attempts.over'), null);
      return answerCallbackQuery(bot, callbackQuery.id, t(bot, 'verify.wrong'), true);
    }
    // 答错即换新题：原地替换卡片，题目与选项全部刷新
    const card = buildMathCard(bot, chatId);
    await setUserState(bot, chatId, {
      pending_answer: String(card.correctIndex),
      pending_question: card.question,
      pending_code_expiry: now + CODE_TTL_SECONDS,
      pending_attempts: attempts
    });
    await editVerifyCard(
      bot, chatId, callbackQuery.message.message_id,
      `${t(bot, 'verify.title')}\n\n${t(bot, 'verify.retry.new_question')}\n\n${t(bot, 'verify.math_text', { q: card.question })}`,
      card.rows
    );
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
  const opts = { chat_id: message.chat.id, message_thread_id: message.message_thread_id, parse_mode: 'HTML' };
  const reply = (txt) => sendMessage(bot, { ...opts, text: txt });
  // 取指令名之后的正文
  const restText = () => text.slice(parts[0].length + parts[1].length + 2).trim();
  // 解析 "问题 | 答案"
  const parsePair = () => {
    const rest = restText();
    const sep = rest.indexOf('|');
    if (sep < 0) return null;
    const q = rest.slice(0, sep).trim();
    const a = rest.slice(sep + 1).trim();
    return (q && a) ? { q, a } : null;
  };

  if (!sub) return reply(t(bot, 'verify.usage'));

  if (sub === 'math') {
    await settingSet(bot, 'config:verify_mode', 'math');
    bot.verifyMode = 'math';
    return reply(t(bot, 'verify.set.math'));
  }
  if (sub === 'off') {
    await settingSet(bot, 'config:verify_mode', 'off');
    bot.verifyMode = 'off';
    return reply(t(bot, 'verify.set.off'));
  }
  if (sub === 'custom' || sub === 'add') {
    const pair = parsePair();
    if (!pair) return reply(t(bot, 'verify.need.pipe'));
    if (sub === 'custom') {
      // 兼容旧用法：清空后设为唯一一题
      await setCustomItems(bot, [pair]);
      await settingSet(bot, 'config:verify_mode', 'custom');
      bot.verifyMode = 'custom';
      return reply(t(bot, 'verify.set.custom', { q: escapeHtml(pair.q) }));
    }
    const items = await getCustomItems(bot);
    if (items.length >= MAX_CUSTOM_ITEMS) {
      return reply(t(bot, 'verify.add.limit', { max: MAX_CUSTOM_ITEMS }));
    }
    items.push(pair);
    await setCustomItems(bot, items);
    await settingSet(bot, 'config:verify_mode', 'custom');
    bot.verifyMode = 'custom';
    return reply(t(bot, 'verify.add.done', { i: items.length, n: items.length, q: escapeHtml(pair.q) }));
  }
  if (sub === 'list') {
    const items = await getCustomItems(bot);
    if (!items.length) return reply(t(bot, 'verify.list.empty'));
    const list = items.map((it, i) => t(bot, 'verify.list.item', { i: i + 1, q: escapeHtml(it.q) })).join('');
    return reply(t(bot, 'verify.list.title', { n: items.length, max: MAX_CUSTOM_ITEMS }) + list);
  }
  if (sub === 'del') {
    const items = await getCustomItems(bot);
    const n = parseInt(parts[2], 10);
    if (!Number.isInteger(n) || n < 1 || n > items.length) {
      return reply(t(bot, 'verify.del.invalid', { n: items.length }));
    }
    const removed = items.splice(n - 1, 1)[0];
    await setCustomItems(bot, items);
    return reply(t(bot, 'verify.del.done', { i: n, n: items.length, q: escapeHtml(removed.q) }));
  }
  if (sub === 'clear') {
    await setCustomItems(bot, []);
    return reply(t(bot, 'verify.clear.done'));
  }
  if (sub === 'show') {
    let detail = '';
    if (bot.verifyMode === 'custom') {
      const items = await getCustomItems(bot);
      detail = t(bot, 'verify.show.custom_detail', { n: items.length });
    } else if (bot.verifyMode === 'math') {
      detail = t(bot, 'math.show', { ops: bot.math.ops, min: bot.math.min, max: bot.math.max, count: bot.math.count });
    }
    return reply(t(bot, 'verify.show', { mode: t(bot, 'verify.show.mode.' + bot.verifyMode), detail, limit: bot.maxPerMin }));
  }
  return reply(t(bot, 'verify.usage'));
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

async function handleWelcomeCommand(bot, message) {
  const text = message.text.trim();
  const content = text.replace(/^\/welcome\s*/, '').trim();
  if (!content) {
    const cur = (await settingGet(bot, 'config:welcome')) || t(bot, 'welcome.user', { uid: '{uid}' });
    // 预览按模板原文显示，占位符保持 {uid}；剔除模板自带的 <code> 标签，避免看到原始标签
    const shown = cur.replace(/<\/?code>/g, '');
    return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'welcome.usage', { welcome: escapeHtml(shown) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  await settingSet(bot, 'config:welcome', content);
  return sendMessage(bot, { chat_id: message.chat.id, text: t(bot, 'welcome.set'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

// ---------------- 分类管理面板 ----------------

const BACK_BTN = { text: '⬅️ 返回', callback_data: 'menu:main' };

async function panelText(bot) {
  const modeText = bot.topicMode ? t(bot, 'mode.topic') : t(bot, 'mode.private');
  const secText = `${t(bot, 'security.name.' + bot.security)} (${bot.security})`;
  const verifyText = t(bot, 'verify.show.mode.' + bot.verifyMode);
  const langText = bot.lang === 'zh' ? '中文' : 'English';
  const words = await getKeywords(bot);
  const defaultSet = new Set(DEFAULT_KEYWORDS);
  const defaultCount = words.filter(w => defaultSet.has(w)).length;
  const kwText = bot.lang === 'zh' ? `${words.length}(默认${defaultCount})` : `${words.length}(${defaultCount} def)`;
  const sgText = bot.supergroupId || (bot.topicMode ? (bot.lang === 'zh' ? '未配置!' : 'NOT SET!') : '-');
  return t(bot, 'menu.admin', { mode: modeText, sec: secText, verify: verifyText, lang: langText, kw: kwText, botId: bot.id, sg: sgText });
}

// 渲染指定分类面板（编辑原消息，不刷屏）
async function showMenuPanel(bot, chatId, threadId, panel, msgId = null) {
  let keyboard;
  switch (panel) {
    case 'users':
      keyboard = [
        [ { text: 'ℹ️ 信息', callback_data: 'cmd:/info' }, { text: '🌟 信任', callback_data: 'cmd:/trust' }, { text: '↩️ 取消信任', callback_data: 'cmd:/untrust' } ],
        [ { text: '🚫 屏蔽', callback_data: 'cmd:/block' }, { text: '✅ 解屏', callback_data: 'cmd:/unblock' } ],
        [ { text: '📃 黑名单', callback_data: 'cmd:/blacklist' }, { text: '🗑 清除映射', callback_data: 'cmd:/clear' } ],
        [ BACK_BTN ]
      ];
      break;
    case 'security':
      keyboard = [
        [ { text: '🛡 严格', callback_data: 'cmd:/security 1' }, { text: '🛡 标准', callback_data: 'cmd:/security 2' }, { text: '🛡 宽松', callback_data: 'cmd:/security 3' } ],
        [ { text: '🧭 私聊模式', callback_data: 'cmd:/mode private' }, { text: '🧭 话题模式', callback_data: 'cmd:/mode topic' } ],
        [ { text: '🔐 算术验证', callback_data: 'cmd:/verify math' }, { text: '🔐 关闭验证', callback_data: 'cmd:/verify off' }, { text: '🔐 验证配置', callback_data: 'cmd:/verify show' } ],
        [ { text: '🧮 题库配置', callback_data: 'cmd:/math show' } ],
        [ { text: '❓ 自定义题库', callback_data: 'cmd:/verify list' } ],
        [ BACK_BTN ]
      ];
      break;
    case 'texts':
      keyboard = [
        [ { text: '📃 关键词列表', callback_data: 'cmd:/keyword list' }, { text: '🔄 恢复默认词', callback_data: 'cmd:/keyword reset' } ],
        [ { text: '💬 欢迎语(查看/设置)', callback_data: 'cmd:/welcome' } ],
        [ { text: '🌐 中文', callback_data: 'cmd:/lang zh' }, { text: '🌐 English', callback_data: 'cmd:/lang en' } ],
        [ BACK_BTN ]
      ];
      break;
    case 'bots':
      keyboard = [
        [ { text: '📋 机器人列表', callback_data: 'cmd:/bot list' } ],
        [ { text: '📖 添加方法说明', callback_data: 'cmd:/bot' } ],
        [ BACK_BTN ]
      ];
      break;
    default: // main
      keyboard = [
        [ { text: '👥 用户管理', callback_data: 'menu:users' }, { text: '🛡 安全与模式', callback_data: 'menu:security' } ],
        [ { text: '📝 文案与语言', callback_data: 'menu:texts' }, { text: '🤖 机器人管理', callback_data: 'menu:bots' } ],
        [ { text: '📢 广播(回复消息)', callback_data: 'cmd:/broadcast' }, { text: '📖 全部指令', callback_data: 'cmd:/help' } ]
      ];
  }
  const body = {
    chat_id: chatId,
    text: await panelText(bot),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  };
  if (msgId) {
    body.message_id = msgId;
    return editMessageText(bot, body);
  }
  if (threadId) body.message_thread_id = threadId;
  return sendMessage(bot, body);
}

async function handleAdminMenu(bot, message) {
  return showMenuPanel(bot, message.chat.id, message.message_thread_id, 'main');
}

// ---------------- 机器人管理（/bot） ----------------

async function autoRegisterWebhook(bot) {
  const secret = await getBotSecret(bot);
  const path = bot.id === DEFAULT_BOT_ID ? WEBHOOK : `${WEBHOOK}/${bot.id}`;
  const webhookUrl = `${WORKER_ORIGIN}${path}`;
  const r = await (await fetch(apiUrl(bot, 'setWebhook', { url: webhookUrl, secret_token: secret }))).json();
  // 命令菜单仅注册到私聊（scope 限定），不影响群组；原作者版本无此调用，群组侧行为越少越好
  await requestTelegram(bot, 'setMyCommands', makeReqBody({
    scope: { type: 'all_private_chats' },
    commands: BOT_COMMANDS
  }));
  return r;
}

async function handleBotCommand(bot, message) {
  const parts = message.text.trim().split(/\s+/);
  const sub = (parts[1] || 'list').toLowerCase();

  if (sub === 'list') {
    const res = await bot.db.prepare('SELECT bot_id, admin_uid, sg, topic, max FROM bots ORDER BY bot_id').all();
    const d1Ids = new Set(res.results.map(r => r.bot_id));
    let text = `🤖 <b>${t(bot, 'bot.list.title')}</b>\n`;
    const rows = [];
    for (const r of res.results) {
      rows.push(`<code>${escapeHtml(r.bot_id)}</code> [D1] — ${r.topic ? t(bot, 'mode.topic') : t(bot, 'mode.private')}${r.sg ? ` | sg: <code>${escapeHtml(r.sg)}</code>` : ''}`);
    }
    // 环境变量来源（D1 中不存在的才显示，同名时 D1 优先）
    const envBots = parseBots(bot.env || {});
    for (const id of Object.keys(envBots)) {
      if (!d1Ids.has(id)) {
        const b = envBots[id];
        rows.push(`<code>${escapeHtml(id)}</code> [${t(bot, 'bot.list.env')}] — ${b.topic ? t(bot, 'mode.topic') : t(bot, 'mode.private')}${b.sg ? ` | sg: <code>${escapeHtml(String(b.sg))}</code>` : ''}`);
      }
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
    const newBot = await resolveBot({ D1: bot.db }, id);
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

async function unRegisterWebhook(bot) {
  const r = await (await fetch(apiUrl(bot, 'setWebhook', { url: '' }))).json();
  return new Response('ok' in r && r.ok ? `Ok (${bot.id})` : JSON.stringify(r, null, 2));
}
