import re
from pathlib import Path
from answer_merger import (
    maybe_merge_answer_md, _has_answer_section, _is_pure_answer,
    _derive_answer_path,
)
from question_splitter import split_page


# === content judgment functions ===

def test_has_answer_section_by_keyword():
    text = "题干...\n# 数学试卷参考答案\n17. 解: ..."
    assert _has_answer_section(text)


def test_has_answer_section_by_many_solutions():
    """无'参考答案'关键字但有 6 次'解：' → True"""
    text = "\n".join(f"{i}. 解：答案 {i}" for i in range(1, 7))
    assert _has_answer_section(text)


def test_has_answer_section_false_pure_question():
    """纯题干（无关键字、少'解：'）→ False"""
    text = "# 数学试卷\n1. 下面图形中...\n(A) ... (B) ...\n2. 近日...\n27. 如图..."
    assert not _has_answer_section(text)


def test_is_pure_answer_true():
    """纯答案：有'解：'多 + 无选择题选项 + 无题干词"""
    text = "\n".join(f"{i}. 解：解答 {i}" for i in range(1, 7))
    assert _is_pure_answer(text)


def test_is_pure_answer_false_has_options():
    """有答案但有完整选择题选项（A-D 连续）→ 是试卷+答案版本，非纯答案"""
    text = (
        "1. 下面图形中，既是轴对称图形的是 (A) 甲 (B) 乙 (C) 丙 (D) 丁\n"
        "17. 解：答案\n18. 解：答案\n19. 解：答案\n20. 解：答案\n21. 解：答案\n22. 解：答案"
    )
    assert not _is_pure_answer(text)


def test_is_pure_answer_true_with_math_notation_and_explanations():
    """真实海淀202507答案：解析里含概率记号 'P (A)' 与'如图'，仍是纯答案。

    回归：旧实现用 `\\([A-D]\\)` 与「如图」关键词判非纯答案，被解析正文里的
    `\\therefore P (A) = ...` 和「如图所示」「如图，连接 OC」误命中，
    导致纯答案被当成试卷+答案版（走 case 4b 丢弃真试卷）。
    """
    text = (
        "## 一、选择题（共16分，每题2分）\n"
        "<table><tr><td>题号</td><td>1</td><td>2</td></tr>"
        "<tr><td>答案</td><td>B</td><td>A</td></tr></table>\n"
        "## 二、填空题（共16分，每题2分）\n"
        "9. (4,-1) 10. 4\n"
        "## 三、解答题（共68分）\n"
        "17. 解：如图所示，连接 OC.\n"
        "$\\therefore P (A) = \\frac{8}{12} = \\frac{2}{3}.$\n"
        "18. 解：$\\because$ 如图，$\\therefore x = 2$.\n"
        "19. 解：作图略\n20. 解：略\n21. 解：略\n"
    )
    assert _is_pure_answer(text)


# === 5 cases ===

def test_case1_single_file(tmp_path):
    """case 1: 只有一份文件 → 原样返回"""
    paper = tmp_path / "数学-西城-模拟二-试卷.md"
    paper.write_text("1. 题干\n# 参考答案\n17. 解: ...", encoding="utf-8")
    result = maybe_merge_answer_md(paper, "1. 题干\n# 参考答案\n17. 解: ...")
    assert result == "1. 题干\n# 参考答案\n17. 解: ..."


def test_case2_both_have_answer(tmp_path):
    """case 2: 两份都有答案 → 留试卷，丢弃答案"""
    paper = tmp_path / "数学-丰台-模拟二-试卷.md"
    answer = tmp_path / "数学-丰台-模拟二-答案.md"
    paper_text = "题干\n# 参考答案\n17. 解: ..."
    answer_text = "题干\n# 参考答案\n17. 解: ..."
    paper.write_text(paper_text, encoding="utf-8")
    answer.write_text(answer_text, encoding="utf-8")
    result = maybe_merge_answer_md(paper, paper_text)
    assert result == paper_text


def test_case3_paper_has_answer_answer_is_pure_question(tmp_path):
    """case 3: 试卷有答案 + 答案是纯题干 → 留试卷，丢弃答案"""
    paper = tmp_path / "数学-丰台-模拟二-试卷.md"
    answer = tmp_path / "数学-丰台-模拟二-答案.md"
    paper_text = "1. 题干\n# 参考答案\n17. 解: ..."
    # 答案是无答案版试卷（纯题干，少解：）
    answer_text = "# 数学试卷\n1. 题干 (A)...\n2. 题干\n27. 如图..."
    paper.write_text(paper_text, encoding="utf-8")
    answer.write_text(answer_text, encoding="utf-8")
    result = maybe_merge_answer_md(paper, paper_text)
    assert result == paper_text


def test_case4a_pure_answer_merged(tmp_path):
    """case 4a: 试卷无答案 + 答案是纯答案 → 合并"""
    paper = tmp_path / "数学-某地-模拟二-试卷.md"
    answer = tmp_path / "数学-某地-模拟二-答案.md"
    paper_text = "1. 题干\n2. 题干\n3. 题干"
    paper.write_text(paper_text, encoding="utf-8")
    # 纯答案：6 次解：，无选项无题干词
    answer_text = "\n".join(f"{i}. 解：答案 {i}" for i in range(1, 7))
    answer.write_text(answer_text, encoding="utf-8")
    result = maybe_merge_answer_md(paper, paper_text)
    assert "1. 题干" in result
    assert "1. 解：答案 1" in result
    assert "6. 解：答案 6" in result


def test_case4b_answer_is_paper_plus_answer_version(tmp_path):
    """case 4b: 试卷无答案 + 答案是试卷+答案版本 → 用答案文件，丢弃试卷。

    「试卷+答案版」的判据是含**完整的选择题选项序列**（连续 A-D，同真实数据
    海淀202607 的答案文件）。旧 fixture 只放一个 `(A)` 就断言 4b，会被解析正文里的
    概率记号 `P (A)` 之类误命中——那正是本次修掉的 bug。
    """
    paper = tmp_path / "数学-某地-模拟二-试卷.md"
    answer = tmp_path / "数学-某地-模拟二-答案.md"
    paper_text = "1. 题干\n2. 题干\n3. 题干"
    paper.write_text(paper_text, encoding="utf-8")
    # 答案是试卷+答案版本：含完整选择题选项（题干）+ 答案部分
    answer_text = (
        "1. 下面图形中，既是轴对称图形的是 (A) 甲 (B) 乙 (C) 丙 (D) 丁\n"
        "2. 在平面直角坐标系中 (A) 1 (B) 2 (C) 3 (D) 4\n"
        "# 参考答案\n17. 解：答案\n18. 解：答案\n19. 解：答案\n20. 解：答案\n21. 解：答案\n22. 解：答案"
    )
    answer.write_text(answer_text, encoding="utf-8")
    result = maybe_merge_answer_md(paper, paper_text)
    assert result == answer_text  # 用答案文件
    assert "1. 下面图形中" in result
    assert "17. 解：答案" in result


def test_case5_both_no_answer(tmp_path):
    """case 5: 两份都无答案 → 处理试卷文件（答案留空）"""
    paper = tmp_path / "数学-某地-模拟二-试卷.md"
    answer = tmp_path / "数学-某地-模拟二-答案.md"
    paper_text = "1. 题干\n2. 题干"
    answer_text = "1. 题干\n2. 题干"
    paper.write_text(paper_text, encoding="utf-8")
    answer.write_text(answer_text, encoding="utf-8")
    result = maybe_merge_answer_md(paper, paper_text)
    assert result == paper_text


def test_derive_answer_path():
    paper = Path("/tmp/数学-初三(下)-202607-丰台-模拟二-试卷.md")
    assert _derive_answer_path(paper).name == "数学-初三(下)-202607-丰台-模拟二-答案.md"


def test_derive_answer_path_in_sibling_answer_dir(tmp_path):
    """convert 把每个 PDF 转成同名子目录（'X-试卷/X-试卷.md' + 'X-答案/X-答案.md'），
    配对必须跨兄弟目录找到答案 md。

    回归：旧实现 `md_path.with_name(...)` 只换文件名、父目录不变，只会去
    `...-试卷/` 里找 `...-答案.md` → 永远找不到 → 答案静默丢弃。
    """
    stem = "数学-初三(上)-202507-海淀-（上）期末考"
    paper_dir = tmp_path / f"{stem}-试卷"
    answer_dir = tmp_path / f"{stem}-答案"
    paper_dir.mkdir()
    answer_dir.mkdir()
    paper = paper_dir / f"{stem}-试卷.md"
    paper.write_text("1. 题干", encoding="utf-8")
    answer = answer_dir / f"{stem}-答案.md"
    answer.write_text("17. 解：答案", encoding="utf-8")

    assert _derive_answer_path(paper) == answer


def test_case4a_sibling_answer_dir_merged(tmp_path):
    """端到端：答案 md 在兄弟目录时，纯答案应合并进试卷（case 4a）。"""
    stem = "数学-初三(上)-202507-海淀-（上）期末考"
    paper_dir = tmp_path / f"{stem}-试卷"
    answer_dir = tmp_path / f"{stem}-答案"
    paper_dir.mkdir()
    answer_dir.mkdir()
    paper_text = "1. 题干一\n2. 题干二\n3. 题干三"
    answer_text = "\n".join(f"{i}. 解：答案 {i}" for i in range(17, 23))
    paper = paper_dir / f"{stem}-试卷.md"
    paper.write_text(paper_text, encoding="utf-8")
    (answer_dir / f"{stem}-答案.md").write_text(answer_text, encoding="utf-8")

    result = maybe_merge_answer_md(paper, paper_text)
    assert "1. 题干一" in result
    assert "17. 解：答案 17" in result
    assert "22. 解：答案 22" in result


def test_case4a_merged_text_aligns_answers_without_keyword_title(tmp_path):
    """答案文件没有「参考答案」标题时（海淀202507 真实格式：直接
    `## 一、选择题` + 答案表），合并后仍必须能被 split_page 识别为答案区并对齐。

    回归：`_has_answer_section` 靠「≥5 次解：」就认定有答案区，但 split_page 只认
    「参考答案/答案及评分/评分参考」关键字进入答案模式。不补答案区标题时，合并的
    答案会被当成更多题干（题号重复、答案全空）。
    """
    stem = "数学-初三(上)-202507-海淀-（上）期末考"
    paper_dir = tmp_path / f"{stem}-试卷"
    answer_dir = tmp_path / f"{stem}-答案"
    paper_dir.mkdir()
    answer_dir.mkdir()
    paper_text = (
        "## 一、选择题（共16分，每题2分）\n"
        "1. 第一题 (A) 甲 (B) 乙 (C) 丙 (D) 丁\n"
        "2. 第二题"
    )
    answer_text = (
        "## 一、选择题（共16分，每题2分）\n"
        "<table><tr><td>题号</td><td>1</td><td>2</td></tr>"
        "<tr><td>答案</td><td>B</td><td>A</td></tr></table>\n"
        "17. 解：过程\n18. 解：过程\n19. 解：过程\n20. 解：过程\n21. 解：过程"
    )
    paper = paper_dir / f"{stem}-试卷.md"
    paper.write_text(paper_text, encoding="utf-8")
    (answer_dir / f"{stem}-答案.md").write_text(answer_text, encoding="utf-8")

    merged = maybe_merge_answer_md(paper, paper_text)
    by_no = {q.group_order: q for q in split_page(merged, paper)}
    assert by_no[1].answer == "B"
    assert by_no[2].answer == "A"


def test_real_fengtai_case3(tmp_path):
    """真实丰台数据：试卷有'参考答案'关键字 + 答案是无答案版试卷 → case 3，留试卷"""
    paper_text = (
        "1. 选择题题干 (A) ... (B) ...\n...\n"
        "# 丰台区2025年九年级学业水平考试综合练习（二）数学试卷参考答案\n"
        "17. 解: 计算...\n18. 解: ...\n19. 解: ...\n20. 解: ...\n21. 解: ...\n22. 解: ..."
    )
    answer_text = (
        "# 数学试卷\n2026.05\n"
        "1. 下面图形中，既是轴对称...\n(A) ...\n(B) ...\n"
        "2. 近日, 中国科学技术大学...\n"
        "27. 如图, 在 △ABC 中...\n28. 在平面直角坐标系..."
    )
    paper = tmp_path / "数学-初三(下)-202607-丰台-模拟二-试卷.md"
    answer = tmp_path / "数学-初三(下)-202607-丰台-模拟二-答案.md"
    paper.write_text(paper_text, encoding="utf-8")
    answer.write_text(answer_text, encoding="utf-8")
    result = maybe_merge_answer_md(paper, paper_text)
    assert result == paper_text  # 丰台 case 3：留试卷文件
    assert "# 数学试卷" not in result  # 答案文件被丢弃
