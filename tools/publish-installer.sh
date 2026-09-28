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
# 同时**重新生成** public/download/index.html（下载页）—— 页面内联列出本次发布的每个文件
# 与大小，因此永远不会列出陈旧文件。为什么需要它见下方第 2.5 步的注释：
# /download/ 命中不了静态文件时会被 SPA 回退成应用本体（HTTP 200 + HTML），而不是 404。
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

# 2.5) 生成下载页（public/download/index.html）—— 每次都重写，因此只会列出本次发布的东西
#
# 为什么要有这一页：`vite preview` 没开目录列表，且 vite.config.ts 用的是默认 appType=spa，
# 于是 htmlFallbackMiddleware 会把所有未命中的路径改写成 /index.html —— 也就是**访问
# /download/ 会返回学习应用本体（HTTP 200 + HTML），空目录/错文件名都不 404**；错名还会让浏览器
# 把 HTML 存成 .dmg。（实测见 spec §6-6 与 docs/ai-core-changelog.md。）
# 一个真实存在的 index.html 能命中静态文件、正常渲染，把「本次发布了哪些文件」讲清楚。
gen_download_page() {
  local items="" f name size
  for f in "$@"; do
    name="$(basename "$f")"
    size="$(du -h "$f" | cut -f1 | tr -d '[:space:]')"
    items="${items}      <li><a class=\"file\" href=\"${name}\">${name}</a><span class=\"size\">${size}</span></li>
"
  done
  cat > "$DEST_DIR/index.html" <<HTML
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>K12 智学 · PC App 下载</title>
<style>
  :root { --brand: #ff6b35; --brand-dark: #e85a28; --text: #2a1f18; --secondary: #6b5d52; --tertiary: #9c8d80; --bg: #f5f0e8; --card: #ffffff; --line: #ece3d6; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 48px 20px; background: var(--bg); color: var(--text);
         font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
         line-height: 1.7; }
  main { max-width: 640px; margin: 0 auto; background: var(--card); border: 1px solid var(--line);
         border-radius: 16px; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; }
  .note { color: var(--secondary); font-size: 14px; margin: 0 0 24px; }
  ul.files { list-style: none; margin: 0; padding: 0; }
  ul.files li { display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
                padding: 12px 0; border-bottom: 1px solid var(--line); }
  ul.files li:last-child { border-bottom: 0; }
  a.file { color: var(--brand); font-weight: 600; text-decoration: none; word-break: break-all; }
  a.file:hover { color: var(--brand-dark); text-decoration: underline; }
  .size { color: var(--tertiary); font-size: 13px; white-space: nowrap; }
  ul.notes { list-style: disc; margin: 0; padding-left: 20px; font-size: 14px; }
  ul.notes li { padding: 3px 0; }
  code { background: #f2ebe0; border-radius: 4px; padding: 1px 6px; font-size: 13px; word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>K12 智学 · PC App 下载</h1>
  <p class="note">本页由 tools/publish-installer.sh 在每次发布时重新生成，只列出本次真正发布到服务器的文件。</p>
  <ul class="files">
${items}  </ul>
  <h2>首次打开说明</h2>
  <ul class="notes">
    <li>macOS（安装包未签名）：首次打开会被系统拦下。可执行
      <code>xattr -dr com.apple.quarantine "/Applications/K12 智学.app"</code>，
      或到「系统设置 → 隐私与安全性」点「仍要打开」。</li>
    <li>Windows（安装包未签名）：首次运行会弹 SmartScreen 警告，点「更多信息」后选「仍要运行」。</li>
  </ul>
</main>
</body>
</html>
HTML
  log "已生成下载页 index.html（列出本次 $# 个文件）"
}
gen_download_page "$@"

# 3) 重建 web
if [ "$DO_BUILD" -eq 1 ]; then
  log "重建 web（会把 public/ 拷进 dist/）…"
  ( cd "$WEB_DIR" && npm run build )
else
  log "跳过重建（--no-build）—— 新文件不会进 dist/；此时 /download/ 返回的是 SPA 的 index.html（不是下载列表），且未发布前 /download/ 根本没有下载页"
fi

# 4) 打印下载地址（地址的唯一真源 = apps/desktop/server-url.js）
SERVER_URL="$(cd "$ROOT" && node -e "console.log(require('./apps/desktop/server-url.js').SERVER_URL)")"
log "下载页（浏览器打开即可看到本次所有文件）："
printf '  %s/download/\n' "${SERVER_URL%/}"
log "单文件直链："
for f in "$@"; do
  printf '  %s/download/%s\n' "${SERVER_URL%/}" "$(basename "$f")"
done
