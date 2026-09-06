"""试卷题切分器：按题号切分 + 答案对齐（统一扫描算法）。

与教材卡的 card_splitter（按 400 字贪心合并）不同，试卷题按题号切分，
题干原文原封不动，保留所有图片引用。详见
docs/superpowers/specs/2026-09-05-exam-question-splitter-design.md。
"""

import re
from dataclasses import dataclass
from pathlib import Path

# 主题号（行首）：1-2 位数字 + . + 非数字字符（不要求空格，兼容 9.xxx / 9. xxx / 9.$...$）
_MAIN_STEM_RE = re.compile(r'^\s*(\d{1,2})\.\D')
# 主题号前缀剥离：只消费 ^\s*\d{1,2}\.，不消费 . 后的内容字符（避免无空格格式 '9.若' 丢首字）
_STEM_PREFIX_RE = re.compile(r'^\s*\d{1,2}\.')
# 紧凑格式（行内，答案区一行多题号）：(?<!\d) 防止把 19.5 的小数点误切
_INLINE_STEM_RE = re.compile(r'(?<!\d)(\d{1,2})\.\D')
# 小问号：行首 (N) 或（N）
_SUB_STEM_RE = re.compile(r'^\s*[\(（](\d{1,2})[\)）]')
# 大题分组标题：行首 中文序号 + 、
_GROUP_HEADER_RE = re.compile(r'^\s*([一二三四五六七八九十]+)、')
# 日期/页码陷阱：行首 4 位数字 + . + 数字（如 2026.5）
_DATE_TRAP_RE = re.compile(r'^\s*\d{4}\.\d')
# 答案关键字（行内搜索）
_ANSWER_KEYWORD_RE = re.compile(r'参考答案|答案|评分参考')


def is_date_trap(line: str) -> bool:
    """行首是否为日期/页码格式（如 2026.5），不当题号。"""
    return bool(_DATE_TRAP_RE.match(line))


def is_group_header(line: str) -> tuple[bool, str | None]:
    """行首是否为大题分组标题（如 '三、解答题'）。返回 (是否, 组号)。"""
    m = _GROUP_HEADER_RE.match(line)
    if m:
        return True, m.group(1)
    return False, None


def is_main_stem(line: str) -> tuple[bool, int | None]:
    """行首是否为主题号（如 '9.' '9. ' '9.$...$'）。返回 (是否, 题号 N)。

    排除 4 位年份（2026.5）和小数（9.5）—— . 后必须是非数字字符。
    """
    m = _MAIN_STEM_RE.match(line)
    if m:
        return True, int(m.group(1))
    return False, None


def is_sub_stem(line: str) -> bool:
    """行首是否为小问号（如 '(1)' '（2）'）。"""
    return bool(_SUB_STEM_RE.match(line))


def is_answer_keyword(line: str) -> bool:
    """行内是否含答案关键字（参考答案/答案/评分参考）。"""
    return bool(_ANSWER_KEYWORD_RE.search(line))


def split_inline_stems(line: str) -> list[tuple[int, str]]:
    """紧凑格式：一行多题号（答案区 '9. xxx 10. yyy 11. zzz'）。

    返回 [(题号 N, 答案文本), ...]。无匹配返回空列表。
    """
    matches = list(_INLINE_STEM_RE.finditer(line))
    if not matches:
        return []
    results: list[tuple[int, str]] = []
    for i, m in enumerate(matches):
        n = int(m.group(1))
        # 答案文本从 . 后的 \D 字符开始（包含该字符），到下一题号起点前
        start = m.end() - 1  # 回退到 \D 字符位置
        end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
        text = line[start:end].strip()
        results.append((n, text))
    return results


@dataclass
class RawQuestion:
    """切分后的原始题（answer/explanation 由答案对齐阶段填入）。"""
    group_order: int                # 题号 N（主题号）
    group_id: str | None            # 大题分组（"一"/"二"/"三"...），无分组为 None
    content: str                    # 题干原文（主题号"N."已剥离，小问号"(N)"保留）
    answer: str = ""                # 答案（答案对齐阶段填入）
    explanation: str | None = None  # 解析（答案对齐阶段填入）


def _strip_main_stem_prefix(line: str) -> str:
    """剥离行首主题号 'N.' 前缀，保留剩余内容（不消费 . 后的内容字符）。

    '9. 若代数式' -> '若代数式'
    '9.若代数式' -> '若代数式'
    '9. $\\frac{1}{x-3}$' -> '$\\frac{1}{x-3}$'
    """
    return _STEM_PREFIX_RE.sub('', line, count=1).strip()


def _strip_answer_prefix(text: str) -> str:
    """剥离答案文本开头的'解：'/'证明：'等前缀，只留内容。"""
    return re.sub(r'^\s*(解|证明|原式|原不等式组)[：:]\s*', '', text.strip())


def split_page(text: str, md_path: Path) -> list[RawQuestion]:
    """按题号切分试卷 MD 并对齐答案，返回 RawQuestion 列表。

    Args:
        text: 试卷 MD 全文（已 strip_chrome + normalize_fullwidth_parens）
        md_path: MD 文件路径（用于诊断日志，本函数不读）

    Returns:
        RawQuestion 列表，按题号顺序
    """
    questions: list[RawQuestion] = []
    current: RawQuestion | None = None
    current_group_id: str | None = None
    in_answer_section = False
    current_answer_lines: list[str] = []  # 当前累积的答案文本（多行）
    current_answer_n: int | None = None  # 当前答案属于哪个题号

    def _flush_answer():
        """把累积的答案塞入对应题。"""
        nonlocal current_answer_lines, current_answer_n
        if current_answer_n is None or not current_answer_lines:
            current_answer_lines = []
            current_answer_n = None
            return
        answer_text = _strip_answer_prefix("\n".join(current_answer_lines))
        for q in questions:
            if q.group_order == current_answer_n:
                if q.answer:
                    q.answer += "\n" + answer_text  # 多段答案合并
                else:
                    q.answer = answer_text
                break
        current_answer_lines = []
        current_answer_n = None

    for line in text.split('\n'):
        if not line.strip():
            continue

        if is_date_trap(line):
            continue

        ok, gid = is_group_header(line)
        if ok:
            if in_answer_section:
                _flush_answer()
            else:
                if current is not None:
                    questions.append(current)
                    current = None
            current_group_id = gid
            continue

        if not in_answer_section and is_answer_keyword(line):
            if current is not None:
                questions.append(current)
                current = None
            in_answer_section = True
            continue

        # 主题号处理（含紧凑格式一行多题号）
        inline_stems = split_inline_stems(line) if in_answer_section else []
        ok, n = is_main_stem(line)

        if in_answer_section:
            if inline_stems:
                # 紧凑格式：一行多题号答案
                _flush_answer()  # 先把上一段答案塞入
                if len(inline_stems) == 1:
                    current_answer_n = inline_stems[0][0]
                    current_answer_lines = [inline_stems[0][1]]
                else:
                    # 多个题号一行：每个题号独立成段，立即 flush
                    for stem_n, stem_text in inline_stems:
                        current_answer_n = stem_n
                        current_answer_lines = [stem_text]
                        _flush_answer()
                    current_answer_n = None
            elif ok:
                # 展开格式：行首单题号，开始新答案段
                _flush_answer()
                rest = _strip_main_stem_prefix(line)
                current_answer_n = n
                current_answer_lines = [rest] if rest else []
            else:
                # 答案段的续行（含小问号行 (1)(2)）
                if current_answer_n is not None:
                    current_answer_lines.append(line)
            continue

        # 题干区
        if ok:
            if current is not None:
                questions.append(current)
            current = RawQuestion(
                group_order=n,
                group_id=current_group_id,
                content=_strip_main_stem_prefix(line),
            )
            continue

        if is_sub_stem(line):
            if current is not None:
                current.content += "\n" + line
            continue

        if current is not None:
            current.content += "\n" + line

    # 末尾 flush 残留答案 + 残留题
    if in_answer_section:
        _flush_answer()
    if current is not None:
        questions.append(current)

    return questions
