#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_movies.py - 拉取 TMDB 电影数据并本地化 (带重试)

功能:
  1. 从 TMDB 拉取 popular + top_rated 片单，去重合并 (~400 部)
  2. 下载 w342 海报到 images/posters/ 并用 Pillow 压缩 (quality~70)
  3. 自动打标签 (类型/关键词 -> 情绪/主题/基调/节奏/年代/语种)
  4. 输出 data/movies.js (window.MOVIES = [...])

健壮性:
  - 网络(SSL 抖动)重试: 页面与图片均最多重试 3 次，页面彻底失败则跳过该页继续，不中断整体
  - 已存在的海报跳过不重下；重跑只会补缺失图与新片

后续扩展: 多平台排名合并见底部 merge_sources() 预留接口。

设置 key: 环境变量 TMDB_API_KEY 或 scripts/.env 写 TMDB_API_KEY=xxxx
用法: python scripts/fetch_movies.py
"""
import os
import re
import sys
import json
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMG_DIR = ROOT / "images" / "posters"
DATA_JS = ROOT / "data" / "movies.js"
ENV_FILE = Path(__file__).resolve().parent / ".env"

def load_key():
    key = os.environ.get("TMDB_API_KEY")
    if key:
        return key
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("TMDB_API_KEY") and "=" in line:
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None

API_KEY = load_key()
if not API_KEY:
    sys.exit("未找到 TMDB_API_KEY。请在环境变量设置，或在 scripts/.env 写 TMDB_API_KEY=xxxx")

IMG_DIR.mkdir(parents=True, exist_ok=True)

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

_session = requests.Session()
_retry = Retry(total=3, backoff_factor=0.6, status_forcelist=[429, 500, 502, 503, 504],
               allowed_methods=["GET"])
_session.mount("https://", HTTPAdapter(max_retries=_retry))
_session.mount("http://", HTTPAdapter(max_retries=_retry))
_session.headers.update({"User-Agent": "movie-mood/1.0"})

API = "https://api.themoviedb.org/3"
IMG_BASE = "https://image.tmdb.org/t/p/w342"

GENRE_MAP = {
    28: "动作", 12: "冒险", 16: "动画", 35: "喜剧", 80: "犯罪",
    99: "纪录片", 18: "剧情", 10751: "家庭", 14: "奇幻", 36: "历史",
    27: "恐怖", 10402: "音乐", 9648: "悬疑", 10749: "爱情",
    878: "科幻", 10770: "电视电影", 53: "惊悚", 10752: "战争", 37: "西部",
}
GENRE_TAGS = {
    "动作": ["热血", "爽", "冒险"], "冒险": ["冒险", "热血"], "动画": ["动画", "童话"],
    "喜剧": ["喜剧", "轻松"], "犯罪": ["犯罪", "悬疑"], "剧情": ["温情"],
    "家庭": ["家庭", "温情"], "奇幻": ["童话", "冒险"], "历史": ["历史"],
    "恐怖": ["恐怖", "暗黑"], "音乐": ["音乐"], "悬疑": ["悬疑", "烧脑"],
    "爱情": ["爱情", "浪漫"], "科幻": ["科幻", "烧脑"], "惊悚": ["悬疑", "烧脑"],
    "战争": ["战争"], "西部": ["冒险"], "纪录片": ["写实"],
}
KW_TAGS = [
    (r"治愈|温柔|温暖|family|warm|heal|heart", ["治愈", "温情"]),
    (r"孤独|lonely|isolat|alone", ["孤独", "致郁"]),
    (r"青春|youth|teen|school|校园", ["青春", "成长"]),
    (r"成长|grow up|coming of age", ["成长"]),
    (r"友情|friendship|friend", ["友情"]),
    (r"爱情|romance|love", ["爱情", "浪漫"]),
    (r"催泪|感人|tear|emotion|moving|sad", ["致郁", "温情"]),
    (r"搞笑|hilarious|funny|laugh|幽默", ["喜剧", "轻松"]),
    (r"燃|热血|inspir|motivat|heroic", ["热血", "爽"]),
    (r"烧脑|twist|mind|puzzle|mystery|谜", ["烧脑", "悬疑"]),
    (r"黑暗|dark|grim|暴力|violen", ["暗黑"]),
    (r"震撼|epic|grand|史诗", ["震撼"]),
    (r"轻松|light|chill|relax", ["轻松"]),
    (r"社会|society|politic|阶级|poverty", ["社会", "写实"]),
    (r"美食|food|cuisine|料理", ["美食"]),
    (r"旅行|travel|journey|road", ["旅行", "冒险"]),
    (r"职场|work|office|career|公司", ["职场"]),
    (r"科幻|sci-fi|future|space|外星|机器人", ["科幻"]),
    (r"末日|apocalyps|zombie|丧尸|disaster", ["科幻", "暗黑"]),
    (r"童话|fairy|fantasy|magic|魔法", ["童话"]),
    (r"黑帮|mafia|gangster|毒枭", ["犯罪"]),
    (r"监狱|prison", ["犯罪", "写实"]),
]
LANG_MAP = {"zh": "华语", "en": "欧美", "ja": "日韩", "ko": "日韩",
            "fr": "其他", "de": "其他", "es": "其他", "it": "其他",
            "hi": "其他", "th": "其他", "pt": "其他", "ru": "其他"}

def tag_from_meta(movie):
    tags = {}
    def add(t, w=1):
        tags[t] = tags.get(t, 0) + w
    genres = [GENRE_MAP.get(g, "") for g in movie.get("genre_ids", [])]
    for g in genres:
        if g and g in GENRE_TAGS:
            for t in GENRE_TAGS[g]:
                add(t)
    text = (movie.get("title", "") + " " + movie.get("overview", "")).lower()
    for pat, tlist in KW_TAGS:
        if re.search(pat, text, re.I):
            for t in tlist:
                add(t)
    year = int((movie.get("release_date") or "0")[:4] or 0)
    if year and year < 1990:
        add("经典老片")
    elif year and year <= 2010:
        add("近代")
    elif year:
        add("新片")
    lang = LANG_MAP.get(movie.get("original_language", ""), "其他")
    add(lang)
    if "动作" in genres or "冒险" in genres:
        add("快节奏")
    if "剧情" in genres or "历史" in genres or "战争" in genres:
        add("慢节奏")
    if "喜剧" in genres:
        add("明亮")
    if "恐怖" in genres or "惊悚" in genres:
        add("冷峻")
    if "家庭" in genres or "动画" in genres:
        add("温暖")
    return tags

def fetch_pages(endpoint, pages=10):
    out = {}
    for p in range(1, pages + 1):
        url = f"{API}/{endpoint}?api_key={API_KEY}&language=zh-CN&page={p}"
        try:
            r = _session.get(url, timeout=20)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f"  ! {endpoint} page {p} 失败(跳过): {e}")
            time.sleep(0.5)
            continue
        for m in data.get("results", []):
            if m.get("poster_path"):
                out[m["id"]] = m
        print(f"  {endpoint} page {p}: +{len(data.get('results', []))} (累计 {len(out)})")
        time.sleep(0.2)
    return out

def download_poster(poster_path, mid):
    dest = IMG_DIR / f"{mid}.webp"
    if dest.exists():
        return str(dest.relative_to(ROOT)).replace("\\", "/")
    url = f"{IMG_BASE}{poster_path}"
    try:
        r = _session.get(url, timeout=30)
        r.raise_for_status()
        raw = r.content
        try:
            from io import BytesIO
            from PIL import Image
            img = Image.open(BytesIO(raw)).convert("RGB")
            if img.width > 500:
                h = int(img.height * 500 / img.width)
                img = img.resize((500, h))
            buf = BytesIO()
            img.save(buf, "WEBP", quality=82, method=4)
            dest.write_bytes(buf.getvalue())
        except Exception:
            dest.write_bytes(raw)
        return str(dest.relative_to(ROOT)).replace("\\", "/")
    except Exception as e:
        print(f"  ! 海报下载失败 {mid}: {e}")
        return ""

def get_imdb_id(mid):
    """TMDB external_ids 拿 imdb_id（免费、可靠）。"""
    try:
        r = _session.get(f"{API}/movie/{mid}/external_ids?api_key={API_KEY}", timeout=20)
        r.raise_for_status()
        return r.json().get("imdb_id") or ""
    except Exception as e:
        print(f"  ! imdb_id 失败 {mid}: {e}")
        return ""

def get_douban_rating(title):
    """豆瓣移动端 rexxar 搜索接口，取第一个结果的评分（容错）。"""
    if not title:
        return None
    try:
        r = _session.get(
            "https://m.douban.com/rexxar/api/v2/search?type=movie&q=" + requests.utils.quote(title),
            headers={"Referer": "https://m.douban.com/movie/", "User-Agent": "Mozilla/5.0"},
            timeout=20,
        )
        r.raise_for_status()
        items = r.json().get("subjects", {}).get("items", [])
        if items:
            rt = items[0].get("target", {}).get("rating") or {}
            v = rt.get("value")
            if v:
                return round(float(v), 1)
    except Exception as e:
        print(f"  ! 豆瓣评分失败 [{title}]: {e}")
    return None

OMDB_KEY = os.environ.get("OMDB_API_KEY", "")
def get_omdb_rating(imdb_id):
    """OMDB 拿 IMDB 评分数字（需免费 key；未配置则跳过）。"""
    if not (imdb_id and OMDB_KEY):
        return None
    try:
        r = _session.get(f"http://www.omdbapi.com/?i={imdb_id}&apikey={OMDB_KEY}", timeout=20)
        r.raise_for_status()
        d = r.json()
        ir = d.get("imdbRating")
        if ir and ir != "N/A":
            return float(ir)
    except Exception as e:
        print(f"  ! OMDB 失败 {imdb_id}: {e}")
    return None

def main():
    print("拉取 TMDB 片单 ...")
    pop = fetch_pages("movie/popular", pages=15)
    top = fetch_pages("movie/top_rated", pages=10)
    merged = {**top, **pop}
    print(f"合并后共 {len(merged)} 部(有海报)")
    movies = []
    for mid, m in merged.items():
        tags = tag_from_meta(m)
        if not tags:
            continue
        poster = download_poster(m["poster_path"], mid)
        year = int((m.get("release_date") or "0")[:4] or 0)
        tmdb_rating = round(m.get("vote_average") or 0, 1)
        imdb_id = get_imdb_id(mid)
        douban_rating = get_douban_rating(m.get("title") or m.get("original_title"))
        imdb_rating = get_omdb_rating(imdb_id)
        movies.append({
            "id": mid,
            "title": m.get("title") or m.get("original_title"),
            "original": m.get("original_title"),
            "year": year,
            "genres": [GENRE_MAP.get(g, "") for g in m.get("genre_ids", []) if GENRE_MAP.get(g)],
            "rating": tmdb_rating,
            "tmdb_rating": tmdb_rating,
            "douban_rating": douban_rating,
            "imdb_rating": imdb_rating,
            "imdb_id": imdb_id,
            "overview": (m.get("overview") or "")[:240],
            "poster": poster,
            "tags": tags,
            "sources": {"tmdb_pop": m.get("popularity", 0)},
        })
        time.sleep(0.25)
    movies.sort(key=lambda x: x["rating"], reverse=True)
    DATA_JS.parent.mkdir(parents=True, exist_ok=True)
    with open(DATA_JS, "w", encoding="utf-8") as f:
        f.write("// 自动生成，请勿手改。运行 scripts/fetch_movies.py 重新生成。\n")
        f.write("window.MOVIES = ")
        json.dump(movies, f, ensure_ascii=False, indent=1)
        f.write(";\n")
    missing = sum(1 for x in movies if not x["poster"])
    print(f"已写出 {len(movies)} 部 (其中 {missing} 部缺本地海报) -> {DATA_JS}")

if __name__ == "__main__":
    main()
