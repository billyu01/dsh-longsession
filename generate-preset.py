#!/usr/bin/env python3
"""从随包发布的 standard 预设生成「长会话增强」预设覆盖补丁。

用法:
    python3 generate-preset.py [--asar <app.asar 路径>] [--out cordis.patch.yml]

DSH 升级后重新运行一次即可把官方预设的最新内容同步进来。

只做三处改动:
1. 在 compaction 隔离组里插入 longsession-governor（自适应增量压缩治理）。
2. 把工具结果修剪预算从 8192/4096/1024 收紧到 4000/2000/800 字符。
3. 生成覆盖 preset-standard 的完整声明（因为预设 config 是整体替换，不能局部合并）。
"""
import argparse
import json
import sys
from pathlib import Path

DEFAULT_ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
SHIPPED = "/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml"
DEFAULT_OUT = Path(__file__).resolve().parent / "cordis.patch.yml"

GOVERNOR_ROW = """{indent}- id: longsession-governor
{indent}  name: 'dsh-longsession/governor'
{indent}  config:
{indent}    slack: 3
{indent}    keepFactor: 1.5
{indent}    minStepsBetween: 25
{indent}    minGrowthRatio: 1
"""

HEADER = """# 本文件由 generate-preset.py 生成，不要手改。
# 覆盖官方 standard 预设：压缩组内插入自适应增量压缩治理，并收紧工具结果修剪预算。
# DSH 升级后请重新运行：python3 generate-preset.py
"""


def load_asar_header(asar_path: str):
    raw = Path(asar_path).read_bytes()
    start = raw.find(b'{"files":')
    if start < 0:
        raise SystemExit("找不到 asar 的 JSON 头")
    header, end = json.JSONDecoder().raw_decode(raw[start:].decode("utf-8", "replace"))
    data_start = (start + end + 3) // 4 * 4
    return header, data_start, raw


def find_entry(header, target: str):
    node = header
    for part in target.strip("/").split("/"):
        node = node["files"][part]
    return node


def extract_file(asar_path: str, inner: str) -> str:
    header, data_start, raw = load_asar_header(asar_path)
    entry = find_entry(header, inner)
    offset = data_start + int(entry["offset"])
    return raw[offset:offset + entry["size"]].decode("utf-8")


def build(shipped_text: str) -> str:
    lines = shipped_text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("    - id: preset-standard"))
    row = lines[start:]
    dedented = []
    for line in row:
        if line.startswith("    "):
            dedented.append(line[4:])
        else:
            dedented.append(line)
    out = list(dedented)
    # 收紧修剪预算
    replacements = {
        "thresholdChars: 8192": "thresholdChars: 4000",
        "headChars: 4096": "headChars: 2000",
        "tailChars: 1024": "tailChars: 800",
    }
    fixed = []
    for line in out:
        key = line.strip()
        if key in replacements:
            indent = line[: len(line) - len(line.lstrip())]
            fixed.append(indent + replacements[key])
        else:
            fixed.append(line)
    out = fixed
    # 在修剪器前插入治理插件
    target = next(i for i, line in enumerate(out) if line.strip() == "- id: tool-result-pruner")
    indent = out[target][: len(out[target]) - len(out[target].lstrip())]
    out[target:target] = GOVERNOR_ROW.format(indent=indent).rstrip("\n").splitlines()
    return HEADER + "\n".join(out).rstrip("\n") + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asar", default=DEFAULT_ASAR)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()
    shipped = extract_file(args.asar, SHIPPED)
    text = HEADER + build(shipped).replace(HEADER, "")
    Path(args.out).write_text(text, encoding="utf-8")
    print(f"已写入 {args.out}（{len(text.splitlines())} 行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
