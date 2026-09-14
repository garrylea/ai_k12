"""语文默写管线：正文纠正（**唯一允许模型产出正文字符**的环节）。

⚠️ 与 `dictation_locate` 的边界正好相反，改动本模块前务必先读这段：

- `dictation_locate` 只让模型给锚点，正文由 `dictation_slice` 从 MD **原样切出**——
  于是「正文错了只可能是边界问题，不可能是模型幻觉」。
- 本模块**故意让模型重写正文**。原因：有些错误在页面上就是错的（OCR 认错字、
  注释碎片混入正文），不存在任何「原样可切的正确源」，程序无法自行修好。

模型选择（用户 2026-09-14 指定）：**本地模型优先、ds flash 兜底**。primary / fallback
分别取 `.env` 的 `LLM_PROVIDER` 与 `LLM_FALLBACK_*`，与 refinery 其余环节一致
（当前 = `local` / `deepseek`），本模块不硬编码任何模型名。

策略（用户 2026-09-14 裁决，**勿再加固成闸门**）：把自检未过的篇目直接交给模型，
**模型输出即采用**，不再拿长度比之类的规则去拦——用户的判断是「模型肯定是对的」。
曾经的 `[_MIN_RATIO, _MAX_RATIO]` 长度护栏已被明确要求去掉：它会拦住「正文过短」
这类**本来就需要模型补内容**的情形，属于自相矛盾。

保留的两件事都不是闸门，不阻断任何输出：

1. `normalize_body` 复用于模型输出——与切片正文走同一套空白/角标清理，否则模型
   抄回的 `$^{①}$` 角标会原样进库（学生不会打角标，判题必然不等）。
2. **留痕**：原文、纠正稿、用了哪个模型、纠正稿重跑自检后还剩什么问题，都写进
   `{book}-review.md`。纠正后自检仍报错时**照常入库**，只在报告里标出来让人看见。

只有当**两个模型都拿不出任何非空输出**（调用失败/返回空）时才返回 `body=None`，
此时维持 fail-closed（不进 JSONL，进人工处理清单）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from dictation_check import check_body
from dictation_slice import normalize_body
from llm import LLMClient

#: 模型常把正文裹在 ``` 里（哪怕提示词说了不要），剥掉围栏
_FENCE_RE = re.compile(r"^\s*```[a-zA-Z0-9_-]*\s*\n(.*?)\n?\s*```\s*$", re.DOTALL)


@dataclass
class RepairResult:
    """一次纠正尝试的结论。

    `body is None` 仅表示**两个模型都没给出非空输出**——调用方须维持 fail-closed，
    不得把原文当「已纠正」放行。
    """

    body: str | None = None
    source: str | None = None
    attempts: list[str] = field(default_factory=list)
    note: str = ""
    residual: list[str] = field(default_factory=list)


def _strip_fence(text: str) -> str:
    """剥掉包住正文的 markdown 代码围栏（只剥最外层一对）。"""
    match = _FENCE_RE.match(text)
    return match.group(1) if match else text


def build_user_prompt(body: str, work_title: str, author: str, dynasty: str,
                      genre: str, errors: list[str]) -> str:
    """组装纠正请求的用户消息（把自检发现的问题一并交给模型）。"""
    return (
        f"【篇名】{work_title or '（未知）'}\n"
        f"【作者】{author or '（未知）'}（{dynasty or '未知'}）\n"
        f"【体裁】{genre}\n"
        f"【程序自检发现的问题】{'；'.join(errors)}\n\n"
        f"【待纠正的正文】\n{body}\n\n"
        "请输出纠正后的正文全文（只输出正文，不要任何解释）。"
    )


def _label(kind: str, llm: LLMClient, index: int) -> str:
    """给尝试记一条人可读标签（模型名即可，取不到就退化为序号）。"""
    model = getattr(llm, "model", "") or f"模型{index + 1}"
    return f"{kind}:{model}"


def repair_body(
    primary: LLMClient,
    fallback: LLMClient | None,
    *,
    body: str,
    work_title: str,
    author: str,
    dynasty: str,
    genre: str,
    errors: list[str],
    chrome: set[str],
    prompt: str,
) -> RepairResult:
    """按「本地优先 → ds flash 兜底」纠正一篇自检未通过的正文。

    取**第一个非空输出**即采用（用户裁决：不要额外闸门）。每个模型只判「是否给出
    了非空输出」，不给就换下一个；两个都不给才返回 `body=None`。
    """
    candidates: list[tuple[str, LLMClient]] = [
        (kind, llm) for kind, llm in (("local", primary), ("fallback", fallback))
        if llm is not None
    ]
    user_prompt = build_user_prompt(body, work_title, author, dynasty, genre, errors)
    attempts: list[str] = []

    for index, (kind, llm) in enumerate(candidates):
        label = _label(kind, llm, index)
        try:
            response = llm.complete(prompt, user_prompt)
        except Exception as exc:                      # 模型不可达/超时/4xx：换下一个
            attempts.append(f"{label} 调用失败：{str(exc)[:160]}")
            continue

        # 与切片正文同一套清理（空白 + 角标），避免模型抄回的 `$^{①}$` 原样进库
        candidate = normalize_body(_strip_fence(response.content or "")).strip()
        if not candidate:
            attempts.append(f"{label} 输出为空")
            continue

        residual = check_body(candidate, work_title, genre, chrome).errors
        attempts.append(
            f"{label} 已采用（{len(body)} -> {len(candidate)} 字）"
            + (f"，纠正后自检仍报：{'；'.join(residual)}" if residual else "，纠正后自检通过")
        )
        return RepairResult(
            body=candidate,
            source=label,
            attempts=attempts,
            note=f"{label}（{len(body)} -> {len(candidate)} 字）",
            residual=residual,
        )

    return RepairResult(
        body=None,
        source=None,
        attempts=attempts,
        note="所有模型均未给出非空输出，维持 fail-closed",
    )
