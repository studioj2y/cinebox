# 今天看什么电影 · MoodFlix

一个"今天看什么电影"式的问答互动小网页：滚动海报墙首屏 → 回答 5 个关于心情/性格/状态的模糊问题 → 用模糊逻辑推荐一部电影。纯静态（HTML/CSS/JS），可直接双击打开，也能一键部署到 Vercel。

## 目录结构
```
movie-mood/
├─ index.html          三屏页面（海报墙 / 答题 / 结果）
├─ css/style.css       暗色影院风样式 + 海报墙滚动动画
├─ js/
│  ├─ match.js         模糊匹配 + 推荐理由 + AI 提示词 stub
│  └─ app.js           海报墙渲染 / 答题流程 / 结果交互
├─ data/
│  ├─ movies.js        window.MOVIES（电影元数据 + 标签 + 本地海报路径）
│  └─ questions.js     window.QUESTIONS（~100 道性格/心情/状态题）
├─ images/posters/     本地压缩海报（运行 fetch 后生成）
└─ scripts/
   ├─ fetch_movies.py  拉 TMDB 真实片单 + 压缩海报 + 自动打标签
   └─ gen_questions.py 重新生成题库
```

## 本地运行（无需任何后端）
直接用浏览器打开 `index.html` 即可。数据以 `window.*` 全局变量形式加载，因此 `file://` 双击打开也不会遇到 CORS 问题。
需要本地服务器时：`python -m http.server` 后访问 `http://127.0.0.1:8000`。

> 当前 `data/movies.js` 是 14 部示例片（海报走渐变标题卡兜底）。拉完真实数据会被覆盖。

## 拉取真实电影数据（需你的 TMDB key）
1. 准备 key：在 https://www.themoviedb.org/settings/api 申请（免费）。
2. 设置 key（二选一，均不会被提交）：
   - 环境变量：`set TMDB_API_KEY=你的key`（PowerShell）或 `export TMDB_API_KEY=你的key`
   - 或新建 `scripts/.env` 写入：`TMDB_API_KEY=你的key`
3. 安装依赖（已自带 `.venv` 则跳过创建）：
   ```
   python -m venv .venv
   .venv\Scripts\pip install Pillow requests
   ```
4. 运行：
   ```
   .venv\Scripts\python scripts/fetch_movies.py
   ```
   会从 TMDB 拉取 popular + top_rated 去重约 400 部，下载 `w342` 海报到 `images/posters/` 并压缩（quality 70），生成 `data/movies.js`（含自动标签）。

### 多平台排名合并（后续）
`fetch_movies.py` 已为每个电影预留 `sources` 字段。后续要融合豆瓣/IMDb 等排名时，在脚本里新增对应平台的抓取/打分函数，合并进 `sources` 并按综合分排序即可（不影响前端逻辑）。

## 题库
`scripts/gen_questions.py` 生成 `data/questions.js`，共 99 道题，覆盖：心情、精力、陪伴、情绪体验、内容偏好、时间、人生阶段、性格、观影目的、题材、情绪粒度、隐喻 12 个维度。每题选项映射到与电影一致的标签权重体系。改完重跑脚本即可刷新。

## 模糊匹配逻辑（js/match.js）
- 5 题答案的标签权重累加为向量 `W`。
- 每部电影得分 = `Σ(W[t]·电影标签强度) + 命中标签覆盖度 + 评分微调`，保证"至少有些相关性"。
- 取前 8 名做加权随机，挑出一部——既贴近心境又保留每次的随机性。
- `换一部` 从候选池里另选，`重新测` 重开。

## AI 全盘解读（预留）
`match.js` 的 `buildInterpretPrompt()` 已生成完整提示词（把 5 个回答 + 影片信息串成 200~350 字叙事）。前端"✦ AI 全盘解读"按钮会展示这段提示词。正式接入时：在 Vercel 建 `/api/interpret` 函数，把提示词发给 LLM 返回解读，前端 `fetch` 调用即可（key 放 Vercel 环境变量，不进仓库）。

## 部署到 Vercel
纯静态，零配置：
1. 把整个 `movie-mood/` 推到 GitHub 仓库。
2. Vercel 导入该仓库，Framework 选 "Other"，Build Command / Output 留空（或 Output Directory 留空）。
3. Deploy。`index.html` 为入口，所有资源相对路径，天然同域可用。

> 注意：`images/posters/` 需随仓库一起提交（约数百张压缩 jpg，总大小通常 10~20MB，Vercel 可承载）。若图片过多想减负，可在 `fetch_movies.py` 里把分辨率降到 `w185` 或提高压缩比。
