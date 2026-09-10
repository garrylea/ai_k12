"""answer_importer：范围 SQL 构造 + 记录分类 + diff + 报告（纯函数层）。

DB 编排（定位/读题/UPDATE）在 answer_importer_cli.py。
回写语义见 spec 2026-09-10 §5；幂等：无变化记录不进 diff、不发 UPDATE。
"""

from dataclasses import dataclass, field

from answer_records import AnswerRecord

_GAP_PREDICATES = {
    "answer_empty": "(q.answer IS NULL OR q.answer = '')",
    "approach_empty": "(q.approach IS NULL OR q.approach = '')",
    "explanation_empty": "(q.explanation IS NULL OR q.explanation = '')",
}


@dataclass
class ScopeFilter:
    question_ids: set[int] | None = None
    paper_ids: list[int] | None = None
    question_nos: set[int] | None = None
    gaps: set[str] = field(default_factory=set)
    sources: list[str] | None = None
    types: list[str] | None = None
    difficulty: int | None = None
    content_hash: str | None = None

    def is_empty(self) -> bool:
        return not any([
            self.question_ids, self.paper_ids, self.question_nos, self.gaps,
            self.sources, self.types, self.difficulty, self.content_hash,
        ])


def _placeholders(n: int) -> str:
    return ",".join(["%s"] * n)


def build_scope_sql(scope: ScopeFilter) -> tuple[str, list]:
    """构造 questions（别名 q）上的 WHERE 片段与参数；无约束返回 ('1=1', [])。"""
    if scope.question_nos and not scope.paper_ids:
        raise ValueError("question_no 必须与 paper_id 搭配")
    conds: list[str] = []
    params: list = []

    if scope.question_ids:
        ids = sorted(scope.question_ids)
        conds.append(f"q.id IN ({_placeholders(len(ids))})")
        params.extend(ids)
    if scope.paper_ids:
        pids = list(scope.paper_ids)
        sub = (f"SELECT question_id FROM paper_questions "
               f"WHERE paper_id IN ({_placeholders(len(pids))})")
        sub_params: list = list(pids)
        if scope.question_nos:
            nos = sorted(scope.question_nos)
            sub += f" AND question_no IN ({_placeholders(len(nos))})"
            sub_params.extend(nos)
        conds.append(f"q.id IN ({sub})")
        params.extend(sub_params)
    for gap in sorted(scope.gaps):
        if gap not in _GAP_PREDICATES:
            raise ValueError(
                f"未知缺口条件：{gap}（允许：{' | '.join(sorted(_GAP_PREDICATES))}）")
        conds.append(_GAP_PREDICATES[gap])
    if scope.sources:
        conds.append("(" + " OR ".join(["q.source LIKE %s"] * len(scope.sources)) + ")")
        params.extend(f"%{s}%" for s in scope.sources)
    if scope.types:
        conds.append(f"q.type IN ({_placeholders(len(scope.types))})")
        params.extend(scope.types)
    if scope.difficulty is not None:
        conds.append("q.difficulty = %s")
        params.append(scope.difficulty)
    if scope.content_hash:
        conds.append("q.content_hash = %s")
        params.append(scope.content_hash)
    return (" AND ".join(conds) if conds else "1=1"), params


@dataclass
class QuestionRow:
    question_id: int
    type: str
    answer: str = ""
    approach: str | None = None
    explanation: str | None = None


@dataclass
class MatchResult:
    paired: list[tuple[AnswerRecord, QuestionRow]]
    unresolved: list[AnswerRecord]
    out_of_scope: list[tuple[AnswerRecord, QuestionRow]]


def classify(
    records: list[AnswerRecord],
    resolved: list[QuestionRow | None],
    in_scope_ids: set[int] | None = None,
) -> MatchResult:
    """resolved 与 records 等长；None=定位失败。in_scope_ids=None 表示不限范围。"""
    if len(records) != len(resolved):
        raise ValueError("records 与 resolved 长度必须一致")
    paired: list[tuple[AnswerRecord, QuestionRow]] = []
    unresolved: list[AnswerRecord] = []
    out_of_scope: list[tuple[AnswerRecord, QuestionRow]] = []
    for rec, row in zip(records, resolved):
        if row is None:
            unresolved.append(rec)
        elif in_scope_ids is not None and row.question_id not in in_scope_ids:
            out_of_scope.append((rec, row))
        else:
            paired.append((rec, row))
    return MatchResult(paired=paired, unresolved=unresolved, out_of_scope=out_of_scope)


@dataclass
class DiffEntry:
    question_id: int
    label: str
    type: str
    old_answer: str
    new_answer: str | None
    old_approach: str | None
    new_approach: str | None
    old_explanation: str | None
    new_explanation: str | None
    type_change: tuple[str, str] | None


def build_diff(paired: list[tuple[AnswerRecord, QuestionRow]]) -> list[DiffEntry]:
    diff: list[DiffEntry] = []
    for rec, row in paired:
        type_change = (row.type, rec.type) if rec.type and rec.type != row.type else None
        answer_changed = rec.answer is not None and rec.answer != (row.answer or "")
        approach_changed = rec.approach is not None and rec.approach != (row.approach or "")
        expl_changed = rec.explanation is not None and rec.explanation != (row.explanation or "")
        if not (answer_changed or approach_changed or expl_changed or type_change):
            continue  # 幂等：无变化不出 diff
        diff.append(DiffEntry(
            question_id=row.question_id,
            label=rec.locator(),
            type=rec.type or row.type,
            old_answer=row.answer or "",
            new_answer=rec.answer,
            old_approach=row.approach,
            new_approach=rec.approach,
            old_explanation=row.explanation,
            new_explanation=rec.explanation,
            type_change=type_change,
        ))
    return diff


def locate_paper(title: str, papers: list[tuple[str, int, int]]) -> tuple[int | None, list[tuple[str, int, int]]]:
    """在 (title, id, question_count) 列表中定位试卷：唯一精确命中返回 id；
    重名/多条候选返回 (None, 候选)；无精确命中时子串匹配兜底（仍多条则列候选）。"""
    exact = [p for p in papers if p[0] == title]
    if len(exact) == 1:
        return exact[0][1], []
    hits = exact or [p for p in papers if title in p[0]]
    if len(hits) == 1:
        return hits[0][1], []
    return None, hits


def _trunc(s: str | None, n: int = 40) -> str:
    s = (s or "").replace("\n", " ")
    return s if len(s) <= n else s[:n] + "…"


def _field_line(name: str, old: str | None, new: str | None) -> str | None:
    if new is None:
        return None
    if not (old or "").strip():
        return f"    {name}: (无 -> 新增) {_trunc(new)}"
    return f"    {name}: {_trunc(old)} -> {_trunc(new)}"


def format_report(
    *,
    target: str,
    diff: list[DiffEntry],
    unmatched: list[AnswerRecord],
    out_of_scope: list[tuple[AnswerRecord, QuestionRow]],
    warnings: list[str],
    apply: bool,
) -> str:
    suffix = "（已写入）" if apply else "（dry-run 预览，--apply 才写入）"
    lines = [f"=== 目标：{target} ===", f"将更新 {len(diff)} 题{suffix}", ""]
    if diff:
        lines.append("—— 更新明细 ——")
        for d in diff:
            lines.append(f"  {d.label} (questions#{d.question_id}, {d.type})")
            if d.new_answer is not None:
                lines.append(f"    答案: {_trunc(d.old_answer)} -> {_trunc(d.new_answer)}")
            for name, old, new in (("思路", d.old_approach, d.new_approach),
                                   ("解析", d.old_explanation, d.new_explanation)):
                line = _field_line(name, old, new)
                if line:
                    lines.append(line)
            if d.type_change:
                lines.append(f"    题型: {d.type_change[0]} -> {d.type_change[1]}")
        lines.append("")
    if unmatched:
        lines.append(f"—— 定位失败 {len(unmatched)} 条（不写入）——")
        for rec in unmatched:
            note = f"（{rec.note}）" if rec.note else ""
            lines.append(f"  第 {rec.line_no} 行 {rec.locator()}{note}")
        lines.append("")
    if out_of_scope:
        lines.append(f"—— 范围外跳过 {len(out_of_scope)} 条（不满足 --where，不写入）——")
        for rec, row in out_of_scope:
            lines.append(f"  第 {rec.line_no} 行 {rec.locator()} -> questions#{row.question_id}")
        lines.append("")
    if warnings:
        lines.append(f"—— 警告 {len(warnings)} 条 ——")
        for w in warnings:
            lines.append(f"  {w}")
        lines.append("")
    if not diff and not unmatched and not out_of_scope:
        lines.append("（无变化——与库内数据一致，幂等重跑）")
    return "\n".join(lines)
