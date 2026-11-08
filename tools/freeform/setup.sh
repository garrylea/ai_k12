#!/usr/bin/env bash
# 做题入口（freeform）一条命令交付：环境检查 + 路由/索引迁移 + schema 对账。
# 幂等，可重复执行。用法：bash tools/freeform/setup.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE="apps/server/.env"
MIGRATION="tools/db/migrations/2026-11-08_freeform_routes.sql"

echo "== 0/4 读取 apps/server/.env =="
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE" || echo "警告：$ENV_FILE 解析异常，继续用已有环境变量"
  set +a
  echo "已加载 $ENV_FILE"
else
  echo "未找到 $ENV_FILE，改用当前 shell 环境变量"
fi

echo "== 1/4 检查 MinerU =="
MINERU_BIN="${MINERU_BIN:-mineru-open-api}"
if ! command -v "$MINERU_BIN" >/dev/null 2>&1; then
  echo "未找到 ${MINERU_BIN}。请先：pip install mineru && mineru-open-api auth"
  exit 1
fi

echo "== 2/4 检查 MINERU_TOKEN =="
TOKEN="${MINERU_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$ENV_FILE" ]]; then
  TOKEN="$(grep -E '^MINERU_TOKEN=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
fi
if [[ -z "$TOKEN" ]]; then
  echo "MINERU_TOKEN 未配置。到 https://mineru.net/apiManage/token 获取 sk- 开头的 Key，写入 apps/server/.env"
  exit 1
fi

echo "== 3/4 应用路由迁移 =="
if ! command -v mysql >/dev/null 2>&1; then
  echo "未找到 mysql 客户端。请先安装 MySQL 客户端后重试。"
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "未找到迁移文件 $MIGRATION"
  exit 1
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-ai_k12}"
# 仓库 .env 用 DB_PASS；兼容 MySQL 惯用的 DB_PASSWORD
DB_PASSWORD="${DB_PASSWORD:-${DB_PASS:-}}"
DB_NAME="${DB_NAME:-ai_k12}"

if [[ -n "$DB_PASSWORD" ]]; then
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < "$MIGRATION"
else
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" < "$MIGRATION"
fi
echo "迁移已应用（freeform_split / freeform_judge + idx_uf_uploader_url）"

echo "== 4/4 schema 对账 =="
python3 tools/db/schema_reconcile.py

echo
echo "完成。请重启后端（在 apps/server 下）：node dist/main.js"
