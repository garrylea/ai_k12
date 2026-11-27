import json
from pathlib import Path

from question_extract import (
    _purge_stem_chain_issues_for_source, _write_stem_chain_issues,
)
from stem_chain import StemIssue


def test_stem_chain_issue_log_replaces_same_source_only(tmp_path):
    log = tmp_path / "stem_chain_issues.jsonl"
    log.write_text(
        '{"source":"卷A","code":"old"}\n'
        '{"source":"卷B","code":"keep"}\n',
        encoding="utf-8",
    )
    _purge_stem_chain_issues_for_source(log, "卷A")
    rows = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert rows == [{"source": "卷B", "code": "keep"}]


def test_write_stem_chain_issues_serializes_stable_fields(tmp_path):
    log = tmp_path / "stem_chain_issues.jsonl"
    count = _write_stem_chain_issues(log, "卷A", [
        StemIssue(
            code="stem_chain_gap",
            severity="error",
            message="缺 26",
            line_no=12,
            excerpt="26. 弱候选",
            question_no=26,
            interval_id="C25-27",
            candidate_ids=("L12-Main-26",),
        )
    ])
    row = json.loads(log.read_text(encoding="utf-8").splitlines()[0])
    assert count == 1
    assert row["source"] == "卷A"
    assert row["question_no"] == 26
    assert row["candidate_ids"] == ["L12-Main-26"]


def test_capability_disabled_never_enters_global_chain(monkeypatch):
    import question_extract as qe
    from subject_strategies import get_strategy

    def boom(*args, **kwargs):
        raise AssertionError("global chain must not run")

    monkeypatch.setattr(qe, "collect_main_stem_probes", boom)
    result, issues = qe._split_paper_questions(
        "1. 第一题正文",
        Path("english.md"),
        get_strategy("english"),
        None,
        False,
    )
    assert [q.group_order for q in result.questions] == [1]
    assert issues == []
