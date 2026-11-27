from dataclasses import dataclass


@dataclass(frozen=True)
class StemEvidence:
    tag: str
    polarity: str
    detail: str = ""


@dataclass(frozen=True)
class StemOption:
    candidate_id: str
    raw_number: int | None
    number: int
    form: str
    recovery: str
    evidence: tuple[StemEvidence, ...]
    content_rest: str


@dataclass(frozen=True)
class StemCandidate:
    line_no: int
    text: str
    options: tuple[StemOption, ...]
    context_before: str
    context_after: str
    anchor: bool = False


@dataclass(frozen=True)
class StemPath:
    assignments: tuple[tuple[int, int, str], ...]
    rank_key: tuple
    selected_options: tuple[StemOption, ...]


@dataclass(frozen=True)
class StemAmbiguity:
    reason: str
    left_anchor: int
    right_anchor: int
    expected_numbers: tuple[int, ...]
    candidates: tuple[StemCandidate, ...]
    top_paths: tuple[StemPath, ...]


@dataclass(frozen=True)
class StemGapSegment:
    left_question_no: int
    right_question_no: int
    missing_numbers: tuple[int, ...]
    line_start: int | None
    line_end: int
    excerpt: str
    boundary_known: bool


@dataclass(frozen=True)
class StemIssue:
    code: str
    severity: str
    message: str
    line_no: int
    excerpt: str
    question_no: int | None = None
    interval_id: str | None = None
    candidate_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class StemCollectionResult:
    anchors: tuple[StemCandidate, ...]
    candidates: tuple[StemCandidate, ...]
    consumed_lines: frozenset[int]


@dataclass(frozen=True)
class StemChainResult:
    accepted: dict[int, tuple[int, str, str]]
    gaps: list[tuple[int, int, int]]
    gap_segments: list[StemGapSegment]
    ambiguities: list[StemAmbiguity]
    safe_prefix: dict[int, tuple[int, str, str]]
    issues: list[StemIssue]


_RECOVERY_COST = {
    "exact": 0,
    "glued_suffix": 1,
    "missing_dot": 1,
    "dropped_tens": 3,
}


def recovery_cost(option: StemOption) -> int:
    return _RECOVERY_COST[option.recovery]


def has_hard_veto(option: StemOption) -> bool:
    return any(e.polarity == "veto" for e in option.evidence)


def _positive_count(option: StemOption, tags: set[str]) -> int:
    return sum(
        e.polarity == "positive" and e.tag in tags
        for e in option.evidence
    )


def option_rank_key(option: StemOption) -> tuple:
    return (
        recovery_cost(option),
        -_positive_count(option, {"blank_before", "paragraph_break", "prev_sentence_end"}),
        -_positive_count(option, {"chinese_after", "long_stem", "stem_keyword", "math_after"}),
        -_positive_count(option, {"near_right_anchor", "answer_slot_hint", "continuous_context"}),
    )


def path_rank_key(path: StemPath) -> tuple:
    total_recovery = sum(recovery_cost(o) for o in path.selected_options)
    paragraph = sum(
        _positive_count(o, {"blank_before", "paragraph_break", "prev_sentence_end"})
        for o in path.selected_options
    )
    stem = sum(
        _positive_count(o, {"chinese_after", "long_stem", "stem_keyword", "math_after"})
        for o in path.selected_options
    )
    context = sum(
        _positive_count(o, {"near_right_anchor", "answer_slot_hint", "continuous_context"})
        for o in path.selected_options
    )
    return total_recovery, -paragraph, -stem, -context


from question_splitter import (
    is_answer_keyword, is_junk_stem_line, is_main_stem, is_notice_stem_line,
)


def _body_evidence(rest: str, blank_before: bool) -> tuple[StemEvidence, ...]:
    evidence = [StemEvidence("line_start", "positive")]
    if blank_before:
        evidence.append(StemEvidence("blank_before", "positive"))
    if len(rest) >= 6 and any("\u4e00" <= ch <= "\u9fff" for ch in rest):
        evidence.append(StemEvidence("chinese_after", "positive"))
    if len(rest) >= 30:
        evidence.append(StemEvidence("long_stem", "positive"))
    if any(word in rest for word in ("求", "证明", "如图", "已知", "解方程")):
        evidence.append(StemEvidence("stem_keyword", "positive"))
    return tuple(evidence)


def collect_main_stem_probes(text: str, strategy) -> list[StemCandidate]:
    lines = text.split("\n")
    probes: list[StemCandidate] = []
    blank_before = False
    for i, line in enumerate(lines):
        if not line.strip():
            blank_before = True
            continue
        if is_answer_keyword(line):
            break
        ok, number = strategy.is_stem(line)
        if not ok or number is None:
            blank_before = False
            continue
        rest = line.lstrip()
        rest = rest.split(".", 1)[1].strip() if "." in rest else rest
        evidence = _body_evidence(rest, blank_before)
        if is_junk_stem_line(line):
            evidence += (StemEvidence("notice_junk", "veto"),)
        elif is_notice_stem_line(line) and not probes:
            evidence += (StemEvidence("notice_junk", "veto"),)
        option = StemOption(
            candidate_id=f"L{i}-Main",
            raw_number=number,
            number=number,
            form="main",
            recovery="exact",
            evidence=evidence,
            content_rest=rest,
        )
        probes.append(StemCandidate(
            line_no=i,
            text=line.strip()[:160],
            options=(option,),
            context_before="\n".join(lines[max(0, i - 2):i]),
            context_after="\n".join(lines[i + 1:i + 3]),
        ))
        blank_before = False
    return probes


def select_stem_anchors(probes: list[StemCandidate]) -> list[StemCandidate]:
    best_by_number: dict[int, StemCandidate] = {}
    for candidate in probes:
        option = candidate.options[0]
        if has_hard_veto(option):
            continue
        current = best_by_number.get(option.number)
        if current is None:
            best_by_number[option.number] = candidate
            continue
        current_option = current.options[0]
        if option_rank_key(option) < option_rank_key(current_option):
            best_by_number[option.number] = candidate

    anchors: list[StemCandidate] = []
    last_no = 0
    for number in sorted(best_by_number):
        candidate = best_by_number[number]
        option = candidate.options[0]
        if option.number <= last_no:
            continue
        anchors.append(StemCandidate(
            line_no=candidate.line_no,
            text=candidate.text,
            options=candidate.options,
            context_before=candidate.context_before,
            context_after=candidate.context_after,
            anchor=True,
        ))
        last_no = option.number
    return anchors


from question_splitter import (
    ambiguous_stem_candidate, bare_stem_candidate, orphan_stem_candidate,
    split_glued_next_stem,
)


def supports_global_stem_chain(strategy) -> bool:
    return bool(getattr(strategy, "supports_global_stem_chain", False))


def _expected_between(left: int, right: int) -> tuple[int, ...]:
    return tuple(range(left + 1, right))


def _option(
    line_no: int,
    number: int,
    form: str,
    recovery: str,
    rest: str,
    raw_number: int,
    context: tuple[StemEvidence, ...],
) -> StemOption:
    return StemOption(
        candidate_id=f"L{line_no}-{form}-{number}",
        raw_number=raw_number,
        number=number,
        form=form,
        recovery=recovery,
        evidence=context,
        content_rest=rest,
    )


def _display_math_open(lines: list[str], line_no: int) -> bool:
    opens = sum(line.count("$$") for line in lines[:line_no]) % 2
    return bool(opens)


def _hard_veto_evidence(lines: list[str], line_no: int) -> tuple[StemEvidence, ...]:
    line = lines[line_no]
    veto: list[StemEvidence] = []
    if _display_math_open(lines, line_no):
        veto.append(StemEvidence("inside_math", "veto"))
    stripped = line.lstrip()
    if stripped.startswith(("=", "+", "-", "×", "÷")):
        veto.append(StemEvidence("after_operator", "veto"))
    return tuple(veto)


def _ordered_anchor_pairs(anchors):
    """只产出按行号递增的相邻锚点对。

    select_stem_anchors 按题号排序，卷首小号（如 `2.` `3.` `4.` 出现在第 11 题之后）
    会让相邻锚点的 line_no 回指，zip 出反向区间并造出虚假的 gap。这类锚点对不构成
    题号链区间，三个消费锚点对的地方统一跳过。
    """
    return (
        (left, right)
        for left, right in zip(anchors, anchors[1:])
        if left.line_no < right.line_no
    )


def collect_interval_candidates(text: str, strategy, anchors: list[StemCandidate]):
    if not supports_global_stem_chain(strategy):
        return StemCollectionResult(tuple(anchors), (), frozenset())
    lines = text.split("\n")
    candidates: list[StemCandidate] = []
    consumed: set[int] = set()
    for left, right in _ordered_anchor_pairs(anchors):
        left_no = left.options[0].number
        right_no = right.options[0].number
        expected = set(_expected_between(left_no, right_no))
        if not expected:
            continue
        # 锚点的题号锁定只对「以它为边界的区间」生效；同一行在另一个区间里
        # 仍可产生别的题号解释（如 11→15 区间内的 `2.` → 12）。
        boundary_lines = {left.line_no, right.line_no}
        for i in range(left.line_no + 1, right.line_no):
            line = lines[i]
            blank_before = i > 0 and not lines[i - 1].strip()
            context = _body_evidence(line.strip(), blank_before) + _hard_veto_evidence(lines, i)
            options: list[StemOption] = []

            ok, number = strategy.is_stem(line)
            if ok and i not in boundary_lines:
                rest = line.lstrip().split(".", 1)[-1].strip()
                if number in expected:
                    options.append(_option(
                        i, number, "main", "exact", rest, number, context,
                    ))
                for wanted in expected:
                    if wanted >= 10 and wanted % 10 == number:
                        options.append(_option(
                            i, wanted, "main", "dropped_tens",
                            rest, number, context,
                        ))

            ambiguous = ambiguous_stem_candidate(line)
            if ambiguous:
                number, rest = ambiguous
                glued_number = next(
                    (n for n in expected if n == number), None
                )
                if glued_number is not None:
                    options.append(_option(
                        i, glued_number, "glued_number", "glued_suffix",
                        rest, number, context,
                    ))

            bare = bare_stem_candidate(line)
            if bare:
                number, rest = bare
                if number in expected:
                    options.append(_option(
                        i, number, "bare", "missing_dot", rest, number, context,
                    ))
                for wanted in expected:
                    if wanted >= 10 and wanted % 10 == number:
                        options.append(_option(
                            i, wanted, "bare", "dropped_tens",
                            rest, number, context,
                        ))

            orphan = orphan_stem_candidate(line)
            if orphan:
                rest = orphan[0]
                number = left_no + 1
                if number in expected and blank_before:
                    options.append(_option(
                        i, number, "orphan_dot", "missing_dot",
                        rest, number, context,
                    ))

            glued = split_glued_next_stem(line, left_no + 1)
            if glued:
                _head, number, rest = glued
                if number in expected:
                    options.append(_option(
                        i, number, "inline_glued", "exact", rest, number,
                        context + (StemEvidence("continuous_context", "positive"),),
                    ))
                    consumed.add(i)

            kept = tuple(o for o in options if not has_hard_veto(o))
            if kept:
                candidates.append(StemCandidate(
                    line_no=i,
                    text=line.strip()[:160],
                    options=kept,
                    context_before="\n".join(lines[max(0, i - 2):i]),
                    context_after="\n".join(lines[i + 1:i + 3]),
                ))

    return StemCollectionResult(
        anchors=tuple(anchors),
        candidates=tuple(candidates),
        consumed_lines=frozenset(consumed),
    )


def _options_by_number(collection: StemCollectionResult) -> dict[int, list[tuple[int, StemOption]]]:
    out: dict[int, list[tuple[int, StemOption]]] = {}
    for candidate in collection.candidates:
        for option in candidate.options:
            if not has_hard_veto(option):
                out.setdefault(option.number, []).append((candidate.line_no, option))
    return out


def _top_two(paths: list[StemPath]) -> list[StemPath]:
    ranked = sorted(paths, key=lambda p: p.rank_key)
    unique: list[StemPath] = []
    seen: set[tuple] = set()
    for path in ranked:
        key = tuple((line, number, cid) for line, number, cid in path.assignments)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
        if len(unique) == 2:
            break
    return unique


def _complete_paths(
    collection: StemCollectionResult,
) -> list[tuple[int, int, list[StemPath], dict[int, list[StemPath]]]]:
    options = _options_by_number(collection)
    completed = []
    for left, right in _ordered_anchor_pairs(collection.anchors):
        left_no = left.options[0].number
        right_no = right.options[0].number
        expected = tuple(range(left_no + 1, right_no))
        paths_by_no: dict[int, list[StemPath]] = {
            left_no: [StemPath(
                assignments=((left.line_no, left_no, left.options[0].candidate_id),),
                rank_key=(0, 0, 0, 0),
                selected_options=(),
            )]
        }
        for number in expected:
            expanded: list[StemPath] = []
            for prev in paths_by_no.get(number - 1, []):
                prev_line = prev.assignments[-1][0]
                for line_no, option in options.get(number, []):
                    if line_no <= prev_line or line_no >= right.line_no:
                        continue
                    selected = prev.selected_options + (option,)
                    assignments = prev.assignments + ((line_no, number, option.candidate_id),)
                    draft = StemPath(
                        assignments=assignments,
                        rank_key=(),
                        selected_options=selected,
                    )
                    expanded.append(StemPath(
                        assignments=assignments,
                        rank_key=path_rank_key(draft),
                        selected_options=selected,
                    ))
            paths_by_no[number] = _top_two(expanded)
        completed.append((left_no, right_no, paths_by_no.get(right_no - 1, []), paths_by_no))
    return completed


def select_stem_chains(
    collection: StemCollectionResult,
    *,
    source_lines: list[str] | None = None,
    margin: int = 2,
) -> StemChainResult:
    accepted: dict[int, tuple[int, str, str]] = {}
    safe_prefix: dict[int, tuple[int, str, str]] = {}
    gaps: list[tuple[int, int, int]] = []
    gap_segments: list[StemGapSegment] = []
    ambiguities: list[StemAmbiguity] = []
    issues: list[StemIssue] = []

    for left, right in _ordered_anchor_pairs(collection.anchors):
        left_no = left.options[0].number
        right_no = right.options[0].number
        matching = next(
            (entry for entry in _complete_paths(collection)
             if entry[0] == left_no and entry[1] == right_no),
            None,
        )
        paths = matching[2] if matching else []
        if paths:
            first = paths[0]
            needs_confirmation = any(
                option.recovery == "dropped_tens" for option in first.selected_options
            )
            clear_winner = (
                len(paths) == 1
                or first.rank_key[0] < paths[1].rank_key[0]
                or sum(first.rank_key[1:]) + margin <= sum(paths[1].rank_key[1:])
            )
            if clear_winner and not needs_confirmation:
                for line_no, number, cid in first.assignments[1:]:
                    option = next(o for o in first.selected_options if o.candidate_id == cid)
                    accepted[line_no] = (number, option.form, option.recovery)
                continue
            interval_candidates = tuple(
                candidate for candidate in collection.candidates
                if left.line_no < candidate.line_no < right.line_no
            )
            ambiguities.append(StemAmbiguity(
                reason="high_risk_recovery" if needs_confirmation else "ambiguous",
                left_anchor=left_no,
                right_anchor=right_no,
                expected_numbers=tuple(range(left_no + 1, right_no)),
                candidates=interval_candidates,
                top_paths=tuple(paths),
            ))
            issues.append(StemIssue(
                code="stem_chain_high_risk_recovery" if needs_confirmation else "stem_chain_ambiguous",
                severity="warning",
                message=f"题 {left_no}→{right_no} 需要本地 LLM 仲裁",
                line_no=left.line_no + 1,
                excerpt=left.text,
                question_no=left_no + 1,
                interval_id=f"C{left_no}-{right_no}",
            ))
            # 未仲裁 = 当前区间保留 gap：候选行整体压住，不让裸题号兜底把
            # `2./3./4.` 原样吐成第 2/3/4 题；仲裁成功后 question_extract 会按
            # interval_id 丢掉这里的 stem_chain_gap 并解除 suppression。
            missing = tuple(range(left_no + 1, right_no))
            weak = [candidate.line_no for candidate in interval_candidates]
            start = min(weak) if weak else None
            end = right.line_no - 1
            boundary_known = start is not None and end >= start
            if not boundary_known:
                start = None
                end = max(end, 0)
            if source_lines is not None and start is not None:
                gap_text = "\n".join(source_lines[start:end + 1])
            else:
                gap_text = "\n".join(
                    candidate.text for candidate in interval_candidates
                )
            gaps.append((left_no, left_no + 1, left.line_no + 1))
            gap_segments.append(StemGapSegment(
                left_question_no=left_no,
                right_question_no=right_no,
                missing_numbers=missing,
                line_start=start,
                line_end=end,
                excerpt=gap_text[:600],
                boundary_known=boundary_known,
            ))
            issues.append(StemIssue(
                code="stem_chain_gap",
                severity="error",
                message=f"题号链在 {left_no}→{left_no + 1} 待仲裁确认",
                line_no=left.line_no + 1,
                excerpt=gap_text[:600],
                question_no=left_no + 1,
                interval_id=f"C{left_no}-{right_no}",
            ))
            continue

        # No complete path: accept only the left-connected safe prefix.
        expected = tuple(range(left_no + 1, right_no))
        options = _options_by_number(collection)
        last_line = left.line_no
        stopped_at = None
        for number in expected:
            choices = [
                (line_no, option)
                for line_no, option in options.get(number, [])
                if line_no > last_line
            ]
            if len(choices) != 1:
                stopped_at = number
                break
            line_no, option = choices[0]
            tags = {e.tag for e in option.evidence if e.polarity == "positive"}
            paragraph_ok = bool(tags & {
                "blank_before", "paragraph_break", "prev_sentence_end",
            })
            stem_ok = bool(tags & {
                "chinese_after", "long_stem", "stem_keyword", "math_after",
            })
            if option.recovery == "dropped_tens" or not paragraph_ok or not stem_ok:
                stopped_at = number
                break
            safe_prefix[line_no] = (number, option.form, option.recovery)
            accepted[line_no] = (number, option.form, option.recovery)
            last_line = line_no
        if stopped_at is not None:
            gaps.append((stopped_at - 1, stopped_at, left.line_no + 1))
            weak = [
                candidate.line_no
                for candidate in collection.candidates
                if any(option.number == stopped_at for option in candidate.options)
            ]
            start = min(weak) if weak else None
            end = right.line_no - 1
            boundary_known = start is not None and end >= start
            if not boundary_known:
                start = None
                end = max(end, 0)
            if source_lines is not None and start is not None:
                text = "\n".join(source_lines[start:end + 1])
            else:
                text = "\n".join(
                    candidate.text for candidate in collection.candidates
                    if start is not None and start <= candidate.line_no <= end
                )
            gap_segments.append(StemGapSegment(
                left_question_no=stopped_at - 1,
                right_question_no=right_no,
                missing_numbers=tuple(range(stopped_at, right_no)),
                line_start=start,
                line_end=end,
                excerpt=text[:600],
                boundary_known=boundary_known,
            ))
            issues.append(StemIssue(
                code="stem_chain_gap",
                severity="error",
                message=f"题号链在 {stopped_at - 1}→{stopped_at} 断开",
                line_no=left.line_no + 1,
                excerpt=text[:600],
                question_no=stopped_at,
                interval_id=f"C{left_no}-{right_no}",
            ))
            if start is None:
                issues.append(StemIssue(
                    code="stem_chain_boundary_uncertain",
                    severity="warning",
                    message="gap 起始行不确定，尾部内容需人工复核",
                    line_no=left.line_no + 1,
                    excerpt=text[:600],
                    question_no=stopped_at,
                    interval_id=f"C{left_no}-{right_no}",
                ))

    result = StemChainResult(
        accepted=accepted,
        gaps=gaps,
        gap_segments=gap_segments,
        ambiguities=ambiguities,
        safe_prefix=safe_prefix,
        issues=issues,
    )
    return StemChainResult(
        accepted=result.accepted,
        gaps=result.gaps,
        gap_segments=result.gap_segments,
        ambiguities=result.ambiguities,
        safe_prefix=result.safe_prefix,
        issues=result.issues + validate_forced_assignments(result),
    )


def validate_forced_assignments(result: StemChainResult) -> list[StemIssue]:
    seen: dict[int, int] = {}
    issues: list[StemIssue] = []
    for line_no, (number, _form, _recovery) in sorted(result.accepted.items()):
        if number in seen:
            issues.append(StemIssue(
                code="stem_chain_forced_duplicate",
                severity="error",
                message=f"题 {number} 同时命中行 {seen[number] + 1} 和 {line_no + 1}",
                line_no=line_no + 1,
                excerpt="",
                question_no=number,
            ))
        else:
            seen[number] = line_no
    return issues
