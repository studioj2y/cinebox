// core.js — AI 解读服务端核心（与部署形态无关，Vercel 函数与本地 dev-server 共用）
// 职责：多 key 轮转 + 多提供方故障转移 + 内存缓存。前端不再持有任何 key。
import crypto from "crypto";

// 提供方注册表：新增提供方只需在此加一项，并在 .env 配对应的 *_API_KEYS 即可
const PROVIDER_DEFS = {
  agnes: {
    label: "Agnes",
    base: () => process.env.AGNES_BASE || "https://apihub.agnes-ai.com/v1",
    model: () => process.env.AGNES_MODEL || "agnes-2.5-flash",
    path: "/chat/completions",
    auth: (k) => "Bearer " + k,
  },
  openai: {
    label: "OpenAI",
    base: () => process.env.OPENAI_BASE || "https://api.openai.com/v1",
    model: () => process.env.OPENAI_MODEL || "gpt-4o-mini",
    path: "/chat/completions",
    auth: (k) => "Bearer " + k,
  },
  deepseek: {
    label: "DeepSeek",
    base: () => process.env.DEEPSEEK_BASE || "https://api.deepseek.com/v1",
    model: () => process.env.DEEPSEEK_MODEL || "deepseek-chat",
    path: "/chat/completions",
    auth: (k) => "Bearer " + k,
  },
  moonshot: {
    label: "Moonshot",
    base: () => process.env.MOONSHOT_BASE || "https://api.moonshot.cn/v1",
    model: () => process.env.MOONSHOT_MODEL || "moonshot-v1-8k",
    path: "/chat/completions",
    auth: (k) => "Bearer " + k,
  },
};

// 启用的提供方：env AI_PROVIDERS 逗号分隔；缺省仅 agnes
function enabledProviders() {
  const raw = (process.env.AI_PROVIDERS || "agnes")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return raw.filter((p) => PROVIDER_DEFS[p]);
}

// 构造「端点」列表：每个提供方 × 其多个 key，作为轮转/故障转移的基本单元
function buildEndpoints() {
  const endpoints = [];
  for (const name of enabledProviders()) {
    const def = PROVIDER_DEFS[name];
    const envKey = name === "agnes" ? "AGNES_API_KEYS" : name.toUpperCase() + "_API_KEYS";
    const keysRaw = process.env[envKey] || process.env.API_KEYS || "";
    const keys = keysRaw.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean);
    for (const key of keys) endpoints.push({ name, def, key });
  }
  return endpoints;
}

// 负载均衡游标：每次请求从下一个 key 开始，使多 key 真正分摊流量
let cursor = 0;

// 简单内存缓存（按 电影 + 答案签名）。Serverless 实例内热，重启即清空。
// 持久化（跨实例共享）请接 Vercel KV / Upstash，这里先保证结构正确。
const cache = new Map();
const CACHE_MAX = 1000;
function cacheKey(movieId, answers) {
  const sig = crypto.createHash("md5").update(JSON.stringify(answers || [])).digest("hex");
  return `mk:${movieId}:${sig}`;
}

const SYSTEM_PROMPT =
  "你是「不良少女放映组」的观影向导，懂电影也懂人心。用温暖、像朋友一样的语气写一段中文解读，可以带一点点不羁、漫不经心的酷劲儿——但别太用力，保持真诚自然。不要使用任何 markdown 格式。";

const MIN_LEN = 18; // 低于此长度视为被截断/异常短

export async function interpret({ movieId, title, answers, prompt }) {
  if (!prompt) throw new Error("缺少 prompt");

  const key = cacheKey(movieId, answers);
  if (cache.has(key)) return { text: cache.get(key), cached: true };

  const endpoints = buildEndpoints();
  if (!endpoints.length)
    throw new Error("未配置任何 API key（请设置 AGNES_API_KEYS 等环境变量）");

  // 轮转起点：每来一个请求就推进游标，分摊到不同 key
  const start = cursor % endpoints.length;
  cursor = (cursor + 1) % endpoints.length;

  let lastErr = "";
  // 从轮转起点开始，依次尝试各端点（多 key / 多提供方），任一成功即返回
  for (let i = 0; i < endpoints.length; i++) {
    const { name, def, key: apiKey } = endpoints[(start + i) % endpoints.length];
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000); // 30s 超时
      const resp = await fetch(def.base() + def.path, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: def.auth(apiKey) },
        body: JSON.stringify({
          model: def.model(),
          temperature: 0.8,
          max_tokens: 900,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        }),
      });
      clearTimeout(to);
      if (!resp.ok) throw new Error(`${def.label} HTTP ${resp.status}`);
      let data;
      try {
        data = await resp.json();
      } catch (e) {
        throw new Error(`${def.label} 返回解析失败（疑似截断）`);
      }
      let t = ((data.choices && data.choices[0] && data.choices[0].message.content) || "").trim();
      if (t.length < MIN_LEN) throw new Error(`${def.label} 返回过短（疑似截断）`);
      // 兜底：结尾必带「今晚就它了。」
      if (!/今晚就它了[。\.！!]?$/.test(t.replace(/\s+$/, ""))) {
        t = t.replace(/\s+$/, "") + "\n\n今晚就它了。";
      }
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, t);
      return { text: t, cached: false, provider: name };
    } catch (e) {
      lastErr = e.message;
      continue; // 故障转移：尝试下一个 key / 提供方
    }
  }
  throw new Error("所有 key/提供方均失败：" + lastErr);
}
