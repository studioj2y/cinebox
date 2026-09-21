#!/usr/bin/env node
/* CINEBOX AI 提供方降级自检
 * ---------------------------------------------------------------------------
 * 用本机 mock 服务模拟 Agnes / Gemini，验证核心的「分层故障转移」逻辑，
 * **不需要任何真实 key、不产生任何外部请求、不花额度**。
 *
 * 用法：在项目根目录执行   node scripts/check-ai.mjs
 * 退出码：0 = 全部通过，1 = 有失败。
 *
 * 为什么要有这个脚本：降级路径（超时/5xx/空返回/降级后成功）恰恰是线上最容易
 * 悄悄坏掉、又很难用真 key 复现的部分。这里把 8 种配置组合全部钉死。
 */
import http from "http";
import path from "path";
import { pathToFileURL } from "url";

const ROOT = process.cwd();
const CORE_URL = pathToFileURL(path.join(ROOT, "api", "_lib", "core.js")).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- mock 提供方 ---------------- */
const state = {
  agnes: "ok",   // ok | http500 | http429 | slow | short | empty | keycheck
  gemini: "ok",
};

const LONG_TEXT =
  "这是一段用于自检的解读文本，长度足以通过最短长度校验，用来模拟模型正常返回内容。";

const server = http.createServer(async (req, res) => {
  const who = req.url.startsWith("/agnes") ? "agnes" : "gemini";
  const mode = state[who];
  const auth = req.headers.authorization || "";

  let body = "";
  for await (const c of req) body += c;

  if (mode === "slow") await sleep(8000);

  const fail = (code, msg) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  };

  if (mode === "http500") return fail(500, "internal error");
  if (mode === "http429") return fail(429, "rate limited");
  // 层内多 key 轮转：只认 good 这个 key，其余 401
  if (mode === "keycheck" && auth !== "Bearer good") return fail(401, "bad key");

  const text = mode === "short" ? "太短" : mode === "empty" ? "" : LONG_TEXT + `（${who}）`;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
});

const PORT = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------------- 环境隔离 ---------------- */
const ENV_PREFIX = /^(AGNES|GEMINI|OPENAI|DEEPSEEK|MOONSHOT|AI_|API_KEYS|KV_)/;
function scrubEnv() {
  for (const k of Object.keys(process.env)) if (ENV_PREFIX.test(k)) delete process.env[k];
}

// core.js 在模块顶层固化超时/预算常量，所以每个场景都要**重新加载模块**（用 query 破缓存）
let gen = 0;
async function loadCore(env) {
  scrubEnv();
  Object.assign(process.env, env);
  return import(CORE_URL + "?v=" + ++gen);
}

/* ---------------- 断言 ---------------- */
let pass = 0;
let failCount = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failCount++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? "  → " + detail : ""}`);
  }
}

const REQ = {
  movieId: "test-1",
  title: "测试影片",
  answers: [{ question: "q", text: "a" }],
  prompt: "请写一段解读。",
};

console.log("CINEBOX AI 降级自检（全部走本地 mock，无外部请求）\n");

/* ---- 1. 只配 Agnes ---- */
{
  console.log("[1] 只配 Agnes → 只用 Agnes");
  state.agnes = "ok";
  state.gemini = "ok";
  const { interpret } = await loadCore({ AGNES_API_KEYS: "a1", AGNES_BASE: BASE + "/agnes" });
  const r = await interpret({ ...REQ });
  check("provider = agnes", r.provider === "agnes", "实际 " + r.provider);
  check("未标记降级", !r.fallback);
  check("文本以「今晚就它了。」收尾", /今晚就它了。$/.test(r.text), JSON.stringify(r.text.slice(-12)));
}

/* ---- 2. 只配 Gemini ---- */
{
  console.log("\n[2] 只配 Gemini → 只用 Gemini");
  state.agnes = "http500"; // 即便 Agnes 挂了也不该被调用（没配 key）
  state.gemini = "ok";
  const { interpret } = await loadCore({ GEMINI_API_KEY: "g1", GEMINI_BASE: BASE + "/gemini" });
  const r = await interpret({ ...REQ, movieId: "test-2" });
  check("provider = gemini", r.provider === "gemini", "实际 " + r.provider);
  check("未标记降级", !r.fallback);
}

/* ---- 3. 两者都配，Agnes 5xx → 降级 Gemini ---- */
{
  console.log("\n[3] 都配 + Agnes 返回 500 → 降级 Gemini");
  state.agnes = "http500";
  state.gemini = "ok";
  const { interpret } = await loadCore({
    AGNES_API_KEYS: "a1", AGNES_BASE: BASE + "/agnes",
    GEMINI_API_KEY: "g1", GEMINI_BASE: BASE + "/gemini",
  });
  const r = await interpret({ ...REQ, movieId: "test-3" });
  check("provider = gemini", r.provider === "gemini", "实际 " + r.provider);
  check("标记 fallback = true", r.fallback === true);
}

/* ---- 4. Agnes 限流 429 → 降级 ---- */
{
  console.log("\n[4] 都配 + Agnes 返回 429 → 降级 Gemini");
  state.agnes = "http429";
  state.gemini = "ok";
  const { interpret } = await loadCore({
    AGNES_API_KEYS: "a1", AGNES_BASE: BASE + "/agnes",
    GEMINI_API_KEY: "g1", GEMINI_BASE: BASE + "/gemini",
  });
  const r = await interpret({ ...REQ, movieId: "test-4" });
  check("provider = gemini", r.provider === "gemini", "实际 " + r.provider);
  check("标记 fallback = true", r.fallback === true);
}

/* ---- 5. Agnes 卡住不返回 → 按单提供方超时切走（不能把总预算耗光） ---- */
{
  console.log("\n[5] 都配 + Agnes 卡死 8s → 超时后切 Gemini（AI_TIMEOUT_MS=1500）");
  state.agnes = "slow";
  state.gemini = "ok";
  const { interpret } = await loadCore({
    AGNES_API_KEYS: "a1", AGNES_BASE: BASE + "/agnes",
    GEMINI_API_KEY: "g1", GEMINI_BASE: BASE + "/gemini",
    AI_TIMEOUT_MS: "1500", AI_BUDGET_MS: "20000",
  });
  const t0 = Date.now();
  const r = await interpret({ ...REQ, movieId: "test-5" });
  const cost = Date.now() - t0;
  check("provider = gemini", r.provider === "gemini", "实际 " + r.provider);
  check("在 Agnes 卡死 8s 前就切走（< 6s）", cost < 6000, "实际 " + cost + "ms");
}

/* ---- 6. Agnes 返回过短（疑似截断）→ 降级 ---- */
{
  console.log("\n[6] 都配 + Agnes 返回过短 → 降级 Gemini");
  state.agnes = "short";
  state.gemini = "ok";
  const { interpret } = await loadCore({
    AGNES_API_KEYS: "a1", AGNES_BASE: BASE + "/agnes",
    GEMINI_API_KEY: "g1", GEMINI_BASE: BASE + "/gemini",
  });
  const r = await interpret({ ...REQ, movieId: "test-6" });
  check("provider = gemini", r.provider === "gemini", "实际 " + r.provider);
  check("标记 fallback = true", r.fallback === true);
}

/* ---- 7. 两者都挂 → 抛出汇总错误（含两家原因） ---- */
{
  console.log("\n[7] 都配 + 两家都失败 → 报错，且错误信息含两家原因");
  state.agnes = "http500";
  state.gemini = "http429";
  const { interpret } = await loadCore({
    AGNES_API_KEYS: "a1", AGNES_BASE: BASE + "/agnes",
    GEMINI_API_KEY: "g1", GEMINI_BASE: BASE + "/gemini",
  });
  let err = null;
  try {
    await interpret({ ...REQ, movieId: "test-7" });
  } catch (e) {
    err = e;
  }
  check("确实抛错", !!err);
  check("错误信息含 Agnes 与 Gemini", !!err && /Agnes/.test(err.message) && /Gemini/.test(err.message), err && err.message);
  check("错误信息含 HTTP 状态码", !!err && /HTTP 500/.test(err.message) && /HTTP 429/.test(err.message), err && err.message);
  check("错误信息无重复提供方名", !!err && !/Agnes: Agnes/.test(err.message), err && err.message);
}

/* ---- 8. 完全没配 → 明确报错 ---- */
{
  console.log("\n[8] 一个 key 都没配 → 明确报错");
  const { interpret } = await loadCore({});
  let err = null;
  try {
    await interpret({ ...REQ, movieId: "test-8" });
  } catch (e) {
    err = e;
  }
  check("确实抛错", !!err);
  check("提示未配置 key", !!err && /未配置任何 AI key/.test(err.message), err && err.message);
}

/* ---- 9. 同提供方内多 key 轮转：坏 key 换好 key，不吃降级 ---- */
{
  console.log("\n[9] Agnes 多 key（bad,good）→ 层内换 key 成功，不算降级");
  state.agnes = "keycheck";
  state.gemini = "ok";
  const { interpret } = await loadCore({
    AGNES_API_KEYS: "bad,good", AGNES_BASE: BASE + "/agnes",
    GEMINI_API_KEY: "g1", GEMINI_BASE: BASE + "/gemini",
  });
  const r = await interpret({ ...REQ, movieId: "test-9" });
  check("provider 仍为 agnes", r.provider === "agnes", "实际 " + r.provider);
  check("层内换 key 不标记为降级", !r.fallback);
}

/* ---- 10. 缓存命中：同片同答案第二次不再调用模型 ---- */
{
  console.log("\n[10] 缓存：同 movieId + 同答案第二次直接命中");
  state.agnes = "ok";
  const { interpret } = await loadCore({ AGNES_API_KEYS: "a1", AGNES_BASE: BASE + "/agnes" });
  const r1 = await interpret({ ...REQ, movieId: "test-10" });
  const r2 = await interpret({ ...REQ, movieId: "test-10" });
  check("首次未命中缓存", r1.cached === false);
  check("二次命中缓存", r2.cached === true);
  check("两次文本一致", r1.text === r2.text);
}

/* ---- 11. 优先级由 AI_PROVIDERS 顺序决定 ---- */
{
  console.log("\n[11] AI_PROVIDERS 顺序 = 优先级（写成 gemini,agnes 时 Gemini 优先）");
  state.agnes = "http500";
  state.gemini = "ok";
  const { interpret, providerStatus } = await loadCore({
    AI_PROVIDERS: "gemini,agnes",
    AGNES_API_KEYS: "a1", AGNES_BASE: BASE + "/agnes",
    GEMINI_API_KEY: "g1", GEMINI_BASE: BASE + "/gemini",
  });
  const st = providerStatus();
  check("顺序为 gemini → agnes", st.map((s) => s.name).join(",") === "gemini,agnes", JSON.stringify(st.map((s) => s.name)));
  check("两家 key 均识别", st.every((s) => s.ready));
  const r = await interpret({ ...REQ, movieId: "test-11" });
  check("provider = gemini", r.provider === "gemini", "实际 " + r.provider);
  check("未走降级（Gemini 本就是首选）", !r.fallback);
}

/* ---- 12. key 别名：单数 GEMINI_API_KEY 与复数 GEMINI_API_KEYS 都能识别 ---- */
{
  console.log("\n[12] key 别名识别（GEMINI_API_KEY / GEMINI_API_KEYS）");
  const a = await loadCore({ GEMINI_API_KEY: "g1", GEMINI_BASE: BASE + "/gemini" });
  check("识别单数 GEMINI_API_KEY", a.providerStatus().find((s) => s.name === "gemini").ready);
  const b = await loadCore({ GEMINI_API_KEYS: "g1,g2", GEMINI_BASE: BASE + "/gemini" });
  check("识别复数 GEMINI_API_KEYS（2 个）", b.providerStatus().find((s) => s.name === "gemini").keys === 2);
  const c = await loadCore({ AGNES_API_KEYS: "a1", AGNES_BASE: BASE + "/agnes" });
  const stc = c.providerStatus();
  check("未配 key 的 Gemini 标记为 not ready", stc.find((s) => s.name === "gemini").ready === false, JSON.stringify(stc));
}

console.log(`\n${failCount === 0 ? "\x1b[32m" : "\x1b[31m"}结果：${pass} 通过 / ${failCount} 失败\x1b[0m`);
server.closeAllConnections?.();
server.close();
process.exit(failCount === 0 ? 0 : 1);
