"""answer_doc：Markdown 按卷答案文档解析（纯函数层）。

文档格式（spec 2026-09-10 §4.2）：

    # 试卷：<试卷标题>          —— 用于定位 exam_papers（可重名，CLI 列候选）
    ## <印刷题号>               —— 对应 paper_questions.question_no
    答案：<内容，可多行>         —— 必填；公式用 $...$ LaTeX
    思路：<内容，可多行>         —— 可选；写入 questions.approach
    解析：<内容，可多行>         —— 可选；写入 questions.explanation
    题型：calculation           —— 可选；仅需改标时写

多行续接：字段行之后的行（含空行）接续到该字段；空行被保留，字段以
「下一字段行 / `## 题号` / `---` 分隔线 / 文件结束」结束。围栏代码块
（```）内的内容原样保留（含空行与缩进），用于内嵌 `<svg>` 图示。
"""

import re
from dataclasses import dataclass, field

from answer_records import AnswerRecord, VALID_TYPES

HEADING_PAPER_RE = re.compile(r"^#\s*试卷[:：]\s*(.+?)\s*$")
HEADING_ITEM_RE = re.compile(r"^##\s*(\d+)\s*$")
FIELD_RE = re.compile(r"^(答案|思路|解析|题型)[:：]\s*(.*)$")
_HR_RE = re.compile(r"^(---|\*\*\*|___)\s*$")
_FIELD_ATTR = {"答案": "answer", "思路": "approach", "解析": "explanation"}
_MULTILINE_FIELDS = ("答案", "思路", "解析")


class AnswerDocError(ValueError):
    """文档格式/内容不合法（缺答案、非法题型标注、缺标题等）。"""


@dataclass
class AnswerDocItem:
    no: int
    answer: str = ""
    approach: str = ""
    explanation: str = ""
    type_override: str | None = None


@dataclass
class AnswerDoc:
    title: str = ""
    items: list[AnswerDocItem] = field(default_factory=list)


def parse_answer_doc(text: str) -> AnswerDoc:
    doc = AnswerDoc()
    by_no: dict[int, AnswerDocItem] = {}
    current: AnswerDocItem | None = None
    field_name: str | None = None
    pending_blanks = 0
    in_fence = False

    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()

        # 围栏代码块内：原样保留（含空行与缩进），直到闭合围栏
        if in_fence:
            if current is not None and field_name in _MULTILINE_FIELDS:
                attr = _FIELD_ATTR[field_name]
                old = getattr(current, attr)
                setattr(current, attr, f"{old}\n{line}" if old else line)
            if stripped.startswith("```"):
                in_fence = False
            continue

        m = HEADING_PAPER_RE.match(line)
        if m:
            doc.title = m.group(1)
            current, field_name, pending_blanks = None, None, 0
            continue

        m = HEADING_ITEM_RE.match(line)
        if m:
            no = int(m.group(1))
            current = by_no.get(no)
            if current is None:
                current = AnswerDocItem(no=no)
                by_no[no] = current
                doc.items.append(current)
            field_name = None
            pending_blanks = 0
            continue

        if current is None:
            continue  # 标题前的杂项行忽略

        m = FIELD_RE.match(line)
        if m:
            field_name = m.group(1)
            value = m.group(2).strip()
            pending_blanks = 0
            if field_name == "题型":
                current.type_override = value or None
            elif value:
                setattr(current, _FIELD_ATTR[field_name], value)
            continue

        if _HR_RE.match(line):
            field_name = None  # 分隔线结束当前字段，自身不进入内容
            pending_blanks = 0
            continue

        if field_name in _MULTILINE_FIELDS:
            if not stripped:
                pending_blanks += 1  # 空行保留为字段内空行，不断开续接
                continue
            attr = _FIELD_ATTR[field_name]
            old = getattr(current, attr)
            sep = "\n" * (pending_blanks + 1) if old else ""
            setattr(current, attr, f"{old}{sep}{stripped}")
            pending_blanks = 0
            if stripped.startswith("```"):
                in_fence = True
            continue

    _validate(doc)
    return doc


def _validate(doc: AnswerDoc) -> None:
    if not doc.title:
        raise AnswerDocError("缺少试卷标题（首行应为「# 试卷：<标题>」）")
    if not doc.items:
        raise AnswerDocError("文档中没有任何题目（需要「## <题号>」标记）")
    for it in doc.items:
        if not it.answer.strip():
            raise AnswerDocError(f"第 {it.no} 题缺少「答案：」字段（每题必写答案）")
        if it.type_override is not None and it.type_override not in VALID_TYPES:
            raise AnswerDocError(
                f"第 {it.no} 题题型标注非法：{it.type_override}"
                f"（仅允许 {' | '.join(sorted(VALID_TYPES))}）"
            )


def doc_to_records(doc: AnswerDoc, paper_id: int) -> list[AnswerRecord]:
    """把文档条目转成统一的 AnswerRecord（paper_id + question_no 定位）。"""
    records: list[AnswerRecord] = []
    for it in doc.items:
        records.append(AnswerRecord(
            paper_id=paper_id,
            question_no=it.no,
            answer=it.answer.strip() or None,
            approach=it.approach.strip() or None,
            explanation=it.explanation.strip() or None,
            type=it.type_override,
        ))
    return records
