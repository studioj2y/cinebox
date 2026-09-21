#!/usr/bin/env node
/* CINEBOX Gemini 真实端点探针
 * ---------------------------------------------------------------------------
 * 与 scripts/check-ai.mjs 的分工：
 *   · check-ai.mjs  —— 本地 mock，验**降级逻辑**，零外网零额度；
 *   · 本脚本        —— 打**真实 Google 端点**，验“配了却出不来结果”的**根因**。
 *
 * 它会依次做完这 6 件事，并把 HTTP 状态与原样响应打出来：
 *   ① 列出该 key 在 OpenAI 兼容层上**可用**的模型 ID  → 直接回答“模型名对不对”
 *   ② 完全复刻 core.js 的请求体                        → 直接回答“应用这一发能不能成”
 *   ③ 排除 max_tokens 干扰（去掉 / 放大 / 换成 max_completion_tokens）
 *   ④ 排除 thinking 吃光 token：看 finish_reason 与 usage
 *   ⑤ reasoning_effort（OpenAI 标准字段）是否被接受   → core.js 默认压思考走这条
 *   ⑥ extra_body.google.thinking_config（Gemini 原生字段）能否被透传 —— 与 ⑤ 互斥
 *
 * 用法（在项目根目录）：
 *   GEMINI_API_KEY=AIza... node scripts/probe-gemini.mjs
 *   node scripts/probe-gemini.mjs --model gemini-3.1-flash-lite     # 读 .env
 *   node scripts/probe-gemini.mjs --model gemini-3.1-flash-lite --key AIza...
 *
 * ⚠️ 会消耗极少量额度（每步输出都很短），仅用于排障。
 */
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 与 dev-server.mjs 相同的 .env 加载方式（Node 20.12+ 内置）
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
  console.log("[env] 已加载项目根 .env");
} catch (e) {
  console.log("[env] 未找到 .env，使用系统环境变量");
}

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const KEY = argOf("--key", process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || "");
const MODEL = argOf("--model", process.env.GEMINI_MODEL || "gemini-2.5-flash");
const BASE = (process.env.GEMINI_BASE ||
  "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, "");

if (!KEY) {
  console.error("\n✗ 没有拿到 key。请设 GEMINI_API_KEY，或用 --key 传入。\n");
  process.exit(2);
}

const mask = (k) => k.slice(0, 6) + "…" + k.slice(-4) + `（长 ${k.length}）`;
console.log(`\nendpoint : ${BASE}`);
console.log(`model    : ${MODEL}`);
console.log(`key      : ${mask(KEY)}`);
console.log("（仅显示前后几位，避免 key 进日志/截图）\n");

const sys = "你是「不良少女放映组」的主理人，替人挑片很多年。说话短、准、不哄人。不要使用任何 markdown 格式。";
const user = "请用一句话（30 字以内）说说今晚适合看什么类型的电影。";

async function call(label, body, { timeoutMs = 45000, method = "POST", url = BASE + "/chat/completions" } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await resp.text();
    const ms = Date.now() - t0;
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { /* 非 JSON */ }

    const content = j?.choices?.[0]?.message?.content ?? null;
    const reasoning = j?.choices?.[0]?.message?.reasoning_content ?? null;
    const finish = j?.choices?.[0]?.finish_reason ?? null;
    const usage = j?.usage ?? null;

    console.log(`── ${label}`);
    console.log(`   HTTP ${resp.status}  ${ms}ms`);
    if (resp.ok) {
      console.log(`   finish_reason = ${finish}`);
      console.log(`   content 长度  = ${content == null ? "null" : String(content).trim().length}`);
      if (reasoning) console.log(`   ⚠️ 还返回了 reasoning_content（长 ${String(reasoning).length}）—— 说明思考内容与正文分开放`);
      if (usage) console.log(`   usage = ${JSON.stringify(usage)}`);
      if (content) console.log(`   正文 = ${String(content).trim().slice(0, 80)}`);
    } else {
      console.log(`   ✗ 失败响应：${raw.slice(0, 400)}`);
    }
    console.log("");
    return { status: resp.status, ok: resp.ok, content, finish, usage, raw };
  } catch (e) {
    console.log(`── ${label}`);
    console.log(`   ✗ ${e.name === "AbortError" ? "超时（" + timeoutMs + "ms 无响应）" : e.message}\n`);
    return { status: 0, ok: false, error: e.message };
  } finally {
    clearTimeout(to);
  }
}

console.log("① 该 key 在 OpenAI 兼容层上可用的模型 ID");
const list = await call("GET /models", null, { method: "GET", url: BASE + "/models", timeoutMs: 20000 });
if (list.raw) {
  try {
    const ids = (JSON.parse(list.raw).data || []).map((m) => m.id);
    if (ids.length) {
      console.log(`   共 ${ids.length} 个，其中含 gemini-3* 的：`);
      const g3 = ids.filter((i) => /gemini-3/.test(i));
      console.log("   " + (g3.length ? g3.join(", ") : "（没有 gemini-3 系列）"));
      console.log(`   你要用的「${MODEL}」${ids.includes(MODEL) ? "✅ 在列表内" : "❌ 不在列表内 —— 名字可能拼错或该模型未在兼容层开放"}`);
      console.log("");
    }
  } catch (e) { /* 已在 call 里打印 */ }
}

console.log("② 复刻 core.js 的请求体（temperature 0.8 + max_tokens 2048）");
await call("应用当前形态", {
  model: MODEL,
  temperature: 0.8,
  max_tokens: 2048,
  messages: [{ role: "system", content: sys }, { role: "user", content: user }],
});

console.log("③ 排查 max_tokens 相关干扰");
await call("去掉 max_tokens", {
  model: MODEL,
  temperature: 0.8,
  messages: [{ role: "system", content: sys }, { role: "user", content: user }],
});
await call("max_tokens 放大到 4096", {
  model: MODEL,
  temperature: 0.8,
  max_tokens: 4096,
  messages: [{ role: "system", content: sys }, { role: "user", content: user }],
});
await call("用 max_completion_tokens 代替", {
  model: MODEL,
  temperature: 0.8,
  max_completion_tokens: 900,
  messages: [{ role: "system", content: sys }, { role: "user", content: user }],
});

/* ⑤⑥ 兼容层压思考的**两条互斥路径**，分别打一次，用来确认哪条在你这台 key 上被接受：
 *   ① reasoning_effort                     —— OpenAI 标准字段（core.js 默认走这条）
 *   ② extra_body.google.thinking_config    —— Gemini 原生字段（文档里 thinking_level 那套经兼容层透传）
 * 官方明确二者不能同时用。若 ② 报 400，说明该兼容层不吃 extra_body 形状 ⇒ 用 ① 即可。
 * ⚠️ 文档里 types.ThinkingConfig(thinking_level=...) 是**原生 SDK**（另一个端点）的写法，此处不适用。 */
console.log("⑤ reasoning_effort 路径（OpenAI 标准字段）");
await call("reasoning_effort=low + max_tokens 2048", {
  model: MODEL,
  temperature: 0.8,
  max_tokens: 2048,
  reasoning_effort: "low",
  messages: [{ role: "system", content: sys }, { role: "user", content: user }],
});

console.log("⑥ thinking_config 路径（Gemini 原生字段，经兼容层透传）");
await call("extra_body.google.thinking_config.thinking_level=low", {
  model: MODEL,
  temperature: 0.8,
  max_tokens: 2048,
  extra_body: { google: { thinking_config: { thinking_level: "low", include_thoughts: true } } },
  messages: [{ role: "system", content: sys }, { role: "user", content: user }],
});

console.log("—— 怎么读这份结果 ——");
console.log("· ① 报 401/403  → key 本身无效或没启用（去 AI Studio 确认，注意不是 Vertex 的凭据）");
console.log("· ① 模型不在列表内 → GEMINI_MODEL 填的模型该兼容层不提供，换一个列表里的名字");
console.log("· ② 失败而 ③ 某一步成功 → 就是那个参数的问题，按成功的那组改 core.js");
console.log("· ② 成功但 content 长度为 0/null → 思考内容吃光了 max_tokens（③ 的 4096 那步应能救回）");
console.log("· ⑤ 与 ⑥ 都成功 → 该端点两条压思考路径都可用，core.js 里任选一条（默认就是 ⑤）");
console.log("· ⑥ 报 400 而 ⑤ 成功 → 该兼容层不接受 extra_body 形状，用 GEMINI_REASONING_EFFORT 即可");
