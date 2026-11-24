#!/usr/bin/env bash
# 英语训练轨四模块（真题 / 专项 / 错题 / 薄弱点图谱）单一交付入口。
#
# 一条命令走完：预检 → 确认 → 幂等迁移 → 材料感知回填 → 测试与构建 → 复查。
# 非交互：SETUP_YES=1 bash tools/english-training/setup.sh（跳过唯一的确认步骤）。
#
# 注意：第 5 步的 npm run build 会覆盖 dist，正在跑的 dev server 需要自行重启。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-ai_k12}"
DB_PASS="${DB_PASS:-ai_k12}"
DB_NAME="${DB_NAME:-ai_k12}"

mysql_cli() {
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" "$@"
}

MIGRATION="tools/db/migrations/2026-11-24_english_knowledge_points.sql"

echo "== 1/6 预检 =="
mysql_cli -e "SELECT COUNT(*) AS english_papers FROM exam_papers WHERE subject_id=3;" >/dev/null
[ -f "$MIGRATION" ] || { echo "缺少迁移文件：$MIGRATION"; exit 1; }
[ -f tools/data-refinery/src/backfill_question_kps.py ] || { echo "缺少回填脚本"; exit 1; }
echo "预检通过（exam_papers 可读、迁移与回填脚本就位）"

echo "== 2/6 确认（仅此一步需要人） =="
if [ "${SETUP_YES:-0}" = "1" ]; then
  echo "SETUP_YES=1，跳过确认"
else
  read -r -p "将写入英语知识点种子并重跑标注，确认？[y/N] " ans \
    || { echo "非交互环境（stdin 已结束）无法确认。请用 SETUP_YES=1 bash tools/english-training/setup.sh" >&2; exit 1; }
  [ "$ans" = "y" ] || { echo "已取消"; exit 0; }
fi

echo "== 3/6 应用幂等迁移 =="
mysql_cli < "$MIGRATION"

echo "== 4/6 材料感知回填 =="
(cd tools/data-refinery && python3 src/backfill_question_kps.py \
  --subject english --include-material --answerable-only)

echo "== 5/6 测试与构建 =="
(cd apps/server && npx vitest run && npm run build)
(cd apps/web && npm test -- --run && npm run build)

echo "== 6/6 复查 =="
mysql_cli -e "
SELECT (SELECT COUNT(*) FROM knowledge_points WHERE subject_id=3) AS kps,
       (SELECT COUNT(DISTINCT q.id) FROM questions q
        JOIN question_knowledge_points qkp ON qkp.question_id=q.id
        WHERE q.subject_id=3 AND q.is_active=1 AND COALESCE(TRIM(q.answer),'')<>'') AS tagged;"

echo "完成。启动后端请用：node dist/main.js"
echo "注意：npm run build 会覆盖 dev server 正在服务的 dist。"
