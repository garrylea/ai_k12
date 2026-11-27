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
