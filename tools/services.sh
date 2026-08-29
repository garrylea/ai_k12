#!/usr/bin/env bash
#
# K12 智学系统 - 服务管理脚本（部署完成后日常使用）
#
# 前提：已通过 tools/deploy.sh 完成部署（依赖 apps/server/dist、apps/web/dist、
# apps/server/.env、MySQL 已初始化）。本脚本不构建、不安装，只管进程生命周期。
#
# 用法：
#   bash tools/services.sh start      # 启动 server + web（已在运行则跳过）
#   bash tools/services.sh stop       # 停止 server + web（未运行则跳过）
#   bash tools/services.sh restart    # 重启
#   bash tools/services.sh status     # 查看运行状态与健康检查
#   bash tools/services.sh log server # 跟踪 server 日志（log web 同理）
#
# PID/日志与 deploy.sh 共用 tools/deploy/runtime/，由 deploy.sh 启动的服务
# 也可用本脚本停止/重启。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$ROOT/apps/server"
WEB_DIR="$ROOT/apps/web"
ENV_FILE="$SERVER_DIR/.env"
RUNTIME_DIR="$SCRIPT_DIR/deploy/runtime"
SERVER_LOG="$RUNTIME_DIR/server.log"
WEB_LOG="$RUNTIME_DIR/web.log"
SERVER_PID_FILE="$RUNTIME_DIR/server.pid"
WEB_PID_FILE="$RUNTIME_DIR/web.pid"

log() { printf '[services] %s\n' "$*"; }
die() { printf '[services] [ERROR] %s\n' "$*" >&2; exit 1; }

# 从 .env 读 PORT（与 main.ts 默认一致）
server_port() {
  if [ -f "$ENV_FILE" ]; then
    local v
    v="$(grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
    [ -n "$v" ] && { echo "$v"; return; }
  fi
  echo 3001
}
SERVER_PORT="$(server_port)"
WEB_PORT="${WEB_PORT:-5173}"

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"
  else
    return 1
  fi
}

port_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n' | head -1
  fi
}

# pid 存活且 PID 文件与端口一致才算"我们在跑"；只占端口但无 PID 文件的进程
# （如手动 npx 起的服务）按"被外部进程占用"处理。
svc_running() { # $1=pid文件 $2=端口
  [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null
}

pid_of() { # $1=pid文件 $2=端口 $3=名称
  if [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; then
    cat "$1"
  elif port_in_use "$2"; then
    port_pid "$2"
  fi
}

start_one() { # $1=名称 $2=pid文件 $3=日志 $4=端口 $5=启动命令(在各自目录执行)
  local name="$1" pidfile="$2" logfile="$3" port="$4" cmd="$5" workdir="$6"
  if svc_running "$pidfile"; then
    log "${name} 已在运行 (pid $(cat "$pidfile"))，跳过"
    return 0
  fi
  if port_in_use "$port"; then
    local pid
    pid="$(port_pid "$port")"
    die "端口 ${port}（${name}）被其他进程占用: PID=${pid:-?} $(ps -p "${pid:-0}" -o command= 2>/dev/null | cut -c1-80)。请先停止它或重跑 deploy.sh。"
  fi
  ( cd "$workdir" && eval "$cmd" )
  sleep 1
  if ! svc_running "$pidfile"; then
    log "⚠ ${name} 启动后进程可能未存活，请查看日志: $logfile"
  else
    log "${name} 已启动 (pid $(cat "$pidfile"))，日志: $logfile"
  fi
}

start_server() {
  [ -f "$SERVER_DIR/dist/main.js" ] || die "未找到 apps/server/dist/main.js，请先运行 bash tools/deploy.sh 完成部署/构建"
  # 物化图片目录：server 按存在性挂载 /assets（见 deploy.sh 同款处理）
  mkdir -p "$ROOT/tools/data-refinery/output/assets"
  mkdir -p "$RUNTIME_DIR"
  start_one 'server' "$SERVER_PID_FILE" "$SERVER_LOG" "$SERVER_PORT" \
    "nohup node dist/main.js >> '$SERVER_LOG' 2>&1 & echo \$! > '$SERVER_PID_FILE'" \
    "$SERVER_DIR"
}

start_web() {
  [ -f "$WEB_DIR/dist/index.html" ] || die "未找到 apps/web/dist 构建产物，请先运行 bash tools/deploy.sh 完成部署/构建"
  start_one 'web' "$WEB_PID_FILE" "$WEB_LOG" "$WEB_PORT" \
    "K12_API_PROXY='http://localhost:${SERVER_PORT}' nohup npx vite preview --host 0.0.0.0 --port '$WEB_PORT' >> '$WEB_LOG' 2>&1 & echo \$! > '$WEB_PID_FILE'" \
    "$WEB_DIR"
}

stop_one() { # $1=名称 $2=pid文件 $3=端口
  local name="$1" pidfile="$2" port="$3" pid
  pid="$(pid_of "$pidfile" "$port" "$name")"
  if [ -z "${pid:-}" ]; then
    log "${name} 未在运行"
    rm -f "$pidfile"
    return 0
  fi
  log "停止 ${name} (pid ${pid})..."
  kill "$pid" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "${name} 未响应 TERM，强制 kill -9"
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$pidfile"
  if port_in_use "$port"; then
    log "⚠ 端口 ${port} 仍被占用，可能被其他进程持有"
  else
    log "${name} 已停止"
  fi
}

wait_healthy() { # $1=URL $2=名称 $3=超时秒
  local url="$1" name="$2" timeout="${3:-30}" i code
  for ((i = 0; i < timeout; i += 2)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)"
    [ "$code" = '200' ] && return 0
    sleep 2
  done
  return 1
}

cmd_start() {
  start_server
  start_web
  log '健康检查...'
  if wait_healthy "http://localhost:${SERVER_PORT}/api/content/subjects" 'server' 30; then
    echo '  ✓ server 就绪 (/api/content/subjects)'
  else
    echo "  ✗ server 健康检查超时，请查看: $SERVER_LOG" >&2
  fi
  if wait_healthy "http://localhost:${WEB_PORT}/" 'web' 15; then
    echo '  ✓ web 就绪 (/)'
  else
    echo "  ✗ web 健康检查超时，请查看: $WEB_LOG" >&2
  fi
  echo
  echo "  Web:    http://localhost:${WEB_PORT}"
  echo "  Server: http://localhost:${SERVER_PORT}"
}

cmd_stop() {
  stop_one 'web' "$WEB_PID_FILE" "$WEB_PORT"
  stop_one 'server' "$SERVER_PID_FILE" "$SERVER_PORT"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  local spid wpid
  spid="$(pid_of "$SERVER_PID_FILE" "$SERVER_PORT" server || true)"
  wpid="$(pid_of "$WEB_PID_FILE" "$WEB_PORT" web || true)"
  if [ -n "${spid:-}" ]; then
    echo "server: 运行中 (pid ${spid})，http://localhost:${SERVER_PORT}"
  else
    echo "server: 未运行（端口 ${SERVER_PORT} 空闲）"
  fi
  if [ -n "${wpid:-}" ]; then
    echo "web:    运行中 (pid ${wpid})，http://localhost:${WEB_PORT}"
  else
    echo "web:    未运行（端口 ${WEB_PORT} 空闲）"
  fi
  echo "日志:   $SERVER_LOG / $WEB_LOG"
}

cmd_log() { # $1=server|web
  local target="${1:-}"
  case "$target" in
    server) tail -f "$SERVER_LOG" ;;
    web)    tail -f "$WEB_LOG" ;;
    *) die "用法: bash tools/services.sh log server|web" ;;
  esac
}

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  log)     cmd_log "${2:-}" ;;
  -h|--help|'') usage ;;
  *) usage; die "未知命令: $1" ;;
esac
