#!/bin/bash
# CINEBOX 生产启动脚本（腾讯云轻量应用服务器 Lighthouse）
# 用法：
#   bash start.sh            # 以后台方式启动（默认 3000 端口）
#   PORT=8080 bash start.sh  # 指定端口
# 停止： pkill -f "node server.mjs"
set -e
cd "$(dirname "$0")"

# 若存在 .env，载入环境变量（AGNES_API_KEYS 等）
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
  echo "已载入 .env"
fi

export PORT="${PORT:-3000}"
export HOST="${HOST:-0.0.0.0}"

echo "启动 CINEBOX，监听 ${HOST}:${PORT}"
nohup node server.mjs > cinebox.log 2>&1 &
echo "已启动，PID=$!（日志见 cinebox.log）"
sleep 1
curl -s -o /dev/null -w "本地自检 HTTP %{http_code}\n" "http://127.0.0.1:${PORT}/" || echo "自检失败，请查看 cinebox.log"
