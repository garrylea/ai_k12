#!/usr/bin/env bash
#
# K12 智学系统 — MySQL 自动化安装与数据库初始化脚本
#
# 功能：
#   1. 检测当前系统是否已安装 MySQL，以及版本是否满足设计文档要求。
#   2. 若未安装或版本过低，则调用系统包管理器自动安装/升级。
#   3. 启动 MySQL 服务。
#   4. 创建业务数据库与用户。
#   5. 执行 schema.sql 初始化表结构、索引与触发器，并写入基础种子数据（subjects，见 schema.sql 末尾 INSERT IGNORE）。
#
# 设计文档约定：
#   - 数据库：MySQL 9.7.1 LTS（文档版本 v1.2）
#   - 命名：snake_case，表名为复数名词
#   - 字符集：utf8mb4
#
# 注意：
#   MySQL 9.x 属于 Innovation Release，并非 LTS。文档中 "MySQL 9.7.1 LTS"
#   的写法与 Oracle 官方发行策略不符。本脚本默认仍以文档所述版本为目标，
#   但会通过包管理器安装其仓库中可用的最新版本。若需固定到真实 LTS，
#   请修改 TARGET_VERSION 为 "8.4.0" 或 "8.0.40"。
#
# 用法：
#   ./install_mysql.sh [选项]
#
# 选项：
#   -d, --db-name NAME          数据库名（默认：ai_k12）
#   -u, --db-user USER          业务用户名（默认：ai_k12）
#   -p, --db-pass PASS          业务用户密码（默认：随机生成）
#   -r, --root-pass PASS        MySQL root 密码（默认：空密码尝试）
#   -t, --target-version VER    目标 MySQL 版本（默认：9.7.1）
#   -s, --schema FILE           schema SQL 文件路径（默认：与本脚本同目录的 schema.sql）
#       --dry-run               仅打印将要执行的操作，不实际运行
#   -h, --help                  显示帮助
#

set -euo pipefail

TARGET_VERSION="9.7.1"
DB_NAME="ai_k12"
DB_USER="ai_k12"
DB_PASS=""
ROOT_PASS=""
SCHEMA_FILE=""
DRY_RUN=0
MYSQL_CLI=(mysql)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

error() {
  echo "[ERROR] $*" >&2
  exit 1
}

usage() {
  sed -n '2,35p' "$0" | sed 's/^# //' | sed 's/^#//'
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -d|--db-name)
        DB_NAME="$2"
        shift 2
        ;;
      -u|--db-user)
        DB_USER="$2"
        shift 2
        ;;
      -p|--db-pass)
        DB_PASS="$2"
        shift 2
        ;;
      -r|--root-pass)
        ROOT_PASS="$2"
        shift 2
        ;;
      -t|--target-version)
        TARGET_VERSION="$2"
        shift 2
        ;;
      -s|--schema)
        SCHEMA_FILE="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        error "未知参数: $1"
        ;;
    esac
  done

  if [[ -z "$SCHEMA_FILE" ]]; then
    SCHEMA_FILE="${SCRIPT_DIR}/schema.sql"
  fi

  if [[ -z "$DB_PASS" ]]; then
    # od 读取有限字节，避免 tr 因 /dev/urandom 无限流被 SIGPIPE 中断
    DB_PASS=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
  fi
}

detect_os() {
  local kernel
  kernel=$(uname -s)
  case "$kernel" in
    Darwin)
      echo "macos"
      ;;
    Linux)
      if [[ -f /etc/os-release ]]; then
        # shellcheck source=/dev/null
        source /etc/os-release
        case "$ID" in
          ubuntu|debian|linuxmint|pop)
            echo "debian"
            ;;
          fedora|rhel|centos|rocky|almalinux|ol)
            echo "rhel"
            ;;
          *)
            error "不支持的 Linux 发行版: $ID"
            ;;
        esac
      else
        error "无法识别 Linux 发行版"
      fi
      ;;
    *)
      error "不支持的操作系统: $kernel"
      ;;
  esac
}

# 提取语义化版本号（例如 "8.4.3"），忽略构建号
get_mysql_version() {
  local version_line
  if command -v mysql >/dev/null 2>&1; then
    version_line=$(mysql --version 2>/dev/null || true)
    echo "$version_line" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true
  else
    echo ""
  fi
}

# 比较版本号：v1 >= v2 返回 0
version_gte() {
  local v1="$1"
  local v2="$2"
  if [[ "$v1" == "$v2" ]]; then
    return 0
  fi
  # sort -V 按版本号排序，-C 静默比较
  if printf '%s\n%s\n' "$v2" "$v1" | sort -V -C; then
    return 0
  fi
  return 1
}

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[DRY-RUN] $*"
  else
    log "执行: $*"
    "$@"
  fi
}

run_cmd_silent() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[DRY-RUN] $*"
  else
    "$@"
  fi
}

install_mysql() {
  local os="$1"
  log "开始安装 MySQL（目标版本参考: ${TARGET_VERSION}）..."
  case "$os" in
    macos)
      if ! command -v brew >/dev/null 2>&1; then
        error "macOS 上需要 Homebrew，请先安装：https://brew.sh"
      fi
      run_cmd brew update
      run_cmd brew install mysql
      ;;
    debian)
      run_cmd sudo apt-get update
      # 尝试安装指定主版本；若仓库无此版本，apt 会报错，这里回退到默认 mysql-server
      if apt-cache show mysql-server="${TARGET_VERSION}"* >/dev/null 2>&1; then
        run_cmd sudo apt-get install -y "mysql-server=${TARGET_VERSION}*"
      else
        log "仓库中未找到 MySQL ${TARGET_VERSION}，将安装默认版本"
        run_cmd sudo apt-get install -y mysql-server
      fi
      ;;
    rhel)
      run_cmd sudo dnf update -y || run_cmd sudo yum update -y
      if sudo dnf list available mysql-server-"${TARGET_VERSION}"* >/dev/null 2>&1; then
        run_cmd sudo dnf install -y "mysql-server-${TARGET_VERSION}*"
      else
        log "仓库中未找到 MySQL ${TARGET_VERSION}，将安装默认版本"
        run_cmd sudo dnf install -y mysql-server || run_cmd sudo yum install -y mysql-server
      fi
      ;;
  esac
}

upgrade_mysql() {
  local os="$1"
  log "开始升级 MySQL（目标版本参考: ${TARGET_VERSION}）..."
  case "$os" in
    macos)
      run_cmd brew update
      run_cmd brew upgrade mysql || true
      ;;
    debian)
      run_cmd sudo apt-get update
      if apt-cache show mysql-server="${TARGET_VERSION}"* >/dev/null 2>&1; then
        run_cmd sudo apt-get install -y "mysql-server=${TARGET_VERSION}*"
      else
        run_cmd sudo apt-get install -y mysql-server
      fi
      ;;
    rhel)
      run_cmd sudo dnf update -y mysql-server || run_cmd sudo yum update -y mysql-server || true
      ;;
  esac
}

start_mysql_service() {
  local os="$1"
  log "启动 MySQL 服务..."
  case "$os" in
    macos)
      if [[ "$DRY_RUN" -eq 0 ]]; then
        if ! brew services list | grep -q "mysql.*started"; then
          run_cmd brew services start mysql
        else
          log "MySQL 服务已在运行"
        fi
      else
        run_cmd brew services start mysql
      fi
      ;;
    debian)
      run_cmd sudo systemctl start mysql
      run_cmd sudo systemctl enable mysql
      ;;
    rhel)
      run_cmd sudo systemctl start mysqld
      run_cmd sudo systemctl enable mysqld
      ;;
  esac
}

# 尝试找到可用的 mysql 客户端调用方式
resolve_mysql_cli() {
  local os="$1"
  MYSQL_CLI=(mysql -u root)

  if [[ -n "$ROOT_PASS" ]]; then
    MYSQL_CLI+=("-p${ROOT_PASS}")
  fi

  # Linux 上 root 默认可能使用 auth_socket，先尝试 sudo
  if [[ "$os" != "macos" ]]; then
    if ! run_cmd_silent "${MYSQL_CLI[@]}" -e "SELECT 1" >/dev/null 2>&1; then
      if sudo mysql -e "SELECT 1" >/dev/null 2>&1; then
        MYSQL_CLI=(sudo mysql)
        log "使用 sudo mysql 作为 root 客户端"
      fi
    fi
  fi
}

mysql_exec() {
  local sql="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[DRY-RUN] mysql -e \"$sql\""
  else
    "${MYSQL_CLI[@]}" -e "$sql"
  fi
}

setup_database() {
  log "创建数据库与用户..."
  mysql_exec "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  mysql_exec "CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';"
  mysql_exec "GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';"
  mysql_exec "FLUSH PRIVILEGES;"
}

apply_schema() {
  if [[ ! -f "$SCHEMA_FILE" ]]; then
    error "找不到 schema 文件: $SCHEMA_FILE"
  fi
  log "执行 schema 文件: $SCHEMA_FILE"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[DRY-RUN] mysql ${DB_NAME} < ${SCHEMA_FILE}"
  else
    "${MYSQL_CLI[@]}" "${DB_NAME}" < "$SCHEMA_FILE"
  fi
}

print_summary() {
  echo
  echo "========================================"
  echo "数据库初始化完成"
  echo "========================================"
  echo "数据库名: ${DB_NAME}"
  echo "业务用户: ${DB_USER}"
  echo "业务密码: ${DB_PASS}"
  echo "MySQL 版本: $(get_mysql_version)"
  echo "Schema 文件: ${SCHEMA_FILE}"
  echo "========================================"
}

main() {
  parse_args "$@"

  local os
  os=$(detect_os)
  log "检测到操作系统: $os"

  local installed_version
  installed_version=$(get_mysql_version)

  if [[ -z "$installed_version" ]]; then
    log "未检测到 MySQL，将执行安装"
    install_mysql "$os"
  elif version_gte "$installed_version" "$TARGET_VERSION"; then
    log "MySQL 已安装且版本满足要求: $installed_version >= $TARGET_VERSION"
  else
    log "MySQL 版本过低: $installed_version < ${TARGET_VERSION}，将执行升级"
    upgrade_mysql "$os"
  fi

  start_mysql_service "$os"
  resolve_mysql_cli "$os"
  setup_database
  apply_schema

  if [[ "$DRY_RUN" -eq 0 ]]; then
    print_summary
  else
    log "干跑模式结束，未执行实际修改"
  fi
}

main "$@"
