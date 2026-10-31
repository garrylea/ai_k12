"""把人工补的题统一写入 MySQL（scripts/fix_question_cli.py 的产物）。

规则：
- 以 (paper_id, group_order) 定位题目；该题号已有行 → 原址更新，没有 → 新增并挂到卷上；
- 人工确认过的题一律 `is_active=1`、`needs_review=0`（人工就是那道复核门）；
- 写完后按 group_order 重排该卷的 question_no，保证卷内顺序与卷面题号一致；
- 幂等：`applied=true` 的记录跳过，重复执行不会插重。

用法：
    python3 scripts/apply_fixes_cli.py --dry-run      # 预览会改哪些题
    python3 scripts/apply_fixes_cli.py --apply        # 真正写库
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import pymysql  # noqa: E402

from config import RefineryConfig  # noqa: E402
from db_loader import content_hash  # noqa: E402
from subject_codes import subject_code_for_parts  # noqa: E402

FIXES_DIR = ROOT / "output" / "manual_fixes"


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def _subject_id(cur, rel_path: str) -> int | None:
    code = subject_code_for_parts(Path(rel_path).parts, default="")
    if not code:
        return None
    cur.execute("SELECT id FROM subjects WHERE code=%s", (code,))
    row = cur.fetchone()
    return int(row[0]) if row else None


def _paper_row(cur, rel_path: str, source: str) -> tuple[int, int] | None:
    """返回 (paper_id, subject_id)；按 source_key 精确匹配。"""
    key = f"{rel_path}/{source}"
    cur.execute("SELECT id, subject_id FROM exam_papers WHERE source_key=%s", (key,))
    row = cur.fetchone()
    if row:
        return int(row[0]), int(row[1])
    return None


def _existing_question(cur, paper_id: int, group_order: int) -> int | None:
    cur.execute(
        "SELECT question_id FROM paper_questions WHERE paper_id=%s AND group_order=%s",
        (paper_id, group_order))
    row = cur.fetchone()
    return int(row[0]) if row else None


def _renumber(cur, paper_id: int) -> int:
    """按卷面题号重排 question_no，返回受影响行数。

    与 db_loader 同一口径：`question_no = COALESCE(group_order, 行序)`，
    所以补回缺题后题号会对上（而不是把空缺挤掉、整卷顺序错位）。
    """
    cur.execute(
        "UPDATE paper_questions pq JOIN ("
        "  SELECT question_id, ROW_NUMBER() OVER (ORDER BY group_order, question_no) rn"
        "  FROM paper_questions WHERE paper_id=%s) t"
        " ON t.question_id = pq.question_id "
        "SET pq.question_no = COALESCE(pq.group_order, t.rn) "
        "WHERE pq.paper_id=%s",
        (paper_id, paper_id))
    return cur.rowcount


def apply_record(cur, rec: dict, apply: bool) -> str:
    found = _paper_row(cur, rec["rel_path"], rec["source"])
    if not found:
        return "跳过：库里没有这份卷（先跑 import_cli 入库）"
    paper_id, subject_id = found
    go = int(rec["group_order"])
    qid = _existing_question(cur, paper_id, go)
    action = "更新" if qid else "新增"

    if not apply:
        return f"{action}：paper={paper_id} 第{go}题（question_id={qid or '—'}）"

    chash = content_hash(rec["content"], rec.get("options"))
    options = rec.get("options")
    if qid:
        cur.execute(
            "UPDATE questions SET content=%s, options=%s, answer=%s, material_text=%s, "
            "content_hash=%s, is_active=1 WHERE id=%s",
            (rec["content"],
             json.dumps(options, ensure_ascii=False) if options else None,
             rec.get("answer") or "", rec.get("material_text"), chash, qid))
    else:
        cur.execute(
            "INSERT INTO questions (subject_id, group_order, type, difficulty, content, options, "
            "answer, material_text, grade_band, source, source_year, content_hash, is_active) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)",
            (subject_id, go, "choice" if options else "short_answer", 2,
             rec["content"],
             json.dumps(options, ensure_ascii=False) if options else None,
             rec.get("answer") or "", rec.get("material_text"),
             "junior", rec["source"], 2024, chash))
        qid = int(cur.lastrowid)
        cur.execute(
            "INSERT IGNORE INTO paper_questions (paper_id, question_id, question_no, group_order) "
            "VALUES (%s,%s,%s,%s)", (paper_id, qid, go, go))

    _renumber(cur, paper_id)
    cur.execute("UPDATE exam_papers SET question_count=(SELECT COUNT(*) FROM paper_questions "
                "WHERE paper_id=%s) WHERE id=%s", (paper_id, paper_id))
    return f"{action}：paper={paper_id} 第{go}题 -> question_id={qid}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixes-dir", default=str(FIXES_DIR))
    parser.add_argument("--subject", help="学科中文名过滤（按 rel_path 首段）")
    parser.add_argument("--apply", action="store_true", help="真正写库（默认只预览）")
    parser.add_argument("--dry-run", action="store_true", help="只预览（与默认行为一致，便于显式声明）")
    parser.add_argument("--force", action="store_true", help="连 applied=true 的记录也重放")
    args = parser.parse_args()
    if args.apply and args.dry_run:
        parser.error("--apply 与 --dry-run 互斥")

    files = sorted(Path(args.fixes_dir).glob("*.jsonl"))
    if not files:
        print(f"[done] {args.fixes_dir} 下没有补题记录")
        return 0

    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
                           autocommit=False)
    total = 0
    try:
        with conn.cursor() as cur:
            for f in files:
                rows = _read_jsonl(f)
                todo = [r for r in rows if args.force or not r.get("applied")]
                if args.subject:
                    todo = [r for r in todo if Path(r["rel_path"]).parts[0] == args.subject]
                for rec in todo:
                    msg = apply_record(cur, rec, args.apply)
                    print(f"[{rec['source'][:26]}] 题{rec['group_order']}: {msg}")
                    if args.apply and not msg.startswith("跳过"):
                        rec["applied"] = True
                        rec["applied_at"] = datetime.now().isoformat(timespec="seconds")
                        total += 1
                if args.apply:
                    _write_jsonl(f, rows)
        if args.apply:
            conn.commit()
            print(f"\n[ok] 已写入 {total} 题")
        else:
            conn.rollback()
            print(f"\n[dry-run] 预览 {total or '—'} 条；确认后加 --apply")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
