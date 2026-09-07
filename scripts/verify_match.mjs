/* 推荐质量回归工具
 * 用法: node scripts/verify_match.mjs
 * 对比「改动前(movies.js.bak + match.js.bak)」与「改动后(现行)」的关键指标。
 * 说明: 出题统一用现行 tierOf 做分层抽样，使两组的题目分布一致，
 *       唯一变量是「补标签 + 调温度 + 题目档位权重」本身的效果。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (p) => path.join(ROOT, p);
function loadJS(file, name) {
  const w = {};
  new Function("window", fs.readFileSync(R(file), "utf8"))(w);
  return w[name];
}

function build(moviesFile, matchFile) {
  const MOVIES = loadJS(moviesFile, "MOVIES");
  const QUESTIONS = loadJS("data/questions.js", "QUESTIONS");
  const w = {};
  new Function("window", fs.readFileSync(R(matchFile), "utf8"))(w);
  return { MOVIES, QUESTIONS, Match: w.Match };
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* 分层抽样（与 js/app.js pickStratified 同逻辑）：5 = 核心×2 + 重要×2 + 点缀×1
 * 替代原先的纯随机 shuffle，保证每轮都有核心信号。 */
function pickStratified(list, n, tierOf) {
  const tiers = { 3: [], 2: [], 1: [] };
  list.forEach((q) => tiers[tierOf(q.category)].push(q));
  // 配额按 n 缩放：核心 40% / 重要 40% / 点缀 20%，保证 n≠5 时也成立
  const q3 = Math.max(1, Math.round(n * 0.4));
  const q1 = Math.max(1, Math.floor(n * 0.2));
  const quota = { 3: q3, 2: Math.max(0, n - q3 - q1), 1: q1 };
  const picked = [];
  [3, 2, 1].forEach((t) =>
    shuffle(tiers[t]).slice(0, quota[t]).forEach((q) => picked.push(q))
  );
  if (picked.length < n) {
    const rest = shuffle(list.filter((q) => picked.indexOf(q) < 0));
    while (picked.length < n && rest.length) picked.push(rest.shift());
  }
  return shuffle(picked).slice(0, n);
}

// 模拟一次完整答题：分层抽题 → 随机选选项 → 打上 _cat（供 aggregate 按档位加权）
function simulate(QUESTIONS, tierOf, n = 5) {
  return pickStratified(QUESTIONS, n, tierOf).map((q) => {
    const o = q.options[Math.floor(Math.random() * q.options.length)];
    o._cat = q.category;
    return o;
  });
}

function metrics({ MOVIES, QUESTIONS, Match }, tierOf) {
  const tagCount = {};
  MOVIES.forEach((m) =>
    Object.keys(m.tags || {}).forEach((t) => (tagCount[t] = (tagCount[t] || 0) + 1))
  );
  const movieTagSet = new Set(Object.keys(tagCount));

  // 孤儿标签：题目用到但片库没有
  const qTags = {};
  QUESTIONS.forEach((q) =>
    (q.options || []).forEach((o) =>
      Object.keys(o.weights || {}).forEach((t) => (qTags[t] = 1))
    )
  );
  const orphan = Object.keys(qTags).filter((t) => !movieTagSet.has(t));

  // 完全落空 / 部分落空 选项
  let dead = 0, partial = 0;
  QUESTIONS.forEach((q) =>
    (q.options || []).forEach((o) => {
      const w = o.weights || {};
      const ts = Object.keys(w);
      if (!ts.length) return;
      const total = ts.reduce((s, t) => s + (w[t] || 0), 0);
      const dv = ts
        .filter((t) => !movieTagSet.has(t))
        .reduce((s, t) => s + (w[t] || 0), 0);
      if (dv === total) dead++;
      else if (dv / total >= 0.5) partial++;
    })
  );

  // 噪声：固定一组答案反复推荐，去重结果数（越低越稳）
  function noise(answers, runs = 200) {
    const ranked = Match.recommend(answers, MOVIES, { poolSize: 8 });
    const ids = new Set();
    for (let i = 0; i < runs; i++) {
      const p = Match.pickOne(ranked);
      if (p) ids.add(p.m.id);
    }
    return ids.size;
  }
  const noiseArr = [];
  for (let t = 0; t < 20; t++) noiseArr.push(noise(simulate(QUESTIONS, tierOf)));
  const avgNoise = noiseArr.reduce((a, b) => a + b, 0) / noiseArr.length;

  // 头部集中度：同一答案反复推荐，最常出现的那部占比（越高=信号越强）
  function topShare(answers, runs = 300) {
    const ranked = Match.recommend(answers, MOVIES, { poolSize: 8 });
    const c = {};
    for (let i = 0; i < runs; i++) {
      const p = Match.pickOne(ranked);
      if (p) c[p.m.id] = (c[p.m.id] || 0) + 1;
    }
    return Math.max(...Object.values(c)) / runs;
  }
  const shareArr = [];
  for (let t = 0; t < 20; t++) shareArr.push(topShare(simulate(QUESTIONS, tierOf)));
  const avgShare = shareArr.reduce((a, b) => a + b, 0) / shareArr.length;

  // 纯分数最优片（不经过温度扰动）
  function best(answers) {
    const W = Match.aggregate(answers);
    const sc = MOVIES.map((m) => ({ m, r: Match.scoreMovie(m, W) }));
    sc.sort((a, b) => b.r.score - a.r.score);
    return sc[0] ? sc[0].m : null;
  }

  // 单题区分度：固定背景答案，只换该题选项，最优片是否变化
  let noDisc = 0, tested = 0;
  const noDiscByTier = { 3: [0, 0], 2: [0, 0], 1: [0, 0] };
  QUESTIONS.forEach((q) => {
    if (q.options.length < 2) return;
    const others = pickStratified(
      QUESTIONS.filter((x) => x !== q),
      4,
      tierOf
    ).map((x) => {
      const o = x.options[0];
      o._cat = x.category;
      return o;
    });
    const res = new Set();
    q.options.forEach((o) => {
      o._cat = q.category;
      const b = best(others.concat([o]));
      if (b) res.add(b.title);
    });
    tested++;
    if (res.size === 1) {
      noDisc++;
      const t = tierOf(q.category);
      noDiscByTier[t][0]++;
    }
    noDiscByTier[tierOf(q.category)][1]++;
  });

  // 信号：不同答案 → 最优片去重数（越高=答案越能影响结果）
  const bests = new Set();
  for (let t = 0; t < 300; t++) {
    const b = best(simulate(QUESTIONS, tierOf));
    if (b) bests.add(b.id);
  }

  return {
    orphan, dead, partial, avgNoise, avgShare, noDisc, tested,
    signalVariety: bests.size, noDiscByTier,
  };
}

const tierOf = (c) => {
  const w = { 体验: 3, 心情: 3, 目的: 3, 陪伴: 3, 偏好: 3, 题材: 2, 精力: 2 };
  return w[c] || 1;
};

const OLD = metrics(build("data/movies.js.bak", "js/match.js.bak"), tierOf);
const NEW = metrics(build("data/movies.js", "js/match.js"), tierOf);

const row = (name, a, b, better) => {
  const mark =
    better === "down"
      ? b < a ? "✅" : b === a ? "＝" : "⚠️"
      : b > a ? "✅" : b === a ? "＝" : "⚠️";
  console.log(`  ${mark} ${name.padEnd(24)} ${String(a).padStart(8)}  →  ${String(b)}`);
};

console.log("=== 改动前 → 改动后 ===\n");
console.log("  【数据层】");
row("孤儿标签数", OLD.orphan.length, NEW.orphan.length, "down");
row("完全落空选项", OLD.dead, NEW.dead, "down");
row("死权重≥50%选项", OLD.partial, NEW.partial, "down");
console.log("\n  【信号 vs 噪声】");
row("同答案200次去重数", OLD.avgNoise.toFixed(1), NEW.avgNoise.toFixed(1), "down");
row("首选占比(越高=越准)", (OLD.avgShare * 100).toFixed(0) + "%", (NEW.avgShare * 100).toFixed(0) + "%", "up");
console.log("\n  【区分度】");
row("零区分度题目数", `${OLD.noDisc}/${OLD.tested}`, `${NEW.noDisc}/${NEW.tested}`, "down");
row("300组答案最优片种类", OLD.signalVariety, NEW.signalVariety, "up");

const tierLine = (tag, m) => {
  console.log(`  ${tag}`);
  ["3", "2", "1"].forEach((t) => {
    const [n, tot] = m.noDiscByTier[t];
    const label = { 3: "核心×3", 2: "重要×2", 1: "点缀×1" }[t];
    console.log(
      `    ${label}  ${String(n).padStart(3)}/${String(tot).padEnd(3)} 无区分  (${((n / tot) * 100).toFixed(0)}%)`
    );
  });
};
console.log("\n  【零区分度 · 按档位拆解】");
tierLine("改动前:", OLD);
tierLine("改动后:", NEW);
console.log("\n  剩余孤儿标签:", NEW.orphan.length ? NEW.orphan.join(", ") : "无");
