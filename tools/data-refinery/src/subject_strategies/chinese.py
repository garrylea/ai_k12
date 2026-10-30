"""语文策略：选项体系（甲乙丙丁 / ①②③ / 3–6 项）、材料归属与答案提取。

选项与材料规则原先以 `if subject == "chinese"` 分支和两个材料谓词的形式写在
question_splitter.py 里；搬到这里之后内核不再出现任何学科判断，改语文规则
只改本文件。答案提取 2026-10-30 也并入本文件，一个学科的四件事
（切题 / 选项 / 材料 / 答案）都在一处。

语文答案提取是独立流程（不调 LLM，五步）：
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

from question_splitter import (
    is_answer_keyword,
    is_group_header,
    is_main_stem,
    is_part_header,
    split_options as split_options_abcd,
)
from subject_strategies.types import ExtractedAnswer, MaterialPolicy

# 语文选择题的题干提示：中文标签（甲乙丙/①②③）既可能是选项也可能是填空占位，
# 只有题干出现这些词才按选项拆（「我的分析：【甲】文…」是三处填空，不是 A/B/C）。
_CHOICE_STEM_RE = re.compile(r'一项|下列|选择|选出|正确|错误|不恰当|最恰当|哪一')

# 语文选项常用标签：甲乙丙丁、①②③④，以及可扩展的 A-F。
# 语文卷选择题不一定是 4 项（文言文/现代文常见 3 项：「甲乙丙三句，全都正确的一项」）。
# 必须限定行首：题干里「对【甲】【乙】两处…」是引用，不是选项定义。
_CN_OPTION_RES = (
    re.compile(r'(?m)^[ \t]*【\s*([甲乙丙丁])\s*】'),
    re.compile(r'(?m)^[ \t]*[（(]\s*([甲乙丙丁])\s*[）)]'),
    re.compile(r'(?m)^[ \t]*([甲乙丙丁])\s*[.．、](?=\s*\S)'),
)
_CIRCLED_OPTION_RE = re.compile(r'(?m)^[ \t]*([①②③④])')
_LATIN_FLEX_RE = re.compile(r'(?<![A-Za-z0-9])([A-F])\s*[.．、](?=\s*\S)')


def _consecutive_run(matches, labels: str) -> list[tuple[int, int, str]]:
    """从一组匹配里取最长的连续标签序列（A→B→C / 甲→乙→丙 / ①②③）。"""
    run: list[tuple[int, int, str]] = []
    best: list[tuple[int, int, str]] = []
    order = {ch: i for i, ch in enumerate(labels)}
    for m in matches:
        label = m.group(1)
        if label not in order:
            continue
        if run and order[label] == order[run[-1][2]] + 1:
            run.append((m.start(), m.end(), label))
        else:
            if len(run) > len(best):
                best = run
            run = [(m.start(), m.end(), label)]
    if len(run) > len(best):
        best = run
    return best


def _find_option_marks_cn(content: str) -> list[tuple[int, int, str]] | None:
    """语文选项：找最长的连续标签序列（2 项起），支持 A-F / 甲乙丙丁 / ①②③④。

    序列必须从该体系的首个标签开始（A / 甲 / ①）。OCR 偶尔丢掉一个选项的点号
    （`A. ① B ② C. ③ D. ④` 的 B 没有点），此时最长连续段是 `C,D`，若照用会把
    C/D 重编号成 A/B、把 A/B 的内容并进题干——学生看到的选项是错的。这种情况
    直接放弃拆分，保留原文交给标注判缺陷（标待复核），不产出错位选项。
    """
    latin_matches = list(_LATIN_FLEX_RE.finditer(content))
    if len(latin_matches) >= 2:
        latin = _consecutive_run(latin_matches, "ABCDEF")
        if not latin or latin[0][2] != "A":
            return None

    candidates: list[list[tuple[int, int, str]]] = []
    if len(latin_matches) >= 2:
        candidates.append(_consecutive_run(latin_matches, "ABCDEF"))
    for pattern in _CN_OPTION_RES:
        run = _consecutive_run(list(pattern.finditer(content)), "甲乙丙丁")
        if len(run) >= 2 and run[0][2] == "甲":
            candidates.append(run)
    circled = _consecutive_run(list(_CIRCLED_OPTION_RE.finditer(content)), "①②③④")
    if len(circled) >= 2 and circled[0][2] == "①":
        candidates.append(circled)
    if not candidates:
        return None
    # 选项最多的一组；同样长时取出现更早的（避免把题干里的「甲乙」当选项）
    best = max(candidates, key=lambda run: (len(run), -run[0][0]))
    return best if len(best) >= 2 else None


def _split_by_marks(content: str, marks: list[tuple[int, int, str]]) -> tuple[str, list[dict]] | None:
    """按标签序列切选项（语文专用，支持 2-6 项；label 归一为 A/B/C…，原标签保留）。"""
    stem = content[:marks[0][0]].strip()
    opts: list[dict] = []
    for i, (_, end, original) in enumerate(marks):
        stop = marks[i + 1][0] if i + 1 < len(marks) else len(content)
        text = content[end:stop].strip()
        if not text:
            return None
        opts.append({
            "label": "ABCDEF"[i],
            "text": text,
            "original_label": original,
        })
    if not opts:
        return None
    return stem, opts


class ChineseStrategy:
    code = "chinese"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        """语文：甲乙丙丁 / ①②③④ / A–F，允许 2–6 项，label 归一为 A/B/C…。"""
        marks = _find_option_marks_cn(content)
        # 「【甲】【乙】【丙】」「①②③」既可能是选项，也可能是填空占位：
        # 「我的分析：【甲】文张岱…【乙】文高濂…【丙】诗…」是三处填空，
        # 拆成选项会把三段正文当成 A/B/C、题干只剩「任务三」。只有题干出现
        # 选择提示（一项/下列/选择/最恰当…）时才按选项处理。
        if marks and marks[0][2] in "甲乙丙丁①②③④":
            if not _CHOICE_STEM_RE.search(content[: marks[0][0]]):
                marks = None
        if marks:
            result = _split_by_marks(content, marks)
            if result is not None:
                return result
        return split_options_abcd(content)

    def material_policy(self) -> MaterialPolicy:
        return ChineseMaterialPolicy(attach=True)

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        return extract_chinese_answers(text, md_path)


# 模块级单例：材料谓词判「上一题选项是否已完整」时要拆选项，不必每次新建策略。
_STRATEGY = ChineseStrategy()


class ChineseMaterialPolicy(MaterialPolicy):
    """语文的题号前 / 两题之间短文归属规则。"""

    def is_material_title(self, lines: list[str], index: int, line: str) -> bool:
        """语文文段标题：短、纯中文、后面紧跟长段落（如「绿绸叠翠」「流光溢彩」）。

        这类标题出现在两题之间时，表示下一题换了一段材料；旧逻辑会把整段材料
        并进上一题正文（大兴 2024 题4 吞掉题5 的【甲】【乙】文段）。
        """
        text = line.strip()
        if not (2 <= len(text) <= 12):
            return False
        if re.search(r'[。！？；：:，,、0-9A-Za-z]', text):
            return False
        if text.startswith(("#", "材料", "（", "(")):
            return False
        for j in range(index + 1, min(index + 4, len(lines))):
            nxt = lines[j].strip()
            if not nxt:
                continue
            return (
                len(nxt) >= 30
                and not is_main_stem(nxt)[0]
                and not is_group_header(nxt)[0]
                and not is_part_header(nxt)[0]
            )
        return False

    def looks_like_between_material(self, current_content: str, line: str) -> bool:
        """上一题选项已完整时，空行后的长段落是否像下一题的共享材料。

        要求：段落够长、不是标题/图片/选项续行，且上一题确实能确定性拆出
        3 个以上选项（说明它的正文已经结束）。
        """
        text = line.strip()
        if len(text) < 40:
            return False
        if text.startswith(("#", "![", "<table", "材料")):
            return False
        _, opts = _STRATEGY.split_options(current_content)
        return bool(opts) and len(opts) >= 3 and all(o["text"].strip() for o in opts)


# ---------------------------------------------------------------------------
# 答案提取（2026-10-30 并入，独立于切题内核）
# ---------------------------------------------------------------------------

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
    """把答案里的评分说明/评分表拆出来。

    - 答案**末尾**的纯分值括号（'（2 分）'）直接丢弃（选择/填空题答案是 `C` 即可，
      分值没有解析价值；不写进「解析」列避免噪声）
    - 含评分特征词的括号（'（共 2分。……给分）'）移入「解析」列
    - 答案主体是评分表（作文评分标准 HTML table）：表整体移入「解析」列，
      答案只留标题（'评分参考'）
    - 剥离后答案为空时回退原文（宁啰嗦不空）

    Returns:
        (干净答案, 解析文本)。说明之间用换行连接。
    """
    notes: list[str] = []
    text = answer_text.strip()

    # 1) 末尾纯分值（可连续多个）：'C（2 分）' -> 'C'
    while True:
        m = _TRAILING_SCORE_NOTE_RE.search(text)
        if not m:
            break
        text = text[:m.start()].rstrip()

    # 2) 带评分特征词的括号（任意位置）
    def _take(m: re.Match) -> str:
        if _is_scoring_note(m.group(1)):
            notes.append(m.group(0))
            return ""
        return m.group(0)

    cleaned = _PAREN_RE.sub(_take, text)
    cleaned = re.sub(r"\n{2,}", "\n", cleaned)
    cleaned = "\n".join(ln.strip() for ln in cleaned.split("\n") if ln.strip())

    # 3) 评分表答案（作文）：表格及其后说明整体进解析，答案只留标题
    if "<table" in cleaned:
        idx = cleaned.find("<table")
        head = cleaned[:idx].strip() or "评分参考"
        notes.insert(0, cleaned[idx:].strip())
        cleaned = head
        return cleaned, "\n".join(notes)

    if not cleaned.strip():
        # 全是评分说明：保留原文，宁可啰嗦不可空
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


def extract_chinese_answers(text: str, md_path: Path) -> list[ExtractedAnswer]:
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
