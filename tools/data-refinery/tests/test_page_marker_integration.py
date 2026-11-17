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
    assert "删除 2 处页码标记" in out
