/* match.js - 模糊匹配逻辑
 * 输入: answers = [{weights:{tag:w}}, ...]  (每题所选选项的标签权重)
 * 输出: 排序后的电影 + 推荐理由 + (后续) AI 解读提示词
 */
(function (global) {
  "use strict";

  /* 场景类标签映射：这些维度是「观看场景」而非电影属性，
   * 片库里不可能有「一个人看」「周末」这种标签（任何片都能一个人看）。
   * 与其硬给电影打标污染数据，不如在此把场景偏好翻译成内容偏好。
   * 例：选「一个人看」→ 加权 孤独/慢节奏/治愈，而非落空。 */
  const SCENE_MAP = {
    一个人看: { 孤独: 1.0, 慢节奏: 0.5, 治愈: 0.4 },
    和朋友: { 喜剧: 1.0, 爽: 0.5, 热血: 0.4 },
    和伴侣: { 浪漫: 1.0, 温情: 0.5 },
    周末: { 轻松: 1.0, 慢节奏: 0.4 },
    深夜: { 慢节奏: 0.7, 孤独: 0.5, 暗黑: 0.4 },
    通勤: { 轻松: 1.0, 快节奏: 0.4 },
    // 片库真美食题材仅 3 部，池子太薄，用情绪相近的标签兜底避免落空
    美食: { 治愈: 0.8, 温暖: 0.6 },
  };

  /* 题目档位权重：解决「137 题几乎全权重 1」导致的等权淹没。
   * 判据是「答案需不需要二次翻译」：答案能直接等价于内容类型的题，权重最高。
   * ×3 核心：体验/心情/目的/陪伴（此刻要什么，直接映射内容）+ 偏好（长期口味，题量最大）
   * ×2 重要：题材（二次筛选，前提是已选中该题材）/ 精力（只决定节奏快慢）
   * ×1 点缀：性格/阶段/粒度/隐喻/时间/情怀/夜生活（趣味包装与强度微调）
   * 注意：questions.js 由脚本自动生成，故档位不写进数据，而在此集中维护。 */
  const CATEGORY_WEIGHT = {
    体验: 3, 心情: 3, 目的: 3, 陪伴: 3, 偏好: 3,
    题材: 2, 精力: 2,
    性格: 1, 阶段: 1, 粒度: 1, 隐喻: 1, 时间: 1, 情怀: 1, 夜生活: 1,
  };
  // 档位分级：供分层抽样复用，保证权重与抽题口径一致
  function tierOf(category) {
    const w = CATEGORY_WEIGHT[category] || 1;
    return w >= 3 ? 3 : w >= 2 ? 2 : 1;
  }

  // 评分取值：优先 TMDB 评分（更权威），缺失时回落到自有 rating 字段
  // 抽成独立函数，避免 (tmdb_rating || rating) 在多处重复、且口径不一致
  function ratingOf(m) {
    return m && (m.tmdb_rating != null ? m.tmdb_rating : (m.rating || 0));
  }

  // 把多题答案聚合成总权重向量
  function aggregate(answers) {
    const W = {};
    answers.forEach((a) => {
      if (!a || !a.weights) return;
      const k = CATEGORY_WEIGHT[a._cat] || 1;
      for (const t in a.weights) {
        const w = a.weights[t] * k;
        W[t] = (W[t] || 0) + w;
        // 场景标签展开为内容标签（原标签保留：已补标的题材类可直接命中）
        const mapped = SCENE_MAP[t];
        if (mapped) {
          for (const mt in mapped) W[mt] = (W[mt] || 0) + w * mapped[mt];
        }
      }
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
    // 系数 0.22→0.45 的依据(2026-09-08 参数扫描): 池温是本引擎唯一「免费」的多样性杠杆：
    //   0.22→0.60 区间内，可达集 197→300 部、Top20 集中度 54%→31%，而信号(同答案稳定性)
    //   不降反升 71.4%→77.0%。因为 pickOne 是在池内按「真实分」低温挑选，池子变多样并不损准确度。
    //   取 0.45 而非 0.60: 再往上对可达集的边际收益变小，而「换一部」质量会继续下滑。
    //   ⚠️ 不要再靠调高「首次温度」换多样性，那是假多样性，信号会暴跌(首温 0.15 时信号仅剩 38%)。
    const T = Math.max(1.2, maxScore * 0.45);
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
  // tempFactor 由调用方决定，两个场景需求相反:
  //   首次揭晓 → 低温(0.05)，给出最匹配的那部，让 5 道题真正起作用
  //   「换一部」→ 中温(0.2)，保证点下去有明显变化，但不至于换到低分相关片
  //      (实测: 池温上调到 0.45 后，换一部若仍用 0.3，质量会从 80% 掉到 70.4%；
  //       回补到 0.2 后回到 74.3%，而连点 40 次仍能换出 7.3 部不同的片，变化度几乎无损)
  function pickOne(ranked, opts) {
    if (!ranked.length) return null;
    opts = opts || {};
    const scores = ranked.map((x) => (x.r ? x.r.score : 0));
    const maxS = Math.max.apply(null, scores);
    const tf = opts.tempFactor != null ? opts.tempFactor : 0.05;
    const T = Math.max(0.6, maxS * tf);
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

  /* 地区/年代是客观分类而非情绪气质，出现在「为什么是它」里会很出戏
   * （曾出现「它带着『其他』的气质」）。这里从推荐理由中剔除，
   * 但仍可正常显示在结果页的标签区。 */
  const SKIP_IN_REASON = new Set(["欧美", "华语", "其他", "近代"]);

  function buildReason(movie, W) {
    /* 文案一律写成「无主语短语」，由下面统一加一次「你」，
     * 避免三句连排出现「你…你…你…」的机器感。
     * 场景类标签（深夜/一个人看/和朋友等）是观看场景、不在电影标签上，
     * 已由 SCENE_MAP 翻译成内容标签，故此处不再留对应文案。
     * 写法要求：能直接接在「你」后面读通，短、口语、带一点观察，
     * 不写成机构化的状态描述（「需要被温柔包裹」→「需要被稳稳接住」）。 */
    const labelMap = {
      治愈: "需要被稳稳接住", 致郁: "想认真地难过一会儿", 热血: "身上有股没处使的劲儿",
      轻松: "想彻底松口气", 烧脑: "脑子闲不下来", 温情: "想靠近一点别人的温度",
      爽: "在等一个痛快", 浪漫: "心里还留着点浪漫", 孤独: "一个人待着也不觉得亏",
      震撼: "想被什么东西砸一下", 暗黑: "知道世界有阴影，也不躲", 冒险: "想逃去远方",
      青春: "会想起年轻时的自己", 成长: "在意自己有没有变好", 喜剧: "欠自己一场大笑",
      悬疑: "不介意被蒙在鼓里", 科幻: "想看看以后会怎样", 历史: "想从旧事里找点答案",
      动画: "心里还住着个小孩", 友情: "想有人搭个伴", 日韩: "想看点东亚的味道",
      童话: "还信魔法", 明亮: "想要点光", 音乐: "想被旋律托住",
      爱情: "心里有人", 家庭: "想回家", 职场: "想知道自己站在哪一格", 快节奏: "想让时间跑起来",
      冷峻: "受得住冷的真实", 战争: "想知道人能被推到哪一步",
      写实: "想看没滤镜的生活", 惊悚: "想被吓出点清醒",
      奇幻: "想逃进别的世界", 恐怖: "想试试自己的胆量",
      慢节奏: "不想再赶时间", 新片: "想赶在前面看", 旅行: "想去远方坐会儿",
      温暖: "有点凉，想被捂一捂", 犯罪: "敢看人性的暗面", 社会: "想看懂这世界",
      经典老片: "想和老片重逢", 美食: "想被喂饱眼睛", 荒诞: "看懂了这世界的荒唐",
    };
    const fallback = "它和此刻的你是一路人，不用多解释。";
    // 多取几个再过滤，避免前 3 个恰好都是地区标签时理由为空
    const tags = topTags(movie, W, 8)
      .filter((t) => !SKIP_IN_REASON.has(t))
      .slice(0, 2);
    const parts = tags.map((t) => labelMap[t]).filter(Boolean);
    if (!parts.length) return fallback;
    /* 只取前两个标签：topTags 已按匹配强度排序，前两条就是最强信号。
     * 三条堆在一起会读成清单，两句反而更像有人在跟你说话。 */
    let s = "你" + parts[0];
    if (parts.length > 1) s += "，也" + parts[1];
    return s + "。";
  }

  /* ---------- AI 解读提示词 ----------
   * 接法: 把 buildInterpretPrompt 的结果发给 LLM (agnes / gemini)，
   * 返回一段 150~350 字的"整盘解读"，把用户的 5 个回答与这部电影串成叙事。
   * 服务端在 api/interpret.js，前端 fetch 调用。
   *
   * 人设描述是这一段里真正影响成品质感的部分：写"懂电影也懂人心"会得到
   * 一段评测腔的推荐语；写清身份与说话习惯（短、准、不哄人）才拿得到
   * 「不良少女放映组」该有的口吻。改这里等于改 AI 说话的调子。 */
  function buildInterpretPrompt(answersText, movie) {
    return [
      "你是不良少女放映组的主理人，替人挑片很多年。说话短、准、不哄人。",
      "请根据下面这位用户刚才的回答，为这部电影写一段中文解读。",
      "【格式】宁可写短，也绝不能在句子中间截断，每句话都要完整。150 字上下就够。",
      "【要求】",
      "1. 不剧透关键情节。",
      "2. 说清为什么是这部，把用户此刻的心境和片子的气质接上，别泛泛夸片。",
      "3. 像一个看得多、不迎合的人：可以有点不羁和漫不经心，但不油、不用力、不煽情。",
      "4. 可以点破用户在躲什么，但不要教训人，也别卖惨。",
      "5. 最后一句必须是「今晚就它了。」，独占一行，一字不差，不可替换。",
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

  global.Match = { aggregate, scoreMovie, recommend, pickOne, buildReason, topTags, buildInterpretPrompt, ratingOf, CATEGORY_WEIGHT, tierOf };
})(window);
