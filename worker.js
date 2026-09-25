// Telegram MirroTalk Bot - Cloudflare Worker (D1 存储版, ES module 格式)
// 所有数据持久化在 D1 (绑定名: DB)，首次请求自动建表，无需手动迁移。

let TOKEN = ''; // Get it from @BotFather
const WEBHOOK = '/endpoint';
let ADMIN_UID = ''; // 管理员的用户 ID (用于接收私聊通知/指令)
let DB = null; // D1 绑定

// --- 环境变量配置 (运行时从 env 注入) ---
let ENV_TOPIC_GROUP = false;
let SUPERGROUP_ID = '';
let MAX_MSG_PER_MIN = 40;

// 将 env 中的配置写入模块变量（ES module 格式下不能直接引用顶层绑定变量）
function initEnv(env) {
  DB = env.DB;
  TOKEN = env.ENV_BOT_TOKEN;
  ADMIN_UID = env.ENV_ADMIN_UID;
  ENV_TOPIC_GROUP = env.ENV_ENABLE_TOPIC_GROUP === 'true';
  SUPERGROUP_ID = env.ENV_SUPERGROUP_ID || '';
  MAX_MSG_PER_MIN = env.ENV_MAX_MSG_PER_MIN ? (parseInt(env.ENV_MAX_MSG_PER_MIN) || 40) : 40;
  ENV_BOT_SECRET_VAL = env.ENV_BOT_SECRET || '';
}
let ENV_BOT_SECRET_VAL = '';
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
    zh: '⚠️ <b>配置警告</b>: 已开启话题模式但未设置 ENV_SUPERGROUP_ID。',
    en: '⚠️ <b>Config warning</b>: topic mode enabled but ENV_SUPERGROUP_ID is not set.'
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
  'blocked.notice': { zh: '🚫 您已被屏蔽，消息不会被转发。', en: '🚫 You are blocked. Messages will not be forwarded.' },
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
    zh: '🪪 <b>新用户接入</b>\n昵称: {name}\n用户名: {username}\nUserID: <code>{uid}</code>\n发起时间: {time}\n\n{notice}',
    en: '🪪 <b>New user</b>\nName: {name}\nUsername: {username}\nUserID: <code>{uid}</code>\nFirst seen: {time}\n\n{notice}'
  },
  'notice.default': {
    zh: '请友善沟通，禁止发送广告、诈骗及违规内容，违规将被屏蔽。',
    en: 'Be respectful. Ads, scams and prohibited content will get you blocked.'
  },
  'keyword.usage': {
    zh: '用法:\n<code>/keyword list</code> 查看关键词\n<code>/keyword add 词</code> 添加\n<code>/keyword del 词</code> 删除\n<code>/keyword reset</code> 恢复默认',
    en: 'Usage:\n<code>/keyword list</code> list keywords\n<code>/keyword add &lt;word&gt;</code> add\n<code>/keyword del &lt;word&gt;</code> delete\n<code>/keyword reset</code> restore defaults'
  },
  'keyword.list_empty': { zh: '📃 关键词黑名单为空。', en: '📃 Keyword blacklist is empty.' },
  'keyword.list_title': { zh: '📃 <b>关键词黑名单</b> (共 {n} 个)', en: '📃 <b>Keyword blacklist</b> ({n} words)' },
  'keyword.added': { zh: '✅ 已添加关键词: <code>{w}</code>', en: '✅ Keyword added: <code>{w}</code>' },
  'keyword.exists': { zh: 'ℹ️ 关键词 <code>{w}</code> 已存在。', en: 'ℹ️ Keyword <code>{w}</code> already exists.' },
  'keyword.deleted': { zh: '🗑 已删除关键词: <code>{w}</code>', en: '🗑 Keyword deleted: <code>{w}</code>' },
  'keyword.notfound': { zh: '⚠️ 未找到关键词: <code>{w}</code>', en: '⚠️ Keyword not found: <code>{w}</code>' },
  'keyword.reset': { zh: '✅ 关键词已恢复为默认列表。', en: '✅ Keywords restored to defaults.' },
  'mode.switched.private': { zh: '✅ 已切换为：<b>私聊模式</b>', en: '✅ Switched to: <b>Private Chat mode</b>' },
  'mode.switched.topic': { zh: '✅ 已切换为：<b>话题群组模式</b>', en: '✅ Switched to: <b>Topic Group mode</b>' },
  'mode.usage': { zh: '当前模式：<b>{mode}</b>\n\n切换：\n<code>/mode private</code>\n<code>/mode topic</code>', en: 'Current mode: <b>{mode}</b>\n\nSwitch:\n<code>/mode private</code>\n<code>/mode topic</code>' },
  'mode.param_err': { zh: '⚠️ 参数错误：请使用 /mode private 或 /mode topic', en: '⚠️ Bad argument: use /mode private or /mode topic' },
  'mode.no_sg': { zh: '⚠️ 未配置 ENV_SUPERGROUP_ID，无法开启话题群组模式。', en: '⚠️ ENV_SUPERGROUP_ID not set; cannot enable topic mode.' },
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
    zh: '🛠 <b>管理员菜单</b>\n\n<b>当前设置:</b>\n- 🧭 模式: <b>{mode}</b>\n- 🛡 安全级别: <b>{sec}</b>\n- 🔐 验证: <b>{verify}</b>\n- 🌐 语言: <b>{lang}</b>\n\n<b>用户管理</b>\n<code>/info</code> 查看用户信息\n<code>/trust</code> 永久信任\n<code>/untrust</code> 取消信任\n<code>/block</code> 屏蔽 (Shadowban)\n<code>/unblock</code> 解除屏蔽\n<code>/blacklist</code> 查看黑名单\n\n<b>系统设置</b>\n<code>/mode private|topic</code> 切换模式\n<code>/security 1|2|3</code> 安全级别\n<code>/verify ...</code> 验证方式 (math/custom/off)\n<code>/math ...</code> 算术题库配置\n<code>/keyword ...</code> 关键词黑名单\n<code>/lang zh|en</code> 界面语言\n<code>/clear</code> 清除消息映射\n\n<b>广播</b>\n<code>/broadcast</code> 回复一条消息全员广播',
    en: '🛠 <b>Admin Menu</b>\n\n<b>Current:</b>\n- 🧭 Mode: <b>{mode}</b>\n- 🛡 Security: <b>{sec}</b>\n- 🔐 Verify: <b>{verify}</b>\n- 🌐 Language: <b>{lang}</b>\n\n<b>Users</b>\n<code>/info</code> user info\n<code>/trust</code> trust user\n<code>/untrust</code> remove trust\n<code>/block</code> shadowban\n<code>/unblock</code> unblock\n<code>/blacklist</code> view blacklist\n\n<b>System</b>\n<code>/mode private|topic</code> switch mode\n<code>/security 1|2|3</code> level\n<code>/verify ...</code> math/custom/off\n<code>/math ...</code> math config\n<code>/keyword ...</code> keyword blacklist\n<code>/lang zh|en</code> UI language\n<code>/clear</code> clear mappings\n\n<b>Broadcast</b>\n<code>/broadcast</code> reply to a msg to broadcast'
  },
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
  'broadcast.done': { zh: '✅ <b>广播完成</b>\n\n成功发送: {ok} 人\n失败: {fail} 人', en: '✅ <b>Broadcast done</b>\n\nSent: {ok}\nFailed: {fail}' },
  'broadcast.error': { zh: '❌ <b>广播过程中出错</b>\n\n{err}', en: '❌ <b>Broadcast error</b>\n\n{err}' }
};

function t(key, vars = {}) {
  const entry = STRINGS[key];
  if (!entry) return key;
  const lang = currentLang || DEFAULT_LANG;
  let s = entry[lang] !== undefined ? entry[lang] : entry[DEFAULT_LANG];
  for (const [k, v] of Object.entries(vars)) {
    s = s.split('{' + k + '}').join(String(v));
  }
  return s;
}

// ---------------- D1 存储层 ----------------

async function ensureTables() {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS user_states (
    chat_id TEXT PRIMARY KEY,
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
    first_card_sent INTEGER DEFAULT 0
  )`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS message_mappings (
    admin_message_id TEXT PRIMARY KEY,
    guest_chat_id TEXT NOT NULL,
    created_at INTEGER
  )`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS chat_topic_mappings (
    chat_id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL
  )`).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_topic_user ON chat_topic_mappings(topic_id)`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS message_hashes (
    hash TEXT PRIMARY KEY,
    expires_at INTEGER
  )`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS keywords (
    word TEXT PRIMARY KEY
  )`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`).run();
}

async function settingGet(key, dflt = null) {
  const row = await DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!row) return dflt;
  return row.value;
}

async function settingSet(key, value) {
  await DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, String(value)).run();
}

async function settingDel(key) {
  await DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

async function getUserState(chatId) {
  const row = await DB.prepare('SELECT * FROM user_states WHERE chat_id = ?').bind(String(chatId)).first();
  if (row) return row;
  const def = {
    chat_id: String(chatId), is_blocked: 0, is_trusted: 0, is_verified: 0, verified_expiry: 0,
    is_rate_limited: 0, message_count: 0, window_start: 0,
    pending_question: null, pending_answer: null, pending_code_expiry: 0, pending_attempts: 0,
    first_card_sent: 0
  };
  await DB.prepare(`INSERT INTO user_states (chat_id, is_blocked, is_trusted, is_verified, verified_expiry,
    is_rate_limited, message_count, window_start, pending_code_expiry, pending_attempts, first_card_sent)
    VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`).bind(def.chat_id).run();
  return def;
}

async function setUserState(chatId, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const sets = cols.map(c => `${c} = ?`).join(', ');
  const vals = cols.map(c => fields[c]);
  await DB.prepare(`UPDATE user_states SET ${sets} WHERE chat_id = ?`).bind(...vals, String(chatId)).run();
}

async function getBotSecret() {
  if (cachedSecret) return cachedSecret;
  if (ENV_BOT_SECRET_VAL) {
    cachedSecret = ENV_BOT_SECRET_VAL;
    return cachedSecret;
  }
  const s = await settingGet('system:bot_secret');
  if (s) { cachedSecret = s; return s; }
  const newSecret = crypto.randomUUID().replace(/-/g, '');
  await settingSet('system:bot_secret', newSecret);
  cachedSecret = newSecret;
  return newSecret;
}

async function getSecurityLevel() {
  const v = await settingGet('config:security_level');
  return v === null ? DEFAULT_SECURITY_LEVEL : parseInt(v);
}

async function getTopicModeEnabled() {
  const now = Date.now();
  if (cachedMode !== null && (now - cachedModeAt) < MODE_CACHE_MS) return cachedMode;
  const v = await settingGet('config:enable_topic_group');
  cachedMode = v === null ? ENV_TOPIC_GROUP : (v === 'true');
  cachedModeAt = now;
  return cachedMode;
}

async function setTopicModeEnabled(enabled) {
  await settingSet('config:enable_topic_group', enabled ? 'true' : 'false');
  cachedMode = enabled;
  cachedModeAt = Date.now();
}

async function getVerifyMode() {
  return (await settingGet('config:verify_mode')) || 'math';
}

async function getLang() {
  return (await settingGet('config:lang')) || DEFAULT_LANG;
}

async function getKeywords() {
  const res = await DB.prepare('SELECT word FROM keywords').all();
  return res.results.map(r => r.word);
}

async function ensureKeywordsSeeded() {
  const c = await DB.prepare('SELECT COUNT(*) AS n FROM keywords').first();
  if (c.n === 0) {
    const stmt = DB.prepare('INSERT OR IGNORE INTO keywords (word) VALUES (?)');
    await DB.batch(DEFAULT_KEYWORDS.map(w => stmt.bind(w)));
  }
}

// ---------------- 题库生成 ----------------

function generateMathChallenge() {
  const ops = (mathCfg.ops || '+-*/').split('');
  const op = ops[secureRandomInt(0, ops.length)];
  const min = mathCfg.min, max = mathCfg.max;
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
  while (incorrect.size < Math.max(1, mathCfg.count - 1) && guard < 200) {
    guard++;
    const offset = secureRandomInt(1, Math.max(5, Math.floor(answer / 2) + 2));
    const wrong = secureRandomInt(0, 2) === 0 ? answer + offset : answer - offset;
    if (wrong !== answer && wrong >= 0) incorrect.add(String(wrong));
  }
  while (incorrect.size < mathCfg.count - 1) {
    incorrect.add(String(answer + incorrect.size + 1));
  }

  return {
    question: questionText,
    correct_answer: String(answer),
    incorrect_answers: Array.from(incorrect).slice(0, Math.max(1, mathCfg.count - 1))
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

function apiUrl(methodName, params = null) {
  let query = '';
  if (params) query = '?' + new URLSearchParams(params).toString();
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`;
}

function requestTelegram(methodName, body, params = null) {
  return fetch(apiUrl(methodName, params), body).then(r => r.json());
}

function makeReqBody(body) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function sendMessage(msg = {}) { return requestTelegram('sendMessage', makeReqBody(msg)); }
function copyMessage(msg = {}) { return requestTelegram('copyMessage', makeReqBody(msg)); }
function forwardMessage(msg) { return requestTelegram('forwardMessage', makeReqBody(msg)); }
function createForumTopic(chat_id, name) { return requestTelegram('createForumTopic', makeReqBody({ chat_id, name })); }
function editForumTopic(chat_id, message_thread_id, name) { return requestTelegram('editForumTopic', makeReqBody({ chat_id, message_thread_id, name })); }
function answerCallbackQuery(callback_query_id, text, show_alert = false) { return requestTelegram('answerCallbackQuery', makeReqBody({ callback_query_id, text, show_alert })); }
function deleteMessage(chat_id, message_id) { return requestTelegram('deleteMessage', makeReqBody({ chat_id, message_id })); }
function pinMessage(chat_id, message_id) { return requestTelegram('pinChatMessage', makeReqBody({ chat_id, message_id })); }
function unpinMessage(chat_id, message_id) { return requestTelegram('unpinChatMessage', makeReqBody({ chat_id, message_id })); }

// ---------------- 路由入口 ----------------

let cachedSecret = null;
let cachedMode = null;
let cachedModeAt = 0;
const MODE_CACHE_MS = 15000;
let currentLang = DEFAULT_LANG;
let mathCfg = { ops: '+-*/', min: 1, max: 9, count: 4 };

async function loadRuntimeConfig() {
  currentLang = await getLang();
  const ops = await settingGet('config:math_ops');
  const min = await settingGet('config:math_min');
  const max = await settingGet('config:math_max');
  const count = await settingGet('config:math_count');
  mathCfg = {
    ops: ops || '+-*/',
    min: min !== null ? parseInt(min) : 1,
    max: max !== null ? parseInt(max) : 9,
    count: count !== null ? parseInt(count) : 4
  };
}

export default {
  async fetch(request, env, ctx) {
    initEnv(env);
    const url = new URL(request.url);
    if (url.pathname === WEBHOOK) {
      return handleWebhook(request, ctx);
    } else if (url.pathname === '/registerWebhook') {
      const secret = await getBotSecret();
      return registerWebhook(url, WEBHOOK, secret);
    } else if (url.pathname === '/unRegisterWebhook') {
      return unRegisterWebhook();
    } else {
      return new Response('No handler for this request');
    }
  },

  async scheduled(event, env, ctx) {
    initEnv(env);
    ctx.waitUntil(handleScheduled(event));
  }
};

async function handleScheduled(event) {
  await ensureTables();
  const now = Math.floor(Date.now() / 1000);
  await DB.prepare('DELETE FROM message_hashes WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now).run();
  await DB.prepare('DELETE FROM user_states WHERE pending_code_expiry > 0 AND pending_code_expiry < ?').bind(now).run();
  console.log('Cron cleanup done at', event.scheduledTime);
}

async function handleWebhook(request, ctx) {
  const secret = await getBotSecret();
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    return new Response('Unauthorized', { status: 403 });
  }
  const update = await request.json();
  ctx.waitUntil(onUpdate(update));
  return new Response('Ok');
}

async function onUpdate(update) {
  await ensureTables();
  await ensureKeywordsSeeded();
  await loadRuntimeConfig();

  if ('message' in update) {
    await onMessage(update.message);
  } else if ('callback_query' in update) {
    await handleCallback(update.callback_query);
  }
}

async function onMessage(message) {
  // 忽略服务消息
  if (message.new_chat_members || message.left_chat_member || message.group_chat_created ||
      message.supergroup_chat_created || message.channel_chat_created || message.pinned_message) {
    return new Response('Ok');
  }

  if (message.text === '/start') {
    let startMsg;
    if (message.chat.id.toString() === ADMIN_UID) {
      const topicMode = await getTopicModeEnabled();
      startMsg = t('welcome.admin', {
        uid: message.chat.id,
        mode: topicMode ? t('mode.topic') : t('mode.private'),
        sgWarn: (topicMode && !SUPERGROUP_ID) ? t('mode.warn.nosg') : ''
      });
    } else {
      startMsg = t('welcome.user', { uid: message.chat.id });
    }
    return sendMessage({ chat_id: message.chat.id, text: startMsg, parse_mode: 'HTML' });
  }

  if (SUPERGROUP_ID && message.chat.id.toString() === SUPERGROUP_ID) {
    const fromAdmin = message.from && message.from.id && message.from.id.toString() === ADMIN_UID;
    const anonymousAdmin = message.sender_chat && message.sender_chat.id && message.sender_chat.id.toString() === SUPERGROUP_ID;
    if (fromAdmin || anonymousAdmin) return handleAdminMessage(message);
    return new Response('Ok');
  }

  if (message.chat.id.toString() === ADMIN_UID) {
    return handleAdminMessage(message);
  }

  return handleGuestMessage(message);
}

// ---------------- 管理员逻辑 ----------------

async function handleAdminMessage(message) {
  if (message.text) {
    const text = message.text.trim();
    if (text.startsWith('/help') || text.startsWith('/admin')) return handleAdminMenu(message);
    if (text.startsWith('/mode')) return handleModeCommand(message);
    if (text.startsWith('/info')) return handleInfoCommand(message);
    if (text.startsWith('/trust')) return handleTrustCommand(message);
    if (text.startsWith('/untrust')) return handleUntrustCommand(message);
    if (text.startsWith('/block')) return handleBlockCommand(message);
    if (text.startsWith('/unblock')) return handleUnblockCommand(message);
    if (text.startsWith('/blacklist')) return handleBlacklistCommand(message);
    if (text.startsWith('/security')) return handleSecurityCommand(message);
    if (text.startsWith('/broadcast')) return handleBroadcastCommand(message);
    if (text.startsWith('/verify')) return handleVerifyCommand(message);
    if (text.startsWith('/math')) return handleMathCommand(message);
    if (text.startsWith('/keyword')) return handleKeywordCommand(message);
    if (text.startsWith('/lang')) return handleLangCommand(message);
    if (text.startsWith('/clear')) return handleClearCommand(message);
  }

  const topicMode = await getTopicModeEnabled();

  if (topicMode && SUPERGROUP_ID && message.chat.id.toString() === SUPERGROUP_ID && message.message_thread_id) {
    const topicId = message.message_thread_id;
    const row = await DB.prepare('SELECT chat_id FROM chat_topic_mappings WHERE topic_id = ?').bind(String(topicId)).first();
    let userId = row ? row.chat_id : null;

    if ((!userId || userId.toString() === ADMIN_UID) && message.reply_to_message) {
      const map = await DB.prepare('SELECT guest_chat_id FROM message_mappings WHERE admin_message_id = ?')
        .bind(String(message.reply_to_message.message_id)).first();
      if (map) {
        userId = map.guest_chat_id;
        await DB.prepare('INSERT OR REPLACE INTO chat_topic_mappings (chat_id, topic_id) VALUES (?, ?)')
          .bind(String(userId), String(topicId)).run();
      }
    }

    if (userId && userId.toString() !== ADMIN_UID) {
      return copyMessage({ chat_id: userId, from_chat_id: message.chat.id, message_id: message.message_id });
    }

    return sendMessage({
      chat_id: message.chat.id,
      text: t('topic.reply_hint'),
      message_thread_id: topicId
    });
  } else {
    if (message.reply_to_message) {
      const map = await DB.prepare('SELECT guest_chat_id FROM message_mappings WHERE admin_message_id = ?')
        .bind(String(message.reply_to_message.message_id)).first();
      if (map) {
        return copyMessage({ chat_id: map.guest_chat_id, from_chat_id: message.chat.id, message_id: message.message_id });
      }
      if (message.chat.id.toString() === ADMIN_UID) {
        return sendMessage({
          chat_id: message.chat.id,
          text: t('map.notfound'),
          reply_to_message_id: message.message_id
        });
      }
    }
  }
}

// ---------------- 普通用户逻辑 ----------------

async function handleGuestMessage(message) {
  const chatId = message.chat.id;
  const state = await getUserState(chatId);
  const now = Math.floor(Date.now() / 1000);

  // 1. 黑名单检查（trusted 权限高于 blocked）
  if (state.is_blocked && !state.is_trusted) {
    return new Response('Ok');
  }

  // 2. 自定义问答等待中（仅 custom 模式拦截文本作答；已验证/信任用户不受影响）
  const pendingMode = await getVerifyMode();
  const stillVerified = state.is_verified && state.verified_expiry > now;
  if (pendingMode === 'custom' && state.pending_answer && state.pending_code_expiry > now && !state.is_trusted && !stillVerified) {
    const isText = !!message.text;
    if (isText) {
      const answerGiven = message.text.trim().toLowerCase();
      if (answerGiven === state.pending_answer.trim().toLowerCase()) {
        await setUserState(chatId, {
          is_verified: 1, verified_expiry: now + VERIFY_TTL_SECONDS,
          pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0,
          is_rate_limited: 0, message_count: 0, window_start: 0
        });
        await sendMessage({ chat_id: chatId, text: t('verify.passed'), parse_mode: 'HTML' });
        return new Response('Ok');
      } else {
        const attempts = (state.pending_attempts || 0) + 1;
        await setUserState(chatId, { pending_attempts: attempts });
        if (attempts >= 3) {
          await setUserState(chatId, { pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0 });
          return sendMessage({ chat_id: chatId, text: t('verify.wrong') + '\n' + t('rate.limited') });
        }
        return sendMessage({ chat_id: chatId, text: t('verify.wrong') });
      }
    }
    // 媒体消息在等待答案时不允许
    await sendVerificationChallenge(chatId, message.message_id);
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
  await setUserState(chatId, { message_count: newCount, window_start: newWindow });

  const rateLimited = newCount > MAX_MSG_PER_MIN;
  if (rateLimited && !state.is_rate_limited) {
    await setUserState(chatId, { is_rate_limited: 1, is_verified: 0, verified_expiry: 0 });
    await sendMessage({ chat_id: chatId, text: t('rate.limited') });
  }
  if (rateLimited) {
    return sendVerificationChallenge(chatId, message.message_id);
  }

  // 4. 验证状态判定
  const isTrusted = !!state.is_trusted;
  const isVerified = !isTrusted && state.is_verified && state.verified_expiry > now;
  const securityLevel = await getSecurityLevel();
  const verifyMode = await getVerifyMode();

  let allowed = false;
  const isText = !!message.text;

  if (isTrusted || verifyMode === 'off') {
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
    return sendVerificationChallenge(chatId, message.message_id);
  }

  // 6. 放行 -> 关键词/去重检查（仅文本，trusted 豁免）
  if (message.text && !isTrusted) {
    const keywords = await getKeywords();
    const hit = keywords.some(k => message.text.includes(k));
    if (hit) return new Response('Ok');

    const hash = await sha256(message.text.trim());
    const dup = await DB.prepare('SELECT hash FROM message_hashes WHERE hash = ? AND (expires_at IS NULL OR expires_at > ?)')
      .bind(hash, now).first();
    if (dup) return new Response('Ok');
    await DB.prepare('INSERT OR REPLACE INTO message_hashes (hash, expires_at) VALUES (?, ?)')
      .bind(hash, now + DEDUPE_TTL_SECONDS).run();
  }

  const topicMode = await getTopicModeEnabled();
  let topicId = null;
  let forwardChatId = ADMIN_UID;

  if (topicMode && SUPERGROUP_ID) {
    forwardChatId = SUPERGROUP_ID;
    const row = await DB.prepare('SELECT topic_id FROM chat_topic_mappings WHERE chat_id = ?').bind(String(chatId)).first();
    topicId = row ? row.topic_id : null;

    if (!topicId) {
      let title = `${message.chat.first_name || ''} ${message.chat.last_name || ''}`.trim();
      if (message.chat.username) title += ` (@${message.chat.username})`;
      if (!title) title = `User ${chatId}`;
      if (title.length > 128) title = title.substring(0, 125) + '...';

      const topicRes = await createForumTopic(SUPERGROUP_ID, title);
      if (topicRes.ok) {
        topicId = String(topicRes.result.message_thread_id);
        await DB.prepare('INSERT OR REPLACE INTO chat_topic_mappings (chat_id, topic_id) VALUES (?, ?)')
          .bind(String(chatId), topicId).run();
        await sendFirstCard({ chatId, message, topicMode: true, topicId });
      } else {
        console.error('Create topic failed:', JSON.stringify(topicRes));
        await sendMessage({
          chat_id: SUPERGROUP_ID,
          text: t('topic.create_fail', { uid: chatId, err: topicRes.description || 'Unknown error' }),
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

  const forwardReq = await copyMessage(forwardBody);
  if (forwardReq.ok) {
    const adminMsgId = String(forwardReq.result.message_id);
    await DB.prepare('INSERT OR REPLACE INTO message_mappings (admin_message_id, guest_chat_id, created_at) VALUES (?, ?, ?)')
      .bind(adminMsgId, String(chatId), now).run();

    if (!topicMode && !topicId && !state.first_card_sent) {
      // 私聊模式首次消息 -> 管理员私聊置顶信息卡
      await sendFirstCard({ chatId, message, topicMode: false });
    }
  } else {
    console.error('Forward/Copy message failed:', JSON.stringify(forwardReq));
    await sendMessage({
      chat_id: ADMIN_UID,
      text: t('forward.fail', { uid: chatId, err: forwardReq.description || 'Unknown' }),
      parse_mode: 'HTML'
    });
  }
}

// 首次置顶信息卡：昵称/用户名/UserID/发起时间 + 通知内容；发新卡前自动 unpin 上一张
async function sendFirstCard({ chatId, message, topicMode, topicId = null }) {
  try {
    const state = await getUserState(chatId);
    if (state.first_card_sent) return;

    const targetChat = topicMode ? SUPERGROUP_ID : ADMIN_UID;
    const body = {
      chat_id: targetChat,
      text: t('pin.card', {
        name: escapeHtml(`${message.chat.first_name || ''} ${message.chat.last_name || ''}`.trim() || '—'),
        username: message.chat.username ? '@' + message.chat.username : '—',
        uid: chatId,
        time: new Date().toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US'),
        notice: (await settingGet('config:notification')) || t('notice.default')
      }),
      parse_mode: 'HTML'
    };
    if (topicMode && topicId) body.message_thread_id = parseInt(topicId);

    const res = await sendMessage(body);
    if (res.ok) {
      const msgId = res.result.message_id;
      const pinKey = topicMode ? `pin:topic:${topicId}` : 'pin:private';
      const prev = await settingGet(pinKey);
      if (prev) {
        try { await unpinMessage(targetChat, parseInt(prev)); } catch (e) { /* 旧消息可能已删除 */ }
      }
      await pinMessage(targetChat, msgId);
      await settingSet(pinKey, String(msgId));
      await setUserState(chatId, { first_card_sent: 1 });
    }
  } catch (e) {
    console.error('sendFirstCard error:', e);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------- 验证逻辑 ----------------

async function sendVerificationChallenge(chatId, pendingMsgId) {
  const mode = await getVerifyMode();
  if (mode === 'custom') {
    const q = await settingGet('config:custom_question');
    const a = await settingGet('config:custom_answer');
    if (q && a) {
      const now = Math.floor(Date.now() / 1000);
      await setUserState(chatId, {
        pending_question: q, pending_answer: a,
        pending_code_expiry: now + CODE_TTL_SECONDS, pending_attempts: 0
      });
      return sendMessage({
        chat_id: chatId,
        text: `${t('verify.title')}\n\n${t('verify.custom_text', { q })}`,
        parse_mode: 'HTML',
        reply_to_message_id: pendingMsgId
      });
    }
    // 未配置自定义题目时降级为算术题
    await sendMessage({ chat_id: chatId, text: t('verify.custom_notset') });
  }

  const challenge = generateMathChallenge();
  const options = [
    { text: challenge.correct_answer, isCorrect: true },
    ...challenge.incorrect_answers.map(ans => ({ text: ans, isCorrect: false }))
  ];
  shuffleArray(options);

  const correctIndex = options.findIndex(o => o.isCorrect);
  const now = Math.floor(Date.now() / 1000);
  await setUserState(chatId, {
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

  return sendMessage({
    chat_id: chatId,
    text: `${t('verify.title')}\n\n${t('verify.math_text', { q: challenge.question })}`,
    parse_mode: 'HTML',
    reply_to_message_id: pendingMsgId,
    reply_markup: { inline_keyboard: rows }
  });
}

async function handleCallback(callbackQuery) {
  const data = callbackQuery.data;
  if (!data.startsWith('verify:')) return;

  await loadRuntimeConfig();

  const [_, uidStr, answerIdxStr] = data.split(':');
  const answerIdx = parseInt(answerIdxStr);
  const chatId = callbackQuery.message.chat.id;
  const now = Math.floor(Date.now() / 1000);

  const state = await getUserState(chatId);

  if (!state.pending_answer || state.pending_code_expiry <= now) {
    return answerCallbackQuery(callbackQuery.id, t('verify.expired'), true);
  }

  const correctIdx = parseInt(state.pending_answer);

  if (answerIdx === correctIdx) {
    await setUserState(chatId, {
      is_verified: 1, verified_expiry: now + VERIFY_TTL_SECONDS,
      pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0,
      is_rate_limited: 0, message_count: 0, window_start: 0
    });
    await requestTelegram('editMessageText', makeReqBody({
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: t('verify.passed'),
      parse_mode: 'HTML'
    }));
    return answerCallbackQuery(callbackQuery.id, '✅');
  } else {
    const attempts = (state.pending_attempts || 0) + 1;
    await setUserState(chatId, { pending_attempts: attempts });
    if (attempts >= 3) {
      await setUserState(chatId, { pending_answer: null, pending_question: null, pending_code_expiry: 0, pending_attempts: 0 });
      return answerCallbackQuery(callbackQuery.id, t('verify.wrong'), true);
    }
    return answerCallbackQuery(callbackQuery.id, t('verify.wrong'), true);
  }
}

// ---------------- 指令处理 ----------------

async function getTargetUserId(message) {
  const topicId = message.message_thread_id;
  if (topicId) {
    const row = await DB.prepare('SELECT chat_id FROM chat_topic_mappings WHERE topic_id = ?').bind(String(topicId)).first();
    if (row) return row.chat_id;
  }
  if (message.reply_to_message) {
    const row = await DB.prepare('SELECT guest_chat_id FROM message_mappings WHERE admin_message_id = ?')
      .bind(String(message.reply_to_message.message_id)).first();
    if (row) return row.guest_chat_id;
  }
  return null;
}

async function handleInfoCommand(message) {
  const userId = await getTargetUserId(message);
  if (!userId) {
    return sendMessage({ chat_id: message.chat.id, text: t('target.unknown'), message_thread_id: message.message_thread_id });
  }
  const state = await getUserState(userId);
  const now = Math.floor(Date.now() / 1000);

  let statusText;
  if (state.is_blocked) statusText = t('info.status.blocked');
  else if (state.is_trusted) statusText = t('info.status.trusted');
  else if (state.is_verified && state.verified_expiry > now) statusText = t('info.status.verified');
  else statusText = t('info.status.unverified');
  if (state.is_rate_limited) statusText += ' / ' + t('info.status.limited');

  const text = `${t('info.title')}\nUID: <code>${userId}</code>\nStatus: ${statusText}\nLink: <a href="tg://user?id=${userId}">${t('info.link')}</a>`;
  return sendMessage({ chat_id: message.chat.id, text, parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleTrustCommand(message) {
  const userId = await getTargetUserId(message);
  if (!userId) return sendMessage({ chat_id: message.chat.id, text: t('target.unknown'), message_thread_id: message.message_thread_id });
  await setUserState(userId, { is_trusted: 1, is_blocked: 0, is_verified: 1, verified_expiry: Math.floor(Date.now() / 1000) + VERIFY_TTL_SECONDS });
  return sendMessage({ chat_id: message.chat.id, text: t('trust.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleUntrustCommand(message) {
  const userId = await getTargetUserId(message);
  if (!userId) return sendMessage({ chat_id: message.chat.id, text: t('target.unknown'), message_thread_id: message.message_thread_id });
  await setUserState(userId, { is_trusted: 0 });
  return sendMessage({ chat_id: message.chat.id, text: t('untrust.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleBlockCommand(message) {
  const userId = await getTargetUserId(message);
  if (!userId) return sendMessage({ chat_id: message.chat.id, text: t('target.unknown'), message_thread_id: message.message_thread_id });
  await setUserState(userId, { is_blocked: 1, is_trusted: 0, is_verified: 0, verified_expiry: 0 });
  return sendMessage({ chat_id: message.chat.id, text: t('block.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleUnblockCommand(message) {
  const userId = await getTargetUserId(message);
  if (!userId) return sendMessage({ chat_id: message.chat.id, text: t('target.unknown'), message_thread_id: message.message_thread_id });
  await setUserState(userId, { is_blocked: 0 });
  return sendMessage({ chat_id: message.chat.id, text: t('unblock.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleBlacklistCommand(message) {
  const res = await DB.prepare('SELECT chat_id FROM user_states WHERE is_blocked = 1 ORDER BY chat_id').all();
  if (!res.results.length) {
    return sendMessage({ chat_id: message.chat.id, text: t('blacklist.empty'), message_thread_id: message.message_thread_id });
  }
  const list = res.results.map(r => `<code>${r.chat_id}</code>`).join(', ');
  return sendMessage({
    chat_id: message.chat.id,
    text: `${t('blacklist.title', { n: res.results.length })}\n${list}`,
    parse_mode: 'HTML',
    message_thread_id: message.message_thread_id
  });
}

async function handleClearCommand(message) {
  const text = message.text.trim();
  if (text === '/clear all') {
    await DB.prepare('DELETE FROM message_mappings').run();
    await DB.prepare('DELETE FROM chat_topic_mappings').run();
    await settingDel('pin:private');
    const pins = await DB.prepare("SELECT key FROM settings WHERE key LIKE 'pin:topic:%'").all();
    for (const p of pins.results) await settingDel(p.key);
    return sendMessage({ chat_id: message.chat.id, text: t('clear.all.done'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  const userId = await getTargetUserId(message);
  if (!userId) return sendMessage({ chat_id: message.chat.id, text: t('target.unknown'), message_thread_id: message.message_thread_id });
  await DB.prepare('DELETE FROM message_mappings WHERE guest_chat_id = ?').bind(String(userId)).run();
  await DB.prepare('DELETE FROM chat_topic_mappings WHERE chat_id = ?').bind(String(userId)).run();
  return sendMessage({ chat_id: message.chat.id, text: t('clear.user.done', { uid: userId }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleKeywordCommand(message) {
  const parts = message.text.trim().split(/\s+/);
  const action = (parts[1] || '').toLowerCase();

  if (!action || action === 'list') {
    if (!action) return sendMessage({ chat_id: message.chat.id, text: t('keyword.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    const words = await getKeywords();
    if (!words.length) return sendMessage({ chat_id: message.chat.id, text: t('keyword.list_empty'), message_thread_id: message.message_thread_id });
    return sendMessage({
      chat_id: message.chat.id,
      text: `${t('keyword.list_title', { n: words.length })}\n${words.map(w => `<code>${escapeHtml(w)}</code>`).join('  ')}`,
      parse_mode: 'HTML',
      message_thread_id: message.message_thread_id
    });
  }

  if (action === 'add') {
    const word = parts.slice(2).join(' ');
    if (!word) return sendMessage({ chat_id: message.chat.id, text: t('keyword.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    const exists = await DB.prepare('SELECT word FROM keywords WHERE word = ?').bind(word).first();
    if (exists) return sendMessage({ chat_id: message.chat.id, text: t('keyword.exists', { w: escapeHtml(word) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    await DB.prepare('INSERT INTO keywords (word) VALUES (?)').bind(word).run();
    return sendMessage({ chat_id: message.chat.id, text: t('keyword.added', { w: escapeHtml(word) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  if (action === 'del') {
    const word = parts.slice(2).join(' ');
    if (!word) return sendMessage({ chat_id: message.chat.id, text: t('keyword.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    const res = await DB.prepare('DELETE FROM keywords WHERE word = ?').bind(word).run();
    if (!res.meta.changes) return sendMessage({ chat_id: message.chat.id, text: t('keyword.notfound', { w: escapeHtml(word) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    return sendMessage({ chat_id: message.chat.id, text: t('keyword.deleted', { w: escapeHtml(word) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  if (action === 'reset') {
    await DB.prepare('DELETE FROM keywords').run();
    await ensureKeywordsSeeded();
    return sendMessage({ chat_id: message.chat.id, text: t('keyword.reset'), message_thread_id: message.message_thread_id });
  }

  return sendMessage({ chat_id: message.chat.id, text: t('keyword.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleModeCommand(message) {
  const topicMode = await getTopicModeEnabled();
  const parts = message.text.trim().split(/\s+/);

  if (parts.length === 1) {
    const modeText = topicMode ? t('mode.topic') : t('mode.private');
    return sendMessage({ chat_id: message.chat.id, text: t('mode.usage', { mode: modeText }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }

  const v = parts[1].toLowerCase();
  if (v === 'private') {
    await setTopicModeEnabled(false);
    return sendMessage({ chat_id: message.chat.id, text: t('mode.switched.private'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (v === 'topic') {
    if (!SUPERGROUP_ID) {
      return sendMessage({ chat_id: message.chat.id, text: t('mode.no_sg'), message_thread_id: message.message_thread_id });
    }
    await setTopicModeEnabled(true);
    return sendMessage({ chat_id: message.chat.id, text: t('mode.switched.topic'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  return sendMessage({ chat_id: message.chat.id, text: t('mode.param_err'), message_thread_id: message.message_thread_id });
}

async function handleSecurityCommand(message) {
  const args = message.text.trim().split(/\s+/);
  if (args.length !== 2) {
    const current = await getSecurityLevel();
    return sendMessage({ chat_id: message.chat.id, text: t('security.usage', { lv: current }), message_thread_id: message.message_thread_id });
  }
  const level = parseInt(args[1]);
  if (![1, 2, 3].includes(level)) {
    return sendMessage({ chat_id: message.chat.id, text: t('security.invalid'), message_thread_id: message.message_thread_id });
  }
  await settingSet('config:security_level', level);
  return sendMessage({ chat_id: message.chat.id, text: t('security.set', { name: t('security.name.' + level) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleVerifyCommand(message) {
  const text = message.text.trim();
  const parts = text.split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();

  if (!sub) return sendMessage({ chat_id: message.chat.id, text: t('verify.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });

  if (sub === 'math') {
    await settingSet('config:verify_mode', 'math');
    return sendMessage({ chat_id: message.chat.id, text: t('verify.set.math'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (sub === 'off') {
    await settingSet('config:verify_mode', 'off');
    return sendMessage({ chat_id: message.chat.id, text: t('verify.set.off'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (sub === 'custom') {
    const rest = text.slice(parts[0].length + parts[1].length + 2);
    const sep = rest.indexOf('|');
    if (sep < 0) return sendMessage({ chat_id: message.chat.id, text: t('verify.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    const q = rest.slice(0, sep).trim();
    const a = rest.slice(sep + 1).trim();
    if (!q || !a) return sendMessage({ chat_id: message.chat.id, text: t('verify.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
    await settingSet('config:custom_question', q);
    await settingSet('config:custom_answer', a);
    await settingSet('config:verify_mode', 'custom');
    return sendMessage({ chat_id: message.chat.id, text: t('verify.set.custom', { q: escapeHtml(q) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (sub === 'show') {
    const mode = await getVerifyMode();
    let detail = '';
    if (mode === 'custom') {
      const q = await settingGet('config:custom_question');
      detail = q ? `Q: ${escapeHtml(q)}` : '(未设置)';
    } else if (mode === 'math') {
      detail = t('math.show', { ops: mathCfg.ops, min: mathCfg.min, max: mathCfg.max, count: mathCfg.count });
    }
    return sendMessage({
      chat_id: message.chat.id,
      text: t('verify.show', { mode: t('verify.show.mode.' + mode), detail, limit: MAX_MSG_PER_MIN }),
      parse_mode: 'HTML',
      message_thread_id: message.message_thread_id
    });
  }
  return sendMessage({ chat_id: message.chat.id, text: t('verify.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleMathCommand(message) {
  const parts = message.text.trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();

  if (!sub) return sendMessage({ chat_id: message.chat.id, text: t('math.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });

  if (sub === 'ops') {
    const ops = parts[2];
    if (!ops || !/^[+\-*\/]{1,4}$/.test(ops) || new Set(ops).size !== ops.length) {
      return sendMessage({ chat_id: message.chat.id, text: t('math.err.ops'), message_thread_id: message.message_thread_id });
    }
    await settingSet('config:math_ops', ops);
    await loadRuntimeConfig();
    return sendMessage({ chat_id: message.chat.id, text: t('math.set.ops', { ops: escapeHtml(ops) }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (sub === 'range') {
    const min = parseInt(parts[2]), max = parseInt(parts[3]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max > 99 || min >= max) {
      return sendMessage({ chat_id: message.chat.id, text: t('math.err.range'), message_thread_id: message.message_thread_id });
    }
    await settingSet('config:math_min', min);
    await settingSet('config:math_max', max);
    await loadRuntimeConfig();
    return sendMessage({ chat_id: message.chat.id, text: t('math.set.range', { min, max }), message_thread_id: message.message_thread_id });
  }
  if (sub === 'count') {
    const n = parseInt(parts[2]);
    if (!Number.isFinite(n) || n < 2 || n > 6) {
      return sendMessage({ chat_id: message.chat.id, text: t('math.err.count'), message_thread_id: message.message_thread_id });
    }
    await settingSet('config:math_count', n);
    await loadRuntimeConfig();
    return sendMessage({ chat_id: message.chat.id, text: t('math.set.count', { n }), message_thread_id: message.message_thread_id });
  }
  if (sub === 'show') {
    return sendMessage({
      chat_id: message.chat.id,
      text: t('math.show', { ops: mathCfg.ops, min: mathCfg.min, max: mathCfg.max, count: mathCfg.count }),
      parse_mode: 'HTML',
      message_thread_id: message.message_thread_id
    });
  }
  return sendMessage({ chat_id: message.chat.id, text: t('math.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleLangCommand(message) {
  const parts = message.text.trim().split(/\s+/);
  const v = (parts[1] || '').toLowerCase();
  if (!v) {
    return sendMessage({ chat_id: message.chat.id, text: t('lang.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  if (v !== 'zh' && v !== 'en') {
    return sendMessage({ chat_id: message.chat.id, text: t('lang.invalid'), message_thread_id: message.message_thread_id });
  }
  await settingSet('config:lang', v);
  await loadRuntimeConfig();
  return sendMessage({ chat_id: message.chat.id, text: t('lang.set'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
}

async function handleAdminMenu(message) {
  const sec = await getSecurityLevel();
  const topicMode = await getTopicModeEnabled();
  const modeText = topicMode ? t('mode.topic') : t('mode.private');
  const secText = `${t('security.name.' + sec)} (${sec})`;
  const verifyMode = await getVerifyMode();
  const verifyText = t('verify.show.mode.' + verifyMode);
  const langText = currentLang === 'zh' ? '中文' : 'English';
  return sendMessage({
    chat_id: message.chat.id,
    text: t('menu.admin', { mode: modeText, sec: secText, verify: verifyText, lang: langText }),
    parse_mode: 'HTML',
    message_thread_id: message.message_thread_id
  });
}

async function handleBroadcastCommand(message) {
  if (!message.reply_to_message) {
    return sendMessage({ chat_id: message.chat.id, text: t('broadcast.usage'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
  const broadcastMsg = message.reply_to_message;

  await sendMessage({ chat_id: message.chat.id, text: t('broadcast.start'), parse_mode: 'HTML', message_thread_id: message.message_thread_id });

  let sentCount = 0, failCount = 0;
  try {
    const res = await DB.prepare('SELECT chat_id FROM chat_topic_mappings').all();
    const ids = res.results.map(r => r.chat_id);
    // 兼容私聊模式用户：从消息映射中提取去重
    const maps = await DB.prepare('SELECT DISTINCT guest_chat_id AS chat_id FROM message_mappings').all();
    for (const m of maps.results) {
      if (!ids.includes(m.chat_id)) ids.push(m.chat_id);
    }

    for (const userId of ids) {
      if (String(userId) === String(ADMIN_UID)) continue;
      try {
        await copyMessage({
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

    return sendMessage({ chat_id: message.chat.id, text: t('broadcast.done', { ok: sentCount, fail: failCount }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  } catch (e) {
    return sendMessage({ chat_id: message.chat.id, text: t('broadcast.error', { err: e.message }), parse_mode: 'HTML', message_thread_id: message.message_thread_id });
  }
}

async function registerWebhook(requestUrl, suffix, secret) {
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`;
  const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json();
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}

async function unRegisterWebhook() {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json();
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}
