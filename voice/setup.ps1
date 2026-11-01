# 肥鱼语音 · 加强包安装脚本（Windows PowerShell）
#
# 只做三件事：建 venv、装 Python 依赖、下模型。装完把打印出来的
# 「工作区」路径填进侧栏「全部参数 → 语音工作区」，耳朵就能喊了。
#
# 用法（在任意目录）：
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Workspace "D:\my-voice" -Asr small
#
# 参数：
#   -Workspace  装到哪里，默认 <插件目录>\voice（放在插件里最省事）
#   -Python     用哪个 python 建 venv，默认 py -3
#   -Asr        whisper 模型大小：small（默认，463MB，准）/ base（145MB，快）/ tiny（75MB，最省）
#   -HfBase     whisper 模型从哪下，默认 https://hf-mirror.com（国内能连）；官方地址是
#               https://huggingface.co
#   -SkipModels 只建环境不下模型

[CmdletBinding()]
param(
  [string]$Workspace = '',
  [string]$Python = '',
  [ValidateSet('tiny', 'base', 'small')]
  [string]$Asr = 'small',
  [string]$HfBase = '',
  [switch]$SkipModels
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- 路径 ----------
if (-not $Workspace) { $Workspace = Join-Path $PSScriptRoot '' }
$Workspace = [System.IO.Path]::GetFullPath($Workspace)
$scriptsDir = Join-Path $Workspace 'scripts'
$modelsDir = Join-Path $Workspace 'models'
$venvDir = Join-Path $Workspace '.venv-voice'

Write-Host ''
Write-Host '肥鱼语音 · 加强包' -ForegroundColor Cyan
Write-Host "工作区：$Workspace"
Write-Host ''

# 脚本已经在仓库里（voice\scripts），如果工作区就是插件目录就直接用，
# 否则把它们复制过去，保证 voice_config.json 的相对路径还能对得上。
$here = Join-Path $PSScriptRoot 'scripts'
if ((Test-Path $here) -and ([System.IO.Path]::GetFullPath($here) -ne [System.IO.Path]::GetFullPath($scriptsDir))) {
  New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
  Copy-Item (Join-Path $here '*') $scriptsDir -Recurse -Force
}
foreach ($f in 'voice_assistant.py', 'gen_keywords.py', 'requirements.txt', 'voice_config.json') {
  if (-not (Test-Path (Join-Path $scriptsDir $f))) {
    throw "缺少 scripts\$f —— 请把整个 voice\scripts 目录一起复制过来"
  }
}
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

# ---------- 1. venv ----------
$venvPy = Join-Path $venvDir 'Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  Write-Host '[1/4] 建虚拟环境 .venv-voice …' -ForegroundColor Yellow
  if ($Python) {
    & $Python -m venv $venvDir
  } else {
    $py = (Get-Command py -ErrorAction SilentlyContinue)
    if ($py) { & py -3 -m venv $venvDir }
    else {
      $py3 = (Get-Command python -ErrorAction SilentlyContinue)
      if (-not $py3) { throw '找不到 python，请先装 Python 3.10+ 并加入 PATH，或用 -Python 指定完整路径' }
      & python -m venv $venvDir
    }
  }
  if (-not (Test-Path $venvPy)) { throw '虚拟环境没建起来' }
} else {
  Write-Host '[1/4] 已有虚拟环境，跳过' -ForegroundColor DarkGray
}

# ---------- 2. 依赖 ----------
Write-Host '[2/4] 装 Python 依赖（sherpa-onnx / faster-whisper / sounddevice …）' -ForegroundColor Yellow
& $venvPy -m pip install --upgrade pip --quiet
& $venvPy -m pip install -r (Join-Path $scriptsDir 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip 安装失败，看上面的报错' }

if ($SkipModels) {
  Write-Host '[3/4] 按要求跳过模型下载' -ForegroundColor DarkGray
  Write-Host '[4/4] 完成（没有模型喊不出声）' -ForegroundColor Yellow
  Write-Host "工作区填：$Workspace"
  exit 0
}

# ---------- 3. 下模型 ----------
# 国内直连 huggingface.co 常常连不上，默认先走 hf-mirror.com 镜像；
# 想用官方的就 -HfBase https://huggingface.co
$HfBase = if ($HfBase) { $HfBase.TrimEnd('/') } else { 'https://hf-mirror.com' }

function Get-File($url, $dest) {
  if (Test-Path $dest) {
    $len = (Get-Item $dest).Length
    if ($len -gt 0) { Write-Host "  已有 $(Split-Path $dest -Leaf)（$([math]::Round($len/1MB,1))MB），跳过" -ForegroundColor DarkGray; return }
  }
  Write-Host "  ↓ $url" -ForegroundColor DarkGray
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 1800
  $len = (Get-Item $dest).Length
  if ($len -lt 1024) { throw "下载下来只有 $len 字节，八成是被拦了：$url" }
}

Write-Host '[3/4] 下模型（约 500MB，慢一点）' -ForegroundColor Yellow

# 3.1 唤醒词 KWS（35MB）
$kwsName = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
$kwsDir = Join-Path $modelsDir $kwsName
if (-not (Test-Path (Join-Path $kwsDir 'tokens.txt'))) {
  $tar = Join-Path $modelsDir 'kws.tar.bz2'
  Get-File "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$kwsName.tar.bz2" $tar
  Write-Host '  解包 KWS …' -ForegroundColor DarkGray
  & tar -xjf $tar -C $modelsDir
  if ($LASTEXITCODE -ne 0) { throw "解包失败：请手动解压 $tar 到 $modelsDir" }
} else { Write-Host '  已有 KWS 模型，跳过' -ForegroundColor DarkGray }

# 3.2 断句用的 VAD（0.6MB）
$vad = Join-Path $modelsDir 'silero_vad.onnx'
Get-File 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx' $vad

# 3.3 转写用的 whisper（faster-whisper 格式，从 HuggingFace 拉）
$asrDir = Join-Path $modelsDir "fw-$Asr"
$hfRepo = "Systran/faster-whisper-$Asr"
if (-not (Test-Path (Join-Path $asrDir 'model.bin'))) {
  New-Item -ItemType Directory -Force -Path $asrDir | Out-Null
  foreach ($f in 'config.json', 'tokenizer.json', 'vocabulary.txt', 'model.bin') {
    Get-File "$HfBase/$hfRepo/resolve/main/$f" (Join-Path $asrDir $f)
  }
} else { Write-Host "  已有 $asrDir，跳过" -ForegroundColor DarkGray }

# ---------- 4. 把 voice_config.json 指到本地模型 ----------
Write-Host '[4/4] 校正 voice_config.json 里的模型路径 …' -ForegroundColor Yellow

# 唤醒词种子文件：插件不会自己生成拼音，先放一份「大飞鱼/大肥鱼/肥鱼」的底稿，
# 之后侧栏改词时会用 pypinyin 重新编译成 keywords.generated.txt。
$seed = Join-Path $scriptsDir 'keywords-seed.txt'
$kwTarget = Join-Path $modelsDir 'keywords-daifeiyu.txt'
if ((Test-Path $seed) -and -not (Test-Path $kwTarget)) {
  Copy-Item $seed $kwTarget -Force
}

$cfgPath = Join-Path $scriptsDir 'voice_config.json'
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.kws.model_dir = '../models/' + $kwsName
$cfg.kws.keywords_file = '../models/keywords-daifeiyu.txt'
$cfg.vad.model = '../models/silero_vad.onnx'
$cfg.asr.model_dir = '../models/fw-' + $Asr
$json = $cfg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# ---------- 自检 ----------
Write-Host ''
Write-Host '自检：' -ForegroundColor Yellow
Push-Location $scriptsDir
try {
  & $venvPy voice_assistant.py --selftest
  $ok = ($LASTEXITCODE -eq 0)
} finally { Pop-Location }

Write-Host ''
if ($ok) { Write-Host '装好了。' -ForegroundColor Green } else { Write-Host '自检没过，看上面的报错。' -ForegroundColor Red }
Write-Host ''
Write-Host '下一步：打开 DSH 侧栏「肥鱼语音」→ 全部参数（调试用）→ 语音工作区，填：' -ForegroundColor Cyan
Write-Host "  $Workspace"
Write-Host '然后回到「耳朵（喊她名字）」卡片点「现在开始听」。' -ForegroundColor Cyan
Write-Host ''
