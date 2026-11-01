/**
 * dsh-coo-aurabot-bridge · 宿主半边
 *
 * 把**桌宠**（dsh-coopanion-pet）与 **QQ**（dsh-aurabot-qq）双向桥接，并给
 * Python 语音脚本开一个本地输入口。三件事：
 *
 *   1. 方向 A（桌宠 → QQ）
 *      `ctx.on('session/event')` 听 `assistant/message` → 过滤链 → aurabot.send()
 *      （这是**唯一**能拿到桌宠回复的办法：coopanion 不 provide 也不 emit）
 *
 *   2. 方向 B（QQ → 桌宠）
 *      `ctx.get('aurabot').on('activity')` 听 QQ 进来的消息 → 过滤链
 *      → HTTP POST 到 coopanion 自己的路由（等价"主人说了一句话"）
 *
 *   3. 语音输入口
 *      Python 脚本听到唤醒词后把文字 POST 到 /voice-input，走同一条方向 B 链路
 *
 * 三个硬约束（写在 policy.js 里，不散落）：
 *   - aToQ.enabled 默认 false：**装好不发任何 QQ 消息**，必须手动开
 *   - 群聊永不桥进桌宠
 *   - aurabot 自己的会话（QQ·主人私聊等）永远排除，防来回打乒乓
 *
 * 不改 dsh-coopanion-pet 一行源码，也不 import 它或 aurabot 的内部文件。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { createConfigStore, CONFIG_PATH, ENDPOINT_PATH, LOG_PATH, VERSION } from './config.js'
import { createLogger } from './log.js'
import * as coop from './coopanion.js'
import { createAurabotBridge, readAurabotSessions, readAurabotConfig } from './aurabot.js'
import { createPolicy, stripMarkdown } from './policy.js'
import { compileKeywords, normalizeWords, wakeStatus } from './wakewords.js'
import { TTS_ROUTE, synthesize, ttsStatus, forget as forgetTts } from './tts.js'
import { createListenSupervisor } from './listen.js'

const NAME = 'dsh-coo-aurabot-bridge'
/** 路由根：coopanion 的独立窗口桥接刻意不在 /api 下（无 cookie 会被鉴权拦），这里也备一份。 */
const ROUTE_API = '/api/dsh-coo-aurabot-bridge'
const ROUTE_ROOT = '/coo-aurabot-bridge'

export const name = 'coo-aurabot-bridge'
/** aurabot 是**可选**依赖，绝不能写进 inject（它自己的 examples 也这么说）。 */
export const inject = ['webServer']

/** 从消息内容里取纯文本（丢掉工具调用等非文本块），与 coopanion 的 textOf 同规则。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  if (typeof content === 'string') return content.trim()
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 读请求体（JSON），上限 256KB。 */
function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { resolve(null); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (error) { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

export function apply(ctx) {
  const store = createConfigStore(ctx.logger)
  const cfg = store.load()
  if (store.dirty) store.save()

  const log = createLogger(LOG_PATH, ctx.logger, cfg.logMaxLines)
  log.info(`启动；配置 ${CONFIG_PATH}`)

  /** 动态读 aurabot 的会话映射（它随时可能新建会话，不能缓存一次性）。 */
  const sessions = () => {
    const r = readAurabotSessions()
    if (!r.ok && r.detail) log.warn('读 aurabot sessions.json 失败：' + r.detail)
    return r
  }

  const policy = createPolicy(() => cfg, sessions, log)

  /** 耳朵（Python 语音脚本）的托管器：负责拉起/看护/带走子进程。 */
  const ear = createListenSupervisor(() => cfg, log)

  /**
   * 闸门变了让她自己说一句——用户得知道"她不是坏了，是故意不听了"。
   * 只出气泡（sayText 走 say 命令，不触发 LLM），且暂停期间只说一次。
   */
  ear.onGate((g) => {
    const text = g.state === 'paused'
      ? (g.reason.includes('锁屏') ? '锁屏了，我先不听了' : '我先不听了，点点我就回来')
      : g.state === 'listening' ? '我又在听啦' : ''
    if (!text) return
    void coop.sayText(base(), text).then((r) => {
      if (!r.ok) log.info(`（气泡没弹出来：${r.detail}）`)
    })
  })

  let getWebServer = () => null
  const base = () => coop.resolveBase(getWebServer(), cfg)

  // 先把 aurabot 那层建出来：下面 session/event 的回调会用到它
  let au = null

  /* ---------------- 念白：我的回复 → 桌宠朗读 ---------------- */

  let lastSpokenAt = 0
  let lastSpokenText = ''
  /** 每个会话最后一条 assistant 文本，等 turn/end 再念（避免念碎片）。 */
  const pendingSpeech = new Map()

  /** 主人私聊对应的 aurabot 会话 id（她只念这个会话的回复）。 */
  const ownerSessionIds = () => {
    const map = sessions().map || {}
    const out = new Set()
    for (const [k, v] of Object.entries(map)) {
      if (!k.startsWith('private:')) continue
      // chats 的值是 { sessionId, preset, level, title, model } 这种对象
      const id = v && typeof v === 'object' ? v.sessionId : v
      if (id) out.add(String(id))
    }
    return out
  }

  /**
   * 把我的回复送进她嘴里。
   *
   * 独立于 aToQ：那条是"把回复再发一遍到 QQ"（单脑模式下关着），
   * 这条只是"让电脑上那个小鲸鱼把同一句话念出来"，不影响 QQ 收到什么。
   */
  const maybeSpeak = (sid, raw) => {
    if (!cfg.speak.enabled) return
    if (cfg.speak.ownerOnly && !ownerSessionIds().has(sid)) return
    let text = String(raw ?? '').trim()
    if (!text) return
    if (cfg.speak.stripMarkdown) text = stripMarkdown(text)
    text = text.replace(/\s+/g, ' ').trim()
    if (cfg.speak.requireChinese && !/[\u4e00-\u9fa5]/.test(text)) return
    if (text.length > cfg.speak.maxChars) text = text.slice(0, cfg.speak.maxChars)
    if (text === lastSpokenText && Date.now() - lastSpokenAt < 4000) return
    const gap = Date.now() - lastSpokenAt
    if (gap < cfg.speak.minIntervalMs) return
    lastSpokenAt = Date.now()
    lastSpokenText = text
    void coop.speakText(base(), text, cfg.speak.timeoutMs).then((r) => {
      log.info(`念白(${r.ok ? 'ok' : r.detail}) ${text.slice(0, 30)}`)
    })
  }

  /* ---------------- 方向 A：桌宠 → QQ ---------------- */

  // 第一次见到某种事件类型时记一笔，用来确认钩子真的接上了（最多 8 种）
  const seenTypes = new Set()

  ctx.on('session/event', (session, ev) => {
    try {
      if (ev?.type && !seenTypes.has(ev.type) && seenTypes.size < 8) {
        seenTypes.add(ev.type)
        log.info(`session/event 钩子已接通：收到 "${ev.type}"（累计 ${seenTypes.size} 种）`)
      }
      if (ev?.type === 'turn/end') {
        // 一轮结束才念：assistant/message 是流式的，逐个念会念成碎片
        const sid0 = session && session.id ? String(session.id) : ''
        const buffered = pendingSpeech.get(sid0)
        if (buffered) {
          pendingSpeech.delete(sid0)
          maybeSpeak(sid0, buffered)
        }
        return
      }
      if (ev?.type !== 'assistant/message') return
      const sid = session && session.id ? String(session.id) : ''
      const text = textOf(ev?.data?.message?.content)
      if (!text) return
      if (pendingSpeech.size > 32) pendingSpeech.clear()
      pendingSpeech.set(sid, text)

      const verdict = policy.admitToQQ(sid, text)
      if (!verdict.pass) {
        // 默认（a2q-disabled / session-not-allowed）太吵，只在调试级别记
        if (verdict.reason !== 'a2q-disabled' && verdict.reason !== 'session-not-allowed') {
          log.info(`方向A 丢弃(${verdict.reason}) sid=${sid.slice(0, 20)}`)
        }
        return
      }

      const asVoice = cfg.aToQ.asVoice && verdict.text.length <= cfg.aToQ.voiceMaxChars
      void (async () => {
        const r = await au.send({ target: cfg.aToQ.target, text: verdict.text, voice: asVoice })
        log.info(`方向A → QQ ${asVoice ? '语音' : '文字'} ${r.sent ? '已发' : '未发(' + r.reason + ')'} ${verdict.text.slice(0, 40)}`)
      })()
    } catch (error) {
      log.error('方向A 出错：' + String(error?.message ?? error))
    }
  })

  /* ---------------- 方向 B：QQ → 桌宠 ---------------- */

  /** 主人私聊对应的 chatId：config 里写死的优先，否则从 aurabot 的会话映射里猜。 */
  const ownerChatId = () => {
    if (cfg.voiceInput.voiceTarget) return String(cfg.voiceInput.voiceTarget)
    const map = sessions().map || {}
    const key = Object.keys(map).find((k) => k.startsWith('private:'))
    if (key) return key
    // 兜底：aurabot 自己的配置里有主人 QQ
    const ac = readAurabotConfig()
    const owner = ac && ac.ownerQQ ? String(ac.ownerQQ) : ''
    return owner ? `private:${owner}` : ''
  }

  /** 单脑模式：语音输入直接喂进 QQ 会话，回复由 aurabot 自己发出去。 */
  const injectToOwnerChat = async (text, why) => {
    const chatId = ownerChatId()
    if (!chatId) return { ok: false, reason: 'no-chat', via: 'aurabot-session' }
    const senderId = chatId.includes(':') ? chatId.split(':').slice(1).join(':') : ''
    const r = await au.injectToChat({ chatId, text, senderId })
    if (r.ok) {
      // 这句话是自己喂进去的，别又把它的回复当成"桌宠说的"再发一遍到 QQ
      policy.noteInjected(text)
      log.info(`语音→QQ会话(${why}) ${text.slice(0, 40)}`)
    } else {
      log.warn(`语音→QQ会话失败(${why}/${r.reason})：${r.detail ?? ''}`)
    }
    return r
  }

  const injectToPet = async (text, why) => {
    const b = base()
    const r = await coop.injectText(b, text, { deliver: cfg.voiceInput.deliver, sessionId: cfg.voiceInput.sessionId })
    if (r.ok) {
      policy.noteInjected(text)
      log.info(`注入桌宠成功(${why}/${r.via}) ${text.slice(0, 40)}`)
    } else {
      log.warn(`注入桌宠失败(${why}/${r.via})：${r.detail}`)
    }
    return r
  }

  /** 按 voiceRoute 决定语音输入往哪投。 */
  const routeVoice = async (text, why) => {
    if (cfg.voiceInput.voiceRoute === 'pet') return injectToPet(text, why)
    return injectToOwnerChat(text, why)
  }

  const onActivity = (a) => {
    const verdict = policy.admitFromQQ(a)
    if (!verdict.pass) {
      if (verdict.reason !== 'q2p-disabled' && verdict.reason !== 'not-inbound') {
        log.info(`方向B 丢弃(${verdict.reason}) chat=${a?.chatId ?? '?'}`)
      }
      return
    }
    if (cfg.q2p.mode === 'say') {
      void coop.sayText(base(), verdict.text).then((r) => log.info(`方向B 只念(${r.ok ? 'ok' : r.detail})`))
      return
    }
    // 单脑模式：这句话本来就已经进了 QQ 会话并会由它自己回答，再注入一次就是两个 AI
    if (cfg.voiceInput.voiceRoute !== 'pet') {
      log.info(`方向B 跳过(单脑模式，QQ 会话自己答) chat=${a?.chatId ?? '?'}`)
      return
    }
    void injectToPet(verdict.text, 'qq')
  }

  au = createAurabotBridge(() => ctx.get('aurabot'), onActivity, log)
  /* ---------------- 语音输入口 ---------------- */

  const handleVoiceInput = async (req, res) => {
    const body = await readJson(req)
    if (!body) return sendJson(res, 400, { ok: false, reason: 'bad-json' })

    if (!cfg.voiceInput.enabled) return sendJson(res, 403, { ok: false, reason: 'voice-input-disabled' })

    // 令牌校验：脚本从 endpoint.json 读，同机的其他程序不该能随便开口
    const token = String(body.token ?? req.headers['x-bridge-token'] ?? '')
    if (cfg.voiceInput.token && token !== cfg.voiceInput.token) {
      return sendJson(res, 401, { ok: false, reason: 'bad-token' })
    }

    // 唤醒应答：只有唤醒、没有正文 —— 只让她说一句「我在」，不触发 LLM
    if (body.wake === true && body.text == null) {
      const r = cfg.voiceInput.wakeWordEcho
        ? await coop.sayText(base(), String(body.echo ?? '我在').slice(0, 40))
        : { ok: true, detail: 'echo-disabled' }
      return sendJson(res, 200, { ok: r.ok, via: 'wake-echo', detail: r.detail })
    }

    const text = String(body.text ?? '').trim().slice(0, cfg.voiceInput.maxChars)
    if (!text) return sendJson(res, 400, { ok: false, reason: 'empty-text' })

    // 记下这次是语音来的会话（方向 A 白名单靠它）
    if (body.sessionId) policy.bindSession(body.sessionId)

    const r = await routeVoice(text, 'voice')
    return sendJson(res, r.ok ? 200 : 502, {
      ok: r.ok,
      via: r.via,
      route: cfg.voiceInput.voiceRoute,
      detail: r.detail,
      chatId: r.chatId ?? null,
      sessionId: cfg.voiceInput.sessionId || null
    })
  }

  /* ---------------- 诊断与测试 ---------------- */

  const handleStatus = async (_req, res) => {
    const sessionsInfo = sessions()
    const auInfo = await au.info()
    return sendJson(res, 200, {
      ok: true,
      name: NAME,
      version: VERSION,
      baseUrl: base(),
      aurabot: {
        available: au.available(),
        enabled: auInfo.enabled ?? null,
        dryRun: auInfo.dryRun ?? null,
        online: auInfo.online ?? null,
        ownSessions: sessionsInfo.ids.length,
        // 主人私聊那一条对应的会话：合并成"一个脑子"时要指向它
        ownerSessionId: (() => {
          const map = sessionsInfo.map || {}
          const key = Object.keys(map).find((k) => k.startsWith('private:'))
          return key && map[key]?.sessionId ? String(map[key].sessionId) : ''
        })(),
        ownerChatKey: (() => {
          const map = sessionsInfo.map || {}
          return Object.keys(map).find((k) => k.startsWith('private:')) || ''
        })(),
        chats: Object.keys(sessionsInfo.map || {}),
        // 单脑模式靠 service.hub.pushToSession 把话喂进 QQ 会话；这条只做能力探测，不真发
        canInject: (() => {
          try {
            const s = ctx.get('aurabot')
            return !!(s && s.hub && typeof s.hub.pushToSession === 'function')
          } catch (error) {
            return false
          }
        })()
      },
      // 侧栏的全量开关都渲染自这一份，所以必须带上
      config: cfg,
      gates: {
        aToQ: cfg.aToQ.enabled,
        q2p: cfg.q2p.enabled,
        voiceInput: cfg.voiceInput.enabled,
        tts: cfg.tts.enabled,
        listen: cfg.listen.enabled,
        speak: cfg.speak.enabled
      },
      tts: ttsStatus(cfg),
      speak: {
        enabled: cfg.speak.enabled,
        ownerOnly: cfg.speak.ownerOnly,
        maxChars: cfg.speak.maxChars,
        stripMarkdown: cfg.speak.stripMarkdown,
        requireChinese: cfg.speak.requireChinese,
        minIntervalMs: cfg.speak.minIntervalMs,
        lastAt: lastSpokenAt || null,
        lastText: lastSpokenText || '',
        endpoint: '/api/dsh-coopanion-pet/speak-test'
      },
      listen: ear.status(),
      policy: policy.state(),
      coopanion: await coop.listSessions(base()),
      speech: await coop.speechCapability(base()),
      // 唤醒词摘要（不含产物全文，/status 要轻）
      wake: (() => {
        const w = wakeStatus(cfg)
        return {
          enabled: w.enabled,
          words: w.words,
          genScript: w.genScript,
          genScriptError: w.genScriptError,
          compiled: {
            exists: w.compiled.exists,
            file: w.compiled.file,
            count: w.compiled.count ?? 0,
            hasBom: w.compiled.hasBom ?? false,
            modifiedAt: w.compiled.modifiedAt ?? null,
            error: w.compiled.error ?? null
          }
        }
      })()
    })
  }

  /** 模拟桌宠说话：直接喂给方向 A 的过滤链与发送逻辑（不开 QQ 也能验过滤）。 */
  const handleSimulatePet = async (req, res) => {
    const body = await readJson(req)
    if (!body) return sendJson(res, 400, { ok: false, reason: 'bad-json' })
    const sid = String(body.sessionId ?? cfg.voiceInput.sessionId ?? '')
    const text = String(body.text ?? '')
    if (!text) return sendJson(res, 400, { ok: false, reason: 'empty-text' })
    const verdict = policy.admitToQQ(sid, text)
    if (!verdict.pass) {
      return sendJson(res, 200, { ok: false, stage: 'policy', reason: verdict.reason })
    }
    const asVoice = cfg.aToQ.asVoice && verdict.text.length <= cfg.aToQ.voiceMaxChars
    if (body.dry === true) {
      return sendJson(res, 200, { ok: true, stage: 'policy', wouldSend: verdict.text, asVoice })
    }
    const r = await au.send({ target: cfg.aToQ.target, text: verdict.text, voice: asVoice })
    return sendJson(res, 200, { ok: r.sent, stage: 'send', sent: r.sent, reason: r.reason, asVoice })
  }

  /** 模拟 QQ 来消息：不碰真 QQ，直接走方向 B 全链路。 */
  const handleSimulateQQ = async (req, res) => {
    const body = await readJson(req)
    if (!body) return sendJson(res, 400, { ok: false, reason: 'bad-json' })
    const text = String(body.text ?? '')
    if (!text) return sendJson(res, 400, { ok: false, reason: 'empty-text' })
    const payload = {
      kind: 'in',
      chatId: String(body.chatId ?? 'private:3358492095'),
      userId: String(body.userId ?? '3358492095'),
      nickname: String(body.nickname ?? '主人'),
      text,
      direct: body.direct !== false,
      owner: body.owner !== false
    }
    const verdict = policy.admitFromQQ(payload)
    if (!verdict.pass) return sendJson(res, 200, { ok: false, stage: 'policy', reason: verdict.reason })
    const r = await injectToPet(verdict.text, 'simulate')
    return sendJson(res, r.ok ? 200 : 502, { ok: r.ok, stage: 'inject', via: r.via, detail: r.detail })
  }

  /* ---------------- 语音合成（让桌宠真的出声） ---------------- */

  /**
   * 桌宠要的那条路由：`POST /plugins/xiaomi-mimo-tts/synthesize`
   * 请求体 `{ text, format?, voice? }`，成功回音频字节。
   *
   * 这条路径不挂在本插件自己的前缀下，因为桌宠的 lib/optional.js:106 写死了它。
   * 我们按它的公开契约实现一遍，等于**冒充 dsh-xiaomi-tts**，但不用装它。
   */
  const handleSynthesize = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    const body = await readJson(req, 64 * 1024)
    const text = typeof body?.text === 'string' ? body.text : ''
    if (!text.trim()) return sendJson(res, 400, { ok: false, reason: 'no-text' })

    const r = await synthesize(text, cfg, log)
    if (!r.ok) {
      // 桌宠只看 res.ok：非 2xx 就是"这次没合成出来"，它只会安静地不出声
      const code = r.reason === 'too-long' ? 413 : r.reason === 'tts-disabled' ? 501 : 502
      return sendJson(res, code, { ok: false, reason: r.reason, message: r.detail || '' })
    }
    res.writeHead(200, {
      'Content-Type': r.type,
      'Content-Length': String(r.audio.length),
      'Cache-Control': 'no-store',
      'X-Tts-Ms': String(r.ms),
      'X-Tts-Cached': r.cached ? '1' : '0'
    })
    res.end(r.audio)
  }

  /** 侧栏试听：GET 看状态，POST 直接回音频（浏览器里 new Audio 就能放）。 */
  const handleTts = async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendJson(res, 200, { ok: true, ...ttsStatus(cfg) })
    }
    const body = await readJson(req, 64 * 1024)
    const text = typeof body?.text === 'string' ? body.text : ''
    if (!text.trim()) return sendJson(res, 400, { ok: false, reason: 'no-text' })
    const r = await synthesize(text, cfg, log)
    if (!r.ok) return sendJson(res, 502, { ok: false, reason: r.reason, message: r.detail || '' })
    res.writeHead(200, { 'Content-Type': r.type, 'Content-Length': String(r.audio.length), 'Cache-Control': 'no-store' })
    res.end(r.audio)
  }

  /* ---------------- 耳朵（语音唤醒） ---------------- */

  /**
   * GET  看状态：pid、运行多久、最近一行输出、闸门状态、热键
   * POST `{ action: 'start'|'stop'|'restart' }` 手动控制；不带 action 就只回状态
   *
   * 常用入口是侧栏那个开关。这里也留一条路由，方便命令行/脚本直接调。
   */
  const handleListen = async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendJson(res, 200, { ok: true, ...ear.status() })
    }
    const body = await readJson(req)
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, reason: 'bad-json' })
    const action = String(body.action || '').trim()
    if (!action) return sendJson(res, 200, { ok: true, ...ear.status() })

    if (action === 'start') {
      if (!cfg.listen.enabled) {
        return sendJson(res, 400, {
          ok: false,
          reason: 'listen-disabled',
          message: '耳朵总开关是关的，先在侧栏打开「耳朵」'
        })
      }
      const r = await ear.start('api')
      return sendJson(res, r.ok ? 200 : 502, { ...r, ...ear.status() })
    }
    if (action === 'stop') {
      ear.stop()
      return sendJson(res, 200, { ok: true, ...ear.status() })
    }
    if (action === 'restart') {
      const r = await ear.restart()
      return sendJson(res, r.ok ? 200 : 502, { ...r, ...ear.status() })
    }
    return sendJson(res, 400, { ok: false, reason: 'unknown-action' })
  }

  /**
   * 念白：GET 看状态；POST `{ text }` 让桌宠把这段念出来（侧栏试听、外部脚本用）。
   */
  const handleSpeak = async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendJson(res, 200, {
        ok: true,
        enabled: cfg.speak.enabled,
        ownerOnly: cfg.speak.ownerOnly,
        maxChars: cfg.speak.maxChars,
        lastAt: lastSpokenAt || null,
        lastText: lastSpokenText || ''
      })
    }
    const body = await readJson(req, 64 * 1024)
    const text = String(body?.text ?? '').trim()
    if (!text) return sendJson(res, 400, { ok: false, reason: 'no-text' })
    const r = await coop.speakText(base(), text.slice(0, cfg.speak.maxChars), cfg.speak.timeoutMs)
    return sendJson(res, r.ok ? 200 : 502, r)
  }

  /** 读写配置：GET 全量，POST 局部覆盖（深合并）。 */
  const handleConfig = async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return sendJson(res, 200, { ok: true, config: cfg })
    const body = await readJson(req)
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, reason: 'bad-json' })
    store.set(body)
    store.save()
    // 声音/语速/引擎改了就丢掉合成缓存，否则试听听到的还是旧声音
    if (body && typeof body === 'object' && body.tts !== undefined) forgetTts()

    // 耳朵：开关一变就跟着拉起/停掉（改闸门参数不用重启，Python 侧 1 秒内自己读）
    if (body?.listen && typeof body.listen === 'object') {
      if (cfg.listen.enabled && !ear.status().running) {
        void ear.start('config').then((r) => {
          if (!r.ok) log.warn('按配置拉起耳朵失败：' + r.reason)
        })
      } else if (!cfg.listen.enabled && ear.status().running) {
        ear.stop()
        log.info('耳朵总开关关了，已停掉（麦克风已松开）')
      }
    }

    log.info('配置已更新：' + JSON.stringify(body).slice(0, 200))
    return sendJson(res, 200, { ok: true, config: cfg })
  }

  /* ---------------- 唤醒词（侧栏 ↔ Python） ---------------- */

  /**
   * GET  看状态：当前词表 + 编译产物（行数、路径、有没有 BOM）
   * POST 存词并**立即编译**：侧栏「保存」后不用重启 Python，主循环会自己发现
   *      config.json 变了并重建 KeywordSpotter（见 voice_assistant.py 的热加载）。
   */
  const handleWakewords = async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendJson(res, 200, { ok: true, ...wakeStatus(cfg) })
    }

    const body = await readJson(req)
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, reason: 'bad-json' })

    let dropped = []
    if (body.words !== undefined) {
      const norm = normalizeWords(body.words, cfg)
      dropped = norm.dropped
      // 空词表不允许保存：那等于把耳朵关了又没关，用户会以为坏了
      if (norm.words.length === 0) {
        return sendJson(res, 400, {
          ok: false,
          reason: 'empty-words',
          message: '至少要留一个唤醒词',
          dropped
        })
      }
      cfg.wake.words = norm.words
    }
    if (body.enabled !== undefined) cfg.wake.enabled = body.enabled === true
    if (body.autoGenerate !== undefined) cfg.wake.autoGenerate = body.autoGenerate === true
    if (typeof body.genScript === 'string') cfg.wake.genScript = body.genScript.trim()
    if (typeof body.pythonPath === 'string') cfg.wake.pythonPath = body.pythonPath.trim()
    store.save()
    log.info(`唤醒词已更新：${cfg.wake.words.join('、')}（启用=${cfg.wake.enabled}）`)

    // 只改开关不必重编译，省一次 20s 的子进程；显式 regenerate 或缺产物时才编
    const wantCompile = cfg.wake.enabled && (body.regenerate === true || body.words !== undefined)
    let compiled = null
    if (wantCompile) {
      compiled = await compileKeywords(cfg, log)
    }

    return sendJson(res, 200, {
      ok: true,
      ...wakeStatus(cfg),
      dropped,
      compiled
    })
  }

  /* ---------------- 挂路由 + 落 endpoint.json ---------------- */

  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer')
    getWebServer = () => webServer

    const port = typeof webServer?.port === 'number' ? webServer.port : 0
    // Python 脚本靠这个文件发现端口与令牌
    try {
      mkdirSync(dirname(ENDPOINT_PATH), { recursive: true })
      writeFileSync(ENDPOINT_PATH, JSON.stringify({
        ok: true,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        url: `http://127.0.0.1:${port}${ROUTE_API}/voice-input`,
        token: cfg.voiceInput.token,
        updatedAt: Date.now()
      }, null, 2) + '\n', 'utf8')
      log.info(`endpoint.json 已写入（端口 ${port}）`)
    } catch (error) {
      log.warn('写 endpoint.json 失败：' + String(error?.message ?? error))
    }

    const routes = [
      ['/voice-input', 'POST', handleVoiceInput],
      ['/wakewords', 'ANY', handleWakewords],
      ['/status', 'GET', handleStatus],
      ['/config', 'ANY', handleConfig],
      ['/simulate-pet', 'POST', handleSimulatePet],
      ['/simulate-qq', 'POST', handleSimulateQQ],
      ['/tts', 'ANY', handleTts],
      ['/listen', 'ANY', handleListen],
      ['/speak', 'ANY', handleSpeak]
    ]

    for (const root of [ROUTE_API, ROUTE_ROOT]) {
      for (const [suffix, method, handler] of routes) {
        try {
          const dispose = webServer.register({
            kind: 'exact',
            path: root + suffix,
            handler: async (req, res) => {
              const m = req.method || 'GET'
              if (method !== 'ANY' && m !== method && !(method === 'GET' && m === 'HEAD')) {
                res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('method not allowed')
                return
              }
              try {
                await handler(req, res)
              } catch (error) {
                log.error(`路由 ${suffix} 出错：` + String(error?.message ?? error))
                try { sendJson(res, 500, { ok: false, reason: String(error?.message ?? error) }) } catch (e) {}
              }
            }
          })
          wctx.effect(() => dispose, `${NAME}: ${root}${suffix}`)
        } catch (error) {
          log.warn(`挂路由 ${root}${suffix} 失败：` + String(error?.message ?? error))
        }
      }
    }

    // 桌宠要的那条：**不带本插件前缀**，路径由 dsh-coopanion-pet 的
    // lib/optional.js:106 写死。挂了它，桌宠的 /tts 就能拿到音频。
    if (cfg.tts.enabled) {
      try {
        const dispose = webServer.register({
          kind: 'exact',
          path: TTS_ROUTE,
          handler: async (req, res) => {
            try {
              await handleSynthesize(req, res)
            } catch (error) {
              log.error('语音合成路由出错：' + String(error?.message ?? error))
              try { sendJson(res, 500, { ok: false, reason: String(error?.message ?? error) }) } catch (e) {}
            }
          }
        })
        wctx.effect(() => dispose, `${NAME}: ${TTS_ROUTE}`)
        log.info(`语音合成路由已挂：${TTS_ROUTE}（桌宠可以出声了）`)
      } catch (error) {
        log.warn(`挂 ${TTS_ROUTE} 失败：` + String(error?.message ?? error))
      }
    } else {
      log.info('语音合成关着（配置 tts.enabled=false），桌宠只出气泡不出声')
    }

    // 耳朵：随插件起（windowsHide，没有 cmd 黑窗），插件卸载就带走
    if (cfg.listen.enabled && cfg.listen.startWithPlugin !== false) {
      void ear.start('plugin-start').then((r) => {
        if (r.ok) log.info(`耳朵随插件起来了（pid ${r.pid}）`)
        else log.warn('耳朵没起来：' + r.reason)
      })
    } else if (!cfg.listen.enabled) {
      log.info('耳朵关着（配置 listen.enabled=false），不占麦克风')
    } else {
      log.info('耳朵总开关开着，但「随插件起」关着，等手动启动')
    }

    // aurabot 可能在桥接之后才就绪，稍等一会儿再订阅（它没有 ready 事件可听）
    let tries = 0
    const attach = () => {
      const r = au.attach()
      if (r.ok) { log.info('已订阅 aurabot activity（方向 B 生效）'); return }
      if (r.reason === 'aurabot-not-installed' && ++tries <= 20) {
        setTimeout(attach, 1000)
        return
      }
      log.warn('订阅 aurabot 失败：' + r.reason)
    }
    attach()

    wctx.effect(() => () => {
      au.detach()
      // 耳朵必须带走，否则留一只没人管的进程占着麦克风
      ear.dispose()
      log.info('桥接已卸载')
      try {
        const ep = JSON.parse(readFileSync(ENDPOINT_PATH, 'utf8'))
        ep.url = null
        ep.updatedAt = Date.now()
        writeFileSync(ENDPOINT_PATH, JSON.stringify(ep, null, 2) + '\n', 'utf8')
      } catch (error) { /* 无所谓 */ }
    }, `${NAME}: 收尾`)
  })

  // 首次安装时把实际配置写出来一份，用户能直接看到所有开关
  if (!existsSync(CONFIG_PATH)) store.save()

  /**
   * 启动时把唤醒词编译一遍（**异步、不阻塞插件加载**）。
   * 场景：侧栏改过词 → 重启 DSH；或换了 KWS 模型 → tokens.txt 变了需要重切。
   * 失败只记日志，不影响桥接本身（语音只是三件事里的一件）。
   */
  if (cfg.wake.enabled && cfg.wake.autoGenerate) {
    void compileKeywords(cfg, log).catch((error) => {
      log.warn('唤醒词自动编译异常：' + String(error?.message ?? error))
    })
  }
}
