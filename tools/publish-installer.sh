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
# 同时**重新生成** public/download/index.html（下载页）—— 页面列出下载目录里**实际存在**的
# 产物（安装包按平台分区并给平台提示，更新用文件收进折叠区），并标注哪些是本次发布、
# 哪些是早期版本。本脚本**从不删除**已发布文件（版本归档是本期明确的非目标），所以旧产物
# 会一起列出，而不是谎报「目录里只有本次这几个」。为什么需要这一页见下方第 2.5 步的注释：
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

# 2.5) 生成下载页（public/download/index.html）
#
# 为什么要有这一页：`vite preview` 没开目录列表，且 vite.config.ts 用的是默认 appType=spa，
# 于是 htmlFallbackMiddleware 会把所有未命中的路径改写成 /index.html —— 也就是**访问
# /download/ 会返回学习应用本体（HTTP 200 + HTML），空目录/错文件名都不 404**；错名还会让浏览器
# 把 HTML 存成 .dmg。（实测见 spec §6-6 与 docs/ai-core-changelog.md。）
# 一个真实存在的 index.html 能命中静态文件、正常渲染，把「服务器上到底有哪些文件」讲清楚。
#
# 页面分区（勿合并回一张平铺列表）：主区**只列安装包**并按名给平台提示；更新用文件
# （latest*.yml / *.blockmap）收进默认折叠的 <details>。更新清单与二进制差分对家长毫无用处，
# 平铺同权重会让家长下错东西（Windows 家长会看到 .dmg / AppImage）。
#
# ⚠️ 本函数**不删任何文件**（用户对破坏性操作保守、版本归档是本期明确的非目标）：它列出
#   DEST_DIR 里**实际存在**的产物，把本次传来的（"$@"）标为「本次发布」、其余标为「早期版本」，
#   并在有旧产物时告警。清 public/ 也清不掉 dist/（要等下次 vite build），所以「如实列出」
#   才是诚实的修法，而不是悄悄删除。

# URL 编码 / HTML 转义：脚本接受任意路径，文件名含 & < " # ? 会写出损坏或非法页面。
url_encode() {
  local LC_ALL=C s="$1" out="" i c
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out="${out}${c}" ;;
      *) out="${out}$(printf '%%%02X' "'${c}")" ;;
    esac
  done
  printf '%s' "$out"
}
html_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  printf '%s' "${s//\'/&#39;}"
}

gen_download_page() {
  local current_list="" primary="" updates="" f
  # 本次发布的 basename 清单（页面据此把「本次发布」与「早期版本」分开）
  for f in "$@"; do
    current_list="${current_list}$(basename "$f")
"
  done

  local primary_count=0 updates_count=0 earlier_count=0
  local earlier_names=""
  local path name name_lc size kind hint tag tag_class href text
  # 扫描目标目录里**实际存在**的产物（只认本脚本产生的几类，index.html 等自动跳过）
  for path in "$DEST_DIR"/*; do
    [ -f "$path" ] || continue
    name="$(basename "$path")"
    # 仅用于匹配的小写副本：显示名与 href 仍用原始大小写，否则 `…-X64.DMG` 会被拷入并打印
    # 直链、却因大小写不匹配被这个 case 跳过，从而不出现在页面上。
    name_lc="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    hint=""
    case "$name_lc" in
      *.exe)      kind=installer; hint="Windows" ;;
      *.appimage) kind=installer; hint="Linux" ;;
      *.dmg|*.pkg)
        kind=installer
        case "$name_lc" in
          *arm64*) hint="macOS（Apple 芯片 / M 系列）" ;;
          *x64*)   hint="macOS（Intel）" ;;
          *)       hint="macOS" ;;
        esac ;;
      latest*.yml|*.blockmap) kind=updates ;;
      *) continue ;;
    esac

    size="$(du -h "$path" | cut -f1 | tr -d '[:space:]')"
    if printf '%s' "$current_list" | grep -qxF -- "$name"; then
      tag="本次发布"; tag_class="current"
    else
      tag="早期版本"; tag_class="earlier"
      earlier_names="${earlier_names}${path}
"
      earlier_count=$(( earlier_count + 1 ))
    fi
    href="$(url_encode "$name")"
    text="$(html_escape "$name")"

    if [ "$kind" = installer ]; then
      primary_count=$(( primary_count + 1 ))
      primary="${primary}      <li>
        <span class=\"file-block\"><a class=\"file\" href=\"${href}\">${text}</a>
          <span class=\"meta\"><span class=\"hint\">${hint}</span><span class=\"tag ${tag_class}\">${tag}</span></span></span>
        <span class=\"size\">${size}</span>
      </li>
"
    else
      updates_count=$(( updates_count + 1 ))
      updates="${updates}      <li><a class=\"file\" href=\"${href}\">${text}</a><span class=\"size\">${size}</span></li>
"
    fi
  done

  local primary_block="$primary" updates_block=""
  [ "$primary_count" -gt 0 ] || primary_block="      <li class=\"empty\">目录中暂无安装包。</li>
"
  if [ "$updates_count" -gt 0 ]; then
    updates_block="  <details class=\"updates\">
    <summary>供应用自动更新使用的文件（更新清单与二进制差分），普通用户无需下载</summary>
    <ul class=\"files\">
${updates}    </ul>
  </details>
"
  fi

  cat > "$DEST_DIR/index.html" <<HTML
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>K12 智学 · PC App 下载</title>
<style>
  /* 配色 token 来源：apps/web/style.md §2（唯一真源）—— 勿在本页另起一套颜色 */
  :root { --brand: #ff6b35; --brand-dark: #e85a28; --warning: #d89844; --text: #2a1f18; --secondary: #6b5d52; --tertiary: #9c8d80; --bg: #f5f0e8; --card: #ffffff; --line: #ece3d6; }
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
  li.empty { color: var(--tertiary); font-size: 14px; }
  .file-block { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  a.file { color: var(--brand); font-weight: 600; text-decoration: none; word-break: break-all; }
  a.file:hover { color: var(--brand-dark); text-decoration: underline; }
  .meta { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .hint { color: var(--secondary); }
  .tag { font-size: 12px; color: var(--tertiary); border: 1px solid var(--line);
         border-radius: 999px; padding: 0 8px; }
  .tag.earlier { color: var(--warning); }
  .size { color: var(--tertiary); font-size: 13px; white-space: nowrap; }
  details.updates { margin-top: 8px; border-top: 1px solid var(--line); padding-top: 12px; }
  details.updates summary { cursor: pointer; color: var(--secondary); font-size: 14px; }
  details.updates ul.files li { padding: 6px 0; border-bottom: 0; }
  ul.notes { list-style: disc; margin: 0; padding-left: 20px; font-size: 14px; }
  ul.notes li { padding: 3px 0; }
  code { background: #f2ebe0; border-radius: 4px; padding: 1px 6px; font-size: 13px; word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>K12 智学 · PC App 下载</h1>
  <p class="note">本页由 tools/publish-installer.sh 生成，列出本目录中可识别的产物（含早期版本）；标注「本次发布」的是最近一次发布。</p>
  <h2>安装包</h2>
  <ul class="files">
${primary_block}  </ul>
${updates_block}  <h2>首次打开说明</h2>
  <ul class="notes">
    <li>macOS（.pkg 安装包，未签名）：双击安装；若提示「无法验证开发者」，到
      「系统设置 → 隐私与安全性」点「仍要打开」后再双击，按安装器提示输入开机密码完成。
      全程不需要终端。</li>
    <li>macOS（早期发布的 .dmg 包）：拖入「应用程序」后首次打开若被拦，需在终端执行
      <code>xattr -dr com.apple.quarantine "/Applications/K12 智学.app"</code>，
      或走「系统设置 → 隐私与安全性 → 仍要打开」。</li>
    <li>Windows（安装包未签名）：首次运行会弹 SmartScreen 警告，点「更多信息」后选「仍要运行」。</li>
  </ul>
</main>
</body>
</html>
HTML
  log "已生成下载页 index.html（安装包 ${primary_count} 个、更新用文件 ${updates_count} 个；本次发布 $# 个）"

  # 旧产物告警（不清理，只提示——见上方 2.5 注释）
  if [ "$earlier_count" -gt 0 ]; then
    local s kb_total=0
    while IFS= read -r s; do
      [ -n "$s" ] || continue
      kb_total=$(( kb_total + $(du -k "$s" | cut -f1 | tr -d '[:space:]') ))
    done <<< "$earlier_names"
    local total_size
    total_size="$(awk -v k="$kb_total" 'BEGIN{ if (k>=1048576) printf "%.1fG", k/1048576; else if (k>=1024) printf "%.1fM", k/1024; else printf "%dK", k }')"
    log "注意：下载目录里仍有 ${earlier_count} 个早期发布的产物（合计 ${total_size}）——本脚本不清理，需人工决定何时归档/删除："
    while IFS= read -r s; do
      [ -n "$s" ] || continue
      log "  早期版本: $(basename "$s")"
    done <<< "$earlier_names"
  fi
}
gen_download_page "$@"

# 3) 重建 web
if [ "$DO_BUILD" -eq 1 ]; then
  log "重建 web（会把 public/ 拷进 dist/）…"
  ( cd "$WEB_DIR" && npm run build )
else
  log "跳过重建（--no-build）—— 新文件不会进 dist/；此时 /download/ 返回的是 SPA 的 index.html（不是下载列表）"
fi

# 4) 打印下载地址（地址的唯一真源 = apps/desktop/server-url.js）
SERVER_URL="$(cd "$ROOT" && node -e "console.log(require('./apps/desktop/server-url.js').SERVER_URL)")"
if [ "$DO_BUILD" -eq 1 ]; then
  log "下载页（浏览器打开即可看到本次所有文件）："
  printf '  %s/download/\n' "${SERVER_URL%/}"
  log "单文件直链："
  for f in "$@"; do
    printf '  %s/download/%s\n' "${SERVER_URL%/}" "$(basename "$f")"
  done
else
  # --no-build：文件只进了 public/，没进 dist/（vite preview 服务的是 dist/）——
  # 此时 /download/ 与其下的单文件直链都仍会被 SPA 回退成应用本体，打印它们就是谎报。
  log "未重建 web，故不打印下载地址：/download/（含单文件直链）在下次真正构建前返回的都是应用本体，不是本次的文件。"
  log "  下载页已写到 apps/web/public/download/index.html（下次构建后随 dist/ 一起对外生效）。"
fi
