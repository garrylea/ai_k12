"""语文策略：选项体系（甲乙丙丁 / ①②③ / 3–6 项）与材料归属。

这些规则原先以 `if subject == "chinese"` 分支和两个材料谓词的形式写在
question_splitter.py 里；搬到这里之后内核不再出现任何学科判断，改语文规则
只改本文件。
"""

import re
from pathlib import Path

from question_splitter import (
    is_group_header,
    is_main_stem,
    is_part_header,
    split_options as split_options_abcd,
)
from subject_cases.chinese import extract_answers as chinese_answers
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
        # Task 6 之前先委托 subject_cases，避免一次性动两处
        return chinese_answers(text, md_path)


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
