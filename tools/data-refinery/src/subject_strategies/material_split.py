"""题内材料切分（物理/化学共用规则）— 2026-11-02。

## 为什么单独一个模块

`MaterialPolicy` 管的是「题号前 / 两题之间的短文归到哪道题」（语文/英语跨题共享）。
物理/化学的科普阅读题、实验探究题是**另一形态**：材料与小问在同一个题号内

    31. 阅读以下文字，并回答问题：
    <6 段科普正文 + 图>
    (1) ……
    (2) ……
    (3) ……

小问不是主题号（`question_splitter` 明确「小问号不切，合并到上一个主题号」），
所以材料与问题一起落在 `content` 里。本模块把这一段的材料切到 `material_text`。

## 三级流水（用户 2026-11-02 裁决）

1. **规则**（本模块）：命中材料标志 + 行首 `(1)` + 小问连续（存在 `(2)`）→ 确定切分
2. **LLM 兜底**：规则没切但 `needs_llm()` 为真时，交给 `material_split_cli` 批量处理
3. **人工**：规则与 LLM 都失败才进待审清单

## 自校验

切分点按原文切片，`material + rest == content` **构造上恒成立**（不做 rstrip），
所以不存在「丢字」风险；展示层自行处理首尾空白。
"""

import re

# 材料标志词。都在真实试卷里出现过至少一次（物理/化学 2024 各卷）。
_MATERIAL_HINT = re.compile(
    r"阅读以下文字|阅读下面|阅读材料|阅读短文|科普短文|科普阅读|"
    r"【进行实验】|【查阅资料】|【提出问题】|【进行猜想】|【实验探究】|【反思评价】"
)

# 行首小问起点：`(1)` / `（1）` / `1）`（OCR 常丢左括号），后面要有实际内容。
_SUBQ1 = re.compile(r"^[ \t]*[（(]?1[）)][ \t]*\S", re.MULTILINE)
# 小问连续性：rest 里还要有 `(2)`/`2）`，否则这个 `(1)` 多半是正文里的公式编号。
_SUBQ2 = re.compile(r"[（(]?2[）)]")

# 低于此长度基本不可能是「材料 + 小问」。
MIN_CONTENT_LEN = 100
# 材料段至少要有这么多实质内容（防把题号行当材料）。
MIN_MATERIAL_LEN = 60
# 材料段**含图/表**时的下限：物理化学常见「用下图装置进行实验。」一句话 + 图 + 小问，
# 材料本身很短，但图必须留在材料区，否则小问区会莫名其妙挂一张图。
MIN_MATERIAL_LEN_WITH_FIGURE = 8
# 小问段至少要有这么多实质内容。
MIN_REST_LEN = 10

_FIGURE_MARK = ("![", "<table", "<img")


def split_material_rule(content: str) -> tuple[str | None, str]:
    """规则切分。切不动返回 `(None, content)`。

    判据是**结构**而不是关键词：物理/化学的实验题多数不写「阅读以下文字」，
    开头直接是「小丽想要探究…实验桌上的器材有…」+ 图 + 表，然后 `(1)(2)(3)`。
    因此只看三件事：

    1. 有行首 `(1)` 小问起点
    2. 小问连续（rest 里还有 `(2)`）
    3. 切分前是**实质性的一大段**（≥ `MIN_MATERIAL_LEN`，用来排除
       「求下列各式的值：(1)…(2)…」这类题干本身就是问题的短题）

    返回的 `material` 是**原文切片**（不 rstrip），保证 `material + rest == content`。
    """
    if not content or len(content) < MIN_CONTENT_LEN:
        return (None, content)

    m = _SUBQ1.search(content)
    if not m:
        return (None, content)

    cut = m.start()
    material, rest = content[:cut], content[cut:]
    has_figure = any(mark in material for mark in _FIGURE_MARK)
    min_material = MIN_MATERIAL_LEN_WITH_FIGURE if has_figure else MIN_MATERIAL_LEN
    if len(material.strip()) < min_material or len(rest.strip()) < MIN_REST_LEN:
        return (None, content)
    if not _SUBQ2.search(rest):
        # 只有孤零零一个 (1)：大概率是正文公式编号，不切。
        return (None, content)
    return (material, rest)


def needs_llm(content: str) -> bool:
    """规则没切、但**看起来仍像材料题**时才值得调 LLM（控制成本）。

    判据：够长 + 有行首 `(1)`，但规则因「小问不连续 / 材料段太短」没切。
    这类多半是小问编号格式异常（`(1)` 后是 `①` 而不是 `(2)`），交给 LLM 判切点。
    """
    if not content or len(content) < MIN_CONTENT_LEN:
        return False
    return bool(_SUBQ1.search(content))
