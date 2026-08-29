#!/usr/bin/env bash
#
# K12 智学系统 — 一键环境部署脚本（全新 macOS / Linux）
#
# 功能：
#   1. 交互式收集并校验用户输入（数据库、LLM 模型、管理员账号）。
#   2. 自动安装 Node（nvm）与 MySQL（tools/db/install_mysql.sh）。
#   3. 生成 apps/server/.env，改写 model-routes.yaml 的模型名。
#   4. 构建 web / server（生产模式），并补拷 YAML/提示词资产到 dist。
#   5. 配置种子：seed-llm-config（模型配置表）、seed-admin（管理员）。
#   6. 后台启动服务，健康检查，打印使用信息。
#   7. 断点续跑：配置与已完成步骤保存到 tools/deploy/runtime/，失败后重跑可从失败处继续。
#
# 业务数据导入不在此脚本范围内（由 tools/data-refinery 的 pipeline_cli 处理，
# 其 .env 配置由 pipeline 首跑时从本脚本产物引导生成）。
#
# 用法：
#   bash tools/deploy.sh          # 全新部署；若存在上次状态则询问是否续跑
#   bash tools/deploy.sh --fresh  # 清除已保存状态，重新开始（等价于 --reset）
#   bash tools/deploy.sh --help   # 显示帮助
#
set -euo pipefail

# ---------- 路径常量 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$ROOT/apps/server"
WEB_DIR="$ROOT/apps/web"
INSTALL_MYSQL="$ROOT/tools/db/install_mysql.sh"
YAML_PATH="$SERVER_DIR/src/ai-core/model-routes.yaml"
ENV_FILE="$SERVER_DIR/.env"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
HELPER_SCRIPT="$SCRIPT_DIR/deploy/apply-llm-config.mjs"
STATE_HELPER="$SCRIPT_DIR/deploy/state.mjs"
STATE_FILE="$RUNTIME_DIR/deploy.state.json"

SERVER_PORT="${SERVER_PORT:-3001}"
WEB_PORT="${WEB_PORT:-5173}"
UPLOAD_DIR="${UPLOAD_DIR:-./uploads}"
PROVIDERS_ALL="kimi qwen gemini deepseek"
NODE_MIN_VERSION="20.19.0"
NVM_VERSION="v0.40.1"

# ---------- 基础函数 ----------
log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] [ERROR] %s\n' "$*" >&2; exit 1; }

confirm() { # $1=提示  默认 yes
  local ans
  printf '%s [Y/n]: ' "$1" >&2
  read -r ans || die "读取输入失败"
  case "$ans" in
    ""|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- 状态存储（断点续跑）----------
# 状态保存在 $RUNTIME_DIR/deploy.state.json（含密码等敏感信息，权限 600）。
state_get() { node "$STATE_HELPER" get "$STATE_FILE" "$1"; }
state_set() { node "$STATE_HELPER" set "$STATE_FILE" "$1" "$2"; }
state_has() { node "$STATE_HELPER" has "$STATE_FILE" "$1" >/dev/null 2>&1; }

# 步骤包装：已完成（有标记）则跳过，否则执行并在成功后打标记
step_run() { # $1=步骤函数 $2=标记名
  if state_has "$2"; then
    log "跳过已完成的步骤: ${2}"
    return 0
  fi
  "$1"
  state_set "$2" done
}

# 保存本次收集到的全部输入（在 node 就绪后调用）
save_inputs() {
  state_set DB_HOST "$DB_HOST"; state_set DB_PORT "$DB_PORT"; state_set DB_NAME "$DB_NAME"
  state_set DB_USER "$DB_USER"; state_set DB_PASS "$DB_PASS"
  state_set SERVER_PORT "$SERVER_PORT"; state_set WEB_PORT "$WEB_PORT"
  state_set SELECTED_PROVIDERS "$SELECTED_PROVIDERS"
  local p up var
  for p in $SELECTED_PROVIDERS; do
    up="$(printf '%s' "$p" | tr 'a-z' 'A-Z')"
    var="LLM_${up}_MODEL";    state_set "$var" "${!var}"
    var="LLM_${up}_BASE_URL"; state_set "$var" "${!var}"
    var="LLM_${up}_API_KEY";  state_set "$var" "${!var}"
  done
  state_set ADMIN_USERNAME "$ADMIN_USERNAME"; state_set ADMIN_PASSWORD "$ADMIN_PASSWORD"
  state_set LLM_ENC_KEY "$LLM_ENC_KEY"; state_set JWT_SECRET "$JWT_SECRET"
}

# 从状态文件恢复输入到全局变量
load_state() {
  DB_HOST="$(state_get DB_HOST)"; DB_PORT="$(state_get DB_PORT)"; DB_NAME="$(state_get DB_NAME)"
  DB_USER="$(state_get DB_USER)"; DB_PASS="$(state_get DB_PASS)"
  SERVER_PORT="$(state_get SERVER_PORT)"; WEB_PORT="$(state_get WEB_PORT)"
  SELECTED_PROVIDERS="$(state_get SELECTED_PROVIDERS)"
  local p up var
  for p in $SELECTED_PROVIDERS; do
    up="$(printf '%s' "$p" | tr 'a-z' 'A-Z')"
    var="LLM_${up}_MODEL";    printf -v "$var" '%s' "$(state_get "$var")"
    var="LLM_${up}_BASE_URL"; printf -v "$var" '%s' "$(state_get "$var")"
    var="LLM_${up}_API_KEY";  printf -v "$var" '%s' "$(state_get "$var")"
  done
  ADMIN_USERNAME="$(state_get ADMIN_USERNAME)"; ADMIN_PASSWORD="$(state_get ADMIN_PASSWORD)"
  LLM_ENC_KEY="$(state_get LLM_ENC_KEY)"; JWT_SECRET="$(state_get JWT_SECRET)"
}

collect_all() {
  collect_db
  collect_ports
  collect_llm
  collect_admin
}

# 启动服务 + 健康检查作为一个步骤（健康检查失败则该步骤标记不落，续跑会重试）
start_and_check() {
  start_services
  health_check
}

ask_var() { # $1=提示 $2=默认值 $3=变量名
  local _prompt="$1" _def="$2" _name="$3" _read
  printf '%s [%s]: ' "$_prompt" "$_def" >&2
  read -r _read || die "读取输入失败"
  [ -z "$_read" ] && _read="$_def"
  printf -v "$_name" '%s' "$_read"
}

ask_secret() { # $1=提示 $2=变量名 $3=最小长度 $4=可选：不得等于该值
  local _s _c
  while true; do
    printf '%s: ' "$1" >&2
    read -r -s _s || die "读取输入失败"
    printf '\n' >&2
    if [ -z "$_s" ]; then
      echo '  错误：不能为空' >&2
      continue
    fi
    if [ "${#_s}" -lt "$3" ]; then
      echo "  错误：长度必须 ≥ $3 位（当前 ${#_s} 位）" >&2
      continue
    fi
    if [ -n "${4:-}" ] && [ "$_s" = "$4" ]; then
      echo '  错误：不能与用户名相同' >&2
      continue
    fi
    printf '请再次输入确认: ' >&2
    read -r -s _c || die "读取输入失败"
    printf '\n' >&2
    if [ "$_s" != "$_c" ]; then
      echo '  错误：两次输入不一致，请重新输入' >&2
      continue
    fi
    printf -v "$2" '%s' "$_s"
    return 0
  done
}

ask_port() { # $1=提示 $2=默认值 $3=变量名  校验：1-65535 的数字
  local val
  while true; do
    ask_var "$1" "$2" val
    if [[ "$val" =~ ^[0-9]+$ ]] && [ "$val" -ge 1 ] && [ "$val" -le 65535 ]; then
      printf -v "$3" '%s' "$val"
      return 0
    fi
    echo "  错误：端口必须是 1-65535 之间的数字" >&2
  done
}

is_url() { [[ "$1" =~ ^https?://.+$ ]]; }

# 端口占用检测：返回 0 表示端口被占用（跨平台：lsof / ss）
port_in_use() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "[:.]${p}[[:space:]]"
  else
    return 1
  fi
}

# 返回占用端口的首个进程 PID
port_pid() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | head -1
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$p" 2>/dev/null | tr -s ' ' '\n' | head -1
  fi
}

# 安全更新 .env 中的单个键值（兼容 macOS/Linux 的 sed）
set_env_var() { # $1=key $2=value
  if grep -q "^${1}=" "$ENV_FILE"; then
    sed -i.bak "s|^${1}=.*|${1}=${2}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    echo "${1}=${2}" >> "$ENV_FILE"
  fi
}

# 确保端口可用：若被占用则询问用户处理（杀掉占用进程 / 换端口 / 取消）
ensure_port_free() { # $1=端口 $2=服务名（'服务端'/'Web'）
  local port="$1" name="$2" pid info choice new_port
  while port_in_use "$port"; do
    pid="$(port_pid "$port")"
    info="$(ps -p "${pid:-0}" -o command= 2>/dev/null | cut -c1-100)"
    echo "  ⚠ 端口 ${port}（${name}）已被进程占用: PID=${pid:-?} ${info}" >&2
    while true; do
      printf '  请选择：1) 杀掉该进程并使用此端口   2) 重新指定端口   3) 取消部署 [1/2/3]: ' >&2
      read -r choice || die "读取输入失败"
      case "$choice" in
        1)
          if [ -n "$pid" ]; then
            echo "  正在停止占用进程 ${pid}..."
            kill "$pid" 2>/dev/null || true
            sleep 1
            if port_in_use "$port"; then kill -9 "$pid" 2>/dev/null || true; fi
          fi
          if port_in_use "$port"; then
            echo '  错误：端口仍被占用（可能被其他进程持有），请重新选择' >&2
            continue
          fi
          return 0
          ;;
        2)
          ask_port "请输入新的${name}端口" "$port" new_port
          port="$new_port"
          if [ "$name" = '服务端' ]; then
            SERVER_PORT="$new_port"
            set_env_var 'PORT' "$new_port"
          else
            WEB_PORT="$new_port"
          fi
          break
          ;;
        3)
          echo '已取消部署。' >&2
          exit 1
          ;;
        *) echo '  无效选择' >&2 ;;
      esac
    done
  done
}

version_ge() { # $1=当前版本 $2=最低版本  （点分数字比较）
  local a b i an bn
  IFS='.' read -r -a a <<< "$1"
  IFS='.' read -r -a b <<< "$2"
  for ((i = 0; i < 3; i++)); do
    an="${a[i]:-0}"
    bn="${b[i]:-0}"
    if [ "$an" -gt "$bn" ] 2>/dev/null; then return 0; fi
    if [ "$an" -lt "$bn" ] 2>/dev/null; then return 1; fi
  done
  return 0
}

# ---------- 1. 收集数据库配置 ----------
collect_db() {
  echo '=== 数据库配置 ==='
  ask_var '数据库主机' 'localhost' DB_HOST
  ask_var '数据库端口' '3306' DB_PORT
  ask_var '数据库名' 'ai_k12' DB_NAME
  ask_var '数据库用户名' 'ai_k12' DB_USER
  ask_secret '数据库密码（≥8 位）' DB_PASS 8 "$DB_USER"
}

# ---------- 2. 收集服务端口 ----------
collect_ports() {
  echo '=== 服务端口 ==='
  ask_port '服务端 API 端口（NestJS）' "$SERVER_PORT" SERVER_PORT
  ask_port 'Web 页面端口（前端）' "$WEB_PORT" WEB_PORT
}

# ---------- 3. 收集 LLM 配置 ----------
test_llm() { # $1=provider $2=modelId $3=baseUrl $4=apiKey
  local provider="$1" model="$2" base="$3" key="$4"
  local tmp code
  tmp="$(mktemp)"
  case "$provider" in
    kimi|qwen|deepseek)
      code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 30 \
        -X POST "${base%/}/v1/chat/completions" \
        -H "Authorization: Bearer ${key}" \
        -H 'Content-Type: application/json' \
        -d "{\"model\":\"${model}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}" \
        2>/dev/null || echo '000')
      ;;
    gemini)
      code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 30 \
        -X POST "${base%/}/v1/models/${model}:generateContent?key=${key}" \
        -H 'Content-Type: application/json' \
        -d '{"contents":[{"parts":[{"text":"ping"}]}]}' \
        2>/dev/null || echo '000')
      ;;
    *) rm -f "$tmp"; return 1 ;;
  esac
  if [ "$code" = '200' ]; then
    rm -f "$tmp"
    return 0
  fi
  echo "    HTTP ${code}; 响应: $(head -c 300 "$tmp" 2>/dev/null || true)" >&2
  rm -f "$tmp"
  return 1
}

configure_llm_provider() { # $1=provider
  local p="$1" def_url def_model
  case "$p" in
    kimi)    def_url='https://api.moonshot.cn'                        def_model='kimi-latest' ;;
    qwen)    def_url='https://dashscope.aliyuncs.com/compatible-mode' def_model='qwen3.7-max' ;;
    gemini)  def_url='https://generativelanguage.googleapis.com'      def_model='gemini-3.1-pro' ;;
    deepseek) def_url='https://api.deepseek.com'                      def_model='deepseek-v4-flash' ;;
    *) die "未知 provider: $p" ;;
  esac

  local model url key choice
  local skip_test=0
  while true; do
    ask_var "  ${p} 模型名" "$def_model" model
    ask_var "  ${p} Base URL" "$def_url" url
    if ! is_url "$url"; then
      echo '  错误：Base URL 必须是 http(s):// 开头的合法地址' >&2
      continue
    fi
    while true; do
      printf '  %s API Key: ' "$p" >&2
      read -r -s key || die "读取输入失败"
      printf '\n' >&2
      [ -n "$key" ] && break
      echo '  错误：API Key 不能为空' >&2
    done

    if [ "$skip_test" = '1' ]; then break; fi
    echo "  → 测试 ${p} 连通性（model=${model}, ${url}）..."
    if test_llm "$p" "$model" "$url" "$key"; then
      echo "  ✓ ${p} 连通性测试通过"
      break
    else
      echo "  ✗ ${p} 连通性测试失败" >&2
      while true; do
        printf '  请选择：1) 重新填写   2) 跳过测试仅保存 [1/2]: ' >&2
        read -r choice || die "读取输入失败"
        case "$choice" in
          1) break ;;
          2) skip_test=1; break ;;
          *) echo '  无效选择' >&2 ;;
        esac
      done
      [ "$skip_test" = '1' ] && break
    fi
  done

  local up
  up="$(printf '%s' "$p" | tr 'a-z' 'A-Z')"
  printf -v "LLM_${up}_MODEL" '%s' "$model"
  printf -v "LLM_${up}_BASE_URL" '%s' "$url"
  printf -v "LLM_${up}_API_KEY" '%s' "$key"
}

collect_llm() {
  echo '=== LLM 大模型配置（模型名 / Base URL / API Key）==='
  local val ok p
  while true; do
    printf '选择要配置的 provider（逗号分隔，可选：%s）: ' "$PROVIDERS_ALL" >&2
    read -r val || die "读取输入失败"
    val="$(printf '%s' "$val" | tr -d ' ' | tr ',' ' ')"
    [ -n "$val" ] || { echo '  错误：至少选择一个 provider' >&2; continue; }
    ok=1
    for p in $val; do
      case " $PROVIDERS_ALL " in
        *" $p "*) ;;
        *) echo "  错误：未知 provider: ${p}（可选：${PROVIDERS_ALL}）" >&2; ok=0; break ;;
      esac
    done
    [ "$ok" = '1' ] && break
  done
  SELECTED_PROVIDERS="$val"

  for p in $SELECTED_PROVIDERS; do
    echo "--- 配置 ${p} ---"
    configure_llm_provider "$p"
  done
}

# ---------- 4. 收集管理员账号 ----------
collect_admin() {
  echo '=== 管理员账号 ==='
  ask_var '管理员用户名' 'admin' ADMIN_USERNAME
  ask_secret '管理员密码（≥6 位）' ADMIN_PASSWORD 6
}

# ---------- 5. 安装环境 ----------
ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local v
    v="$(node -v | sed 's/^v//')"
    if version_ge "$v" "$NODE_MIN_VERSION"; then
      log "Node 版本满足要求: $(node -v)"
      return 0
    fi
    log "Node 版本过低: $(node -v)（要求 ≥${NODE_MIN_VERSION}）"
  else
    log '未检测到 Node，将通过 nvm 安装'
  fi

  if [ ! -s "${HOME}/.nvm/nvm.sh" ]; then
    log '安装 nvm...'
    curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
  fi
  # shellcheck disable=SC1090
  . "${HOME}/.nvm/nvm.sh"
  log '通过 nvm 安装 Node 22 LTS...'
  nvm install 22 >/dev/null
  nvm alias default 22 >/dev/null
  export PATH="${HOME}/.nvm/current/bin:${PATH}"
  log "Node 已就绪: $(node -v)"
}

ensure_mysql() {
  local root_arg=() root_pass=""
  if command -v mysql >/dev/null 2>&1; then
    if ! mysql -u root -e 'SELECT 1' >/dev/null 2>&1; then
      ask_secret 'MySQL root 密码（用于建库建用户）' root_pass 1
      root_arg=(-r "$root_pass")
    fi
  fi
  log '安装 / 启动 MySQL 并初始化数据库（耗时较长，Linux 下可能要求 sudo）...'
  # bash 3.2 在 set -u 下展开空数组会报 unbound variable，需先判断数组是否为空
  if [ "${#root_arg[@]}" -gt 0 ]; then
    bash "$INSTALL_MYSQL" -d "$DB_NAME" -u "$DB_USER" -p "$DB_PASS" "${root_arg[@]}"
  else
    bash "$INSTALL_MYSQL" -d "$DB_NAME" -u "$DB_USER" -p "$DB_PASS"
  fi

  # 校验业务账号连接。install_mysql.sh 用 CREATE USER IF NOT EXISTS 不会更新已有用户密码，
  # 若库中已存在同名旧密码用户，这里连接会失败，需用 root 把密码重置为用户本次填写的值。
  if ! mysql -u "$DB_USER" -p"$DB_PASS" -e 'SELECT 1' "$DB_NAME" >/dev/null 2>&1; then
    log "业务账号 ${DB_USER} 连接失败（库中可能存在同名旧密码用户），使用 root 重置密码..."
    if mysql -u root -e 'SELECT 1' >/dev/null 2>&1; then
      mysql -u root -e "ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}'; FLUSH PRIVILEGES;"
    elif [ -n "$root_pass" ]; then
      mysql -u root -p"$root_pass" -e "ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}'; FLUSH PRIVILEGES;"
    else
      die "无法以 root 连接 MySQL，请手动执行: ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';"
    fi
    mysql -u "$DB_USER" -p"$DB_PASS" -e 'SELECT 1' "$DB_NAME" >/dev/null 2>&1 || die "重置密码后业务账号 ${DB_USER} 仍无法连接"
    log "业务账号 ${DB_USER} 密码已重置并连接正常"
  else
    log "业务账号 ${DB_USER} 连接正常"
  fi
}

# ---------- 6. 生成配置 ----------
write_env() {
  log "写入 $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Generated by tools/deploy.sh on $(date '+%Y-%m-%d %H:%M:%S')
# LLM provider credentials
KIMI_BASE_URL=${LLM_KIMI_BASE_URL:-}
KIMI_API_KEY=${LLM_KIMI_API_KEY:-}
QWEN_BASE_URL=${LLM_QWEN_BASE_URL:-}
QWEN_API_KEY=${LLM_QWEN_API_KEY:-}
GEMINI_BASE_URL=${LLM_GEMINI_BASE_URL:-}
GEMINI_API_KEY=${LLM_GEMINI_API_KEY:-}
DEEPSEEK_BASE_URL=${LLM_DEEPSEEK_BASE_URL:-}
DEEPSEEK_API_KEY=${LLM_DEEPSEEK_API_KEY:-}

# Admin seed
ADMIN_INITIAL_USERNAME=${ADMIN_USERNAME}
ADMIN_INITIAL_PASSWORD=${ADMIN_PASSWORD}

# Database
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_USER=${DB_USER}
DB_PASS=${DB_PASS}
DB_NAME=${DB_NAME}

# Admin console: AES-256-GCM key (64 hex chars)
LLM_CONFIG_ENC_KEY=${LLM_ENC_KEY}
JWT_SECRET=${JWT_SECRET}
PORT=${SERVER_PORT}
UPLOAD_DIR=${UPLOAD_DIR}
EOF
}

apply_llm_yaml() {
  local args=() up var m
  for p in $SELECTED_PROVIDERS; do
    up="$(printf '%s' "$p" | tr 'a-z' 'A-Z')"
    var="LLM_${up}_MODEL"
    m="${!var}"
    args+=("${p}=${m}")
  done
  log "改写 $YAML_PATH 中的模型名..."
  node "$HELPER_SCRIPT" "$YAML_PATH" "${args[@]}"
}

# ---------- 7. 构建 ----------
build_server() {
  log '构建 server（npm install + tsc）...'
  ( cd "$SERVER_DIR" && npm install && npm run build )
  mkdir -p "$SERVER_DIR/dist/ai-core"
  cp "$SERVER_DIR"/src/ai-core/*.yaml "$SERVER_DIR/dist/ai-core/"
  cp -R "$SERVER_DIR/src/ai-core/prompts" "$SERVER_DIR/dist/ai-core/"
  log 'server 构建完成，已补拷 yaml/prompts 到 dist/ai-core/'
}

build_web() {
  log '构建 web（npm install + vite build）...'
  ( cd "$WEB_DIR" && npm install && npm run build )
  log 'web 构建完成'
}

# ---------- 8. 配置种子 ----------
seed() {
  log '执行 seed-llm-config（YAML → llm_models/llm_routes）...'
  ( cd "$SERVER_DIR" && npx tsx src/scripts/seed-llm-config.ts )
  log '执行 seed-admin（创建管理员账号 + 占位家长）...'
  (
    cd "$SERVER_DIR"
    ADMIN_INITIAL_USERNAME="$ADMIN_USERNAME" \
    ADMIN_INITIAL_PASSWORD="$ADMIN_PASSWORD" \
    DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_USER="$DB_USER" DB_PASS="$DB_PASS" DB_NAME="$DB_NAME" \
      npx tsx src/scripts/seed-admin.ts
  )
}

# ---------- 9. 启动服务 ----------
start_services() {
  mkdir -p "$RUNTIME_DIR"

  # 物化图片目录：server 启动时按存在性挂载 /assets 静态服务（main.ts 的 useStaticAssets）。
  # 全新部署时数据管线尚未跑过，必须先建目录，否则 /assets 被静默跳过挂载，
  # 之后管线产出图片也要重启 server 才生效。
  mkdir -p "$ROOT/tools/data-refinery/output/assets"

  if [ -f "$RUNTIME_DIR/server.pid" ] && kill -0 "$(cat "$RUNTIME_DIR/server.pid")" 2>/dev/null; then
    log "server 已在运行 (pid $(cat "$RUNTIME_DIR/server.pid"))"
  else
    ensure_port_free "$SERVER_PORT" '服务端'
    ( cd "$SERVER_DIR" && nohup node dist/main.js >> "$RUNTIME_DIR/server.log" 2>&1 & echo $! > "$RUNTIME_DIR/server.pid" )
    log "server 已启动 (pid $(cat "$RUNTIME_DIR/server.pid"))，日志: $RUNTIME_DIR/server.log"
  fi

  if [ -f "$RUNTIME_DIR/web.pid" ] && kill -0 "$(cat "$RUNTIME_DIR/web.pid")" 2>/dev/null; then
    log "web 已在运行 (pid $(cat "$RUNTIME_DIR/web.pid"))"
  else
    ensure_port_free "$WEB_PORT" 'Web'
    ( cd "$WEB_DIR" && K12_API_PROXY="http://localhost:${SERVER_PORT}" nohup npx vite preview --host 0.0.0.0 --port "$WEB_PORT" >> "$RUNTIME_DIR/web.log" 2>&1 & echo $! > "$RUNTIME_DIR/web.pid" )
    log "web 已启动 (pid $(cat "$RUNTIME_DIR/web.pid"))，日志: $RUNTIME_DIR/web.log"
  fi
}

health_check() {
  log '健康检查...'
  local srv web
  sleep 3
  srv="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://localhost:${SERVER_PORT}/api/content/subjects" || echo 000)"
  web="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://localhost:${WEB_PORT}/" || echo 000)"
  echo "  server (/api/content/subjects): HTTP ${srv}"
  echo "  web (/):                        HTTP ${web}"
  [ "$srv" = '200' ] || { echo "  ✗ server 健康检查失败，请查看: $RUNTIME_DIR/server.log" >&2; return 1; }
  [ "$web" = '200' ] || { echo "  ✗ web 健康检查失败，请查看: $RUNTIME_DIR/web.log" >&2; return 1; }
  echo '  ✓ 全部通过'
}

# ---------- 10. 总结 ----------
print_summary() {
  cat <<EOF

============================================================
  部署完成
============================================================
  Web:    http://localhost:${WEB_PORT}
  Server: http://localhost:${SERVER_PORT}
  API:    http://localhost:${SERVER_PORT}/api/content/subjects

  数据库:  ${DB_HOST}:${DB_PORT}/${DB_NAME}  用户: ${DB_USER}
  管理员:  ${ADMIN_USERNAME}（密码已在安装时设定）
  配置的 LLM provider: ${SELECTED_PROVIDERS}

  日志:    ${RUNTIME_DIR}/server.log
           ${RUNTIME_DIR}/web.log
  PID:     ${RUNTIME_DIR}/server.pid / web.pid
  停止:    bash tools/services.sh stop（启停/重启/状态见 bash tools/services.sh --help）

  提示:
    - 业务数据导入请使用 tools/data-refinery 的总控脚本：
      cd tools/data-refinery && python src/pipeline_cli.py --source all
      （首跑会自动生成本目录的 .env，从上面配置的模型中选择）
    - 自定义模型可在管理台 /api/admin/models 调整。
    - 管理员登录后请尽快修改初始密码。
============================================================
EOF
}

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

# ---------- main ----------
main() {
  local resumed=0
  case "${1:-}" in
    -h|--help)
      usage
      exit 0
      ;;
    --fresh|--reset)
      rm -f "$STATE_FILE"
      log '已清除保存的部署状态，将从零开始全新部署'
      ;;
  esac

  log "K12 智学系统部署脚本（仓库根目录: ${ROOT}）"
  [ -d "$SERVER_DIR" ] || die "找不到 ${SERVER_DIR}，请确认在正确的仓库内运行"
  [ -d "$WEB_DIR" ] || die "找不到 $WEB_DIR"

  # 断点续跑：检测已保存的状态
  if [ -f "$STATE_FILE" ]; then
    if confirm '检测到上次部署的状态，是否从失败处继续？'; then
      log '正在加载已保存的配置并跳过已完成步骤...'
      load_state
      resumed=1
    else
      log '选择重新开始，清除旧状态...'
      rm -f "$STATE_FILE"
      collect_all
    fi
  else
    collect_all
  fi

  echo
  echo '=== 本次部署配置 ==='
  echo "  数据库: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  echo "  LLM provider: ${SELECTED_PROVIDERS}"
  echo "  管理员: ${ADMIN_USERNAME}"
  echo "  端口: 服务端 ${SERVER_PORT} / Web ${WEB_PORT}"
  if [ "$resumed" = 1 ]; then
    log '将续跑未完成的步骤（已完成的自动跳过）'
  else
    confirm '确认以上配置并开始安装？' || { echo '已取消。' >&2; exit 1; }
  fi

  step_run ensure_node NODE

  # node 就绪后：若尚未保存输入则生成密钥并保存（此后失败即可续跑）
  if ! state_has INPUTS; then
    log '生成随机密钥（LLM 配置加密 / JWT）...'
    LLM_ENC_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    save_inputs
    state_set INPUTS done
  fi

  step_run ensure_mysql MYSQL
  step_run write_env ENV
  step_run apply_llm_yaml YAML
  step_run build_server BUILD_SERVER
  step_run build_web BUILD_WEB
  step_run seed SEED
  step_run start_and_check START

  print_summary
}

main "$@"
