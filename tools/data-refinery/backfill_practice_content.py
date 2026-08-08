"""一次性脚本：对前 N 条 practice 卡，用 content_metadata.groups 重组 content。

用法：python backfill_practice_content.py [--limit 5] [--dry-run]

- --limit N：只处理前 N 条（默认 5）
- --dry-run：只打印对比，不写 DB
"""

import argparse
import json
import os
import sys

import pymysql
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

load_dotenv()

from db_loader import rebuild_practice_content  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    conn = pymysql.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "ai_k12"),
        password=os.getenv("DB_PASSWORD", "ai_k12"),
        database=os.getenv("DB_NAME", "ai_k12"),
        charset="utf8mb4",
    )

    cur = conn.cursor()
    cur.execute(
        "SELECT id, content, content_metadata FROM cards WHERE card_type='practice' ORDER BY id LIMIT %s",
        (args.limit,),
    )
    rows = cur.fetchall()
    print(f"找到 {len(rows)} 条 practice 卡\n")

    updated = 0
    for cid, old_content, cm_json in rows:
        cm = json.loads(cm_json) if cm_json else {}
        groups = cm.get("groups")
        needs_fallback = cm.get("needs_fallback", False)

        if not groups:
            print(f"[SKIP] ID={cid}: 无 groups 元数据")
            continue
        if needs_fallback:
            print(f"[SKIP] ID={cid}: needs_fallback=True（groups 校验未通过）")
            continue

        new_content = rebuild_practice_content(groups)

        if new_content == old_content:
            print(f"[SKIP] ID={cid}: content 无需变更（已为重组格式）")
            continue

        # 打印对比
        old_lines = old_content.count("\n") + 1
        new_lines = new_content.count("\n") + 1
        n_qs = sum(len(g.get("questions", [])) for g in groups)
        print(f"--- ID={cid} ---")
        print(f"  groups: {len(groups)} 组, questions: {n_qs} 题")
        print(f"  content 行数: {old_lines} -> {new_lines}")
        print(f"  [旧] 前 150 字: {old_content[:150]}")
        print(f"  [新] 前 150 字: {new_content[:150]}")
        print()

        if not args.dry_run:
            cur.execute(
                "UPDATE cards SET content=%s WHERE id=%s",
                (new_content, cid),
            )
            updated += 1

    if not args.dry_run and updated > 0:
        conn.commit()
        print(f"已更新 {updated} 条记录")
    elif args.dry_run:
        print(f"[DRY RUN] 以上为预览，未写入 DB。去掉 --dry-run 执行写入")

    conn.close()


if __name__ == "__main__":
    main()
