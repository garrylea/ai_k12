"""answer_importer：范围 SQL + 分类 + diff + 报告（纯函数，不连库）。"""

import pytest

from answer_importer import (
    QuestionRow,
    ScopeFilter,
    build_diff,
    build_scope_sql,
    classify,
    format_report,
    locate_paper,
)
from answer_records import AnswerRecord


def _row(qid, type_="short_answer", answer="", approach=None, explanation=None):
    return QuestionRow(question_id=qid, type=type_, answer=answer,
                       approach=approach, explanation=explanation)


class TestScopeSql:
    def test_empty(self):
        assert build_scope_sql(ScopeFilter()) == ("1=1", [])

    def test_question_ids_sorted(self):
        where, params = build_scope_sql(ScopeFilter(question_ids={3, 1}))
        assert where == "q.id IN (%s,%s)"
        assert params == [1, 3]

    def test_paper_and_no(self):
        where, params = build_scope_sql(ScopeFilter(paper_ids=[3], question_nos={17, 2}))
        assert where == ("q.id IN (SELECT question_id FROM paper_questions "
                         "WHERE paper_id IN (%s) AND question_no IN (%s,%s))")
        assert params == [3, 2, 17]

    def test_gaps(self):
        where, _ = build_scope_sql(ScopeFilter(gaps={"answer_empty", "explanation_empty"}))
        assert where == ("(q.answer IS NULL OR q.answer = '') AND "
                         "(q.explanation IS NULL OR q.explanation = '')")

    def test_attributes(self):
        where, params = build_scope_sql(ScopeFilter(
            sources=["海淀"], types=["choice"], difficulty=2, content_hash="hhhh"))
        assert "q.source LIKE %s" in where
        assert "q.type IN (%s)" in where
        assert "q.difficulty = %s" in where
        assert "q.content_hash = %s" in where
        assert params == ["%海淀%", "choice", 2, "hhhh"]

    def test_question_no_without_paper_raises(self):
        with pytest.raises(ValueError, match="question_no"):
            build_scope_sql(ScopeFilter(question_nos={1}))

    def test_unknown_gap_raises(self):
        with pytest.raises(ValueError, match="未知缺口条件"):
            build_scope_sql(ScopeFilter(gaps={"bogus"}))


class TestClassify:
    def test_paired_unresolved_out_of_scope(self):
        records = [
            AnswerRecord(question_id=1, answer="A", line_no=1),
            AnswerRecord(question_id=2, answer="B", line_no=2),
            AnswerRecord(question_id=3, answer="C", line_no=3),
        ]
        m = classify(records, [_row(1), None, _row(3)], in_scope_ids={1})
        assert [r.question_id for _, r in m.paired] == [1]
        assert [x.question_id for x in m.unresolved] == [2]
        assert [r.question_id for _, r in m.out_of_scope] == [3]

    def test_no_scope_means_all_paired(self):
        m = classify([AnswerRecord(question_id=1, answer="A")], [_row(1)], None)
        assert len(m.paired) == 1 and not m.out_of_scope

    def test_length_mismatch(self):
        with pytest.raises(ValueError, match="长度"):
            classify([AnswerRecord(question_id=1)], [])


class TestDiff:
    def test_answer_change_and_approach_new(self):
        rec = AnswerRecord(question_id=1, answer="B", approach="配方", line_no=1)
        diff = build_diff([(rec, _row(1, "choice", answer="A"))])
        assert len(diff) == 1
        d = diff[0]
        assert (d.old_answer, d.new_answer) == ("A", "B")
        assert d.old_approach is None and d.new_approach == "配方"
        assert d.type_change is None

    def test_explanation_provided_overrides(self):
        rec = AnswerRecord(question_id=1, explanation="新解析")
        d = build_diff([(rec, _row(1, answer="A", explanation="旧解析"))])[0]
        assert (d.old_explanation, d.new_explanation) == ("旧解析", "新解析")

    def test_type_change(self):
        rec = AnswerRecord(question_id=1, type="calculation")
        d = build_diff([(rec, _row(1, "short_answer", answer="A"))])[0]
        assert d.type_change == ("short_answer", "calculation")
        assert d.type == "calculation"

    def test_unchanged_is_idempotent(self):
        rec = AnswerRecord(question_id=1, answer="A", approach="配方", explanation="过程")
        assert build_diff([(rec, _row(1, answer="A", approach="配方", explanation="过程"))]) == []

    def test_none_fields_not_changed(self):
        rec = AnswerRecord(question_id=1, note="只备注")
        assert build_diff([(rec, _row(1, answer="A", explanation="旧"))]) == []


class TestLocatePaper:
    def test_unique_exact(self):
        assert locate_paper("X 卷", [("X 卷", 3, 30)]) == (3, [])

    def test_duplicate_lists_candidates(self):
        papers = [("X 卷", 2, 37), ("X 卷", 6, 28), ("Y 卷", 9, 28)]
        pid, candidates = locate_paper("X 卷", papers)
        assert pid is None
        assert [c[1] for c in candidates] == [2, 6]

    def test_substring_fallback(self):
        assert locate_paper("海淀", [("2024 海淀 初三 模拟二", 2, 37)]) == (2, [])


class TestReport:
    def test_sections(self):
        m = classify(
            [AnswerRecord(question_id=1, answer="B", line_no=1),
             AnswerRecord(question_id=99, answer="X", line_no=2)],
            [_row(1, "choice", answer="A"), None],
        )
        out = format_report(target="测试", diff=build_diff(m.paired),
                            unmatched=m.unresolved, out_of_scope=m.out_of_scope,
                            warnings=["示例警告"], apply=False)
        assert "目标：测试" in out
        assert "将更新 1 题" in out
        assert "更新明细" in out
        assert "定位失败 1 条" in out
        assert "示例警告" in out
        assert "dry-run" in out

    def test_out_of_scope_section(self):
        m = classify([AnswerRecord(question_id=3, answer="C", line_no=1)], [_row(3)], in_scope_ids=set())
        out = format_report(target="T", diff=[], unmatched=m.unresolved,
                            out_of_scope=m.out_of_scope, warnings=[], apply=False)
        assert "范围外跳过 1 条" in out

    def test_no_change_idempotent(self):
        out = format_report(target="T", diff=[], unmatched=[], out_of_scope=[],
                            warnings=[], apply=False)
        assert "幂等重跑" in out
