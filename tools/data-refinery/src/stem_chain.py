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
