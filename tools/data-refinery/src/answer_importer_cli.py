"""answer_importer_cli：题目内容回写题库（answer/approach/explanation/type）。

用法（cd tools/data-refinery）：
    python src/answer_importer_cli.py --records edits.jsonl                 # dry-run
    python src/answer_importer_cli.py --records edits.jsonl --apply         # 写入（输 yes）
    python src/answer_importer_cli.py --doc 答案.md --paper-id 3
    python src/answer_importer_cli.py --export --where answer_empty --out to_fill.jsonl
    python src/answer_importer_cli.py --list-papers 海淀

语义（spec 2026-09-10 §5）：缺省=不改、非空=覆盖、空串=不改；type 仅标注时改；
任一写入 answer_verified=1；幂等重跑无 diff 不写。
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # 直接执行时能 import 同目录模块

from answer_doc import AnswerDocError, doc_to_records, parse_answer_doc  # noqa: E402
from answer_importer import (  # noqa: E402
    QuestionRow,
    ScopeFilter,
    build_diff,
    build_scope_sql,
    classify,
    format_report,
    locate_paper,
)
from answer_records import (  # noqa: E402
    AnswerRecord,
    AnswerRecordError,
    ExportRow,
    build_export_jsonl,
    parse_answer_records,
)

DEFAULT_LIMIT = 500
GAP_CHOICES = ["answer_empty", "approach_empty", "explanation_empty"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="题目内容回写题库（answer/approach/explanation/type）")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--records", help="JSONL 输入路径")
    src.add_argument("--doc", help="Markdown 按卷答案文档路径")
    src.add_argument("--export", action="store_true", help="导出待补模板（配合 --where/--out）")
    p.add_argument("--out", help="导出目标路径（--export 必填）")
    p.add_argument("--paper-id", type=int, default=None, help="试卷 id（重名时直接指定）")
    p.add_argument("--paper-title", default=None,
                   help="试卷标题（唯一命中则解析为 paper_id；--records/--doc 均可配合）")
    p.add_argument("--question-id", default=None, help="主键选择器，如 1,2,10-20")
    p.add_argument("--question-no", default=None, help="印刷题号（须配合 --paper-id 或可唯一命中的 --paper-title）")
    p.add_argument("--where", dest="where", default=None,
                   help="缺口条件，逗号分隔：" + "/".join(GAP_CHOICES))
    p.add_argument("--source", default=None, help="来源关键词（LIKE）")
    p.add_argument("--type", dest="type", default=None, help="题型（逗号分隔）")
    p.add_argument("--difficulty", type=int, default=None, help="难度 1/2/3")
    p.add_argument("--content-hash", dest="content_hash", default=None, help="题干哈希")
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"安全阀（默认 {DEFAULT_LIMIT}）")
    p.add_argument("--apply", action="store_true", help="实际写入（默认 dry-run）")
    p.add_argument("--list-papers", metavar="KEYWORD", default=None, help="按关键词列候选试卷")
    return p.parse_args(argv)


def parse_int_set(spec: str) -> set[int]:
    """解析 '1,2,10-20' -> {1,2,10..20}。"""
    result: set[int] = set()
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo_s, hi_s = part.split("-", 1)
            lo, hi = int(lo_s), int(hi_s)
            if lo > hi:
                raise ValueError(f"区间非法：{part}")
            result.update(range(lo, hi + 1))
        else:
            result.add(int(part))
    return result


def build_scope(args, paper_id: int | None = None) -> ScopeFilter:
    scope = ScopeFilter()
    if args.question_id:
        scope.question_ids = parse_int_set(args.question_id)
    pid = paper_id if paper_id is not None else args.paper_id
    if pid:
        scope.paper_ids = [pid]
    if args.question_no:
        scope.question_nos = parse_int_set(args.question_no)
    if args.where:
        scope.gaps = {g.strip() for g in args.where.split(",") if g.strip()}
    if args.source:
        scope.sources = [args.source]
    if args.type:
        scope.types = [t.strip() for t in args.type.split(",") if t.strip()]
    scope.difficulty = args.difficulty
    scope.content_hash = args.content_hash
    return scope


def build_update_sql(rec: AnswerRecord, row: QuestionRow) -> tuple[str, list]:
    """构造单题 UPDATE：只含记录提供的字段 + answer_verified/updated_at，WHERE id。"""
    sets: list[str] = []
    params: list = []
    if rec.answer is not None:
        sets.append("answer = %s")
        params.append(rec.answer)
    if rec.approach is not None:
        sets.append("approach = %s")
        params.append(rec.approach)
    if rec.explanation is not None:
        sets.append("explanation = %s")
        params.append(rec.explanation)
    if rec.type is not None and rec.type != row.type:
        sets.append("type = %s")
        params.append(rec.type)
    sets.append("answer_verified = 1")
    sets.append("updated_at = CURRENT_TIMESTAMP(3)")
    params.append(row.question_id)
    return f"UPDATE questions SET {', '.join(sets)} WHERE id = %s", params


def build_export_sql(scope: ScopeFilter, limit: int) -> tuple[str, list]:
    """导出查询：单一 --paper-id 时 LEFT JOIN 取印刷题号供 _ref 参考。"""
    where, params = build_scope_sql(scope)
    if scope.paper_ids and len(set(scope.paper_ids)) == 1:
        pid = scope.paper_ids[0]
        sql = (
            "SELECT q.id, q.content, q.options, q.type, q.answer, q.approach, q.explanation, "
            "pq.question_no "
            "FROM questions q "
            "LEFT JOIN paper_questions pq ON pq.question_id = q.id AND pq.paper_id = %s "
            f"WHERE {where} ORDER BY q.id LIMIT %s"
        )
        return sql, [pid] + params + [limit]
    sql = (
        "SELECT q.id, q.content, q.options, q.type, q.answer, q.approach, q.explanation "
        f"FROM questions q WHERE {where} ORDER BY q.id LIMIT %s"
    )
    return sql, params + [limit]


def connect():
    import pymysql
    from config import RefineryConfig

    cfg = RefineryConfig.from_env()
    return pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4")


def _row(raw) -> QuestionRow:
    return QuestionRow(question_id=raw[0], type=raw[1], answer=raw[2] or "",
                       approach=raw[3], explanation=raw[4])


def load_questions_by_ids(conn, ids: set[int]) -> dict[int, QuestionRow]:
    if not ids:
        return {}
    ph = ",".join(["%s"] * len(ids))
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT id, type, answer, approach, explanation FROM questions WHERE id IN ({ph})",
            sorted(ids),
        )
        return {r[0]: _row(r) for r in cur.fetchall()}


def load_questions_by_hash(conn, hashes: set[str]) -> dict[str, QuestionRow]:
    if not hashes:
        return {}
    ph = ",".join(["%s"] * len(hashes))
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT content_hash, id, type, answer, approach, explanation FROM questions "
            f"WHERE content_hash IN ({ph})",
            sorted(hashes),
        )
        return {r[0]: _row((r[1], r[2], r[3], r[4], r[5])) for r in cur.fetchall()}


def load_questions_by_paper_no(conn, pairs: set[tuple[int, int]]) -> dict[tuple[int, int], QuestionRow]:
    if not pairs:
        return {}
    ph = ",".join(["(%s,%s)"] * len(pairs))
    flat = [x for p in sorted(pairs) for x in p]
    with conn.cursor() as cur:
        cur.execute(
            "SELECT pq.paper_id, pq.question_no, q.id, q.type, q.answer, q.approach, q.explanation "
            "FROM paper_questions pq JOIN questions q ON q.id = pq.question_id "
            f"WHERE (pq.paper_id, pq.question_no) IN ({ph})",
            flat,
        )
        return {(r[0], r[1]): _row((r[2], r[3], r[4], r[5], r[6])) for r in cur.fetchall()}


def resolve_records(conn, records: list[AnswerRecord]) -> list[QuestionRow | None]:
    by_qid = load_questions_by_ids(conn, {x.question_id for x in records if x.question_id is not None})
    by_hash = load_questions_by_hash(conn, {x.content_hash for x in records if x.content_hash is not None})
    by_paper = load_questions_by_paper_no(
        conn, {(x.paper_id, x.question_no) for x in records if x.paper_id is not None})
    resolved: list[QuestionRow | None] = []
    for rec in records:
        if rec.question_id is not None:
            resolved.append(by_qid.get(rec.question_id))
        elif rec.content_hash is not None:
            resolved.append(by_hash.get(rec.content_hash))
        else:
            resolved.append(by_paper.get((rec.paper_id, rec.question_no)))
    return resolved


def load_scope_ids(conn, scope: ScopeFilter) -> set[int] | None:
    if scope.is_empty():
        return None
    where, params = build_scope_sql(scope)
    with conn.cursor() as cur:
        cur.execute(f"SELECT q.id FROM questions q WHERE {where}", params)
        return {r[0] for r in cur.fetchall()}


def load_papers(conn, keyword: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT title, id, question_count FROM exam_papers WHERE title LIKE %s ORDER BY id",
            (f"%{keyword}%",),
        )
        return cur.fetchall()


def load_export_rows(conn, scope: ScopeFilter, limit: int) -> list[ExportRow]:
    sql, params = build_export_sql(scope, limit)
    rows: list[ExportRow] = []
    with conn.cursor() as cur:
        cur.execute(sql, params)
        for r in cur.fetchall():
            if len(r) == 8:
                rows.append(ExportRow(question_id=r[0], content=r[1] or "", type=r[3],
                                      answer=r[4] or "", options=r[2], approach=r[5],
                                      explanation=r[6], paper_id=scope.paper_ids[0], question_no=r[7]))
            else:
                rows.append(ExportRow(question_id=r[0], content=r[1] or "", type=r[3],
                                      answer=r[4] or "", options=r[2], approach=r[5],
                                      explanation=r[6]))
    return rows


def _records_from_doc(conn, args, paper_id: int | None):
    """解析 Markdown 并定位试卷。返回 (records, target_label) 或 (None, None)。"""
    doc = parse_answer_doc(open(args.doc, encoding="utf-8").read())
    if paper_id is None:
        papers = list(load_papers(conn, doc.title))
        paper_id, candidates = locate_paper(doc.title, papers)
        if paper_id is None:
            print(f"试卷「{doc.title}」无法唯一定位，候选如下（用 --paper-id 指定）：")
            for title, pid, count in (candidates or papers):
                print(f"  #{pid}\t{count} 题\t{title}")
            return None, None
    return doc_to_records(doc, paper_id), f"试卷 #{paper_id} {doc.title}"


def _run(conn, args) -> int:
    if args.list_papers:
        for title, pid, count in load_papers(conn, args.list_papers):
            print(f"  #{pid}\t{count} 题\t{title}")
        return 0

    # 解析试卷范围：--paper-id 优先；否则 --paper-title 经 DB 唯一命中解析为 paper_id
    resolved_paper_id = args.paper_id
    if resolved_paper_id is None and args.paper_title:
        papers = list(load_papers(conn, args.paper_title))
        resolved_paper_id, candidates = locate_paper(args.paper_title, papers)
        if resolved_paper_id is None:
            print(f"试卷「{args.paper_title}」无法唯一定位，候选如下（用 --paper-id 指定）：")
            for title, pid, count in (candidates or papers):
                print(f"  #{pid}\t{count} 题\t{title}")
            return 2

    scope = build_scope(args, paper_id=resolved_paper_id)

    if args.export:
        if not args.out:
            print("错误：--export 需要 --out 指定输出路径", file=sys.stderr)
            return 2
        rows = load_export_rows(conn, scope, args.limit)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(build_export_jsonl(rows))
        print(f"已导出 {len(rows)} 题 -> {args.out}")
        if len(rows) >= args.limit:
            print(f"[警告] 导出达到 --limit {args.limit} 上限，可能被截断；如需完整缺口请调大 --limit 后重导。")
        return 0

    if args.records:
        records = parse_answer_records(open(args.records, encoding="utf-8").read())
        target = args.records
    elif args.doc:
        records, target = _records_from_doc(conn, args, resolved_paper_id)
        if records is None:
            return 2
    else:
        print("错误：需要 --records / --doc / --export / --list-papers 之一", file=sys.stderr)
        return 2

    if len(records) > args.limit:
        print(f"错误：本次将处理 {len(records)} 条，超过 --limit {args.limit}；"
              f"确认无误请显式调大 --limit", file=sys.stderr)
        return 2

    resolved = resolve_records(conn, records)
    in_scope_ids = load_scope_ids(conn, scope)
    match = classify(records, resolved, in_scope_ids)
    diff = build_diff(match.paired)
    warnings = [f"第 {rec.line_no} 行 {rec.locator()} 内容字段全为空，未产生更新"
                for rec, _row in match.paired if not rec.has_content()]

    print(format_report(target=target, diff=diff, unmatched=match.unresolved,
                        out_of_scope=match.out_of_scope, warnings=warnings, apply=args.apply))

    if not args.apply:
        print("\n（dry-run，未写入。确认无误后加 --apply 执行。）")
        return 0
    if not diff:
        print("（无变化，未写入——幂等重跑。）")
        return 0

    try:
        answer = input(f"确认写入 {len(diff)} 题？输入 yes 执行：").strip()
    except EOFError:
        print("已取消（未收到确认输入；交互式终端输入 yes，或先 `echo yes |` 再执行）。")
        return 1
    if answer != "yes":
        print("已取消。")
        return 1

    diff_qids = {d.question_id for d in diff}
    written = 0
    with conn.cursor() as cur:
        for rec, row in match.paired:
            if row.question_id not in diff_qids:
                continue
            sql, params = build_update_sql(rec, row)
            cur.execute(sql, params)
            written += 1
    conn.commit()
    print(f"已写入 {written} 题（answer_verified=1）。")
    return 0


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.limit <= 0:
        print("错误：--limit 必须为正整数", file=sys.stderr)
        return 2
    conn = connect()
    try:
        try:
            return _run(conn, args)
        except (AnswerRecordError, AnswerDocError, ValueError, OSError) as e:
            print(f"错误：{e}", file=sys.stderr)
            return 2
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
