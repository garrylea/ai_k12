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
