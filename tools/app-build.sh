#!/usr/bin/env bash
#
# PC App 出包入口 —— 把「怎么出包」收敛到一处，`--help` 自述全部参数。
#
# 为什么有这个脚本（2026-09-28）：出包原先只写在实施计划里（两串 electron-builder 参数，
# 其中 publish 注入的 provider+url **必须同时给**），而 README 只讲 CI 流程 ——
# 也就是「本机怎么出包」本来就有个会漂移的说明点。收敛成带 `--help` 的脚本后，
# 文档只需指过来，不必再抄一遍命令。**发布那一步不重写逻辑**：`--publish` 直接转发给
# `tools/publish-installer.sh`（单一实现）。
#
# 本机限制（实测）：mac 包只能在本机出（.dmg 依赖 hdiutil）；**Windows/Linux 出不了**
# —— NSIS 要 wine、AppImage 要 docker，本机都没装。三平台产物只能走 `--online`（CI）。
#
# 设计见 docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md
set -euo pipefail

# ⚠️ 本文件里「`$VAR` 后面紧跟中文标点」的地方**必须写成 `${VAR}`**（下面有几处就是为此写的，
#    别当噪音删掉）：macOS 自带的是 **bash 3.2**，它会把紧跟的多字节 UTF-8 字符当成变量名的
#    一部分，在 `set -u` 下直接报 `unbound variable`（不是给出空值）。而且**只在跑到那一行时才炸**
#    —— 2026-09-28 实测：`$need，`、`$MODE）` 这类写法让 `--win` / `--linux` 与两个 warn 分支
#    全部报错，而正常出包路径完全看不出来。新增中文文案时留意这一条。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$ROOT/apps/desktop"
BUILDER="$DESKTOP_DIR/node_modules/.bin/electron-builder"
CONFIG="$DESKTOP_DIR/electron-builder.yml"

log()  { printf '[app-build] %s\n' "$*"; }
warn() { printf '[app-build] [WARN] %s\n' "$*" >&2; }
die()  { printf '[app-build] [ERROR] %s\n' "$*" >&2; exit 1; }

pkg_version() { ( cd "$DESKTOP_DIR" && node -p "require('./package.json').version" ) 2>/dev/null || echo '?'; }

# 服务器地址的唯一真源是 apps/desktop/server-url.js（与 publish-installer.sh 同一处）
server_url() { ( cd "$ROOT" && node -e "console.log(require('./apps/desktop/server-url.js').SERVER_URL)" ); }

require_builder() {
  [ -x "$BUILDER" ] || die "找不到 $BUILDER —— 先在 apps/desktop 跑 npm ci"
  [ -f "$CONFIG" ] || die "找不到 $CONFIG —— 打包配置缺失，先确认工作区完整"
}

run_tests() {
  log "跑 apps/desktop 测试（与 CI 的测试门禁同一道）…"
  ( cd "$DESKTOP_DIR" && npm test )
}

verify_asar() {
  log "asar 自检（必需资源是否齐全、有无测试文件混进包）…"
  ( cd "$DESKTOP_DIR" && node scripts/verify-asar.js )
}

# 把 electron-builder 收在一处调用：失败时把它那句看不出所以然的报错翻译成可执行的提示。
#
# 为什么需要（2026-09-28 实测）：本机到 GitHub 不通时，electron-builder 会在
# 「unpacking default Electron distribution」处抛 `read ECONNRESET`，堆栈全是 got/TLS 内部帧，
# **完全看不出是网络问题**；而且即使 Electron 已缓存在 `~/Library/Caches/electron` 也一样会去联网。
# 这里不阻止任何构建（说不定有可用的镜像），只在失败后补一句人话。
run_builder() {
  local status=0
  ( cd "$DESKTOP_DIR" && "$BUILDER" "$@" ) || status=$?
  if [ "$status" -ne 0 ]; then
    warn "electron-builder 失败（退出码 ${status}）。"
    warn "若上面的报错是 read ECONNRESET / 连接超时 / socket hang up，多半是**本机到 GitHub 不通** ——"
    warn "打包这一步会去取 Electron 发行包（本机缓存在 ~/Library/Caches/electron，缓存好也一样会联网）。"
    warn "连不上时它可能先**静默卡几分钟才报错**（2026-09-28 实测约 4 分钟），不是死住了。"
    warn "出路：修好代理 / VPN 后重试；或设 ELECTRON_MIRROR 指向可达镜像。"
    warn "只想确认壳本身没坏，可先跑 npm test（在 apps/desktop 下）。"
    return "$status"
  fi
}

list_dist() {
  log "dist 产物："
  (
    cd "$DESKTOP_DIR/dist" 2>/dev/null || return 0
    for f in *.dmg *.exe *.AppImage *.blockmap latest*.yml; do
      [ -f "$f" ] || continue
      printf '  %s (%s)\n' "$f" "$(du -h "$f" | cut -f1)"
    done
  )
}

usage() {
  cat <<'USAGE'
PC App 出包入口

用法: bash tools/app-build.sh <模式> [选项]

模式（一次只能选一个）：
  --check              快速门禁：跑测试 + 最小出包（--dir，只产出 .app，约 10s）+ asar 自检。
                       不产出安装包、不清空 dist、不碰 web 层。改完壳先跑这个。
  --local              本机出 mac 安装包：先清空 apps/desktop/dist，再出 x64 + arm64
                       两个 dmg（约 1min），最后跑 asar 自检。
  --online             GitHub Actions 出三平台包（mac dmg / win exe / linux AppImage）。
                       默认只做预检并打印要执行的命令；加 --yes 才真的打 tag 并推。
  --publish <文件...>  发布安装包到本机服务器 /download/ —— 转发给 tools/publish-installer.sh
                       （因此也接受它的 --no-build）。注意：会重建 web，替换 :5173 正在服务的 dist/
  --win | --linux      本机出不了（NSIS 要 wine、AppImage 要 docker），这里只说明原因与出路。

选项：
  --manifest           配合 --local：额外注入 publish 配置，产出 latest-mac.yml（发布/④ 要用）。
                       不注入就没有更新清单。
  --yes                配合 --online：预检通过后真的打 tag 并推 origin。
  -h, --help           显示本页。

示例（把 <版本> 换成 apps/desktop/package.json 里的 version）：
  bash tools/app-build.sh --check                             # 改完壳，快速确认没坏
  bash tools/app-build.sh --local                             # 出两个 dmg
  bash tools/app-build.sh --local --manifest                  # 出 dmg + latest-mac.yml
  bash tools/app-build.sh --online                            # 看要推什么（不推）
  bash tools/app-build.sh --online --yes                      # 预检通过后推 tag，触发 CI
  bash tools/app-build.sh --publish apps/desktop/dist/k12-desktop-<版本>-arm64.dmg

本机限制：mac 包只能在本机出（.dmg 要 hdiutil）；Windows/Linux 产物只能靠 --online。
打包需要能访问 GitHub（见 README 的说明）；发布到服务器会重建 web 并替换正在服务的 dist/。
USAGE
}

mode_check() {
  require_builder
  run_tests
  log "最小出包（--dir：只产出 .app，不打包成 dmg）…"
  run_builder --mac --dir
  verify_asar
  log "--check 通过：测试绿 + 壳能装起来 + 包内资源白名单完整。（本次未产出安装包）"
}

mode_local() {
  require_builder
  local args=( --mac )
  if [ "$MANIFEST" -eq 1 ]; then
    [ -f "$DESKTOP_DIR/server-url.js" ] || die "找不到 $DESKTOP_DIR/server-url.js（服务器地址的唯一真源）"
    local url
    url="$(server_url)"
    log "注入 publish 配置以产出更新清单：$url/download"
    args+=( --config.publish.provider=generic "--config.publish.url=$url/download" )
  fi
  log "清空 apps/desktop/dist …"
  rm -rf "$DESKTOP_DIR/dist"
  log "出 mac 包（x64 + arm64 两个 dmg，约 1min）…"
  run_builder "${args[@]}"
  verify_asar
  list_dist
  if [ "$MANIFEST" -eq 0 ]; then
    warn "本次没有更新清单（未加 --manifest）—— 发布给 ④ / 自动更新用时需要它"
  fi
}

mode_online() {
  local ver tag remote_url ci_url ahead
  ver="$(pkg_version)"
  [ "$ver" != '?' ] || die "读不到 apps/desktop/package.json 的 version"

  log "本地版本 $ver → 目标 tag desktop-v$ver"
  tag="desktop-v$ver"

  # 预检 1：工作区必须干净 —— tag 指向 HEAD，产物必须与提交一致
  [ -z "$(git -C "$ROOT" status --porcelain)" ] \
    || die "工作区不干净 —— 先提交或丢弃改动（tag 指向 HEAD，产物必须与提交一致）"

  # 预检 2：同名 tag 不得已存在，**本地与 origin 都要看**。两者的处置完全不同：
  #   本地有、origin 没有 = 多半是上次推送失败留下的 → 可安全删掉重来；
  #   origin 有 = 那是一个已发布的版本 → 必须换版本号，不许删。
  # ⚠️ 必须先看 origin：只看本地（2026-09-28 评审发现）漏掉了「远端已有、本地没有」的情形。
  local rs=0 remote_state='unknown'
  git -C "$ROOT" ls-remote --tags --exit-code origin "refs/tags/$tag" >/dev/null 2>&1 || rs=$?
  case "$rs" in
    0) remote_state='exists' ;;
    2) remote_state='absent' ;;   # ls-remote --exit-code 用 2 表示「没有匹配的 ref」
    *) remote_state='unknown' ;;  # 多半是网络不通
  esac

  if [ "$remote_state" = 'exists' ]; then
    die "tag $tag 已在 origin 上存在（那是一个已发布的版本）—— 改 apps/desktop/package.json 的 version 后再来，不要删它重打"
  fi
  if git -C "$ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    if [ "$remote_state" = 'absent' ]; then
      die "本地有 tag $tag 但 origin 没有（多半是上次推送失败留下的）—— 删掉重来即可：git tag -d $tag"
    fi
    die "本地已有 tag ${tag}，但无法确认它是否已推到 origin（网络不通？）—— 先确认远端状态再重试"
  fi
  if [ "$remote_state" = 'unknown' ]; then
    warn "无法确认 origin 上是否已有 tag ${tag}（网络不通？）"
    if [ "$CONFIRM" -eq 1 ]; then
      die "--yes 但无法确认远端状态 —— 联网确认后再推（--online 本来就需要联网）"
    fi
  fi

  # 预检 3：测试门禁。与 CI 的同名门禁一致，但**在本地先失败**，避免推完 tag 才发现红
  run_tests

  # 预检 4：只提示、不阻塞 —— 推 tag 会把它可达的提交一并推上去
  ahead="$(git -C "$ROOT" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo '?')"
  case "$ahead" in
    0)  : ;;
    '?') warn "当前分支没有上游（或未 fetch）—— 请自行确认远端状态" ;;
    *)  warn "本地还有 $ahead 个未推送提交；推这个 tag 会把这些提交一并推上去" ;;
  esac

  remote_url="$(git -C "$ROOT" remote get-url origin 2>/dev/null || echo '')"
  ci_url="$(printf '%s' "$remote_url" \
    | sed -E 's#^git@[^:]+:(.*)\.git$#https://github.com/\1/actions#; s#^https://github\.com/(.*)\.git$#https://github.com/\1/actions#')"

  if [ "$CONFIRM" -eq 1 ]; then
    log "预检通过 → 打 tag 并推 origin（CI 将开始三平台出包）"
    git -C "$ROOT" tag "$tag"
    # ⚠️ 推送失败必须回滚本地 tag（2026-09-28 评审发现）：否则下次会被「tag 已存在」卡住，
    # 而那个报错会让人去改版本号 —— 对一个从没推上去的 tag 来说那是错的处置。
    if ! git -C "$ROOT" push origin "$tag"; then
      git -C "$ROOT" tag -d "$tag" >/dev/null
      die "推送失败，已回滚本地 tag ${tag}（免得下次被「tag 已存在」卡住）—— 检查网络/权限后重试"
    fi
    log "已推 $tag"
    [ -n "$ci_url" ] && log "CI 进度看 $ci_url 的 Desktop Release"
  else
    log "预检通过。本次未推任何东西（缺少 --yes）。要真推就执行："
    printf '  git tag %s\n  git push origin %s\n' "$tag" "$tag"
    [ -n "$ci_url" ] && log "推完在 $ci_url 的 Desktop Release 看进度"
    log "或直接重跑：bash tools/app-build.sh --online --yes"
  fi
}

mode_publish() {
  [ "$#" -ge 1 ] || die "--publish 需要至少一个文件，例如：--publish apps/desktop/dist/k12-desktop-0.1.0-arm64.dmg"
  log "转发给 tools/publish-installer.sh（发布到服务器 /download/）…"
  exec bash "$SCRIPT_DIR/publish-installer.sh" "$@"
}

mode_unsupported() {
  local what="$1" need="$2"
  log "本机出不了 ${what} 安装包：需要 ${need}，本机没装。"
  log "两条出路："
  printf '  1) 走 CI，三平台一起出：bash tools/app-build.sh --online --yes\n'
  printf '  2) 先在本机装好 %s，再直接跑 apps/desktop 下的 electron-builder（配置见 electron-builder.yml）\n' "$need"
  exit 1
}

MODE=""
MANIFEST=0
CONFIRM=0
PUBLISH_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      log "当前 apps/desktop 版本：$(pkg_version)（--online 会打 tag desktop-v<该值>）"
      usage
      exit 0
      ;;
    --check|--local|--online)
      [ -z "$MODE" ] || die "只能选一个模式：已经选了 ${MODE}，又给了 $1"
      MODE="${1#--}"
      shift
      ;;
    --win|--linux)
      [ -z "$MODE" ] || die "只能选一个模式：已经选了 ${MODE}，又给了 $1"
      MODE="${1#--}"
      shift
      ;;
    --publish)
      [ -z "$MODE" ] || die "只能选一个模式：已经选了 ${MODE}，又给了 $1"
      MODE=publish
      shift
      [ "$#" -ge 1 ] || die "--publish 需要至少一个文件"
      PUBLISH_ARGS=( "$@" )
      shift "$#"
      ;;
    --manifest)
      MANIFEST=1
      shift
      ;;
    --yes)
      CONFIRM=1
      shift
      ;;
    *)
      die "未知参数：$1（用 --help 看用法）"
      ;;
  esac
done

[ -n "$MODE" ] || { usage >&2; exit 1; }

# 只对某个模式有意义的选项：点出来，别让人以为生效了
if [ "$MANIFEST" -eq 1 ] && [ "$MODE" != local ]; then
  warn "--manifest 只对 --local 有意义（当前模式：--${MODE}），本次已忽略"
fi
if [ "$CONFIRM" -eq 1 ] && [ "$MODE" != online ]; then
  warn "--yes 只对 --online 有意义（当前模式：--${MODE}），本次已忽略"
fi
# --publish 收下它后面的**所有**参数（文件名里可能有空格），所以任何选项写在它后面都会变成文件名。
# 静默吞掉最糟（2026-09-28 评审发现：`--publish a.dmg --yes` 会让 --yes 无声消失），这里点出来。
if [ "$MODE" = publish ]; then
  for _a in "${PUBLISH_ARGS[@]}"; do
    case "$_a" in
      --yes|--manifest)
        die "「${_a}」不能写在 --publish 之后：--publish 会收下它后面的所有参数当文件名（该选项对 --publish 也无意义）。把要传的选项放在模式参数之前。"
        ;;
    esac
  done
  unset _a
fi

case "$MODE" in
  check)   mode_check ;;
  local)   mode_local ;;
  online)  mode_online ;;
  publish) mode_publish "${PUBLISH_ARGS[@]}" ;;
  win)     mode_unsupported "Windows" "wine（出 NSIS .exe）" ;;
  linux)   mode_unsupported "Linux" "docker（出 AppImage）" ;;
  *)       die "内部错误：未知模式 $MODE" ;;
esac
