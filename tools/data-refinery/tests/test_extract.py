import json
from pathlib import Path
from unittest.mock import MagicMock

from extract import Extractor, _parse_json_object, repair_malformed_html
from models import ExamQuestion, TextbookCard


class TestExtractor:
    def test_extracts_questions(self, tmp_path):
        md_path = tmp_path / "试卷.md"
        md_path.write_text("# 试卷\n1. 1+1=? A.1 B.2", encoding="utf-8")

        mock_llm = MagicMock()
        mock_llm.complete.return_value = MagicMock(
            content=json.dumps({
                "items": [{
                    "subject_id": "math",
                    "type": "choice",
                    "difficulty": 1,
                    "content": "1+1=?",
                    "options": [{"label": "A", "text": "1"}, {"label": "B", "text": "2"}],
                    "answer": "B",
                }]
            }),
            prompt_tokens=100,
            completion_tokens=50,
        )

        extractor = Extractor(llm=mock_llm, prompt="system", kind="questions")
        result = extractor.run(md_path)

        assert len(result.items) == 1
        assert isinstance(result.items[0], ExamQuestion)
        assert result.items[0].answer == "B"
        assert result.prompt_tokens == 100
        assert result.completion_tokens == 50

    def test_extracts_cards(self, tmp_path):
        md_path = tmp_path / "教材.md"
        md_path.write_text("# 二次根式\n形如...", encoding="utf-8")

        mock_llm = MagicMock()
        mock_llm.complete.return_value = MagicMock(
            content=json.dumps({
                "items": [{
                    "sort_order": 1,
                    "card_type": "concept",
                    "lesson_id": "1.1 二次根式",
                    "content": "二次根式的概念",
                }]
            }),
            prompt_tokens=80,
            completion_tokens=40,
        )

        extractor = Extractor(llm=mock_llm, prompt="system", kind="cards")
        result = extractor.run(md_path)

        assert len(result.items) == 1
        assert isinstance(result.items[0], TextbookCard)
        assert result.items[0].card_type == "concept"
        assert result.items[0].lesson_id == "1.1 二次根式"

    def test_skips_items_with_null_or_empty_content(self, tmp_path):
        # LLM 偶发返回 content=null/"" 的卡片（如纯图片片段），应跳过而非整页失败
        md_path = tmp_path / "教材.md"
        md_path.write_text("# 教材\n形如...", encoding="utf-8")
        mock_llm = MagicMock()
        mock_llm.complete.return_value = MagicMock(
            content=json.dumps({"items": [
                {"sort_order": 1, "card_type": "concept", "content": "有效内容",
                 "lesson_id": "26.1 反比例函数"},
                {"sort_order": 2, "card_type": "concept", "content": None,
                 "lesson_id": "26.1 反比例函数"},
                {"sort_order": 3, "card_type": "example", "content": "", "lesson_id": None},
            ]}),
            prompt_tokens=10, completion_tokens=5,
        )
        extractor = Extractor(llm=mock_llm, prompt="system", kind="cards")
        result = extractor.run(md_path)
        assert len(result.items) == 1
        assert result.items[0].content == "有效内容"


class TestParseJSONObject:
    """本地模型输出兼容性：代码块包裹、LaTeX 反斜杠漏转义。"""

    def test_clean_json(self):
        out = _parse_json_object('{"items": [{"a": 1}]}')
        assert out == {"items": [{"a": 1}]}

    def test_strips_code_fence(self):
        out = _parse_json_object('```json\n{"items": []}\n```')
        assert out == {"items": []}

    def test_repairs_unescaped_latex_backslashes(self):
        # 模型漏转义：\_ 与 \%（单反斜杠），合法转义 \n 须保留
        raw = '{"items": [{"content": "填空 \\_\\_\\_ 与 $30\\%$\\n换行"}]}'
        out = _parse_json_object(raw)
        assert out["items"][0]["content"] == "填空 \\_\\_\\_ 与 $30\\%$\n换行"

    def test_preserves_valid_escapes(self):
        # \n \t 为合法转义，不得被加倍
        raw = '{"items": [{"content": "a\\nb\\tc"}]}'
        assert _parse_json_object(raw)["items"][0]["content"] == "a\nb\tc"

    def test_empty_and_garbage(self):
        assert _parse_json_object("") == {}
        import pytest
        with pytest.raises(json.JSONDecodeError):
            _parse_json_object("not json at all")


class TestRepairMalformedHtml:
    """判据是**结构**：只有 ``<name`` 后面紧跟一整只合法标签（有闭合 ``>``）
    才补 ``>``。不等式链（``0<AM<5`` / ``$2<a<3$`` / ``$m<n$``）一律不动。"""

    def test_repairs_consecutive_missing_gt(self):
        assert repair_malformed_html("<table<tr<td>20</td></tr></table>") == (
            "<table><tr><td>20</td></tr></table>"
        )

    def test_repairs_chained(self):
        # 连续三个缺 >：靠多轮替换收敛
        assert repair_malformed_html("<table<tbody<tr<td>1</td></tr></tbody></table>") == (
            "<table><tbody><tr><td>1</td></tr></tbody></table>"
        )

    def test_keeps_inequality_chain_with_uppercase_symbols(self):
        # 2026-11-03 用户报告：数学真题 86419 第 8 题 ② 小问被吞成 0<5
        src = "②AM的取值范围是0<AM<5；"
        assert repair_malformed_html(src) == src

    def test_keeps_variable_chain_even_if_name_looks_like_a_tag(self):
        # 不靠标签白名单：变量名叫 div/tr/sub 也不会被当成残缺标签，
        # 因为后面跟的 <5 / <3 / <n 都不是「一整只合法标签」
        for src in (
            "$2<a<3$",
            "$0^{\\circ}<a<90^{\\circ}$",
            "0<p<1",
            "a<b<c",
            "0<div<5",
            "0<tr<5",
            "0<sub<5",
            "$m<n$",
        ):
            assert repair_malformed_html(src) == src

    def test_keeps_inequality_inside_table_cell(self):
        src = "<table><tr><td>0<x<5</td></tr></table>"
        assert repair_malformed_html(src) == src

    def test_keeps_valid_html_and_plain_text(self):
        assert repair_malformed_html("<table><tr><td>1</td></tr></table>") == (
            "<table><tr><td>1</td></tr></table>"
        )
        assert repair_malformed_html("a < b") == "a < b"
        assert repair_malformed_html(None) is None
        assert repair_malformed_html("") == ""
