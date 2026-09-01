#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_topup.py - 补足国外片到约 60 部(补 欧美 + 其他)，凑 ~100 总新增。
复用 fetch_movies 工具；按 id / (标题,原名) 去重，幂等安全。"""
import sys, json, time, re, urllib.parse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_movies as F

DATA_JS = F.DATA_JS
API = F.API
KEY = F.API_KEY

def norm(s):
    return re.sub(r"[()（）\s\-:.！!?？、,，.'']", "", (s or "").lower()).strip()

txt = DATA_JS.read_text(encoding="utf-8").split("window.MOVIES", 1)[1].strip()
if txt.startswith("="): txt = txt[1:].strip()
if txt.endswith(";"): txt = txt[:-1]
existing = json.loads(txt)
existing_ids = {m["id"] for m in existing}
existing_keys = {(norm(m.get("title")), norm(m.get("original"))) for m in existing}
print(f"当前总计: {len(existing)} 部")

def already(m):
    if m.get("id") in existing_ids: return True
    return (norm(m.get("title")), norm(m.get("original_title"))) in existing_keys

def collect(params, pages, quota, collected):
    for p in range(1, pages + 1):
        if len(collected) >= quota: break
        q = dict(params); q["page"] = p
        url = f"{API}/discover/movie?api_key={KEY}&language=zh-CN&" + urllib.parse.urlencode(q)
        try:
            r = F._session.get(url, timeout=20); r.raise_for_status(); data = r.json()
        except Exception as e:
            print(f"  ! 失败(跳过): {e}"); time.sleep(0.5); continue
        for m in data.get("results", []):
            if len(collected) >= quota: break
            if not m.get("poster_path"): continue
            if already(m): continue
            collected.append(m)
        print(f"  {params.get('region') or params.get('with_original_language') or params.get('sort_by')} p{p}: 新 {len(collected)}/{quota}")
        time.sleep(0.25)

def make_record(m):
    tags = F.tag_from_meta(m); mid = m["id"]
    poster = F.download_poster(m["poster_path"], mid)
    year = int((m.get("release_date") or "0")[:4] or 0)
    tr = round(m.get("vote_average") or 0, 1)
    return {"id": mid, "title": m.get("title") or m.get("original_title"), "original": m.get("original_title"),
            "year": year, "genres": [F.GENRE_MAP.get(g, "") for g in m.get("genre_ids", []) if F.GENRE_MAP.get(g)],
            "rating": tr, "tmdb_rating": tr, "douban_rating": None, "imdb_rating": None,
            "imdb_id": F.get_imdb_id(mid), "overview": (m.get("overview") or "")[:240],
            "poster": poster, "tags": tags, "sources": {"tmdb_topup": m.get("popularity", 0)}}

# 目标: 欧美 ~10 + 其他 ~6 = ~16，封顶 15
collected = []
collect({"region": "US", "sort_by": "popularity.desc"}, 16, 10, collected)      # 欧美(更冷门页)
collect({"sort_by": "popularity.desc"}, 12, 10, collected)                       # 欧美(补充)
for lang in ["fr", "de", "es", "it", "hi"]:
    if len(collected) >= 16: break
    collect({"with_original_language": lang, "sort_by": "popularity.desc"}, 3, 16, collected)

_ids = set(); new = []
for m in collected:
    if m["id"] in _ids or len(new) >= 15: continue
    _ids.add(m["id"]); new.append(m)

records = []
miss = 0
for i, m in enumerate(new, 1):
    rec = make_record(m); 
    if not rec["poster"]: miss += 1
    records.append(rec)
    print(f"  [+{i}] {rec['title']} ({rec['year']}) {[k for k in ['华语','欧美','日韩','其他'] if rec['tags'].get(k)]}")
    time.sleep(0.2)

merged = existing + records
merged.sort(key=lambda x: x["rating"], reverse=True)
DATA_JS.write_text("window.MOVIES = " + json.dumps(merged, ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")

lang_cnt = {}
for m in merged:
    for t in ["华语", "欧美", "日韩", "其他"]:
        if m.get("tags", {}).get(t): lang_cnt[t] = lang_cnt.get(t, 0) + 1
print(f"\n合并后总计: {len(merged)} 部 (本次 +{len(records)}, 缺海报 {miss})")
print(f"语种分布: {lang_cnt}")
