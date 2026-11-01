# dsh-coo-aurabot-bridge

把**桌宠（dsh-coopanion-pet）**和 **QQ 机器人（dsh-aurabot-qq）**连成一个双向通道，
再给桌宠配一副"耳朵"（本地 KWS 唤醒 + faster-whisper 转写），变成能喊一声就说话的语音助手。

- **方向 A（桌宠 → QQ）**：桌宠会话里出现 assistant 回复时，转发到主人 QQ（默认包 `<voice>` 发语音条）。
- **方向 B（QQ → 桌宠）**：QQ 主人私聊来消息时，注入桌宠会话，让她正常走 LLM 回复。
- **语音输入（耳朵 → 桌宠）**：`scripts/voice_assistant.py` 听唤醒词"大飞鱼"，转写后 POST 到本插件的 `/voice-input`。

> 不修改 `dsh-coopanion-pet` 与 `dsh-aurabot-qq` 的任何源码。两侧都只用它们已经存在的公开面：
> coopanion 的 `session/event` 与 HTTP 路由；aurabot 的 `ctx.get('aurabot')` 服务与 `activity` 事件。

---

## 1. 安装

插件目录本身就是一个可直接 `file:` 引用的包。**两种装法，选一种**。

### 1.0 先想清楚要哪一档

| | 只装主插件（零依赖） | 加装 `voice/` 加强包 |
|---|---|---|
| QQ ↔ 桌宠 双向桥接 | ✅ | ✅ |
| 把我的回复念出来（念白） | ✅ | ✅ |
| 桌宠 TTS 出声 | 走系统 edge-tts | 可以接你的云端 TTS |
| 喊「大飞鱼」她就听 | ❌ | ✅（要 Python + ~500MB 模型） |

主插件本身**没有任何 npm 依赖**，`package.json` 里也没有 `dependencies`。
`voice/` 是可选的，细则见 [`voice/README.md`](voice/README.md)。

前提：插件是桥，得先有 **dsh-coopanion-pet**（桌宠）和 **dsh-aurabot-qq**（QQ）。

### 1.1 装到 profile 里

DSH 的 profile 目录一般是 `~/.dsh/profiles/<profile名>/`（Windows 上是
`C:\Users\<你>\.dsh\profiles\<profile名>\`，profile 名默认 `desktop`）。

把整个插件目录放到 `<profile>/plugins/dsh-coo-aurabot-bridge`，
然后在 `<profile>/package.json` 里登记两处：

```json
"dependencies": {
  "dsh-coo-aurabot-bridge": "file:<profile>/plugins/dsh-coo-aurabot-bridge"
},
"dsh": { "profile": { "bundles": [ "...", "dsh-coo-aurabot-bridge" ] } }
```

> 路径写**正斜杠**（`file:C:/Users/me/.dsh/...`）最稳，反斜杠在 JSON 里要转义。

### 1.2 装依赖（可选）

插件**没有任何 npm 依赖**，如果 profile 里已经 `pnpm install` 过，直接用就行。
需要显式装一次时：

```powershell
cd <profile>
pnpm add "file:<profile>/plugins/dsh-coo-aurabot-bridge"
```

> **坑**：`pnpm add` 常常因为 store 路径 / 网络失败。
> 失败也没关系——只要 `package.json` 里写了上面那两处，
> 再把 `node_modules\dsh-coo-aurabot-bridge` 做成 junction 指到插件目录即可：
> ```powershell
> New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-coo-aurabot-bridge" `
>   -Target "<profile>\plugins\dsh-coo-aurabot-bridge"
> ```

### 1.3 装完检查

```powershell
# 宿主加载了吗？——**端口每次都变**，必须从 endpoint.json 读，不要抄任何固定端口
$b = (Get-Content "$env:USERPROFILE\.dsh\plugins-data\coo-aurabot-bridge\endpoint.json" | ConvertFrom-Json).baseUrl
curl.exe -s "$b/api/dsh-coo-aurabot-bridge/status"
```

正常应看到：

```json
{"ok":true,"gates":{"aToQ":false,"q2p":true,"voiceInput":true},"aurabot":{"available":true,...},"sessions":{...}}
```

`gates.aToQ` 是 `false` —— 这是设计上的默认值，见 §3。

---

## 2. HTTP 面（都挂在 DSH 的 webServer 上，无额外端口）

前缀两份等价：`/api/dsh-coo-aurabot-bridge` 与 `/coo-aurabot-bridge`。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/voice-input` | 语音输入口：`{text, token, sessionId?, wake?, echo?}` |
| GET/POST | `/wakewords` | 读唤醒词与编译状态 / 存词并立即编译（侧栏用的就是这个） |
| GET | `/status` | 诊断：gates、aurabot 状态、coopanion 会话数、排除集、唤醒词摘要、tts/listen/speak 状态 |
| GET/POST | `/config` | 读全量配置 / 深合并写配置 |
| GET/POST | `/tts` | 读语音合成状态 / 直接合成并回音频字节（侧栏试听用） |
| GET/POST | `/speak` | 读念白状态 / 让桌宠念一句 `{text}` |
| GET/POST | `/listen` | 读耳朵状态 / 控制：`{action:'start'\|'stop'\|'restart'}` |
| POST | `/simulate-pet` | 假装桌宠说了一句（走方向 A 全链路，`dry:true` 只到 policy） |
| POST | `/simulate-qq` | 假装 QQ 来了消息（走方向 B 全链路） |

另外**多挂了一条不带前缀的路由**：`POST /plugins/xiaomi-mimo-tts/synthesize`。
这是桌宠（dsh-coopanion-pet）原生就会去找的 TTS 端点（`lib/optional.js` 的 `TTS_ROUTE`），
本插件冒充它，桌面端就**一行代码都不用改**也能出声。它只在 `tts.enabled` 打开时挂载。

### `/voice-input` 的三种用法

```powershell
# ① 唤醒应答：只让她说一句"我在"，不触发 LLM
# ② 正文：注入桌宠会话，触发一轮对话
# ③ 带 sessionId：顺手把这个会话加进方向 A 白名单
```

`token` 从 `~/.dsh/plugins-data/coo-aurabot-bridge/endpoint.json` 读，也接受请求头 `x-bridge-token`。

---

## 2.5 侧栏面板与唤醒词（v0.2.0 新增）

装好后侧栏「自动化任务」区里会出现一个 **肥鱼语音** 入口（插槽 `sidebar.panellist`，
`order: 30`，排在「自动化任务」10 和「Aurabot」20 之后）。点进去是整页面板，
可以在这里改唤醒词和开关，不用再手编 JSON。

### 唤醒词是怎么生效的

关键在于**存的和用的是两种东西**：

| 层 | 存在哪 | 长什么样 | 谁写 |
|---|---|---|---|
| 用户意图 | `config.json` 的 `wake.words` | `["大飞鱼","大肥鱼","肥鱼"]`（中文） | 侧栏 / 插件 |
| 派生数据 | `models/keywords.generated.txt` | `d à f ēi y ú @大飞鱼`（带调拼音 token 串） | `scripts/gen_keywords.py` |

sherpa-onnx 的 KWS 只吃下面那种「拼音 token 串」，而且音节能切分必须严格贴合模型的
`tokens.txt`（`'dà'` 要拆成 `d` + `à`，`'zhǎng'` 要拆成 `zh` + `ǎng`）。
手写既容易错（调号打错就静默不命中），也没法让人在界面上改。

所以编译放在 Python 侧做：`pypinyin` 转拼音 + 按 `tokens.txt` **最长匹配**切分。
Node 侧没有、也不该引中文拼音依赖，那只会把同一个 bug 养在两边。

**改词之后会发生什么：**

1. 侧栏点「保存并编译」→ `POST /wakewords` → 写 `config.json` → 立刻跑一次生成器
2. Python 语音脚本每秒钟查一次 `config.json` 的 mtime，变了就重新编译并**重建
   KeywordSpotter**（旧的一扔，新的一接），日志里打 `★ 唤醒词已热重载`
3. 所以**改词不用重启任何进程**，几秒内就生效

### 新增依赖

`pypinyin`（纯 Python 包）已加进 `scripts/requirements.txt`。没装的话唤醒词会退回
`voice_config.json` 里写死的 `keywords_file`，侧栏改词不生效——但其余功能都正常。

### 侧栏里能改的开关

面板是**横向卡片墙**（`grid` + `repeat(auto-fit, minmax(330px,1fr))`，根节点
`maxWidth: 1180` 且 `height:100% / overflowY:auto`，所以能上下滚）。

| 开关 | 对应配置 | 说明 |
|---|---|---|
| **桌宠说话（总闸）** | `tts.enabled` + `speak.enabled` | 一次改两段。关掉 → 既不念白也不出声 |
| 只留一个脑子 | `voiceInput.voiceRoute` | `aurabot`=语音喂给 QQ 那个会话（推荐）；`pet`=旧行为，会两个 AI 同时答 |
| 唤醒词（耳朵） | `wake.enabled` | 关掉后不再识别唤醒词 |
| 语音输入口 | `voiceInput.enabled` | 关掉后 `/voice-input` 直接 403 |
| QQ → 桌宠 | `q2p.enabled` | 仍受「仅主人私聊」约束 |
| 桌宠 → QQ | `aToQ.enabled` | **默认关**；打开时会二次确认，因为会真的发 QQ |
| 回复包成语音条 | `aToQ.asVoice` | 套 `<voice>` 标签，超 `voiceMaxChars` 自动退回文字 |
| 托管语音脚本 | `listen.enabled` | 插件 spawn Python 耳朵（`windowsHide`，没黑窗）；关掉 = 一键闭嘴 |
| 闸一：锁屏停 | `listen.pauseOnLock` | 由 Python 侧 `OpenInputDesktop` 判断 |
| 闸二：闲置停 | `listen.pauseOnIdle` / `listen.idleMinutes` | 键鼠 N 分钟没动就放开麦克风 |
| 暂停时松开麦克风 | `listen.releaseMicOnPause` | 关掉就只是不处理，麦克风仍占着 |
| 随插件起 | `listen.startWithPlugin` | DSH 启动即听，不用 dshmarket 手动点开始 |
| 热键兜底 | `listen.hotkey.enabled` / `combo` | 默认 `ctrl+alt+j`（`ctrl+alt+f` 在本机被别的软件占了） |
| 念白 | `speak.enabled` 等 | 把我在 QQ 里的回复同步到桌宠念出来（默认关） |
| 语音合成 | `tts.enabled` / `voice` / `useLocalScript` | `useLocalScript:true` 时优先借用 aurabot 的 `local/tts.mjs` |

最下面还有一张 **「全部参数（调试用）」** 折叠卡，把 DEFAULTS 里每个可调项都做成了控件
（含 `voiceInput.sessionId`、`aToQ.sessionIds`、`q2p.mode`、`wake.*`、`tts.*`、`listen.*`、
`speak.*`、三个工作区路径、`minIntervalMs` / `suppressReplyMs` / `logMaxLines` 等），
改完立刻写进 `config.json`，不用手编 JSON。

---

## 3. 安全与默认值

| 开关 | 默认 | 说明 |
|---|---|---|
| `aToQ.enabled` | **false** | 桌宠→QQ 的闸门。**关着的时候一个字节都不会发到 QQ** |
| `q2p.enabled` | true | QQ→桌宠。仍受 `ownerOnly` / `allowGroups` 约束 |
| `q2p.allowGroups` | false | 群聊**默认不桥**，只有主人私聊才进桌宠 |
| `voiceInput.enabled` | true | 语音输入口。有 token 校验 |
| `minIntervalMs` | 800 | 两条注入之间的最小间隔 |
| `suppressReplyMs` | 45000 | 刚刚注入过的话，45 秒内不许原样转回 QQ（防回声） |

**防死循环三重保险**：

1. **排除集**：aurabot 自己的会话（`~/.dsh/plugins-data/aurabot/sessions.json` 里 `chats.*.sessionId`，
   目前是 `session-7f336a37…` 空间日记 与 `session-aa9bca1c…` 主人私聊）永远不往 QQ 转发。
   否则她的回复在同一会话里再被看到，就会无限回环。
2. **回声抑制**：注入桌宠的原文记下来，45 秒内不转发回 QQ。
3. **系统消息过滤**：`[语音]`、`（回答桌宠的提问「…」）`、`【系统`、`[system]` 等前缀一律丢弃。

另外 `<voice>` 只在文本 ≤ `voiceMaxChars`（默认 120 字）时加；
超了就发文字——免得一条几百字的语音条。

---

## 4. 改完代码怎么让它生效

本机实测：**touch 源码不会触发 HMR**，要重载插件。

```powershell
# 通过 plugin_manager：先 disable 再 enable（target 用 entry id）
#   set_plugin  target="include:coo-aurabot-bridge"  enabled=false
#   set_plugin  target="include:coo-aurabot-bridge"  enabled=true
```

两侧改动的生效方式**不一样**：

| 改了哪 | 生效方式 |
|---|---|
| `lib/*.js`（宿主半边） | 重载插件（上面的 disable/enable）；改的是路由/过滤链/发送逻辑 |
| `client/client.js`（浏览器半边） | **刷新页面**（或重启 DSH）；侧栏入口与面板属于前端 |
| `voice/scripts/*.py`（语音脚本） | 侧栏「耳朵」卡片点「重启耳朵」（插件会自动拉新的）；或重载插件 |
| `config.json` 里的 `wake.words` | **什么都不用做**，Python 每秒自查 mtime，几秒内热重载 |

> `node_modules/dsh-coo-aurabot-bridge` 是指向 `plugins/dsh-coo-aurabot-bridge` 的
> **junction**，所以改 `plugins/` 下的文件就是改加载到的那份，不需要重装。
> 如果哪天发现改代码没反应，先确认它还是 junction（`Get-Item` 看 `LinkType`）——
> 一旦变成真实目录副本，就会出现"改 A 生效在 B"的怪事。

重载后 `endpoint.json` 会刷新（含新端口与新 token），日志里应出现：

```
[coo-aurabot-bridge] 启动 / endpoint.json 已写入（端口 60xxx）
[coo-aurabot-bridge] 已订阅 aurabot activity（方向 B 生效）
```

---

## 5. 测试

### 5.1 离线（不碰真 QQ、不碰桌宠）

```powershell
cd <插件目录>
node test\offline.mjs
```

脚本自己按 `import.meta.url` 找上一级作为插件目录，也可用环境变量覆盖：
`$env:BRIDGE_PLUGIN_DIR = "D:\somewhere\dsh-coo-aurabot-bridge"`。

覆盖 38 项：policy 拒因链、Markdown 清理、token 校验、方向 A/B 的开关与回声抑制，
以及唤醒词接口的契约（去重去空、空词表拒绝、超长词丢弃、词存中文不存拼音）。
全绿输出 `38/38 通过`，exit 0。

### 5.2 桌宠→QQ（会真的发到 QQ）

```powershell
$b = (Get-Content "$env:USERPROFILE\.dsh\plugins-data\coo-aurabot-bridge\endpoint.json" | ConvertFrom-Json).baseUrl + "/api/dsh-coo-aurabot-bridge"

# 只开一个会话，避免别的会话乱发
$cfg = '{"aToQ":{"enabled":true,"sessionIds":["<你的会话id>"]}}'
[System.IO.File]::WriteAllText("$env:TEMP\cfg.json", $cfg, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST "$b/config" -H "Content-Type: application/json" --data-binary "@$env:TEMP\cfg.json"

# 干跑：只走到 policy，不发
curl.exe -s -X POST "$b/simulate-pet" -H "Content-Type: application/json" --data-binary "@$env:TEMP\pet-dry.json"
#   → {"ok":true,"stage":"policy","wouldSend":"…","asVoice":true}

# 真发
curl.exe -s -X POST "$b/simulate-pet" -H "Content-Type: application/json" --data-binary "@$env:TEMP\pet.json"
#   → {"ok":true,"stage":"send","sent":true,"reason":"发出去了","asVoice":true}
```

QQ 侧验证：看 `~/.dsh/plugins-data/aurabot/logs/aurabot-<日期>.log`，
出现 `[OneBot] 私聊 <ownerQQ> | 发送：[语音]` 即成功（`[语音]` 说明走了 TTS 语音条）。

> **PowerShell 拼中文 JSON 会出问题**（会被写成 `??????`）。
> 一律用 `[System.IO.File]::WriteAllText(path, json, UTF8无BOM)` 写文件，再 `--data-binary "@file"`。

测完**记得关回去**：

```powershell
# aToQ 关掉 + 清空白名单
# {"aToQ":{"enabled":false,"sessionIds":[]}}
```

### 5.3 QQ→桌宠

```powershell
curl.exe -s -X POST "$b/simulate-qq" -H "Content-Type: application/json" --data-binary "@$env:TEMP\qq.json"
#   → {"ok":true,"stage":"inject","via":"followup","detail":"delivered"}
```

`via: followup` = 走了 `agent.followup`（等价"用户又说了句话"）；
`via: chat-send` = 明确指定了 sessionId，走 `/chat/send`。

真 QQ 侧验证：直接用手机给机器人发一条私聊，看桌宠是否回。

群聊默认被拦，`/simulate-qq` 传 `{"chatId":"group:123","owner":true}` 会得到
`{"ok":false,"reason":"group-not-allowed"}`。

### 5.4 语音输入口

```powershell
$tok = (Get-Content "$env:USERPROFILE\.dsh\plugins-data\coo-aurabot-bridge\endpoint.json" -Raw | ConvertFrom-Json).token
$body = '{"wake":true,"echo":"我在","token":"' + $tok + '"}'
[System.IO.File]::WriteAllText("$env:TEMP\wake.json", $body, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST "$b/voice-input" -H "Content-Type: application/json" --data-binary "@$env:TEMP\wake.json"
#   → {"ok":true,"via":"wake-echo","detail":"said"}   桌宠气泡里出"我在"
```

---

## 6. 文件

```
plugins/dsh-coo-aurabot-bridge/
├─ package.json          dsh.bundle.patch + dsh.client（浏览器半边）
├─ cordis.patch.yml      - insert: id: coo-aurabot-bridge
├─ README.md
├─ client/
│  └─ client.js          侧栏入口（sidebar.panellist）+ 整页面板；只调本插件的 HTTP 面
├─ voice/                ★ 可选加强包（不装也能用，见 voice/README.md）
│  ├─ setup.ps1          建 venv + 装依赖 + 下模型 + 自检
│  ├─ README.md
│  └─ scripts/
│     ├─ voice_assistant.py   耳朵主程序（KWS → VAD → whisper → POST /voice-input）
│     ├─ gen_keywords.py      中文词 → sherpa KWS 的拼音 token 串
│     ├─ voice_config.json    脚本自己的配置（模型路径、阈值、设备）
│     ├─ requirements.txt
│     └─ keywords-seed.txt    唤醒词底稿（大飞鱼/大肥鱼/肥鱼）
└─ lib/
   ├─ index.js           路由挂载、方向 A/B 订阅、endpoint.json、模拟端点、唤醒词路由
   ├─ config.js          配置读写（深合并）、默认值、endpoint/日志路径
   ├─ coopanion.js       coopanion HTTP 客户端（injectText / sayText / speakText / listSessions）
   ├─ aurabot.js         通过 ctx.get('aurabot') 拿服务；send 时包 <voice>；injectToChat 喂 QQ 会话
   ├─ wakewords.js       调 gen_keywords.py 编译唤醒词、词表校验、产物状态
   ├─ listen.js          耳朵的托管（spawn / 重启 / dispose / pid 去重 / @@GATE 状态）
   ├─ tts.js             语音合成：接本机 aurabot 的 tts.mjs，失败退回 edge-tts
   ├─ policy.js          方向 A/B 的准入判定、Markdown 清理、系统消息过滤、回声抑制
   └─ log.js             轮转日志
```

### 6.1 三个「工作区」配置键（换机器必看）

脚本与模型**不在插件目录里**也能跑，靠这三个键指路（侧栏「全部参数（调试用）」里都能改）：

| 键 | 找不到时的回退顺序 |
|---|---|
| `listen.workspace` | 配置值 → 插件自带 `<插件>/voice/` → 当前工作目录 |
| `wake.workspace` | 同上（编译唤醒词用） |
| `listen.scriptPath` / `wake.genScript` / `listen.pythonPath` / `wake.pythonPath` | 填了就**只用**填的（不回落），所以路径写错会明确报错，不会偷偷用别的 |

装到插件自己的 `voice/` 目录时这两个 workspace 键可以留空——插件会通过 `import.meta.url` 找到自己旁边的脚本。
装到别处（比如 D 盘）就填绝对路径。

运行时数据（**不在**插件目录里）：

```
~/.dsh/plugins-data/coo-aurabot-bridge/
├─ config.json      配置
├─ endpoint.json    端口 + token（Python 脚本读它）
├─ voice.pid        耳朵进程号（防重复挂载养两个）
└─ bridge.log       桥接日志
```

---

## 7. 已知限制

- **aurabot 侧 TTS 决定权不在桥接层**：桥接只负责传文本 / 包 `<voice>`。
  语音能不能真发出去取决于 aurabot 的 `voice.enabled` 与它自己的 TTS 引擎
  （edge-tts 或面板「本地接口」里配的 tts.mjs），实测可用。
- **aurabot 的 `send()` 是"尽力而为"**：返回的 `message` 是三态文字
  （"总开关关着，没真发" / "试运行，只进了日志" / "发出去了"），桥接按文字判断，不是严格回执。
- **注入依赖 `activeAgent`**：coopanion 的 `deliverAnswer` 拿不到活跃 agent 时静默丢弃。
  如果 `/simulate-qq` 返回 `ok:true` 但桌宠没反应，先看 DSH 里有没有正在跑的会话。
- **coopanion 的气泡栈只留 3 条**（`MAX_LINES = 3`），长对话在页面里会被顶掉。

### 7.1 语音链路为什么"注入了却没回复"（2026-10-29 实测定位）

按下面顺序排查，四条都是**真的把人坑过**的：

1. **`/report` 不是「主人说话」的入口**。它只是"回答她正在问的问题"，多数情况下
   注入成功（204）但**不会触发新一轮对话**。要真的排一轮，必须
   `voiceInput.deliver = 'chat-send'` 且**指定 `sessionId`**（走 `chat.send` →
   `sessionController.prompt`，等价于在 DSH 里打字）。实测：`/report` 12 秒零输出，
   `chat/send` 1.7 秒就出回复。
2. **四道闸依次是** `a2q-disabled` → `excluded-session` → `session-not-allowed`
   → `suppressed` → 才发送。其中 **`session-not-allowed` 是静默的**（日志不打），
   最容易误判成"她没回"。`aToQ.sessionIds` 为空 + `autoBindVoice` 没绑上时，就是这个结果。
3. **`suppressReplyMs` 必须为 0**（语音场景）。她的回复只要 1.7 秒就到了，
   而默认 45000 会把它整段吞掉，日志显示 `方向A 丢弃(suppressed)`。
   它本来的用途是防止"QQ 注入的话原样回传"，那个场景已由 `excluded-session` 挡住。
4. **她调 `pet_listen` 会让整轮卡死**。`pet_listen` 依赖 DSH 的 STT 插件，
   `speech.available=false` 时这一轮**永远出不来回复**（实测 10 分钟零 assistant 消息）。
   触发词通常是"听得见吗"这类句子——测试语音链路时请用普通内容（如"说一句话"），
   别用"听得见吗"。

**端口每次都变**：`endpoint.json` 的 `port` 是 DSH webServer 启动时分配的
（实测 55723 / 49673 / 60457 都出现过）。任何写死端口的命令都会静默失败，
一律从 `endpoint.json` 读。
