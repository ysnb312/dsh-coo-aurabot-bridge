#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把**中文唤醒词**编译成 sherpa-onnx KWS 能吃的 keywords 文件。

为什么需要这个：
  sherpa-onnx 的 keywords_file 不是中文词表，而是「带声调拼音 token 串」，
  形如  d à f ēi y ú @大飞鱼
  每个音节要按模型的 tokens.txt 切成子词（d + à / f + ēi / y + ú）。
  手写既容易错（调号打错就静默不命中），也没法让侧栏改词。

做的事：
  1. pypinyin 把中文转带调拼音               大飞鱼 → ['dà','fēi','yú']
  2. 按 tokens.txt 做**最长匹配**切分音节      'dà' → ['d','à']（而不是 ['dà']）
  3. 拼成 `tokens @中文词` 一行一词，写 UTF-8 **无 BOM**（带 BOM 会让 sherpa 报
     "Cannot find ID for token ﻿d"，这是踩过的坑）

用法：
  # 从插件的 config.json 读（推荐，侧栏改完就能生成）
  python gen_keywords.py --config ~/.dsh/plugins-data/coo-aurabot-bridge/config.json

  # 直接给词
  python gen_keywords.py --words "大飞鱼,大肥鱼,肥鱼"

  # 只校验，不写文件
  python gen_keywords.py --words "大飞鱼" --check
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DEFAULT_MODEL_DIR = ROOT / "models" / "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
DEFAULT_TOKENS = DEFAULT_MODEL_DIR / "tokens.txt"
DEFAULT_OUT = ROOT / "models" / "keywords.generated.txt"

# 插件写下的配置（侧栏保存到这里）
DEFAULT_BRIDGE_CONFIG = Path.home() / ".dsh" / "plugins-data" / "coo-aurabot-bridge" / "config.json"

# 与 models/keywords-daifeiyu.txt 一致的出厂词；config 里没写就用它
FALLBACK_WORDS = ["大飞鱼", "大肥鱼", "肥鱼"]


def load_tokens(path: Path) -> list[str]:
    """读 tokens.txt，返回按长度降序排好的 token 列表（最长匹配要用）。"""
    if not path.is_file():
        raise SystemExit(f"[x] tokens.txt 不存在：{path}")
    toks: list[str] = []
    for line in path.read_text("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        # 格式是 "token id"，只取第一段
        tok = line.split()[0]
        if tok:
            toks.append(tok)
    # 最长优先，保证 'zh' 先于 'z'、'ēng' 先于 'ē'
    toks.sort(key=len, reverse=True)
    return toks


def split_syllable(syllable: str, tokens: list[str]) -> list[str] | None:
    """
    把一个带调音节切成 token 序列（贪心最长匹配）。

    'dà'  → ['d', 'à']        （tokens 里没有 'dà'，但有 'd' 和 'à'）
    'fēi' → ['f', 'ēi']
    'zhǎng' → ['zh', 'ǎng']

    切不开就返回 None（说明这个词在这个模型里念不出来）。
    """
    out: list[str] = []
    i = 0
    n = len(syllable)
    while i < n:
        for tok in tokens:
            if syllable.startswith(tok, i):
                out.append(tok)
                i += len(tok)
                break
        else:
            return None  # 有字符落不进任何 token
    return out


def build_lines(words: list[str], tokens: list[str]) -> tuple[list[str], list[str]]:
    """返回 (keywords 行, 失败说明)。中文词必须原样保留在 @ 后面。"""
    from pypinyin import lazy_pinyin, Style  # 延迟导入：--check 之外不需要

    lines: list[str] = []
    errors: list[str] = []

    for word in words:
        word = word.strip()
        if not word:
            continue

        # 已经是拼音串（含空格）就原样当一行用，方便手写调试
        if " " in word:
            if "@" not in word:
                errors.append(f"{word!r}：手写的拼音串缺少 @显示名")
                continue
            lines.append(word)
            continue

        syllables = lazy_pinyin(word, style=Style.TONE)
        parts: list[str] = []
        bad = False
        for syl in syllables:
            if not syl:
                continue
            piece = split_syllable(syl, tokens)
            if piece is None:
                errors.append(f"{word!r}：音节 {syl!r} 无法按 tokens.txt 切分")
                bad = True
                break
            parts.extend(piece)
        if bad:
            continue
        if not parts:
            errors.append(f"{word!r}：转不出任何拼音")
            continue

        # 注意 @ 前那个空格是 sherpa 的字段分隔，不能省：
        # 写成 "ú@大飞鱼" 会让它把 "@大飞鱼" 当 token 解析而报 ID 找不到。
        lines.append(" ".join(parts) + " @" + word)

    return lines, errors


def read_words_from_config(path: Path) -> tuple[list[str], dict]:
    """从插件的 config.json 取 wake.words。读不到就返回出厂词。"""
    if not path.is_file():
        return list(FALLBACK_WORDS), {"source": "fallback", "reason": f"没找到 {path}"}
    try:
        cfg = json.loads(path.read_text("utf-8"))
    except Exception as e:  # noqa: BLE001
        return list(FALLBACK_WORDS), {"source": "fallback", "reason": f"config.json 解析失败：{e}"}

    wake = cfg.get("wake") if isinstance(cfg.get("wake"), dict) else {}
    words = wake.get("words")
    if not isinstance(words, list) or not words:
        return list(FALLBACK_WORDS), {"source": "fallback", "reason": "config.wake.words 为空"}
    return [str(w) for w in words], {"source": "config", "path": str(path)}


def main() -> int:
    ap = argparse.ArgumentParser(description="中文唤醒词 → sherpa-onnx keywords 文件")
    ap.add_argument("--config", default=str(DEFAULT_BRIDGE_CONFIG), help="插件的 config.json")
    ap.add_argument("--words", help="直接给词，逗号分隔（优先于 --config）")
    ap.add_argument("--tokens", default=str(DEFAULT_TOKENS), help="模型的 tokens.txt")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="输出文件")
    ap.add_argument("--check", action="store_true", help="只校验不写文件")
    ap.add_argument("--json", action="store_true", help="用 JSON 输出结果（给插件调用）")
    args = ap.parse_args()

    tokens = load_tokens(Path(args.tokens).expanduser())

    if args.words:
        words = [w for w in args.words.replace("，", ",").split(",") if w.strip()]
        meta = {"source": "cli"}
    else:
        words, meta = read_words_from_config(Path(args.config).expanduser())

    lines, errors = build_lines(words, tokens)

    result = {
        "ok": bool(lines) and not errors,
        "words": words,
        "lines": lines,
        "errors": errors,
        "out": None if args.check else str(Path(args.out).expanduser()),
        **meta,
    }

    if not lines:
        result["ok"] = False
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print("[x] 一行都没生成出来", file=sys.stderr)
            for e in errors:
                print("   -", e, file=sys.stderr)
        return 1

    if not args.check:
        out = Path(args.out).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        # UTF-8 无 BOM + CRLF，与出厂 keywords 文件保持一致
        text = "\r\n".join(lines) + "\r\n"
        out.write_bytes(text.encode("utf-8"))  # encode 后写 bytes ⇒ 绝不带 BOM
        result["ok"] = True

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        for line in lines:
            print(line)
        for e in errors:
            print("[!]", e, file=sys.stderr)
        if not args.check:
            print(f"\n已写入 {result['out']}（{len(lines)} 条，来源 {meta.get('source')}）")

    return 0 if (lines and not errors) else 0 if lines else 1


if __name__ == "__main__":
    sys.exit(main())
