"""一次性迁移脚本：将 practice 卡的扁平 content_metadata 包装为 groups 结构。

旧结构：{"intro": "...", "questions": [...], "images": [...], ...}
新结构：{"groups": [{"intro": "...", "questions": [...]}], "images": [...], ...}

幂等：已有 groups 的卡跳过。
"""

import json
import os
import sys

import pymysql
from dotenv import load_dotenv

load_dotenv()


def main():
    conn = pymysql.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "ai_k12"),
        password=os.getenv("DB_PASS", "ai_k12"),  # 与 config.py 一致用 DB_PASS（曾误用 DB_PASSWORD，仅默认值撞对才工作）
        database=os.getenv("DB_NAME", "ai_k12"),
        charset="utf8mb4",
    )

    cur = conn.cursor()
    cur.execute(
        "SELECT id, content_metadata FROM cards WHERE card_type='practice' ORDER BY id"
    )
    rows = cur.fetchall()
    print(f"找到 {len(rows)} 张 practice 卡")

    updated = 0
    skipped = 0

    for card_id, cm_json in rows:
        if not cm_json:
            skipped += 1
            continue

        try:
            md = json.loads(cm_json)
        except (json.JSONDecodeError, TypeError):
            print(f"[WARN] card id={card_id}: content_metadata 非合法 JSON，跳过")
            skipped += 1
            continue

        # 幂等：已有 groups 则跳过
        if "groups" in md:
            skipped += 1
            continue

        # 无 intro/questions 也无需迁移
        if "questions" not in md and "intro" not in md:
            skipped += 1
            continue

        # 包装为 groups 结构
        group: dict = {}
        if md.get("intro"):
            group["intro"] = md["intro"]
        if md.get("questions"):
            group["questions"] = md["questions"]

        new_md = {k: v for k, v in md.items() if k not in ("intro", "questions")}
        if group.get("questions"):
            new_md["groups"] = [group]

        cur.execute(
            "UPDATE cards SET content_metadata=%s WHERE id=%s",
            (json.dumps(new_md, ensure_ascii=False), card_id),
        )
        updated += 1
        n_qs = len(group.get("questions", []))
        print(f"[ok] card id={card_id}: wrapped {n_qs} questions into 1 group")

    conn.commit()
    conn.close()
    print(f"\n迁移完成：updated={updated}, skipped={skipped}, total={len(rows)}")


if __name__ == "__main__":
    main()
