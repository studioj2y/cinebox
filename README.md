# 今晚看什么电影 · CINEBOX

一个"今晚看什么电影"式的问答互动小网页：滚动海报墙首屏 → 回答 5 个关于心情/性格/状态的模糊问题 → 用模糊逻辑推荐一部电影，并由「不良少女放映组」的观影向导给出一段带点不羁劲儿的 AI 解读。纯静态（HTML/CSS/JS），可直接双击打开，也能一键部署到 Vercel。

## 目录结构
```
movie-mood/
├─ index.html          三屏页面（海报墙 / 答题 / 结果）
├─ css/style.css       暗色影院风样式 + 海报墙滚动动画
├─ js/
│  ├─ match.js         模糊匹配 + 推荐理由 + AI 解读提示词
│  └─ app.js           海报墙渲染 / 答题流程 / 结果交互 / agnes 调用
├─ data/
│  ├─ movies.js        window.MOVIES（439 部电影元数据 + 标签 + 本地海报路径）
│  └─ questions.js     window.QUESTIONS（99 道性格/心情/状态题）
├─ images/
│  ├─ logo-silhouette.png   白色剪影 LOGO
│  └─ posters/         439 张本地压缩海报（随仓库提交）
└─ scripts/            数据拉取 / 题库生成 / LOGO 处理脚本（开发用）
```

## 本地运行（无需任何后端）
直接用浏览器打开 `index.html` 即可。数据以 `window.*` 全局变量形式加载，因此 `file://` 双击打开也不会遇到 CORS 问题。
需要本地服务器时：`python -m http.server` 后访问 `http://127.0.0.1:8000`。

## 重新拉取电影数据（需你的 TMDB key）
`data/movies.js` 已含 439 部真实片单与本地海报，通常无需重跑。
如需刷新：
1. 准备 key：https://www.themoviedb.org/settings/api （免费）。
2. 设置 key（二选一，均不会被提交）：
   - 环境变量：`export TMDB_API_KEY=你的key`
   - 或新建 `scripts/.env` 写入：`TMDB_API_KEY=你的key`
3. 安装依赖：`.venv\Scripts\pip install Pillow requests`（仓库已自带 `.venv` 则跳过）。
4. 运行：`.venv\Scripts\python scripts/fetch_movies.py`
   会从 TMDB 拉取 popular + top_rated 去重约 439 部，下载 `w342` 海报到 `images/posters/` 并压缩（quality 70），生成 `data/movies.js`。

## AI 解读（已接入 agnes-ai）
结果页「✦ 不良解读」按钮会直接调用 agnes-ai 的 `/v1/chat/completions` 端点（模型 `agnes-2.5-flash`），把 5 个回答 + 影片信息串成一段 200~350 字、以「今晚就它了。」收尾的叙事解读。配置写在 `js/app.js` 顶部的 `AGNES` 常量里。
- ⚠️ **当前 key 硬编码在前端**（小范围测试可接受）。正式发布前建议改为走一个 Vercel Serverless Function 代理：前端 `fetch('/api/interpret')`，函数里带 key 转发给 agnes，key 放进 Vercel 环境变量，不进仓库、不暴露给用户。
- 前端已做兜底：即便接口异常，也会回退展示已构造好的提示词，不会白屏。

## 部署到 Vercel（纯静态 · 零配置）
整个项目是纯静态文件，不需要构建步骤。

### 明天部署清单（按顺序执行）
```bash
# ① 在 GitHub 网页端新建一个空仓库，例如 movie-mood
#    （不要勾选 Initialize with README / .gitignore / License，保持空仓库）
#    记下仓库 URL，例如 https://github.com/<你的用户名>/movie-mood.git

# ② 本地关联并推送（在 Git Bash 里执行，注意换成你的用户名和路径）
cd /d/DHZQ/workbuddy/Ideas/movie-mood
git remote add origin https://github.com/<你的用户名>/movie-mood.git
git branch -M main
git push -u origin main

# ③ 打开 https://vercel.com/new → Import 刚才的 GitHub 仓库
#    - Framework Preset：选 Other（纯静态，无构建）
#    - Build Command：留空
#    - Output Directory：留空（或填 "."）
#    - 不需要设置任何环境变量（除非你改走了 /api 代理方案）
#    点 Deploy，约几十秒后拿到 *.vercel.app 公网地址。
```

> 注意：`images/posters/` 已随仓库提交（439 张压缩 jpg，约 16MB，Vercel 完全可承载）。若以后想减负，可在 `scripts/fetch_movies.py` 把分辨率降到 `w185` 或提高压缩比后重跑。

## 后续可选项
- 多平台排名合并：`fetch_movies.py` 已为每个电影预留 `sources` 字段，融合豆瓣/IMDb 等排名时往里追加打分函数即可。
- key 代理：如上所述，把 agnes 调用挪到 `/api/interpret` 函数，key 入 Vercel 环境变量。
