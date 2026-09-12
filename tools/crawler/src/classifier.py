"""分类模块。

根据页面信息确定分类维度，生成规范化文件名和存储路径。
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional


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


_SIMULATION_EXAM_TYPES = {"模拟一", "模拟二", "模拟三"}

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

    exam_type 既接受站点原始写法（`二模`），也接受规范化后的写法（`模拟二`）——
    调用方可能来自 parser（原始），也可能来自 Classification（规范化），两者都不能漏判。
    """
    for source in (exam_type, title, filename):
        marked = _semester_from_markers(source)
        if marked is not None:
            return marked
    if Classifier.normalize_exam_type(exam_type) in _SIMULATION_EXAM_TYPES:
        return "second"
    return _semester_from_month(filename) or _semester_from_month(title)


def _parse_prompt_answer(answer: str) -> Optional[str]:
    text = (answer or "").strip().lower()
    if not text:
        return None
    if text.startswith("上") or text in {"first", "1"}:
        return "first"
    if text.startswith("下") or text in {"second", "2"}:
        return "second"
    return None


class SemesterResolver:
    """学期解析：先自动推断，判不出时询问用户。

    两层缓存，缺一不可：
    - 文件级 `key`（同一份试卷）：自动推断成功的值只在这一层复用，保证「试卷/答案」同学期；
    - 组级 `group`（(年级,考试类型,年份)）：只有用户亲自回答过才写入，同组只问一次。

    不能把自动推断值写进组缓存——那会让无证据的 B 卷静默继承 A 卷的推断（月考上下学期都有）。
    prompt_fn 为 None 表示非交互场景：判不出就记入 unresolved，由调用方跳过该文件。
    """

    def __init__(self, prompt_fn: Optional[Callable[[str], str]] = None) -> None:
        self._prompt_fn = prompt_fn
        self._file_cache: dict = {}
        self._group_cache: dict = {}
        self.unresolved: list[str] = []

    def resolve(
        self,
        *,
        exam_type: str,
        filename: str = "",
        title: str = "",
        key: object = None,
        group: object = None,
        label: str = "",
    ) -> Optional[str]:
        identity = label or filename or exam_type

        semester = resolve_semester(exam_type, title=title, filename=filename)
        if semester is not None:
            self._remember_file(key, semester)
            return semester

        if group is not None and group in self._group_cache:
            semester = self._group_cache[group]
            self._remember_file(key, semester)
            return semester

        if key is not None and key in self._file_cache:
            return self._file_cache[key]

        if self._prompt_fn is None:
            self.unresolved.append(identity)
            return None

        semester = _parse_prompt_answer(self._prompt_fn(identity))
        if semester is None:
            self.unresolved.append(identity)
            return None
        if group is not None:
            self._group_cache[group] = semester
        self._remember_file(key, semester)
        return semester

    def _remember_file(self, key: object, semester: str) -> None:
        if key is not None:
            self._file_cache[key] = semester
