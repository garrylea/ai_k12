import json
from pathlib import Path
from types import SimpleNamespace

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


def test_local_llm_arbitration_merges_drops_stale_issues_and_lifts_suppression(monkeypatch):
    """llm_provider=local 启用路径：仲裁结果并入 forced map、旧 gap issue 被丢弃、
    gap suppression range 随之消失；全程不触碰真实 LLM/DB/网络。"""
    import question_extract as qe
    from stem_chain import StemIssue
    from stem_chain_arbiter import StemArbitrationResult
    from subject_strategies import get_strategy

    text = """11. 第十一题题干内容很长。

2. 第十二题候选甲内容很长。

2. 第十二题候选乙内容很长。

13. 第十三题题干内容。

4. 第十四题弱候选内容。

16. 第十六题题干内容。
"""
    strategy = get_strategy("math")
    # 未仲裁时 C13-16 是 gap：第 14 题候选行落在 suppression range 内，被吞掉。
    baseline, _ = qe._split_paper_questions(
        text, Path("local-arb.md"), strategy, None, False,
    )
    assert 14 not in [q.group_order for q in baseline.questions]

    calls: list[object] = []

    def fake_arbitrate(llm, ambiguities, paper_stem):
        calls.append(paper_stem)
        return StemArbitrationResult(
            accepted={
                8: (14, "main", "dropped_tens"),
                9: (15, "bare", "missing_dot"),
            },
            issues=[StemIssue(
                code="stem_chain_llm_resolved", severity="info",
                message="C13-16 本地 LLM 完成闭集分配", line_no=9,
                excerpt="", question_no=14, interval_id="C13-16",
            )],
        )

    monkeypatch.setattr(qe, "arbitrate_stem_ambiguities", fake_arbitrate)
    config = SimpleNamespace(llm_provider="local")
    result, issues = qe._split_paper_questions(
        text,
        Path("local-arb.md"),
        strategy,
        object(),  # 假 llm：只被 fake 接收，绝不被调用
        config.llm_provider == "local",
    )

    # 仲裁确实走启用路径，且只调用一次。
    assert calls == ["local-arb"]
    # 仲裁合并：accepted 写回链结果，第 14 题的槽位与正文都被保留。
    assert result.stem_chain_result.accepted[8] == (14, "main", "dropped_tens")
    assert result.stem_chain_result.accepted[9] == (15, "bare", "missing_dot")
    by_no = {q.group_order: q for q in result.questions}
    assert 14 in by_no and "第十四题弱候选" in by_no[14].content
    # 陈旧 issue 丢弃：同一 interval 的 stem_chain_gap 被 resolved 取代。
    assert [i.code for i in issues if i.interval_id == "C13-16"] == [
        "stem_chain_llm_resolved",
    ]
    # suppression range 解除：gap segment 的缺号已被仲裁全部接受。
    assert not any(
        gap.missing_numbers == (14, 15)
        for gap in result.stem_chain_result.gap_segments
    )


def test_dropped_tens_paper_suppresses_ambiguity_until_arbitrated():
    """卷首 `2./3./4.` + 第 11/15 题锚点：未仲裁时不能吐出 2/3/4；
    仲裁成功后闭集恢复 11-15，且反向锚点 C4-11 的假 gap 全程不出现。"""
    import question_extract as qe
    from subject_strategies import get_strategy

    text = """11. 第十一题题干内容很长很长需要满足行长判定。

2. 第十二十一题备选内容也很长很长。

3. 第十二十三题备选内容也很长很长。

4. 第十二十四题备选内容也很长很长。

15. 第十五题题干内容很长很长。
"""
    strategy = get_strategy("math")

    unresolved, issues = qe._split_paper_questions(
        text, Path("dropped-tens.md"), strategy, None, False,
    )
    assert [q.group_order for q in unresolved.questions] == [11, 15]
    assert not {2, 3, 4} & {q.group_order for q in unresolved.questions}
    # 未仲裁区间必须留下 gap segment + gap issue；该 gap 覆盖候选行与缺号。
    assert any(
        seg.missing_numbers == (12, 13, 14)
        and seg.line_start == 2 and seg.line_end == 7 and seg.boundary_known
        for seg in unresolved.stem_chain_result.gap_segments
    )
    assert any(
        i.code == "stem_chain_gap" and i.interval_id == "C11-15" for i in issues
    )
    assert not any(i.interval_id == "C4-11" for i in issues)

    class FakeLLM:
        def complete(self, system, user):
            intervals = json.loads(user)["intervals"]
            return SimpleNamespace(content=json.dumps({
                "intervals": [
                    {
                        "interval_id": iv["interval_id"],
                        "result": "resolved",
                        "assignments": [
                            {"number": c["number"], "candidate_id": c["candidate_id"]}
                            for c in iv["candidates"]
                        ],
                    }
                    for iv in intervals
                ]
            }, ensure_ascii=False))

    resolved, resolved_issues = qe._split_paper_questions(
        text, Path("dropped-tens.md"), strategy, FakeLLM(), True,
    )
    assert [q.group_order for q in resolved.questions] == [11, 12, 13, 14, 15]
    # 仲裁成功后该区间不再有 gap issue / gap segment；C4-11 假 gap 也不存在。
    assert not any(
        seg.missing_numbers == (12, 13, 14)
        for seg in resolved.stem_chain_result.gap_segments
    )
    assert [
        i.code for i in resolved_issues if i.interval_id == "C11-15"
    ] == ["stem_chain_llm_resolved"]
    assert not any(i.interval_id == "C4-11" for i in resolved_issues)
