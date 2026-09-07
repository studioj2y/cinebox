/* UI/文案审查：labelMap 覆盖率、推荐理由语感、分类名可读性 */
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
const MOVIES = loadJS("data/movies.js", "MOVIES");
const QUESTIONS = loadJS("data/questions.js", "QUESTIONS");
const w = {};
new Function("window", fs.readFileSync(R("js/match.js"), "utf8"))(w);
const Match = w.Match;

// 从 match.js 源码里抠出 labelMap
const src = fs.readFileSync(R("js/match.js"), "utf8");
const lmSrc = src.slice(src.indexOf("const labelMap"), src.indexOf("if (!tags.length)"));
const lm = {};
lmSrc.replace(/([一-鿿]+)\s*:\s*"([^"]*)"/g, (_, k, v) => (lm[k] = v));

console.log("=== ① labelMap 覆盖：哪些文案永远不会出现 ===");
const movieTags = new Set();
MOVIES.forEach((m) => Object.keys(m.tags || {}).forEach((t) => movieTags.add(t)));
const keys = Object.keys(lm);
const deadEntries = keys.filter((k) => !movieTags.has(k));
console.log(`  labelMap 共 ${keys.length} 条，其中电影标签里不存在（永不触发）: ${deadEntries.length} 条`);
deadEntries.forEach((k) => console.log(`    ✗ ${k} →「${lm[k]}」`));

console.log("\n=== ② 电影标签但 labelMap 没有（会走 fallback 句式）===");
const noMap = [...movieTags].filter((t) => !lm[t]);
console.log(`  ${noMap.length} 个: ${noMap.join(", ") || "无"}`);

console.log("\n=== ③ 推荐理由语感：随机 400 组答案，统计「你」字重复 ===");
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const tierOf = (c) => ({ 体验: 3, 心情: 3, 目的: 3, 陪伴: 3, 偏好: 3, 题材: 2, 精力: 2 }[c] || 1);
const cnt = { 0: 0, 1: 0, 2: 0, 3: 0 };
const samples = [];
for (let i = 0; i < 400; i++) {
  const qs = shuffle(QUESTIONS).slice(0, 5);
  const answers = qs.map((q) =>
    Object.assign({}, q.options[Math.floor(Math.random() * q.options.length)], { _cat: q.category })
  );
  const W = Match.aggregate(answers);
  const ranked = Match.recommend(answers, MOVIES, { poolSize: 8 });
  if (!ranked.length) continue;
  const pick = Match.pickOne(ranked);
  const reason = Match.buildReason(pick.m, W);
  const n = (reason.match(/你/g) || []).length;
  cnt[Math.min(n, 3)]++;
  if (samples.length < 6) samples.push(reason);
}
console.log(`  含 0 个「你」: ${cnt[0]}   1个: ${cnt[1]}   2个: ${cnt[2]}   3个及以上: ${cnt[3]}`);
console.log("\n  真实样例：");
samples.forEach((s) => console.log(`    ${s}`));

console.log("\n=== ④ 题目分类名（会直接显示在答题页 qCat）===");
const cats = {};
QUESTIONS.forEach((q) => (cats[q.category] = (cats[q.category] || 0) + 1));
Object.entries(cats).sort((a, b) => b[1] - a[1]).forEach(([c, n]) =>
  console.log(`    ${c.padEnd(4)} ${String(n).padStart(3)} 题`)
);
