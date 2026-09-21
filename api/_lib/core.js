// core.js — AI 解读服务端核心（与部署形态无关，Vercel 函数与本地 dev-server 共用）
// 职责：多提供方**分层故障转移** + 多 key 轮转 + 缓存 + 限流。前端不再持有任何 key。
import crypto from "crypto";
import fs from "fs";
import path from "path";

/* ==================== 提供方注册表 ====================
 * 新增提供方只需在此加一项，并在 .env 配对应 key。
 *
 * keys: 候选环境变量名，按顺序取**第一个非空**的。同时接受两种写法——
 *       *_API_KEY（各家官方惯例的单数名，Gemini 即如此）与 *_API_KEYS（逗号分隔多 key 轮转）。
 *       全部未配置时，**仅第一层**可回退到 API_KEYS（适用于聚合网关用一个 key 打通多家）。
 * base: 返回 API 根地址（不含 path）；末尾斜杠自动去掉，避免拼出 //chat/completions。
 */
const stripSlash = (s) => String(s || "").replace(/\/+$/, "");

/* 配置类告警只打一次：线上日志按量计费，且同一错误每次请求都刷会淹没真正的故障。
 * （值与取值来源见下方 PROVIDER_DEFS.gemini.extra 的注释） */
const _warned = new Set();
const warnOnce = (msg) => {
  if (_warned.has(msg)) return;
  _warned.add(msg);
  console.warn("[core] " + msg);
};

// Gemini 兼容层的 reasoning_effort 合法值；none 仅能关闭 2.5 系（非 Pro）的思考。
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "none"]);
// Gemini 原生 thinking_config.thinking_level 合法值（没有 none —— 3.x 关不掉思考）。
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high"]);

const PROVIDER_DEFS = {
  agnes: {
    label: "Agnes",
    base: () => process.env.AGNES_BASE || "https://apihub.agnes-ai.com/v1",
    model: () => process.env.AGNES_MODEL || "agnes-2.5-flash",
    path: "/chat/completions",
    keys: ["AGNES_API_KEYS", "AGNES_API_KEY"],
    auth: (k) => "Bearer " + k,
  },
  gemini: {
    /* Google 官方的 OpenAI 兼容层，可直接复用本文件的请求体/解析逻辑。
     * ⚠️ base 必须带 `/openai` 后缀（少了它 404）；
     * ⚠️ model 必须填 **Gemini 真实模型名**（如 gemini-2.5-flash），填 gpt-* 会 404 model not found；
     * ⚠️ key 用 Google AI Studio（aistudio.google.com）的 API key，走 Bearer；
     *    Vertex AI 的 service account 凭据不适用此端点。 */
    label: "Gemini",
    base: () => process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta/openai",
    model: () => process.env.GEMINI_MODEL || "gemini-2.5-flash",
    path: "/chat/completions",
    keys: ["GEMINI_API_KEYS", "GEMINI_API_KEY"],
    auth: (k) => "Bearer " + k,
    /* —— 压思考（可选）：兼容层有两条路，**官方明确二者互斥**，同时用会 400 ——
     *  ① reasoning_effort —— **本文件采用的默认路径**。
     *       OpenAI 标准字段，作为顶层 JSON 字段发给 /v1beta/openai/chat/completions。
     *       合法值 minimal | low | medium | high；none 只能关 2.5 系（2.5 Pro 与 3.x 关不掉）。
     *       官方映射：minimal → 3.1Pro:low  3.1Flash-Lite:minimal  3Flash:minimal  2.5:1024
     *                 low     → 3.1Pro:low  3.1Flash-Lite:low      3Flash:low      2.5:1024
     *                 medium  → medium / 2.5:8192      high → high / 2.5:24576
     *  ② extra_body.google.thinking_config.{thinking_level, include_thoughts}
     *       Gemini 原生字段，经兼容层透传（Google 官方 REST 示例即此形状）。
     *       thinking_level 与 ① 同构；额外可以用 include_thoughts 让模型回思考摘要，便于排障。
     *
     * ⚠️ 文档里 `types.ThinkingConfig(thinking_level="high")` 属于**原生 google-genai SDK**
     *    （打到 /v1beta/models/{model}:generateContent，鉴权用 x-goog-api-key），
     *    与本文件调用的**兼容层不是同一套参数**，两者的字段名与位置都不同、不能混填。
     *    在本文件（兼容层）里想要 thinking_level 那种写法，就得走上面的 ②。
     *
     * 为什么需要它：Gemini 3.x 是思考模型且**思考无法关闭**，思考 token 与正文共享 max_tokens；
     * 预算被思考吃光 ⇒ content 为空/极短 ⇒ 命中下面的 MIN_LEN 判空。
     * 缺省两条路都不传，用模型默认思考级别（本参数永不发给 Agnes 等其它提供方）。 */
    extra: (def) => {
      const eff = (process.env.GEMINI_REASONING_EFFORT || "").trim().toLowerCase();
      const lvl = (process.env.GEMINI_THINKING_LEVEL || "").trim().toLowerCase();
      const model = def.model();

      if (eff && lvl) {
        warnOnce("GEMINI_REASONING_EFFORT 与 GEMINI_THINKING_LEVEL 互斥（官方规定不能同时用），已只用 GEMINI_REASONING_EFFORT");
      }
      if (eff) {
        if (!REASONING_EFFORTS.has(eff)) {
          warnOnce(`GEMINI_REASONING_EFFORT="${eff}" 不是合法值（可选 ${[...REASONING_EFFORTS].join(" / ")}），已忽略`);
          return {};
        }
        if (eff === "none" && !/^gemini-2\.5-(flash|flash-lite)/.test(model)) {
          warnOnce(`reasoning_effort=none 只能关闭 Gemini 2.5（非 Pro）的思考，当前模型 ${model} 关不掉；已忽略以免被 Google 拒绝`);
          return {};
        }
        return { reasoning_effort: eff };
      }
      if (lvl) {
        if (!THINKING_LEVELS.has(lvl)) {
          warnOnce(`GEMINI_THINKING_LEVEL="${lvl}" 不是合法值（可选 ${[...THINKING_LEVELS].join(" / ")}），已忽略`);
          return {};
        }
        const cfg = { thinking_level: lvl };
        if (/^(1|true|yes)$/.test((process.env.GEMINI_INCLUDE_THOUGHTS || "").trim().toLowerCase())) {
          cfg.include_thoughts = true;
        }
        return { extra_body: { google: { thinking_config: cfg } } };
      }
      return {};
    },
  },
  openai: {
    label: "OpenAI",
    base: () => process.env.OPENAI_BASE || "https://api.openai.com/v1",
    model: () => process.env.OPENAI_MODEL || "gpt-4o-mini",
    path: "/chat/completions",
    keys: ["OPENAI_API_KEYS", "OPENAI_API_KEY"],
    auth: (k) => "Bearer " + k,
  },
  deepseek: {
    label: "DeepSeek",
    base: () => process.env.DEEPSEEK_BASE || "https://api.deepseek.com/v1",
    model: () => process.env.DEEPSEEK_MODEL || "deepseek-chat",
    path: "/chat/completions",
    keys: ["DEEPSEEK_API_KEYS", "DEEPSEEK_API_KEY"],
    auth: (k) => "Bearer " + k,
  },
  moonshot: {
    label: "Moonshot",
    base: () => process.env.MOONSHOT_BASE || "https://api.moonshot.cn/v1",
    model: () => process.env.MOONSHOT_MODEL || "moonshot-v1-8k",
    path: "/chat/completions",
    keys: ["MOONSHOT_API_KEYS", "MOONSHOT_API_KEY"],
    auth: (k) => "Bearer " + k,
  },
};

/* 启用的提供方：env AI_PROVIDERS 逗号分隔，**顺序即优先级**——
 * 靠前的先试，整层失败才降级到下一层。缺省 "agnes,gemini"：
 *   · 两者都配 key → agnes 优先，gemini 兜底；
 *   · 只配其中一个 → 另一个无 key 自动跳过，等于直接用配好的那个；
 *   · 一个都没配 → 报错（见 buildTiers / interpret）。
 * 想加 openai/deepseek/moonshot 做更多兜底层，把它写进 AI_PROVIDERS 并配好 key 即可。 */
const DEFAULT_PROVIDERS = "agnes,gemini";

function enabledProviders() {
  const raw = (process.env.AI_PROVIDERS || DEFAULT_PROVIDERS)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return raw.filter((p) => PROVIDER_DEFS[p]);
}

/* allowGlobalFallback 只给**第一层**（最高优先级）开——它才是"你指向聚合网关的那个提供方"。
 * 为什么不能对所有层开放：那会造出一个**假兜底**。假设只配了 API_KEYS（Agnes 网关的 key），
 * 且 AI_PROVIDERS 是缺省的 agnes,gemini，那么 Gemini 层也会读到同一个 key 而"就绪"，
 * 接着拿 Agnes 的 key 去请求 Google 端点，必然 401。表现是：降级路径看起来存在、
 * providerStatus 也显示 ready，实际从没成功过一次 —— 比直接报"没配 key"更难查。
 * 真要用一个 key 打通多家，把同一个值同时填进各家的 *_API_KEY 即可（显式、无歧义）。 */
function readKeys(def, allowGlobalFallback) {
  for (const name of def.keys || []) {
    const raw = process.env[name];
    if (raw && raw.trim()) {
      const ks = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      if (ks.length) return ks;
    }
  }
  if (!allowGlobalFallback) return [];
  return (process.env.API_KEYS || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/* 构造「层级」：一个提供方 = 一层，层内是它的多个 key。
 * 没配 key 的提供方直接跳过，所以「只配一个就用那个」无需额外判断。 */
function buildTiers() {
  const tiers = [];
  enabledProviders().forEach((name, i) => {
    const def = PROVIDER_DEFS[name];
    const keys = readKeys(def, i === 0);
    if (!keys.length) return;
    tiers.push({ name, def, keys });
  });
  return tiers;
}

/* ---------------- 超时与时间预算 ----------------
 * 四个数字必须**同调**，改一个就要回头看其余三个：
 *   ① AI_TIMEOUT_MS  单提供方最长等待（默认 25s）
 *   ② AI_BUDGET_MS   整个请求的总预算（默认 45s）
 *   ③ vercel.json 的 maxDuration = 60s —— 超过会被平台掐断（504），故 ② < ③
 *   ④ 前端 fetch 超时（js/app.js，70s）必须**大于** ②，否则后端还在降级、前端已 abort
 *
 * 为什么把单家从 15s 放宽到 25s（2026-09-21）：
 *   线上出现「十几秒后失败、再试又成功」的间歇性故障 —— 十几秒正好是原来的 15s 上限。
 *   根因是 **Gemini 3.x 属于思考模型（思考无法关闭）**，同一 prompt 的耗时波动很大，
 *   15s 会在"其实快成功了"的时刻把它掐掉。宁可让失败慢一点，也不要制造假失败。
 * 每次实际请求的超时 = min(单提供方超时, 剩余预算)；剩余不足 MIN_SLOT 就不再开新提供方。 */
const PER_TIMEOUT = Math.max(1000, Number(process.env.AI_TIMEOUT_MS) || 25000);
const BUDGET_MS = Math.max(2000, Number(process.env.AI_BUDGET_MS) || 45000);
const MIN_SLOT = 1200;

// 层内轮转游标：每次请求从下一个 key 开始，使同提供方的多 key 真正分摊流量
const cursors = new Map();
function nextStart(name, len) {
  const s = (cursors.get(name) || 0) % len;
  cursors.set(name, (s + 1) % len);
  return s;
}

const SYSTEM_PROMPT =
  "你是「不良少女放映组」的观影向导，懂电影也懂人心。用温暖、像朋友一样的语气写一段中文解读，可以带一点点不羁、漫不经心的酷劲儿——但别太用力，保持真诚自然。不要使用任何 markdown 格式。";

const MIN_LEN = 18; // 低于此长度视为被截断/异常短

/* 单次调用（一个提供方 + 一个 key）。任何异常都向上抛，由调用方决定降级。 */
async function callOnce(def, apiKey, prompt, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(stripSlash(def.base()) + def.path, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: def.auth(apiKey) },
      body: JSON.stringify({
        model: def.model(),
        temperature: 0.8,
        // 2048 而非 900：这是**上限**不是目标长度，正常回答不会变长；
        // 但思考模型（Gemini 3.x）的思考 token 与正文共享这个额度，900 可能被思考吃光。
        max_tokens: 2048,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        ...(def.extra ? def.extra(def) : {}),
      }),
    });
    if (!resp.ok) throw new Error(`${def.label} HTTP ${resp.status}`);
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error(`${def.label} 返回解析失败（疑似截断）`);
    }
    const ch = (data.choices && data.choices[0]) || {};
    const msg = ch.message || {};
    const t = String(msg.content || "").trim();
    if (t.length < MIN_LEN) {
      /* 别只说「过短」——把可判定的线索带上，否则线上只能看到一句无从下手的报错。
       * 典型：finish_reason=length 且 completion_tokens 已用满 ⇒ 额度被思考/被截断吃光。 */
      const bits = [`${t.length} 字`];
      if (ch.finish_reason) bits.push(`finish_reason=${ch.finish_reason}`);
      if (data.usage && data.usage.completion_tokens != null) bits.push(`completion_tokens=${data.usage.completion_tokens}`);
      if (msg.reasoning_content) bits.push("返回了 reasoning_content（思考内容与正文分开，疑似思考占满额度）");
      throw new Error(`${def.label} 返回过短或为空（${bits.join("，")}）`);
    }
    return t;
  } catch (e) {
    if (e && e.name === "AbortError") {
      const secs = (timeoutMs / 1000).toFixed(1).replace(/\.0$/, "");
      throw new Error(`${def.label} 超时（${secs}s 无响应）`);
    }
    throw e;
  } finally {
    clearTimeout(to);
  }
}

/* ---------------- 缓存（与提供方无关） ----------------
 * 优先 Vercel KV（跨实例共享）；未配置 KV 时自动降级为内存 Map（实例内热，重启清空）。
 * 启用 KV：在 Vercel 创建 KV store 并 Link 本项目即可。 */
let kv = null;
let kvTried = false;
async function getKV() {
  if (kvTried) return kv;
  kvTried = true;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    const mod = await import("@vercel/kv");
    kv = mod.kv; // @vercel/kv 自动读取注入的环境变量
    return kv;
  } catch (e) {
    return null; // 本地未安装 @vercel/kv → 降级内存
  }
}

const memCache = new Map();
const CACHE_MAX = 1000;
function cacheKey(movieId, answers) {
  const sig = crypto.createHash("md5").update(JSON.stringify(answers || [])).digest("hex");
  return `mk:${movieId}:${sig}`;
}
async function cacheGet(key) {
  const k = await getKV();
  if (k) {
    try {
      const v = await k.get(key);
      return v || null;
    } catch (e) { /* 忽略，降级 */ }
  }
  return memCache.has(key) ? memCache.get(key) : null;
}
async function cacheSet(key, val) {
  const k = await getKV();
  if (k) {
    try { await k.set(key, val, { ex: 86400 }); return; } catch (e) { /* 降级 */ }
  }
  if (memCache.size >= CACHE_MAX) memCache.delete(memCache.keys().next().value);
  memCache.set(key, val);
}

/* ---------------- 限流 ----------------
 * /api/interpret 是公开端点，早期版本无任何防护：任何人循环 curl 即可消耗 API 额度，
 * 且缓存 key = md5(movieId+answers)，改一个答案就能绕过缓存。故在此加按 IP 的双窗口限流。
 * 存储优先 Vercel KV（跨实例共享，真正能挡住分布式刷量）；未配置 KV 时降级为内存计数。
 * 额度宽松度按真实使用设定：正常用户一次会话最多点几次「不良有话说」。 */
const RATE_LIMITS = [
  { name: "min", window: 60, limit: 10 },        // 10 次 / 分钟
  { name: "day", window: 86400, limit: 50 },     // 50 次 / 天
];
const memHits = new Map(); // key -> { n, exp }
function memIncr(key, ttl) {
  const now = Date.now();
  const rec = memHits.get(key);
  if (!rec || rec.exp <= now) {
    memHits.set(key, { n: 1, exp: now + ttl * 1000 });
  } else {
    rec.n += 1;
  }
  // 防止 Map 无限增长（IP 是有限枚举，但清理成本很低）
  if (memHits.size > 5000) {
    for (const [k, v] of memHits) if (v.exp <= now) memHits.delete(k);
  }
  return memHits.get(key).n;
}
export async function rateCheck(ip) {
  const stamp = Date.now();
  for (const rl of RATE_LIMITS) {
    const bucket = Math.floor(stamp / 1000 / rl.window);
    const key = `rl:${ip}:${rl.name}:${bucket}`;
    let n;
    const k = await getKV();
    if (k) {
      try {
        n = await k.incr(key);
        if (n === 1) await k.expire(key, rl.window);
      } catch (e) {
        n = memIncr(key, rl.window); // KV 抖动 → 降级内存，不因此放行
      }
    } else {
      n = memIncr(key, rl.window);
    }
    if (n > rl.limit) {
      const retryAfter = rl.name === "min" ? 60 : 3600;
      return { ok: false, scope: rl.name, retryAfter, limit: rl.limit };
    }
  }
  return { ok: true };
}

/* ---------------- 片库白名单 ----------------
 * 校验 movieId 确实在片库内，避免用不存在的 id 制造无限种缓存 key 绕过限流/缓存。
 * 读文件失败（如 Vercel 打包未含 data/）时返回 null → 跳过校验，绝不因此让请求 500。 */
let _movieIds = undefined;
export function movieIdSet() {
  if (_movieIds !== undefined) return _movieIds;
  try {
    const p = path.join(process.cwd(), "data", "movies.js");
    const w = {};
    new Function("window", fs.readFileSync(p, "utf8"))(w);
    _movieIds = new Set((w.MOVIES || []).map((m) => String(m.id)));
  } catch (e) {
    _movieIds = null; // 读不到就放弃校验，可用性优先
  }
  return _movieIds;
}

/* 供调试/自检：当前生效的提供方与优先级（**不暴露 key**） */
export function providerStatus() {
  return enabledProviders().map((name, i) => {
    const def = PROVIDER_DEFS[name];
    const keys = readKeys(def, i === 0);
    return { name, label: def.label, model: def.model(), keys: keys.length, ready: keys.length > 0 };
  });
}

/* ==================== 主流程 ====================
 * 分层故障转移：按 AI_PROVIDERS 顺序逐层尝试，层内多 key 轮转。
 * 任一次调用成功即返回；某层全败才降级到下一层；所有层都失败则抛出汇总错误。
 * 返回值保留 provider（实际生效的提供方）与 fallback（是否由降级得来），便于排查与统计。 */
export async function interpret({ movieId, title, answers, prompt }) {
  if (!prompt) throw new Error("缺少 prompt");

  const key = cacheKey(movieId, answers);
  const cached = await cacheGet(key);
  if (cached) return { text: cached, cached: true };

  const tiers = buildTiers();
  if (!tiers.length) {
    throw new Error("未配置任何 AI key（请设置 AGNES_API_KEYS 或 GEMINI_API_KEY）");
  }

  const t0 = Date.now();
  const failures = []; // 已宣告失败的提供方，用于汇总错误 + 判断是否发生降级

  for (const tier of tiers) {
    const start = nextStart(tier.name, tier.keys.length);
    let tierErr = "";

    for (let i = 0; i < tier.keys.length; i++) {
      // 每次调用前重算剩余预算，确保 agnes 慢时不会把 gemini 的时间用光
      const left = Math.min(PER_TIMEOUT, BUDGET_MS - (Date.now() - t0));
      if (left < MIN_SLOT) {
        tierErr = tierErr || "剩余时间预算不足";
        break;
      }
      const apiKey = tier.keys[(start + i) % tier.keys.length];
      try {
        let t = await callOnce(tier.def, apiKey, prompt, left);
        // 兜底：结尾必带「今晚就它了。」
        if (!/今晚就它了[。\.！!]?$/.test(t.replace(/\s+$/, ""))) {
          t = t.replace(/\s+$/, "") + "\n\n今晚就它了。";
        }
        await cacheSet(key, t);
        const fallback = failures.length > 0;
        if (fallback) {
          console.warn(`[interpret] 降级到 ${tier.def.label} 成功；前序失败：${failures.join("；")}`);
        }
        return { text: t, cached: false, provider: tier.name, fallback };
      } catch (e) {
        tierErr = e.message; // 层内换下一个 key 继续试
      }
    }

    // callOnce 抛出的消息已带提供方名（如「Agnes HTTP 500」），此处统一成「Agnes: HTTP 500」，避免重复
    const detail = tierErr.startsWith(tier.def.label)
      ? tierErr.slice(tier.def.label.length).replace(/^[：:\s]+/, "")
      : tierErr;
    failures.push(`${tier.def.label}: ${detail || "全部 key 失败"}`);
  }

  throw new Error("AI 服务暂不可用（" + failures.join("；") + "）");
}
