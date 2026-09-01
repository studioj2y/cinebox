#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_more.py - 增量补充电影到 data/movies.js (不重抓已有)

目标:
  - 华语(国内) 约 40 部: discover with_original_language=zh (兼顾人气与经典)
  - 国外 约 60 部: 日韩(ja/ko) ~25 + 其他(fr/de/es/it/hi/pt/ru) ~20 + 欧美(en) 补充 ~15

去重: 已有 id 或 (规范化标题, 规范化原名) 命中则跳过 -> 自然消解"奥德赛"同名重复
标签/海报/imdb_id: 复用 fetch_movies 的工具函数
输出: 重新写回 data/movies.js (已有片 + 新片, 按评分降序), 打印前后统计
"""
import sys, json, time, re, urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_movies as F

ROOT = F.ROOT
DATA_JS = F.DATA_JS
IMG_DIR = F.IMG_DIR
API = F.API
KEY = F.API_KEY

def norm(s):
    return re.sub(r"[()（）\s\-:.！!?？、,，.'']", "", (s or "").lower()).strip()

def load_existing():
    txt = DATA_JS.read_text(encoding="utf-8")
    txt = txt.split("window.MOVIES", 1)[1]
    txt = txt.strip()
    if txt.startswith("="):
        txt = txt[1:].strip()
    if txt.endswith(";"):
        txt = txt[:-1]
    return json.loads(txt)

def dedup_existing(movies):
    seen = {}
    out = []
    for m in movies:
        k = (norm(m.get("title")), norm(m.get("original")))
        if k in seen:
            # 同名同原名: 保留评分更高者
            prev = seen[k]
            if (m.get("rating") or 0) > (prev.get("rating") or 0):
                out[out.index(prev)] = m
                seen[k] = m
            continue
        seen[k] = m
        out.append(m)
    return out

existing = dedup_existing(load_existing())
existing_ids = {m["id"] for m in existing}
existing_keys = {(norm(m.get("title")), norm(m.get("original"))) for m in existing}
print(f"已有(去重后): {len(existing)} 部")

def already(m):
    if m.get("id") in existing_ids:
        return True
    return (norm(m.get("title")), norm(m.get("original_title"))) in existing_keys

def discover_collect(params, pages, quota, collected):
    """从 discover 拉片，直到 collected 凑满 quota 部新片"""
    for p in range(1, pages + 1):
        if len(collected) >= quota:
            break
        q = dict(params)
        q["page"] = p
        url = f"{API}/discover/movie?api_key={KEY}&language=zh-CN&" + urllib.parse.urlencode(q)
        try:
            r = F._session.get(url, timeout=20)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f"  ! discover 失败(跳过): {e}")
            time.sleep(0.5)
            continue
        for m in data.get("results", []):
            if len(collected) >= quota:
                break
            if not m.get("poster_path"):
                continue
            if already(m):
                continue
            collected.append(m)
        print(f"  discover {params.get('with_original_language') or params.get('sort_by')} p{p}: 累计新片 {len(collected)}/{quota}")
        time.sleep(0.25)

def make_record(m):
    tags = F.tag_from_meta(m)
    mid = m["id"]
    poster = F.download_poster(m["poster_path"], mid)
    year = int((m.get("release_date") or "0")[:4] or 0)
    tmdb_rating = round(m.get("vote_average") or 0, 1)
    imdb_id = F.get_imdb_id(mid)
    return {
        "id": mid,
        "title": m.get("title") or m.get("original_title"),
        "original": m.get("original_title"),
        "year": year,
        "genres": [F.GENRE_MAP.get(g, "") for g in m.get("genre_ids", []) if F.GENRE_MAP.get(g)],
        "rating": tmdb_rating,
        "tmdb_rating": tmdb_rating,
        "douban_rating": None,
        "imdb_rating": None,
        "imdb_id": imdb_id,
        "overview": (m.get("overview") or "")[:240],
        "poster": poster,
        "tags": tags,
        "sources": {"tmdb_more": m.get("popularity", 0)},
    }

# ---------- 1) 华语 40 ----------
print("\n=== 抓取 华语(国内) ===")
hua = []
discover_collect({"with_original_language": "zh", "sort_by": "popularity.desc"}, 6, 45, hua)
discover_collect({"with_original_language": "zh", "sort_by": "vote_count.desc"}, 6, 45, hua)
# 去重 hua 内部
_hua_ids = set()
hua_new = []
for m in hua:
    if m["id"] in _hua_ids:
        continue
    _hua_ids.add(m["id"])
    hua_new.append(m)
hua_new = hua_new[:40]

# ---------- 2) 国外 60 ----------
print("\n=== 抓取 国外(日韩/其他/欧美) ===")
foreign = []
# 日韩
discover_collect({"with_original_language": "ja", "sort_by": "popularity.desc"}, 5, 14, foreign)
discover_collect({"with_original_language": "ko", "sort_by": "popularity.desc"}, 5, 25, foreign)
# 其他(欧洲/印度等)
for lang in ["fr", "de", "es", "it", "hi", "pt", "ru"]:
    if len(foreign) >= 45:
        break
    discover_collect({"with_original_language": lang, "sort_by": "popularity.desc"}, 2, 45, foreign)
# 欧美补充(popular 更靠后的页)
discover_collect({"sort_by": "popularity.desc"}, 10, 60, foreign)
foreign_new = []
_fids = set()
for m in foreign:
    if m["id"] in _fids or len(foreign_new) >= 60:
        continue
    _fids.add(m["id"])
    foreign_new.append(m)
foreign_new = foreign_new[:60]

all_new = hua_new + foreign_new
print(f"\n新片合计: 华语 {len(hua_new)} + 国外 {len(foreign_new)} = {len(all_new)}")

# ---------- 下载 + 写记录 ----------
records = []
missing_poster = 0
for i, m in enumerate(all_new, 1):
    rec = make_record(m)
    if not rec["poster"]:
        missing_poster += 1
    records.append(rec)
    print(f"  [{i}/{len(all_new)}] {rec['title']} ({rec['year']}) lang={[k for k in ['华语','欧美','日韩','其他'] if rec['tags'].get(k)]}")
    time.sleep(0.2)

merged = existing + records
merged.sort(key=lambda x: x["rating"], reverse=True)

DATA_JS.write_text(
    "window.MOVIES = " + json.dumps(merged, ensure_ascii=False, indent=1) + ";\n",
    encoding="utf-8",
)

# 统计
lang_cnt = {}
for m in merged:
    for t in ["华语", "欧美", "日韩", "其他"]:
        if m.get("tags", {}).get(t):
            lang_cnt[t] = lang_cnt.get(t, 0) + 1
print(f"\n=== 完成 ===")
print(f"合并后总计: {len(merged)} 部 (原有 {len(existing)} + 新 {len(records)})")
print(f"新片缺海报: {missing_poster}")
print(f"语种分布: {lang_cnt}")
