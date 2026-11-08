#!/usr/bin/env bash
# 做题入口（freeform）一条命令交付：加载环境 → 路由/索引迁移 → schema 对账 → MinerU 预检（仅告警）。
# 幂等，可重复执行。用法：bash tools/freeform/setup.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE="apps/server/.env"
MIGRATION="tools/db/migrations/2026-11-08_freeform_routes.sql"

echo "== 1/4 读取 apps/server/.env =="
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE" || echo "警告：$ENV_FILE 解析异常，继续用已有环境变量"
  set +a
  echo "已加载 $ENV_FILE"
else
  echo "未找到 $ENV_FILE，改用当前 shell 环境变量"
fi

echo "== 2/4 应用路由迁移 =="
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

echo "== 3/4 schema 对账 =="
# schema_reconcile.py 无论有无差异都 exit 0，故以输出里的成功行为判据。
set +e
RECON_OUT="$(python3 tools/db/schema_reconcile.py 2>&1)"
RECON_RC=$?
set -e
printf '%s\n' "$RECON_OUT"
if [[ $RECON_RC -ne 0 || "$RECON_OUT" != *"结构差异: 无"* ]]; then
  echo "schema 对账有差异，见上；已停止，请先处理差异"
  exit 1
fi

echo "== 4/4 MinerU 预检（仅告警）=="
# MinerU 只在识题运行时用到，缺 CLI / token 不影响迁移结果，故这里不中断。
MINERU_BIN="${MINERU_BIN:-mineru-open-api}"
if ! command -v "$MINERU_BIN" >/dev/null 2>&1; then
  echo "警告：未找到 ${MINERU_BIN}，识题功能运行时才会失败。需要时执行：pip install mineru && mineru-open-api auth"
elif [[ -z "${MINERU_TOKEN:-}" ]]; then
  echo "警告：MINERU_TOKEN 未配置，识题功能运行时才会失败。到 https://mineru.net/apiManage/token 获取 sk- 开头的 Key，写入 $ENV_FILE"
else
  echo "MinerU 预检通过（${MINERU_BIN} 可用，MINERU_TOKEN 已配置）"
fi

echo
echo "完成。请重启后端（在 apps/server 下）：node dist/main.js"
