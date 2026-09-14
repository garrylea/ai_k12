"""语文默写管线：**纯程序**定位正文（不调用 LLM 判断起止）。

## 为什么不再用 LLM 定位（2026-09-14 用户裁决）

旧实现让 LLM 返回「正文首句/末句锚点」，程序再按锚点切。问题是**一次调用要给模型
一整个单元**（实测「第六单元」= 30 页 / 1.45 万字 / 一次找 13 篇），而 `llm.py` 又不传
`temperature`，于是同一份代码同一份输入连跑 3 次得 **23 / 22 / 20 篇**，每次漏的还不一样。
「哪些篇目、在第几页」本来就在目录里（`candidates.json`），正文起止又是**版面结构**
决定的——这些都不该问模型。

## 定位规则（全部来自实测的九上真实版面）

1. **标题行**：篇名在正文页里独立成行（`# 11 岳阳楼记 $^{①}$`）或**与作者同行**
   （`月夜忆舍弟 $^{①}$ 杜甫`、`咸阳城东楼 $^{①}$ 许浑`）。篇名写法与目录 label 常有出入
   （全半角括号、词牌与副题间的空格、目录带副题而正文只写词牌），故**两边都归一**再比。
2. **锚点页** = 印刷页 + 偏移。命中多处时只认**靠近该值**的那个：实测《十五从军征》
   在目录页（page_006）也会命中标题行，不筛就会把锚点定到目录上。
3. **正文起点**：从标题行往下走，跳过这些**非正文**块——
   - 空行；
   - **编者导语**：`## 预习` / `## 阅读提示` 标题行 + 紧随的那一段白话说明（实测 9 页有）；
   - **题解日期**：整行被括号包住的日期行（`(一九三六年二月)`）；
   - **作者行**：很短、且无任何句读标点（`张岱` / `范仲淹` / `《左传》`）；
   - **图片行**（`![` / `.jpg`）。
4. **正文终点**（取最先出现的）：下一个 `## ...` 编者栏目 / 下一篇的**标题行** /
   首个**注释式行**（与 `dictation_slice._PAGE_ANNOTATION_RE` 同判据）。

页范围上界卡在**下一个候选的锚点页 − 1**：相邻两篇常同页（`月夜忆舍弟` 与
`长沙过贾谊宅` 同在 page_072），不卡就会互相吃内容。

## 切不出来的情形（交调用方走 LLM 重写 + 人工过目）

有一类篇目的正文在书上**被编者说明与课后题逐行插花**——实测《沁园春·雪》：上半阙后插着
「1936年2月，毛主席率领红一方面军…写下了这首词。」这段写作背景，下半阙又被拆到下一页、
与「节奏」「领字」「押韵韵脚…」等课后题**逐行交错**。这类**任何连续子串都取不到正确正文**，
结构规则无能为力。

程序**不做猜**，改用**格律校验**把它确定性地暴露出来（`dictation_check` 的格律项）：
诗与词的字数有定数（绝句/律诗 20/28/40/56；词牌见 `CI_PATTERNS`），切错了字数就不对，
于是能判定「这一篇切不出来」并转交重写。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from pydantic import BaseModel, ValidationError

from extract import _parse_json_object
from llm import LLMClient

#: 一页之外最多再往后看的页数（实测单篇最长《出师表》跨 4 页）
MAX_SPAN_PAGES = 6

#: 编者导语标题：其后那一段是编者写的话，不是正文，跳过
_GUIDE_HEADINGS = ("预习", "阅读提示")

_MD_HEADING_RE = re.compile(r"^#{1,6}\s*")
_NUM_PREFIX_RE = re.compile(r"^\d+\*?\s*")
#: 行内注释角标（标题行常带 `$^{①}$`）
_TITLE_MARKER_RE = re.compile(r"\$\^\{[^}]*\}\$")
#: 注释式行（与 dictation_slice 的判据一致）
_ANNOTATION_LINE_RE = re.compile(r"^\s*(?:[①-⑳㉑-㉟㊱-㊿]|〔)|〔[^〕]*〕")
#: 整行被括号包住的题解日期：`(一九三六年二月)` / `（1936年2月）`
_DATE_PAREN_RE = re.compile(r"^\s*[（(][^）)]{2,20}[）)]\s*$")
#: 句读标点：正文行必有；作者行没有
_PUNCT_RE = re.compile(r"[，。！？；：、,\.!\?;:]")
_IMAGE_RE = re.compile(r"!\[|\.jpg|\.png")
#: 图注行：实测《过零丁洋》正文后紧跟一行 `《过零丁洋》(局部)毛泽东手书`
_CAPTION_RE = re.compile(r"[（(]局部[）)]|手书")
_WS_RE = re.compile(r"\s+")
#: 词牌副题分隔：`水调歌头(明月几时有)` -> `水调歌头`
_SUBTITLE_RE = re.compile(r"[（(·].*$")

#: 词牌 -> 正文字数（去标点）。只收本册实际出现的词牌，新增册次时补。取通行正体字数。
CI_PATTERNS: dict[str, int] = {
    "沁园春": 114,
    "水调歌头": 95,
    "浣溪沙": 42,
    "丑奴儿": 44,
    "采桑子": 44,
    "南乡子": 56,
    "破阵子": 62,
    "渔家傲": 62,
    "江城子": 70,
    "满江红": 93,
}

#: 体裁白名单（与 ai-core / check 一致）
_GENRES = ("shi", "ci", "qu", "wen", "other")


def norm_title(text: str) -> str:
    """篇名归一：去空白 + 全半角括号统一。

    目录 label 与正文写法常在这两点上不同：`行路难(其一)` vs `行路难（其一）`、
    `南乡子 · 登京口北固亭有怀` vs `南乡子·登京口北固亭有怀`。
    """
    return _WS_RE.sub("", text or "").replace("（", "(").replace("）", ")")


def ci_pattern_of(work_title: str) -> int | None:
    """取篇名对应词牌的正体字数；不是本表收录的词牌则返回 None。"""
    return CI_PATTERNS.get(_SUBTITLE_RE.sub("", norm_title(work_title)))


def _bare_title(line: str) -> str:
    """去掉 markdown 前缀、前导序号与角标，得到裸标题文本。"""
    s = _NUM_PREFIX_RE.sub("", _MD_HEADING_RE.sub("", line.strip()))
    return _TITLE_MARKER_RE.sub("", s).strip()


def _title_before_marker(line: str) -> str:
    """取**第一个角标之前**的部分——那是篇名本体。

    角标把标题行切成「篇名 + 作者」两段（`## 浣溪沙 $^{①}$ 秦观`、
    `月夜忆舍弟 $^{①}$ 杜甫`、`咸阳城东楼 $^{①}$ 许浑`），作者在角标**之后**。
    只取前半段比对，才能让「目录带副题、正文只写词牌」的篇目对上
    （`浣溪沙（漠漠轻寒上小楼）` ↔ 正文 `浣溪沙`）。
    """
    stripped = _NUM_PREFIX_RE.sub("", _MD_HEADING_RE.sub("", line.strip()))
    match = _TITLE_MARKER_RE.search(stripped)
    return (stripped[: match.start()] if match else stripped).strip()


def _title_line_index(lines: list[str], work_title: str) -> int | None:
    """在若干行里找该篇标题行，返回行号；找不到返回 None。

    比较时**两边都去掉副题**（`水调歌头(明月几时有)` → `水调歌头`），因为有三种
    实测写法必须都能对上：
    - 正文写全称：`# 11 岳阳楼记 $^{①}$`；
    - 目录带副题、正文只写词牌：`水调歌头(明月几时有)` ↔ 正文 `水调歌头$^{①}$`；
    - 作者与篇名同行（角标分界）：`月夜忆舍弟 $^{①}$ 杜甫`、`## 浣溪沙 $^{①}$ 秦观`。
    """
    target = _base_title(work_title)
    if not target:
        return None
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        seen = _base_title(_title_before_marker(line))
        if not seen:
            continue
        if seen == target:
            return index
        # 正文行常带角标且很短，前缀匹配要防误判：要求至少 3 字
        if len(seen) >= 3 and target.startswith(seen):
            return index
    return None


def _base_title(text: str) -> str:
    """归一 + 去掉副题，用于篇名比对。"""
    return _SUBTITLE_RE.sub("", norm_title(text))


def find_anchor_pages(work_title: str, pages: list[tuple[int, str]]) -> list[int]:
    """返回**所有**含该篇标题行的页号（按页序）。"""
    return [no for no, text in pages
            if _title_line_index(text.splitlines(), work_title) is not None]


def find_anchor_page(work_title: str, printed_page: int | None,
                     pages: list[tuple[int, str]], offset: int | None,
                     tolerance: int = 3) -> int | None:
    """找该篇标题行所在的 MD 页。

    `printed_page + offset` 是首选；命中多处时只认它附近 `tolerance` 页内的那个——
    实测《十五从军征》在目录页（page_006）也会命中标题行，不筛就会定到目录上。
    没有可靠偏移时退化为「离印刷页最近的那个」（仍好过第一个命中），
    再退化为「第一个命中」。
    """
    hits = find_anchor_pages(work_title, pages)
    if not hits:
        return None
    if printed_page is not None and offset is not None:
        expected = printed_page + offset
        near = [no for no in hits if abs(no - expected) <= tolerance]
        if near:
            return min(near, key=lambda no: abs(no - expected))
    if printed_page is not None:
        return min(hits, key=lambda no: abs(no - printed_page))
    return hits[0]


def _is_guide_heading(line: str) -> bool:
    """是否编者导语标题（`## 预习` / `## 阅读提示`）。"""
    if not _MD_HEADING_RE.match(line.strip()):
        return False
    bare = _bare_title(line)
    return any(bare == h or bare.startswith(h) for h in _GUIDE_HEADINGS)


def _is_section_heading(line: str) -> bool:
    """是否 `## ...` 编者栏目（正文终止符）。"""
    return bool(_MD_HEADING_RE.match(line.strip())) and not _is_guide_heading(line)


def _looks_like_other_title(line: str, other_titles: frozenset[str]) -> str | None:
    """本行是否像「下一篇的标题行」，是则返回那个篇名——同一页多篇时用来收住正文。

    **只认候选清单里真实存在的其它篇名**（归一后比对），不靠「短行 + 角标」这类猜测。
    曾用「带角标且 ≤12 字」当判据，实测被《十五从军征》的正文行
    `道逢乡里人，家中有阿 $^{②}$ 谁？`（去掉角标正好 12 字）误判成标题行，
    于是该篇正文只切出前两句 12 字。候选清单本来就在手上，用真名单最准。
    """
    stripped = line.strip()
    if not stripped or not other_titles:
        return None
    for title in other_titles:
        if _title_line_index([stripped], title) is not None:
            return title
    return None


def _find_body_start(lines: list[str], title_idx: int) -> tuple[int, list[str]] | None:
    """从标题行往下找正文第一行，返回 (行号, 留痕)。找不到返回 None。"""
    notes: list[str] = []
    i = title_idx + 1
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        if not stripped:
            i += 1
            continue
        if _IMAGE_RE.search(stripped):
            notes.append("跳过图片行")
            i += 1
            continue
        if _is_guide_heading(raw):
            heading = _bare_title(raw)
            i += 1
            while i < len(lines) and not lines[i].strip():     # 标题后的空行
                i += 1
            i = _skip_guide_body(lines, i)
            notes.append(f"跳过编者导语（{heading}）")
            continue
        if _DATE_PAREN_RE.match(stripped):
            notes.append(f"跳过题解日期（{stripped}）")
            i += 1
            continue
        if (not _PUNCT_RE.search(stripped) and len(norm_title(stripped)) <= 8
                and not _ANNOTATION_LINE_RE.match(raw)):
            notes.append(f"跳过作者行（{stripped}）")
            i += 1
            continue
        return i, notes
    return None


def _skip_guide_body(lines: list[str], i: int) -> int:
    """跳过编者导语的内容，返回正文应开始的行号。

    实测两种导语体例，都要处理（九上）：
    - **`## 预习` + 若干条 `◎` 提示**：条目以 `◎` 起行，条数不定——
      实测《醉翁亭记》《出师表》各 **2 条**，只跳一条会把第二条 `◎…` 当正文收进去
      （表现为正文以「◎读课文时…」开头）。
    - **`## 阅读提示` + 一段白话**：没有 `◎` 标记（实测 9 页），跳过**那一段**即可。
    """
    j = i
    # 先吃掉所有以 ◎/○ 起行的提示段（段间空行一并跨过）
    while j < len(lines):
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j < len(lines) and lines[j].lstrip().startswith(("◎", "○")):
            while j < len(lines) and lines[j].strip():
                j += 1
            continue
        break
    if j > i:
        return j
    # 没有 ◎ 条目 → 是「阅读提示」体例，跳过紧随的那一段白话
    while j < len(lines) and lines[j].strip():
        j += 1
    return j


def _find_body_end(lines: list[str], start: int,
                   other_titles: frozenset[str]) -> tuple[list[str], list[str]]:
    """从正文第一行往下扫到终止符，返回 (正文行, 留痕)。

    **图片行与「图注」行一律剔除、不终止**（图片绝不是正文）：实测《酬乐天…》诗后、
    《曹刿论战》正文后、《过零丁洋》正文后都跟着 `![](images/…jpg)`，
    且《过零丁洋》那行的图注 `《过零丁洋》(局部)毛泽东手书` 紧随其后；
    终止会让正文被截断，所以选择「跳过该行、继续收」。
    """
    notes: list[str] = []
    body: list[str] = []
    for i in range(start, len(lines)):
        raw = lines[i]
        stripped = raw.strip()
        if not stripped:
            body.append("")
            continue
        if _IMAGE_RE.search(stripped) or _CAPTION_RE.search(stripped):
            notes.append("剔除图片/图注行")
            continue
        # 先判「下一篇标题行」再判编者栏目：两者都可能是 `## ...`，
        # 但命中候选名单时说明是下一篇课文，报告里这样写更准确。
        hit = _looks_like_other_title(raw, other_titles)
        if hit is not None:
            notes.append(f"终止于下一篇标题行（{hit}）")
            break
        if _is_section_heading(raw):
            notes.append(f"终止于编者栏目（{_bare_title(raw)}）")
            break
        if _ANNOTATION_LINE_RE.match(raw):
            notes.append("终止于注释式行")
            break
        body.append(raw)
    while body and not body[-1].strip():
        body.pop()
    return body, notes


@dataclass
class LocatedBody:
    """一篇的正文定位结果（纯程序切出，未经 normalize）。"""

    work_title: str
    body: str
    start_page: int
    end_page: int
    notes: list[str] = field(default_factory=list)


def locate_body(work_title: str, printed_page: int | None,
                pages: list[tuple[int, str]], offset: int | None,
                next_anchor_page: int | None = None,
                other_titles: frozenset[str] = frozenset()) -> LocatedBody | None:
    """定位并切出**一篇**作品的正文（纯程序，不调用 LLM）。

    `pages` 为按页序排列的 `(页号, 已剥页眉并切掉注释块的文本)`。
    `other_titles` 为**其余候选的篇名集合**，用于在同页多篇时收住正文
    （见 `_looks_like_other_title`：用真名单，不猜）。
    页范围 = 锚点页 .. min(锚点页+MAX_SPAN_PAGES, 下一个候选锚点页)。
    """
    anchor = find_anchor_page(work_title, printed_page, pages, offset)
    if anchor is None:
        return None

    # 上界取「下一个候选的锚点页」**本身**（不是它 −1）：相邻两篇常同页或紧邻
    # （十五从军征锚点 157、白雪歌 158，正文跨在两页上），减 1 会把正文尾巴切掉
    # （实测十五从军征被截成只剩前两句 12 字）。收尾改由页内的终止符负责。
    hi = anchor + MAX_SPAN_PAGES
    if next_anchor_page is not None:
        hi = min(hi, max(next_anchor_page, anchor))

    lines: list[str] = []
    page_of: list[int] = []
    for no, text in pages:
        if anchor <= no <= hi:
            for line in text.splitlines():
                lines.append(line)
                page_of.append(no)
    if not lines:
        return None

    title_idx = _title_line_index(lines, work_title)
    if title_idx is None:
        return None
    found = _find_body_start(lines, title_idx)
    if found is None:
        return None
    start, notes = found

    body_lines, end_notes = _find_body_end(lines, start, other_titles)
    body = "\n".join(body_lines).strip()
    if not body:
        return None
    return LocatedBody(
        work_title=work_title,
        body=body,
        start_page=page_of[start],
        end_page=page_of[min(len(page_of) - 1, start + len(body_lines))],
        notes=notes + end_notes,
    )


#: 判定「这一行是编者白话」的字数门槛（去标点后）。实测诗文行都 ≤ 44 字
#: （词整首写一行时最长 44），而编者赏析段都 ≥ 119 字，分界很宽。
PROSE_LINE_MIN = 60

#: 近体诗常见字数（绝句/律诗）。用于诗类的收尾判断。
REGULATED_SHI_LENS = frozenset({20, 28, 40, 56})

_PUNCT_ONLY_RE = re.compile(r"[，。！？；：、（）《》〈〉“”‘’,\.!\?;:\s…—－·]")


def _char_count(text: str) -> int:
    """去标点与空白后的字数（**先删角标**，否则 `$^{②}$` 会被算进去）。"""
    return len(_PUNCT_ONLY_RE.sub("", _TITLE_MARKER_RE.sub("", text)))


def trim_to_form(body: str, work_title: str, genre: str) -> tuple[str, list[str]]:
    """按**格律**把尾部编者赏析（以及词前小序）切掉，返回 (正文, 留痕)。

    实测「课外古诗词诵读」的篇目，正文后面紧跟一段编者白话赏析，
    结构规则看不出边界（它不是注释、也不是下一个标题行），表现为
    《月夜忆舍弟》切出 205 字（正文只有 40 字）。格律能确定性地解决它：

    - **词**：字数有定数（`CI_PATTERNS`）。取长度恰好等于词牌字数的那个**连续行段**——
      这一步同时干掉**词前的编者小序**（《水调歌头》的「丙辰中秋…兼怀子由」）
      与词后的赏析。
    - **诗**：只要**尾部若干行是长白话行**（≥ `PROSE_LINE_MIN` 字）就丢掉；
      仅在「行普遍很短」（中位数 ≤ 20）时才做，避免误伤文言文那种整段长行。
      古体/乐府（《十五从军征》96、《白雪歌》144）尾部是诗句、不是白话，
      天然不受影响（它们的尾巴已被「下一篇标题行」收住）。

    切不出确定结果时**原样返回**，交给 `dictation_check` 的格律项去报错。
    """
    lines = [line for line in body.splitlines() if line.strip()]
    if not lines:
        return body, []

    if genre == "ci":
        pattern = ci_pattern_of(work_title)
        if pattern:
            # 找长度恰好等于词牌字数的连续行段（优先单项）
            for i in range(len(lines)):
                total = 0
                for j in range(i, len(lines)):
                    total += _char_count(lines[j])
                    if total == pattern:
                        if i == 0 and j == len(lines) - 1:
                            return body, []
                        notes = []
                        if i > 0:
                            notes.append(f"按词牌字数 {pattern} 切掉词前小序 {i} 行")
                        if j < len(lines) - 1:
                            notes.append(f"按词牌字数 {pattern} 切掉词后编者赏析 {len(lines) - 1 - j} 行")
                        return "\n".join(lines[i:j + 1]), notes
                    if total > pattern:
                        break
        return body, []

    if genre == "shi":
        counts = [_char_count(line) for line in lines]
        if len(lines) <= 1:
            return body, []
        short_lines = sorted(counts)
        median = short_lines[len(short_lines) // 2]
        if median > 20:                     # 整段长行 → 像文言文，不敢动
            return body, []
        cut = len(lines)
        while cut > 1 and _char_count(lines[cut - 1]) >= PROSE_LINE_MIN:
            cut -= 1
        if cut == len(lines):
            return body, []
        kept = sum(_char_count(line) for line in lines[:cut])
        if kept not in REGULATED_SHI_LENS:
            # 切完不是常见近体诗字数（古体诗）→ 宁可不切，交给自检报错
            return body, []
        return "\n".join(lines[:cut]), [f"切掉尾部编者赏析 {len(lines) - cut} 行（正文 {kept} 字）"]

    return body, []


class PieceIdentity(BaseModel):
    """一篇的作者/朝代/体裁——**这三个短字段由 LLM 提供**（用户 2026-09-14 裁决）。

    它们是事实性短字段、可人工核对；目录 label 里只有「篇名/作者」、**没有朝代**，
    交给模型补最省事。**模型不参与定位**：正文起止一律由上面的版面规则切。
    """

    author: str = ""
    dynasty: str = ""
    genre: str = "other"


def ask_identity(llm: LLMClient, work_title: str, prompt: str) -> PieceIdentity:
    """问一篇的作者/朝代/体裁。请求与响应都极小（输入只有篇名），失败由调用方兜住。"""
    response = llm.complete(
        prompt,
        f"【篇名】{work_title}\n\n请给出这篇作品的作者、朝代、体裁。",
    )
    data = _parse_json_object(response.content)
    if not isinstance(data, dict):
        return PieceIdentity()
    if data.get("genre") not in _GENRES:
        data = {**data, "genre": "other"}
    try:
        return PieceIdentity.model_validate(
            {k: v for k, v in data.items() if k in PieceIdentity.model_fields}
        )
    except ValidationError:
        return PieceIdentity()
