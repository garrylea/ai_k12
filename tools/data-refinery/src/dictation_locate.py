"""语文默写管线：用 LLM 在教材 MD 中定位古诗文/文言文。

职责边界（关键）：LLM **只做判断**——是不是古诗文、篇名/作者/朝代、体裁、
正文首末句锚点。**它不产出正文字符**；正文由 dictation_slice 按锚点从 MD 原样切出。
这样「正文错了」只可能是边界问题，不可能是模型幻觉。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from extract import _parse_json_object
from llm import LLMClient


class LocatedPassage(BaseModel):
    """一篇候选课文的定位结果。"""

    is_classical: bool = Field(..., description="是否古诗文/文言文（现代诗与现代文为 false）")
    work_title: str = ""
    author: str = ""
    dynasty: str = ""
    genre: Literal["shi", "ci", "qu", "wen", "other"] = "other"
    body_start_anchor: str = Field("", description="正文首句（含标点，逐字来自页文本）")
    body_end_anchor: str = Field("", description="正文末句（含标点，逐字来自页文本）")
    reason: str = Field("", description="判断依据，写进人工过目清单便于复核")


class LocateResult(BaseModel):
    passages: list[LocatedPassage] = Field(default_factory=list)


def locate_unit(llm: LLMClient, unit_label: str, unit_text: str, prompt: str) -> LocateResult:
    """对一个单元的页文本做定位。

    unit_text 为该单元涉及页按页序拼接、且已剥运行页眉的文本。
    """
    user_prompt = (
        f"【单元】{unit_label}\n\n"
        f"【教材页文本】\n{unit_text}\n\n"
        "请按系统提示的要求，输出该单元内每篇古诗文/文言文的定位结果。"
    )
    response = llm.complete(prompt, user_prompt)
    return LocateResult.model_validate(_parse_json_object(response.content))
