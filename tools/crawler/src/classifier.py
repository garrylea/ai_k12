"""分类模块。

根据页面信息确定分类维度，生成规范化文件名和存储路径。
"""

from dataclasses import dataclass, field
from pathlib import Path


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
