"""LLM 提取器：从 Markdown 提取题目或卡片。"""

import json
import re
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


_TAG_LT_RE = re.compile(r"<([a-zA-Z][a-zA-Z0-9]*)(?=<)")


def repair_malformed_html(text: str | None) -> str | None:
    """修 LLM 抽取题面时常见的 HTML 残缺：``<tr<td>`` 这种缺 ``>`` 的写法
    修成 ``<tr><td>``。

    Why: 本地量化模型在表格稠密的题面里偶发把 ``<tr><td>`` 的第一个 ``>``
    漏掉，写成 ``<tr<td>``。前端的 ``rehype-raw``（用 parse5）和 Python 的
    bs4+html.parser / bs4+lxml 都无法修这种残缺——parse5/html.parser 把
    ``tr<td`` 当成 tag 名（React 渲染抛 ``Invalid tag: tr<td``），lxml 把
    ``<tr<td>20</td>`` 解析成 ``<tr>20<td>21</td></tr>``（20 裸露在 tr 里
    没被 td 包裹）。两者都破坏表格结构，故自己写正则。

    规则：``<tag`` 后跟 ``<``（而非 ``>``）说明 tag 没闭合，补 ``>``。用
    lookahead ``(?=<)`` 不消耗 ``<``，一次扫描能处理连续残缺
    （``<table<tr<td>`` → ``<table><tr><td>``：``<table`` 匹配补 ``>``，
    ``<`` 保留给下一轮 ``<tr`` 匹配）。只匹配 ``<字母序列`` 后跟 ``<``，
    不误伤合法 ``a < b`` / ``$x < y$``（``<`` 后非字母或后续非 ``<``），
    也不误伤合法 ``<table>``（``<table`` 后是 ``>`` 不匹配前瞻）。

    调用点：``Extractor.run`` 在 LLM JSON 解析后、构造 dataclass 前，
    对题面 markdown 字段（content / options[].text / answer / explanation /
    material_text / title）调用。前端 ``apps/web/src/components/markdown.tsx``
    有同名 ``repairHtml`` 兜底，已有库数据无需重跑管线即生效。
    """
    if not text or "<" not in text:
        return text
    return _TAG_LT_RE.sub(r"<\1>", text)


# 含 markdown / HTML 表格的题面字段，需在 LLM 输出后调 repair_malformed_html。
_MD_HTML_FIELDS_QUESTIONS = ("content", "answer", "explanation", "material_text")
_MD_HTML_FIELDS_CARDS = ("content", "title")


def _repair_item_html(item: dict, kind: str) -> dict:
    """对单个 LLM 抽取条目的 markdown 字段修 HTML 残缺。原地修改并返回。"""
    fields = (
        _MD_HTML_FIELDS_QUESTIONS if kind == "questions" else _MD_HTML_FIELDS_CARDS
    )
    for f in fields:
        v = item.get(f)
        if isinstance(v, str):
            item[f] = repair_malformed_html(v)
    if kind == "questions":
        opts = item.get("options")
        if isinstance(opts, list):
            for opt in opts:
                if isinstance(opt, dict) and isinstance(opt.get("text"), str):
                    opt["text"] = repair_malformed_html(opt["text"])
    return item


def _parse_json_object(content: str) -> dict:
    """从 LLM 输出中解析 JSON 对象。

    依次尝试：原样解析 -> 去除代码块 -> 修复非法转义 -> 截取最外层 ``{...}``。
    兼容本地模型常见的 ```json``` 围栏包裹与 LaTeX 反斜杠漏转义。
    """
    text = (content or "").strip()
    if not text:
        return {}

    # 剥离 <think>...</think> 块（本地/推理模型 thinking 模式下可能直接输出思考标签）
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
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
        # 跳过 content 为 null/空 的条目（LLM 偶发对纯图片片段返回 null，避免整页失败）
        raw_items = [it for it in raw_items if it.get("content")]
        # 修 LLM 输出题面里常见的 HTML 残缺（<tr<td> 缺 >）→ <tr><td>，
        # 在构造 dataclass 前对所有 markdown 字段调用（见 repair_malformed_html）
        raw_items = [_repair_item_html(it, self._kind) for it in raw_items]

        if self._kind == "questions":
            items = [ExamQuestion(**item) for item in raw_items]
        else:
            items = [TextbookCard(**item) for item in raw_items]

        return ExtractionResult(
            items=items,
            prompt_tokens=response.prompt_tokens,
            completion_tokens=response.completion_tokens,
        )
