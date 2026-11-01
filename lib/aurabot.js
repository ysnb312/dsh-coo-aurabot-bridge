/**
 * aurabot 适配层：**只通过它自己提供的服务面**接，不 import 内部文件。
 *
 * 它 `ctx.provide('aurabot', service)`（src/core/bridge.js:90），第三方插件按它
 * 自己的 examples 用 `ctx.get('aurabot')` 取（**不要写进 inject**，因为它是可选依赖）。
 *
 * 拿到的面：
 *   service.on('activity', fn)   收 QQ 消息/回复（kind:'in'|'out'）
 *   service.send({target,text})  发 QQ 消息；target 缺省 = private:<主人QQ>
 *   service.info()               enabled / dryRun / online / owner
 *
 * **开关不在这里判**：aurabot 自己在 hub.deliver → sendSegments 里判
 * `cfg.enabled` / `cfg.dryRun`（hub.js:459 起），桥接层重复实现只会得出两套
 * 不一致的结论。我们只看返回的 message 判断"真发了没有"。
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const AURABOT_DIR = process.env.AURABOT_DATA_DIR || join(DSH_HOME, 'plugins-data', 'aurabot')

/** 读出 auarabot 自己的会话映射，用于**防死循环**的排除集。 */
export function readAurabotSessions() {
  const file = join(AURABOT_DIR, 'sessions.json')
  if (!existsSync(file)) return { ok: false, map: {}, ids: [] }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const chats = raw?.chats && typeof raw.chats === 'object' ? raw.chats : {}
    const ids = Object.values(chats)
      .map((v) => (v && typeof v.sessionId === 'string' ? v.sessionId : ''))
      .filter(Boolean)
    return { ok: true, map: chats, ids }
  } catch (error) {
    return { ok: false, map: {}, ids: [], detail: String(error?.message ?? error) }
  }
}

/** 读 auarabot 的配置（主人 QQ、开关状态）——只读，不写。 */
export function readAurabotConfig() {
  const file = join(AURABOT_DIR, 'config.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) { return null }
}

/**
 * 包一层 `service`，把它可能不在的情况全折成 `{ ok:false, reason }`。
 * 桥接插件在 aurabot 被卸掉时仍然能启动（只是方向 A 失效）。
 */
export function createAurabotBridge(getService, onActivity, log) {
  const service = () => {
    let s = null
    try { s = getService() } catch (error) { s = null }
    return s && typeof s.send === 'function' ? s : null
  }

  let detach = null

  const attach = () => {
    const s = service()
    if (!s) return { ok: false, reason: 'aurabot-not-installed' }
    if (detach) return { ok: true, reason: 'already-attached' }
    if (typeof s.on !== 'function') return { ok: false, reason: 'aurabot-no-event-api' }
    try {
      detach = s.on('activity', (a) => {
        try { onActivity(a) } catch (error) { log?.warn?.('activity 处理出错：' + String(error?.message ?? error)) }
      })
      return { ok: true, reason: 'attached' }
    } catch (error) {
      detach = null
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }

  const detachAll = () => {
    try { detach?.() } catch (error) { /* 取消订阅失败无所谓 */ }
    detach = null
  }

  /** 发一条 QQ 消息。`voice` 为 true 时包 <voice></voice> 让 aurabot 转语音条。 */
  const send = async ({ target, text, voice }) => {
    const s = service()
    if (!s) return { ok: false, reason: 'aurabot-not-installed', sent: false }
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, reason: 'empty', sent: false }
    const payload = voice ? `<voice>${body}</voice>` : body
    try {
      const r = await s.send({ target: target || undefined, text: payload })
      // 返回的 message 三态：「总开关关着，没真发」/「试运行，只进了日志」/「发出去了」
      const message = String(r?.message ?? '')
      const sent = /发出去了|sent/i.test(message) && !/没发|试运行/.test(message)
      return { ok: r?.ok !== false, sent, reason: message || (r?.ok === false ? 'rejected' : 'delivered'), raw: r }
    } catch (error) {
      return { ok: false, sent: false, reason: String(error?.message ?? error) }
    }
  }

  /**
   * 读它的状态。**它自己的 info() 是 async**（bridge.js:39 `info: async () => …`），
   * 早先这里当同步用，拿到的是 Promise 展开后的空对象，enabled/dryRun 全是 null。
   */
  const info = async () => {
    const s = service()
    if (!s) return { available: false }
    try {
      const i = typeof s.info === 'function' ? await s.info() : null
      return { available: true, ...(i && typeof i === 'object' ? i : {}) }
    } catch (error) {
      return { available: true, detail: String(error?.message ?? error) }
    }
  }

  /**
   * 把一句话当作"主人在 QQ 里说的"喂进 aurabot 自己的会话。
   *
   * 这是"只留一个脑子"的关键：不再另开一个桌宠会话，而是直接推给 QQ 会话，
   * 于是那一轮的回复由 hub 自己 `deliver` 到 QQ（hub.js:498 onSessionEvent →
   * turn/end completed），桌宠那边靠全局 session/event 钩子显示对话栈，不会再出现
   * 两个 AI 同时回答。
   *
   * 走 `service.hub.pushToSession(chat, content, senderId, opts)`（hub.js:1004）：
   * 它内部会 hooks.prompt → agentFor(chat) → agent.followup/steer。
   */
  const injectToChat = async ({ chatId, text, senderId, steer = false, queryText }) => {
    const s = service()
    if (!s) return { ok: false, reason: 'aurabot-not-installed' }
    const hub = s.hub
    if (!hub || typeof hub.pushToSession !== 'function') {
      return { ok: false, reason: 'aurabot-no-hub', detail: '这个版本的 aurabot 没对外开 hub' }
    }
    const id = String(chatId || '').trim()
    if (!id) return { ok: false, reason: 'no-chat' }
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, reason: 'empty-text' }

    // chatId 形如 private:10001 / group:123456
    const [kind, ...rest] = id.split(':')
    const key = rest.join(':')
    const chat = kind === 'group'
      ? { chatId: id, kind: 'group', groupId: key }
      : { chatId: id, kind: 'private', userId: key }

    try {
      await hub.pushToSession(chat, [{ type: 'text', text: body }], senderId || undefined, {
        queryText: queryText ?? body,
        steer
      })
      return { ok: true, via: 'aurabot-session', chatId: id }
    } catch (error) {
      return { ok: false, reason: 'push-failed', detail: String(error?.message ?? error) }
    }
  }

  return { attach, detach: detachAll, send, info, injectToChat, available: () => service() !== null }
}
