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


from dataclasses import dataclass
from pathlib import Path


@dataclass
class ImageInfo:
    """一张图片的元信息（image_scan 产出）"""
    ref_path: str         # MD 中的引用路径，如 "images/hash.jpg"
    disk_path: Path       # 磁盘实际路径
    width: int            # 原始宽度 px
    height: int           # 原始高度 px
    scaled_width: int     # 缩放后宽度 px（≤IMG_MAX_WIDTH）
    scaled_height: int    # 缩放后高度 px
    char_cost: int        # 折算字数
    position_in_text: int  # 在 text_content 中的字符偏移


@dataclass
class CardFragment:
    """拆分后的原始卡片片段（card_splitter 产出）"""
    sort_order: int               # 页内序号，从 1 开始
    content: str                  # 原始 Markdown（含图片引用），一字不改
    images: list[ImageInfo]       # 本卡片包含的图片
    raw_text_char_count: int      # 纯文字字数
    image_char_cost: int          # 图片折算总字数
    total_char_cost: int          # = raw_text_char_count + image_char_cost
    textbook_page: str            # 从 MD 文件名提取，如 "P8"
