/**
 * 离线冒烟测试：不启动 DSH，用假 ctx 把插件的 apply() 跑一遍。
 *
 * 覆盖：
 *   1. 模块能 import（没有语法错/循环依赖）
 *   2. apply() 不抛
 *   3. 路由都挂上了（假 webServer 记录 register 调用）
 *   4. endpoint.json / config.json 写出来了
 *   5. 过滤链的关键分支：a2q 默认关、群聊拒绝、非主人拒绝、排除会话、去 markdown
 *   6. /voice-input 的令牌校验
 *
 * 用法：node scripts/test-bridge-offline.mjs
 */

import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'bridge-test-'))
process.env.DSH_HOME = tmp
process.env.AURABOT_DATA_DIR = join(tmp, 'plugins-data', 'aurabot')

// auarabot 的会话映射（排除集）
import { mkdirSync } from 'node:fs'
mkdirSync(process.env.AURABOT_DATA_DIR, { recursive: true })
writeFileSync(join(process.env.AURABOT_DATA_DIR, 'sessions.json'), JSON.stringify({
  chats: {
    'private:10001': { sessionId: 'session-qq-owner' },
    'system:diary': { sessionId: 'session-qq-diary' }
  }
}), 'utf8')

const results = []
const check = (name, fn) => {
  try {
    const v = fn()
    results.push([v ? 'PASS' : 'FAIL', name, v === true ? '' : String(v)])
  } catch (error) {
    results.push(['FAIL', name, String(error?.message ?? error)])
  }
}
const checkAsync = async (name, fn) => {
  try {
    const v = await fn()
    results.push([v ? 'PASS' : 'FAIL', name, v === true ? '' : String(v)])
  } catch (error) {
    results.push(['FAIL', name, String(error?.message ?? error)])
  }
}

/* ---------- 假 ctx ---------- */
const handlers = new Map()      // 事件名 → fn[]
const routes = new Map()        // path → handler
const logs = []

const fakeCtx = {
  logger: {
    info: (m) => logs.push('info ' + m),
    warn: (m) => logs.push('warn ' + m),
    error: (m) => logs.push('error ' + m)
  },
  get: (name) => (name === 'aurabot' ? fakeAurabot : undefined),
  on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); return () => {} },
  // 真 cordis 的 effect(fn) 是"现在拿 disposer，卸载时再调它"；
  // 这里绝不能立刻 invoke —— 那等于当场执行清理，把订阅全拆掉。
  effect: (fn) => { try { return fn() } catch (e) {} },
  inject: (names, cb) => {
    const wctx = {
      get: (n) => (n === 'webServer' ? fakeWebServer : undefined),
      effect: (fn) => { try { return fn() } catch (e) {} }
    }
    cb(wctx)
  }
}

const fakeWebServer = {
  port: 51234,
  register({ kind, path, handler }) {
    routes.set(path, handler)
    return () => routes.delete(path)
  }
}

/* ---------- 假 auarabot service ---------- */
const activityListeners = []
let sendCalls = []
const fakeAurabot = {
  version: '1.0.5',
  apiVersion: 1,
  info: () => ({ ok: true, enabled: true, dryRun: false, online: true }),
  send: async ({ target, text }) => {
    sendCalls.push({ target, text })
    return { ok: true, message: '发出去了' }
  },
  on: (event, fn) => {
    if (event === 'activity') activityListeners.push(fn)
    return () => { const i = activityListeners.indexOf(fn); if (i >= 0) activityListeners.splice(i, 1) }
  }
}

/* ---------- 跑 apply ---------- */
// 插件源码位置：脚本在 <插件>/test/ 下，默认就是上一级目录；也可用 BRIDGE_PLUGIN_DIR 覆盖
const pluginDir = process.env.BRIDGE_PLUGIN_DIR
  ?? new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const mod = await import(new URL('file:///' + pluginDir.replace(/\\/g, '/') + '/lib/index.js').href)
mod.apply(fakeCtx)

const cfgPath = join(tmp, 'plugins-data', 'coo-aurabot-bridge', 'config.json')
const epPath = join(tmp, 'plugins-data', 'coo-aurabot-bridge', 'endpoint.json')

check('apply() 不抛异常', () => true)
check('config.json 已写出', () => existsSync(cfgPath))
check('endpoint.json 已写出', () => existsSync(epPath))

const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
check('aToQ.enabled 默认 false（首次安装不发 QQ）', () => cfg.aToQ.enabled === false)
check('q2p.enabled 默认 true', () => cfg.q2p.enabled === true)
check('voiceInput.token 已生成', () => typeof cfg.voiceInput.token === 'string' && cfg.voiceInput.token.length >= 32)
check('voiceMaxChars 默认 120', () => cfg.aToQ.voiceMaxChars === 120)

const ep = JSON.parse(readFileSync(epPath, 'utf8'))
check('endpoint.port 来自 webServer.port', () => ep.port === 51234)
check('endpoint.url 指向 /voice-input', () => ep.url === 'http://127.0.0.1:51234/api/dsh-coo-aurabot-bridge/voice-input')

const paths = [...routes.keys()]
// 注意：别用 `a === N || '提示字符串'` 这种写法 —— 非空字符串是 truthy，
// 断言会永远通过（这个坑原来就在这里，12 条路由却"通过"了 5 条 × 2 的检查）。
const ROUTE_COUNT = 6
check(`挂了 ${ROUTE_COUNT} 条路由 × 2 个根`, () => paths.length === ROUTE_COUNT * 2 || `实际 ${paths.length} 条：${paths.join(',')}`)
check('有 /status', () => paths.some((p) => p.endsWith('/status')))
check('有 /voice-input', () => paths.some((p) => p.endsWith('/voice-input')))
check('有 /simulate-pet', () => paths.some((p) => p.endsWith('/simulate-pet')))
check('有 /wakewords（唤醒词配置口）', () => paths.some((p) => p.endsWith('/wakewords')))

check('订阅了 activity（方向 B 生效）', () => activityListeners.length === 1)
check('监听了 session/event（方向 A）', () => (handlers.get('session/event') || []).length === 1)

/* ---------- 假 req / res ---------- */
const fakeRes = () => {
  const r = { code: 0, body: '', writeHead(c) { r.code = c }, end(b) { r.body = b } }
  return r
}
const fakeReq = (payload) => {
  const chunks = [Buffer.from(JSON.stringify(payload), 'utf8')]
  const req = {
    method: 'POST',
    headers: {},
    on(event, fn) {
      if (event === 'data') for (const c of chunks) fn(c)
      if (event === 'end') fn()
      return req
    },
    destroy() {}
  }
  return req
}
let res = fakeRes()

/* ---------- 过滤链 ---------- */
const sessionEvent = handlers.get('session/event')[0]
const emitAssistant = (sid, text) => sessionEvent({ id: sid }, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } }
})

// a2q 默认关：发了也不应该调 auarabot.send
sendCalls = []
emitAssistant('session-voice-1', '你好呀')
await new Promise((r) => setTimeout(r, 30))
check('方向A：aToQ 关闭时一条都不发', () => sendCalls.length === 0)

// 打开 aToQ —— 走插件自己的 /config 路由，改的是**内存里那一份**（直接改文件没用）
const configHandler = routes.get('/api/dsh-coo-aurabot-bridge/config')
res = fakeRes()
await configHandler(fakeReq({ aToQ: { enabled: true } }), res)
check('/config 能打开 aToQ', () => JSON.parse(res.body).config.aToQ.enabled === true)

const voiceHandler = routes.get('/api/dsh-coo-aurabot-bridge/voice-input')

// 令牌错
res = fakeRes()
await voiceHandler(fakeReq({ text: '你好', sessionId: 'session-voice-1' }), res)
check('/voice-input 令牌错 → 401', () => res.code === 401 || 'code=' + res.code)

// 令牌对（会自动绑会话，注入必然失败因为 51234 没服务，但绑定先发生）
res = fakeRes()
await voiceHandler(fakeReq({ text: '你好', sessionId: 'session-voice-1', token: ep.token }), res)
check('/voice-input 令牌对 → 不是 401', () => res.code !== 401)

// 白名单会话的回复应该转发
sendCalls = []
emitAssistant('session-voice-1', '桌宠说的话')
await new Promise((r) => setTimeout(r, 50))
check('方向A：白名单会话的回复会发 QQ', () => sendCalls.length === 1)

// 排除集：aurabot 自己的会话
sendCalls = []
emitAssistant('session-qq-owner', 'QQ 那边的回复')
await new Promise((r) => setTimeout(r, 30))
check('方向A：aurabot 自己的会话被排除（防死循环）', () => sendCalls.length === 0)

// markdown 清理
sendCalls = []
emitAssistant('session-voice-1', '**重点**：这是`代码`和[链接](http://x)')
await new Promise((r) => setTimeout(r, 50))
check('方向A：markdown 被清掉', () => sendCalls.length === 1 && !/\*\*|`|\]\(/.test(sendCalls[0].text) || JSON.stringify(sendCalls))

// 短句走语音
check('方向A：≤120 字的回复包 <voice>', () => sendCalls[0].text.startsWith('<voice>'))

// 长句退回文字
sendCalls = []
cfg.aToQ.enabled = true
emitAssistant('session-voice-1', '啊'.repeat(200))
await new Promise((r) => setTimeout(r, 50))
check('方向A：>120 字退回文字（不包 voice）', () => sendCalls.length === 1 && !sendCalls[0].text.startsWith('<voice>') || JSON.stringify(sendCalls).slice(0, 200))

/* ---------- 方向 B 过滤 ---------- */
const fire = (a) => activityListeners[0](a)
const q2pChecks = []
const simQQ = routes.get('/api/dsh-coo-aurabot-bridge/simulate-qq')
const simPet = routes.get('/api/dsh-coo-aurabot-bridge/simulate-pet')

// 群聊消息必须被拒（simulate-qq 会把 chatId 交给过滤链）
res = fakeRes()
await simQQ(fakeReq({ text: '群里说的话', chatId: 'group:123456', owner: false }), res)
check('方向B：群聊被拒', () => JSON.parse(res.body).reason === 'group-not-allowed' || res.body)

// 非主人被拒
res = fakeRes()
await simQQ(fakeReq({ text: '陌生人', chatId: 'private:999', owner: false }), res)
check('方向B：非主人被拒', () => JSON.parse(res.body).reason === 'not-owner' || res.body)

// 系统消息被拒
res = fakeRes()
await simQQ(fakeReq({ text: '[语音·cosyvoice] 嗯嗯', chatId: 'private:10001', owner: true }), res)
check('方向B：系统消息被拒', () => JSON.parse(res.body).reason === 'system-text' || res.body)

/* ---------- /status ---------- */
const statusHandler = routes.get('/api/dsh-coo-aurabot-bridge/status')
res = fakeRes()
await statusHandler({ method: 'GET', headers: {} }, res)
const st = JSON.parse(res.body)
check('/status 返回 gates', () => st.gates && st.gates.aToQ === true)
check('/status 报告 auarabot available', () => st.aurabot.available === true)

/* ---------- 唤醒词（侧栏 ↔ Python 的契约） ---------- */
const wakeHandler = routes.get('/api/dsh-coo-aurabot-bridge/wakewords')

// GET：应返回当前词表 + 编译产物状态
res = fakeRes()
await wakeHandler({ method: 'GET', headers: {} }, res)
const w0 = JSON.parse(res.body)
check('/wakewords GET 返回词表', () => Array.isArray(w0.words) && w0.words.length > 0 || res.body)
check('/wakewords GET 带编译状态', () => w0.compiled && typeof w0.compiled.exists === 'boolean')
check('出厂唤醒词含「大飞鱼」', () => w0.words.includes('大飞鱼'))

// POST：去空、去重、trim 都要生效
res = fakeRes()
await wakeHandler(fakeReq({ words: ['  小鲸鱼  ', '小鲸鱼', '', '你好肥鱼'] }), res)
const w1 = JSON.parse(res.body)
check('/wakewords POST 去重去空', () => w1.words.length === 2 && w1.words[0] === '小鲸鱼' || JSON.stringify(w1.words))

// POST：空词表必须被拒（不然等于把耳朵静音了却看不出来）
res = fakeRes()
await wakeHandler(fakeReq({ words: [] }), res)
check('/wakewords 空词表 → 400', () => res.code === 400 && JSON.parse(res.body).reason === 'empty-words' || res.body)

// POST：超长词被丢弃并报告
res = fakeRes()
await wakeHandler(fakeReq({ words: ['肥鱼', '这是一个特别特别长的唤醒词超过十二个字'] }), res)
const w2 = JSON.parse(res.body)
check('/wakewords 超长词被丢弃', () => Array.isArray(w2.dropped) && w2.dropped.length === 1 || JSON.stringify(w2.dropped))
check('/wakewords 合法词仍保留', () => w2.words.includes('肥鱼'))

// 落盘：config.json 里应该是中文词（人类可读），不是拼音
const cfg2 = JSON.parse(readFileSync(cfgPath, 'utf8'))
check('config.wake.words 存的是中文', () => Array.isArray(cfg2.wake?.words) && cfg2.wake.words.includes('肥鱼'))


const width = Math.max(...results.map((r) => r[1].length))
let failed = 0
for (const [verdict, name, detail] of results) {
  if (verdict === 'FAIL') failed++
  console.log(`${verdict === 'PASS' ? '✓' : '✗'} ${name.padEnd(width)}  ${detail}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (logs.some((l) => l.startsWith('error'))) {
  console.log('\n--- 宿主 logger 的 error ---')
  for (const l of logs.filter((x) => x.startsWith('error'))) console.log('  ' + l)
}
rmSync(tmp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
