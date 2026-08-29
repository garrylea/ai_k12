"""卡片标注器：调用 LLM 对已拆分的卡片进行分类标注。

LLM 只负责标注（page_type / card_type / lesson_id / title / textbook_page /
groups），不修改卡片正文（practice 卡 groups[].questions[].text 为逐字摘录，例外），
不拆分或合并卡片。
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import get_args

from llm import LLMClient, LLMResponse
from models import TextbookCard

# _parse_json_object 复用 extract.py 的 JSON 解析逻辑
from extract import _parse_json_object

# 合法 card_type 枚举，取自 TextbookCard 的 Literal 定义（单一来源，自动同步）
VALID_CARD_TYPES = get_args(TextbookCard.model_fields["card_type"].annotation)

# 编号大题模式：行首 N. 或 N、 后跟非空白字符
_STEM_RE = re.compile(r'^(\d+)[.、]\s*\S', re.MULTILINE)


def _find_in_content(text: str, content: str) -> int:
    """在 content 中查找 text 位置，失败时退化为前 20 字符匹配。"""
    pos = content.find(text)
    if pos < 0 and len(text) > 20:
        pos = content.find(text[:20])
    return pos


def _split_groups_if_needed(groups: list[dict] | None, card_content: str) -> list[dict] | None:
    """程序化兜底：LLM 把多组题塞进一个 group 时，按原文位置拆分。

    两种触发场景：
    1. intro 含多个编号大题（如 "1. 解方程：\\n2. 列方程："）-> 按大题位置拆
    2. 部分 question 在原文中出现在 intro 之前 -> 拆为无 intro 前组 + 有 intro 后组

    Args:
        groups: LLM 解析出的 groups（None 或多组时原样返回）
        card_content: 卡片原文（用于定位 question/intro 位置）

    Returns:
        拆分后的 groups，或原 groups（无法拆分时）
    """
    if not groups or len(groups) != 1 or not card_content:
        return groups

    group = groups[0]
    intro = group.get("intro") or ""
    questions = group.get("questions") or []

    if not questions:
        return groups

    # 定位每道题在原文中的位置
    q_positions: list[tuple[int, dict]] = []
    for q in questions:
        pos = _find_in_content(q["text"], card_content)
        if pos >= 0:
            q_positions.append((pos, q))

    if not q_positions:
        return groups  # 无法定位题目，放弃拆分

    q_positions.sort(key=lambda x: x[0])

    # Case 1: intro 含多个编号大题 -> 按大题位置拆分
    stem_matches = list(_STEM_RE.finditer(intro))
    if len(stem_matches) >= 2:
        stem_intros = []
        for i, m in enumerate(stem_matches):
            start = m.start()
            end = stem_matches[i + 1].start() if i + 1 < len(stem_matches) else len(intro)
            stem_intros.append(intro[start:end].strip())

        # 定位每个大题题干在原文中的位置
        stem_positions: list[tuple[int, str]] = []
        for si in stem_intros:
            pos = _find_in_content(si, card_content)
            if pos >= 0:
                stem_positions.append((pos, si))

        if len(stem_positions) >= 2:
            stem_positions.sort(key=lambda x: x[0])
            split_groups: list[dict] = []

            # 大题之前的题（如续页残留）-> 无 intro 组
            first_stem_pos = stem_positions[0][0]
            pre_qs = [q for pos, q in q_positions if pos < first_stem_pos]
            if pre_qs:
                split_groups.append({"intro": None, "questions": pre_qs})

            # 每个大题的题
            for i, (spos, si) in enumerate(stem_positions):
                next_pos = stem_positions[i + 1][0] if i + 1 < len(stem_positions) else len(card_content) + 1
                stem_qs = [q for pos, q in q_positions if spos <= pos < next_pos]
                if stem_qs:
                    split_groups.append({"intro": si, "questions": stem_qs})

            if len(split_groups) >= 2:
                return split_groups

    # Case 2: 部分 question 在原文中出现在 intro 之前 -> 拆为前组（无 intro）+ 后组（有 intro）
    if intro:
        intro_pos = _find_in_content(intro[:30] if len(intro) > 30 else intro, card_content)
        if intro_pos >= 0:
            pre_qs = [q for pos, q in q_positions if pos < intro_pos]
            post_qs = [q for pos, q in q_positions if pos >= intro_pos]
            if pre_qs and post_qs:
                return [
                    {"intro": None, "questions": pre_qs},
                    {"intro": intro, "questions": post_qs},
                ]

    return groups


@dataclass
class LabelResult:
    """LLM 标注产出"""
    page_type: str           # "front_matter" | "chapter_intro" | "content" | "practice"
    card_type: str           # "concept" | "example" | "practice" | "explore" | "summary" | "reading"
    lesson_id: str | None    # 章节标题原文，或 null（继承）
    title: str | None        # 卡片标题
    textbook_page: str       # 如 "P8"
    groups: list[dict] | None = None  # 仅 practice 卡：[{"intro": str|None, "questions": [{"n": int, "text": str}]}]


@dataclass
class PageLabelResult:
    """一页的标注结果"""
    page_type: str
    labels: list[LabelResult]  # 与 splitter 输出的卡片一一对应
    # card_type 超出白名单的卡（已归一为 concept）：[(卡序号, 模型原始值)]
    # 非空时调用方可触发分级重试（主模型重试 → 兜底模型）
    invalid_card_types: list[tuple[int, str]] = field(default_factory=list)


class CardLabeler:
    """使用 LLM 对 splitter 输出的卡片进行标注。"""

    def __init__(self, llm: LLMClient, prompt_template: str):
        self._llm = llm
        self._prompt = prompt_template
        # 最近一次 LLM 原始输出（诊断日志用：card_type 非法时随失败记录落盘）
        self.last_raw_content: str | None = None

    @property
    def model_name(self) -> str:
        """当前使用的模型名（诊断日志用）。"""
        return getattr(self._llm, "model", type(self._llm).__name__)

    def label(self, cards_text: list[str], page_number: str,
              prev_lesson_id: str | None = None,
              toc_labels: list[str] | None = None) -> PageLabelResult:
        """调用 LLM 对一页的卡片进行标注。

        Args:
            cards_text: 拆分后的卡片文本列表（splitter 输出）
            page_number: 页码字符串，如 "P8"
            prev_lesson_id: 上一页的 lesson_id（跨页继承）
            toc_labels: 该书 TOC 的合法 lesson_id 列表（注入 prompt，
                让 LLM 优先逐字复制目录条目，减少标签漂移）

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
        if toc_labels:
            shown = toc_labels[:300]
            listing = "\n".join(f"- {l}" for l in shown)
            if len(toc_labels) > len(shown):
                listing += f"\n- ...（共 {len(toc_labels)} 条，已截断）"
            user_message += (
                "\n\n---\nLegal lesson_id list（标注 lesson_id 时优先从下列目录条目中"
                "逐字复制；仅当页面确实出现列表中没有的编号节/子节标题时才输出页面原文）：\n"
                + listing
            )

        response: LLMResponse = self._llm.complete(self._prompt, user_message)
        self.last_raw_content = response.content
        data = _parse_json_object(response.content)

        page_type = str(data.get("page_type", "content"))
        raw_items = data.get("items", [])

        labels: list[LabelResult] = []
        invalid_card_types: list[tuple[int, str]] = []
        for idx, item in enumerate(raw_items):
            card_type = str(item.get("card_type", "concept"))
            if card_type not in VALID_CARD_TYPES:
                # 本地模型偶发把 page_type 枚举值（如 "content"）误填进 card_type；
                # 先归一为 concept 保住本页，同时记录原始值供调用方分级重试
                invalid_card_types.append((idx, card_type))
                card_type = "concept"
            raw_groups = item.get("groups")
            groups = None
            # 仅 practice 卡解析 groups；非 practice 卡即使 LLM 误返也忽略
            if card_type == "practice" and isinstance(raw_groups, list):
                groups = []
                for g in raw_groups:
                    if not isinstance(g, dict):
                        continue
                    g_intro = g.get("intro")
                    if not (isinstance(g_intro, str) and g_intro):
                        g_intro = None
                    g_qs = []
                    for q in g.get("questions") or []:
                        if not isinstance(q, dict):
                            continue
                        try:
                            n = int(q.get("n", 0))
                            if n < 1:
                                continue
                            text = q.get("text")
                            if not isinstance(text, str) or not text:
                                continue
                            g_qs.append({"n": n, "text": text})
                        except (TypeError, ValueError):
                            continue
                    if g_qs:
                        groups.append({"intro": g_intro, "questions": g_qs})
                if not groups:
                    groups = None
                else:
                    # 程序化兜底：LLM 把多组题塞进一个 group 时按原文位置拆分
                    groups = _split_groups_if_needed(groups, cards_text[idx] if idx < len(cards_text) else "")
            labels.append(LabelResult(
                page_type=page_type,
                card_type=card_type,
                lesson_id=item.get("lesson_id"),
                title=item.get("title"),
                textbook_page=item.get("textbook_page", page_number),
                groups=groups,
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

        return PageLabelResult(page_type=page_type, labels=labels,
                               invalid_card_types=invalid_card_types)
