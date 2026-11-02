#!/usr/bin/env python3
"""物理/化学题内材料回填（B2，2026-11-02）。

把「材料 + (1)(2)(3) 小问」混在 `content` 里的题目，按规则切出材料：

    material_text  ← 材料段（含图/表）
    content        ← 小问段
    material_method← 'rule'

## 一条命令完成：备份 → 切分 → 写库 → 复查

    python3 tools/db/material_backfill.py

`--dry-run` 只打印不写（开发用）。

## 安全边界（项目铁律）

- **只处理 `material_text IS NULL` 的题**：语文/英语已有人工/管线材料的一律不动。
- **只写三列**：`material_text` / `content` / `material_method`；其他列前后 MD5 必须一致。
- **拼接自校验**：`material + rest == 原 content`（不 rstrip，构造上恒成立），不成立整题跳过。
- **备份**：写库前把受影响行的原值导出到 `tools/db/backups/`，可直接回滚。

## 为什么不含 LLM 兜底

实测 165 道物化题：规则命中 38 道（物理 26 / 化学 12）；其余是选择题（材料+选项，无小问，
不该切）或「一句话情境 + 小问」（材料段 < 60 字，切出来是碎块，也不该切）。
真正需要 LLM 判切点的题本次为 0。`material_split.needs_llm()` 谓词与留痕列已就位，
将来出现格式异常的小问编号时再接入 LLM 兜底，不影响本脚本。
"""

import argparse
import hashlib
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "data-refinery" / "src"))

from subject_strategies.material_split import split_material_rule  # noqa: E402

DB = dict(host="localhost", port=3306, user="ai_k12", password="ai_k12",
          database="ai_k12", charset="utf8mb4")
SUBJECTS = ("physics", "chemistry")
BACKUP_DIR = Path(__file__).resolve().parent / "backups"


def md5(s: str | None) -> str:
    return hashlib.md5((s or "").encode("utf-8")).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写库")
    args = ap.parse_args()

    conn = pymysql.connect(**DB)
    cur = conn.cursor()
    cur.execute("""
        SELECT q.id, s.code, q.type, q.content, q.material_text
          FROM questions q JOIN subjects s ON s.id = q.subject_id
         WHERE s.code IN (%s, %s) AND q.material_text IS NULL
         ORDER BY q.id
    """, SUBJECTS)
    rows = cur.fetchall()

    plan: list[tuple[int, str, str, str]] = []   # (id, material, rest, subject)
    skipped = 0
    for qid, subj, qtype, content, _mat in rows:
        material, rest = split_material_rule(content or "")
        if not material:
            skipped += 1
            continue
        # 拼接自校验：切片按定义应等原文；不等说明中途有人改过 content，跳过
        if material + rest != content:
            skipped += 1
            continue
        plan.append((qid, material, rest, subj))

    print(f"候选（material_text 为空）: {len(rows)} 题；可切分 {len(plan)} 题；跳过 {skipped}")
    by_subj: dict[str, int] = {}
    for _, _, _, subj in plan:
        by_subj[subj] = by_subj.get(subj, 0) + 1
    print("  按学科:", by_subj)

    if not plan:
        print("无需改动。")
        conn.close()
        return 0

    if args.dry_run:
        for qid, material, rest, subj in plan[:5]:
            print(f"--- id={qid} {subj} material={len(material)}字 rest={len(rest)}字 ---")
            print("  material.head:", material[:60].replace("\n", " | "))
            print("  rest.head   :", rest[:60].replace("\n", " | "))
        print("(dry-run，未写库)")
        conn.close()
        return 0

    # ---- 备份 ----
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup = BACKUP_DIR / "20261102_material_backfill_rollback.sql"
    with backup.open("w", encoding="utf-8") as f:
        f.write("-- 回滚：把 content 还原、material_text/material_method 清空\n")
        for qid, _material, _rest, _subj in plan:
            cur.execute("SELECT content FROM questions WHERE id=%s", (qid,))
            orig = cur.fetchone()[0]
            f.write(
                f"UPDATE questions SET content={conn.escape(orig)}, "
                f"material_text=NULL, material_method=NULL WHERE id={qid};\n"
            )
    print(f"备份已写入 {backup}")

    # ---- 写库（只写三列）----
    other_cols_before: dict[int, str] = {}
    guard_sql = """
        SELECT id, type, options, answer, explanation, approach, grade_band,
               source, source_year, content_hash, is_active, difficulty, full_score, group_id, group_order
          FROM questions WHERE id IN (%s)
    """
    ids = [p[0] for p in plan]
    cur.execute(guard_sql % ",".join(["%s"] * len(ids)), ids)
    for r in cur.fetchall():
        other_cols_before[r[0]] = md5("|".join("" if v is None else str(v) for v in r[1:]))

    for qid, material, rest, _subj in plan:
        cur.execute(
            "UPDATE questions SET material_text=%s, content=%s, material_method='rule' WHERE id=%s",
            (material, rest, qid),
        )

    # ---- 复查：其他列 MD5 不变 + 三列已写 ----
    cur.execute(guard_sql % ",".join(["%s"] * len(ids)), ids)
    changed = [r[0] for r in cur.fetchall()
               if other_cols_before.get(r[0]) != md5("|".join("" if v is None else str(v) for v in r[1:]))]

    cur.execute("""
        SELECT COUNT(*) FROM questions
         WHERE id IN (%s) AND material_text IS NOT NULL AND material_method='rule'
    """ % ",".join(["%s"] * len(ids)), ids)
    written = cur.fetchone()[0]

    conn.commit()
    print(f"已写 {written}/{len(ids)} 题；其他列变化 {len(changed)} 题 {changed[:5]}")
    if changed:
        print("⚠️ 其他列发生变化，请检查（回滚 SQL 见备份文件）")
        conn.close()
        return 2
    conn.close()
    print("复查通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
