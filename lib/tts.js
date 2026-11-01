/**
 * 语音合成：把文字变成 mp3 字节，交给桌宠播。
 *
 * 为什么要自己做：dsh-coopanion-pet 的 /tts 端点本身只是**转发器**——它去 fetch
 * 同源路由 `/plugins/xiaomi-mimo-tts/synthesize`（见它的 lib/optional.js:106
 * detectTextToSpeech），拿不到就回 501 no-tts-plugin。也就是说桌宠"会不会说话"
 * 只取决于宿主里有没有这条路由，跟它自己一行代码都不冲突。
 *
 * 所以这里就**假装自己是那个路由**：用 edge-tts（本机 pyenv 里已装好，和 QQ 语音条
 * 同一个引擎）合成，直接把音频字节回给桌宠。好处：
 *   - 不装 dsh-xiaomi-tts（不要 API key、不联网调上游）
 *   - 不改桌宠源码、不新增插件
 *   - 和 QQ 语音条用同一套声音，主人听感一致
 *
 * 走子进程而不是自己讲协议：edge-tts 7.x 的 CLI 就够用，且它自己处理了重连与鉴权。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const IS_WIN = process.platform === 'win32'

/** 与桌宠 lib/optional.js 里的 TTS_ROUTE 完全一致的路径。 */
export const TTS_ROUTE = '/plugins/xiaomi-mimo-tts/synthesize'

/** 桌宠要的 MIME；edge-tts 的输出是 mp3。 */
export const MIME = 'audio/mpeg'

/** 千问 TTS 输出的是 24k 单声道 wav。 */
export const MIME_WAV = 'audio/wav'

/**
 * aurabot 那边的本地接口脚本：QQ 语音条就是它在合成。
 * 直接复用同一份脚本 → 桌宠和 QQ 的声音、语气完全一致，不用两边各维护一套。
 */
export function resolveLocalScript(cfg) {
  const fixed = String(cfg?.tts?.localScript || '').trim()
  if (fixed) return existsSync(fixed) ? fixed : { error: `配置的 localScript 不存在：${fixed}` }
  const guess = join(homedir(), '.dsh', 'plugins-data', 'aurabot', 'local', 'tts.mjs')
  return existsSync(guess) ? guess : { error: `没找到 aurabot 的 tts.mjs：${guess}` }
}

/** 动态载入 tts.mjs 并合成，返回 wav 字节。失败返回 { error }。 */
async function viaLocalScript(text, cfg, log) {
  const script = resolveLocalScript(cfg)
  if (typeof script !== 'string') return { error: script.error }
  let outDir = ''
  try {
    outDir = mkdtempSync(join(tmpdir(), 'coo-qwen-'))
  } catch (error) {
    return { error: `建不了临时目录：${String(error?.message ?? error)}` }
  }
  try {
    const mod = await import(pathToFileURL(script).href + `?t=${Date.now()}`)
    const fn = mod?.default || mod?.synthesize
    if (typeof fn !== 'function') return { error: 'tts.mjs 没有导出可调用的函数' }
    const out = await fn({ text, outDir, log: { info: (m) => log?.info?.(`[tts.mjs] ${m}`), warn: (m) => log?.warn?.(`[tts.mjs] ${m}`) } })
    const file = typeof out === 'string' ? out : String(out?.file || '')
    if (!file || !existsSync(file)) return { error: 'tts.mjs 没返回音频文件（它自己失败时会静默返回空串）' }
    const audio = readFileSync(file)
    if (!audio || audio.length < 400) return { error: 'tts.mjs 给的音频太小' }
    return { audio, type: /\.wav$/i.test(file) ? MIME_WAV : MIME }
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 300) }
  } finally {
    try { rmSync(outDir, { recursive: true, force: true }) } catch (error) { /* 临时目录删不掉无所谓 */ }
  }
}

/**
 * 找解释器。优先配置，其次 aurabot 那份 pyenv（edge-tts 就装在那儿）。
 * 与 aurabot 的 src/voice/tts.js 同一套探测顺序，避免两边找到不同的 python。
 */
export function resolvePython(cfg) {
  const fixed = String(cfg?.tts?.pythonPath || '').trim()
  if (fixed) return existsSync(fixed) ? fixed : { error: `配置的 pythonPath 不存在：${fixed}` }

  const dirs = []
  const envDir = String(process.env.AURABOT_PYENV || '').trim()
  if (envDir) dirs.push(envDir)
  dirs.push(join('C:', 'Aurabot', 'pyenv'), join(homedir(), 'Aurabot', 'pyenv'))

  const names = IS_WIN
    ? [['Scripts', 'python.exe'], ['Scripts', 'python']]
    : [['bin', 'python3'], ['bin', 'python']]

  for (const dir of dirs) {
    for (const parts of names) {
      const exe = join(dir, ...parts)
      if (existsSync(exe)) return exe
    }
  }
  return IS_WIN ? 'python.exe' : 'python3'
}

/** 上一次合成的结果，给侧栏显示"到底通没通"。 */
let last = { ok: null, at: 0, ms: 0, bytes: 0, reason: '' }

export const lastRun = () => ({ ...last })

/**
 * 最近几段合成结果的缓存。
 *
 * 桌宠会把同一句话反复念（重进页面、表情触发、侧栏连点试听），每次掏 3 秒
 * 去联网很浪费；key 用「声音+语速+文本」的哈希，改任何一项就重新合成。
 */
function createCache(limit) {
  const map = new Map()
  const max = Math.max(1, Number(limit) || 24)
  return {
    get(key) {
      const hit = map.get(key)
      if (!hit) return null
      // 命中后挪到末尾（Map 保插入顺序，正好当 LRU 用）
      map.delete(key)
      map.set(key, hit)
      return hit
    },
    set(key, value) {
      map.set(key, value)
      while (map.size > max) map.delete(map.keys().next().value)
    },
    get size() { return map.size },
    clear() { map.clear() }
  }
}

const cache = createCache(24)

/** 清掉缓存（侧栏改过声音/引擎后调用，让下一次真的重合成）。 */
export function forget() {
  cache.clear()
}

/**
 * 合成一段语音。
 *
 * @param text 要念的文字（已由调用方截断）。
 * @param cfg  插件配置，读 `cfg.tts`。
 * @param log  日志器。
 * @returns `{ ok:true, audio:Buffer, type, ms, cached }` 或 `{ ok:false, reason, detail }`
 */
export async function synthesize(text, cfg, log) {
  const body = String(text ?? '').trim()
  if (!body) return Promise.resolve({ ok: false, reason: 'empty-text' })

  const conf = cfg?.tts || {}
  if (conf.enabled === false) return Promise.resolve({ ok: false, reason: 'tts-disabled' })

  const maxChars = Math.max(1, Number(conf.maxChars) || 500)
  if (body.length > maxChars) return Promise.resolve({ ok: false, reason: 'too-long', detail: `一次最多 ${maxChars} 字` })

  const voice = String(conf.voice || 'zh-CN-XiaoyiNeural').trim() || 'zh-CN-XiaoyiNeural'
  const rate = String(conf.rate || '').trim()
  const volume = String(conf.volume || '').trim()
  const pitch = String(conf.pitch || '').trim()

  const key = [voice, rate, volume, pitch, body].join('\u0000')
  const hit = cache.get(key)
  if (hit) {
    last = { ok: true, at: Date.now(), ms: 0, bytes: hit.audio.length, reason: 'cached' }
    return Promise.resolve({ ok: true, audio: hit.audio, type: hit.type || MIME, ms: 0, cached: true })
  }

  // 先试 aurabot 那份本地接口脚本（qq 语音条用的就是它，语气指令也在里面）。
  // 成了就用它 → 桌宠和 QQ 同一个嗓子；不成再退回下面的 edge-tts。
  if (conf.useLocalScript !== false) {
    const startedAt = Date.now()
    const got = await viaLocalScript(body, cfg, log)
    if (got.audio) {
      const ms = Date.now() - startedAt
      cache.set(key, { audio: got.audio, type: got.type })
      last = { ok: true, at: Date.now(), ms, bytes: got.audio.length, reason: 'local-script' }
      log?.info?.(`语音合成好了（走 aurabot 的 tts.mjs）：${body.slice(0, 12)}…（${got.audio.length}B，${ms}ms）`)
      return { ok: true, audio: got.audio, type: got.type, ms }
    }
    if (got.error) log?.warn?.(`本地 tts.mjs 没成，退回 edge-tts：${got.error}`)
  }

  const python = resolvePython(cfg)
  if (typeof python !== 'string') return Promise.resolve({ ok: false, reason: 'no-python', detail: python.error })

  // 文本走文件而不是 -t：台词里可能有引号、换行，Windows 命令行拼参数容易挂
  let dir = ''
  try {
    dir = mkdtempSync(join(tmpdir(), 'coo-tts-'))
  } catch (error) {
    return Promise.resolve({ ok: false, reason: 'no-temp', detail: String(error?.message ?? error) })
  }
  const txtFile = join(dir, 'in.txt')
  const mediaFile = join(dir, 'out.mp3')
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) { /* 临时目录删不掉无所谓 */ }
  }

  try {
    writeFileSync(txtFile, body, 'utf8')
  } catch (error) {
    cleanup()
    return Promise.resolve({ ok: false, reason: 'no-temp', detail: String(error?.message ?? error) })
  }

  const args = ['-m', 'edge_tts', '-f', txtFile, '-v', voice, '--write-media', mediaFile, '--no-progress']
  if (rate) args.push('--rate', rate)
  if (volume) args.push('--volume', volume)
  if (pitch) args.push('--pitch', pitch)

  const timeout = Math.max(3000, Number(conf.timeoutMs) || 20000)
  const started = Date.now()

  return new Promise((resolve) => {
    execFile(
      python,
      args,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const ms = Date.now() - started
        if (error) {
          cleanup()
          const detail = String(stderr || stdout || error.message || '').trim().slice(0, 400)
          last = { ok: false, at: Date.now(), ms, bytes: 0, reason: error.killed ? 'timeout' : detail || 'edge-tts-failed' }
          log?.warn?.(`语音合成失败（${ms}ms）：${last.reason}`)
          return resolve({ ok: false, reason: last.reason, detail, ms, python })
        }
        let audio = null
        try {
          audio = readFileSync(mediaFile)
        } catch (e) {
          audio = null
        }
        cleanup()
        if (!audio || audio.length === 0) {
          last = { ok: false, at: Date.now(), ms, bytes: 0, reason: 'no-audio' }
          log?.warn?.(`语音合成没产出音频（${ms}ms）`)
          return resolve({ ok: false, reason: 'no-audio', ms, python })
        }
        cache.set(key, { audio })
        last = { ok: true, at: Date.now(), ms, bytes: audio.length, reason: 'ok' }
        log?.info?.(`语音合成好了：${body.slice(0, 12)}…（${audio.length}B，${ms}ms，${voice}）`)
        resolve({ ok: true, audio, type: MIME, ms })
      }
    )
  })
}

/** 侧栏状态用：解释器、声音、开关。 */
export function ttsStatus(cfg) {
  const python = resolvePython(cfg)
  const conf = cfg?.tts || {}
  return {
    enabled: conf.enabled !== false,
    route: TTS_ROUTE,
    python: typeof python === 'string' ? python : null,
    pythonError: typeof python === 'string' ? null : python.error,
    voice: String(conf.voice || 'zh-CN-XiaoyiNeural'),
    rate: String(conf.rate || ''),
    maxChars: Number(conf.maxChars) || 500,
    cacheSize: cache.size,
    last: { ...last }
  }
}
