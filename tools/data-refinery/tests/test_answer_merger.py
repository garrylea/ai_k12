from pathlib import Path
from answer_merger import maybe_merge_answer_md


def test_text_has_answer_keyword_no_merge(tmp_path):
    """text 末尾含'参考答案'关键字，不合并，原样返回。"""
    text = "9. 题干\n参考答案\n9. 答案"
    result = maybe_merge_answer_md(tmp_path / "试卷.md", text)
    assert result == text


def test_no_answer_md_file_returns_original(tmp_path):
    """text 无答案关键字，且找不到答案 MD，原样返回。"""
    paper = tmp_path / "数学-初三(下)-202607-西城-模拟二-试卷.md"
    paper.write_text("9. 题干", encoding="utf-8")
    result = maybe_merge_answer_md(paper, "9. 题干")
    assert result == "9. 题干"


def test_answer_md_merged_when_no_answer_in_paper(tmp_path):
    """text 无答案关键字，找到同名答案 MD，内容合并到末尾。"""
    paper = tmp_path / "数学-初三(下)-202607-西城-模拟二-试卷.md"
    answer = tmp_path / "数学-初三(下)-202607-西城-模拟二-答案.md"
    paper.write_text("9. 题干", encoding="utf-8")
    answer.write_text("参考答案\n9. 答案", encoding="utf-8")
    result = maybe_merge_answer_md(paper, "9. 题干")
    assert "9. 题干" in result
    assert "参考答案" in result
    assert "9. 答案" in result
