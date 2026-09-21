// 本地开发服务器：同时托管静态站点与 /api/interpret（复用服务端核心）
// 用法：node dev-server.mjs  然后访问 http://localhost:3000
// 生产请用 Vercel（api/ 会被当作 Serverless Function 自动接管）。
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));

/* 先把 .env 灌进 process.env，**再** import 业务 handler —— 顺序不能反。
 * core.js 在模块顶层就把 AI_TIMEOUT_MS / AI_BUDGET_MS 固化成常量，
 * 若 handler 被静态 import 提前求值，.env 里的超时/预算就永远不生效
 * （各提供方的 key 是调用时读的，不受影响，但两处行为不一致同样难查）。
 * Node 20.12+ 内置 process.loadEnvFile，不需要 dotenv（本机也没有 node_modules）。 */
try {
  process.loadEnvFile(path.join(root, ".env"));
  console.log("[env] 已加载 .env");
} catch (e) {
  console.log("[env] 未找到 .env —— 仅用当前环境变量（可复制 .env.example 为 .env 填入 AI key）");
}
const { default: interpretHandler } = await import("./api/interpret.js");

const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/* Vercel 的 Node runtime 会在 res 上挂 status()/json() 两个便捷方法，
 * 原生 http.ServerResponse 没有。这里补上，从而**直接复用 api/interpret.js 的 handler**
 * ——早期版本本地另写一份只调 core.interpret() 的逻辑，导致限流/输入校验在本地完全不生效，
 * 本地测不出来、线上才暴露，属于典型的"本地与生产不一致"。 */
function asVercelRes(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  // ---- API：与 Vercel 生产走同一个 handler（含限流与输入校验）----
  if (req.url.split("?")[0] === "/api/interpret") {
    await interpretHandler(req, asVercelRes(res));
    return;
  }

  // ---- 静态文件 ----
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const fp = path.join(root, p);
  if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});

server.listen(PORT, () => {
  console.log("dev server running: http://localhost:" + PORT);
});
