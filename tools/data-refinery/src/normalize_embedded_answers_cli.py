"""整理 questions.answer 中混入的题解分段。

默认只预览；`--apply` 时先展示同一份预览，再备份、事务写入并复查。
"""

import argparse
import json
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from answer_sections import merge_old_then_new, split_answer_sections


DEFAULT_LIMIT = 5000


@dataclass(frozen=True)
class CleanupRow:
    question_id: int
    subject: str
    type_: str
    answer: str
    approach: str | None
    explanation: str | None
    answer_verified: int


@dataclass(frozen=True)
class CleanupChange:
    question_id: int
    before: CleanupRow
    after_answer: str
    after_approach: str | None
    after_explanation: str | None
    added_approach: bool
    added_explanation: bool


class ConcurrentChangeError(RuntimeError):
    """扫描后题目被其它进程修改，拒绝覆盖。"""


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="整理 questions.answer 中混入的答案/解析/详解分段",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="预览后备份并写入；默认只预览",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="配合 --apply 跳过交互确认",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"单次最多扫描题数（默认 {DEFAULT_LIMIT}）",
    )
    return parser.parse_args(argv)


def build_cleanup_changes(
    rows: list[CleanupRow],
) -> tuple[list[CleanupChange], list[tuple[CleanupRow, list[str]]]]:
    changes: list[CleanupChange] = []
    skipped: list[tuple[CleanupRow, list[str]]] = []
    for row in rows:
        sections = split_answer_sections(row.answer)
        if not sections.recognized:
            continue
        if sections.issues:
            skipped.append((row, list(sections.issues)))
            continue

        answer = sections.answer.strip()
        if not answer:
            skipped.append((row, ["answer_empty_after_split"]))
            continue

        approach = merge_old_then_new(row.approach, sections.approach)
        explanation = merge_old_then_new(row.explanation, sections.explanation)
        if (
            answer == (row.answer or "").strip()
            and approach == row.approach
            and explanation == row.explanation
        ):
            continue

        changes.append(CleanupChange(
            question_id=row.question_id,
            before=row,
            after_answer=answer,
            after_approach=approach,
            after_explanation=explanation,
            added_approach=bool(
                sections.approach.strip()
                and sections.approach.strip() not in (row.approach or "")
            ),
            added_explanation=bool(
                sections.explanation.strip()
                and sections.explanation.strip() not in (row.explanation or "")
            ),
        ))
    return changes, skipped


def write_backup(path: Path, changes: list[CleanupChange]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for change in changes:
            row = change.before
            handle.write(json.dumps({
                "question_id": row.question_id,
                "subject": row.subject,
                "type": row.type_,
                "answer": row.answer,
                "approach": row.approach,
                "explanation": row.explanation,
                "answer_verified": row.answer_verified,
            }, ensure_ascii=False) + "\n")


def apply_changes(conn, changes: list[CleanupChange]) -> None:
    try:
        with conn.cursor() as cur:
            for change in changes:
                cur.execute(
                    "UPDATE questions SET answer=%s, approach=%s, explanation=%s "
                    "WHERE answer=%s "
                    "AND COALESCE(approach,'')=COALESCE(%s,'') "
                    "AND COALESCE(explanation,'')=COALESCE(%s,'') "
                    "AND answer_verified=%s AND id=%s",
                    (
                        change.after_answer,
                        change.after_approach,
                        change.after_explanation,
                        change.before.answer,
                        change.before.approach,
                        change.before.explanation,
                        change.before.answer_verified,
                        change.question_id,
                    ),
                )
                if cur.rowcount != 1:
                    raise ConcurrentChangeError(
                        f"questions#{change.question_id} 在扫描后被修改"
                    )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def verify_changes(conn, changes: list[CleanupChange]) -> list[str]:
    if not changes:
        return []
    ids = [change.question_id for change in changes]
    placeholders = ",".join(["%s"] * len(ids))
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, answer, approach, explanation, answer_verified "
            f"FROM questions WHERE id IN ({placeholders}) ORDER BY id",
            ids,
        )
        rows = {
            int(row[0]): (row[1], row[2], row[3], int(row[4]))
            for row in cur.fetchall()
        }

    problems: list[str] = []
    for change in changes:
        expected = (
            change.after_answer,
            change.after_approach,
            change.after_explanation,
            change.before.answer_verified,
        )
        actual = rows.get(change.question_id)
        if actual != expected:
            problems.append(
                f"questions#{change.question_id} 写入后复查不一致："
                f"expected={expected!r} actual={actual!r}"
            )
    return problems


def load_rows(conn, limit: int) -> list[CleanupRow]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT q.id, s.code, q.type, q.answer, q.approach, "
            "q.explanation, q.answer_verified "
            "FROM questions q JOIN subjects s ON s.id=q.subject_id "
            "WHERE q.answer REGEXP "
            "'答案|解析|分析|思路|详解|解答|点睛' "
            "ORDER BY q.id LIMIT %s",
            (limit,),
        )
        return [
            CleanupRow(
                question_id=int(row[0]),
                subject=str(row[1]),
                type_=str(row[2]),
                answer=row[3] or "",
                approach=row[4],
                explanation=row[5],
                answer_verified=int(row[6]),
            )
            for row in cur.fetchall()
        ]


def connect():
    import pymysql
    from config import RefineryConfig

    cfg = RefineryConfig.from_env()
    return pymysql.connect(
        host=cfg.db_host,
        port=cfg.db_port,
        user=cfg.db_user,
        password=cfg.db_pass,
        database=cfg.db_name,
        charset="utf8mb4",
    )


def _format_report(
    changes: list[CleanupChange],
    skipped: list[tuple[CleanupRow, list[str]]],
    *,
    apply: bool,
) -> str:
    subjects = Counter(change.before.subject for change in changes)
    merge_count = sum(
        bool(change.before.approach) or bool(change.before.explanation)
        for change in changes
    )
    lines = [
        "=== 题解内嵌分段整理 ===",
        (
            f"将更新 {len(changes)} 题"
            + ("（预览）" if not apply else "（写入）")
        ),
        f"规则：旧字段后追加；answer_verified 保持原值；异常跳过 {len(skipped)} 条",
        f"已有思路/详解并追加：{merge_count} 题",
        (
            f"新增思路：{sum(change.added_approach for change in changes)} 题；"
            f"新增详解：{sum(change.added_explanation for change in changes)} 题"
        ),
        "学科分布：" + (
            "，".join(f"{subject}={count}" for subject, count in sorted(subjects.items()))
            or "无"
        ),
    ]
    if changes:
        lines.append("")
        lines.append("—— 更新明细（前 50 题）——")
        for change in changes[:50]:
            row = change.before
            lines.append(
                f"  questions#{row.question_id} [{row.subject}/{row.type_}] "
                f"answer {len(row.answer)} -> {len(change.after_answer)} 字；"
                f"approach {len(row.approach or '')} -> "
                f"{len(change.after_approach or '')} 字；"
                f"explanation {len(row.explanation or '')} -> "
                f"{len(change.after_explanation or '')} 字"
            )
    if skipped:
        lines.append("")
        lines.append("—— 异常跳过 ——")
        for row, reasons in skipped:
            lines.append(
                f"  questions#{row.question_id} [{row.subject}/{row.type_}]: "
                f"{', '.join(reasons)}"
            )
    return "\n".join(lines)


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.limit <= 0:
        print("错误：--limit 必须为正整数", file=sys.stderr)
        return 2

    conn = connect()
    try:
        rows = load_rows(conn, args.limit)
        changes, skipped = build_cleanup_changes(rows)
        print(_format_report(changes, skipped, apply=args.apply))

        if len(rows) >= args.limit:
            print(
                f"[警告] 扫描达到 --limit {args.limit}，可能未覆盖全部题；"
                "确认后调大 --limit 重跑。"
            )
        if not args.apply:
            print("\n（预览完成，未写入。确认后运行 --apply。）")
            return 0
        if not changes:
            print("（无变化，未写入。）")
            return 0

        if not args.yes:
            try:
                answer = input(f"确认写入 {len(changes)} 题？输入 yes 执行：").strip()
            except EOFError:
                print("已取消（未收到确认输入）。")
                return 1
            if answer != "yes":
                print("已取消。")
                return 1

        from config import RefineryConfig

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = (
            RefineryConfig.from_env().output_dir
            / "backups"
            / f"embedded_answers_{stamp}.jsonl"
        )
        write_backup(backup, changes)
        print(f"备份：{backup}")

        apply_changes(conn, changes)
        problems = verify_changes(conn, changes)
        if problems:
            print("写入后复查失败：", file=sys.stderr)
            for problem in problems:
                print(f"  {problem}", file=sys.stderr)
            return 1
        print(f"已写入并复查通过：{len(changes)} 题。")
        return 0
    finally:
        close = getattr(conn, "close", None)
        if callable(close):
            close()


if __name__ == "__main__":
    sys.exit(main())
