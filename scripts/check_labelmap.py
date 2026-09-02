#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_labelmap.py — 一键检查 labelMap 覆盖缺口

用法 (在 movie-mood/ 目录下):
  python scripts/check_labelmap.py

做什么:
  1. 从 data/questions.js 的 weights 提取「问卷会触发」的标签
  2. 从 data/movies.js 的 tags 提取「电影库存在」的标签
  3. 从 js/match.js 的 labelMap 提取已有文案的标签
  4. 对比输出:
     - [优先级高] 会触发但 labelMap 缺文案的标签 (这些会走兜底模板)
     - [参考]    电影有但从不触发的标签 (一般无需补)
     - 可直接粘贴进 labelMap 的待填片段(空文案占位)

只依赖标准库。
"""
import re
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUESTIONS = os.path.join(ROOT, "data", "questions.js")
MOVIES = os.path.join(ROOT, "data", "movies.js")
MATCH = os.path.join(ROOT, "js", "match.js")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def extract_weights_tags(text):
    out = set()
    for block in re.findall(r'"weights"\s*:\s*\{(.*?)\}', text, re.S):
        out.update(re.findall(r'"([^"]+)"\s*:', block))
    return out


def extract_movie_tags(text):
    out = set()
    for block in re.findall(r'"tags"\s*:\s*\{(.*?)\}', text, re.S):
        out.update(re.findall(r'"([^"]+)"\s*:', block))
    return out


def extract_labelmap(text):
    m = re.search(r'const labelMap = \{(.*?)\n    \};', text, re.S)
    if not m:
        raise SystemExit("未在 js/match.js 找到 labelMap 定义")
    return set(re.findall(r'(\S+?):\s*"', m.group(1)))


def main():
    q = read(QUESTIONS)
    mv = read(MOVIES)
    mt = read(MATCH)

    triggered = extract_weights_tags(q)
    movie_tags = extract_movie_tags(mv)
    label = extract_labelmap(mt)

    trig_missing = sorted(triggered - label)
    movie_missing = sorted(movie_tags - label)
    movie_only_missing = [t for t in movie_missing if t not in triggered]

    bar = "=" * 52
    print(bar)
    print("labelMap 覆盖检查")
    print(bar)
    print(f"labelMap 条目数 : {len(label)}")
    print(f"问卷触发标签数 : {len(triggered)}")
    print(f"电影标签总数   : {len(movie_tags)}")
    print()
    print(f"[优先级高] 会触发但缺文案: {len(trig_missing)} 个")
    if trig_missing:
        for t in trig_missing:
            print(f"  - {t}")
        print("\n可粘贴片段 (填好文案后放进 labelMap):")
        print("  " + ", ".join(f'{t}: ""' for t in trig_missing))
    else:
        print("  ✅ 已全部覆盖，无兜底")
    print()
    print(f"[参考] 电影有但从不触发: {len(movie_only_missing)} 个")
    if movie_only_missing:
        print("  " + "、".join(movie_only_missing))
    print(bar)


if __name__ == "__main__":
    main()
