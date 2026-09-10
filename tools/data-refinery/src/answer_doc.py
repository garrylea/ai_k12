"""answer_doc：Markdown 按卷答案文档解析（纯函数层）。

文档格式（spec 2026-09-10 §4.2）：

    # 试卷：<试卷标题>          —— 用于定位 exam_papers（可重名，CLI 列候选）
    ## <印刷题号>               —— 对应 paper_questions.question_no
    答案：<内容，可多行>         —— 必填；公式用 $...$ LaTeX
    思路：<内容，可多行>         —— 可选；写入 questions.approach
    解析：<内容，可多行>         —— 可选；写入 questions.explanation
    题型：calculation           —— 可选；仅需改标时写

多行续接：字段行之后的非空行接续到该字段（换行拼接），空行断开。
"""

import re
from dataclasses import dataclass, field

from answer_records import AnswerRecord, VALID_TYPES

HEADING_PAPER_RE = re.compile(r"^#\s*试卷[:：]\s*(.+?)\s*$")
HEADING_ITEM_RE = re.compile(r"^##\s*(\d+)\s*$")
FIELD_RE = re.compile(r"^(答案|思路|解析|题型)[:：]\s*(.*)$")
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

    for raw in text.splitlines():
        line = raw.rstrip()

        m = HEADING_PAPER_RE.match(line)
        if m:
            doc.title = m.group(1)
            current, field_name = None, None
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
            continue

        if current is None:
            continue  # 标题前的杂项行忽略

        m = FIELD_RE.match(line)
        if m:
            field_name = m.group(1)
            value = m.group(2).strip()
            if field_name == "题型":
                current.type_override = value or None
            elif value:
                setattr(current, _FIELD_ATTR[field_name], value)
            continue

        if line.strip():
            if field_name in _MULTILINE_FIELDS:
                attr = _FIELD_ATTR[field_name]
                old = getattr(current, attr)
                setattr(current, attr, f"{old}\n{line.strip()}" if old else line.strip())
        else:
            field_name = None  # 空行断开续接

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
