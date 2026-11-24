#!/usr/bin/env bash
# 英语训练轨四模块（真题 / 专项 / 错题 / 薄弱点图谱）单一交付入口。
#
# 一条命令走完：读环境 → 预检 → 确认 → 幂等迁移 → 材料感知回填 → 测试与构建 → 复查断言。
# 非交互：SETUP_YES=1 bash tools/english-training/setup.sh（跳过唯一的确认步骤）。
#
# 注意：第 6 步的 npm run build 会覆盖 dist，正在跑的 dev server 需要自行重启。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 1/6 读取 apps/server/.env =="
ENV_FILE="apps/server/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE" || echo "警告：$ENV_FILE 解析异常，继续用已有环境变量"
  set +a
  echo "已加载 $ENV_FILE"
else
  echo "未找到 ${ENV_FILE}，改用当前 shell 环境变量"
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-ai_k12}"
# 仓库 .env 用 DB_PASS；兼容 MySQL 惯用的 DB_PASSWORD
DB_PASSWORD="${DB_PASSWORD:-${DB_PASS:-}}"
DB_NAME="${DB_NAME:-ai_k12}"

mysql_cli() {
  if [[ -n "$DB_PASSWORD" ]]; then
    mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" "$@"
  else
    mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" "$@"
  fi
}

MIGRATION="tools/db/migrations/2026-11-24_english_knowledge_points.sql"

echo "== 2/6 预检 =="
for cmd in mysql python3 node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "缺少命令：$cmd。请先安装后重试。" >&2
    exit 1
  fi
done
mysql_cli -e "SELECT COUNT(*) AS english_papers FROM exam_papers WHERE subject_id=3;" >/dev/null
[ -f "$MIGRATION" ] || { echo "缺少迁移文件：$MIGRATION" >&2; exit 1; }
[ -f tools/data-refinery/src/backfill_question_kps.py ] || { echo "缺少回填脚本" >&2; exit 1; }
echo "预检通过（mysql/python3/node/npm 可用，exam_papers 可读，迁移与回填脚本就位）"

echo "== 3/6 确认（仅此一步需要人） =="
if [ "${SETUP_YES:-0}" = "1" ]; then
  echo "SETUP_YES=1，跳过确认"
else
  read -r -p "将写入英语知识点种子并重跑标注，确认？[y/N] " ans \
    || { echo "非交互环境（stdin 已结束）无法确认。请用 SETUP_YES=1 bash tools/english-training/setup.sh" >&2; exit 1; }
  [ "$ans" = "y" ] || { echo "已取消"; exit 0; }
fi

echo "== 4/6 应用幂等迁移 =="
mysql_cli < "$MIGRATION"

echo "== 5/6 材料感知回填 =="
set +e
BACKFILL_OUT="$(cd tools/data-refinery && python3 src/backfill_question_kps.py \
  --subject english --include-material --answerable-only 2>&1)"
BACKFILL_RC=$?
set -e
printf '%s\n' "$BACKFILL_OUT"
if [[ $BACKFILL_RC -ne 0 ]]; then
  echo "回填失败（退出码 $BACKFILL_RC），已停止" >&2
  exit 1
fi
FAILED="$(printf '%s\n' "$BACKFILL_OUT" | sed -n 's/.*failed=\([0-9][0-9]*\).*/\1/p' | tail -n1)"
if [[ -n "$FAILED" && "$FAILED" != "0" ]]; then
  echo "回填有 $FAILED 题失败（见上方失败 id），已停止；重跑本脚本可补齐" >&2
  exit 1
fi

echo "== 6/6 测试与构建 =="
(cd apps/server && npx vitest run && npm run build)
(cd apps/web && npm test -- --run && npm run build)

echo "== 复查与断言 =="
KPS="$(mysql_cli -N -B -e "SELECT COUNT(*) FROM knowledge_points WHERE subject_id=3;")"
TAGGED="$(mysql_cli -N -B -e "
SELECT COUNT(DISTINCT q.id) FROM questions q
JOIN question_knowledge_points qkp ON qkp.question_id=q.id
WHERE q.subject_id=3 AND q.is_active=1 AND COALESCE(TRIM(q.answer),'')<>'';")"
printf 'knowledge_points(subject_id=3) = %s（期望 35）\n' "$KPS"
printf '在架有答案且已打标 = %s（期望 >= 70）\n' "$TAGGED"
if [[ "$KPS" != "35" ]]; then
  echo "断言失败：英语知识点应为 35 个，实际 $KPS" >&2
  exit 1
fi
if (( TAGGED < 70 )); then
  echo "断言失败：在架有答案且已打标应 >= 70，实际 $TAGGED" >&2
  exit 1
fi

echo "完成。启动后端请用：node dist/main.js"
echo "注意：npm run build 会覆盖 dev server 正在服务的 dist。"
