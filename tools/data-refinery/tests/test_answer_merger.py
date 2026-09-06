import re
from pathlib import Path
from answer_merger import (
    maybe_merge_answer_md, _has_answer_section, _is_pure_answer,
    _derive_answer_path,
)


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
    """有答案但有选择题选项 → 是试卷+答案版本，非纯答案"""
    text = "1. 题干 (A) ... (B) ...\n17. 解：答案\n18. 解：答案\n19. 解：答案\n20. 解：答案\n21. 解：答案\n22. 解：答案"
    assert not _is_pure_answer(text)


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
    """case 4b: 试卷无答案 + 答案是试卷+答案版本 → 用答案文件，丢弃试卷"""
    paper = tmp_path / "数学-某地-模拟二-试卷.md"
    answer = tmp_path / "数学-某地-模拟二-答案.md"
    paper_text = "1. 题干\n2. 题干\n3. 题干"
    paper.write_text(paper_text, encoding="utf-8")
    # 答案是试卷+答案版本：有题干 + 有答案部分
    answer_text = "1. 题干 (A)...\n# 参考答案\n17. 解：答案\n18. 解：答案\n19. 解：答案\n20. 解：答案\n21. 解：答案\n22. 解：答案"
    answer.write_text(answer_text, encoding="utf-8")
    result = maybe_merge_answer_md(paper, paper_text)
    assert result == answer_text  # 用答案文件
    assert "1. 题干 (A)" in result
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
