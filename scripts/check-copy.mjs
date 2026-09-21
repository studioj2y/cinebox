#!/usr/bin/env node
/* check-copy.mjs - 文案自检（零依赖、离线）
 *
 * 改完题库或界面文案后跑一次：node scripts/check-copy.mjs
 *
 * 为什么需要它：
 *   1. 题库里 358 条回复是逐条手写的，很容易写出重复句式或批发后缀；
 *   2. 文案改动最容易顺手把 weights（标签权重）带歪，而它直接决定推荐结果；
 *   3. 界面文案散在 index.html / app.js / match.js / core.js 四处，改了一处漏一处
 *      肉眼很难发现（本项目就出现过并行编辑导致部分改动静默丢失）。
 *
 * 标签覆盖（labelMap 是否缺文案）另见 scripts/check_labelmap.py。
 * AI 提供方降级链路另见 scripts/check-ai.mjs。
 *
 * 退出码 0 = 全通过，1 = 有未通过项。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log((ok ? "  \x1b[32m✓\x1b[0m " : "  \x1b[31m✗\x1b[0m ") + name + (detail ? "  [" + detail + "]" : ""));
  ok ? pass++ : fail++;
};

/* ---------- 载入题库 ---------- */
const sandbox = {};
new Function("window", read("data/questions.js"))(sandbox);
const Q = sandbox.QUESTIONS || [];

/* ---------- 规则常量 ---------- */
// 批量化后缀：早期由标签兜底生成的回复里大量出现，读起来像导购话术
const BANNED_REPLY = ["款，走起", "给你满上", "拉满", "安排上", "走起", "~", "～", "绝绝子", "宝子"];
// 旧文案黑名单：这些措辞已被重写，若重新出现说明改动回退或漏改
const BANNED_UI = [
  "回答 5 个关于此刻心情的小问题", "给你的今晚", "正在探究你的内心", "聊完啦",
  "揭晓今晚的电影", "今晚为你选出", "陪你一起看电影", "我也来挑一部",
  "正在为您生成海报", "已完成，可长按保存或分享", "好，记下了~", "重新测",
  "需要被温柔包裹", "渴望被点燃", "值得今晚留给它", "懂电影也懂人心",
  "想被怎样", "想要什么", "和谁一起", "耐受度",
];
const REPLY_MAX = 18;
const OPT_MAX = 12;
/* 含用户可见文案的文件。core.js 的 SYSTEM_PROMPT 也直接决定成品语气，
 * 是「AI 解读人设」的另一半，必须一起纳入检查。 */
const UI_FILES = ["index.html", "js/app.js", "js/match.js", "api/_lib/core.js"];

/* 注释不是发布出去的文案。判断「旧措辞是否残留」前先剥掉注释，
 * 否则像 match.js 里「旧写法「需要被温柔包裹」→「需要被稳稳接住」」这种
 * 对照说明会被算成残留（本项目就踩过一次，报了一组假红）。
 * 同一份剥离结果也用于破折号检查 —— 只有真正会显示给用户的字符才算数。 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")   // HTML 注释（含多行）
    .replace(/\/\*[\s\S]*?\*\//g, "")  // JS / CSS 块注释
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l)) // JS 行注释
    .join("\n");
}

console.log("\n=== 文案自检 ===");

/* ---------- [1] 题库结构 ---------- */
const nOpts = Q.reduce((s, q) => s + (q.options || []).length, 0);
check(Q.length > 0, "题库非空", Q.length + " 题 / " + nOpts + " 选项");
const badStruct = [];
Q.forEach((q) => {
  if (!q.id || !q.category || !q.question) badStruct.push("#" + q.id + " 缺字段");
  if (!q.options || !q.options.length) badStruct.push("#" + q.id + " 无选项");
  (q.options || []).forEach((o, i) => {
    if (!o.text) badStruct.push("#" + q.id + "." + i + " 缺 text");
    if (!o.reply) badStruct.push("#" + q.id + "." + i + " 缺 reply");
    if (!o.weights || !Object.keys(o.weights).length) badStruct.push("#" + q.id + "." + i + " weights 为空");
  });
});
check(badStruct.length === 0, "每题每选项字段完整（text/weights/reply）", badStruct.slice(0, 4).join(" ; "));

/* ---------- [2] 回复唯一性 ---------- */
const replies = [];
Q.forEach((q) => (q.options || []).forEach((o) => o.reply && replies.push(o.reply)));
const cnt = {};
replies.forEach((r) => (cnt[r] = (cnt[r] || 0) + 1));
const dup = Object.entries(cnt).filter(([, v]) => v > 1);
check(dup.length === 0, "回复全库唯一（" + replies.length + " 条）",
  dup.slice(0, 5).map(([k, v]) => k + "×" + v).join(" | "));

/* ---------- [3] 回复长度 / 禁用词 / 标点 ---------- */
const tooLong = replies.filter((r) => [...r].length > REPLY_MAX);
check(tooLong.length === 0, "回复 ≤" + REPLY_MAX + " 字",
  tooLong.slice(0, 5).map((r) => r + "(" + [...r].length + ")").join(" ; "));
const bannedHits = [];
replies.forEach((r) => BANNED_REPLY.forEach((b) => { if (r.includes(b)) bannedHits.push(r + " ←「" + b + "」"); }));
check(bannedHits.length === 0, "回复无批量化后缀 / 波浪号", bannedHits.slice(0, 6).join(" ; "));
const dashHits = replies.filter((r) => /[\u2014\u2013]/.test(r));
check(dashHits.length === 0, "回复无 em/en 破折号", dashHits.slice(0, 4).join(" ; "));

/* ---------- [4] 选项文本 ---------- */
const optLong = [];
Q.forEach((q) => (q.options || []).forEach((o) => {
  if ([...o.text].length > OPT_MAX) optLong.push(o.text + "(" + [...o.text].length + ")");
}));
check(optLong.length === 0, "选项文本 ≤" + OPT_MAX + " 字", optLong.slice(0, 6).join(" ; "));
const optDup = [];
Q.forEach((q) => {
  const seen = {};
  (q.options || []).forEach((o) => {
    if (seen[o.text]) optDup.push("#" + q.id + " 选项重复「" + o.text + "」");
    seen[o.text] = 1;
  });
});
check(optDup.length === 0, "同一题内选项不重复", optDup.slice(0, 4).join(" ; "));

/* ---------- [5] 界面文案 ---------- */
const uiHits = [];
for (const f of UI_FILES) {
  let live;
  try { live = stripComments(read(f)); } catch (e) { uiHits.push(f + " 读不到"); continue; }
  BANNED_UI.forEach((b) => { if (live.includes(b)) uiHits.push(f + " ←「" + b + "」"); });
}
check(uiHits.length === 0, "界面文案无旧措辞残留（不含注释）", uiHits.slice(0, 6).join(" ; "));

const uiDash = [];
for (const f of UI_FILES) {
  stripComments(read(f)).split("\n").forEach((l, i) => {
    if (/[\u2014\u2013]/.test(l)) uiDash.push(f + ":" + (i + 1));
  });
}
check(uiDash.length === 0, "界面可见文案无 em/en 破折号", uiDash.slice(0, 6).join(" ; "));

/* AI 解读的人设是两半：core.js 的 SYSTEM_PROMPT（system）与 match.js 的
 * buildInterpretPrompt（user）。这两处最容易被分头改而走味（本项目就漏过一半，
 * 前端换了新口吻、服务端还在用旧人设），这里只断言二者带着同一个身份。 */
const personaOk =
  stripComments(read("api/_lib/core.js")).includes("不良少女放映组") &&
  stripComments(read("js/match.js")).includes("不良少女放映组");
check(personaOk, "AI 解读人设两半一致（core.js / match.js 同身份）");

/* ---------- [6] weights 取值合法性 ---------- */
// 电影库实际存在的标签集：weights 里出现库外标签 = 该偏好永远匹配不到任何片子
const movieTagSet = new Set();
const movieSrc = read("data/movies.js");
for (const block of movieSrc.match(/"tags"\s*:\s*\{[\s\S]*?\}/g) || []) {
  for (const m of block.matchAll(/"([^"]+)"\s*:/g)) movieTagSet.add(m[1]);
}
// 场景标签是观看场景，由 match.js 的 SCENE_MAP 翻译成内容标签，不在电影 tags 上
const SCENE = new Set(["一个人看", "和朋友", "和伴侣", "周末", "深夜", "通勤"]);
const orphan = new Set();
Q.forEach((q) => (q.options || []).forEach((o) => {
  Object.keys(o.weights || {}).forEach((t) => { if (!movieTagSet.has(t) && !SCENE.has(t)) orphan.add(t); });
}));
check(orphan.size === 0, "weights 标签均能匹配到片库（或有场景映射）",
  [...orphan].slice(0, 8).join("、"));

/* ---------- 汇总 ---------- */
const color = fail === 0 ? "\x1b[32m" : "\x1b[31m";
console.log(`\n${color}结果：${pass} 通过 / ${fail} 失败\x1b[0m\n`);
process.exit(fail ? 1 : 0);
