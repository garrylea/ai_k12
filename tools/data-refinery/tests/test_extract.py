import json
from pathlib import Path
from unittest.mock import MagicMock

from extract import Extractor
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
