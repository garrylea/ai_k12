"""提取结果的数据模型，字段对齐 Content Service 需求。"""

from typing import Literal

from pydantic import BaseModel, Field


class ExamQuestion(BaseModel):
    subject_id: str
    group_id: str | None = None
    group_order: int | None = None
    type: Literal["choice", "fill_blank", "true_false", "short_answer", "proof"]
    difficulty: int = Field(..., ge=1, le=3)
    content: str
    options: list[dict] | None = None
    answer: str
    explanation: str | None = None
    material_text: str | None = None
    material_url: str | None = None
    grade_band: str | None = None
    source: str | None = None
    source_year: int | None = None


class TextbookCard(BaseModel):
    lesson_id: str | None = None
    sort_order: int
    card_type: Literal["concept", "example", "practice", "explore", "summary", "reading"]
    title: str | None = None
    content: str
    content_metadata: dict | None = None
    knowledge_point_ids: list[str] | None = None
    textbook_page: str | None = None
