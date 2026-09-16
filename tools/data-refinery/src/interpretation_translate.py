"""语文古诗文解释专项管线：**译文生成**（混合模式的「没给就生成」那一半）。

用户 2026-09-16 裁决的混合模式：

- 输入里**给了** `sentences`（逐句原文 + 译文）→ **不调模型**，用输入的；
- 输入里**没给** → 本模块调模型生成逐句译文与整篇译文。

## 两条铁律

1. **模型只填 `translation`，不产出 `text`**。句子文本一律来自 `interpretation_split`
   的程序切句——模型改一个标点都会让「切句拼回正文」的不变式断掉。
   所以请求里只把句子**编号**给它，回来按编号取译文；多给的原文一概忽略。
2. **两个模型都拿不到合法结果就 return 错误**，由调用方 fail-closed（该篇不入库），
   绝不拿半截译文凑数——答题页缺一段译文比整篇不入库更糟。

模型选择与 refinery 其余环节一致：**本地优先、ds flash 兜底**（`.env` 的
`LLM_PROVIDER` / `LLM_FALLBACK_*`），本模块不硬编码模型名。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from llm import LLMClient

#: 模型常把 JSON 裹在 ``` 里（哪怕提示词说了不要），剥掉围栏
_FENCE_RE = re.compile(r"^\s*```[a-zA-Z0-9_-]*\s*\n(.*?)\n?\s*```\s*$", re.DOTALL)


@dataclass
class TranslateResult:
    """`translations is None` 表示**所有模型都没给出合法结果**——调用方须 fail-closed。"""

    translations: list[str] | None = None
    full_translation: str | None = None
    source: str | None = None
    attempts: list[str] = field(default_factory=list)
    error: str | None = None


def build_user_prompt(work_title: str, sentences: list[str], key_terms: list[dict]) -> str:
    numbered = "\n".join(f"{i}. {s}" for i, s in enumerate(sentences))
    if key_terms:
        terms = "\n".join(
            f"- {t['term']}：{t['gloss']}（第 {t['sentenceIndex']} 句）" for t in key_terms
        )
        terms_block = f"\n【本篇重点字词（供参考，翻译时请把它们的含义译进去）】\n{terms}\n"
    else:
        terms_block = ""

    return (
        f"【篇名】{work_title}\n"
        f"{terms_block}\n"
        f"【逐句原文（共 {len(sentences)} 句，编号从 0 开始）】\n{numbered}\n\n"
        "请为每一句给出白话译文，并另给一份整篇的连贯译文。\n"
        "严格按下面的 JSON 输出，不要任何其它文字：\n"
        '{"translations":["第0句译文","第1句译文",...],"full":"整篇译文"}\n'
        f'其中 translations 数组的长度必须正好是 {len(sentences)}，顺序与编号一一对应。'
    )


def _strip_fence(text: str) -> str:
    match = _FENCE_RE.match(text)
    return match.group(1) if match else text


def _parse_payload(raw: str, expected_len: int) -> tuple[list[str] | None, str | None, str | None]:
    """→ (translations, full, error)。任何不合规都返回 error，不返回「凑合能用」的结果。"""
    text = _strip_fence((raw or "").strip())
    if not text:
        return None, None, "输出为空"
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return None, None, f"不是合法 JSON（{e}）"
    if not isinstance(data, dict):
        return None, None, "顶层不是 JSON 对象"

    translations = data.get("translations")
    full = data.get("full")
    if not isinstance(translations, list):
        return None, None, "缺少 translations 数组"
    if len(translations) != expected_len:
        return None, None, f"translations 条数 {len(translations)} != 句数 {expected_len}"
    cleaned: list[str] = []
    for i, tr in enumerate(translations):
        if not isinstance(tr, str) or not tr.strip():
            return None, None, f"第 {i} 句译文为空"
        cleaned.append(tr.strip())
    if not isinstance(full, str) or not full.strip():
        return None, None, "整篇译文为空"
    return cleaned, full.strip(), None


def _label(kind: str, llm: LLMClient, index: int) -> str:
    model = getattr(llm, "model", "") or f"模型{index + 1}"
    return f"{kind}:{model}"


def translate_passage(
    primary: LLMClient,
    fallback: LLMClient | None,
    *,
    work_title: str,
    sentences: list[str],
    key_terms: list[dict],
    prompt: str,
) -> TranslateResult:
    """按「本地优先 → ds flash 兜底」生成一篇的逐句 + 全文译文。

    **不做部分采用**：某个模型给的结果若不合规（条数不对/有空译文/整篇为空），
    整体弃用换下一个；两个都不合规就返回 `translations=None`。
    """
    candidates: list[tuple[str, LLMClient]] = [
        (kind, llm) for kind, llm in (("local", primary), ("fallback", fallback))
        if llm is not None
    ]
    user_prompt = build_user_prompt(work_title, sentences, key_terms)
    attempts: list[str] = []

    for index, (kind, llm) in enumerate(candidates):
        label = _label(kind, llm, index)
        try:
            response = llm.complete(prompt, user_prompt)
        except Exception as exc:                       # 模型不可达/超时/4xx：换下一个
            attempts.append(f"{label} 调用失败：{str(exc)[:160]}")
            continue

        translations, full, err = _parse_payload(response.content or "", len(sentences))
        if err is not None:
            attempts.append(f"{label} 输出不合规：{err}")
            continue

        attempts.append(f"{label} 已采用（{len(sentences)} 句）")
        return TranslateResult(
            translations=translations,
            full_translation=full,
            source=label,
            attempts=attempts,
        )

    return TranslateResult(
        translations=None,
        full_translation=None,
        source=None,
        attempts=attempts,
        error="所有模型均未给出合规译文，维持 fail-closed（该篇不入库）",
    )
