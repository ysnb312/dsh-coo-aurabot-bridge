/**
 * 唤醒词编译：中文词 → sherpa-onnx KWS 的 keywords 文件。
 *
 * 分工原则（重要，别搞反）：
 *   - **中文 → 拼音** 的知识在 Python 侧（scripts/gen_keywords.py，用 pypinyin
 *     + 模型 tokens.txt 做最长匹配）。Node 这边不实现、也不引依赖。
 *   - 这个文件只负责三件事：**探测**解释器/脚本路径、**调用**生成器、**校验**词表。
 *
 * 为什么走子进程而不是自己算：拼音要按 tokens.txt 切子词（'dà' → 'd'+'à'），
 * 那是模型相关知识；自己实现一份等于把同一个 bug 养在两边。
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_WIN = process.platform === 'win32'

/** 插件自己带的加强包目录：<插件>/voice/scripts、<插件>/voice/models。 */
export const BUNDLED_VOICE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'voice')

/**
 * 工作区：配置优先。
 * 空 = 不指定，下面依次看插件自带的 voice/ 与当前目录。
 * （发布版里没有硬编码的私人路径；换机器请填 wake.workspace 或跑 voice/setup.ps1。）
 * 注意 listen.workspace 与 wake.workspace 是两份配置，各自管各自的脚本。
 */
export function workspaceOf(cfg) {
  return String(cfg?.wake?.workspace || '').trim()
}

/**
 * 探测生成脚本路径。
 * 优先级：配置 → wake.workspace → 插件自带的 voice/ → 当前目录。
 */
export function resolveGenScript(cfg) {
  const fixed = String(cfg?.wake?.genScript || '').trim()
  if (fixed) return existsSync(fixed) ? fixed : { error: `配置的 genScript 不存在：${fixed}` }

  const root = workspaceOf(cfg)
  const candidates = [
    ...(root ? [join(root, 'scripts', 'gen_keywords.py')] : []),
    join(BUNDLED_VOICE, 'scripts', 'gen_keywords.py'),
    join(process.cwd(), 'scripts', 'gen_keywords.py')
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return { error: '找不到 gen_keywords.py，请跑 voice/setup.ps1，或在侧栏「唤醒词」里填 wake.workspace / genScript' }
}

/** 探测解释器：优先 venv（里面有 pypinyin / sherpa-onnx），退到 PATH 上的 python。 */
export function resolvePython(cfg, genScript) {
  const fixed = String(cfg?.wake?.pythonPath || '').trim()
  if (fixed) return existsSync(fixed) ? fixed : { error: `配置的 pythonPath 不存在：${fixed}` }

  const root = typeof genScript === 'string' ? resolve(genScript, '..', '..') : (workspaceOf(cfg) || BUNDLED_VOICE)
  const candidates = IS_WIN
    ? [join(root, '.venv-voice', 'Scripts', 'python.exe'), join(root, '.venv-voice', 'Scripts', 'python')]
    : [join(root, '.venv-voice', 'bin', 'python3'), join(root, '.venv-voice', 'bin', 'python')]

  for (const c of candidates) if (existsSync(c)) return c
  // 退路：系统 python（可能没装 pypinyin，生成时会报错，错误会原样回传）
  return IS_WIN ? 'python.exe' : 'python3'
}

/** 生成产物落在哪：配置优先，否则 <脚本所在目录>/../models/keywords.generated.txt。 */
export function resolveOutFile(cfg, genScript) {
  const fixed = String(cfg?.wake?.outFile || '').trim()
  if (fixed) return fixed
  const root = typeof genScript === 'string' ? resolve(genScript, '..', '..') : (workspaceOf(cfg) || BUNDLED_VOICE)
  return join(root, 'models', 'keywords.generated.txt')
}

/**
 * 校验并规范化词表。
 * 返回 { words, dropped: [{ word, reason }] }，**永远不抛**——侧栏输入什么都能存。
 */
export function normalizeWords(input, cfg) {
  const maxWords = Math.max(1, Number(cfg?.wake?.maxWords) || 12)
  const maxChars = Math.max(2, Number(cfg?.wake?.maxWordChars) || 12)

  const raw = Array.isArray(input)
    ? input
    : String(input ?? '')
        // 中英文逗号、分号、换行都当分隔符：侧栏是 textarea，用户会各种贴法
        .split(/[,，;；\n\r]+/)

  const seen = new Set()
  const words = []
  const dropped = []

  for (const item of raw) {
    const w = String(item ?? '').trim()
    if (!w) continue
    if (w.length > maxChars) {
      dropped.push({ word: w.slice(0, 20), reason: `超过 ${maxChars} 字` })
      continue
    }
    if (seen.has(w)) continue
    if (words.length >= maxWords) {
      dropped.push({ word: w, reason: `超过 ${maxWords} 个上限` })
      continue
    }
    seen.add(w)
    words.push(w)
  }

  return { words, dropped }
}

/** 跑一次生成器。返回 { ok, lines, errors, stderr, ms }，不抛。 */
export function compileKeywords(cfg, log) {
  const script = resolveGenScript(cfg)
  if (typeof script !== 'string') {
    log?.warn?.('唤醒词：' + script.error)
    return Promise.resolve({ ok: false, reason: script.error, lines: [], errors: [] })
  }

  const python = resolvePython(cfg, script)
  if (typeof python !== 'string') {
    log?.warn?.('唤醒词：' + python.error)
    return Promise.resolve({ ok: false, reason: python.error, lines: [], errors: [] })
  }

  const out = resolveOutFile(cfg, script)
  const words = (cfg?.wake?.words || []).join(',')

  if (!words) {
    return Promise.resolve({ ok: false, reason: '没有唤醒词', lines: [], errors: [] })
  }

  const started = Date.now()
  const args = [script, '--words', words, '--out', out, '--json']

  return new Promise((resolvePromise) => {
    execFile(
      python,
      args,
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const ms = Date.now() - started
        let parsed = null
        try {
          // 生成器 --json 会打一行 JSON；前面可能有 python 的其它输出，取最后一行能解析的
          for (const line of String(stdout || '').trim().split(/\r?\n/).reverse()) {
            try { parsed = JSON.parse(line); break } catch (e) { /* 继续往上找 */ }
          }
        } catch (e) { /* 忽略 */ }

        if (error && !parsed) {
          const reason = String(stderr || error.message || '').trim().slice(0, 400) || '生成器执行失败'
          log?.warn?.(`唤醒词编译失败：${reason}`)
          return resolvePromise({ ok: false, reason, lines: [], errors: [], stderr: String(stderr || '').slice(0, 400), ms, python, script, out })
        }

        const lines = Array.isArray(parsed?.lines) ? parsed.lines : []
        const errors = Array.isArray(parsed?.errors) ? parsed.errors : []
        const ok = parsed ? parsed.ok !== false && lines.length > 0 : lines.length > 0

        if (ok) log?.info?.(`唤醒词已编译：${lines.length} 条 → ${out}（${ms}ms）`)
        else log?.warn?.('唤醒词编译没产出：' + (errors.join('; ') || parsed?.reason || '未知'))

        resolvePromise({ ok, lines, errors, ms, python, script, out, stderr: String(stderr || '').slice(0, 400) })
      }
    )
  })
}

/** 读生成产物现状（给侧栏显示"当前生效的是什么"）。 */
export function readCompiled(cfg) {
  const script = resolveGenScript(cfg)
  if (typeof script !== 'string') return { exists: false, error: script.error }
  const out = resolveOutFile(cfg, script)

  if (!existsSync(out)) return { exists: false, file: out }
  try {
    const st = statSync(out)
    const text = readFileSync(out, 'utf8')
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    return {
      exists: true,
      file: out,
      bytes: st.size,
      modifiedAt: st.mtimeMs,
      lines,
      // 带 BOM 会让 sherpa 报 "Cannot find ID for token ﻿d"，这里显式暴露出来
      hasBom: readFileSync(out).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
      count: lines.length
    }
  } catch (error) {
    return { exists: false, file: out, error: String(error?.message ?? error) }
  }
}

/** 侧栏要用的一份汇总状态。 */
export function wakeStatus(cfg) {
  const script = resolveGenScript(cfg)
  const compiled = readCompiled(cfg)
  return {
    enabled: cfg?.wake?.enabled !== false,
    words: Array.isArray(cfg?.wake?.words) ? cfg.wake.words : [],
    genScript: typeof script === 'string' ? script : null,
    genScriptError: typeof script === 'string' ? null : script.error,
    python: typeof script === 'string' ? resolvePython(cfg, script) : null,
    compiled
  }
}

export { dirname, homedir }
