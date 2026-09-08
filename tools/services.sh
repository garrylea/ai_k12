#!/usr/bin/env bash
#
# K12 智学系统 - 服务管理脚本（部署完成后日常使用）
#
# 前提：已通过 tools/deploy.sh 完成部署（依赖 apps/server/dist、apps/web/dist、
# apps/server/.env、MySQL 已初始化）。本脚本不安装依赖（依赖变更请重跑 deploy.sh）。
#
# start/restart 默认先重新构建（server tsc + 补拷 ai-core yaml/prompts、
# web tsc+vite build）再启服务——改完代码 restart 即生效，不会跑旧 dist。
# 构建失败则中止（restart 时服务保持运行中的旧进程不动）。
# 纯重启不想等构建（如只改了 .env）：--no-build 或环境变量 SERVICES_NO_BUILD=1。
#
# 用法：
#   bash tools/services.sh start      # 构建 + 启动 server + web（已在运行则跳过）
#   bash tools/services.sh stop       # 停止 server + web（未运行则跳过）
#   bash tools/services.sh restart    # 构建 + 重启（构建失败不动运行中的服务）
#   bash tools/services.sh build      # 只构建不启动
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
  # 用 node 直跑 vite（不经 npx/npm exec 包装），使 $! 记录的 PID 就是真正提供服务的进程：
  # 若记录包装进程（npm exec）的 PID，stop 只会杀掉包装层，真正的 vite 子进程可能成孤儿
  # 继续占着端口，后续 start 误报"端口被其他进程占用"，而页面仍由旧进程在服务。
  start_one 'web' "$WEB_PID_FILE" "$WEB_LOG" "$WEB_PORT" \
    "K12_API_PROXY='http://localhost:${SERVER_PORT}' nohup node node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port '$WEB_PORT' >> '$WEB_LOG' 2>&1 & echo \$! > '$WEB_PID_FILE'" \
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
    # PID 记录为包装进程（旧版 npx 启动方式）时，子进程可能未随包装退出而成孤儿占端口；
    # 该端口由本脚本管理，兜底强制结束端口持有者。
    local opid
    opid="$(port_pid "$port")"
    log "⚠ 端口 ${port} 仍被占用 (pid ${opid:-?})，视为本服务残留进程，kill -9 兜底"
    [ -n "${opid:-}" ] && kill -9 "$opid" 2>/dev/null || true
    sleep 1
  fi
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

# ---------- 构建 ----------
# 与 deploy.sh build_server 同款：tsc 不拷贝 ai-core 的 yaml/prompts 资产，
# 构建后必须补拷，否则 ModelRouter/prompt 模板读不到（CLAUDE.md 已知限制）。
cmd_build() {
  log '构建 server（tsc + 补拷 ai-core yaml/prompts）...'
  ( cd "$SERVER_DIR" && npm run build ) || die 'server 构建失败'
  mkdir -p "$SERVER_DIR/dist/ai-core"
  cp "$SERVER_DIR"/src/ai-core/*.yaml "$SERVER_DIR/dist/ai-core/"
  cp -R "$SERVER_DIR/src/ai-core/prompts" "$SERVER_DIR/dist/ai-core/"
  # KaTeX 字体：node_modules CSS 中的 url(fonts/...) 在 Vite dev/build 模式下
  # 无法正确解析为可访问的静态资源，导致数学公式（如 \sqrt{}）字体 404、
  # 渲染错位（根号横线缺失，显示为 /8）。通过脚本复制字体到 public/katex-fonts/
  # 并生成修正路径后的 CSS（src/styles/katex-fonts.css），由 markdown.tsx 引用。
  log '设置 KaTeX 字体（复制到 public/katex-fonts/ + 生成修正路径 CSS）...'
  ( cd "$WEB_DIR" && node scripts/setup-katex-fonts.cjs ) || die 'KaTeX 字体设置失败'
  log '构建 web（tsc -b + vite build）...'
  ( cd "$WEB_DIR" && npm run build ) || die 'web 构建失败'
  log '构建完成'
}

_BUILT=0
maybe_build() {
  [ "$NO_BUILD" = 1 ] && return 0
  [ "$_BUILT" = 1 ] && return 0
  cmd_build
  _BUILT=1
}

do_start() {
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

cmd_start() {
  maybe_build
  do_start
}

cmd_stop() {
  stop_one 'web' "$WEB_PID_FILE" "$WEB_PORT"
  stop_one 'server' "$SERVER_PID_FILE" "$SERVER_PORT"
}

cmd_restart() {
  # 先构建后停止：构建失败时运行中的旧进程保持不动，不出现服务空窗
  maybe_build
  cmd_stop
  sleep 1
  do_start
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
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
}

# --no-build 逃生口：纯重启（只改了 .env / 崩溃恢复），跳过构建
NO_BUILD="${SERVICES_NO_BUILD:-0}"
for _arg in "$@"; do
  [ "$_arg" = "--no-build" ] && NO_BUILD=1
done

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  build)   cmd_build ;;
  status)  cmd_status ;;
  log)     cmd_log "${2:-}" ;;
  -h|--help|'') usage ;;
  *) usage; die "未知命令: $1" ;;
esac
