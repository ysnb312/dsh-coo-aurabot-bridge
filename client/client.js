// dsh-coo-aurabot-bridge · 网页半边（侧栏入口 + 整页面板）
//
// 只做两件事：
//   1. 在侧栏「自动化任务」区注册一个入口（插槽 sidebar.panellist）
//   2. 提供一个面板：改唤醒词、看编译结果、开关三条链路
//
// 全部数据都走宿主半边的 HTTP 接口（/api/dsh-coo-aurabot-bridge/*），
// 浏览器这边不碰麦克风、不碰 QQ、不碰文件系统。
//
// 写法对齐 DSH 自带插件与 dsh-aurabot-qq：window.__ModuleLoader__ 协议 + slots API。

window.__ModuleLoader__.load({
  id: 'dsh-coo-aurabot-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    const inject = ['slots']
    const PANEL_ID = 'coo-aurabot-bridge'
    const API = '/api/dsh-coo-aurabot-bridge'

    // ---------------- 接口 ----------------
    const get = (p) =>
      fetch(API + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))

    const post = (p, body) =>
      fetch(API + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))

    // ---------------- 视觉常量（跟 DSH 主题走） ----------------
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      text3: 'var(--dsw-alias-label-tertiary)',
      bgBase: 'var(--dsw-alias-bg-base)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)'
    }

    const card = {
      background: C.bg1,
      border: '1px solid ' + C.border,
      borderRadius: 10,
      padding: 14,
      marginBottom: 0,
      minWidth: 0
    }

    // 横向排布：卡片按可用宽度自动折行，宽屏一行能并两三张
    const gridStyle = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))',
      gap: 14,
      alignItems: 'start'
    }

    const fullWidth = { gridColumn: '1 / -1', minWidth: 0 }

    const label = { fontSize: 12, color: C.text2, marginBottom: 6, display: 'block' }
    const hint = { fontSize: 11.5, color: C.text3, lineHeight: 1.6, marginTop: 6 }

    // ---------------- 小控件 ----------------
    function Btn({ children, onClick, disabled, kind, small }) {
      const primary = kind === 'primary'
      const danger = kind === 'danger'
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled: !!disabled,
          style: {
            padding: small ? '4px 10px' : '7px 14px',
            fontSize: small ? 12 : 13,
            borderRadius: 7,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            border: '1px solid ' + (primary ? 'transparent' : C.border2),
            background: primary ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'transparent',
            color: primary ? '#fff' : danger ? C.err : C.text,
            fontWeight: primary ? 550 : 400,
            transition: 'opacity .15s'
          }
        },
        children
      )
    }

    function Toggle({ checked, onChange, title, desc, warnOn }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '9px 0',
            borderTop: '1px solid ' + C.border
          }
        },
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': !!checked,
            onClick: () => onChange(!checked),
            style: {
              flex: '0 0 auto',
              marginTop: 1,
              width: 34,
              height: 19,
              borderRadius: 19,
              border: 'none',
              cursor: 'pointer',
              position: 'relative',
              background: checked ? (warnOn ? C.warn : C.ok) : C.border2,
              transition: 'background .18s'
            }
          },
          h('span', {
            style: {
              position: 'absolute',
              top: 2,
              left: checked ? 17 : 2,
              width: 15,
              height: 15,
              borderRadius: '50%',
              background: '#fff',
              transition: 'left .18s'
            }
          })
        ),
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 13, color: C.text } }, title),
          desc ? h('div', { style: hint }, desc) : null
        )
      )
    }

    const inputStyle = {
      padding: '5px 8px',
      fontSize: 12.5,
      borderRadius: 6,
      border: '1px solid ' + C.border2,
      background: 'transparent',
      color: C.text,
      outline: 'none'
    }

    /** 一行「标题 + 说明 + 控件」，给非布尔的调参项用。 */
    function Row({ title, desc, children }) {
      return h(
        'div',
        { style: { padding: '9px 0', borderTop: '1px solid ' + C.border } },
        h('div', { style: { fontSize: 13, color: C.text } }, title),
        desc ? h('div', { style: hint }, desc) : null,
        children ? h('div', { style: { marginTop: 7 } }, children) : null
      )
    }

    /**
     * 文本/数字输入：**失焦或回车才提交**。
     * 边打边提交会每敲一个字符写一次 config.json，还会把光标位置冲掉。
     */
    function TextField({ value, onCommit, placeholder, type, width, step, min }) {
      const [v, setV] = useState(value == null ? '' : String(value))
      const focused = useRef(false)
      useEffect(() => {
        if (!focused.current) setV(value == null ? '' : String(value))
      }, [value])
      return h('input', {
        type: type || 'text',
        step,
        min,
        value: v,
        placeholder: placeholder || '',
        onFocus: () => { focused.current = true },
        onChange: (e) => setV(e.target.value),
        onBlur: () => { focused.current = false; onCommit(v) },
        onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
        style: { ...inputStyle, width: width || 180 }
      })
    }

    function Select({ value, options, onChange, width }) {
      return h(
        'select',
        { value: value == null ? '' : String(value), onChange: (e) => onChange(e.target.value), style: { ...inputStyle, width: width || 180 } },
        options.map((o) => h('option', { key: o[0], value: o[0] }, o[1]))
      )
    }

    /** 把 ['a','b'] + 值 变成 { a: { b: value } }，配合深合并的 /config。 */
    function buildPatch(path, value) {
      const out = {}
      let cur = out
      path.forEach((k, i) => {
        if (i === path.length - 1) cur[k] = value
        else { cur[k] = {}; cur = cur[k] }
      })
      return out
    }

    function Badge({ kind, children }) {
      const color = kind === 'ok' ? C.ok : kind === 'warn' ? C.warn : kind === 'err' ? C.err : C.text3
      return h(
        'span',
        {
          style: {
            fontSize: 11,
            padding: '1px 7px',
            borderRadius: 20,
            color,
            border: '1px solid ' + color,
            whiteSpace: 'nowrap'
          }
        },
        children
      )
    }

    const timeAgo = (t) => {
      if (!t) return '—'
      const s = Math.round((Date.now() - t) / 1000)
      if (s < 60) return '刚刚'
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
      return Math.floor(s / 86400) + ' 天前'
    }

    // ---------------- 唤醒词区块 ----------------
    function WakeSection({ onToast, onChanged }) {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [compiling, setCompiling] = useState(false)
      const [result, setResult] = useState(null)
      const loadedRef = useRef(false)

      const load = useCallback(async () => {
        const r = await get('/wakewords')
        setState(r)
        // 只在首次加载时填充输入框，避免轮询把用户正在敲的字冲掉
        if (!loadedRef.current && Array.isArray(r?.words)) {
          setDraft(r.words.join('\n'))
          loadedRef.current = true
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const save = async (regenerate) => {
        const words = draft
          .split(/[,，;；\n\r]+/)
          .map((s) => s.trim())
          .filter(Boolean)

        if (words.length === 0) {
          onToast('至少要留一个唤醒词', 'err')
          return
        }

        setBusy(true)
        if (regenerate) setCompiling(true)
        const r = await post('/wakewords', { words })
        setBusy(false)
        setCompiling(false)

        if (r?.ok) {
          setState(r)
          setResult(r.compiled || null)
          const dropped = Array.isArray(r.dropped) && r.dropped.length ? `（忽略 ${r.dropped.length} 条）` : ''
          const n = r.compiled?.lines?.length ?? 0
          onToast(r.compiled?.ok ? `已保存并编译 ${n} 条唤醒词${dropped}` : '已保存，但编译失败，见下方原因', r.compiled?.ok ? 'ok' : 'err')
          onChanged && onChanged()
        } else {
          onToast(r?.message || r?.reason || '保存失败', 'err')
        }
      }

      if (!state) {
        return h('div', { style: { ...card, color: C.text3, fontSize: 13 } }, '加载中…')
      }

      const compiled = state.compiled || {}
      const okCompiled = compiled.exists && (compiled.count || 0) > 0

      return h(
        'div',
        { style: card },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text } }, '唤醒词'),
          okCompiled
            ? h(Badge, { kind: 'ok' }, `${compiled.count} 条已生效`)
            : h(Badge, { kind: 'warn' }, '尚未编译'),
          compiled.hasBom ? h(Badge, { kind: 'err' }, '文件带 BOM') : null,
          h('span', { style: { marginLeft: 'auto', fontSize: 11.5, color: C.text3 } }, '编译于 ' + timeAgo(compiled.modifiedAt))
        ),

        h('label', { style: label }, '喊这些词能唤醒（一行一个，也可用逗号分隔）'),
        h('textarea', {
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          rows: 4,
          spellCheck: false,
          placeholder: '大飞鱼\n大肥鱼\n肥鱼',
          style: {
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            padding: '8px 10px',
            fontSize: 13,
            lineHeight: 1.7,
            borderRadius: 8,
            border: '1px solid ' + C.border2,
            background: C.bgBase,
            color: C.text,
            fontFamily: 'inherit',
            outline: 'none'
          }
        }),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h(Btn, { onClick: () => save(true), disabled: busy || compiling, kind: 'primary' }, compiling ? '正在编译…' : '保存并编译'),
          h(Btn, { onClick: load, disabled: busy, small: true }, '刷新'),
          h('span', { style: { marginLeft: 'auto', fontSize: 11.5, color: C.text3 } },
            compiled.file ? compiled.file.replace(/^.*[\\/]/, '') : '—')
        ),

        // 编译失败时把真实原因摊开：多半是「路径不对」或「venv 里没装 pypinyin」
        result && result.ok === false
          ? h(
              'div',
              { style: { ...hint, color: C.err, marginTop: 8 } },
              '编译失败：' + (result.reason || (result.errors || []).join('; ') || '未知原因')
            )
          : null,

        state.genScriptError
          ? h('div', { style: { ...hint, color: C.err } }, state.genScriptError)
          : null,

        h(
          'div',
          { style: hint },
          '存的是中文词；真正的 KWS 关键词是「带调拼音」，由 ',
          h('code', { style: { fontSize: 11 } }, 'scripts/gen_keywords.py'),
          ' 用 pypinyin + 模型 tokens.txt 编译。保存后语音脚本会在几秒内自动重载，不用重启。'
        ),

        okCompiled
          ? h(
              'details',
              { style: { marginTop: 8 } },
              h('summary', { style: { fontSize: 11.5, color: C.text3, cursor: 'pointer' } }, '看看编译出来的拼音串'),
              h(
                'pre',
                {
                  style: {
                    marginTop: 6,
                    padding: 8,
                    background: C.bg2,
                    borderRadius: 6,
                    fontSize: 11,
                    color: C.text2,
                    overflowX: 'auto',
                    whiteSpace: 'pre'
                  }
                },
                (compiled.lines || []).join('\n')
              )
            )
          : null
      )
    }

    // ---------------- 主面板 ----------------
    function BridgePage() {
      const [status, setStatus] = useState(null)
      const [toast, setToast] = useState(null)
      const [busyKey, setBusyKey] = useState('')

      const showToast = useCallback((text, kind) => {
        setToast({ text, kind: kind || 'ok' })
        setTimeout(() => setToast(null), 3800)
      }, [])

      const loadStatus = useCallback(async () => {
        const r = await get('/status')
        setStatus(r)
      }, [])

      useEffect(() => {
        loadStatus()
        const t = setInterval(loadStatus, 8000)
        return () => clearInterval(t)
      }, [loadStatus])

      // 开关都写进 /config（深合并），宿主侧 cfg 是同一份引用，立即生效
      const patch = async (body, key, okMsg) => {
        setBusyKey(key)
        const r = await post('/config', body)
        setBusyKey('')
        if (r?.ok) {
          showToast(okMsg || '已保存', 'ok')
          loadStatus()
        } else {
          showToast(r?.reason || '保存失败', 'err')
        }
      }

      // 用 /voice-input 直接喂一句话，等效"对着麦克风说了一句"
      const testVoice = async () => {
        const r = await post('/voice-input', { text: '这是一条来自侧栏的语音测试' })
        if (r?.ok) showToast('已注入桌宠（' + (r.via || 'ok') + '）', 'ok')
        else showToast('注入失败：' + (r?.detail || r?.reason || '未知'), 'err')
      }

      // 试听：打 /tts 拿音频字节，浏览器这边直接播（跟桌宠同一套合成）
      const [ttsText, setTtsText] = useState('嘿嘿，我是大肥鱼，今天也吃白米饭！')
      const testTts = async () => {
        const text = String(ttsText || '').trim()
        if (!text) return showToast('先写点要念的字', 'err')
        setBusyKey('tts')
        try {
          const res = await fetch(API + '/tts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text })
          })
          if (!res.ok) {
            let msg = '合成失败'
            try { const j = await res.json(); msg += '：' + (j.message || j.reason || '') } catch (e) { /* 非 JSON */ }
            showToast(msg, 'err')
            return
          }
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const el = new Audio(url)
          el.onended = () => URL.revokeObjectURL(url)
          await el.play()
          showToast('念好了（' + Math.round(blob.size / 1024) + ' KB）', 'ok')
        } catch (error) {
          showToast('放不出来：' + (error?.message || '未知'), 'err')
        } finally {
          setBusyKey('')
          loadStatus()
        }
      }

      const tts = status?.tts || {}
      const speak = status?.speak || {}

      const gates = status?.gates || {}
      const au = status?.aurabot || {}
      const wakeOn = status?.wake?.enabled !== false

      return h(
        'div',
        { style: { padding: '18px 20px', maxWidth: 1180, margin: '0 auto', height: '100%', overflowY: 'auto', boxSizing: 'border-box' } },

        // 标题
        h(
          'div',
          { style: { marginBottom: 16 } },
          h('div', { style: { fontSize: 17, fontWeight: 650, color: C.text } }, '肥鱼语音'),
          h(
            'div',
            { style: { fontSize: 12, color: C.text2, marginTop: 4, lineHeight: 1.6 } },
            '桌宠 ⇄ QQ 双向桥接，外加一副本地耳朵（sherpa-onnx 唤醒 + faster-whisper 转写）。'
          )
        ),

        // 卡片区：横向网格，宽屏一行并两三张，窄屏自动折成一列
        h(
          'div',
          { style: gridStyle },

          // 连接状态条
          h(
            'div',
            { style: { ...card, gridColumn: '1 / -1', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 } },
          h('span', { style: { color: C.text2 } }, 'QQ 插件 ',
            h(Badge, { kind: au.available ? 'ok' : 'warn' }, au.available ? '在线' : '未装')),
          h('span', { style: { color: C.text2 } }, '总开关 ',
            h(Badge, { kind: au.enabled ? 'ok' : 'warn' }, au.enabled ? '开' : '关')),
          h('span', { style: { color: C.text2 } }, '桌宠 ',
            h(Badge, { kind: status?.coopanion?.ok ? 'ok' : 'warn' }, status?.coopanion?.ok ? '可达' : '不可达')),
          h('span', { style: { marginLeft: 'auto', color: C.text3 } }, status?.baseUrl || '')
        ),

        // 唤醒词
        h(WakeSection, { onToast: showToast, onChanged: loadStatus }),

        // 链路开关
        h(
          'div',
          { style: card },
          h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text, marginBottom: 2 } }, '链路开关'),

          h(Toggle, {
            checked: gates.tts !== false,
            onChange: (v) => patch(
              { tts: { enabled: v }, speak: { enabled: v } },
              'talk',
              v ? '桌宠会说话了' : '桌宠安静了（只出气泡）'
            ),
            title: '桌宠说话（总闸）',
            desc: '一关就全静：不念我的回复，她自己也不出声。开着她才有声音——这就是「她会不会说话」那把闸'
          }),

          h(Toggle, {
            checked: (status?.config?.voiceInput?.voiceRoute ?? 'aurabot') === 'aurabot',
            onChange: (v) => patch(
              { voiceInput: { voiceRoute: v ? 'aurabot' : 'pet' } },
              'route',
              v ? '一个脑子：语音喂进 QQ 会话' : '两个脑子：语音喂进桌宠会话'
            ),
            title: '只留一个脑子（推荐开）',
            desc: '开：喊醒后的话直接进 QQ 那个会话，回答由 QQ 这一侧发给你，桌宠只负责显示和出声。关：沿用旧做法，另开一个桌宠会话——那就是之前两个 AI 一起答的原因'
          }),

          h(Toggle, {
            checked: wakeOn,
            warnOn: false,
            onChange: (v) => patch({ wake: { enabled: v } }, 'wake', v ? '唤醒词已启用' : '唤醒词已停用'),
            title: '唤醒词（耳朵）',
            desc: '关掉后语音脚本仍能转写，但不再识别唤醒词'
          }),

          h(Toggle, {
            checked: gates.voiceInput !== false,
            onChange: (v) => patch({ voiceInput: { enabled: v } }, 'vi', v ? '语音输入口已开' : '语音输入口已关'),
            title: '语音输入口 /voice-input',
            desc: '本机令牌校验；关掉后脚本投递会被 403 拒绝'
          }),

          h(Toggle, {
            checked: gates.q2p !== false,
            onChange: (v) => patch({ q2p: { enabled: v } }, 'q2p', v ? 'QQ → 桌宠已开' : 'QQ → 桌宠已关'),
            title: 'QQ → 桌宠',
            desc: '仅主人私聊；群聊与陌生人默认永远不进来'
          }),

          h(Toggle, {
            checked: gates.aToQ === true,
            warnOn: true,
            onChange: (v) => {
              if (v && !window.confirm('打开后，桌宠的回复会真的发到你的 QQ。\n\n确定要开吗？')) return
              patch({ aToQ: { enabled: v } }, 'a2q', v ? '桌宠 → QQ 已开' : '桌宠 → QQ 已关')
            },
            title: '桌宠 → QQ（会真的发出去）',
            desc: '默认关。开着时她说的每句话都会进 QQ，会花钱也会吵'
          }),

          h(Toggle, {
            checked: status?.config?.aToQ?.asVoice !== false,
            onChange: (v) => patch({ aToQ: { asVoice: v } }, 'voice', v ? '回复发语音条' : '回复发文字'),
            title: '回复包成语音条',
            desc: '给她的话套 <voice> 标签，QQ 侧转成语音；超过字数上限自动退回文字'
          })
        ),

        // 全部参数（调试用）：config.json 里每一个可调项在这里都有一个控件
        (() => {
          const c = status?.config || {}
          const L = (...p) => p.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), c)
          const P = (path, value, msg) => patch(buildPatch(path, value), path.join('.'), msg || '已保存')
          return h(
            'details',
            { style: { ...card, ...fullWidth } },
            h(
              'summary',
              { style: { fontSize: 13.5, fontWeight: 600, color: C.text, cursor: 'pointer' } },
              '全部参数（调试用）'
            ),
            h('div', { style: hint }, '上面那些开关只是常用的几个；这里是 config.json 的全量，改完立刻生效。'),

            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginTop: 12 } }, '语音输入'),

            h(Row, {
              title: '目标聊天（voiceTarget）',
              desc: '语音喂给哪个 QQ 会话；空 = 自动用主人私聊 private:<主人QQ>'
            }, h(TextField, {
              value: L('voiceInput', 'voiceTarget'),
              placeholder: 'private:3358492095',
              width: 240,
              onCommit: (v) => P(['voiceInput', 'voiceTarget'], String(v || '').trim())
            })),

            h(Row, {
              title: '单条上限 voiceInput.maxChars',
              desc: '超过就截断，和桌宠自己的 500 对齐'
            }, h(TextField, {
              value: L('voiceInput', 'maxChars'),
              type: 'number',
              min: 20,
              width: 100,
              onCommit: (v) => P(['voiceInput', 'maxChars'], Math.max(20, Number(v) || 500))
            })),

            h(Row, {
              title: '注入方式 voiceInput.deliver',
              desc: '只在「两个脑子」模式下有用：chat-send 指定会话，followup 走当前活跃 agent'
            }, h(Select, {
              value: L('voiceInput', 'deliver') || 'auto',
              options: [['auto', 'auto（自动）'], ['chat-send', 'chat-send'], ['followup', 'followup']],
              onChange: (v) => P(['voiceInput', 'deliver'], v)
            })),

            h(Row, {
              title: '指定会话 voiceInput.sessionId',
              desc: '只在「两个脑子」模式 + chat-send 时有用；现在是：' + (L('voiceInput', 'sessionId') || '空')
            }, h(TextField, {
              value: L('voiceInput', 'sessionId'),
              placeholder: 'session-…',
              width: 300,
              onCommit: (v) => P(['voiceInput', 'sessionId'], String(v || '').trim())
            })),

            h(Toggle, {
              checked: L('voiceInput', 'wakeWordEcho') !== false,
              onChange: (v) => P(['voiceInput', 'wakeWordEcho'], v, v ? '唤醒会应答' : '唤醒不应答'),
              title: '唤醒应答 voiceInput.wakeWordEcho',
              desc: '喊醒时她说一句「我在」，不触发 LLM'
            }),

            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginTop: 14 } }, '桌宠 → QQ'),

            h(Row, {
              title: '转发目标 aToQ.target',
              desc: '空 = private:<主人QQ>，由 aurabot 自己解析'
            }, h(TextField, {
              value: L('aToQ', 'target'),
              placeholder: 'private:3358492095',
              width: 240,
              onCommit: (v) => P(['aToQ', 'target'], String(v || '').trim())
            })),

            h(Row, {
              title: '白名单会话 aToQ.sessionIds',
              desc: '只转发这些会话的回复，一行一个；空 = 只转语音输入绑定的那个'
            }, h(TextField, {
              value: (L('aToQ', 'sessionIds') || []).join(','),
              placeholder: 'session-…',
              width: 300,
              onCommit: (v) => P(['aToQ', 'sessionIds'], String(v || '').split(/[,\s]+/).filter(Boolean))
            })),

            h(Toggle, {
              checked: L('aToQ', 'autoBindVoice') !== false,
              onChange: (v) => P(['aToQ', 'autoBindVoice'], v),
              title: '自动绑定语音会话 aToQ.autoBindVoice',
              desc: '语音输入用过的会话自动进运行时白名单（不写盘）'
            }),

            h(Row, {
              title: '语音条字数上限 aToQ.voiceMaxChars',
              desc: '超过这个字数就退回文字（语音条念不完）'
            }, h(TextField, {
              value: L('aToQ', 'voiceMaxChars'),
              type: 'number',
              min: 20,
              width: 100,
              onCommit: (v) => P(['aToQ', 'voiceMaxChars'], Math.max(20, Number(v) || 120))
            })),

            h(Toggle, {
              checked: L('aToQ', 'stripMarkdown') !== false,
              onChange: (v) => P(['aToQ', 'stripMarkdown'], v),
              title: '去掉 markdown 记号 aToQ.stripMarkdown',
              desc: '把 ** 加粗、` 代码、列表符清掉再发'
            }),

            h(Toggle, {
              checked: L('aToQ', 'repliesOnly') !== false,
              onChange: (v) => P(['aToQ', 'repliesOnly'], v),
              title: '只转最终回复 aToQ.repliesOnly',
              desc: '不转发工具调用的中间态'
            }),

            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginTop: 14 } }, 'QQ → 桌宠'),

            h(Toggle, {
              checked: L('q2p', 'ownerOnly') !== false,
              onChange: (v) => P(['q2p', 'ownerOnly'], v),
              title: '只认主人 q2p.ownerOnly',
              desc: '关掉后陌生人私聊也会进来（不建议）'
            }),

            h(Toggle, {
              checked: L('q2p', 'allowGroups') === true,
              warnOn: true,
              onChange: (v) => P(['q2p', 'allowGroups'], v),
              title: '允许群聊 q2p.allowGroups',
              desc: '默认不许。开了群里每句话都会喂给她'
            }),

            h(Row, {
              title: '单条上限 q2p.maxChars',
              desc: 'QQ 那边一句话超过这个长度就截断'
            }, h(TextField, {
              value: L('q2p', 'maxChars'),
              type: 'number',
              min: 20,
              width: 100,
              onCommit: (v) => P(['q2p', 'maxChars'], Math.max(20, Number(v) || 300))
            })),

            h(Row, {
              title: '注入形态 q2p.mode',
              desc: 'inject = 当作主人说的话走一轮；say = 只念出来不思考'
            }, h(Select, {
              value: L('q2p', 'mode') || 'inject',
              options: [['inject', 'inject（走一轮对话）'], ['say', 'say（只念）']],
              onChange: (v) => P(['q2p', 'mode'], v)
            })),

            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginTop: 14 } }, '唤醒词编译'),

            h(Toggle, {
              checked: L('wake', 'autoGenerate') !== false,
              onChange: (v) => P(['wake', 'autoGenerate'], v),
              title: '启动时自动编译 wake.autoGenerate',
              desc: '改了词表就重新生成 keywords.generated.txt'
            }),

            h(Row, {
              title: '词数上限 wake.maxWords',
              desc: '防止手滑贴进来一整篇文章'
            }, h(TextField, {
              value: L('wake', 'maxWords'),
              type: 'number',
              min: 1,
              width: 100,
              onCommit: (v) => P(['wake', 'maxWords'], Math.max(1, Number(v) || 12))
            })),

            h(Row, {
              title: '单词字数上限 wake.maxWordChars',
              desc: '单个唤醒词最长几个字'
            }, h(TextField, {
              value: L('wake', 'maxWordChars'),
              type: 'number',
              min: 2,
              width: 100,
              onCommit: (v) => P(['wake', 'maxWordChars'], Math.max(2, Number(v) || 12))
            })),

            h(Row, {
              title: '语音工作区 wake.workspace',
              desc: '换机器必填：里面要有 scripts/gen_keywords.py 和 models/。空 = 出厂默认路径'
            }, h(TextField, {
              value: L('wake', 'workspace'),
              placeholder: '自动',
              width: 340,
              onCommit: (v) => P(['wake', 'workspace'], String(v || '').trim())
            })),

            h(Row, {
              title: '编译脚本 wake.genScript',
              desc: '空 = 自动探测 scripts/gen_keywords.py'
            }, h(TextField, {
              value: L('wake', 'genScript'),
              placeholder: '自动',
              width: 340,
              onCommit: (v) => P(['wake', 'genScript'], String(v || '').trim())
            })),

            h(Row, {
              title: '编译用的解释器 wake.pythonPath',
              desc: '空 = 自动探测 .venv-voice（要装了 pypinyin）'
            }, h(TextField, {
              value: L('wake', 'pythonPath'),
              placeholder: '自动',
              width: 340,
              onCommit: (v) => P(['wake', 'pythonPath'], String(v || '').trim())
            })),

            h(Row, {
              title: '产物路径 wake.outFile',
              desc: '空 = <工作区>/models/keywords.generated.txt'
            }, h(TextField, {
              value: L('wake', 'outFile'),
              placeholder: '自动',
              width: 340,
              onCommit: (v) => P(['wake', 'outFile'], String(v || '').trim())
            })),

            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginTop: 14 } }, '说话（TTS）'),

            h(Row, {
              title: 'edge-tts 解释器 tts.pythonPath',
              desc: '空 = 自动探测；当前用的是 ' + (tts.python || '（没找到）')
            }, h(TextField, {
              value: L('tts', 'pythonPath'),
              placeholder: '自动',
              width: 340,
              onCommit: (v) => P(['tts', 'pythonPath'], String(v || '').trim())
            })),

            h(Row, {
              title: '语速 tts.rate',
              desc: "edge-tts 格式，比如 +10% / -5%；空 = 默认"
            }, h(TextField, {
              value: L('tts', 'rate'),
              placeholder: '+0%',
              width: 120,
              onCommit: (v) => P(['tts', 'rate'], String(v || '').trim())
            })),

            h(Row, {
              title: '音量 tts.volume',
              desc: 'edge-tts 格式，比如 +10% / -20%；空 = 默认'
            }, h(TextField, {
              value: L('tts', 'volume'),
              placeholder: '+0%',
              width: 120,
              onCommit: (v) => P(['tts', 'volume'], String(v || '').trim())
            })),

            h(Row, {
              title: '音高 tts.pitch',
              desc: 'edge-tts 格式，比如 +0Hz / -10Hz；空 = 默认'
            }, h(TextField, {
              value: L('tts', 'pitch'),
              placeholder: '+0Hz',
              width: 120,
              onCommit: (v) => P(['tts', 'pitch'], String(v || '').trim())
            })),

            h(Row, {
              title: '合成字数上限 tts.maxChars',
              desc: '超过就拒绝（和桌宠的 500 对齐）'
            }, h(TextField, {
              value: L('tts', 'maxChars'),
              type: 'number',
              min: 20,
              width: 100,
              onCommit: (v) => P(['tts', 'maxChars'], Math.max(20, Number(v) || 500))
            })),

            h(Row, {
              title: '合成超时 tts.timeoutMs',
              desc: '一次合成最多等多久（毫秒）'
            }, h(TextField, {
              value: L('tts', 'timeoutMs'),
              type: 'number',
              min: 3000,
              step: 1000,
              width: 120,
              onCommit: (v) => P(['tts', 'timeoutMs'], Math.max(3000, Number(v) || 20000))
            })),

            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginTop: 14 } }, '念白（回复→桌宠朗读）'),

            h(Row, {
              title: '总开关 speak.enabled',
              desc: '开着我回你的话会送一份给桌宠念'
            }, h(Toggle, {
              checked: !!status?.speak?.enabled,
              onChange: (v) => P(['speak', 'enabled'], v),
              title: ''
            })),

            h(Row, {
              title: '只念私聊 speak.ownerOnly',
              desc: '关掉后群里的回复也念'
            }, h(Toggle, {
              checked: L('speak', 'ownerOnly') !== false,
              onChange: (v) => P(['speak', 'ownerOnly'], v),
              title: ''
            })),

            h(Row, {
              title: '截断长度 speak.maxChars',
              desc: '一段话最多念多少字'
            }, h(TextField, {
              value: L('speak', 'maxChars'),
              type: 'number',
              min: 10,
              step: 10,
              width: 100,
              onCommit: (v) => P(['speak', 'maxChars'], Math.max(10, Number(v) || 150))
            })),

            h(Row, {
              title: '去 Markdown speak.stripMarkdown',
              desc: '念之前把星号井号去掉'
            }, h(Toggle, {
              checked: L('speak', 'stripMarkdown') !== false,
              onChange: (v) => P(['speak', 'stripMarkdown'], v),
              title: ''
            })),

            h(Row, {
              title: '要中文 speak.requireChinese',
              desc: '没有汉字的就不念'
            }, h(Toggle, {
              checked: L('speak', 'requireChinese') !== false,
              onChange: (v) => P(['speak', 'requireChinese'], v),
              title: ''
            })),

            h(Row, {
              title: '朗读间隔 speak.minIntervalMs',
              desc: '两次朗读之间至少隔这么久（毫秒）'
            }, h(TextField, {
              value: L('speak', 'minIntervalMs'),
              type: 'number',
              min: 0,
              step: 100,
              width: 120,
              onCommit: (v) => P(['speak', 'minIntervalMs'], Math.max(0, Number(v) || 0))
            })),

            h(Row, {
              title: '朗读超时 speak.timeoutMs',
              desc: '合成+播放，等多久算失败（毫秒）'
            }, h(TextField, {
              value: L('speak', 'timeoutMs'),
              type: 'number',
              min: 3000,
              step: 1000,
              width: 120,
              onCommit: (v) => P(['speak', 'timeoutMs'], Math.max(3000, Number(v) || 30000))
            })),

            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginTop: 14 } }, '耳朵（进程与节流）'),

            h(Row, {
              title: '语音工作区 listen.workspace',
              desc: '换机器必填：里面要有 scripts/voice_assistant.py、models/ 和 .venv-voice。空 = 出厂默认路径'
            }, h(TextField, {
              value: L('listen', 'workspace'),
              placeholder: '自动',
              width: 340,
              onCommit: (v) => P(['listen', 'workspace'], String(v || '').trim())
            })),

            h(Row, {
              title: '脚本路径 listen.scriptPath',
              desc: '空 = <工作区>/scripts/voice_assistant.py'
            }, h(TextField, {
              value: L('listen', 'scriptPath'),
              placeholder: '自动',
              width: 340,
              onCommit: (v) => P(['listen', 'scriptPath'], String(v || '').trim())
            })),

            h(Row, {
              title: '解释器 listen.pythonPath',
              desc: '空 = 自动探测 <工作区>/.venv-voice'
            }, h(TextField, {
              value: L('listen', 'pythonPath'),
              placeholder: '自动',
              width: 340,
              onCommit: (v) => P(['listen', 'pythonPath'], String(v || '').trim())
            })),

            h(Toggle, {
              checked: L('listen', 'autoRestart') !== false,
              onChange: (v) => P(['listen', 'autoRestart'], v),
              title: '崩了自动重拉 listen.autoRestart',
              desc: '关掉后进程一崩就躺平，等你手动点「重启耳朵」'
            }),

            h(Row, {
              title: '重拉上限 listen.maxRestarts',
              desc: '拉这么多次还崩就一直停着'
            }, h(TextField, {
              value: L('listen', 'maxRestarts'),
              type: 'number',
              min: 0,
              width: 100,
              onCommit: (v) => P(['listen', 'maxRestarts'], Math.max(0, Number(v) || 0))
            })),

            h(Row, {
              title: '重拉间隔 listen.restartDelayMs',
              desc: '两次重拉之间等多久（毫秒）'
            }, h(TextField, {
              value: L('listen', 'restartDelayMs'),
              type: 'number',
              min: 500,
              step: 500,
              width: 120,
              onCommit: (v) => P(['listen', 'restartDelayMs'], Math.max(500, Number(v) || 5000))
            })),

            h(Toggle, {
              checked: L('listen', 'resumeOnActivity') !== false,
              onChange: (v) => P(['listen', 'resumeOnActivity'], v),
              title: '有动静就恢复 listen.resumeOnActivity',
              desc: '暂停后一有键鼠输入就自动接着听'
            }),

            h(Row, {
              title: '闸门轮询 listen.pollMs',
              desc: '多久查一次锁屏/闲置（毫秒），长一点省电'
            }, h(TextField, {
              value: L('listen', 'pollMs'),
              type: 'number',
              min: 200,
              step: 200,
              width: 120,
              onCommit: (v) => P(['listen', 'pollMs'], Math.max(200, Number(v) || 1000))
            })),

            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginTop: 14 } }, '节流与日志'),

            h(Row, {
              title: '复读间隔 minIntervalMs',
              desc: '同一条文本的最小重复间隔（毫秒）'
            }, h(TextField, {
              value: L('minIntervalMs'),
              type: 'number',
              min: 0,
              step: 100,
              width: 120,
              onCommit: (v) => P(['minIntervalMs'], Math.max(0, Number(v) || 0))
            })),

            h(Row, {
              title: '注入后静默 suppressReplyMs',
              desc: '一次注入后这段时间内不再转发回复（毫秒），防打乒乓'
            }, h(TextField, {
              value: L('suppressReplyMs'),
              type: 'number',
              min: 0,
              step: 1000,
              width: 120,
              onCommit: (v) => P(['suppressReplyMs'], Math.max(0, Number(v) || 0))
            })),

            h(Row, {
              title: '日志行数 logMaxLines',
              desc: 'bridge.log 最多留多少行'
            }, h(TextField, {
              value: L('logMaxLines'),
              type: 'number',
              min: 100,
              step: 100,
              width: 120,
              onCommit: (v) => P(['logMaxLines'], Math.max(100, Number(v) || 2000))
            })),

            h(Row, {
              title: '桌宠基址 coopanionBaseUrl',
              desc: '空 = 用宿主 webServer 的端口自动拼；现在解析成 ' + (status?.baseUrl || '？')
            }, h(TextField, {
              value: L('coopanionBaseUrl'),
              placeholder: '自动',
              width: 300,
              onCommit: (v) => P(['coopanionBaseUrl'], String(v || '').trim())
            }))
          )
        })(),

        // 耳朵（语音唤醒，插件托管）
        (() => {
          const l = status?.listen || {}
          const lg = l.gates || {}
          const hk = l.hotkey || {}
          const paused = l.gate?.state === 'paused'
          const listenOn = gates.listen !== false
          const doListen = async (action) => {
            setBusyKey('listen')
            const r = await post('/listen', { action })
            setBusyKey('')
            if (r?.ok) showToast(action === 'stop' ? '耳朵停了' : '耳朵' + (action === 'start' ? '起来了' : '重启了'), 'ok')
            else showToast(r?.message || r?.reason || '没成功', 'err')
            loadStatus()
          }
          return h(
            'div',
            { style: card },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 } },
              h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text } }, '耳朵（喊她名字）'),
              h(Badge, { kind: l.running ? (paused ? 'warn' : 'ok') : 'warn' },
                l.running ? (paused ? '暂停中' : '在听') : '没在跑')
            ),

            h(Toggle, {
              checked: listenOn,
              onChange: (v) => patch({ listen: { enabled: v } }, 'listenOn', v ? '耳朵已开' : '耳朵已关（不占麦克风）'),
              title: '托管语音脚本（不需要开 cmd 窗口）',
              desc: '由本插件 spawn，windowsHide；插件卸载会把它带走。关掉 = 一键闭嘴'
            }),

            h(Toggle, {
              checked: lg.pauseOnLock !== false,
              onChange: (v) => patch({ listen: { pauseOnLock: v } }, 'lk', v ? '锁屏就不听' : '锁屏也继续听'),
              title: '闸一：锁屏就停',
              desc: '锁屏/安全桌面时自动暂停，解锁后自己回来'
            }),

            h(Toggle, {
              checked: lg.pauseOnIdle !== false,
              onChange: (v) => patch({ listen: { pauseOnIdle: v } }, 'idl', v ? '闲置会停' : '闲置不停'),
              title: '闸二：闲置就停',
              desc: '长时间没动键鼠就不再听，避免白占资源'
            }),

            h(
              'div',
              { style: { marginTop: 8 } },
              h('span', { style: label }, '闲置多少分钟算久'),
              h('input', {
                type: 'number',
                min: 0.5,
                step: 0.5,
                value: lg.idleMinutes ?? 10,
                onChange: (e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v) && v >= 0.1) patch({ listen: { idleMinutes: v } }, 'idm', '闲置阈值 ' + v + ' 分钟')
                },
                style: {
                  width: 110,
                  padding: '7px 10px',
                  fontSize: 13,
                  borderRadius: 7,
                  color: C.text,
                  background: C.bg2,
                  border: '1px solid ' + C.border
                }
              })
            ),

            h(Toggle, {
              checked: lg.releaseMicOnPause !== false,
              onChange: (v) => patch({ listen: { releaseMicOnPause: v } }, 'rel', v ? '暂停时松开麦克风' : '暂停时仍占着麦克风'),
              title: '暂停时松开麦克风',
              desc: '开着更干净：暂停时设备管理器里也看不到占用'
            }),

            h(Toggle, {
              checked: lg.startWithPlugin !== false,
              onChange: (v) => patch({ listen: { startWithPlugin: v } }, 'swp', v ? '随插件起' : '不随插件起'),
              title: '随插件起（不用开 cmd）',
              desc: 'DSH 一启动她就在。关掉就只在你手动点的时候起'
            }),

            h(
              'div',
              { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + C.border } },
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                h(Btn, { onClick: () => doListen(l.running ? 'restart' : 'start'), disabled: busyKey === 'listen' || !listenOn, small: true, kind: 'primary' },
                  l.running ? '重启耳朵' : '现在开始听'),
                h(Btn, { onClick: () => doListen('stop'), disabled: busyKey === 'listen' || !l.running, small: true }, '闭嘴（停）'),
                h(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: C.text2, marginLeft: 'auto' } },
                  h('input', {
                    type: 'checkbox',
                    checked: hk.enabled !== false,
                    onChange: (e) => patch({ listen: { hotkey: { enabled: e.target.checked } } }, 'hk', e.target.checked ? '热键兜底已开' : '热键兜底已关')
                  }),
                  '热键兜底'
                )
              ),
              h(
                'div',
                { style: { marginTop: 8 } },
                h('span', { style: label }, '喊不出来时按这个键（等于喊一声）'),
                h('input', {
                  defaultValue: hk.combo || 'ctrl+alt+j',
                  onBlur: (e) => {
                    const v = String(e.target.value || '').trim()
                    if (v && v !== hk.combo) patch({ listen: { hotkey: { combo: v } } }, 'hkc', '热键改成 ' + v)
                  },
                  placeholder: 'ctrl+alt+j',
                  style: {
                    width: 180,
                    padding: '7px 10px',
                    fontSize: 13,
                    borderRadius: 7,
                    color: C.text,
                    background: C.bg2,
                    border: '1px solid ' + C.border
                  }
                })
              ),
              h(
                'div',
                { style: hint },
                (l.running ? 'pid ' + l.pid + '，已跑 ' + Math.round((l.uptimeMs || 0) / 60000) + ' 分钟' : '没在跑') +
                  (l.gate?.reason ? '　状态：' + l.gate.reason : '') +
                  (l.lastLine ? '　最近：' + l.lastLine : '') +
                  (l.lastError ? '　错误：' + l.lastError : '') +
                  (l.scriptError ? '　脚本：' + l.scriptError : '')
              ),
              h(
                'div',
                { style: hint },
                '脚本 ' + (l.script || l.scriptError || '探测中') + '　解释器 ' + (l.python || '探测中')
              )
            )
          )
        })(),

        // 出声（TTS）
        h(
          'div',
          { style: card },
          h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text, marginBottom: 2 } }, '说话（桌宠出声）'),

          h(Toggle, {
            checked: gates.tts !== false,
            onChange: (v) => patch({ tts: { enabled: v } }, 'tts', v ? '桌宠可以出声了' : '桌宠只出气泡'),
            title: '让桌宠说话',
            desc: '她在宿主里找不到 dsh-xiaomi-tts，这条路由由本插件补上，用的是本机 edge-tts'
          }),

          h(
            'div',
            { style: { marginTop: 10 } },
            h('span', { style: label }, '声音'),
            h(
              'select',
              {
                value: tts.voice || 'zh-CN-XiaoyiNeural',
                onChange: (e) => patch({ tts: { voice: e.target.value } }, 'ttsvoice', '声音改成 ' + e.target.value),
                style: {
                  width: '100%',
                  padding: '7px 10px',
                  fontSize: 13,
                  borderRadius: 7,
                  color: C.text,
                  background: C.bg2,
                  border: '1px solid ' + C.border
                }
              },
              ['zh-CN-XiaoyiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural'].map(
                (v) => h('option', { key: v, value: v }, v)
              )
            )
          ),

          h(
            'div',
            { style: { marginTop: 10 } },
            h('span', { style: label }, '试听一句'),
            h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h('input', {
                value: ttsText,
                onChange: (e) => setTtsText(e.target.value),
                style: {
                  flex: 1,
                  padding: '7px 10px',
                  fontSize: 13,
                  borderRadius: 7,
                  color: C.text,
                  background: C.bg2,
                  border: '1px solid ' + C.border
                }
              }),
              h(Btn, { onClick: testTts, disabled: busyKey === 'tts', kind: 'primary', small: true }, '念一下')
            )
          ),

          h(
            'div',
            { style: hint },
            '引擎：' + (tts.python || tts.pythonError || '探测中') +
              (tts.last && tts.last.ok
                ? '　上次成功 ' + tts.last.bytes + ' B / ' + tts.last.ms + ' ms'
                : tts.last && tts.last.reason
                  ? '　上次失败：' + tts.last.reason
                  : '')
          )
        ),

        // 念白：我的回复交给桌宠朗读
        h(
          'div',
          { style: card },
          h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text, marginBottom: 2 } }, '念白（把我的回复念出来）'),
          h('div', { style: hint }, '我在 QQ 里回你的话，桌宠也念一遍。她只念，不改 QQ 收到的东西。'),

          h(Toggle, {
            checked: gates.speak === true,
            onChange: (v) => patch({ speak: { enabled: v } }, 'speak', v ? '以后我说的话她都会念' : '不念了'),
            title: '回复同步给桌宠朗读',
            desc: '走桌宠的 speak 通道（真的出声，不只是气泡）'
          }),

          h(Row, { title: '只念私聊', desc: '群里的回复不念' },
            h(Toggle, {
              checked: speak.ownerOnly !== false,
              onChange: (v) => patch({ speak: { ownerOnly: v } }, 'speakowner', v ? '只念私聊' : '群里的也念'),
              title: ''
            })
          ),

          h(Row, { title: '一段最多念多少字', desc: '太长了听着累，超了截断' },
            h(TextField, {
              value: speak.maxChars ?? 150,
              type: 'number',
              min: 10,
              step: 10,
              width: 100,
              onCommit: (v) => patch({ speak: { maxChars: Math.max(10, Number(v) || 150) } }, 'speakmax', '截断长度改成 ' + v)
            })
          ),

          h(Row, { title: '念之前去掉 Markdown', desc: '不然会念出星号、井号' },
            h(Toggle, {
              checked: speak.stripMarkdown !== false,
              onChange: (v) => patch({ speak: { stripMarkdown: v } }, 'speakmd', v ? '会去掉 Markdown' : '原样念'),
              title: ''
            })
          ),

          h(Row, { title: '没有中文就不念', desc: '纯代码、纯英文念出来没意义' },
            h(Toggle, {
              checked: speak.requireChinese !== false,
              onChange: (v) => patch({ speak: { requireChinese: v } }, 'speakcn', v ? '只念带中文的' : '什么都念'),
              title: ''
            })
          ),

          h(Row, { title: '两次朗读最小间隔（毫秒）', desc: '挡住连续小段落轰炸' },
            h(TextField, {
              value: speak.minIntervalMs ?? 1200,
              type: 'number',
              min: 0,
              step: 100,
              width: 110,
              onCommit: (v) => patch({ speak: { minIntervalMs: Math.max(0, Number(v) || 0) } }, 'speakgap', '间隔改成 ' + v + ' ms')
            })
          ),

          h(Row, { title: '试一下', desc: '直接让桌宠念这句，验通道通不通' },
            h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h(Btn, {
                onClick: async () => {
                  setBusyKey('speak')
                  try {
                    const r = await post('/speak', { text: ttsText || '我能说话啦' })
                    showToast(r.ok ? '送过去了，听她念' : '她没念：' + (r.detail || r.reason || '未知'), r.ok ? 'ok' : 'err')
                  } finally {
                    setBusyKey('')
                    loadStatus()
                  }
                },
                disabled: busyKey === 'speak',
                kind: 'primary',
                small: true
              }, '让桌宠念这句')
            )
          ),

          h(
            'div',
            { style: hint },
            speak.lastAt
              ? '上次念：' + String(speak.lastText || '').slice(0, 24) + '（' + timeAgo(speak.lastAt) + '）'
              : '还没念过'
          )
        ),

        // 诊断 / 快速验证
        h(
          'div',
          { style: card },
          h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text, marginBottom: 8 } }, '试一试'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(Btn, { onClick: testVoice, disabled: busyKey === 'test' }, '模拟一句语音输入'),
            h(Btn, { onClick: loadStatus, small: true }, '刷新状态')
          ),
          h(
            'div',
            { style: hint },
            '「模拟一句语音输入」等价于对着麦克风说话：会走完整链路注入桌宠，让她开始思考。'
          ),
          status?.wake?.compiled?.error
            ? h('div', { style: { ...hint, color: C.err } }, '唤醒词产物：' + status.wake.compiled.error)
            : null
        )
        ),

        toast
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  bottom: 24,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  padding: '9px 16px',
                  borderRadius: 8,
                  fontSize: 13,
                  zIndex: 9999,
                  color: '#fff',
                  background: toast.kind === 'err' ? C.err : C.ok,
                  boxShadow: '0 6px 20px rgba(0,0,0,.18)'
                }
              },
              toast.text
            )
          : null
      )
    }

    // ---------------- 侧栏图标（耳朵 + 声波） ----------------
    function BridgeIcon({ size }) {
      const s = size || 16
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
        // 耳朵
        h('path', { d: 'M7 9a4 4 0 1 1 8 0c0 2-1.4 3-2.2 4.1-.6.8-.8 1.4-.8 2.4a2 2 0 0 1-2 2' }),
        h('path', { d: 'M9.6 9.4a1.5 1.5 0 0 1 2.9.4c0 .9-.9 1.2-.9 2.2' }),
        // 声波
        h('path', { d: 'M17.5 7.5a6 6 0 0 1 0 9' }),
        h('path', { d: 'M19.8 5.2a9 9 0 0 1 0 13.6', opacity: 0.55 })
      )
    }

    // ---------------- 注册 ----------------
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // 整页面板（侧栏点进来看到的内容）
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, BridgePage))

      // 侧栏入口：排在「自动化任务」(10) 与「Aurabot」(20) 之后
      slots.inject('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '肥鱼语音' },
          BridgeIcon
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.BridgePage = BridgePage
    exports.BridgeIcon = BridgeIcon
    return module.exports
  }
})
