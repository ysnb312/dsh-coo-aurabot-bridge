/**
 * 耳朵托管：让插件负责 Python 语音脚本的生死。
 *
 * 为什么要插件托管：
 *   - 用户不想开 cmd 黑窗（start-voice.bat 那种）。这里 spawn 时 windowsHide:true，
 *     子进程没有控制台，日志走 pipe 进 bridge.log。
 *   - "随插件起"：DSH 一启动，耳朵就在；插件卸载，耳朵跟着退，不留孤儿进程。
 *   - 崩了自己拉回来（带退避与次数上限），用户不用守着。
 *
 * 三道闸（锁屏停 / 闲置停 / 随插件起）**真正的判断在 Python 侧**：
 *   锁屏与键鼠闲置是 Win32 的事实，Node 这边问不到，只能由 Python 用 ctypes 读。
 *   本文件负责把开关递过去（读同一份 config.json），并把它的状态收回来。
 *
 * 不改 dsh-coopanion-pet 一行，也不引第三方依赖。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DATA_DIR } from './config.js'

const IS_WIN = process.platform === 'win32'

/** 插件自己带的加强包目录：<插件>/voice/scripts、<插件>/voice/models。 */
export const BUNDLED_VOICE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'voice')

/**
 * 工作区：配置优先。
 * 空 = 不指定，下面会依次看插件自带的 voice/ 和当前目录。
 * （发布版里没有硬编码的私人路径，换机器请填 listen.workspace 或跑 voice/setup.ps1。）
 */
export function workspaceOf(cfg) {
  return String(cfg?.listen?.workspace || '').trim()
}

/** 自己记一份 pid，防止插件被挂载两次时养出两个耳朵。 */
const PID_PATH = join(DATA_DIR, 'voice.pid')

/** 探测 voice_assistant.py。 */
export function resolveScript(cfg) {
  const fixed = String(cfg?.listen?.scriptPath || '').trim()
  if (fixed) return existsSync(fixed) ? fixed : { error: `配置的 scriptPath 不存在：${fixed}` }
  const root = workspaceOf(cfg)
  const candidates = [
    ...(root ? [join(root, 'scripts', 'voice_assistant.py')] : []),
    join(BUNDLED_VOICE, 'scripts', 'voice_assistant.py'),
    join(process.cwd(), 'scripts', 'voice_assistant.py')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return { error: `找不到 voice_assistant.py，请跑 voice/setup.ps1，或在侧栏「耳朵」里填 listen.workspace / scriptPath` }
}

/** 探测解释器：venv 优先（里面才有 sherpa-onnx / faster-whisper）。 */
export function resolvePython(cfg, script) {
  const fixed = String(cfg?.listen?.pythonPath || '').trim()
  if (fixed) return existsSync(fixed) ? fixed : { error: `配置的 pythonPath 不存在：${fixed}` }

  const root = typeof script === 'string'
    ? resolve(script, '..', '..')
    : (workspaceOf(cfg) || BUNDLED_VOICE)
  const cands = IS_WIN
    ? [join(root, '.venv-voice', 'Scripts', 'python.exe'), join(root, '.venv-voice', 'Scripts', 'python')]
    : [join(root, '.venv-voice', 'bin', 'python3'), join(root, '.venv-voice', 'bin', 'python')]
  for (const c of cands) if (existsSync(c)) return c
  return IS_WIN ? 'python.exe' : 'python3'
}

/** pid 还活着？ */
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** 上一个插件实例留下的 pid：能杀就杀，避免两个耳朵抢麦克风。 */
function killStale(log) {
  let pid = 0
  try { pid = Number(JSON.parse(readFileSync(PID_PATH, 'utf8')).pid) || 0 } catch (e) { return }
  if (!pid || pid === process.pid || !alive(pid)) return
  try {
    process.kill(pid)
    log?.warn?.(`发现上一次留下的耳朵进程 ${pid}，已结束它（防止抢麦克风）`)
  } catch (error) {
    log?.warn?.(`上一次的耳朵进程 ${pid} 结束失败：` + String(error?.message ?? error))
  }
}

/**
 * 建耳朵托管器。
 * `getCfg()` 每次现取配置（侧栏改完不用重挂插件）。
 *
 * 进程内单例：市场开关反复 toggle 会让插件被挂载两次，第二次若新造托管器，
 * 就会养出第二只耳朵抢麦克风（实测踩过）。所以第二次拿同一个实例。
 */
let shared = null
export function createListenSupervisor(getCfg, log) {
  if (shared) {
    shared.rebind(getCfg, log)
    return shared
  }
  shared = build(getCfg, log)
  return shared
}

function build(initialGetCfg, initialLog) {
  /** getCfg / log 可能被后来的挂载替换掉（见 rebind）。 */
  let getCfg = initialGetCfg
  let log = initialLog
  /** 子进程与它的运行态。 */
  let child = null
  let stopping = false
  let restarts = 0
  let startedAt = 0
  let lastExit = null
  let lastError = ''
  let lastLine = ''
  let gate = null
  let restartTimer = null
  /** 闸门状态变化时的回调（主程序用它弹气泡提示）。 */
  let onGate = null

  const cfgOf = () => getCfg()?.listen || {}

  /** 子进程每行输出：抓 gate 状态，其余进 bridge.log。 */
  const onLine = (line) => {
    const s = String(line || '').trim()
    if (!s) return
    lastLine = s.slice(0, 200)
    // Python 侧用 @@GATE {...} 汇报闸门状态（见 voice_assistant.py）
    if (s.startsWith('@@GATE')) {
      try {
        const j = JSON.parse(s.slice(6).trim())
        const prev = gate?.state
        gate = { state: String(j.state || ''), reason: String(j.reason || ''), at: Date.now() }
        if (prev !== gate.state) {
          try { onGate?.(gate, prev) } catch (e) { /* 回调不能弄死监听 */ }
        }
      } catch (e) { /* 半行 JSON，忽略 */ }
      return
    }
    if (s.startsWith('@@')) return
    // 子进程自己的日志已经是带时间戳的格式，直接转写
    if (/\bERROR\b|✗|失败|Traceback/.test(s)) log?.warn?.('耳朵| ' + s.slice(0, 300))
    else log?.info?.('耳朵| ' + s.slice(0, 300))
  }

  const pipeLines = (stream) => {
    let buf = ''
    stream.setEncoding?.('utf8')
    stream.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        onLine(line)
      }
      if (buf.length > 8192) buf = '' // 没人换行就别把内存吃满
    })
  }

  const writePid = (pid) => {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(PID_PATH, JSON.stringify({ pid, startedAt: Date.now() }, null, 2) + '\n', 'utf8')
    } catch (e) { /* 无所谓 */ }
  }
  const clearPid = () => { try { rmSync(PID_PATH, { force: true }) } catch (e) {} }

  const scheduleRestart = () => {
    const c = cfgOf()
    if (!c.autoRestart) return
    const max = Math.max(0, Number(c.maxRestarts ?? 5))
    if (restarts >= max) {
      log?.warn?.(`耳朵已重试 ${restarts} 次，停止自动拉起（侧栏可以手动启动）`)
      return
    }
    const delay = Math.max(500, Number(c.restartDelayMs ?? 5000))
    restarts += 1
    log?.info?.(`耳朵 ${delay}ms 后第 ${restarts} 次拉起`)
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => { restartTimer = null; void start('auto-restart') }, delay)
    restartTimer.unref?.()
  }

  async function start(why = 'manual') {
    const c = cfgOf()
    if (!c.enabled) return { ok: false, reason: 'listen-disabled' }
    if (child && alive(child.pid)) return { ok: true, reason: 'already-running', pid: child.pid }

    const script = resolveScript(getCfg())
    if (typeof script !== 'string') { lastError = script.error; return { ok: false, reason: script.error } }
    const python = resolvePython(getCfg(), script)
    if (typeof python !== 'string') { lastError = python.error; return { ok: false, reason: python.error } }

    stopChild('restart')
    killStale(log)

    const args = [script, '--managed']
    stopping = false
    try {
      // windowsHide：没有控制台窗口。stdio 全走 pipe，日志进 bridge.log。
      child = spawn(python, args, {
        cwd: dirname(script),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1'
        }
      })
    } catch (error) {
      child = null
      lastError = String(error?.message ?? error)
      log?.error?.('拉起耳朵失败：' + lastError)
      scheduleRestart()
      return { ok: false, reason: lastError }
    }

    startedAt = Date.now()
    lastExit = null
    gate = null
    writePid(child.pid)
    log?.info?.(`耳朵已拉起（${why}）：pid ${child.pid}，${python}`)

    if (child.stdout) pipeLines(child.stdout)
    if (child.stderr) pipeLines(child.stderr)

    child.on('error', (error) => {
      lastError = String(error?.message ?? error)
      log?.error?.('耳朵进程出错：' + lastError)
    })

    child.on('exit', (code, signal) => {
      lastExit = { code, signal, at: Date.now() }
      const wasStopping = stopping
      child = null
      gate = null
      clearPid()
      if (wasStopping) { log?.info?.('耳朵已停止'); return }
      restartTimer = null
      lastError = lastError || `exit ${code ?? signal}`
      log?.warn?.(`耳朵退出了（code=${code ?? '-'} signal=${signal ?? '-'}）`)
      scheduleRestart()
    })

    return { ok: true, pid: child.pid, python, script }
  }

  /** 只杀自己的子进程，不碰别人的。 */
  function stopChild(why) {
    clearTimeout(restartTimer)
    restartTimer = null
    const c = child
    if (!c) { clearPid(); return false }
    stopping = true
    try { c.kill() } catch (e) { /* 已经死了 */ }
    log?.info?.(`正在结束耳朵（${why}）`)
    return true
  }

  function stop() {
    const had = stopChild('manual')
    stopping = true
    restarts = 0
    startedAt = 0
    clearPid()
    return { ok: true, stopped: had }
  }

  async function restart() {
    stop()
    restarts = 0
    return start('manual-restart')
  }

  /** 侧栏要的一份状态。 */
  function status() {
    const c = cfgOf()
    const script = resolveScript(getCfg())
    const python = typeof script === 'string' ? resolvePython(getCfg(), script) : null
    const running = !!(child && alive(child.pid))
    return {
      enabled: c.enabled !== false,
      running,
      pid: running ? child.pid : null,
      uptimeMs: running && startedAt ? Date.now() - startedAt : 0,
      startedAt: running ? startedAt : null,
      restarts,
      lastExit,
      lastError: lastError || null,
      lastLine: lastLine || null,
      gate,
      script: typeof script === 'string' ? script : null,
      scriptError: typeof script === 'string' ? null : script.error,
      python,
      // 三道闸与热键的当前值（侧栏直接显示，不用再取 /config）
      gates: {
        pauseOnLock: c.pauseOnLock !== false,
        pauseOnIdle: c.pauseOnIdle !== false,
        idleMinutes: Number(c.idleMinutes ?? 10),
        resumeOnActivity: c.resumeOnActivity !== false,
        startWithPlugin: c.enabled !== false
      },
      hotkey: {
        enabled: c.hotkey?.enabled !== false,
        combo: String(c.hotkey?.combo || 'ctrl+alt+j')
      }
    }
  }

  /** 插件卸载时收尾：一定要把子进程带走，否则会剩一只没人管的耳朵。 */
  function dispose() {
    stopChild('dispose')
    restarts = 0
    clearPid()
  }

  return {
    start, stop, restart, status, dispose,
    /** 闸门状态变化时回调（参数：新 gate、旧状态） */
    onGate(fn) { onGate = typeof fn === 'function' ? fn : null },
    /** 第二次挂载时换用新的配置来源与日志出口（子进程不动）。 */
    rebind(nextGetCfg, nextLog) {
      if (typeof nextGetCfg === 'function') getCfg = nextGetCfg
      if (nextLog) log = nextLog
    },
    get pid() { return child?.pid || null }
  }
}

export { PID_PATH }
