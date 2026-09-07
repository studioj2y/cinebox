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
│  ├─ movies.js        window.MOVIES（540 部电影元数据 + 标签 + 本地海报路径）
│  └─ questions.js     window.QUESTIONS（137 道性格/心情/状态题，含答案权重）
├─ api/
│  ├─ _lib/core.js     多 provider 轮转 + KV 缓存（可选降级）
│  └─ interpret.js     Vercel Serverless：/api/interpret
├─ images/
│  ├─ logo-silhouette.png   白色剪影 LOGO
│  └─ posters/         540 张本地压缩海报（随仓库提交）
├─ scripts/            数据拉取 / 题库生成 / LOGO 处理脚本（开发用）
│  └─ verify_match.mjs 推荐质量回归工具（改动前后指标对比）
├─ dev-server.mjs      本地开发服务（静态 + /api/interpret）
└─ server.mjs          生产服务（显式绑定 0.0.0.0，读 .env）
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
   会从 TMDB 拉取 popular + top_rated 去重约 540 部，下载 `w342` 海报到 `images/posters/` 并压缩（quality 70），生成 `data/movies.js`。

## 推荐引擎（js/match.js）

流程：5 题答案 → 按档位加权聚合成标签向量 → 与电影标签强度求内积 → 温度扰动挑一部。

**三处关键设计，改前请先看懂，否则容易把效果改坏：**

1. **场景标签映射 `SCENE_MAP`**：「一个人看」「和朋友」「深夜」等是**观看场景而非电影属性**（任何片都能一个人看），片库里不可能有这些标签。与其硬给电影打标污染数据，不如在此把场景偏好翻译成内容偏好（如「和朋友」→ 喜剧 1.0 / 爽 0.5 / 热血 0.4）。

2. **题目档位权重 `CATEGORY_WEIGHT`**：137 题原先几乎全是权重 1，导致 5 题互相淹没。现按「答案需不需要二次翻译」分三档：
   - `×3` 核心：体验 / 心情 / 目的 / 陪伴 / 偏好
   - `×2` 重要：题材 / 精力
   - `×1` 点缀：性格 / 阶段 / 粒度 / 隐喻 / 时间 / 情怀 / 夜生活

   ⚠️ 档位**不写进 `data/questions.js`**（该文件由 `scripts/gen_questions.py` 自动生成，手改会被覆盖），统一在 `match.js` 维护。

3. **分层抽样 `pickStratified`（js/app.js）**：原先 `shuffle(QUESTIONS).slice(0,5)` 纯随机，实测 **18.2% 的轮次一道核心题都抽不到**，整轮全是弱信号。现按档位配额抽 5 题 = 核心×2 + 重要×2 + 点缀×1，核心信号 0 缺席。

**改完务必跑回归**：`node scripts/verify_match.mjs`
会对比 `data/movies.js.bak` + `js/match.js.bak`（改动前）与现行版本的关键指标。核心看「首选占比」（越高越准）和「核心档零区分度题目数」（越低越好）。

## AI 解读（已接入 agnes-ai）
结果页「✦ 不良解读」按钮调用 `/api/interpret`（Vercel Serverless Function），由服务端带 key 转发给 agnes-ai `/v1/chat/completions`（模型 `agnes-2.5-flash`），把 5 个回答 + 影片信息串成一段 200~350 字、以「今晚就它了。」收尾的叙事解读。

- ✅ **key 不进前端**：走服务端代理，key 配在 Vercel 环境变量，不进仓库、不暴露给用户。
- 多 key 轮转：`AGNES_API_KEYS` 支持逗号分隔多个 key，失败自动换下一个；同时兼容 openai/deepseek/moonshot。
- 缓存：`@vercel/kv` 可选，未配置环境变量时自动退回内存 Map，不影响功能。
- 本地开发：复制 `.env.example` 为 `.env` 填入 key，再 `node dev-server.mjs`。
- 前端已兜底：即便接口异常，也会回退展示已构造好的提示词，不会白屏。

## 部署状态

| 项 | 值 |
|---|---|
| GitHub | `https://github.com/studioj2y/cinebox.git`（分支 `main`） |
| Vercel | 已通过 GitHub 集成，推 `main` 自动重部署 |
| 线上地址 | `cinebox.studioj2y.icu` |

## 日常更新（推送到 GitHub → Vercel 自动部署）

改动完成后，在 Git Bash 里按顺序执行：

```bash
cd /d/DHZQ/workbuddy/Ideas/movie-mood

# ① 先看清楚改了什么（确认没有 .venv / .bak / 大文件混进来）
git status

# ② 按文件添加（不要用 git add . ，避免误提交备份与临时脚本）
git add index.html css/style.css js/match.js js/app.js
git add data/movies.js data/questions.js
git add api/ scripts/ dev-server.mjs server.mjs vercel.json
git add README.md .gitignore package.json

# ③ 提交
git commit -m "feat: 简述本次改动"

# ④ 推送（Vercel 约 1 分钟内自动完成部署）
git push origin main
```

**推送后检查**：Vercel 后台 → Deployments 看是否 Success；再去线上地址刷新验证（静态资源有 CDN 缓存，必要时硬刷新 `Ctrl+F5`）。

### 注意事项
- `.gitignore` 已排除 `.venv/`、`.env`、`*.bak`、`_*.mjs`、开发期源图，不会被提交。
- 若改动涉及 `/api/interpret`（换模型、换 provider），需确认 Vercel 环境变量里有对应的 key。
- `images/posters/` 已随仓库提交（540 张压缩图，约 25MB），Vercel 可承载。

## 后续可选项
- 多平台排名合并：`fetch_movies.py` 已为每个电影预留 `sources` 字段，融合豆瓣/IMDb 等排名时往里追加打分函数即可。
- key 代理：如上所述，把 agnes 调用挪到 `/api/interpret` 函数，key 入 Vercel 环境变量。
