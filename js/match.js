/* match.js - 模糊匹配逻辑
 * 输入: answers = [{weights:{tag:w}}, ...]  (每题所选选项的标签权重)
 * 输出: 排序后的电影 + 推荐理由 + (后续) AI 解读提示词
 */
(function (global) {
  "use strict";

  // 把多题答案聚合成总权重向量
  function aggregate(answers) {
    const W = {};
    answers.forEach((a) => {
      if (!a || !a.weights) return;
      for (const t in a.weights) W[t] = (W[t] || 0) + a.weights[t];
    });
    return W;
  }

  // 单部电影得分: 答案权重 × 电影标签强度, 加覆盖度奖励与评分微调
  function scoreMovie(movie, W) {
    let s = 0;
    let matched = 0;
    for (const t in W) {
      const ms = movie.tags && movie.tags[t];
      if (ms) {
        s += W[t] * ms;
        matched++;
      }
    }
    // 覆盖度: 命中的不同标签数, 保证"多少有些相关性"
    const coverage = matched;
    // 评分微调(0~10 -> 0~2), 让好片更容易浮现但不喧宾夺主
    const ratingBonus = (movie.rating || 0) * 0.2;
    return { score: s + coverage * 0.6 + ratingBonus, matched, raw: s };
  }

  // 标准正态随机 (Box-Muller)，用于温度扰动
  function randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---- 加权维度: 今年新片 + TMDB 评分前100，约 +20% 选中概率 ----
  const BOOST = 1.1;          // 池内选中权重倍数 (pickOne)
  const POOL_LIFT = 0.05;     // 候选池内的上浮量 (单位: 温度 T)
  const CURRENT_YEAR = new Date().getFullYear();
  let _top100Cache = null;
  function getTop100(movies) {
    if (_top100Cache) return _top100Cache;
    const arr = movies.slice().sort(
      (a, b) => (b.tmdb_rating || b.rating || 0) - (a.tmdb_rating || a.rating || 0)
    );
    _top100Cache = new Set(arr.slice(0, 100).map((m) => m.id));
    return _top100Cache;
  }
  function isBoosted(m, movies) {
    if (m.year && m.year === CURRENT_YEAR) return true; // 今年新片
    if (getTop100(movies).has(m.id)) return true;       // TMDB 评分前100
    return false;
  }

  // 推荐: 在"相关片"内做温度扰动排序，扩大可达集合、降低集中度
  function recommend(answers, movies, opts) {
    opts = opts || {};
    const poolSize = opts.poolSize || 16; // 候选池扩大，给"换一部"更多选择
    const W = aggregate(answers);
    const scored = movies.map((m) => ({ m, r: scoreMovie(m, W) }));
    const maxScore = scored.reduce((a, s) => Math.max(a, s.r.score), 0);

    // 相关度门限: 至少命中过标签或达到最高分的 25%，避免完全无关片冒泡
    const gate = Math.max(1, maxScore * 0.25);
    const relevant = scored.filter((s) => s.r.matched > 0 && s.r.score >= gate);

    // 温度扰动: 每次调用给相关片加不同噪声，让不同相关片轮流进入候选池
    const T = Math.max(2, maxScore * 0.55);
    relevant.forEach((s) => {
      s.boosted = isBoosted(s.m, movies);
      // 加权维度: 给新片/前100 一点池内上浮，让它们更容易进入候选池
      const lift = s.boosted ? T * POOL_LIFT : 0;
      s.perturbed = s.r.score + randn() * T + lift;
    });
    relevant.sort((a, b) => b.perturbed - a.perturbed);

    return relevant.slice(0, poolSize).map((s) => ({ m: s.m, r: s.r, boosted: s.boosted }));
  }

  // 从候选池里挑一部 (温度 softmax，偏向高分但更平缓，降低头部集中)
  function pickOne(ranked) {
    if (!ranked.length) return null;
    const scores = ranked.map((x) => (x.r ? x.r.score : 0));
    const maxS = Math.max.apply(null, scores);
    const T = Math.max(1, maxS * 0.35);
    // 加权维度: 今年新片 / 前100 的候选权重 ×1.2 (约 +20% 选中概率)
    const weights = scores.map((s, i) =>
      Math.exp((s - maxS) / T) * ((ranked[i].boosted) ? BOOST : 1)
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return ranked[i];
    }
    return ranked[0];
  }

  function topTags(movie, W, n) {
    return Object.keys(movie.tags || {})
      .filter((t) => W[t])
      .sort((a, b) => (W[b] * (movie.tags[b] || 0)) - (W[a] * (movie.tags[a] || 0)))
      .slice(0, n || 3);
  }

  function buildReason(movie, W) {
    const tags = topTags(movie, W, 3);
    const labelMap = {
      治愈: "你需要被温柔包裹", 致郁: "你想认真地难过一会儿", 热血: "你渴望被点燃",
      轻松: "你想彻底松口气", 烧脑: "你想动动脑子", 温情: "你向往人与人之间温度",
      爽: "你等一个痛快", 浪漫: "你心里有浪漫的余温", 孤独: "你享受独处的此刻",
      震撼: "你想要被宏大击中", 暗黑: "你接受世界的阴影", 冒险: "你想逃去远方",
      青春: "你想回看年轻时", 成长: "你在意前行的意义", 喜剧: "你想笑一场",
      悬疑: "你喜欢未知", 科幻: "你想望向未来", 历史: "你想借往事照见此刻",
      动画: "你心里还住着个小孩", 友情: "你想有人陪", 日韩: "你想看点东亚氛围",
      童话: "你还信魔法", 明亮: "你想要点光", 音乐: "你想被旋律托住",
      爱情: "你心里有人", 家庭: "你想回家", 职场: "你想看清自己", 快节奏: "你想让时间跑起来",
      冷峻: "你想要点冷的真实", 深夜: "你总在深夜沉思", 战争: "你想看清人性边界",
      写实: "你想看没滤镜的生活", 惊悚: "你想被吓出点清醒",
    };
    if (!tags.length) return `它刚好和你此刻的状态同频，值得今晚留给它。`;
    const parts = tags.map((t) => labelMap[t] || `它带着「${t}」的气质`);
    return parts.join("，") + "。";
  }

  /* ---------- 后续接入 AI 的提示词 (stub) ----------
   * 接法: 把 buildInterpretPrompt 的结果发给 LLM (如 agnes / gpt)，
   * 返回一段 200~400 字的"整盘解读"，把用户的 5 个回答与这部电影串成叙事。
   * 可放在 Vercel 的 /api/interpret 函数里，前端 fetch 调用。
   */
  function buildInterpretPrompt(answersText, movie) {
    return [
      "你是一个懂电影也懂人心的观影向导。",
      "请根据用户刚才的 5 个回答，为一部电影写一段中文'全盘解读'。",
      "【最重要】宁可写短，也绝不能在句子中间截断——每一句话都必须写完、通顺、完整。可以精炼（150 字左右亦可），但绝不允许半句话戛然而止。",
      "要求：1) 不剧透关键情节；2) 把用户的心境与电影气质自然勾连；3) 语气像朋友推荐，不油腻，可以带一点点不羁、漫不经心的酷劲儿，但别太用力；4) 最后以「今晚就它了。」收尾——这一句独占一行作为结尾，一字不差，不可替换。",
      "",
      "用户的回答：",
      answersText,
      "",
      "推荐影片：《" + movie.title + "》（" + (movie.year || "") + "）",
      "类型：" + (movie.genres || []).join("、"),
      "评分：" + ([
        movie.tmdb_rating && "TMDB " + movie.tmdb_rating,
        movie.douban_rating && "豆瓣 " + movie.douban_rating,
        movie.imdb_rating && "IMDB " + movie.imdb_rating,
      ].filter(Boolean).join("、") || "暂无评分数据"),
      "简介：" + (movie.overview || ""),
      "标签：" + Object.keys(movie.tags || {}).join("、"),
    ].join("\n");
  }

  global.Match = { aggregate, scoreMovie, recommend, pickOne, buildReason, topTags, buildInterpretPrompt };
})(window);
