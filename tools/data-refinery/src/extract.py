"""LLM 提取器：从 Markdown 提取题目或卡片。"""

import json
from dataclasses import dataclass
from pathlib import Path

from llm import LLMClient, LLMResponse
from models import ExamQuestion, TextbookCard


@dataclass
class ExtractionResult:
    items: list[ExamQuestion | TextbookCard]
    prompt_tokens: int
    completion_tokens: int


class Extractor:
    def __init__(self, llm: LLMClient, prompt: str, kind: str):
        self._llm = llm
        self._prompt = prompt
        self._kind = kind  # "questions" | "cards"

    def run(self, md_path: Path) -> ExtractionResult:
        content = md_path.read_text(encoding="utf-8")
        response: LLMResponse = self._llm.complete(self._prompt, content)
        data = json.loads(response.content)
        raw_items = data.get("items", [])

        if self._kind == "questions":
            items = [ExamQuestion(**item) for item in raw_items]
        else:
            items = [TextbookCard(**item) for item in raw_items]

        return ExtractionResult(
            items=items,
            prompt_tokens=response.prompt_tokens,
            completion_tokens=response.completion_tokens,
        )
