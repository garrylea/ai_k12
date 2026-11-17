"""存量题库页码标记清洗 CLI。

用法（cd tools/data-refinery）：

    python3 src/fix_page_markers_cli.py --apply --yes   # 预览 + 备份 + 写入 + 复查
    python3 src/fix_page_markers_cli.py --dry-run       # 只看不改

口径见 docs/superpowers/specs/2026-11-17-data-refinery-page-marker-cleanup-design.md：
只清 content / material_text / answer / explanation / approach 五个字段；
options 不动；content 变化时重算 content_hash，冲突整行跳过。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E402

import pymysql  # noqa: E402

from config import RefineryConfig  # noqa: E402
from db_loader import content_hash  # noqa: E402
from page_markers import PageMarkerHit, strip_page_markers  # noqa: E402

TEXT_FIELDS = ("content", "material_text", "answer", "explanation", "approach")


@dataclass(frozen=True)
class FieldFix:
    question_id: int
    field: str
    old: str
    new: str
    hits: tuple[PageMarkerHit, ...]


@dataclass(frozen=True)
class RowFix:
    question_id: int
    fields: dict[str, str] = field(default_factory=dict)
    new_content_hash: str | None = None
    paper_id: int | None = None
    question_no: int | None = None
    answer_verified: bool = False
    field_fixes: tuple[FieldFix, ...] = ()


def _connect(cfg: RefineryConfig):
    return pymysql.connect(
        host=cfg.db_host, port=cfg.db_port,
        user=cfg.db_user, password=cfg.db_pass,
        database=cfg.db_name, charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )


def _chunks(items: list[int], size: int = 1000):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def load_rows(conn, *, paper_id: int | None = None,
              subject_id: int | None = None, limit: int | None = None) -> list[dict]:
    sql = (
        "SELECT q.id, q.content, q.material_text, q.answer, q.explanation, "
        "q.approach, q.options, q.content_hash, q.answer_verified "
        "FROM questions q WHERE 1=1"
    )
    params: list = []
    if paper_id is not None:
        sql += (" AND EXISTS (SELECT 1 FROM paper_questions pq "
                "WHERE pq.question_id=q.id AND pq.paper_id=%s)")
        params.append(paper_id)
    if subject_id is not None:
        sql += " AND q.subject_id=%s"
        params.append(subject_id)
    sql += " ORDER BY q.id"
    if limit is not None:
        sql += " LIMIT %s"
        params.append(limit)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


def load_paper_map(conn, question_ids: list[int]) -> dict[int, tuple[int, int]]:
    """question_id -> (paper_id, question_no)；一题多卷取最小 (paper_id, question_no)。"""
    mapping: dict[int, tuple[int, int]] = {}
    ids = [int(x) for x in question_ids]
    for chunk in _chunks(ids):
        ph = ",".join(["%s"] * len(chunk))
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT question_id, paper_id, question_no FROM paper_questions "
                f"WHERE question_id IN ({ph})",
                chunk,
            )
            for row in cur.fetchall():
                qid = int(row["question_id"])
                pair = (int(row["paper_id"]), int(row["question_no"]))
                if qid not in mapping or pair < mapping[qid]:
                    mapping[qid] = pair
    return mapping


def resolve_subject_id(conn, subject: str) -> int | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM subjects WHERE code=%s OR name=%s ORDER BY id LIMIT 1",
            (subject, subject),
        )
        row = cur.fetchone()
    return int(row["id"]) if row else None


def _hash_exists(conn, new_hash: str, question_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM questions WHERE content_hash=%s AND id<>%s LIMIT 1",
            (new_hash, question_id),
        )
        return cur.fetchone() is not None


def _clip(text: str | None, limit: int = 80) -> str:
    s = (text or "").replace("\r", "\\r").replace("\n", "\\n")
    return s if len(s) <= limit else s[:limit] + "…"


def plan_fixes(rows: list[dict], paper_map: dict[int, tuple[int, int]],
               *, hash_exists=None) -> tuple[list[RowFix], list[str], list[str]]:
    """把待清洗行转成 RowFix。

    Returns:
        (row_fixes, manual_lines, conflict_lines)

    ``hash_exists(new_hash, question_id)`` 用于 content_hash 冲突检查；不传则只算不查。
    """
    row_fixes: list[RowFix] = []
    manual_lines: list[str] = []
    conflict_lines: list[str] = []

    for row in rows:
        qid = int(row["id"])
        changed: dict[str, str] = {}
        field_fixes: list[FieldFix] = []

        for name in TEXT_FIELDS:
            old = row.get(name) or ""
            if not old:
                continue
            new, hits = strip_page_markers(old)
            removed = [h for h in hits if h.removed]
            for h in hits:
                if not h.removed:
                    manual_lines.append(
                        f"id={qid} field={name} line={h.line_no}: {_clip(h.raw, 60)}"
                    )
            if not removed or new == old:
                continue
            changed[name] = new
            field_fixes.append(FieldFix(qid, name, old, new, tuple(removed)))

        if not changed:
            continue

        new_hash = None
        if "content" in changed:
            old_hash = row.get("content_hash")
            if old_hash:
                new_hash = content_hash(changed["content"], row.get("options"))
                if new_hash == old_hash:
                    new_hash = None
                elif hash_exists is not None and hash_exists(new_hash, qid):
                    conflict_lines.append(
                        f"id={qid} content_hash={new_hash[:8]}… 与其它题冲突，整行跳过"
                    )
                    continue

        paper_id, question_no = paper_map.get(qid, (None, None))
        row_fixes.append(RowFix(
            question_id=qid,
            fields=changed,
            new_content_hash=new_hash,
            paper_id=paper_id,
            question_no=question_no,
            answer_verified=bool(row.get("answer_verified")),
            field_fixes=tuple(field_fixes),
        ))

    return row_fixes, manual_lines, conflict_lines


def apply_fixes(conn, row_fixes: list[RowFix], *, backup_path: Path) -> int:
    """按 id 聚合写库；写入前先落备份。返回更新行数。"""
    if not row_fixes:
        return 0

    backup_path.parent.mkdir(parents=True, exist_ok=True)
    with backup_path.open("w", encoding="utf-8") as fh:
        for row in row_fixes:
            for ff in row.field_fixes:
                fh.write(json.dumps({
                    "question_id": ff.question_id,
                    "paper_id": row.paper_id,
                    "question_no": row.question_no,
                    "field": ff.field,
                    "old": ff.old,
                    "new": ff.new,
                    "hits": [asdict(h) for h in ff.hits],
                }, ensure_ascii=False) + "\n")

    try:
        conn.begin()
        with conn.cursor() as cur:
            for row in row_fixes:
                sets: list[str] = []
                params: list = []
                for name, value in row.fields.items():
                    sets.append(f"{name}=%s")
                    params.append(value)
                if row.new_content_hash is not None:
                    sets.append("content_hash=%s")
                    params.append(row.new_content_hash)
                params.append(row.question_id)
                cur.execute(
                    f"UPDATE questions SET {', '.join(sets)} WHERE id=%s",
                    params,
                )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return len(row_fixes)


def verify(conn, *, paper_id: int | None = None,
           subject_id: int | None = None,
           limit: int | None = None) -> tuple[int, list[str]]:
    """复查：返回 (仍可自动清理的行数, manual 清单)。"""
    rows = load_rows(conn, paper_id=paper_id, subject_id=subject_id, limit=limit)
    paper_map = load_paper_map(conn, [int(r["id"]) for r in rows])
    fixes, manual, _ = plan_fixes(rows, paper_map)
    return len(fixes), manual


def _print_preview(row_fixes: list[RowFix], conflicts: list[str],
                   manual: list[str]) -> None:
    field_count = sum(len(r.field_fixes) for r in row_fixes)
    print(f"[scan] 扫描 5 个文本字段：命中 {len(row_fixes)} 行 / {field_count} 个字段",
          flush=True)

    for row in row_fixes:
        paper = row.paper_id if row.paper_id is not None else "-"
        qno = row.question_no if row.question_no is not None else "-"
        for ff in row.field_fixes:
            print(f"  id={row.question_id} paper={paper} Q={qno} field={ff.field}")
            if ff.hits:
                print(f"    removed: {_clip(ff.hits[0].raw, 120)}")
            print(f"    before: {_clip(ff.old, 90)}")
            print(f"    after:  {_clip(ff.new, 90)}")

    for line in conflicts:
        print(f"[conflict] {line}", flush=True)
    for line in manual:
        print(f"[manual] {line}", flush=True)

    verified = [r.question_id for r in row_fixes if r.answer_verified]
    if verified:
        print(f"[note] 改动中包含 answer_verified=1 的行："
              f"{', '.join(str(x) for x in verified)}；建议人工抽查", flush=True)


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="清洗题库里的页码标记（页脚/页眉碎片）")
    p.add_argument("--apply", action="store_true", help="实际写库（默认只预览）")
    p.add_argument("--yes", action="store_true", help="配合 --apply 确认写入")
    p.add_argument("--dry-run", action="store_true", help="只看不改（默认行为）")
    p.add_argument("--paper-id", type=int, default=None, help="只处理指定试卷")
    p.add_argument("--subject", default=None, help="学科 code 或中文名")
    p.add_argument("--limit", type=int, default=None, help="最多扫描多少行")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.apply and args.dry_run:
        print("错误：--apply 与 --dry-run 互斥", file=sys.stderr)
        return 2
    if args.yes and not args.apply:
        print("错误：--yes 只能和 --apply 一起用", file=sys.stderr)
        return 2
    if args.apply and not args.yes:
        print("错误：--apply 需要同时给 --yes", file=sys.stderr)
        return 2
    if args.limit is not None and args.limit <= 0:
        print("错误：--limit 必须是正整数", file=sys.stderr)
        return 2

    cfg = RefineryConfig.from_env(input_dir=None, output_dir=None)
    try:
        conn = _connect(cfg)
    except pymysql.MySQLError as exc:
        print(f"[error] 数据库不可用：{exc}", file=sys.stderr)
        return 1

    try:
        subject_id = None
        if args.subject:
            subject_id = resolve_subject_id(conn, args.subject)
            if subject_id is None:
                print(f"错误：学科「{args.subject}」不存在（code/name 都没命中）",
                      file=sys.stderr)
                return 2

        rows = load_rows(conn, paper_id=args.paper_id,
                         subject_id=subject_id, limit=args.limit)
        paper_map = load_paper_map(conn, [int(r["id"]) for r in rows])
        row_fixes, manual, conflicts = plan_fixes(
            rows, paper_map,
            hash_exists=lambda h, qid: _hash_exists(conn, h, qid),
        )
        _print_preview(row_fixes, conflicts, manual)

        if not args.apply:
            print("[dry-run] 未写库；确认后运行 --apply --yes", flush=True)
            return 0

        stamp = time.strftime("%Y%m%d_%H%M%S")
        backup = Path(cfg.output_dir) / f"page_marker_backup_{stamp}.jsonl"
        updated = apply_fixes(conn, row_fixes, backup_path=backup)
        if row_fixes:
            print(f"[backup] {backup}（{sum(len(r.field_fixes) for r in row_fixes)} 条旧值）",
                  flush=True)
        print(f"[apply] {updated} 行更新", flush=True)

        remaining, manual_after = verify(
            conn, paper_id=args.paper_id, subject_id=subject_id, limit=args.limit,
        )
        print(f"[verify] 可自动清理的标记：{remaining}", flush=True)
        print(f"[manual] 表格/标签/围栏内标记：{len(manual_after)}", flush=True)
        if remaining:
            print("[verify] 仍有可清理标记，请检查上面的明细", file=sys.stderr)
            return 1
        return 0
    except pymysql.MySQLError as exc:
        print(f"[error] 数据库操作失败：{exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
