#!/usr/bin/env python3
"""语文「做题要求作题干」定向回填（2026-11-21 用户裁决）。

形态：原卷是「做题要求（引导语+分值）→ 材料+注释 → 填充语段」。
此前 splitter 把「要求+材料+注释」放进 material_text、填充语段当 content，
页面上变成语段在上、要求在下。本脚本把两段搬运到正确位置：

    content       ← material_text 的首行（做题要求）
    material_text ← material_text 其余全文 + 填充语段（原 content）

默认 dry-run；`--apply` 才写库。只改 content / material_text / content_hash 三列，
其余列逐行 MD5 比对不变；写回滚 SQL 到 backups/；按现有口径重算 content_hash。
幂等：回填后 material_text 首行不再是做题要求，重跑自然 0 行。

    python3 tools/db/lead_stem_backfill.py
    python3 tools/db/lead_stem_backfill.py --apply
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from datetime import datetime
from pathlib import Path

import pymysql
from pymysql.converters import escape_string

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "data-refinery" / "src"))

from chinese_material_doc import rewrite_hash_for_row  # noqa: E402
from subject_strategies.chinese_inline_material import _LEAD_PARA_RE  # noqa: E402

DB = dict(host="localhost", port=3306, user="ai_k12", password="ai_k12",
          database="ai_k12", charset="utf8mb4")
BACKUP = Path(__file__).resolve().parent / "backups" / "20261121_lead_stem_rollback.sql"
TOUCHED = ("content", "material_text", "content_hash")


def _sql_literal(value) -> str:
    if value is None:
        return "NULL"
    return "'" + escape_string(str(value)) + "'"


def _norm(s: str) -> str:
    import re
    return re.sub(r"\s+", "", s or "")


def _fingerprint(row: dict) -> str:
    """未触碰列的 MD5：任何一列被动到都判失败。"""
    payload = "\x1f".join(
        f"{k}={row[k]}" for k in sorted(row) if k not in TOUCHED
    )
    return hashlib.md5(payload.encode("utf-8")).hexdigest()


def _plan(conn) -> list[dict]:
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(
            "SELECT q.* FROM questions q JOIN subjects s ON s.id=q.subject_id "
            "WHERE s.code='chinese' AND q.material_text IS NOT NULL"
        )
        rows = cur.fetchall()
    todo = []
    for row in rows:
        first, *tail = row["material_text"].split("\n")
        if not _LEAD_PARA_RE.match(first.strip()):
            continue
        material = "\n".join(tail).strip()
        old_stem = (row["content"] or "").strip()
        if not material or not old_stem:
            continue
        new_material = material + "\n\n" + old_stem
        if _norm(first) + _norm(new_material) != _norm(row["material_text"]) + _norm(row["content"]):
            raise RuntimeError(f"q{row['id']}: 搬运后内容不守恒，跳过整批")
        new = dict(row)
        new["content"] = first.strip()
        new["material_text"] = new_material
        new["content_hash"] = rewrite_hash_for_row(new)
        todo.append({"old": row, "new": new, "before_md5": _fingerprint(row)})
    return todo


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="落库（默认只 dry-run）")
    args = ap.parse_args()

    conn = pymysql.connect(**DB, autocommit=False)
    try:
        todo = _plan(conn)
        print(f"待回填 {len(todo)} 行（做题要求作题干）")
        for item in todo:
            old, new = item["old"], item["new"]
            print(f"  q{old['id']}: content ← {new['content'][:48]}")
            print(f"    material_text ← {new['material_text'][:48]} …（+填充语段）")

        if not args.apply or not todo:
            conn.rollback()
            return

        lines = [f"-- run {datetime.now().isoformat(timespec='seconds')} -- lead_stem_backfill"]
        with conn.cursor() as cur:
            for item in todo:
                old, new = item["old"], item["new"]
                cur.execute("SELECT * FROM questions WHERE id=%s", (old["id"],))
                current = cur.fetchone()
                cols = [d[0] for d in cur.description]
                current_row = dict(zip(cols, current))
                if _fingerprint(current_row) != item["before_md5"]:
                    raise RuntimeError(f"q{old['id']}: 未触碰列发生变化，中止整批")
                lines.append(
                    f"UPDATE questions SET content={_sql_literal(old['content'])}, "
                    f"material_text={_sql_literal(old['material_text'])}, "
                    f"content_hash={_sql_literal(old['content_hash'])} "
                    f"WHERE id={old['id']};"
                )
                try:
                    cur.execute(
                        "UPDATE questions SET content=%s, material_text=%s, content_hash=%s WHERE id=%s",
                        (new["content"], new["material_text"], new["content_hash"], old["id"]),
                    )
                except pymysql.err.IntegrityError:
                    # 唯一键冲突：保留旧 hash，其余两列照常写（与 material_doc_backfill 同口径）
                    cur.execute(
                        "UPDATE questions SET content=%s, material_text=%s WHERE id=%s",
                        (new["content"], new["material_text"], old["id"]),
                    )
                    print(f"  q{old['id']}: content_hash 冲突，保留旧值")
        conn.commit()
        BACKUP.parent.mkdir(parents=True, exist_ok=True)
        with BACKUP.open("a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        print(f"已写库；回滚 SQL → {BACKUP.relative_to(ROOT)}")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
