// Vercel Serverless Function: POST /api/interpret
// 前端只发 prompt + 电影/答案信息，key 与轮转逻辑全在服务端。
import { interpret } from "./_lib/core.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }
  try {
    // Vercel Node 函数 body 可能是 string/buffer，统一读流解析
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const { movieId, title, answers, prompt } = body;
    const result = await interpret({ movieId, title, answers, prompt });
    res.status(200).json(result);
  } catch (e) {
    res.status(502).json({ error: e.message || "interpret failed" });
  }
}
