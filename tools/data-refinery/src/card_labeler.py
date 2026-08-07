"""卡片标注器：调用 LLM 对已拆分的卡片进行分类标注。

LLM 只负责标注（page_type / card_type / lesson_id / title / textbook_page /
intro / questions），不修改卡片正文（practice 卡 questions[].text 为逐字摘录，例外），
不拆分或合并卡片。
"""

import json
from dataclasses import dataclass
from pathlib import Path

from llm import LLMClient, LLMResponse

# _parse_json_object 复用 extract.py 的 JSON 解析逻辑
from extract import _parse_json_object


@dataclass
class QuestionMarker:
    """practice 卡的单题标记"""
    n: int
    text: str


@dataclass
class LabelResult:
    """LLM 标注产出"""
    page_type: str           # "front_matter" | "chapter_intro" | "content" | "practice"
    card_type: str           # "concept" | "example" | "practice" | "explore" | "summary" | "reading"
    lesson_id: str | None    # 章节标题原文，或 null（继承）
    title: str | None        # 卡片标题
    textbook_page: str       # 如 "P8"
    intro: str | None = None              # 仅 practice 卡：题前说明/要求文字
    questions: list[QuestionMarker] | None = None  # 仅 practice 卡：可作答的题列表


@dataclass
class PageLabelResult:
    """一页的标注结果"""
    page_type: str
    labels: list[LabelResult]  # 与 splitter 输出的卡片一一对应


class CardLabeler:
    """使用 LLM 对 splitter 输出的卡片进行标注。"""

    def __init__(self, llm: LLMClient, prompt_template: str):
        self._llm = llm
        self._prompt = prompt_template

    def label(self, cards_text: list[str], page_number: str,
              prev_lesson_id: str | None = None) -> PageLabelResult:
        """调用 LLM 对一页的卡片进行标注。

        Args:
            cards_text: 拆分后的卡片文本列表（splitter 输出）
            page_number: 页码字符串，如 "P8"
            prev_lesson_id: 上一页的 lesson_id（跨页继承）

        Returns:
            PageLabelResult，包含页类型和每张卡的标注
        """
        # 构建用户消息：每张卡的文本（截断防超长）
        card_snippets = []
        for i, content in enumerate(cards_text):
            snippet = content[:800] + ("..." if len(content) > 800 else "")
            card_snippets.append(f"## Card #{i + 1}\n{snippet}")

        user_message = (
            f"Page: {page_number}\n"
            f"Previous lesson_id: {prev_lesson_id or '(none)'}\n\n"
            + "\n\n".join(card_snippets)
        )

        response: LLMResponse = self._llm.complete(self._prompt, user_message)
        data = _parse_json_object(response.content)

        page_type = str(data.get("page_type", "content"))
        raw_items = data.get("items", [])

        labels: list[LabelResult] = []
        for idx, item in enumerate(raw_items):
            card_type = str(item.get("card_type", "concept"))
            raw_qs = item.get("questions")
            questions = None
            # 仅 practice 卡解析 questions/intro；非 practice 卡即使 LLM 误返也忽略
            if card_type == "practice" and raw_qs is not None:
                questions = []
                for q in raw_qs:
                    if not isinstance(q, dict):
                        continue
                    try:
                        n = int(q.get("n", 0))
                        if n < 1:
                            continue
                        text = q.get("text")
                        if not isinstance(text, str) or not text:
                            continue
                        questions.append(QuestionMarker(n=n, text=text))
                    except (TypeError, ValueError, AttributeError):
                        continue
            labels.append(LabelResult(
                page_type=page_type,
                card_type=card_type,
                lesson_id=item.get("lesson_id"),
                title=item.get("title"),
                textbook_page=item.get("textbook_page", page_number),
                intro=item.get("intro") if card_type == "practice" else None,
                questions=questions,
            ))

        # 确保 labels 数量与 cards 数量一致
        while len(labels) < len(cards_text):
            labels.append(LabelResult(
                page_type=page_type,
                card_type="concept",
                lesson_id=None,
                title=None,
                textbook_page=page_number,
            ))
        labels = labels[:len(cards_text)]

        return PageLabelResult(page_type=page_type, labels=labels)
