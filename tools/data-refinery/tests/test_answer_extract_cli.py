"""answer_extract_cli 单测：学科识别、文档渲染、与 answer_importer 的格式衔接。"""

from pathlib import Path

from answer_doc import parse_answer_doc
from answer_extract_cli import find_paper_md, main, render_answer_doc
from subject_strategies.types import ExtractedAnswer


def _answers():
    return [
        ExtractedAnswer(no=1, answer="C", explanation="（2 分）"),
        ExtractedAnswer(no=2, answer="示例：第一行\n第二行"),
        ExtractedAnswer(no=3, answer="", issues=["第 3 题答案段为空"]),
    ]


def test_render_doc_is_parseable_by_answer_importer():
    doc = render_answer_doc("2025 海淀 初三 模拟二", _answers())
    parsed = parse_answer_doc(doc)
    assert parsed.title == "2025 海淀 初三 模拟二"
    by_no = {it.no: it for it in parsed.items}
    assert by_no[1].answer == "C"
    assert by_no[1].explanation == "（2 分）"
    assert by_no[2].answer == "示例：第一行\n第二行"
    # 空答案题不写进文档（answer_doc 校验要求每题非空）
    assert 3 not in by_no


def test_render_doc_strips_markdown_heading_prefix_from_answer():
    doc = render_answer_doc("卷", [ExtractedAnswer(no=5, answer="## 评分参考\n正文")])
    parsed = parse_answer_doc(doc)
    assert parsed.items[0].answer == "评分参考\n正文"


def test_find_paper_md_unique_hit(tmp_path: Path):
    md = tmp_path / "语文/初中/second/2025/语文-初三(下)-202507-海淀-模拟二-试卷"
    md.mkdir(parents=True)
    f = md / "语文-初三(下)-202507-海淀-模拟二-试卷.md"
    f.write_text("# 卷", encoding="utf-8")
    assert find_paper_md(tmp_path, "语文/初中/second/2025") == f


def test_find_paper_md_ambiguous_returns_none(tmp_path: Path, capsys):
    for subj in ("语文", "数学"):
        d = tmp_path / subj / "初中/second/2025"
        d.mkdir(parents=True)
        (d / f"{subj}-初三(下)-202507-海淀-模拟二-试卷.md").write_text("# 卷", encoding="utf-8")
    assert find_paper_md(tmp_path, "202507-海淀") is None
    out = capsys.readouterr().err
    assert "命中 2 个文件" in out


ANSWER_MD_WITH_CROSS_PAGE_FOOTER = """# 海淀区2026年九年级

# 语文试卷答案及评分参考

## 一、基础·运用（共 13 分）

10.答案示例 1：先天下之忧而忧 后天下之乐而乐

答案示例 2：

安得广厦千万间 大庇天下寒士俱欢颜

（2分，每空 1 分。有错该空不得分）语文试卷答案及评分参考 第 1页（共 5页）

（二）（共 5 分）

11.答案：

①美酒佳肴

②自己渡河登山受阻

（2分，每空 1 分。有其他答法，视其合理程度给分）
"""


def test_main_strips_page_footer_from_cross_page_answer(tmp_path, capsys):
    """答案跨页页脚不能写进答案正文；评分说明仍进解析。"""
    md_dir = tmp_path / "md"
    paper_dir = md_dir / "语文/初中/second/2026/语文-初三(下)-202607-海淀-模拟二-答案"
    paper_dir.mkdir(parents=True)
    md = paper_dir / "语文-初三(下)-202607-海淀-模拟二-答案.md"
    md.write_text(ANSWER_MD_WITH_CROSS_PAGE_FOOTER, encoding="utf-8")

    out_doc = tmp_path / "answer.md"
    rc = main([
        "--file", "202607-海淀",
        "--input-dir", str(md_dir),
        "--output-dir", str(tmp_path / "out"),
        "--out", str(out_doc),
        "--subject", "chinese",
    ])
    assert rc == 0

    doc = parse_answer_doc(out_doc.read_text(encoding="utf-8"))
    by_no = {it.no: it for it in doc.items}
    assert "语文试卷答案及评分参考" not in by_no[10].answer
    assert "第1页" not in by_no[10].answer
    assert "有错该空不得分" in by_no[10].explanation
    assert "①美酒佳肴" in by_no[11].answer

    out = capsys.readouterr().out
    assert "[page-marker]" in out
    assert "删除 1 处页码/页眉标记" in out
