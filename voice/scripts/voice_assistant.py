#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
大肥鱼的耳朵 —— 常驻语音输入脚本

链路：
    麦克风 → KWS 唤醒（sherpa-onnx，常驻，RTF≈0.03）
           → VAD 断句（silero，RTF≈0.004）
           → faster-whisper 转写
           → HTTP POST /voice-input → DSH 桥接插件 → 桌宠

设计要点：
  * **唤醒前不跑 ASR**：常驻只跑 KWS + 阈值判断，CPU 占用可以忽略；
    只有喊了"大飞鱼"之后才把音频送进 whisper。
  * **唤醒词与命令要分两句说**：这是 KWS 模型的限制（它做的是词级检测，
    不是"唤醒词+指令"的联合解码）。喊完她会应一声"我在"，然后你再说话。
  * **默认设备冷启动要 20 秒**：第一次开输入流时会在日志里提示，别以为挂了。

三道闸（托管控件在 DSH 的 dsh-coo-aurabot-bridge 插件里）：
  * 锁屏就停、键鼠闲置超时就停、跟着插件一起起停 —— 判断在本脚本，
    因为锁屏与闲置是 Win32 的事实，Node 那边问不到。
  * 全局热键兜底：不方便喊的时候按一下就叫醒（默认 ctrl+alt+j）。
  * 状态通过 `@@GATE {...}` 行回给插件，其余日志走 stdout/stderr。

用法：
    python voice_assistant.py                # 常驻监听
    python voice_assistant.py --managed      # 由插件托管（无控制台，日志走管道）
    python voice_assistant.py --once         # 只跑一轮，说完就退出（调试用）
    python voice_assistant.py --no-kws       # 跳过唤醒词，按回车即录音（调试用）
    python voice_assistant.py --selftest     # 只检查模型/设备/桥接是否就绪
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from ctypes import wintypes
from datetime import datetime
from pathlib import Path

# Windows 控制台默认 cp936，打印中文会炸 —— 先把它掰成 utf-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "voice_config.json"

# 一个模型都没加载时也要能跑起来报错，别在 import 时就崩
np = None
sd = None
sherpa_onnx = None


# --------------------------------------------------------------------------- #
# 配置与日志
# --------------------------------------------------------------------------- #

def load_config(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    def resolve(p: str) -> Path:
        """相对路径按脚本目录解析；支持 ~。"""
        expanded = os.path.expanduser(str(p))
        candidate = Path(expanded)
        if not candidate.is_absolute():
            candidate = (path.parent / candidate).resolve()
        return candidate

    for section in ("kws", "vad", "asr", "log"):
        node = raw.get(section) or {}
        for key in ("model_dir", "keywords_file", "model", "file"):
            if isinstance(node.get(key), str) and node[key]:
                node[key] = resolve(node[key])
    bridge = raw.get("bridge") or {}
    if isinstance(bridge.get("endpoint_file"), str):
        bridge["endpoint_file"] = str(resolve(bridge["endpoint_file"]))
    return raw


class Logger:
    LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}

    def __init__(self, file_path: Path | None, console: bool = True, level: str = "info"):
        self.file_path = file_path
        self.console = console
        self.level = self.LEVELS.get(str(level).lower(), 20)
        if file_path:
            file_path.parent.mkdir(parents=True, exist_ok=True)

    def _write(self, level: str, msg: str) -> None:
        if self.LEVELS[level] < self.level:
            return
        line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]} [{level}] {msg}"
        if self.console:
            print(line, flush=True)
        if self.file_path:
            try:
                with open(self.file_path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass

    def debug(self, m): self._write("debug", m)
    def info(self, m): self._write("info", m)
    def warn(self, m): self._write("warn", m)
    def error(self, m): self._write("error", m)

    def gate(self, state: str, reason: str) -> None:
        """把闸门状态汇报给插件（插件只认 @@ 开头的行，不写进日志文件）。"""
        line = f"@@GATE {json.dumps({'state': state, 'reason': reason}, ensure_ascii=False)}"
        try:
            print(line, flush=True)
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# 三道闸：锁屏停 / 闲置停 / 热键兜底
# --------------------------------------------------------------------------- #

class GateKeeper:
    """
    Win32 事实只能在这里问：Node 拿不到锁屏状态，也拿不到键鼠闲置时长。

    配置来源是插件写的 config.json 的 listen 段（侧栏改的就是它），
    每秒最多 stat 一次，改完不用重启。
    """

    DEFAULT = {
        "pauseOnLock": True,
        "pauseOnIdle": True,
        "idleMinutes": 10,
        "resumeOnActivity": True,
        "releaseMicOnPause": True,
        "pollMs": 1000,
    }

    def __init__(self, log: Logger):
        self.log = log
        self.cfg = dict(self.DEFAULT)
        self._mtime = 0.0
        self._last_check = 0.0
        self._paused_for = ""        # 当前是因为什么暂停的（locked / idle / manual）
        self._last_report = None
        self.hide_cursor_desktop = False

        # Win32
        self.user32 = ctypes.WinDLL("user32", use_last_error=True) if os.name == "nt" else None
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True) if os.name == "nt" else None
        if self.user32 is not None:
            class LASTINPUTINFO(ctypes.Structure):
                _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]
            self._LII = LASTINPUTINFO

        self.refresh(force=True)

    # ---- 配置 ---- #

    def refresh(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_check < 1.0:
            return
        self._last_check = now
        try:
            st = BRIDGE_CONFIG_PATH.stat()
            if not force and st.st_mtime == self._mtime:
                return
            self._mtime = st.st_mtime
            raw = json.loads(BRIDGE_CONFIG_PATH.read_text("utf-8"))
        except Exception:
            return
        node = raw.get("listen") or {}
        merged = dict(self.DEFAULT)
        for k, v in node.items():
            if k in merged and isinstance(v, type(merged[k])):
                merged[k] = v
        # idleMinutes 允许 0.5 这种小数
        try:
            merged["idleMinutes"] = max(0.1, float(node.get("idleMinutes", merged["idleMinutes"])))
        except Exception:
            merged["idleMinutes"] = self.DEFAULT["idleMinutes"]
        if merged != self.cfg:
            self.cfg = merged
            self.log.info(
                "护栏设置：" + ("锁屏停 " if merged["pauseOnLock"] else "")
                + (f"闲置 {merged['idleMinutes']:g} 分停" if merged["pauseOnIdle"] else "闲置不停")
                + ("，松开麦克风" if merged["releaseMicOnPause"] else "")
            )

    def hotkey_conf(self) -> dict:
        try:
            raw = json.loads(BRIDGE_CONFIG_PATH.read_text("utf-8"))
            hk = raw.get("listen", {}).get("hotkey") or {}
        except Exception:
            hk = {}
        return {
            "enabled": hk.get("enabled", True) is not False,
            "combo": str(hk.get("combo") or "ctrl+alt+j"),
        }

    # ---- 事实 ---- #

    def idle_seconds(self) -> float:
        if self.user32 is None:
            return 0.0
        lii = self._LII()
        lii.cbSize = ctypes.sizeof(lii)
        if not self.user32.GetLastInputInfo(ctypes.byref(lii)):
            return 0.0
        now = self.kernel32.GetTickCount()
        return max(0.0, (now - lii.dwTime) / 1000.0)

    def screen_locked(self) -> bool:
        """
        OpenInputDesktop 失败 = 当前在安全桌面（锁屏 / UAC 弹窗）。
        这是纯查询，不去 SwitchDesktop，所以不会打扰用户。
        """
        if self.user32 is None:
            return False
        DESKTOP_READOBJECTS, DESKTOP_SWITCHDESKTOP = 0x0001, 0x0100
        h = self.user32.OpenInputDesktop(0, False, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP)
        if not h:
            return True
        try:
            self.user32.CloseDesktop(h)
        except Exception:
            pass
        return False

    def should_pause(self) -> tuple[str, str]:
        """返回 (原因, 人话说明)；空原因 = 可以听。"""
        self.refresh()
        if self.cfg["pauseOnLock"] and self.screen_locked():
            return "locked", "锁屏了"
        if self.cfg["pauseOnIdle"]:
            idle = self.idle_seconds()
            if idle >= self.cfg["idleMinutes"] * 60:
                return "idle", f"闲置 {idle / 60:.0f} 分钟"
        return "", ""

    def report(self, state: str, reason: str) -> None:
        """状态变了才汇报，别的行不刷屏。"""
        key = (state, reason)
        if key == self._last_report:
            return
        self._last_report = key
        self.log.gate(state, reason)


def parse_combo(combo: str) -> tuple[int, int] | None:
    """'ctrl+alt+j' → (MOD_CONTROL|MOD_ALT, ord('J'))。"""
    mods = {"ctrl": 0x0002, "control": 0x0002, "alt": 0x0001, "shift": 0x0004, "win": 0x0008}
    mask = 0
    vk = None
    for part in str(combo).lower().split("+"):
        p = part.strip()
        if not p:
            continue
        if p in mods:
            mask |= mods[p]
        elif len(p) == 1 and (p.isalpha() or p.isdigit()):
            vk = ord(p.upper())
        elif p.startswith("f") and p[1:].isdigit() and 1 <= int(p[1:]) <= 24:
            vk = 0x70 + int(p[1:]) - 1
        elif p == "space":
            vk = 0x20
    if vk is None or mask == 0:
        return None
    return mask, vk


class HotkeyListener(threading.Thread):
    """
    全局热键兜底（WM_HOTKEY）。不用 keyboard/pynput，纯 ctypes 起一个消息循环线程。

    为什么需要它：喊不出来的时候（半夜、旁边有人、麦克风被别的程序占了），
    按一下热键就等于"我喊了一声"。它只是个触发器，不监听任何按键。
    """

    def __init__(self, combo: str, log: Logger):
        super().__init__(daemon=True, name="hotkey")
        self.combo = combo
        self.log = log
        self.event = threading.Event()
        self.ok = False
        self._tid = None
        self._thread_id = None
        self._stop = False

    def run(self) -> None:
        if os.name != "nt":
            return
        parsed = parse_combo(self.combo)
        if not parsed:
            self.log.warn(f"热键格式看不懂：{self.combo}（例：ctrl+alt+j）")
            return
        mask, vk = parsed
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._tid = 0xB1F1
        # 注意：RegisterHotKey 绑在调用线程上，所以必须在本线程注册
        if not user32.RegisterHotKey(None, self._tid, mask, vk):
            self.log.warn(f"热键注册失败（{self.combo} 可能已被别的程序占用）")
            return
        self.ok = True
        self._thread_id = ctypes.WinDLL("kernel32").GetCurrentThreadId()
        self.log.info(f"全局热键已挂：{self.combo}（按一下等于喊一声）")
        msg = wintypes.MSG()
        try:
            while not self._stop:
                r = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if r == 0 or r == -1:
                    break
                if msg.message == 0x0312 and int(msg.wParam) == self._tid:
                    self.log.info("★ 热键按下了")
                    self.event.set()
        finally:
            try:
                user32.UnregisterHotKey(None, self._tid)
            except Exception:
                pass

    def stop(self) -> None:
        self._stop = True
        if os.name == "nt" and self._thread_id:
            try:
                ctypes.WinDLL("user32").PostThreadMessageW(self._thread_id, 0x0012, 0, 0)  # WM_QUIT
            except Exception:
                pass


# --------------------------------------------------------------------------- #
# 桥接客户端
# --------------------------------------------------------------------------- #

class BridgeClient:
    """读插件写的 endpoint.json，把文字打进桌宠。"""

    def __init__(self, cfg: dict, log: Logger):
        b = cfg.get("bridge") or {}
        self.endpoint_file = Path(b.get("endpoint_file") or "~/.dsh/plugins-data/coo-aurabot-bridge/endpoint.json").expanduser()
        self.url_override = b.get("url_override")
        self.token_override = b.get("token_override")
        self.timeout = float(b.get("timeout_s") or 10)
        self.log = log

    def _endpoint(self) -> tuple[str, str]:
        if self.url_override:
            token = self.token_override or ""
            if not token and self.endpoint_file.exists():
                try:
                    token = json.loads(self.endpoint_file.read_text("utf-8")).get("token", "")
                except Exception:
                    token = ""
            return str(self.url_override), str(token)

        if not self.endpoint_file.exists():
            raise RuntimeError(
                f"没找到 {self.endpoint_file} —— DSH 里的 dsh-coo-aurabot-bridge 还没启动过？"
            )
        data = json.loads(self.endpoint_file.read_text("utf-8"))
        url = data.get("url")
        if not url:
            # 兜底：插件卸载时会把自己写下的 url 抹成 null，但只要端口还在就能拼出来
            base = data.get("baseUrl")
            port = data.get("port")
            if not base and port:
                base = f"http://127.0.0.1:{int(port)}"
            if base:
                url = f"{str(base).rstrip('/')}/api/dsh-coo-aurabot-bridge/voice-input"
                self.log.warn(f"endpoint.json 的 url 是空的，按 baseUrl 拼：{url}")
        if not url:
            raise RuntimeError("endpoint.json 里既没有 url 也没有 port —— 插件还没挂上路由？")
        return str(url), str(data.get("token") or "")

    def _post(self, payload: dict) -> dict:
        url, token = self._endpoint()
        payload = dict(payload)
        payload["token"] = token
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json; charset=utf-8", "X-Bridge-Token": token},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                text = resp.read().decode("utf-8", "replace")
                try:
                    return json.loads(text)
                except Exception:
                    return {"ok": resp.status == 200, "raw": text}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            try:
                return json.loads(detail)
            except Exception:
                return {"ok": False, "reason": f"http-{e.code}", "detail": detail[:200]}
        except urllib.error.URLError as e:
            return {"ok": False, "reason": "bridge-unreachable", "detail": str(e.reason)}

    def send_text(self, text: str) -> dict:
        return self._post({"text": text, "source": "voice"})

    def send_wake(self, echo: str) -> dict:
        return self._post({"wake": True, "echo": echo})

    def ping(self) -> dict:
        """直接 GET /status，用来判断插件活着没有。"""
        url, _ = self._endpoint()
        base = url.rsplit("/", 1)[0]
        try:
            with urllib.request.urlopen(base + "/status", timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:
            return {"ok": False, "reason": str(e)}


# --------------------------------------------------------------------------- #
# 唤醒词检测
# --------------------------------------------------------------------------- #

# 桥接插件写下的配置：唤醒词以这里为唯一真相（侧栏改的就是它）
BRIDGE_CONFIG_PATH = Path.home() / ".dsh" / "plugins-data" / "coo-aurabot-bridge" / "config.json"


def bridge_config_mtime() -> float:
    """插件配置的修改时间；不存在返回 0。用来判断"侧栏是不是刚改过词"。"""
    try:
        return BRIDGE_CONFIG_PATH.stat().st_mtime
    except OSError:
        return 0.0


def sync_wakewords(cfg: dict, log: "Logger") -> Path | None:
    """
    从桥接插件的 config.json 取唤醒词（中文），编译成本地 keywords 文件。

    为什么要经过插件：侧栏改词写的是 config.json，那是**用户意图**；
    真正的 KWS 关键词是拼音 token 串，属于**派生数据**。
    派生数据每次启动/每次改词重算一遍，就不会出现"两边不一致"。

    返回生成的文件路径；拿不到词表/没装 pypinyin 就返回 None（沿用原 keywords 文件）。
    """
    try:
        import gen_keywords as gk
    except Exception as e:  # noqa: BLE001  没装 pypinyin 或脚本不在同一目录
        log.warn(f"唤醒词同步跳过（{e}）——沿用 voice_config.json 里的 keywords_file")
        return None

    try:
        words, meta = gk.read_words_from_config(BRIDGE_CONFIG_PATH)
        tokens_path = Path(cfg["kws"]["model_dir"]) / "tokens.txt"
        tokens = gk.load_tokens(tokens_path)
        lines, errors = gk.build_lines(words, tokens)
        if not lines:
            log.warn("唤醒词一条都没生成出来：" + ("; ".join(errors) or "词表为空"))
            return None

        out = Path(cfg["kws"].get("generated_keywords_file")
                   or (HERE.parent / "models" / "keywords.generated.txt"))
        out.parent.mkdir(parents=True, exist_ok=True)
        # UTF-8 无 BOM + CRLF：带 BOM 会让 sherpa 报 "Cannot find ID for token ﻿d"
        out.write_bytes(("\r\n".join(lines) + "\r\n").encode("utf-8"))
        # 记下当前生效的词，纯粹为了日志能报准（用户改了词之后别再说错）
        cfg["kws"]["_active_words"] = words
        log.info(f"唤醒词已同步：{len(lines)} 条（来源 {meta.get('source')}）→ {out.name}")
        for e in errors:
            log.warn(f"  忽略：{e}")
        return out
    except Exception as e:  # noqa: BLE001  同步失败不该让语音整体停摆
        log.warn(f"唤醒词同步失败（沿用原文件）：{e}")
        return None


class WakeWord:
    """
    sherpa-onnx 的 KeywordSpotter 封装。

    必须按帧喂（长度随 KWS 模型而定，这里用 512 样本 = 32ms），
    每次喂完检查 is_ready → decode_stream → get_result。
    """

    def __init__(self, cfg: dict, log: Logger):
        k = cfg["kws"]
        self.log = log
        self.sample_rate = int(cfg["audio"]["sample_rate"])
        self.model_dir = Path(k["model_dir"])
        self.trailing_silence = k.get("trailing_silence_s", 0.3)

        if not self.model_dir.is_dir():
            raise RuntimeError(f"KWS 模型目录不存在：{self.model_dir}")
        kw_file = Path(k["keywords_file"])
        if not kw_file.is_file():
            raise RuntimeError(f"唤醒词文件不存在：{kw_file}")

        # 关键坑：带 BOM 的文件会让 sherpa 报 "Cannot find ID for token ﻿d"
        head = kw_file.read_bytes()[:3]
        if head == b"\xef\xbb\xbf":
            raise RuntimeError(f"{kw_file} 带 UTF-8 BOM，sherpa 会解析失败，请存成无 BOM")

        def pick(prefix: str) -> Path:
            cands = sorted(self.model_dir.glob(f"{prefix}-*.int8.onnx"))
            if not cands:
                cands = sorted(self.model_dir.glob(f"{prefix}-*.onnx"))
            if not cands:
                raise RuntimeError(f"{self.model_dir} 里找不到 {prefix}-*.onnx")
            return cands[-1]

        self.spotter = sherpa_onnx.KeywordSpotter(
            tokens=str(self.model_dir / "tokens.txt"),
            encoder=str(pick("encoder")),
            decoder=str(pick("decoder")),
            joiner=str(pick("joiner")),
            keywords_file=str(kw_file),
            num_threads=int(k.get("num_threads", 2)),
            sample_rate=self.sample_rate,
            feature_dim=80,
            max_active_paths=4,
            keywords_score=float(k.get("keywords_score", 1.0)),
            keywords_threshold=float(k.get("keywords_threshold", 0.25)),
            num_trailing_blanks=1,
            provider="cpu",
        )
        self.stream = self.spotter.create_stream()
        self._pending_silence = 0
        self._silence_needed = int(self.trailing_silence * self.sample_rate)
        self.log.info(f"唤醒词模型已装载：{self.model_dir.name}（{kw_file.name}）")

    def reset(self) -> None:
        self.stream = self.spotter.create_stream()
        self._pending_silence = 0

    def feed(self, samples) -> list[str]:
        """喂一帧，返回这一帧命中的唤醒词列表（通常是空的）。"""
        hits: list[str] = []
        self.stream.accept_waveform(self.sample_rate, samples)
        while self.spotter.is_ready(self.stream):
            self.spotter.decode_stream(self.stream)
        result = self.spotter.get_result(self.stream)
        if result:
            keyword = getattr(result, "keyword", result)
            hits.append(str(keyword))
            self.spotter.reset_stream(self.stream)
        return hits

    def feed_final(self, samples) -> list[str]:
        """
        尾部补静音再收一次 —— 实测必需：词刚说完就断流会漏检。
        """
        hits = self.feed(samples)
        silence = np.zeros(int(self.trailing_silence * self.sample_rate), dtype=np.float32)
        self.stream.accept_waveform(self.sample_rate, silence)
        self.stream.input_finished()
        while self.spotter.is_ready(self.stream):
            self.spotter.decode_stream(self.stream)
        result = self.spotter.get_result(self.stream)
        if result:
            keyword = getattr(result, "keyword", result)
            hits.append(str(keyword))
        self.spotter.reset_stream(self.stream)
        return hits


# --------------------------------------------------------------------------- #
# 断句
# --------------------------------------------------------------------------- #

class SpeechSegmenter:
    """silero VAD 封装：喂帧，拿回完整的语音段。"""

    def __init__(self, cfg: dict, log: Logger):
        v = cfg["vad"]
        self.log = log
        self.sample_rate = int(cfg["audio"]["sample_rate"])
        model = Path(v["model"])
        if not model.is_file():
            raise RuntimeError(f"VAD 模型不存在：{model}")

        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(model)
        config.silero_vad.min_silence_duration = float(v.get("min_silence_duration", 0.55))
        config.silero_vad.min_speech_duration = float(v.get("min_speech_duration", 0.25))
        config.sample_rate = self.sample_rate
        config.num_threads = int(v.get("num_threads", 1))
        config.provider = "cpu"

        self.vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=int(v.get("buffer_seconds", 60)))
        self.log.info("VAD 已装载：silero_vad.onnx")

    def reset(self) -> None:
        self.vad.reset()

    def feed(self, samples) -> list:
        """喂一帧，返回已经说完的语音段（numpy float32）。"""
        self.vad.accept_waveform(samples)
        segments = []
        while not self.vad.empty():
            seg = self.vad.front
            segments.append(np.array(seg.samples, dtype=np.float32))
            self.vad.pop()
        return segments

    def flush(self) -> list:
        """强制收尾（超时用），返回剩下的语音段。"""
        self.vad.flush()
        segments = []
        while not self.vad.empty():
            seg = self.vad.front
            segments.append(np.array(seg.samples, dtype=np.float32))
            self.vad.pop()
        return segments


# --------------------------------------------------------------------------- #
# 转写
# --------------------------------------------------------------------------- #

class Transcriber:
    def __init__(self, cfg: dict, log: Logger):
        a = cfg["asr"]
        self.log = log
        self.model_dir = Path(a["model_dir"])
        self.language = a.get("language", "zh")
        self.max_chars = int(a.get("max_chars", 500))
        self.model = None
        # WhisperModel 的构造参数（beam_size 不在这里，它是 transcribe() 的参数）
        self._args = dict(
            compute_type=a.get("compute_type", "int8"),
            cpu_threads=int(a.get("cpu_threads", 4)),
        )
        self.beam_size = int(a.get("beam_size", 1))

        if not (self.model_dir / "model.bin").is_file():
            raise RuntimeError(f"whisper 模型不完整：{self.model_dir} 下没有 model.bin")

    def warm_up(self) -> None:
        """提前把模型读进内存（首次 ~3-8 秒），别等用户喊了才开始加载。"""
        self.model = self._load()
        silence = np.zeros(16000, dtype=np.float32)
        self.transcribe(silence)  # 跑一遍空音频，把图也编译掉
        self.log.info("whisper 已预热")

    def _load(self):
        from faster_whisper import WhisperModel
        t0 = time.time()
        model = WhisperModel(str(self.model_dir), device="cpu", **self._args)
        self.log.info(f"whisper 装载完毕（{time.time() - t0:.1f}s）：{self.model_dir.name}")
        return model

    def transcribe(self, samples) -> str:
        if self.model is None:
            self.model = self._load()
        if samples is None or len(samples) < int(0.2 * 16000):
            return ""
        t0 = time.time()
        segments, _info = self.model.transcribe(
            samples,
            language=self.language,
            beam_size=self.beam_size,
            vad_filter=False,        # 我们已经在外面用 silero 切过了
            condition_on_previous_text=False,
        )
        text = "".join(seg.text for seg in segments).strip()
        elapsed = time.time() - t0
        audio_s = len(samples) / 16000
        rtf = elapsed / audio_s if audio_s > 0 else 0
        self.log.info(f"转写 {audio_s:.1f}s 音频用了 {elapsed:.2f}s（RTF {rtf:.2f}）：{text[:60]}")
        if len(text) > self.max_chars:
            text = text[: self.max_chars]
        return text


# --------------------------------------------------------------------------- #
# 麦克风
# --------------------------------------------------------------------------- #

class Microphone:
    """把 16k 单声道 float32 帧塞进队列。"""

    def __init__(self, cfg: dict, log: Logger):
        a = cfg["audio"]
        self.log = log
        self.sample_rate = int(a["sample_rate"])
        self.block = int(a.get("block", 512))
        self.device = a.get("device")
        self.q: queue.Queue = queue.Queue(maxsize=200)
        self.stream = None

    def start(self) -> None:
        # 实测：WasapiSettings(auto_convert=True) 会报 -9984，别用
        self.stream = sd.InputStream(
            samplerate=self.sample_rate,
            blocksize=self.block,
            channels=1,
            dtype="float32",
            device=self.device,
            callback=self._cb,
        )
        self.log.info(f"打开麦克风（{self.sample_rate}Hz / block {self.block}）……首次可能等 20 秒")
        t0 = time.time()
        self.stream.start()
        self.log.info(f"麦克风已就绪（{time.time() - t0:.1f}s）")

    def _cb(self, indata, frames, time_info, status):
        if status:
            self.log.debug(f"音频状态：{status}")
        try:
            self.q.put_nowait(indata[:, 0].copy())
        except queue.Full:
            pass  # 处理不过来就丢帧，绝不阻塞音频线程

    def read(self, timeout: float = 1.0):
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain(self) -> None:
        while True:
            try:
                self.q.get_nowait()
            except queue.Empty:
                return

    def stop(self) -> None:
        try:
            if self.stream is not None:
                self.stream.stop()
                self.stream.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

def list_input_devices(log: Logger) -> None:
    try:
        default_in = sd.default.device[0]
        for idx, dev in enumerate(sd.query_devices()):
            if dev.get("max_input_channels", 0) > 0:
                mark = " ← 默认" if idx == default_in else ""
                log.info(f"  [{idx}] {dev['name']}（{int(dev['default_samplerate'])}Hz，{dev['max_input_channels']}ch）{mark}")
    except Exception as e:
        log.warn(f"枚举音频设备失败：{e}")


def recognise_once(mic: Microphone, seg: SpeechSegmenter, asr: Transcriber, cfg: dict, log: Logger,
                   timeout_s: float | None = None) -> str:
    """
    从麦克风收一段话，直到 VAD 判定说完（或超时）。
    返回转写文字（可能为空）。
    """
    s = cfg["session"]
    listen_timeout = float(timeout_s if timeout_s is not None else s.get("listen_timeout_s", 6.0))
    max_utterance = float(s.get("max_utterance_s", 20.0))

    seg.reset()
    mic.drain()

    started = time.time()
    heard_anything = False
    collected: list = []
    speech_started_at = None

    log.info("在听……")
    while True:
        chunk = mic.read(timeout=0.5)
        if chunk is None:
            if not heard_anything and time.time() - started > listen_timeout:
                log.info("没有听到说话，回到待唤醒")
                return ""
            continue

        pieces = seg.feed(chunk)
        if pieces:
            heard_anything = True
            speech_started_at = speech_started_at or time.time()
            collected.extend(pieces)
            # 说完一段就停（一次只说一句）
            break

        if not heard_anything and time.time() - started > listen_timeout:
            log.info("没有听到说话，回到待唤醒")
            return ""
        if heard_anything and speech_started_at and (time.time() - speech_started_at) > max_utterance:
            collected.extend(seg.flush())
            log.info("超过最长说话时间，强制收尾")
            break

    if not collected:
        collected = seg.flush()
    if not collected:
        log.info("这一段是空的")
        return ""

    audio = np.concatenate(collected) if len(collected) > 1 else collected[0]
    return asr.transcribe(audio)


def selftest(cfg: dict, log: Logger) -> int:
    ok = True
    log.info("=" * 60)
    log.info("自检开始")

    # 1. 依赖
    for mod in ("numpy", "sounddevice", "sherpa_onnx"):
        try:
            __import__(mod)
            log.info(f"  ✓ {mod}")
        except Exception as e:
            log.error(f"  ✗ {mod}: {e}")
            ok = False
    try:
        import faster_whisper  # noqa: F401
        log.info("  ✓ faster_whisper")
    except Exception as e:
        log.error(f"  ✗ faster_whisper: {e}")
        ok = False

    # 2. 麦克风
    try:
        devs = [d for d in sd.query_devices() if d.get("max_input_channels", 0) > 0]
        log.info(f"  ✓ 输入设备 {len(devs)} 个")
        list_input_devices(log)
    except Exception as e:
        log.error(f"  ✗ 麦克风: {e}")
        ok = False

    # 3. 模型
    for label, path in (
        ("KWS 模型目录", Path(cfg["kws"]["model_dir"])),
        ("VAD 模型", Path(cfg["vad"]["model"])),
        ("whisper model.bin", Path(cfg["asr"]["model_dir"]) / "model.bin"),
    ):
        if path.exists():
            log.info(f"  ✓ {label}: {path}")
        else:
            log.error(f"  ✗ {label} 不存在: {path}")
            ok = False

    kw = Path(cfg["kws"]["keywords_file"])
    if kw.is_file():
        if kw.read_bytes()[:3] == b"\xef\xbb\xbf":
            log.error(f"  ✗ {kw.name} 带 BOM")
            ok = False
        else:
            log.info(f"  ✓ 唤醒词文件: {kw.name}（{len(kw.read_text('utf-8').strip().splitlines())} 条）")

    # 4. 桥接
    try:
        client = BridgeClient(cfg, log)
        status = client.ping()
        if status.get("ok"):
            gates = status.get("gates") or {}
            log.info(f"  ✓ 桥接插件在线：{status.get('baseUrl')}")
            log.info(f"     闸门 aToQ={gates.get('aToQ')} q2p={gates.get('q2p')} voiceInput={gates.get('voiceInput')}")
            au = status.get("aurabot") or {}
            log.info(f"     auarabot available={au.get('available')} enabled={au.get('enabled')} dryRun={au.get('dryRun')}")
        else:
            log.error(f"  ✗ 桥接插件连不上：{status.get('reason')}")
            ok = False
    except Exception as e:
        log.error(f"  ✗ 桥接：{e}")
        ok = False

    log.info("自检" + ("通过" if ok else "失败"))
    log.info("=" * 60)
    return 0 if ok else 1


def main() -> int:
    global np, sd, sherpa_onnx

    ap = argparse.ArgumentParser(description="大肥鱼的耳朵")
    ap.add_argument("--config", default=str(CONFIG_PATH))
    ap.add_argument("--once", action="store_true", help="只跑一轮就退出")
    ap.add_argument("--no-kws", action="store_true", help="跳过唤醒词，按回车开始录音")
    ap.add_argument("--selftest", action="store_true", help="只自检")
    ap.add_argument("--wav", help="不录音，直接转写这个 wav 并送入桌宠（端到端调试）")
    ap.add_argument("--managed", action="store_true",
                    help="托管模式：由 DSH 插件拉起（没有控制台，不读 stdin，护栏常开）")
    args = ap.parse_args()

    cfg = load_config(Path(args.config))
    logcfg = cfg.get("log") or {}
    log = Logger(Path(logcfg["file"]) if logcfg.get("file") else None,
                 console=bool(logcfg.get("console", True)),
                 level=str(logcfg.get("level", "info")))

    log.info("=" * 60)
    log.info("大肥鱼的耳朵启动")

    # 依赖延迟导入，好让 --selftest 能在缺依赖时报清楚是哪个
    try:
        import numpy as _np
        np = _np
    except Exception as e:
        log.error(f"缺 numpy：{e}（pip install numpy -i https://mirrors.aliyun.com/pypi/simple/）")
        return 2
    try:
        import sounddevice as _sd
        sd = _sd
    except Exception as e:
        log.error(f"缺 sounddevice：{e}")
        return 2
    try:
        import sherpa_onnx as _so
        sherpa_onnx = _so
    except Exception as e:
        log.error(f"缺 sherpa_onnx：{e}")
        return 2

    if args.selftest:
        return selftest(cfg, log)

    client = BridgeClient(cfg, log)

    # --wav：只做转写 + 投递，完全不开麦克风
    if args.wav:
        asr = Transcriber(cfg, log)
        with wave.open(args.wav, "rb") as w:
            if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
                log.error(f"{args.wav} 必须是 16kHz / 单声道 / 16bit")
                return 2
            raw = w.readframes(w.getnframes())
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        text = asr.transcribe(samples)
        if not text:
            log.error("没转出文字")
            return 1
        log.info(f"转写结果：{text}")
        try:
            r = client.send_text(text)
        except Exception as e:
            # 调试转写时桥接没起来不算失败，只是投递不了
            log.warn(f"投递失败（转写本身是好的）：{e}")
            return 0
        log.info(f"投递结果：{r}")
        return 0 if r.get("ok") else 1

    # 先把侧栏配的唤醒词编译出来（拿不到就沿用 voice_config.json 里那个文件）
    if not args.no_kws:
        generated = sync_wakewords(cfg, log)
        if generated:
            cfg["kws"]["keywords_file"] = str(generated)

    # 装载三件套
    try:
        mic = Microphone(cfg, log)
        seg = SpeechSegmenter(cfg, log)
        asr = Transcriber(cfg, log)
        wake = None if args.no_kws else WakeWord(cfg, log)
    except Exception as e:
        log.error(f"初始化失败：{e}")
        return 2

    list_input_devices(log)

    try:
        mic.start()
    except Exception as e:
        log.error(f"打不开麦克风：{e}")
        return 2

    asr.warm_up()

    # 三道闸 + 热键兜底（托管模式下常开；手动跑也生效，方便现场试）
    gate = GateKeeper(log)
    hotkey = None
    hk_conf = gate.hotkey_conf()
    if hk_conf["enabled"]:
        hotkey = HotkeyListener(hk_conf["combo"], log)
        hotkey.start() if hotkey else None
    gate.report("listening", "可以听")

    try:
        if args.no_kws:
            # 调试模式：按回车即录音
            log.info("调试模式（无唤醒词）：按回车开始说话，Ctrl+C 退出")
            while True:
                input()
                text = recognise_once(mic, seg, asr, cfg, log, timeout_s=30)
                if text:
                    log.info(f"→ 投递：{text}")
                    log.info(f"  结果：{client.send_text(text)}")
                if args.once:
                    return 0
        else:
            # 唤醒词以插件侧 config.json 为唯一真相：它一变就重建 spotter，不用重启脚本
            last_cfg_mtime = bridge_config_mtime()
            last_check = 0.0
            active = cfg["kws"].get("_active_words") or []
            log.info("待唤醒：喊 " + ("、".join(f"「{w}」" for w in active) if active else "配置里的唤醒词"))
            cooldown_until = 0.0
            paused_for = ""
            mic_live = True
            while True:
                # ---- 闸门：先问 Win32 能不能听（每秒最多查一次，宁慢不停） ----
                why, human = gate.should_pause()
                if why and not paused_for:
                    paused_for = why
                    gate.report("paused", human)
                    log.info(f"耳朵暂停：{human}")
                    if gate.cfg["releaseMicOnPause"] and mic_live:
                        mic.stop()
                        mic_live = False
                        log.info("麦克风已松开")
                    if wake is not None:
                        wake.reset()
                elif not why and paused_for:
                    paused_for = ""
                    gate.report("listening", "可以听")
                    log.info("耳朵恢复：接着听")

                if paused_for:
                    if hotkey is not None:
                        hotkey.event.clear()   # 暂停时的热键也当没听见
                    time.sleep(0.5)
                    continue

                if not mic_live:
                    try:
                        mic.start()
                        mic_live = True
                        mic.drain()
                    except Exception as e:  # noqa: BLE001  麦克风被别人占了就等一会再试
                        log.error(f"重新打开麦克风失败：{e}")
                        time.sleep(3)
                        continue

                # ---- 热键：按一下等于喊了一声 ----
                triggered = False
                if hotkey is not None and hotkey.event.is_set():
                    hotkey.event.clear()
                    triggered = True

                chunk = mic.read(timeout=0.5)
                if not triggered and chunk is None:
                    continue
                if time.time() < cooldown_until:
                    continue

                # 每秒最多查一次 config.json（别每帧 stat）
                now_ts = time.time()
                if now_ts - last_check >= 1.0:
                    last_check = now_ts
                    m = bridge_config_mtime()
                    if m and m != last_cfg_mtime:
                        last_cfg_mtime = m
                        log.info("检测到唤醒词配置变化，正在重载…")
                        new_path = sync_wakewords(cfg, log)
                        if new_path:
                            cfg["kws"]["keywords_file"] = str(new_path)
                            try:
                                wake = WakeWord(cfg, log)   # 旧 spotter 由 GC 回收
                                log.info("★ 唤醒词已热重载，立即生效")
                            except Exception as e:  # noqa: BLE001  重载失败不能拖垮监听
                                log.error(f"唤醒词热重载失败，继续用旧的：{e}")

                if not triggered:
                    hits = wake.feed(chunk)
                    if not hits:
                        continue
                    log.info(f"★ 唤醒：{hits}")
                else:
                    log.info("★ 唤醒：热键")

                wake.reset() if wake is not None else None
                seg.reset()
                mic.drain()

                # 应一声（只说话，不触发 LLM）
                s = cfg["session"]
                echo = str(s.get("echo_on_wake") or "我在")
                r = client.send_wake(echo)
                log.info(f"  唤醒应答：{r.get('ok')}")

                text = recognise_once(mic, seg, asr, cfg, log)
                if text:
                    r = client.send_text(text)
                    log.info(f"  投递：{r}")

                    # 语音输入绑定的会话要记下来（方向 A 的白名单靠它）
                    sid = (r or {}).get("sessionId")
                    if sid:
                        log.info(f"  绑定会话：{sid}")

                cooldown_until = time.time() + float(s.get("wake_cooldown_s", 0.8))

                if args.once:
                    return 0
    except KeyboardInterrupt:
        log.info("收到 Ctrl+C，退出")
        return 0
    finally:
        if hotkey is not None:
            hotkey.stop()
        gate.report("stopped", "退出了")
        mic.stop()


if __name__ == "__main__":
    sys.exit(main())
