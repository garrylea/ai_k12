#!/usr/bin/env bash
#
# 把 PC App 的安装包（与更新清单）发布到本机服务器，并打印下载地址。
#
# 用法：
#   bash tools/publish-installer.sh <文件1> [文件2 ...]
#   bash tools/publish-installer.sh --no-build <文件...>    # 只拷不重建（本地验收用）
#
# 做法：拷进 apps/web/public/download/ 之后重建 web —— `vite build` 会把 public/ 原样拷进
# dist/，所以放进 public/ 的文件能在下次构建后仍然存活（`vite build` 默认清空 dist/，
# 直接往 dist/ 里拷会在下次构建时丢失）。
#
# ⚠️ 副作用（spec §4.4）：第 3 步会**重建并替换 apps/web/dist/**，而本机 :5173 的
#    `vite preview` 正在服务这个目录 —— 也就是这一步会重建线上前端，
#    工作区里未提交的前端改动会被一并构建并对外生效。
#
# 设计见 docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md §4.4
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$ROOT/apps/web"
DEST_DIR="$WEB_DIR/public/download"

log() { printf '[publish-installer] %s\n' "$*"; }
die() { printf '[publish-installer] [ERROR] %s\n' "$*" >&2; exit 1; }

DO_BUILD=1
if [ "${1:-}" = "--no-build" ]; then
  DO_BUILD=0
  shift
fi

[ "$#" -ge 1 ] || die "用法: bash tools/publish-installer.sh [--no-build] <文件1> [文件2 ...]"

# 1) 先全量校验再动手 —— 拷进去一半比不拷更糟（下载目录是个公开的静态目录）
for f in "$@"; do
  [ -f "$f" ] || die "找不到文件: $f"
done

# 2) 拷入 public/（vite build 会把它带进 dist/）
mkdir -p "$DEST_DIR"
for f in "$@"; do
  cp -f "$f" "$DEST_DIR/"
  log "已拷入 $(basename "$f")"
done

# 3) 重建 web
if [ "$DO_BUILD" -eq 1 ]; then
  log "重建 web（会把 public/ 拷进 dist/）…"
  ( cd "$WEB_DIR" && npm run build )
else
  log "跳过重建（--no-build）—— 若 dist/ 里还没有这些文件，浏览器会 404"
fi

# 4) 打印下载地址（地址的唯一真源 = apps/desktop/server-url.js）
SERVER_URL="$(cd "$ROOT" && node -e "console.log(require('./apps/desktop/server-url.js').SERVER_URL)")"
log "下载地址（浏览器打开即可下载）："
for f in "$@"; do
  printf '  %s/download/%s\n' "${SERVER_URL%/}" "$(basename "$f")"
done
