"""answer_importer_cli：argparse + SQL 构造（纯函数，不连库）。"""

import pytest

from answer_importer import QuestionRow, ScopeFilter
from answer_importer_cli import (
    build_export_sql,
    build_scope,
    build_update_sql,
    parse_args,
    parse_int_set,
)
from answer_records import AnswerRecord


class TestArgs:
    def test_defaults(self):
        args = parse_args(["--records", "a.jsonl"])
        assert args.apply is False
        assert args.paper_id is None
        assert args.limit == 500

    def test_apply_and_paper(self):
        args = parse_args(["--doc", "a.md", "--paper-id", "3", "--apply"])
        assert args.paper_id == 3 and args.apply is True

    def test_records_doc_mutually_exclusive(self):
        with pytest.raises(SystemExit):
            parse_args(["--records", "a.jsonl", "--doc", "b.md"])

    def test_export_records_mutually_exclusive(self):
        with pytest.raises(SystemExit):
            parse_args(["--export", "--records", "a.jsonl"])


class TestParseIntSet:
    def test_list_and_range(self):
        assert parse_int_set("1,2,10-12") == {1, 2, 10, 11, 12}

    def test_single(self):
        assert parse_int_set("7") == {7}

    def test_bad_range(self):
        with pytest.raises(ValueError, match="区间非法"):
            parse_int_set("10-1")


class TestBuildScope:
    def test_full(self):
        args = parse_args([
            "--records", "a.jsonl", "--paper-id", "3", "--question-no", "1,17",
            "--where", "answer_empty,approach_empty", "--source", "海淀",
            "--type", "choice,calculation", "--difficulty", "2", "--content-hash", "a" * 64,
        ])
        scope = build_scope(args)
        assert scope.paper_ids == [3]
        assert scope.question_nos == {1, 17}
        assert scope.gaps == {"answer_empty", "approach_empty"}
        assert scope.sources == ["海淀"]
        assert scope.types == ["choice", "calculation"]
        assert scope.difficulty == 2
        assert scope.content_hash == "a" * 64

    def test_empty(self):
        assert build_scope(parse_args(["--records", "a.jsonl"])).is_empty()


class TestUpdateSql:
    def test_no_type_change(self):
        rec = AnswerRecord(question_id=101, answer="B", approach="配方")
        row = QuestionRow(question_id=101, type="choice", answer="A")
        sql, params = build_update_sql(rec, row)
        assert "type =" not in sql
        assert "answer_verified = 1" in sql
        assert params == ["B", "配方", 101]

    def test_with_type_change(self):
        rec = AnswerRecord(question_id=117, type="calculation", answer="x=2")
        row = QuestionRow(question_id=117, type="short_answer", answer="")
        sql, params = build_update_sql(rec, row)
        assert "type = %s" in sql
        assert params == ["x=2", "calculation", 117]

    def test_only_changed_fields_included(self):
        rec = AnswerRecord(question_id=5, explanation="新")
        row = QuestionRow(question_id=5, type="choice", answer="A")
        sql, params = build_update_sql(rec, row)
        assert "answer =" not in sql
        assert "approach =" not in sql
        assert params == ["新", 5]


class TestExportSql:
    def test_single_paper_joins_for_question_no(self):
        sql, params = build_export_sql(ScopeFilter(paper_ids=[3]), limit=10)
        assert "LEFT JOIN paper_questions" in sql
        assert "pq.question_no" in sql
        # 第一个参数是 JOIN 的 paper_id，第二个是 WHERE 子查询的 paper_id
        assert params == [3, 3, 10]

    def test_no_paper_plain(self):
        sql, params = build_export_sql(ScopeFilter(gaps={"answer_empty"}), limit=10)
        assert "LEFT JOIN" not in sql
        assert params == [10]

    def test_paper_plus_gap(self):
        sql, params = build_export_sql(
            ScopeFilter(paper_ids=[3], gaps={"answer_empty"}), limit=5)
        assert "LEFT JOIN paper_questions" in sql
        assert params == [3, 3, 5]


class TestBuildScopePaperResolution:
    def test_resolved_paper_id_used(self):
        args = parse_args(["--records", "a.jsonl"])
        assert build_scope(args, paper_id=7).paper_ids == [7]

    def test_paper_title_then_question_no(self):
        # --paper-title 解析出 paper_id 后，--question-no 才能生效
        args = parse_args(["--records", "a.jsonl", "--question-no", "1,3"])
        scope = build_scope(args, paper_id=9)
        assert scope.paper_ids == [9]
        assert scope.question_nos == {1, 3}

    def test_args_paper_id_still_used_without_param(self):
        args = parse_args(["--records", "a.jsonl", "--paper-id", "3"])
        assert build_scope(args).paper_ids == [3]
