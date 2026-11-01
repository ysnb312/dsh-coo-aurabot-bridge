/**
 * 日志：写 `~/.dsh/plugins-data/coo-aurabot-bridge/bridge.log`，同时进宿主 logger。
 *
 * 为什么要单独一份：语音链路要排「麦克风有没有听到 / whisper 转成了什么 /
 * 注入到底成没成」—— 这三件事分属两个进程，必须有一个两边都能看的地方。
 * 行数上限 `logMaxLines`，超了就砍掉前半重新写，不会无限长。
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024

export function createLogger(filePath, hostLogger, maxLines = 2000) {
  let writes = 0

  const stamp = () => {
    const d = new Date()
    const p = (n, w = 2) => String(n).padStart(w, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  }

  const trim = () => {
    try {
      if (!existsSync(filePath)) return
      if (statSync(filePath).size < MAX_BYTES) return
      const lines = readFileSync(filePath, 'utf8').split('\n')
      // 砍掉前半，留下 maxLines 行（末尾常有一个空串）
      const keep = lines.slice(Math.max(0, lines.length - maxLines))
      writeFileSync(filePath, keep.join('\n'), 'utf8')
    } catch (error) {
      /* 截断失败不影响主流程 */
    }
  }

  const write = (level, text) => {
    const line = `${stamp()} [${level}] ${text}`
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      appendFileSync(filePath, line + '\n', 'utf8')
      if (++writes % 200 === 0) trim()
    } catch (error) {
      /* 磁盘写不进去也不能让桥接崩 */
    }
    const fn = level === 'error' ? hostLogger?.error : level === 'warn' ? hostLogger?.warn : hostLogger?.info
    try { fn?.call(hostLogger, '[coo-aurabot-bridge] ' + text) } catch (e) {}
  }

  return {
    info: (t) => write('info', t),
    warn: (t) => write('warn', t),
    error: (t) => write('error', t),
    path: filePath
  }
}
