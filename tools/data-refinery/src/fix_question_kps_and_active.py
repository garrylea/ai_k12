"""一次性修复（2026-11-05）：重新启用「人工确认无问题」的题 + 从 extracted 回填知识点。

两件事：
1. `manual_fix` 里答「没问题」只落 `verdict=no_change`、**一个字段都不改库**，题停在
   `is_active=0`。这里把它们按 `(paper_id, 题号)` 精确找回并置 `is_active=1`。
2. `publish` 的 `ExamQuestion` 模型曾缺 `knowledge_points` 字段（字段被 Pydantic 静默丢弃），
   `db_loader` 也没有写入路径 —— 所以所有试卷题的 `question_knowledge_points` 是 0。
   这里直接从 `output/extracted/**/*.jsonl`（extract 阶段已标好的结果）回填，**不再调 LLM**。

匹配优先用 `exam_papers.source_key → paper_id → paper_questions.question_no/group_order`，
避免 `(source, group_order)` 在重名卷上误伤；回退路径只在唯一命中时才写。

默认 dry-run，`--apply` 才写。幂等：只补缺失，不覆盖已有数据、不动其它列。
用法：
    python3 src/fix_question_kps_and_active.py            # 预览
    python3 src/fix_question_kps_and_active.py --apply    # 写库
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import pymysql

from config import RefineryConfig

ISSUES_FILE = Path(__file__).resolve().parent.parent / "output" / "recognition_issues.jsonl"


def _connect(cfg: RefineryConfig):
    return pymysql.connect(
        host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
        password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
        autocommit=False,
    )


def _load_index(cur) -> dict:
    """一次性把匹配用的索引读进内存（表都不大）。"""
    cur.execute("SELECT id, source_key FROM exam_papers")
    papers = {str(sk): int(pid) for pid, sk in cur.fetchall() if sk}

    cur.execute("SELECT paper_id, question_id, question_no, group_order FROM paper_questions")
    pq_by_no: dict[tuple[int, int], int] = {}
    pq_by_go: dict[tuple[int, int], int] = {}
    for pid, qid, no, go in cur.fetchall():
        pq_by_no[(int(pid), int(no))] = int(qid)
        if go is not None:
            pq_by_go[(int(pid), int(go))] = int(qid)

    cur.execute("SELECT id, subject_id, is_active, source, group_order FROM questions")
    q_subject: dict[int, int] = {}
    q_active: dict[int, int] = {}
    q_by_sg: dict[tuple[str, int], list[int]] = defaultdict(list)
    for qid, sid, active, source, go in cur.fetchall():
        q_subject[int(qid)] = int(sid)
        q_active[int(qid)] = int(active)
        if source is not None and go is not None:
            q_by_sg[(str(source), int(go))].append(int(qid))

    cur.execute("SELECT id, subject_id, code FROM knowledge_points")
    kp_map = {(int(sid), str(code).strip()): int(kid) for kid, sid, code in cur.fetchall()}

    return {
        "papers": papers, "pq_by_no": pq_by_no, "pq_by_go": pq_by_go,
        "q_subject": q_subject, "q_active": q_active, "q_by_sg": q_by_sg,
        "kp_map": kp_map,
    }


def _resolve(idx: dict, source_key: str, source: str, no: int | None) -> int | None:
    """把 (source_key/题号) 解析成唯一的 questions.id；歧义或不唯一返回 None。"""
    pid = idx["papers"].get(source_key)
    if pid is not None and no is not None:
        qid = idx["pq_by_no"].get((pid, int(no))) or idx["pq_by_go"].get((pid, int(no)))
        if qid is not None:
            return qid
    if no is not None:
        ids = idx["q_by_sg"].get((source, int(no))) or []
        if len(ids) == 1:          # 重名卷的回退路径：只认唯一命中
            return ids[0]
    return None


def _source_key_from_rel(rel_path: str, source: str) -> str:
    """recognition_issues 的 rel_path + source 拼成 exam_papers.source_key。"""
    rel = rel_path.strip("/")
    if rel.endswith("/" + source):
        return rel
    return f"{rel}/{source}" if rel else source


def activate_no_change(cur, idx: dict, apply: bool) -> list[tuple[int, str, int]]:
    """Part A：把 verdict=no_change 且仍 is_active=0 的题重新启用。"""
    if not ISSUES_FILE.exists():
        print(f"[skip] 找不到 {ISSUES_FILE}")
        return []
    rows = [json.loads(line) for line in ISSUES_FILE.read_text(encoding="utf-8").splitlines() if line.strip()]
    todo: list[tuple[int, str, int]] = []
    unresolved: list[str] = []
    for rec in rows:
        if rec.get("verdict") != "no_change":
            continue
        source = str(rec.get("source") or "")
        rel = str(rec.get("rel_path") or "")
        no = rec.get("group_order")
        qid = _resolve(idx, _source_key_from_rel(rel, source), source, no)
        if qid is None:
            unresolved.append(f"{source} 题{no}")
            continue
        if idx["q_active"].get(qid, 0) == 0:
            todo.append((qid, source, int(no)))
    print(f"[A] verdict=no_change 记录 {sum(1 for r in rows if r.get('verdict') == 'no_change')} 条；"
          f"仍需启用 {len(todo)} 题；解析不出 {len(unresolved)} 条")
    for qid, source, no in todo:
        print(f"    activate {source} 题{no} -> question_id={qid}")
    if unresolved:
        print(f"    [WARN] 无法唯一定位：{', '.join(unresolved[:10])}")
    if apply and todo:
        for qid, _, _ in todo:
            # questions 表没有 needs_review 列（它只是 JSONL 字段，入库折算成 is_active）
            cur.execute(
                "UPDATE questions SET is_active=1 WHERE id=%s AND is_active=0", (qid,),
            )
    return todo


def backfill_kps(cur, idx: dict, extracted_dir: Path, apply: bool) -> dict:
    """Part B：从 extracted JSONL 的 knowledge_points 回填 question_knowledge_points。"""
    stats = {"files": 0, "rows_with_kp": 0, "planned": 0, "added": 0,
             "no_question": 0, "unknown_code": 0, "no_kp_field": 0}
    planned: list[tuple[int, int, str, str]] = []   # (qid, kp_id, source, code)
    files = sorted(extracted_dir.rglob("*.jsonl"))
    for path in files:
        stats["files"] += 1
        rel = path.relative_to(extracted_dir).with_suffix("")
        source_key = rel.as_posix()
        source = path.stem
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            codes = row.get("knowledge_points") or []
            if not codes:
                stats["no_kp_field"] += 1
                continue
            stats["rows_with_kp"] += 1
            qid = _resolve(idx, source_key, source, lineno)
            if qid is None:
                qid = _resolve(idx, source_key, source, row.get("group_order"))
            if qid is None:
                stats["no_question"] += 1
                continue
            sid = idx["q_subject"].get(qid)
            for code in codes:
                kid = idx["kp_map"].get((sid, str(code).strip())) if sid is not None else None
                if kid is None:
                    stats["unknown_code"] += 1
                    continue
                planned.append((qid, kid, source, str(code).strip()))

    stats["planned"] = len(planned)
    print(f"[B] 扫描 {stats['files']} 个 extracted 文件；带 KP 的行 {stats['rows_with_kp']}；"
          f"待插入关联 {len(planned)} 条")
    print(f"    匹配不到题 {stats['no_question']} 行；未知 KP code {stats['unknown_code']} 个；"
          f"无 KP 字段 {stats['no_kp_field']} 行")
    if apply:
        for qid, kid, source, code in planned:
            cur.execute(
                "INSERT IGNORE INTO question_knowledge_points "
                "(question_id, knowledge_point_id, role) VALUES (%s,%s,'primary')",
                (qid, kid),
            )
            stats["added"] += cur.rowcount
        print(f"    实际新增 {stats['added']} 条（已存在的忽略）")
    return stats


def _report(cur, label: str) -> dict:
    cur.execute("SELECT COUNT(*) FROM questions WHERE is_active=1")
    active = int(cur.fetchone()[0])
    cur.execute("SELECT COUNT(*) FROM question_knowledge_points")
    kp_rows = int(cur.fetchone()[0])
    cur.execute("SELECT COUNT(DISTINCT question_id) FROM question_knowledge_points")
    kp_qs = int(cur.fetchone()[0])
    cur.execute("""SELECT COUNT(*) FROM paper_questions pq JOIN questions q ON q.id=pq.question_id
                   WHERE pq.paper_id=420 AND q.is_active=1""")
    p420_active = int(cur.fetchone()[0])
    cur.execute("""SELECT COUNT(*) FROM question_knowledge_points k
                   JOIN paper_questions pq ON pq.question_id=k.question_id WHERE pq.paper_id=420""")
    p420_kp = int(cur.fetchone()[0])
    print(f"[{label}] is_active=1 题 {active}；KP 关联 {kp_rows} 行 / {kp_qs} 题；"
          f"paper 420 active={p420_active} KP={p420_kp}")
    return {"active": active, "kp_rows": kp_rows, "kp_qs": kp_qs,
            "p420_active": p420_active, "p420_kp": p420_kp}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="一次性修复：启用 no_change 题 + 回填知识点")
    ap.add_argument("--apply", action="store_true", help="真正写库（默认只预览）")
    args = ap.parse_args(argv)

    cfg = RefineryConfig.from_env()
    extracted_dir = cfg.output_dir / "extracted"
    conn = _connect(cfg)
    try:
        with conn.cursor() as cur:
            idx = _load_index(cur)
            print(f"索引：exam_papers {len(idx['papers'])}；paper_questions {len(idx['pq_by_no'])}；"
                  f"questions {len(idx['q_subject'])}；knowledge_points {len(idx['kp_map'])}")
            before = _report(cur, "before")
            activate_no_change(cur, idx, args.apply)
            backfill_kps(cur, idx, extracted_dir, args.apply)
            if args.apply:
                conn.commit()
            else:
                conn.rollback()
            after = _report(cur, "after")
    finally:
        conn.close()

    print("\n=== 汇总 ===")
    for key in ("active", "kp_rows", "kp_qs", "p420_active", "p420_kp"):
        print(f"  {key:12s} {before[key]:>6} -> {after[key]:>6}")
    if not args.apply:
        print("\n[dry-run] 未写库；确认后加 --apply")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
