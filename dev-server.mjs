// 本地开发服务器：同时托管静态站点与 /api/interpret（复用服务端核心）
// 用法：node dev-server.mjs  然后访问 http://localhost:3000
// 生产请用 Vercel（api/ 会被当作 Serverless Function 自动接管）。
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { interpret } from "./api/_lib/core.js";

const root = path.dirname(fileURLToPath(import.meta.url));
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

const server = http.createServer(async (req, res) => {
  // ---- API ----
  if (req.method === "POST" && req.url.split("?")[0] === "/api/interpret") {
    let raw = "";
    for await (const c of req) raw += c;
    try {
      const body = raw ? JSON.parse(raw) : {};
      const r = await interpret(body);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
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
