/**
 * coopanion 适配层：**只走它自己的 HTTP 路由**，不 import、不改源码。
 *
 * 为什么只能这样：dsh-coopanion-pet 没有 `ctx.provide`，也没有任何业务
 * `ctx.emit` —— 它只在内部持有 channel / chat 服务。所以第三方能用的面
 * 就是它注册在宿主 webServer 上的那批路由（实测无鉴权、同机即可调）：
 *
 *   注入一轮对话  POST /api/dsh-coopanion-pet/report   { kind:'answer', text, question }
 *   指定会话注入  POST /api/dsh-coopanion-pet/chat/send { sessionId, text, requestId }
 *   只说话不对话  POST /api/dsh-coopanion-pet/say-test  { text }（≤200 字）
 *   会话清单      GET  /api/dsh-coopanion-pet/chat/list
 *   语音能力探测  GET  /api/dsh-coopanion-pet/speech
 */

const TIMEOUT_MS = 8000

/** 拼基址：优先配置，其次宿主 webServer 的真实端口（不写死 57827）。 */
export function resolveBase(getWebServer, cfg) {
  const fixed = String(cfg?.coopanionBaseUrl || '').trim()
  if (fixed) return fixed.replace(/\/+$/, '')
  let port = 0
  try {
    const ws = typeof getWebServer === 'function' ? getWebServer() : getWebServer
    if (ws && typeof ws.port === 'number') port = ws.port
  } catch (error) { /* 拿不到就退回默认 */ }
  return `http://127.0.0.1:${port || 57827}`
}

/** 带超时的 fetch；任何异常都折成 { ok:false, reason }，调用方不必 try。 */
async function call(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    const body = await res.text()
    let json = null
    try { json = JSON.parse(body) } catch (error) { /* 非 JSON（错误时是纯文本） */ }
    return { ok: res.ok, status: res.status, json, text: body }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : (error?.cause?.code || error?.message || 'fetch-failed')
    return { ok: false, status: 0, json: null, text: '', reason: String(reason) }
  } finally {
    clearTimeout(timer)
  }
}

const jsonPost = (payload) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
})

/**
 * 注入一段用户文本，等价于「主人在桌宠页面里打了这句话」。
 *
 * 返回 `{ ok, via, detail }`：
 *   via='chat-send' 走了指定会话（最确定）
 *   via='followup'  走了活跃 agent（会排一轮新对话）
 *   via='none'      两条路都不通，detail 说明原因
 */
export async function injectText(base, text, opts = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, via: 'none', detail: 'empty' }

  const mode = opts.deliver || 'auto'
  const sessionId = String(opts.sessionId || '').trim()

  if (mode === 'chat-send' || (mode === 'auto' && sessionId)) {
    if (!sessionId) return { ok: false, via: 'none', detail: 'no-session-id' }
    const r = await call(`${base}/api/dsh-coopanion-pet/chat/send`, jsonPost({
      sessionId,
      text: body,
      requestId: `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }))
    if (r.ok && r.json?.ok !== false) return { ok: true, via: 'chat-send', detail: r.json?.reason ?? 'accepted' }
    return { ok: false, via: 'chat-send', detail: r.reason || r.json?.reason || r.json?.message || `http-${r.status}` }
  }

  const r = await call(`${base}/api/dsh-coopanion-pet/report`, jsonPost({ kind: 'answer', text: body, question: '' }))
  // 成功时宿主回 204 空体；失败回纯文本原因（如 'empty answer' / 'unknown kind'）
  if (r.ok) return { ok: true, via: 'followup', detail: 'delivered' }
  return { ok: false, via: 'followup', detail: r.reason || (r.text || '').slice(0, 120) || `http-${r.status}` }
}

/** 只让她在气泡里说一句，**不触发 LLM**（唤醒应答、连接提示用这个）。 */
export async function sayText(base, text) {
  const body = String(text ?? '').trim().slice(0, 200)
  if (!body) return { ok: false, detail: 'empty' }
  const r = await call(`${base}/api/dsh-coopanion-pet/say-test`, jsonPost({ text: body }))
  if (r.ok && r.json?.ok !== false) return { ok: true, detail: r.json?.reason ?? 'said' }
  return { ok: false, detail: r.reason || r.json?.reason || `http-${r.status}` }
}

/**
 * 让她**念出声**（不只是弹气泡）。
 *
 * 走的是页面 `case 'speak'` 那条命令：宿主合成 TTS 音频、页面播放。
 * 语音合成需要宿主里有 `/plugins/xiaomi-mimo-tts/synthesize`（本插件会提供），
 * 页面没连上时宿主会回 `{ ok:false, reason:'offline' }`。
 * 朗读本身可能要几秒（合成+播放），超时给得比别的接口长。
 */
export async function speakText(base, text, timeoutMs = 30000) {
  const body = String(text ?? '').trim().slice(0, 500)
  if (!body) return { ok: false, detail: 'empty' }
  const r = await call(`${base}/api/dsh-coopanion-pet/speak-test`, jsonPost({ text: body }), timeoutMs)
  if (r.ok && r.json?.ok !== false) return { ok: true, detail: r.json?.reason ?? 'spoke' }
  return { ok: false, detail: r.reason || r.json?.reason || `http-${r.status}` }
}

/** 会话清单，用于诊断面板（顺便验证基址对不对）。 */
export async function listSessions(base) {
  const r = await call(`${base}/api/dsh-coopanion-pet/chat/list`)
  if (!r.ok || !r.json) return { ok: false, detail: r.reason || `http-${r.status}`, sessions: [] }
  const raw = r.json.sessions ?? r.json.items ?? (Array.isArray(r.json) ? r.json : [])
  return {
    ok: true,
    sessions: raw.map((s) => ({
      id: String(s?.id ?? s?.sessionId ?? ''),
      title: String(s?.title ?? ''),
      running: s?.running === true
    })).filter((s) => s.id)
  }
}

/** 宿主有没有装 ASR 语音识别插件（有的话 coopanion 自带 /speech 也能用）。 */
export async function speechCapability(base) {
  const r = await call(`${base}/api/dsh-coopanion-pet/speech`)
  if (!r.ok || !r.json) return { ok: false, available: false, detail: r.reason || `http-${r.status}` }
  return { ok: true, available: r.json.available === true, package: r.json.package ?? '' }
}
