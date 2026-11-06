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


# ── 末句设问（道法/历史材料题的常见形态）────────────────────────────────
#
#    27.（10分）……三双鞋……
#    <三段材料，每段带小标题>
#    结合材料，运用所学，谈谈“三双鞋”中蕴含的“变”与“不变”。
#
# 与物化的区别：**没有 (1)(2) 小问编号**，材料后面只跟一句设问。判据同样是结构：
# 最后一行以「结合/根据/运用/请/谈谈…」起头，前面是一整段材料。

_TAIL_LEAD = ("结合", "根据", "运用", "请", "谈谈", "说说", "简述",
              "分析", "评析", "说明", "为")
_TAIL_HINTS = ("结合材料", "运用所学", "谈谈你的", "说说你的")
_MIN_TAIL_LEN, _MAX_TAIL_LEN = 8, 120
_OPTION_LINE = re.compile(r"(?m)^[ \t]*[（(]?[A-D][)）]?[ \t]*[.．、][ \t]*\S")


def split_tail_question_rule(content: str) -> tuple[str | None, str]:
    """把「材料 + 末句设问」切成 `(material, 设问)`；切不动返回 `(None, content)`。

    只在**没有小问编号**时使用（有 `(1)` 的走 `split_material_rule`）。
    返回的 rest 从原文切片，`material + rest == content` 恒成立。
    """
    if not content or len(content) < MIN_CONTENT_LEN:
        return (None, content)
    if _SUBQ1.search(content):
        return (None, content)

    body = content.rstrip()          # 只用来定位最后一行，不改切片
    cut = body.rfind("\n")
    if cut <= 0:
        return (None, content)
    tail = body[cut + 1:].strip()
    material = content[:cut + 1]     # 保留行尾换行，material + rest 才能拼回原文
    rest = content[cut + 1:]

    if not (_MIN_TAIL_LEN <= len(tail) <= _MAX_TAIL_LEN):
        return (None, content)
    if not (tail.startswith(_TAIL_LEAD) or any(h in tail for h in _TAIL_HINTS)):
        return (None, content)
    if len(material.strip()) < MIN_MATERIAL_LEN:
        return (None, content)
    # 材料里有两行以上 A–D 就是选择题，别把选项当材料
    if len(_OPTION_LINE.findall(material)) >= 2:
        return (None, content)
    return (material, rest)


# ── 题前共享材料（第二种形态）────────────────────────────────────────────
#
# 物化除了「题内材料」，还有**题号前**的科技阅读题：
#
#     ## 四、科技阅读题（共3分，每空1分。）
#     请阅读《航天动力电池》并回答第 32 题。
#     ## 航天动力电池
#     <材料 4 段 + 图>
#     32. 请根据上述材料，回答下列问题:
#     (1) …… (2) …… (3) ……
#
# 旧管线（物理/化学 material_policy = 不挂材料）把这段材料**整段丢弃**，
# 结果是题目说「请根据上述材料」而材料不存在（2026-11-02 用户报告第 32 题）。
# 复用语文那套 MaterialPolicy 也能做，但它动的是切题状态机、会影响语文/英语；
# 这里改成切完题后的**独立后处理**：按引导语锚点把材料挂到引用它的题目上。

# 材料引导语：出现即代表「下面是这段材料」，位置在题号之前。
_PRE_ANCHOR = re.compile(
    r"请阅读《[^》]{1,40}》并回答|请阅读下面的材料|请阅读下列材料|"
    r"阅读下面的材料|阅读下列材料|阅读材料，回答|请阅读材料"
)

# 题目的「指向前文」标志：只有这种题才需要把前文材料挂上来。
_PRE_HINT = re.compile(
    r"^(?:请)?(?:根据|结合|阅读)(?:上述|上面|上文|以上)(?:的)?(?:材料|短文|文字|内容)"
)

# 材料块的最低长度（防把「请阅读《x》并回答第 32 题。」一句话当整段材料）。
MIN_PRE_MATERIAL_LEN = 30
# 锚点向上回溯的上限行数（一份卷子的一个材料块不会更长）。
PRE_ANCHOR_WINDOW = 150


def _stem_line_index(lines: list[str], n: int, start: int) -> int | None:
    """从 start 起找题号 N 的行（`32.` / `32．` / `32、`，容忍加粗）。"""
    pat = re.compile(rf"^\s*(?:\*\*)?{n}\s*[.．、]")
    for i in range(start, len(lines)):
        if pat.match(lines[i]):
            return i
    return None


_ANY_STEM_RE = re.compile(r"^\s*(?:\*\*)?\d{1,3}\s*[.．、]")


def needs_pre_material(content: str) -> bool:
    """题目是否在引用前文材料（「根据上述材料」「请阅读上述短文」）。"""
    return bool(_PRE_HINT.match((content or "").lstrip()))


def pre_material_for(lines: list[str], stem_idx: int) -> str | None:
    """取 `stem_idx` 之前最近一个材料引导语起的材料块（不含题号行）。

    材料块止于锚点后的**第一个题号行**：共享材料（「根据上述材料回答第 32、33 题」）
    时，两道题拿到的是同一份，不会把上一题正文算进材料。
    回填脚本按行号定位时直接用它（切题阶段用 `attach_pre_material`）。
    """
    for j in range(stem_idx - 1, max(-1, stem_idx - PRE_ANCHOR_WINDOW), -1):
        if not _PRE_ANCHOR.search(lines[j]):
            continue
        end = next((k for k in range(j + 1, len(lines)) if _ANY_STEM_RE.match(lines[k])), stem_idx)
        block = "\n".join(lines[j:end]).strip()
        return block if len(block) >= MIN_PRE_MATERIAL_LEN else None
    return None


def attach_pre_material(questions, lines: list[str]) -> int:
    """把「题号前的共享材料」挂到引用它的题目上（物理/化学科技阅读题）。

    Args:
        questions: 已切好的题（需有 `group_order` / `content` / `material_text`）
        lines: 试卷 MD 的原始行

    Returns:
        挂上材料的题数

    规则：
    1. 题目 `content` 以「根据/阅读上述材料」开头（说明它在引用前文）
    2. 题号行之前、最近 150 行内能找到材料引导语（`请阅读《…》并回答第 N 题` 等）
    3. 材料 = 引导语行 → 该段第一个题号行之前的所有行（含文章标题、正文、图）

    同一材料块被多题引用时（「根据上述材料回答 1-3 题」），每道题都挂同一份。
    """
    if not lines or not questions:
        return 0

    # 题号 → 行号（按题目顺序向后推进，避免命中答案区的同名题号）
    stems: list[tuple[int, object]] = []
    cursor = 0
    for q in questions:
        idx = _stem_line_index(lines, q.group_order, cursor)
        if idx is None:
            continue
        stems.append((idx, q))
        cursor = idx + 1
    if not stems:
        return 0

    # 每个锚点的材料 = 锚点行 → 其后的第一个题号行（不含）
    hits = 0
    for idx, q in stems:
        if q.material_text and q.material_text.strip():
            continue
        if not _PRE_HINT.match((q.content or "").lstrip()):
            continue
        block = pre_material_for(lines, idx)
        if not block:
            continue
        q.material_text = block
        hits += 1
    return hits
