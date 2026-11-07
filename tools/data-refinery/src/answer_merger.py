"""答案合并/选择：根据内容（非文件名）判断每份文件是否含答案，决定合并或选择。

zgkao 命名反向：'试卷.pdf' 通常是有答案版，'答案.pdf' 通常是无答案版试卷。
文件名只用于配对（识别同一张卷子的两份文件），内容判断由 _has_answer_section/_is_pure_answer 做。
"""

import re
from pathlib import Path
from question_splitter import _find_option_marks, is_answer_keyword

_SOLUTION_RE = re.compile(r'解[：:]|证明[：:]')
# case 4a 合并纯答案时补的答案区标题（无标题的答案文件，见 maybe_merge_answer_md）
_ANSWER_SECTION_HEADER = "# 参考答案\n\n"
# 独立答案文件的强标题词：只在首屏出现、且整篇没有选择题选项序列时才算答案
_STRONG_ANSWER_MARKERS = ("参考答案", "答案及评分", "评分参考")
_HEAD_SCAN_LINES = 15


def _has_answer_section(text: str) -> bool:
    """文件是否含答案部分。

    判定（任一成立）：
    - 末尾 500 字符内有答案关键字（参考答案/答案/评分参考）——试卷+答案合订版；
    - 全文 '解：/证明：' 出现 ≥5 次（展开格式答案）；
    - 首屏有强答案标题（参考答案/答案及评分/评分参考）且全篇无选择题选项
      —— 独立答案文件（答案 PDF 转出的 md，标题在第 1 行，尾部判据看不到）。

    最后一条是 2026-11-07 补的：`海淀九年级语文（上）期中语文试题_答案.pdf`
    这类「试卷与答案分两个文件」的答案 md，标题就在开头，旧实现只看尾部
    → 判成「无答案」，配对成功后仍被当普通试卷丢弃。
    """
    tail = text[-500:] if len(text) > 500 else text
    if any(is_answer_keyword(line) for line in tail.split('\n')):
        return True
    if len(_SOLUTION_RE.findall(text)) >= 5:
        return True
    head = "\n".join(text.splitlines()[:_HEAD_SCAN_LINES])
    return (
        any(marker in head for marker in _STRONG_ANSWER_MARKERS)
        and _find_option_marks(text) is None
    )


def _is_pure_answer(text: str) -> bool:
    """文件是否为纯答案（无题干）。

    纯答案 = 有答案部分 且 不含完整的选择题选项序列。

    「有题干」的判据是**连续 A,B,C,D 选项标记**（复用 question_splitter 的
    选项探测器 `_find_option_marks`），而不是「出现过任意一个 (A) 括号」——
    后者会被解析正文里的概率记号误命中（`\\therefore P (A) = \\frac{8}{12}`）；
    同理也不用「如图/下列」关键词：解析正文里的「如图所示」「如图，连接 OC」
    同样会误命中。误判会让纯答案被当成「试卷+答案版」，走 case 4b 丢弃真试卷
    （2026-09-12 修，海淀/朝阳/西城 三份真实答案文件）。
    """
    if not _has_answer_section(text):
        return False
    if _find_option_marks(text) is not None:
        return False
    return True


def _answer_name_variants(name: str) -> list[str]:
    """同一素材「答案」侧的文件名 / 目录名候选（保序去重，**不含原名**）。

    爬虫命名固定用 `-试卷` / `-答案`；手工丢进 crawler/data 的卷子常见
    `X.pdf` + `X_答案.pdf`、`X答案.pdf`（2026-11-07 海淀九年级语文期中）。
    名字只用于配对，含不含答案仍由内容判定（见 _has_answer_section）。
    """
    path = Path(name)
    suffix = path.suffix
    stem = path.stem if suffix else name
    out: list[str] = []
    if "-试卷" in stem:
        out.append(stem.replace("-试卷", "-答案") + suffix)
    for mark in ("-答案", "_答案", "（答案）", "(答案)", "答案"):
        out.append(f"{stem}{mark}{suffix}")
    seen = {name}
    variants: list[str] = []
    for cand in out:
        if cand not in seen:
            seen.add(cand)
            variants.append(cand)
    return variants


def is_answer_pair(paper_md: Path, answer_md: Path) -> bool:
    """这两个 md 素材路径是否是「一份试卷 + 它的答案文件」配对。

    只比 path 的父子/名字（不读内容），供 import_cli 把「试卷+答案」两个命中
    收敛成一份处理：两份 PDF 一起导入时，按卷名搜索必然同时命中两份。
    """
    return (
        paper_md.parent == answer_md.parent
        and answer_md.name in _answer_name_variants(paper_md.name)
    )


def _derive_answer_path(md_path: Path) -> Path:
    """配对答案 md 路径（只用于配对，不判断内容）。

    三种布局都要支持：
    - 同名换后缀：`X-试卷.md` → `X-答案.md`；`X.md` → `X_答案.md`；
    - 同目录：答案 md 与试卷 md 平铺在同一目录；
    - 兄弟目录：convert 对每个 PDF 生成同名子目录（'X-试卷/X-试卷.md' 与
      'X-答案/X-答案.md'；手工素材则是 'X/X.md' 与 'X_答案/X_答案.md'）。

    回归：旧实现只做 `-试卷`→`-答案` 替换。文件名不含「-试卷」时替换是空操作，
    返回值就是试卷自身 → 合并逻辑拿试卷和它自己比，答案静默丢弃
    （海淀九年级语文期中 2026，27 题全空答案）。
    """
    candidates: list[Path] = [
        md_path.with_name(name) for name in _answer_name_variants(md_path.name)
    ]
    for dir_name in _answer_name_variants(md_path.parent.name):
        answer_dir = md_path.parent.with_name(dir_name)
        # 目录换了后缀时，文件名可能与试卷同名（'X_答案/X.md'），也可能同样带后缀
        for name in [md_path.name, *_answer_name_variants(md_path.name)]:
            candidates.append(answer_dir / name)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return candidates[0] if candidates else md_path


def maybe_merge_answer_md(md_path: Path, text: str) -> str:
    """根据两份文件的内容组合，决定合并或选择。

    Args:
        md_path: 试卷 MD 路径（用于配对答案文件）
        text: 试卷 MD 全文

    Returns:
        最终用于 split_page 处理的文本（可能来自试卷文件、答案文件、或合并）
    """
    answer_path = _derive_answer_path(md_path)

    # case 1: 只有一份文件（配对不到，或配到自己）
    if answer_path == md_path or not answer_path.exists():
        return text

    answer_text = answer_path.read_text(encoding="utf-8")
    paper_has = _has_answer_section(text)
    answer_has = _has_answer_section(answer_text)

    # case 2: 两份都有答案 → 留试卷文件，丢弃答案文件
    if paper_has and answer_has:
        return text

    # case 3: 试卷有答案 + 答案文件无答案（纯题干）→ 留试卷，丢弃答案
    if paper_has and not answer_has:
        return text

    # case 4: 试卷无答案 + 答案文件有答案
    if not paper_has and answer_has:
        if _is_pure_answer(answer_text):
            # case 4a: 答案是纯答案 → 合并到试卷末尾。
            # split_page 只在「参考答案/答案及评分/评分参考」关键字处进入答案区
            # （question_splitter._ANSWER_KEYWORD_RE），而 _has_answer_section 还会用
            # 「≥5 次解：」认答案区——两者口径不同。答案文件没有这类标题时
            # （海淀202507：直接 '## 一、选择题' + 答案表），不补标题的话合并结果会被
            # 当成更多题干（题号重复、答案全空）。补一个规范化答案区标题对齐口径。
            if not any(is_answer_keyword(line) for line in answer_text.split("\n")):
                answer_text = _ANSWER_SECTION_HEADER + answer_text
            return text + "\n\n" + answer_text
        # case 4b: 答案是试卷+答案版本 → 用答案文件（它有完整题干+答案），丢弃试卷
        return answer_text

    # case 5: 两份都无答案 → 处理试卷文件（答案留空，做题时大模型补）
    return text
