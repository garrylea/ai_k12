from stem_chain import (
    StemCandidate, StemEvidence, StemOption, StemPath,
    has_hard_veto, option_rank_key, path_rank_key, recovery_cost,
)


def ev(tag: str, polarity: str = "positive") -> StemEvidence:
    return StemEvidence(tag=tag, polarity=polarity)


def opt(
    number: int = 12,
    *,
    candidate_id: str = "L10-O1",
    raw_number: int | None = None,
    form: str = "main",
    recovery: str = "exact",
    evidence: tuple[StemEvidence, ...] = (),
) -> StemOption:
    return StemOption(
        candidate_id=candidate_id,
        raw_number=number if raw_number is None else raw_number,
        number=number,
        form=form,
        recovery=recovery,
        evidence=evidence,
        content_rest="求二次函数的解析式",
    )


def test_recovery_cost_is_ordered_from_exact_to_dropped_tens():
    assert recovery_cost(opt(recovery="exact")) == 0
    assert recovery_cost(opt(recovery="glued_suffix")) == 1
    assert recovery_cost(opt(recovery="missing_dot")) == 1
    assert recovery_cost(opt(recovery="dropped_tens", raw_number=2)) == 3


def test_hard_veto_cannot_be_offset_by_positive_evidence():
    option = opt(evidence=(
        ev("line_start"), ev("blank_before"), ev("chinese_after"),
        ev("inside_math", "veto"),
    ))
    assert has_hard_veto(option)


def test_rank_prefers_exact_form_then_paragraph_and_stem_evidence():
    exact = opt(evidence=(ev("blank_before"), ev("stem_keyword")))
    glued = opt(
        candidate_id="L20-O1",
        form="glued_number",
        recovery="glued_suffix",
        evidence=(ev("blank_before"), ev("blank_before"), ev("blank_before")),
    )
    assert option_rank_key(exact) < option_rank_key(glued)


def test_path_rank_sums_recovery_before_positive_structure():
    cheap = StemPath(
        assignments=((10, 12, "A"),),
        rank_key=(),
        selected_options=(opt(candidate_id="A"),),
    )
    repaired = StemPath(
        assignments=((20, 12, "B"),),
        rank_key=(),
        selected_options=(opt(
            candidate_id="B",
            raw_number=2,
            recovery="dropped_tens",
            evidence=(ev("blank_before"), ev("stem_keyword")),
        ),),
    )
    assert path_rank_key(cheap) < path_rank_key(repaired)


from question_splitter import (
    ambiguous_stem_candidate, bare_stem_candidate, split_glued_next_stem,
)
from stem_chain import collect_main_stem_probes, select_stem_anchors
from subject_strategies import get_strategy


def test_public_splitter_predicates_reuse_existing_runtime_rules():
    assert ambiguous_stem_candidate("25.16 世纪中叶，我国发明火箭") == (
        25, "16 世纪中叶，我国发明火箭",
    )
    assert bare_stem_candidate("11 在平面直角坐标系中求点坐标") == (
        11, "在平面直角坐标系中求点坐标",
    )
    assert split_glued_next_stem("前文。16.根据材料三回答", 16) == (
        "前文。", 16, "根据材料三回答",
    )


def test_main_probes_then_anchors_are_two_phase_and_ordered():
    md = """# 卷

1. 第一题求一次函数解析式

1. 第一题重复且正文更长一些

3. 第三题证明三角形全等
"""
    probes = collect_main_stem_probes(md, get_strategy("math"))
    anchors = select_stem_anchors(probes)
    assert [candidate.options[0].number for candidate in anchors] == [1, 3]
    assert [candidate.line_no for candidate in anchors] == [2, 6]


from stem_chain import collect_interval_candidates, supports_global_stem_chain


def test_only_math_enables_global_chain_initially():
    assert supports_global_stem_chain(get_strategy("math"))
    assert not supports_global_stem_chain(get_strategy("chinese"))
    assert not supports_global_stem_chain(get_strategy("english"))


def test_interval_candidates_keep_12_8_and_12_16_as_same_number_options():
    md = """11. 第十一题已知函数

10.5 米处的测量数据

12.8 米处是正文数字

12.16 世纪中叶的新式火箭

13. 第十三题求坐标
"""
    probes = collect_main_stem_probes(md, get_strategy("math"))
    anchors = select_stem_anchors(probes)
    result = collect_interval_candidates(md, get_strategy("math"), anchors)
    by_line = {
        candidate.line_no: [option.number for option in candidate.options]
        for candidate in result.candidates
    }
    assert 12 in by_line[4] and 12 in by_line[6]
    assert 10 not in by_line.get(2, [])


def test_interval_candidates_generate_dropped_tens_only_inside_gap():
    md = """11. 第十一题

2. 第二组数据的第一段题目正文

3. 第二组数据的第二段题目正文

4. 第二组数据的第三段题目正文

15. 第十五题
"""
    probes = collect_main_stem_probes(md, get_strategy("math"))
    anchors = select_stem_anchors(probes)
    result = collect_interval_candidates(md, get_strategy("math"), anchors)
    recovered = {
        option.number
        for candidate in result.candidates
        for option in candidate.options
        if option.recovery == "dropped_tens"
    }
    assert recovered == {12, 13, 14}


from stem_chain import (
    StemCollectionResult, StemChainResult,
    select_stem_chains, validate_forced_assignments,
)


def candidate(line_no: int, options: tuple[StemOption, ...]) -> StemCandidate:
    return StemCandidate(
        line_no=line_no,
        text=f"line {line_no}",
        options=options,
        context_before="",
        context_after="",
    )


def anchor(line_no: int, number: int) -> StemCandidate:
    return StemCandidate(
        line_no=line_no,
        text=f"{number}. anchor",
        options=(opt(number=number, candidate_id=f"L{line_no}-Main"),),
        context_before="",
        context_after="",
        anchor=True,
    )


def test_top_two_keeps_lower_scored_option_when_high_option_breaks_order():
    anchors = (anchor(0, 11), anchor(6, 14))
    high_late = opt(
        number=12, candidate_id="late",
        evidence=(ev("blank_before"), ev("blank_before"), ev("blank_before")),
    )
    low_early = opt(
        number=12, candidate_id="early",
        evidence=(ev("blank_before"),),
    )
    no_13 = opt(number=13, candidate_id="q13")
    collection = StemCollectionResult(
        anchors=anchors,
        candidates=(
            candidate(1, (low_early,)),
            candidate(3, (no_13,)),
            candidate(4, (high_late,)),
        ),
        consumed_lines=frozenset(),
    )
    result = select_stem_chains(collection)
    assert result.accepted[1] == (12, "main", "exact")
    assert result.accepted[3] == (13, "main", "exact")
    assert 4 not in result.accepted


def test_equal_paths_are_ambiguous_not_line_order_wins():
    anchors = (anchor(0, 11), anchor(4, 13))
    left = opt(number=12, candidate_id="left")
    right = opt(number=12, candidate_id="right")
    collection = StemCollectionResult(
        anchors=anchors,
        candidates=(candidate(1, (left,)), candidate(2, (right,))),
        consumed_lines=frozenset(),
    )
    result = select_stem_chains(collection)
    assert result.accepted == {}
    assert result.ambiguities[0].reason == "ambiguous"
    assert [p.selected_options[0].candidate_id for p in result.ambiguities[0].top_paths] == [
        "left", "right",
    ]


def test_missing_26_keeps_25_prefix_and_creates_gap_segment():
    anchors = (anchor(0, 24), anchor(5, 27))
    q25 = opt(number=25, candidate_id="q25", evidence=(ev("blank_before"), ev("stem_keyword")))
    weak26 = opt(
        number=26, candidate_id="q26",
        evidence=(ev("inside_math", "veto"),),
    )
    collection = StemCollectionResult(
        anchors=anchors,
        candidates=(candidate(1, (q25,)), candidate(2, (weak26,))),
        consumed_lines=frozenset(),
    )
    result = select_stem_chains(collection)
    assert 1 in result.accepted
    assert any(g.missing_numbers == (26,) for g in result.gap_segments)
    assert any(i.code == "stem_chain_gap" for i in result.issues)


def test_forced_assignment_duplicate_is_an_error():
    result = StemChainResult(
        accepted={1: (12, "main", "exact"), 2: (12, "main", "exact")},
        gaps=[], gap_segments=[], ambiguities=[], safe_prefix={}, issues=[],
    )
    issues = validate_forced_assignments(result)
    assert [issue.code for issue in issues] == ["stem_chain_forced_duplicate"]


def test_out_of_line_order_anchors_do_not_create_reversed_gap():
    """锚点按题号排序但 line_no 回指（2/3/4 出现在第 11 题之后）时，
    反向区间 C4-11 不能造出虚假 stem_chain_gap / 越界 line_start > line_end。"""
    anchors = (
        anchor(2, 2), anchor(4, 3), anchor(6, 4), anchor(0, 11), anchor(8, 15),
    )
    collection = StemCollectionResult(
        anchors=anchors, candidates=(), consumed_lines=frozenset(),
    )
    result = select_stem_chains(
        collection, source_lines=[f"line {i}" for i in range(10)],
    )
    assert not any(i.interval_id == "C4-11" for i in result.issues)
    assert not any(
        (seg.left_question_no, seg.right_question_no) == (4, 11)
        for seg in result.gap_segments
    )
    # 正常行序区间不受影响；所有 gap 段的边界始终自洽。
    assert any(i.interval_id == "C11-15" for i in result.issues)
    for seg in result.gap_segments:
        assert seg.line_start is None or seg.line_start <= seg.line_end
        if seg.boundary_known:
            assert seg.line_start is not None and seg.line_end >= seg.line_start
