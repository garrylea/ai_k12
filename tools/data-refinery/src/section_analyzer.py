"""按大题（section）判定题型：先划出「第 A–B 题属于哪个大题、什么题型」，再照着填。

为什么不能按单题特征猜：题干里出现 A/B/C/D 不等于选择题——物理实验题用 A/B/C/D 标
四个实验图（人大附第 22 题「A 说明____；BD 说明____」），按选项特征校正会整节被改成
选择题。题型在卷面上是**按大题分段**的：同一大题里所有题同一题型，直到下一个大标题。

用法：
    from section_analyzer import analyze_sections
    mapping, sections = analyze_sections(md_text, subject="physics")
    # mapping: {题号: "choice" | "multi_choice" | "fill_blank" | "short_answer" | "calculation"}
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# 大题标题：行首可选 markdown # 前缀 + 中文序号 + 、
_HEADER_RE = re.compile(r"(?m)^#{0,6}[ \t]*([一二三四五六七八九十]+)、[^\n]*")
# 卷内题号（主题号）：行首 1-2 位数字 + . 或 ．
_STEM_RE = re.compile(r"(?m)^[ \t]*(\d{1,2})[ \t]*[.．][ \t]*\S")
# 选项标记（A. / A、/ (A)）
_OPTION_RE = re.compile(r"(?m)^[ \t]*[（(]?[A-D][)）]?[ \t]*[.．、][ \t]*\S")
# 大题标题里的分值与每题分值：共 30 分 / 每小题 2 分 → 这一节应有 15 题。
# 用来在大题标题**丢失**时定位「题型从第几题开始变」——卷面写明的题数是硬证据，
# 比「看有没有 A–D 选项」可靠（后者会把实验题的 A/B/C/D 当选项）。
_TOTAL_SCORE_RE = re.compile(r"共\s*(\d+)\s*分")
_EACH_SCORE_RE = re.compile(r"每小题\s*(\d+(?:\.\d+)?)\s*分")

# 答案段起点：到了答案区就没有题干了
_ANSWER_RE = re.compile(r"(?m)^#{0,6}[ \t]*(参考答案|答案及评分|评分参考)")

# 标题关键词 → 题型。顺序重要：非选择 → 多项选择 → 选择（「非选择题」里含「选择」）。
_COMMON_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"非选择"), "short_answer"),
    (re.compile(r"多项选择|多选"), "multi_choice"),
    (re.compile(r"单项选择|单选|选择题"), "choice"),
    (re.compile(r"判断"), "true_false"),
    (re.compile(r"填空"), "fill_blank"),
    (re.compile(r"计算"), "calculation"),
]

# 学段差异：数学的「解答题」一节里混着 proof/calculation/short_answer，**不能整节压成
# 一个题型**（否则几何证明会被改成 short_answer）；物化的「实验解答题」一节是短的
# 实验问答题，整节 short_answer 正是要修的错。
_SUBJECT_RULES: dict[str, list[tuple[re.Pattern[str], str]]] = {
    "physics": [(re.compile(r"实验|探究|作图|简答|科普|阅读|综合"), "short_answer")],
    "chemistry": [(re.compile(r"实验|探究|简答|阅读|综合"), "short_answer")],
    "politics": [(re.compile(r"简答|材料|阅读|综合"), "short_answer")],
    "math": [],
}

# 这些学科的大题标题可靠地带题型（语文/英语的大题是「积累与运用」「阅读」这种，
# 标题不带题型，按标题判会误伤，保持原逻辑）。
SECTION_TYPED_SUBJECTS = frozenset({"math", "physics", "chemistry", "politics"})


@dataclass
class Section:
    gid: str
    title: str
    type: str | None
    start_no: int
    end_no: int
    inferred: bool = False      # 题型不是标题明写的（标题缺失，或标题没写题型）


def _rules_for(subject: str) -> list[tuple[re.Pattern[str], str]]:
    return _COMMON_RULES + _SUBJECT_RULES.get(subject, [])


def _classify(title: str, subject: str) -> str | None:
    for pat, typ in _rules_for(subject):
        if pat.search(title):
            return typ
    return None


def _option_ratio(text: str) -> float:
    """这一段里「带 A–D 选项的题」占比。只用于整段推断，不用于逐题定型。"""
    marks = list(_STEM_RE.finditer(text))
    if len(marks) < 2:
        return 0.0
    with_opts = 0
    for i, m in enumerate(marks):
        seg_end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        if len(_OPTION_RE.findall(text[m.end():seg_end])) >= 3:
            with_opts += 1
    return with_opts / len(marks)


def _expected_count(title: str) -> int | None:
    """标题写「共 X 分，每小题 Y 分」→ 本节应有几题。"""
    total = _TOTAL_SCORE_RE.search(title)
    each = _EACH_SCORE_RE.search(title)
    if not total or not each:
        return None
    try:
        t, e = float(total.group(1)), float(each.group(1))
    except ValueError:
        return None
    if e <= 0:
        return None
    n = int(round(t / e))
    return n if n > 0 else None


def _infer_type(text: str) -> str:
    """整段一起判（多数题带 A–D 选项 → 选择题），避免逐题抖动。"""
    return "choice" if _option_ratio(text) >= 0.6 else "short_answer"


def analyze_sections(md_text: str, subject: str = "") -> tuple[dict[int, str], list[Section]]:
    """返回 ({题号: 题型}, [大题区间])。

    - 有标题、标题能判题型 → 按题号区间铺开；
    - 题号从上一大题末号直接跳到本大题首号之前 → 认定中间缺了一个大题标题，
      把缺口单独作为一段，用这段的选项特征**整体**判一个题型；
    - 标题在但没写题型 → 用本节正文整体推断。
    """
    if subject and subject not in SECTION_TYPED_SUBJECTS:
        return {}, []

    headers = list(_HEADER_RE.finditer(md_text))
    if not headers:
        return {}, []
    answer = _ANSWER_RE.search(md_text)
    paper_end = answer.start() if answer else len(md_text)

    raw: list[dict] = []
    for i, m in enumerate(headers):
        start = m.end()
        end = headers[i + 1].start() if i + 1 < len(headers) else paper_end
        line_start = md_text.rfind("\n", 0, m.end()) + 1
        line_end = md_text.find("\n", m.end())
        title = md_text[line_start: line_end if line_end != -1 else len(md_text)].strip()
        marks = [(start + mm.start(), int(mm.group(1)))
                 for mm in _STEM_RE.finditer(md_text[start:end])]
        raw.append({"gid": m.group(1), "title": title, "type": _classify(title, subject),
                    "start": start, "end": end, "marks": marks})

    mapping: dict[int, str] = {}
    sections: list[Section] = []
    prev_end = 0
    prev_text_end = 0

    for sec in raw:
        nums = [(pos, n) for pos, n in sec["marks"] if n > prev_end]
        if not nums:
            continue
        first = min(n for _, n in nums)
        # 缺标题：题号从 prev_end+1 直接跳到 first 之前
        if first > prev_end + 1:
            lo, hi = prev_end + 1, first - 1
            gap_text = md_text[prev_text_end: sec["start"]]
            gap_type = _infer_type(gap_text) if gap_text.strip() else "short_answer"
            sections.append(Section("?", "（大题标题缺失）", gap_type, lo, hi, inferred=True))
            for n in range(lo, hi + 1):
                mapping[n] = gap_type
            prev_end = hi

        start_no = prev_end + 1
        end_no = max(n for _, n in nums)
        typ = sec["type"]
        # 标题写明了本节题数、实际却多出题号 → 后面那段属于一个丢了标题的大题
        expected = _expected_count(sec["title"]) if typ else None
        if expected and start_no + expected - 1 < end_no:
            cut = start_no + expected - 1
            for n in range(start_no, cut + 1):
                mapping[n] = typ
            tail_start = next((pos for pos, n in nums if n > cut), None)
            gap_text = md_text[tail_start: sec["end"]] if tail_start is not None else ""
            gap_type = _infer_type(gap_text) if gap_text.strip() else "short_answer"
            sections.append(Section(sec["gid"], sec["title"], typ, start_no, cut, False))
            sections.append(Section("?", "（大题标题缺失）", gap_type, cut + 1, end_no, True))
            for n in range(cut + 1, end_no + 1):
                mapping[n] = gap_type
            prev_end = max(prev_end, end_no)
            prev_text_end = sec["marks"][-1][0]
            continue
        if typ is None:
            # 标题在、但没写题型（数学「解答题」这类混排）：不整节覆盖，保留单题判定
            sections.append(Section(sec["gid"], sec["title"], None, start_no, end_no, True))
        else:
            sections.append(Section(sec["gid"], sec["title"], typ, start_no, end_no, False))
            for n in range(start_no, end_no + 1):
                mapping[n] = typ
        prev_end = max(prev_end, end_no)
        prev_text_end = sec["marks"][-1][0]

    return mapping, sections
