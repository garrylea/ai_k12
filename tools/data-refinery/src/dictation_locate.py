"""语文默写管线：用 LLM 在教材 MD 中定位古诗文/文言文。

职责边界（关键）：LLM **只做判断**——是不是古诗文、篇名/作者/朝代、体裁、
正文首末句锚点。**它不产出正文字符**；正文由 dictation_slice 按锚点从 MD 原样切出。
这样「正文错了」只可能是边界问题，不可能是模型幻觉。

容错（Task 4 评审 Important）：`LocateResult.model_validate` 是**整体**校验，模型一条
畸形数据（`genre: "诗"`、`is_classical` 缺失、裸数组顶层……）就会让**整个单元**被上游
`except Exception` 丢掉（本册一次可损失 10 篇）。故改为**逐条独立校验**：好的留下、
坏的记进 `rejected`（Task 7 写进待人工处理清单，不静默丢）。

- `genre` 白名单外**归一为 `other`**——那正是该字段的默认语义，不让单条幻觉毁掉整页
  （仓库先例：`card_labeler.py` 白名单外回退 concept）。
- `is_classical` 缺失/非法则**只丢该条**，**不默认 True**（默认会静默放宽收录范围）。
"""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator

from extract import _parse_json_object
from llm import LLMClient

_GENRES = ("shi", "ci", "qu", "wen", "other")

# rejected 说明串里的值截断长度：够定位到条目即可，不把整条原文抄进报告
_BRIEF_LIMIT = 60
_REASON_LIMIT = 80

# 拼 rejected 识别信息时**只认契约里声明的字段名**（见 _identify）
_IDENTIFY_FIELDS = ("work_title", "author", "dynasty", "genre", "body_start_anchor")


def _brief(value: Any, limit: int = _BRIEF_LIMIT) -> str:
    """把任意原始值压成一行短文本（供 rejected 说明用，绝不抛错）。"""
    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        text = repr(value)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "…"


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

    @field_validator("genre", mode="before")
    @classmethod
    def _coerce_genre(cls, value: Any) -> str:
        """白名单外（含 null/非字符串）的体裁归一为 other：条目保住，语义不变。"""
        return value if value in _GENRES else "other"


class LocateResult(BaseModel):
    passages: list[LocatedPassage] = Field(default_factory=list)
    rejected: list[str] = Field(
        default_factory=list,
        description="逐条校验失败的条目说明（原因 + 可识别的原始信息），必须写进人工处理清单",
    )


def _identify(raw: dict[str, Any]) -> str:
    """用契约内字段拼一条识别信息（供 rejected 说明）。

    只认契约里声明的字段名：模型若违规回吐 `body` 之类的正文字段，正文文本不得借道
    `rejected` 流向 Task 7 的人工处理报告——这是本模块「正文只能来自 MD 切片」的护栏。
    """
    parts = []
    for key in _IDENTIFY_FIELDS:
        value = raw.get(key)
        if value:
            parts.append(f"{key}={_brief(value)}")
    return "，".join(parts) if parts else "无可用字段"


def _rejection_note(index: int, raw: dict[str, Any], exc: ValidationError) -> str:
    """把一条校验失败压成一行短说明：带序号、篇名（没有就带契约内字段）与原因。"""
    title = raw.get("work_title")
    if isinstance(title, str) and title.strip():
        label = f"《{_brief(title.strip())}》"
    else:
        label = f"无篇名({_identify(raw)})"
    reasons = []
    for err in exc.errors()[:3]:
        loc = ".".join(str(part) for part in err.get("loc") or ())
        msg = _brief(str(err.get("msg", "校验失败")), _REASON_LIMIT)
        reasons.append(f"{loc}: {msg}" if loc else msg)
    return f"第{index + 1}条{label}被丢弃：" + "；".join(reasons or ["未知校验错误"])


def _parse_located(data: Any) -> LocateResult:
    """逐条独立校验模型输出；单条畸形只影响该条，不连坐整个单元。"""
    if isinstance(data, list):
        # 裸数组顶层：模型偶尔只回吐 passages 数组本身（_parse_json_object 会原样返回 list）
        raw_entries = data
    elif isinstance(data, dict):
        if "passages" not in data:
            # 没有 passages 键（如 llm.py 对空内容兜底的 "{}"）→ 空结果，不算错误
            return LocateResult()
        raw_entries = data["passages"]
    else:
        return LocateResult(rejected=[f"顶层不是 JSON 对象/数组（{type(data).__name__}），按空处理"])

    if not isinstance(raw_entries, list):
        return LocateResult(
            rejected=[f"passages 不是数组（{type(raw_entries).__name__}），按空处理"]
        )

    passages: list[LocatedPassage] = []
    rejected: list[str] = []
    for index, raw in enumerate(raw_entries):
        if not isinstance(raw, dict):
            # 不回显内容（可能是模型直接倒出来的正文），只报类型与序号
            rejected.append(f"第{index + 1}条不是对象（{type(raw).__name__}）被丢弃")
            continue
        try:
            passages.append(LocatedPassage.model_validate(raw))
        except ValidationError as exc:
            rejected.append(_rejection_note(index, raw, exc))

    return LocateResult(passages=passages, rejected=rejected)


def locate_unit(llm: LLMClient, unit_label: str, unit_text: str, prompt: str) -> LocateResult:
    """对一个单元的页文本做定位。

    unit_text 为该单元涉及页按页序拼接、且已剥运行页眉的文本。
    逐条独立校验：单条畸形只丢该条，其余条目照常返回（见模块 docstring）。
    """
    user_prompt = (
        f"【单元】{unit_label}\n\n"
        f"【教材页文本】\n{unit_text}\n\n"
        "请按系统提示的要求，输出该单元内每篇古诗文/文言文的定位结果。"
    )
    response = llm.complete(prompt, user_prompt)
    return _parse_located(_parse_json_object(response.content))
