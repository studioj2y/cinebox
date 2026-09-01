#!/usr/bin/env python3
"""把 images/posters/*.jpg 转成 WebP（更小的体积，降低带宽）。
可重复运行：已存在同名 .webp 则跳过；转换成功后删除原 jpg。
movie-mood 站点现在统一引用 .webp。
"""
import os
from PIL import Image

SRC = os.path.join(os.path.dirname(__file__), "..", "images", "posters")


def main():
    if not os.path.isdir(SRC):
        print("posters 目录不存在:", SRC)
        return
    n_done = 0
    n_skip = 0
    for f in os.listdir(SRC):
        if not f.lower().endswith(".jpg"):
            continue
        p = os.path.join(SRC, f)
        out = os.path.splitext(p)[0] + ".webp"
        if os.path.exists(out):
            n_skip += 1
            os.remove(p)  # 已是 webp，清掉旧 jpg
            continue
        with Image.open(p) as im:
            im.convert("RGB").save(out, "WEBP", quality=82, method=4)
        os.remove(p)
        n_done += 1
    print(f"转换完成：新转 {n_done} 张，已存在跳过 {n_skip} 张。目录：{os.path.abspath(SRC)}")


if __name__ == "__main__":
    main()
