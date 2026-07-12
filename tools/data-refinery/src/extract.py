"""LLM 提取器：从 Markdown 提取题目或卡片。"""

import json
from dataclasses import dataclass
from pathlib import Path

from llm import LLMClient, LLMResponse
from models import ExamQuestion, TextbookCard


_VALID_ESCAPES = set('"\\/bfnrtu')
_HEX = set("0123456789abcdefABCDEF")


def _strip_code_fence(text: str) -> str:
    """去除首尾 ```json / ``` 代码块围栏（若有）。"""
    if not text.startswith("```"):
        return text
    nl = text.find("\n")
    inner = text[nl + 1:] if nl != -1 else ""
    if inner.rstrip().endswith("```"):
        inner = inner.rstrip()[:-3]
    return inner.strip()


def _repair_json_escapes(text: str) -> str:
    """把非法 JSON 转义的反斜杠再加一层转义。

    即便提示词明确要求，本地量化模型在长输出中仍会偶发漏写 LaTeX 反斜杠的
    双转义，典型如填空横线 ``\\_`` 写成 ``\\_`` 后跟 ``\\_``（单反斜杠）、
    ``\\%`` 写成 ``\\%``。这些 ``\\X``（X 不属于合法转义字符）在 JSON 中
    永远非法，故把单反斜杠补成双反斜杠必能还原模型本意（字面反斜杠 + X），
    不会改变合法转义（``\\n`` ``\\t`` ``\\uXXXX`` 等）的语义。
    """
    out = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n:
            nxt = text[i + 1]
            if nxt == "u":
                # \u 后须紧跟 4 位十六进制；否则视为字面反斜杠
                if i + 6 <= n and all(c in _HEX for c in text[i + 2:i + 6]):
                    out.append(ch); out.append(nxt); i += 2
                    continue
                out.append("\\\\"); i += 1
                continue
            if nxt in _VALID_ESCAPES:  # 合法转义，含 \\ 自身
                out.append(ch); out.append(nxt); i += 2
                continue
            # 非法转义 -> 反斜杠补双
            out.append("\\\\"); out.append(nxt); i += 2
            continue
        out.append(ch); i += 1
    return "".join(out)


def _parse_json_object(content: str) -> dict:
    """从 LLM 输出中解析 JSON 对象。

    依次尝试：原样解析 -> 去除代码块 -> 修复非法转义 -> 截取最外层 ``{...}``。
    兼容本地模型常见的 ```json``` 围栏包裹与 LaTeX 反斜杠漏转义。
    """
    text = (content or "").strip()
    if not text:
        return {}

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    body = _strip_code_fence(text)
    if body != text:
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            pass

    try:
        return json.loads(_repair_json_escapes(body))
    except json.JSONDecodeError:
        pass

    start = body.find("{")
    end = body.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(_repair_json_escapes(body[start: end + 1]))
        except json.JSONDecodeError:
            pass

    raise json.JSONDecodeError("无法从 LLM 输出中定位 JSON 对象", content, 0)


@dataclass
class ExtractionResult:
    items: list[ExamQuestion | TextbookCard]
    prompt_tokens: int
    completion_tokens: int


class Extractor:
    def __init__(self, llm: LLMClient, prompt: str, kind: str):
        self._llm = llm
        self._prompt = prompt
        self._kind = kind  # "questions" | "cards"

    def run(self, md_path: Path) -> ExtractionResult:
        content = md_path.read_text(encoding="utf-8")
        response: LLMResponse = self._llm.complete(self._prompt, content)
        data = _parse_json_object(response.content)
        raw_items = data.get("items", [])

        if self._kind == "questions":
            items = [ExamQuestion(**item) for item in raw_items]
        else:
            items = [TextbookCard(**item) for item in raw_items]

        return ExtractionResult(
            items=items,
            prompt_tokens=response.prompt_tokens,
            completion_tokens=response.completion_tokens,
        )
