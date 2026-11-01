/**
 * 配置：读写 `~/.dsh/plugins-data/coo-aurabot-bridge/config.json`。
 *
 * 设计原则：
 *   - **默认值本身就是一个安全闸门**（aToQ.enabled 默认 false），
 *     首次安装不发任何 QQ 消息。
 *   - 读不到 / 坏掉都不抛：坏文件会被备份成 `.bad-<时间>` 再用默认值继续跑，
 *     否则一个手抖的逗号就能让整条桥接在启动时炸掉。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const DATA_DIR = join(DSH_HOME, 'plugins-data', 'coo-aurabot-bridge')
export const CONFIG_PATH = join(DATA_DIR, 'config.json')
export const ENDPOINT_PATH = join(DATA_DIR, 'endpoint.json')
export const LOG_PATH = join(DATA_DIR, 'bridge.log')

/** 显示用版本号（与 package.json 保持一致，/status 里报出来方便排查）。 */
export const VERSION = '0.3.0'

/** 生成一个够长的本地调用令牌。 */
export const newToken = () => randomBytes(24).toString('hex')

/** 出厂默认值。**每一项都写注释**，因为它们就是说明书。 */
export const DEFAULTS = {
  /** coopanion 的基址；空 = 用宿主 webServer 的端口自动拼。 */
  coopanionBaseUrl: '',

  /** 语音输入口（Python 脚本 → 这里）。 */
  voiceInput: {
    /** 关掉后 /voice-input 直接 403，其他功能不受影响。 */
    enabled: true,
    /** 调用令牌；首次启动自动生成并写回。 */
    token: '',
    /** 单条上限，超过截断（与 coopanion 自己的 500 上限对齐）。 */
    maxChars: 500,
    /**
     * 注入方式：
     *   'auto'      —— 配了 sessionId 就走 chat/send，否则走 followup
     *   'chat-send' —— POST /api/dsh-coopanion-pet/chat/send（指定会话，确定性最好）
     *   'followup'  —— POST /api/dsh-coopanion-pet/report {kind:'answer'}（等价"用户又说了句话"）
     */
    deliver: 'auto',
    /** 指定会话 id；空 = 由宿主当前的活跃 agent 接手（followup 路径）。 */
    sessionId: '',
    /**
     * 语音输入投给谁（决定"一个脑子还是两个"）：
     *   'aurabot' —— 直接喂进 QQ 会话，回复由 aurabot 自己发到 QQ。**推荐**
     *   'pet'     —— 旧行为，走桌宠 /chat/send 注入另一个会话（会出现两个 AI 同时答）
     */
    voiceRoute: 'aurabot',
    /** voiceRoute='aurabot' 时的目标聊天；空 = private:<主人QQ>，由 aurabot 自己解析。 */
    voiceTarget: '',
    /** 唤醒成功时让她在气泡里应答一句（"我在"），给用户一个反馈。 */
    wakeWordEcho: true
  },

  /** 方向 A：桌宠 → QQ。 */
  aToQ: {
    /** ★ 默认关。装好后必须手动打开才会往 QQ 发任何东西。 */
    enabled: false,
    /** 目标；空 = private:<主人QQ>（由 auarabot 自己解析）。 */
    target: '',
    /** 只转发这些会话的回复；空 = 只转发语音输入绑定的那个会话（自动绑定）。 */
    sessionIds: [],
    /** 语音输入用过的会话，自动加入运行时白名单（不写回磁盘）。 */
    autoBindVoice: true,
    /** 包 <voice></voice> 让 QQ 收到语音条。 */
    asVoice: true,
    /** 超过这个字数退回文字（语音条念不完）。 */
    voiceMaxChars: 120,
    /** 去掉 markdown 记号（她有时会带 ** / ` 出来）。 */
    stripMarkdown: true,
    /** 只转发最终回复，不转发工具调用中间态。 */
    repliesOnly: true
  },

  /** 方向 B：QQ → 桌宠。 */
  q2p: {
    enabled: true,
    /** 只认主人本人 + 私聊；群聊一律不桥。 */
    ownerOnly: true,
    allowGroups: false,
    /** 单条上限。 */
    maxChars: 300,
    /** 发到桌宠气泡的形态：'inject' = 当作主人说的话走一轮对话；'say' = 只念出来。 */
    mode: 'inject'
  },

  /**
   * 唤醒词（侧栏可改）。
   *
   * 这里存**中文词**，人类可读。真正的 keywords 文件是「带调拼音 token 串」，
   * 由 scripts/gen_keywords.py（pypinyin + tokens.txt 最长匹配）编译出来。
   * 为什么不在 Node 侧转拼音：那要么引一个中文拼音依赖，要么手写一张字表，
   * 两者都比「调用已经装好 pypinyin 的 venv」更烂。
   */
  wake: {
    enabled: true,
    /** 出厂三词，与 models/keywords-daifeiyu.txt 一致。 */
    words: ['大飞鱼', '大肥鱼', '肥鱼'],
    /**
     * 语音工作区（里面要有 scripts/ 和 models/）。
     * 空 = 自动探测：插件自带的 voice/ 优先，其次当前目录。
     * 换机器/给别人用又跑了 voice/setup.ps1 装到别处时，填成那个路径。
     */
    workspace: '',
    /** 生成脚本；空 = 自动探测（见 lib/wakewords.js） */
    genScript: '',
    /** 跑生成脚本的解释器；空 = 自动探测 .venv-voice */
    pythonPath: '',
    /** 生成到哪；空 = <工作区>/models/keywords.generated.txt */
    outFile: '',
    /** 插件启动时自动编译一次（改了词也会自动重编） */
    autoGenerate: true,
    /** 词数上限，防止侧栏手滑贴进来一整篇文章 */
    maxWords: 12,
    /** 单个唤醒词字数上限 */
    maxWordChars: 12
  },

  /**
   * 语音合成（桌宠出声）。
   *
   * 桌宠自己的 /tts 端点只是个转发器：它去 fetch 宿主里的
   * `/plugins/xiaomi-mimo-tts/synthesize`，拿不到就回 501。本插件把那条路由补上
   * （见 lib/tts.js），于是不装 xiaomi-tts、不改桌宠源码她也能说话。
   * 引擎用本机 pyenv 里的 edge-tts —— 和 QQ 语音条同一个声音。
   */
  tts: {
    /** 关掉后那条路由回 501，桌宠恢复原样（只出气泡不出声）。 */
    enabled: true,
    /**
     * 优先用 aurabot 的本地接口脚本（~/.dsh/plugins-data/aurabot/local/tts.mjs）。
     * 好处：桌宠和 QQ 语音条同一个嗓子、同一套语气指令；它失败会自动退回 edge-tts。
     */
    useLocalScript: true,
    /** 指定 tts.mjs 路径；空 = 自动找 aurabot 那份。 */
    localScript: '',
    /** edge-tts 的解释器；空 = 自动探测（Aurabot\pyenv 优先）。 */
    pythonPath: '',
    /** 声音。zh-CN-XiaoyiNeural 是女声，与 aurabot 默认一致。 */
    voice: 'zh-CN-XiaoyiNeural',
    /** 语速 / 音量 / 音高，edge-tts 格式：'+10%'、'-5%'、'+0Hz'；空 = 默认。 */
    rate: '',
    volume: '',
    pitch: '',
    /** 单次上限，超过拒绝（与桌宠自己的 500 对齐）。 */
    maxChars: 500,
    /** 单次合成超时（毫秒）。 */
    timeoutMs: 20000
  },

  /**
   * 耳朵（语音唤醒）。
   *
   * 由本插件托管 scripts/voice_assistant.py 这个子进程：插件起来它才起，
   * 插件卸载就带走，不占常驻唤醒脚本、不开 cmd 黑窗口（windowsHide）。
   * 三道闸的判断全在 Python 侧（锁屏/闲置要 Win32 才问得到，Node 拿不到），
   * 但每个开关的**默认值与文案**都在这里，侧栏改完 1 秒内生效。
   */
  listen: {
    /** 总开关。关掉 = 不 spawn、不占麦克风（这就是"一键闭嘴"）。 */
    enabled: true,
    /** 解释器；空 = 自动探测 <工作区>/.venv-voice */
    pythonPath: '',
    /**
     * 语音工作区（里面要有 scripts/voice_assistant.py 和 models/）。
     * 空 = 自动探测出厂路径；换机器/给别人用必须改这里。
     */
    workspace: '',
    /** 脚本；空 = <工作区>/scripts/voice_assistant.py */
    scriptPath: '',
    /** 插件起来就把耳朵拉起来（不想要就关掉，只留手动） */
    startWithPlugin: true,
    /** 崩了自己重拉 */
    autoRestart: true,
    /** 重拉上限，超过就停下等人 */
    maxRestarts: 5,
    /** 重拉间隔（毫秒） */
    restartDelayMs: 5000,

    /** 闸一：锁屏就不听 */
    pauseOnLock: true,
    /** 闸二：闲置太久就不听（暂停时松开麦克风，别人看设备管理器也看不到占用） */
    pauseOnIdle: true,
    /** 闲置多少分钟算久（可以是 0.5 这种小数） */
    idleMinutes: 10,
    /** 有动静就自动恢复听 */
    resumeOnActivity: true,
    /** 暂停时松开麦克风；关掉会一直占着设备但不出声 */
    releaseMicOnPause: true,
    /** 闸门轮询间隔（毫秒），故意留长一点，省电 */
    pollMs: 1000,

    /** 热键兜底：喊不出来时按一下等于喊一声 */
    hotkey: {
      enabled: true,
      /** 写法：ctrl+alt+j / ctrl+shift+space / f9 */
      combo: 'ctrl+alt+j'
    }
  },

  /**
   * 让我回给你的话**从桌宠嘴里念出来**。
   *
   * 默认关着：她一直碎碎念也吵。开了之后，我在 QQ 会话里回你的每段话会
   * 顺手送一份给桌宠朗读（走 /api/dsh-coopanion-pet/speak-test）。
   * 用的是同一个 edge-tts 声音，念的时候她在屏幕角落动嘴。
   */
  speak: {
    /** 总开关。 */
    enabled: false,
    /** 只念主人私聊的回复（群里的不念）。 */
    ownerOnly: true,
    /** 一段话最多念多少字，多了截断（太长听着累）。 */
    maxChars: 150,
    /** 去掉 Markdown 再念（不然会念出星号、井号）。 */
    stripMarkdown: true,
    /** 没有中文的消息跳过（纯代码、纯英文念出来没意义）。 */
    requireChinese: true,
    /** 两次朗读的最小间隔（毫秒），挡住连续小段落轰炸。 */
    minIntervalMs: 1200,
    /** 每次朗读的超时（毫秒），合成+播放要几秒。 */
    timeoutMs: 30000
  },

  /** 同一条文本的最小重复间隔（毫秒）；防她自己复读。 */
  minIntervalMs: 800,
  /** 一次注入后这段时间内不再转发回复（毫秒），防来回打乒乓。 */
  suppressReplyMs: 45000,
  /** 日志最多保留多少行（超过就截断重写）。 */
  logMaxLines: 2000
}

/**
 * 深合并：只用 defaults 里有的键，类型不符就用默认值。
 * `mutate` 为 true 时**就地改 base**（保住外面持有的引用），否则克隆一份。
 */
function merge(base, patch, mutate = false) {
  const out = mutate ? base : structuredClone(base)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) continue
    const dv = out[k]
    if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
      out[k] = merge(dv, v, mutate)
    } else if (Array.isArray(dv)) {
      out[k] = Array.isArray(v) ? v.map(String) : dv
    } else if (typeof v === typeof dv) {
      out[k] = v
    }
  }
  return out
}

/**
 * 找出 raw 里缺的键（递归到两层：顶层段 + 段里的字段）。
 * 插件升级新增了字段（比如 listen.workspace / speak.*）时靠它把新键写回文件，
 * 否则用户打开 config.json 看不到那些开关，会以为插件没这个功能。
 */
function missingKeys(def, raw, prefix = '', depth = 0, out = []) {
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(def)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (!(k in raw)) { out.push(path); continue }
    if (depth < 1 && v && typeof v === 'object' && !Array.isArray(v)) {
      missingKeys(v, raw[k], path, depth + 1, out)
    }
  }
  return out
}

/**
 * 建配置存储。
 * `get()` 每次返回同一份对象（就地改也能生效）；`save()` 才落盘。
 */
export function createConfigStore(logger) {
  let cfg = structuredClone(DEFAULTS)
  let dirty = false

  const ensureDir = () => {
    try { mkdirSync(DATA_DIR, { recursive: true }) } catch (e) { /* 后面写会报 */ }
  }

  const load = () => {
    ensureDir()
    if (!existsSync(CONFIG_PATH)) {
      cfg = structuredClone(DEFAULTS)
      cfg.voiceInput.token = newToken()
      dirty = true
      return cfg
    }
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      // 插件升级后新增的段/字段（比如 listen.workspace、speak.*）要补进文件里，
      // 否则用户打开 config.json 看不到那些新开关，会以为没有
      if (missingKeys(DEFAULTS, raw).length) dirty = true
      cfg = merge(DEFAULTS, raw)
    } catch (error) {
      // 坏文件：留个证据，然后按默认值继续跑（不能因为一个逗号让桥接不启动）
      try { renameSync(CONFIG_PATH, CONFIG_PATH + '.bad-' + Date.now()) } catch (e) {}
      logger?.warn?.('配置读不出来，已按默认值启动：' + String(error?.message ?? error))
      cfg = structuredClone(DEFAULTS)
      dirty = true
    }
    if (!cfg.voiceInput.token) { cfg.voiceInput.token = newToken(); dirty = true }
    return cfg
  }

  const save = () => {
    ensureDir()
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
      dirty = false
      return true
    } catch (error) {
      logger?.warn?.('配置写不回去：' + String(error?.message ?? error))
      return false
    }
  }

  return {
    get: () => cfg,
    /**
     * 局部覆盖。**必须就地改**（mutate）——`index.js` 启动时持有 `cfg` 引用，
     * 换成新对象它看到的还是旧的，改配置会"看着没生效"。
     */
    set(next) { merge(cfg, next, true); dirty = true; return cfg },
    load,
    save,
    get dirty() { return dirty }
  }
}
