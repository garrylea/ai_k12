import json
from pathlib import Path
from unittest.mock import MagicMock

from extract import Extractor, _parse_json_object
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
