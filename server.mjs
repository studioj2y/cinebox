import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3000;
const M = {
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

let interp = null;
try {
  const core = await import("./api/_lib/core.js");
  interp = core.interpret;
} catch (e) {
  console.log("core not loaded:", e.message);
}

const s = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url.split("?")[0] === "/api/interpret") {
    if (!interp) {
      res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "AI off" }));
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    try {
      const b = raw ? JSON.parse(raw) : {};
      const r = await interp(b);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const fp = path.join(root, p);
  if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
    return;
  }
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { "Content-Type": M[ext] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});

s.listen(PORT, HOST, () => console.log("CINEBOX on http://" + HOST + ":" + PORT));
