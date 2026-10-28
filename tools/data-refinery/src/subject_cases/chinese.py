"""语文答案提取 case（2026-10-28 用户裁决的独立流程）。

五步：
1. **答案与试卷分离**：定位「参考答案/答案及评分/评分参考」标题，只处理其后内容。
2. **标点归一化（仅解析用）**：全角 → 半角 1:1 字符映射，供题号识别与结构判断；
   写出的答案文本一律用归一化前的原文（避免中文答案满屏半角逗号）。
3. **按题号对齐**：递增题号开新答案段；回退编号（如作文评分细则「1．字数不足…」）
   视为当前答案续行，绝不新建答案段（会串到第 1 题——2025 海淀语文卷实测事故）。
4. **评分说明拆分**：括号内含「分」且带 给分/扣分/每空/每处/酌情/赋分/评分/共N 的
   评分说明移到「解析」列；拿不准的括号原样保留（不误删）。
5. **校验**：空答案记 issue 并留空，绝不猜。
"""

import re
from pathlib import Path

from question_splitter import is_answer_keyword, is_group_header, is_main_stem

from . import ExtractedAnswer

# 全角 → 半角（1:1 字符，长度不变；仅用于解析，不写回文本）
# 注意不要映射「、」：它是中文大题序号的分隔符（'三、名著阅读'），归一后会破坏
# is_group_header 识别，导致大题标题混进上一题答案（实测事故）。
_FULLWIDTH_TO_HALF = str.maketrans({
    "．": ".", "：": ":", "（": "(", "）": ")",
    "，": ",", "；": ";", "？": "?", "！": "!", "　": " ",
})

# 归一化后的题号前缀（消费 'N.' / 'N:'）
_PREFIX_RE = re.compile(r"^\s*\d{1,2}[.:]")
# 光秃题号行（'1.'/'1．'，行尾即结束）：题号存在但答案缺失
_BARE_STEM_RE = re.compile(r"^\s*(\d{1,2})[.:]\s*$")
# 小节标题：（一）（共 6 分）/ ## （二）（共 10 分）
_SECTION_HEADER_RE = re.compile(r"^#{0,6}\s*[\(]\s*[一二三四五六七八九十]+\s*[\)]")
# markdown 标题前缀（'## 27．评分参考' 的 '## '），偏移量用于回切原文
_HEADING_RE = re.compile(r"^#{1,6}\s*")
# 顶级括号段（不含嵌套括号），用于识别评分说明
_PAREN_RE = re.compile(r"[（(]([^（）()]{2,})[）)]")
# 评分说明特征词
_SCORING_HINT_RE = re.compile(r"给分|扣分|不得分|得分|每空|该空|每处|酌情|赋分|评分|共\s*\d+")
# 纯分值括号（'（2 分）'/'（共 2分）'）：仅剥离答案末尾的，答案只留正文
_TRAILING_SCORE_NOTE_RE = re.compile(r"[（(]\s*(?:共)?\s*\d+(?:\.\d+)?\s*分\s*[）)]\s*$")


def _split_answer_section(text: str) -> list[str] | None:
    """返回参考答案段之后的原始行；找不到答案标题返回 None。

    标题行本身丢弃；试卷主体（含考生须知里的「试题答案」）不参与。
    """
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if is_answer_keyword(line):
            return lines[i + 1:]
    return None


def _is_scoring_note(inner: str) -> bool:
    """括号内容是否为评分说明（含「分」+ 评分特征词）。"""
    return "分" in inner and bool(_SCORING_HINT_RE.search(inner))


def _extract_scoring_notes(answer_text: str) -> tuple[str, str]:
    """把答案里的评分说明括号拆出来。

    - 答案**末尾**的纯分值括号（'（2 分）'）只剥离，不动正文中间的同形括号（评分表内）
    - 含评分特征词的括号（'（共 2分。……给分）'）全文剥离
    - 剥离后答案为空时回退原文（宁啰嗦不空）

    Returns:
        (干净答案, 评分说明)。说明之间用换行连接。
    """
    notes: list[str] = []
    text = answer_text.strip()

    # 1) 末尾纯分值（可连续多个）：'C（2 分）' -> 'C'
    tail_notes: list[str] = []
    while True:
        m = _TRAILING_SCORE_NOTE_RE.search(text)
        if not m:
            break
        tail_notes.append(m.group(0).strip())
        text = text[:m.start()].rstrip()
    notes.extend(tail_notes)

    # 2) 带评分特征词的括号（任意位置）
    def _take(m: re.Match) -> str:
        if _is_scoring_note(m.group(1)):
            notes.append(m.group(0))
            return ""
        return m.group(0)

    cleaned = _PAREN_RE.sub(_take, text)
    cleaned = re.sub(r"\n{2,}", "\n", cleaned)
    cleaned = "\n".join(ln.strip() for ln in cleaned.split("\n") if ln.strip())
    if not cleaned.strip():
        # 全是评分说明（如作文评分框架）：保留原文，宁可啰嗦不可空
        return answer_text.strip(), "\n".join(notes)
    return cleaned.strip(), "\n".join(notes)


def _align_by_number(lines: list[str]) -> list[tuple[int, list[str]]]:
    """按题号把答案行分组（不做文本清洗）。

    题号必须递增；回退编号 / 小节标题 / 大题标题不进答案正文。
    """
    blocks: list[tuple[int, list[str]]] = []
    current_no: int | None = None
    current_lines: list[str] = []
    last_no = 0

    def flush() -> None:
        nonlocal current_no, current_lines, last_no
        if current_no is not None:
            blocks.append((current_no, current_lines))
            last_no = max(last_no, current_no)
        current_no, current_lines = None, []

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        norm = line.translate(_FULLWIDTH_TO_HALF)
        if _SECTION_HEADER_RE.match(norm) or is_group_header(norm)[0]:
            continue

        # 剥掉 markdown 标题前缀再判题号（'## 27．评分参考'）；norm 与原文等长，偏移可直接回切
        head = _HEADING_RE.match(norm)
        offset = head.end() if head else 0
        ok, n = is_main_stem(norm[offset:])
        bare_stem = False
        if not ok:
            # 光秃题号行（'1.'）：题号在、答案缺失——建空块，由校验记 issue
            bare = _BARE_STEM_RE.match(norm[offset:])
            if bare:
                ok, n, bare_stem = True, int(bare.group(1)), True
        if ok and n > last_no:
            flush()
            if bare_stem:
                rest = ""
            else:
                m = _PREFIX_RE.match(norm[offset:])
                rest = line[offset + m.end():].strip() if m else line[offset:].strip()
            current_no = n
            current_lines = [rest] if rest else []
        elif current_no is not None:
            # 续行（含回退编号的评分细则、多行示例）
            current_lines.append(line.strip())

    flush()
    return blocks


def extract_answers(text: str, md_path: Path) -> list[ExtractedAnswer]:
    """语文卷答案提取入口（纯程序，不调用 LLM）。"""
    section = _split_answer_section(text)
    if section is None:
        return [ExtractedAnswer(no=0, issues=[f"{md_path.name} 未找到参考答案段"])]

    results: list[ExtractedAnswer] = []
    for no, lines in _align_by_number(section):
        raw_answer = "\n".join(lines).strip()
        if not raw_answer:
            results.append(ExtractedAnswer(no=no, issues=[f"第 {no} 题答案段为空"]))
            continue
        answer, explanation = _extract_scoring_notes(raw_answer)
        issues: list[str] = []
        if not answer:
            issues.append(f"第 {no} 题剥离评分说明后答案为空，已保留原文")
        results.append(ExtractedAnswer(
            no=no,
            answer=answer,
            explanation=explanation,
            issues=issues,
        ))
    return results
