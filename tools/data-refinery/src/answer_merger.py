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


def _has_answer_section(text: str) -> bool:
    """文件是否含答案部分。

    判定：末尾 500 字符内有答案关键字（参考答案/答案/评分参考），
    或全文 '解：/证明：' 出现 ≥5 次（展开格式答案）。
    """
    tail = text[-500:] if len(text) > 500 else text
    if any(is_answer_keyword(line) for line in tail.split('\n')):
        return True
    return len(_SOLUTION_RE.findall(text)) >= 5


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


def _derive_answer_path(md_path: Path) -> Path:
    """配对答案 md 路径（只用于配对，不判断内容）。

    两种布局都要支持（2026-09-12 修第二种子目录布局）：
    - 同目录：文件名 '-试卷' 替换为 '-答案'
    - 兄弟目录：convert 对每个 PDF 生成同名子目录，试卷与答案 PDF 各自成目录
      （'X-试卷/X-试卷.md' 与 'X-答案/X-答案.md'）。旧实现只用 `with_name`
      （只换文件名、父目录不变），永远找不到兄弟目录里的答案 md，
      导致答案静默丢弃。
    """
    same_dir = md_path.with_name(md_path.name.replace("-试卷", "-答案"))
    if same_dir.exists():
        return same_dir
    parent = md_path.parent
    if parent.name.endswith("-试卷"):
        answer_dir = parent.with_name(parent.name.replace("-试卷", "-答案"))
        sibling = answer_dir / md_path.name.replace("-试卷", "-答案")
        if sibling.exists():
            return sibling
    return same_dir


def maybe_merge_answer_md(md_path: Path, text: str) -> str:
    """根据两份文件的内容组合，决定合并或选择。

    Args:
        md_path: 试卷 MD 路径（用于配对答案文件）
        text: 试卷 MD 全文

    Returns:
        最终用于 split_page 处理的文本（可能来自试卷文件、答案文件、或合并）
    """
    answer_path = _derive_answer_path(md_path)

    # case 1: 只有一份文件
    if not answer_path.exists():
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
