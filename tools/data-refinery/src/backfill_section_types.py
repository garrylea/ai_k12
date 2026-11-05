"""按大题区间回填题型（存量数据）：以 md 的大题标题为准，逐卷覆盖 questions.type。

用法：
    python3 src/backfill_section_types.py            # dry-run
    python3 src/backfill_section_types.py --apply
    python3 src/backfill_section_types.py --subject 物理 --apply
"""

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

import pymysql  # noqa: E402

from config import RefineryConfig  # noqa: E402
from section_analyzer import analyze_sections  # noqa: E402
from subject_codes import subject_code_for_parts  # noqa: E402

MD_ROOT = ROOT / "output" / "md"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--subject", help="学科中文名过滤（按 source_key 首段）")
    args = ap.parse_args()

    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name,
                           charset="utf8mb4", autocommit=False)
    total = 0
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, source_key FROM exam_papers ORDER BY id")
            papers = cur.fetchall()
            for paper_id, key in papers:
                if args.subject and key.split("/")[0] != args.subject:
                    continue
                md = MD_ROOT / f"{key}.md"
                if not md.exists():
                    continue
                subject = subject_code_for_parts(Path(key).parts, default="")
                mapping, sections = analyze_sections(
                    md.read_text(encoding="utf-8", errors="ignore"), subject)
                if not mapping:
                    continue
                cur.execute(
                    "SELECT q.id, pq.question_no, q.type FROM paper_questions pq "
                    "JOIN questions q ON q.id = pq.question_id WHERE pq.paper_id = %s",
                    (paper_id,))
                rows = cur.fetchall()
                changed = [(qid, no, old, mapping[no]) for qid, no, old in rows
                           if no in mapping and old != mapping[no]]
                if not changed:
                    continue
                detail = "，".join(
                    f"{s.gid}:{s.start_no}-{s.end_no}={s.type}{'(推断)' if s.inferred else ''}"
                    for s in sections)
                print(f"[{key.split('/')[-1][:34]}] {detail}")
                for qid, no, old, new in changed[:8]:
                    print(f"    题{no}: {old} -> {new}")
                if len(changed) > 8:
                    print(f"    …另有 {len(changed) - 8} 题")
                total += len(changed)
                if args.apply:
                    for qid, _no, _old, new in changed:
                        cur.execute("UPDATE questions SET type=%s WHERE id=%s", (new, qid))
        if args.apply:
            conn.commit()
            print(f"\n[ok] 已改 {total} 道题的题型")
        else:
            conn.rollback()
            print(f"\n[dry-run] 将改 {total} 道题；确认后加 --apply")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
