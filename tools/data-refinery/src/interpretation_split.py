"""语文古诗文解释专项管线：**切句与字词归属**（纯函数，不碰网络与数据库）。

用户说「你的数据管线需要拆分则自己拆分」——「拆分」就是本模块：
把它们给的「词 + 解释」挂到正文的**某一句话**上（三行对译的第 2 行要知道这一句有哪些词）。

## 切句口径

按句末标点 `。！？；` 切，**标点留在句尾**，句内其余标点（`，、` 等）不动。

**不变式**：`''.join(text for text in sentences) == body`，**逐字相等（含标点）**。
这条由 `interpretation_check` 断言，不是「大概齐」——学生逐句答完就等于把整篇译了一遍，
切句漂移了没人发现才是灾难。

## 字词归属

对每个词，在句子里找**第一个包含它**的那句，取其下标。
- 同一个词出现在多句 → 取首次（学生只答一次，判题也只看这一句）。
- **在正文里找不到的词 → 丢弃并告警**（用户 2026-09-16 裁决）：
  挂不到句子，答题页就没有落点，学生没处填；留下只会变成看不见的死数据。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from interpretation_input import InputKeyTerm

#: 句末标点。只有这些断句，`，`/`、`/`：` 不断。
SENTENCE_END_CHARS = "。！？；"

#: 只当括号内**全是**这些字符时才算「注音」——避免误剥 `（其一）`、`（前259—前210）`、
#: `（醉翁）` 这类真括号（它们是词的一部分，剥掉就去正文里找不到了）。
_PINYIN_CHARS = "A-Za-z0-9" + "āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹ" + r"\s,·．."
_PINYIN_PAREN_RE = re.compile(r"[（(][" + _PINYIN_CHARS + r"]+[）)]")


def term_plain(term: str) -> str:
    """去掉注音括号后的形式——**只用于在正文里定位**。

    用户 2026-09-16 裁决：字词**保留拼音**（学生要看得见读音，如 `谪（zhé）守`），
    所以入库与展示都用原样；但正文里写的是「谪守」，拿带注音的形式去 `in` 永远找不到
    —— 于是定位这一步单独用去注音形式。
    """
    return _PINYIN_PAREN_RE.sub("", term).strip()


@dataclass
class AttributionResult:
    """归属结果。`key_terms` 每项含 `term` / `gloss` / `sentenceIndex`。"""

    key_terms: list[dict] = field(default_factory=list)
    dropped_terms: list[str] = field(default_factory=list)


def split_sentences(body: str) -> list[str]:
    """把正文切成句子（标点留句尾）。

    末尾没有句末标点的残句**也单独成句**——否则拼不回正文，不变式就断了。
    """
    sentences: list[str] = []
    current: list[str] = []
    for ch in body:
        current.append(ch)
        if ch in SENTENCE_END_CHARS:
            sentences.append("".join(current))
            current = []
    if current:
        # 非空即收（哪怕只有空白）：拼回正文的不变式优先于「句子好看」
        sentences.append("".join(current))
    return sentences


def attribute_terms(sentences: list[str], terms: list[InputKeyTerm]) -> AttributionResult:
    """把每个字词挂到「首个包含它的句子」上。挂不到的丢弃并记进 `dropped_terms`。

    定位用 `term_plain`（去注音）——词本身保留拼音入库/展示，但正文里没有拼音。
    若去注音后仍找不到，再拿原样试一次（万一某条注音其实是词的一部分）。
    """
    result = AttributionResult()
    for t in terms:
        plain = term_plain(t.term)
        hit = next((i for i, s in enumerate(sentences) if plain and plain in s), None)
        if hit is None:
            hit = next((i for i, s in enumerate(sentences) if t.term in s), None)
        if hit is None:
            result.dropped_terms.append(t.term)
            continue
        result.key_terms.append({
            "term": t.term,          # 原样（带拼音）——展示用
            "gloss": t.gloss,
            "src": "user",           # 词由人整理提供（区别于旧的 textbook/llm 抽取）
            "sentenceIndex": hit,
        })
    return result


def join_sentences(sentences: list[str]) -> str:
    """把句子拼回正文——不变式断言用。"""
    return "".join(sentences)
