"""分类模块。

根据页面信息确定分类维度，生成规范化文件名和存储路径。
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


_SEMESTER_CN = {"first": "上", "second": "下"}

_EXAM_TYPE_MAP = {
    "一模": "模拟一",
    "二模": "模拟二",
    "三模": "模拟三",
}


@dataclass
class Classification:
    subject: str
    semester: str
    grade: str
    year: str
    year_code: str
    district: str
    exam_type: str
    file_type: str
    level: str = field(default=None)

    def __post_init__(self) -> None:
        if self.level is None:
            self.level = Classifier.derive_level(self.grade)


class Classifier:
    @staticmethod
    def filename(cls: Classification) -> str:
        semester_cn = _SEMESTER_CN[cls.semester]
        exam = Classifier.normalize_exam_type(cls.exam_type)
        return f"{cls.subject}-{cls.grade}({semester_cn})-{cls.year_code}-{cls.district}-{exam}-{cls.file_type}.pdf"

    @staticmethod
    def storage_dir(cls: Classification, base_dir: str = "data") -> Path:
        return Path(base_dir) / cls.subject / cls.level / cls.semester / cls.year

    @staticmethod
    def derive_level(grade: str) -> str:
        if grade.startswith("初"):
            return "初中"
        if grade.startswith("高"):
            return "高中"
        if grade.startswith("小"):
            return "小学"
        raise ValueError(f"无法从年级推导学段: {grade}")

    @staticmethod
    def normalize_exam_type(exam_type: str) -> str:
        return _EXAM_TYPE_MAP.get(exam_type, exam_type)


_SIMULATION_EXAM_TYPES = {"一模", "二模", "三模"}

_FIRST_SEMESTER_MONTHS = {9, 10, 11, 12, 1}
_SECOND_SEMESTER_MONTHS = {3, 4, 5, 6, 7}

_UP_MARKERS = ("（上）", "(上)", "上学期", "第一学期")
_DOWN_MARKERS = ("（下）", "(下)", "下学期", "第二学期")

_MONTH_PATTERNS = (
    re.compile(r"(20\d{2})[.\-/年](\d{1,2})"),
    re.compile(r"(20\d{2})(0[1-9]|1[0-2])"),
)


def _semester_from_markers(text: str) -> Optional[str]:
    if not text:
        return None
    if any(marker in text for marker in _UP_MARKERS):
        return "first"
    if any(marker in text for marker in _DOWN_MARKERS):
        return "second"
    return None


def _semester_from_month(text: str) -> Optional[str]:
    if not text:
        return None
    for pattern in _MONTH_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        month = int(match.group(2))
        if month in _FIRST_SEMESTER_MONTHS:
            return "first"
        if month in _SECOND_SEMESTER_MONTHS:
            return "second"
    return None


def resolve_semester(exam_type: str, title: str = "", filename: str = "") -> Optional[str]:
    """推断学期：返回 "first" / "second"，无法判定返回 None。

    月考/期中/期末在上下两个学期都有，不能靠考试类型推断，只认显式标记或月份；
    一模/二模/三模是约定性的下学期考试，可直接判定。
    """
    for source in (exam_type, title, filename):
        marked = _semester_from_markers(source)
        if marked is not None:
            return marked
    if exam_type in _SIMULATION_EXAM_TYPES:
        return "second"
    return _semester_from_month(filename) or _semester_from_month(title)
