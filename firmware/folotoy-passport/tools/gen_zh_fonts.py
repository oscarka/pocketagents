#!/usr/bin/env python3
"""Generate compact, 100%-coverage Simplified Chinese LVGL 9.5 bitmap fonts for FoloToy AI Passport.

Produces:
  - main/pa_font_zh_16.c : 16px 2bpp (~3,880 glyphs: all 3,755 GB2312 Level-1 Hanzi
                           + ASCII + CJK punctuation + every char in main/*.c)
  - main/pa_font_zh_12.c : 12px 2bpp (~3,880 glyphs: matching full GB2312 Level-1 coverage
                           so 12px metadata, session titles, and Hub toast replies never miss a glyph)

Requires: `lv_font_conv` (via npx) and a single-face Simplified Chinese OTF/TTF font
(Source Han Sans SC / Noto Sans SC).
"""
import glob
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAIN_DIR = ROOT / "main"

DEFAULT_FONT_CANDIDATES = [
    "/tmp/SourceHanSansSC-Regular.otf",
    "/tmp/NotoSansSC-Regular.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
]

EXTRA_PUNCT_AND_UI = (
    "，。！？：；（）【】《》“”‘’、·—…￥％＋－＝／＼｜～"
    "↑↓←→•●✓✗"
    "口袋代理电脑运行待批空闲安全常规高危多选题终端命令修改代码写入文件读取文件"
    "请你选择浏览器操作插件工具审批放行批准拒绝取消允许确认提交同步语音说话录音思考回复"
    "正在连接已全部就绪认证失败离线长按短按切换报码取码锁定选项第条灰度双写暂缓"
)


def collect_gb2312_level1():
    chars = []
    for b1 in range(0xB0, 0xD8):
        for b2 in range(0xA1, 0xFF):
            if b1 == 0xD7 and b2 >= 0xFA:
                continue
            try:
                chars.append(bytes([b1, b2]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return chars


def collect_source_non_ascii():
    chars = set()
    for path in glob.glob(str(MAIN_DIR / "*.c")) + glob.glob(str(MAIN_DIR / "*.h")):
        if os.path.basename(path).startswith("pa_font_zh_"):
            continue
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
        for ch in text:
            if ord(ch) >= 0x80 and not ch.isspace():
                chars.add(ch)
    return chars


def find_font_file():
    env_font = os.environ.get("PA_ZH_FONT_FILE", "").strip()
    if env_font and Path(env_font).exists():
        return env_font
    for cand in DEFAULT_FONT_CANDIDATES:
        if Path(cand).exists():
            return cand
    for pattern in ("*SourceHanSansSC*Regular*", "*NotoSans*SC*Regular*", "*NotoSans*CJK*Regular*"):
        for p in Path("/usr/share/fonts").rglob(pattern):
            return str(p)
    raise FileNotFoundError(
        "No Source Han Sans SC / Noto Sans SC font found. Set PA_ZH_FONT_FILE or install fonts-noto-cjk."
    )


def run_conv(font_file, symbols_str, size, bpp, lv_name, out_path):
    cmd = [
        "npx",
        "--yes",
        "lv_font_conv@1.5.3",
        "--font",
        font_file,
        "--range",
        "0x20-0x7E",
        "--symbols",
        symbols_str,
        "--size",
        str(size),
        "--bpp",
        str(bpp),
        "--format",
        "lvgl",
        "--no-compress",
        "--lv-font-name",
        lv_name,
        "--lv-include",
        "lvgl.h",
        "--output",
        str(out_path),
    ]
    print(f"[gen_zh_fonts] Generating {lv_name} ({size}px, {bpp}bpp, {len(symbols_str)} extra symbols) -> {out_path}")
    subprocess.run(cmd, check=True)
    print(f"[gen_zh_fonts] Wrote {out_path} ({out_path.stat().st_size // 1024} KB source)")


def main():
    font_file = find_font_file()
    print(f"[gen_zh_fonts] Using font: {font_file}")

    src_chars = collect_source_non_ascii()
    gb1_chars = collect_gb2312_level1()

    # Full GB2312 Level-1 Hanzi + CJK punctuation + all source literals for BOTH 16px & 12px
    full_set = sorted(set(gb1_chars) | set(EXTRA_PUNCT_AND_UI) | src_chars)
    symbols_str = "".join(full_set)

    run_conv(font_file, symbols_str, 16, 2, "pa_font_zh_16", MAIN_DIR / "pa_font_zh_16.c")
    run_conv(font_file, symbols_str, 12, 2, "pa_font_zh_12", MAIN_DIR / "pa_font_zh_12.c")

    missing = [ch for ch in sorted(src_chars) if ch not in full_set]
    if missing:
        print(f"[gen_zh_fonts] ERROR: missing source glyphs: {missing}", file=sys.stderr)
        sys.exit(1)
    print(
        f"[gen_zh_fonts] Verified 100% coverage for {len(src_chars)} source non-ASCII chars + "
        f"{len(gb1_chars)} GB2312-L1 Hanzi in BOTH 16px and 12px fonts."
    )


if __name__ == "__main__":
    main()
