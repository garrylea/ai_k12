"""题解内嵌分段解析：把 答案/解析/详解 标题拆回独立字段。"""

import re
from dataclasses import dataclass


_LABELS = (
    "答案", "正确答案", "参考答案",
    "解析", "分析", "思路", "解题思路",
    "详解", "解答", "点睛",
)
_TARGET = {
    "答案": "answer", "正确答案": "answer", "参考答案": "answer",
    "解析": "approach", "分析": "approach",
    "思路": "approach", "解题思路": "approach",
    "详解": "explanation", "解答": "explanation", "点睛": "explanation",
}
_LABEL_ALT = "|".join(sorted(_LABELS, key=len, reverse=True))
_HEADING_RE = re.compile(
    r"^[ \t]*(?:#{1,6}[ \t]*)?(?:[-*+][ \t]+)?"
    r"(?:\*\*|__)?[ \t]*"
    rf"(?:(?:[【\[])[ \t]*(?P<bracket>{_LABEL_ALT})[ \t]*(?:[】\]])"
    rf"|(?P<plain>{_LABEL_ALT})[ \t]*(?:\*\*|__)?[ \t]*[:：])"
    r"[ \t]*(?:\*\*|__)?[ \t]*(?P<rest>.*)$",
    re.MULTILINE,
)
_NUMBERED_ANSWER_RE = re.compile(
    r"(?m)^[ \t]*\d{1,2}[ \t]*[.．][ \t]*答案[ \t]*[:：]"
)


@dataclass(frozen=True)
class AnswerSections:
    answer: str
    approach: str
    explanation: str
    recognized: bool
    issues: tuple[str, ...] = ()


def _join(parts: list[str]) -> str:
    return "\n\n".join(part.strip() for part in parts if part.strip())


def _fence_positions(text: str) -> list[int]:
    return [match.start() for match in re.finditer(r"(?m)^[ \t]*```", text)]


def _heading_matches(text: str):
    fences = _fence_positions(text)
    for match in _HEADING_RE.finditer(text):
        inside = sum(1 for pos in fences if pos < match.start()) % 2 == 1
        if not inside:
            yield match


def split_answer_sections(text: str) -> AnswerSections:
    raw = text or ""
    if len(_fence_positions(raw)) % 2:
        return AnswerSections(raw.strip(), "", "", True, ("unclosed_code_fence",))

    matches = list(_heading_matches(raw))
    if not matches:
        return AnswerSections(raw.strip(), "", "", False)

    issues: list[str] = []
    if _NUMBERED_ANSWER_RE.search(raw):
        issues.append("numbered_answer_heading")

    answer_parts: list[str] = []
    approach_parts: list[str] = []
    explanation_parts: list[str] = []
    preamble = raw[:matches[0].start()].strip()
    if preamble:
        answer_parts.append(preamble)

    answer_headings = 0
    for index, match in enumerate(matches):
        label = match.group("bracket") or match.group("plain")
        target = _TARGET[label]
        end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
        body = (match.group("rest") + raw[match.end():end]).strip()
        if target == "answer":
            answer_headings += 1
            if body:
                answer_parts.append(body)
        elif target == "approach" and body:
            approach_parts.append(body)
        elif target == "explanation" and body:
            explanation_parts.append(body)

    if answer_headings > 1:
        issues.append("multiple_answer_sections")

    answer = _join(answer_parts)
    if not answer:
        issues.append("answer_body_missing")
        answer = raw.strip()

    return AnswerSections(
        answer=answer,
        approach=_join(approach_parts),
        explanation=_join(explanation_parts),
        recognized=True,
        issues=tuple(issues),
    )


def merge_old_then_new(old: str | None, new: str | None) -> str | None:
    left = (old or "").strip()
    right = (new or "").strip()
    if not right or right in left:
        return left or None
    if not left:
        return right
    return f"{left}\n\n{right}"
