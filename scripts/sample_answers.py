#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sample_answers.py — 从题库随机抽取 N 条答案，导出待审清单

用法:
  python scripts/sample_answers.py                 # 默认抽 20 条，打印到终端
  python scripts/sample_answers.py 30              # 抽 30 条
  python scripts/sample_answers.py 20 --seed 7     # 固定随机种子，结果可复现
  python scripts/sample_answers.py 20 --out review.md   # 导出为 markdown 待审表

输出: 每条含 [题号] 题干 / 选项 / 回复 / 权重，方便逐条核对回复是否贴切、权重是否匹配。
只依赖标准库。
"""
import re
import json
import os
import random
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUESTIONS = os.path.join(ROOT, "data", "questions.js")


def load_questions():
    t = open(QUESTIONS, encoding="utf-8").read()
    m = re.search(r'window\.QUESTIONS\s*=\s*(\[[\s\S]*?\])\s*;', t)
    if not m:
        raise SystemExit("未在 data/questions.js 找到 QUESTIONS 数组")
    return json.loads(m.group(1))


def flatten(Q):
    rows = []
    for q in Q:
        for o in q.get("options", []):
            rows.append({
                "qid": q.get("id"),
                "q": q.get("question", ""),
                "opt": o.get("text", ""),
                "reply": o.get("reply", ""),
                "w": o.get("weights", {}),
            })
    return rows


def render(row, i):
    w = "、".join(f"{k}:{v}" for k, v in row["w"].items()) or "(无)"
    return (f"#{i + 1:02d} [Q{row['qid']}] {row['q']}\n"
            f"    选项: {row['opt']}\n"
            f"    回复: {row['reply']}\n"
            f"    权重: {w}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("n", nargs="?", type=int, default=20, help="抽取条数")
    ap.add_argument("--seed", type=int, default=None, help="随机种子(可复现)")
    ap.add_argument("--out", default=None, help="导出 markdown 文件路径")
    args = ap.parse_args()

    rows = flatten(load_questions())
    if args.seed is not None:
        random.seed(args.seed)
    random.shuffle(rows)
    sel = rows[:args.n]

    lines = [f"题库随机抽检 {len(sel)} 条 / 共 {len(rows)} 条\n"]
    for i, r in enumerate(sel):
        lines.append(render(r, i))
    text = "\n".join(lines)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"已导出 {len(sel)} 条到 {args.out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
