"""主提取链路接入页码清洗的集成测试。"""

import json
from pathlib import Path
from types import SimpleNamespace

import question_extract

PAPER_MD = """一、选择题（共16分，每题2分）

1. 下列各数中，最小的数是

A. 1

B. 2

C. 3

D. 4

第5页（共8页）

2. 下列计算正确的是

A. 1+1=2

B. 2+2=4

C. 3+3=6

D. 4+4=8

共6页

3. 若 $x=1$，则 $x+1$ 的值是

A. 1

B. 2

C. 3

D. 4
"""


def _fake_response(content: str):
    return type("R", (), {"content": content, "prompt_tokens": 0, "completion_tokens": 0})()


def _fake_llm():
    class FakeLLM:
        def complete(self, system, user):
            return _fake_response(
                '{"type":"choice","difficulty":2,'
                '"knowledge_points":["M0101"],"suggested_new_kps":[],'
                '"completeness":{"is_complete":true,"issues":[]}}'
            )

    return FakeLLM()


def _source(md_path: Path):
    return SimpleNamespace(
        md_path=md_path,
        rel_path=Path("数学/初中/second/2025"),
        kind="questions",
    )


def test_extract_questions_file_strips_page_markers(tmp_path, monkeypatch, capsys):
    md_path = tmp_path / "数学-初三(下)-202507-海淀-模拟二-试卷.md"
    md_path.write_text(PAPER_MD, encoding="utf-8")

    monkeypatch.setattr(
        question_extract,
        "_query_knowledge_points",
        lambda config, subject_code: [{"code": "M0101", "name": "有理数的概念与分类"}],
    )

    count = question_extract.extract_questions_file(
        _source(md_path), SimpleNamespace(), _fake_llm(), None,
        tmp_path / "extracted", label_batch_size=1,
    )
    assert count == 3

    jsonl = (
        tmp_path / "extracted" / "数学/初中/second/2025"
        / f"{md_path.name[:-3]}.jsonl"
    )
    items = [
        json.loads(line)
        for line in jsonl.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    by_no = {item["group_order"]: item for item in items}

    assert "第5页" not in by_no[1]["content"]
    assert "共6页" not in by_no[2]["content"]
    assert "x+1" in by_no[3]["content"]
    assert "第5页" not in json.dumps(items, ensure_ascii=False)
    assert "共6页" not in json.dumps(items, ensure_ascii=False)

    out = capsys.readouterr().out
    assert "[page-marker]" in out
    assert "删除 2 处页码/页眉标记" in out


def test_preview_split_questions_strips_markers_without_llm(tmp_path):
    """--dry-run 预览必须与正式提取同口径：先洗页脚，再切题，且不调 LLM。"""
    md_path = tmp_path / "数学-初三(下)-202507-海淀-模拟二-试卷.md"
    md_path.write_text(PAPER_MD, encoding="utf-8")

    questions, _strategy = question_extract.preview_split_questions(_source(md_path))

    assert [q.group_order for q in questions] == [1, 2, 3]
    dumped = json.dumps([q.content for q in questions], ensure_ascii=False)
    assert "第5页" not in dumped and "共6页" not in dumped
    assert "x+1" in questions[2].content


def test_extract_cli_preview_prints_each_question(tmp_path, capsys):
    """--preview 的展示层：单卷打逐题摘要，题干里不能带页脚。"""
    from extract_cli import _print_split_preview

    md_path = tmp_path / "数学-初三(下)-202507-海淀-模拟二-试卷.md"
    md_path.write_text(PAPER_MD, encoding="utf-8")

    _print_split_preview(_source(md_path), detailed=True)
    out = capsys.readouterr().out

    assert "[split] 共 3 题" in out
    assert "选4" in out and "答：—" in out
    assert "第5页" not in out and "共6页" not in out


def test_extract_cli_preview_batch_only_counts(tmp_path, capsys):
    from extract_cli import _print_split_preview

    md_path = tmp_path / "数学-初三(下)-202507-海淀-模拟二-试卷.md"
    md_path.write_text(PAPER_MD, encoding="utf-8")

    _print_split_preview(_source(md_path), detailed=False)
    out = capsys.readouterr().out

    assert "[split] 共 3 题" in out
    assert "逐题明细需 --file 指定单卷" in out


def test_preview_text_head_tail_and_image_placeholder():
    from extract_cli import _preview_text

    body = "开头" * 30 + "结尾十个字结尾十个"
    out = _preview_text(body, head=40, tail=10)
    assert len(out) == 40 + 1 + 10
    assert out.endswith("结尾十个字结尾十个")

    with_img = "![](images/x.jpg)" + "文字" * 30 + "收尾十个字符收尾十个"
    out2 = _preview_text(with_img, head=40, tail=10)
    assert "[图片]" in out2
    assert "images" not in out2
    assert len(out2) == 40 + 1 + 10


PAPER_WITH_ANSWERS = """1. 题干一
A. 甲
B. 乙
C. 丙
D. 丁

2. 题干二
A. 甲
B. 乙
C. 丙
D. 丁

# 数学答案

<table><tr><td>题号</td><td>1</td><td>2</td></tr><tr><td>答案</td><td>D</td><td>A</td></tr></table>
"""


def test_preview_shows_answer_column(tmp_path, capsys):
    from extract_cli import _print_split_preview

    md_path = tmp_path / "35中数学.md"
    md_path.write_text(PAPER_WITH_ANSWERS, encoding="utf-8")

    _print_split_preview(_source(md_path), detailed=True)
    out = capsys.readouterr().out

    assert "答：D" in out
    assert "答：A" in out
