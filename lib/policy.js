/**
 * 过滤链：**所有"要不要桥"的判断集中在这里**，别散到调用点。
 *
 * 三条硬约束（用户明确要求，不允许被配置绕过）：
 *   1. 首次安装不发任何 QQ 消息 —— aToQ.enabled 默认 false。
 *   2. 方向 B 只桥主人私聊 —— 群聊永不进桌宠。
 *   3. 防死循环 —— auarabot 自己的会话（QQ·主人私聊 / QQ·空间日记）永远排除，
 *      否则 QQ → 桌宠 → 回 QQ → 又进桌宠 会无限打乒乓。
 */

/** 系统/机械消息的痕迹：这些进桌宠会让它自问自答。 */
const SYSTEM_MARKERS = [
  /^\[语音[·・]/,
  /^（回答桌宠的提问/,
  /^【系统/,
  /^\[system\]/i,
  /^\[coo-aurabot-bridge\]/
]

/** 去掉 markdown 记号（她有时会带 ** / ` / 列表符号出来）。 */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')       // 代码块
    .replace(/`([^`]+)`/g, '$1')           // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // 粗体
    .replace(/\*([^*]+)\*/g, '$1')         // 斜体
    .replace(/^#{1,6}\s+/gm, '')           // 标题号
    .replace(/^[-*+]\s+/gm, '')            // 列表符号
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 链接
    .replace(/<voice>|<\/voice>/gi, '')    // 万一上游已经包过
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 是不是系统消息。 */
export const isSystemText = (text) => {
  const t = String(text ?? '').trim()
  if (!t) return true
  return SYSTEM_MARKERS.some((re) => re.test(t))
}

/**
 * 建一个状态化的过滤器。
 *
 * `sessions()` 返回 `{ ids: [...] }`（aurabot 自己的会话，动态读，不写死）。
 */
export function createPolicy(cfgGetter, sessions, log) {
  let lastText = ''
  let lastAt = 0
  /** 注入过之后这段时间内不再转发回复。 */
  let suppressUntil = 0
  /** 语音输入用过的会话：运行时自动绑定，用于方向 A 的会话白名单。 */
  const boundSessions = new Set()

  /** 方向 B 入口：QQ → 桌宠。返回 { pass, reason, text, chatId }。 */
  const admitFromQQ = (a) => {
    const cfg = cfgGetter()
    if (!cfg.q2p.enabled) return { pass: false, reason: 'q2p-disabled' }
    if (!a || typeof a !== 'object') return { pass: false, reason: 'bad-payload' }
    if (a.kind !== 'in') return { pass: false, reason: 'not-inbound' }

    const chatId = String(a.chatId ?? '')
    if (!chatId) return { pass: false, reason: 'no-chat' }

    // 硬约束 2：群聊一律不桥
    const isGroup = chatId.startsWith('group:')
    if (isGroup && !cfg.q2p.allowGroups) return { pass: false, reason: 'group-not-allowed' }

    // 硬约束 2：只认主人
    if (cfg.q2p.ownerOnly && a.owner !== true) return { pass: false, reason: 'not-owner' }

    if (a.direct === false && !cfg.q2p.allowGroups) return { pass: false, reason: 'not-direct' }

    const text = String(a.text ?? '').trim()
    if (!text) return { pass: false, reason: 'empty' }
    if (text.length > cfg.q2p.maxChars) {
      return { pass: true, reason: 'truncated', text: text.slice(0, cfg.q2p.maxChars) + '…', chatId }
    }
    if (isSystemText(text)) return { pass: false, reason: 'system-text' }

    // 自己刚发出去的话又回来了（不太可能，但挡住更安全）
    if (Date.now() - lastAt < cfg.minIntervalMs && text === lastText) {
      return { pass: false, reason: 'duplicate' }
    }

    return { pass: true, reason: 'ok', text, chatId }
  }

  /** 方向 A 入口：桌宠回复 → QQ。返回 { pass, reason, text }。 */
  const admitToQQ = (sessionId, text) => {
    const cfg = cfgGetter()
    if (!cfg.aToQ.enabled) return { pass: false, reason: 'a2q-disabled' }   // 硬约束 1

    const sid = String(sessionId ?? '')
    if (!sid) return { pass: false, reason: 'no-session' }

    // 硬约束 3：aurabot 自己的会话永远排除
    const excluded = sessions().ids
    if (excluded.includes(sid)) return { pass: false, reason: 'excluded-session' }

    // 会话白名单：配置显式列出的 + 语音输入自动绑定的
    const configured = cfg.aToQ.sessionIds
    const auto = cfg.aToQ.autoBindVoice && boundSessions.has(sid)
    const inList = configured.length === 0 ? auto : configured.includes(sid)
    if (!inList) return { pass: false, reason: 'session-not-allowed' }

    // 刚从 QQ 注入过来的那一轮，别又原样回给 QQ
    if (Date.now() < suppressUntil) return { pass: false, reason: 'suppressed' }

    let body = String(text ?? '').trim()
    if (!body) return { pass: false, reason: 'empty' }
    if (cfg.aToQ.stripMarkdown) body = stripMarkdown(body)
    if (!body) return { pass: false, reason: 'empty-after-strip' }
    if (isSystemText(body)) return { pass: false, reason: 'system-text' }

    if (body.length > 2000) body = body.slice(0, 2000) + '…'

    return { pass: true, reason: 'ok', text: body }
  }

  /** 记一笔"某会话是语音输入来的"，供方向 A 的白名单用。 */
  const bindSession = (sessionId) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return
    if (boundSessions.size > 50) boundSessions.clear()   // 别无限长
    boundSessions.add(sid)
  }

  /** 注入之后调用：这段时间内压制回复转发。 */
  const noteInjected = (text) => {
    const cfg = cfgGetter()
    lastText = String(text ?? '')
    lastAt = Date.now()
    suppressUntil = Date.now() + Math.max(0, Number(cfg.suppressReplyMs) || 0)
  }

  const state = () => ({
    boundSessions: Array.from(boundSessions),
    suppressedForMs: Math.max(0, suppressUntil - Date.now()),
    lastTextAt: lastAt
  })

  return { admitFromQQ, admitToQQ, bindSession, noteInjected, state }
}
