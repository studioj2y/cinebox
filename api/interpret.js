// Vercel Serverless Function: POST /api/interpret
// 前端只发 prompt + 电影/答案信息，key 与轮转逻辑全在服务端。
//
// ⚠️ 安全基线（2026-09-08 补）：本端点完全公开，早期版本无防护，
// 任何人循环调用即可耗尽 API 额度，且缓存 key = md5(movieId+answers)
// 改一个答案就能绕过缓存。现在按顺序做四层校验：
//   ① 按 IP 双窗口限流（10 次/分钟、50 次/天）
//   ② body 大小上限（防止超大 payload 打爆函数内存）
//   ③ prompt 长度上限（防止拿本服务的 key 去跑任意长 prompt）
//   ④ movieId 必须在片库内（防止伪造 id 制造无限种缓存 key）
import { interpret, rateCheck, movieIdSet } from "./_lib/core.js";

const MAX_BODY = 64 * 1024;   // 64 KB
const MAX_PROMPT = 2000;      // 字符数，正常提示词约 600~900

function clientIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  const xr = req.headers["x-real-ip"];
  if (typeof xr === "string" && xr.length) return xr.trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  // ① 限流：在读 body 之前就挡掉，省得为恶意流量解析 JSON
  const ip = clientIP(req);
  const rl = await rateCheck(ip);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({
      error: rl.scope === "min" ? "请求太频繁了，歇一分钟再来。" : "今天的解读额度用完了，明天再来吧。",
    });
    return;
  }

  try {
    // ② body 大小上限：边读边判，超限立即断开
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        res.status(413).json({ error: "请求体过大" });
        return;
      }
    }
    const body = raw ? JSON.parse(raw) : {};
    const { movieId, title, answers, prompt } = body;

    // ③ prompt 长度上限
    if (typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "缺少 prompt" });
      return;
    }
    if (prompt.length > MAX_PROMPT) {
      res.status(400).json({ error: "prompt 过长" });
      return;
    }

    // ④ movieId 必须在片库内（读不到片库时跳过校验，可用性优先）
    const ids = movieIdSet();
    if (ids && movieId != null && !ids.has(String(movieId))) {
      res.status(400).json({ error: "未知的影片 id" });
      return;
    }

    const result = await interpret({ movieId, title, answers, prompt });
    res.status(200).json(result);
  } catch (e) {
    res.status(502).json({ error: e.message || "interpret failed" });
  }
}
