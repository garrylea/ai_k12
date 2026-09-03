"""从 published JSONL 相对路径解析试卷元数据（爬虫 classifier 命名规则的逆操作）。

支持两种布局：
- 平面：数学/初中/second/2024/数学-初三(下)-202407-海淀-模拟二-试卷.jsonl
- 嵌套：数学/初中/second/2024/数学-初三(下)-202407-海淀-模拟二-试卷/数学-初三(下)-202407-海淀-模拟二-试卷.jsonl
db_loader_cli 据此 find-or-create exam_papers（source_key = 相对路径去 .jsonl）。
"""

import re
from dataclasses import dataclass

_LEVEL_TO_BAND = {"小学": "primary", "初中": "junior", "高中": "senior"}
_SEMESTER_CN = {"上": "first", "下": "second"}

# 文件名：subject-grade(学期)-YYYYMM-district-exam_type-file_type
_FILENAME_RE = re.compile(
    r"^(?P<subject>[^-]+)-(?P<grade>[^-()]+)\((?P<sem_cn>[上下])\)"
    r"-(?P<year_code>\d{6})-(?P<district>[^-]+)-(?P<exam_type>[^-]+)"
    r"-(?P<file_type>试卷|答案)\.jsonl$"
)


@dataclass(frozen=True)
class PaperMeta:
    subject: str
    grade: str
    grade_band: str
    semester: str
    year: int
    district: str
    exam_type: str
    file_type: str
    title: str


def _parse_with_dirs(level: str, semester: str, year_dir: str, filename: str) -> PaperMeta | None:
    """按目录段（level/semester/year_dir）+ 文件名解析；目录段不合法返回 None。"""
    if level not in _LEVEL_TO_BAND or semester not in ("first", "second") or not year_dir.isdigit():
        return None
    m = _FILENAME_RE.match(filename)
    if not m:
        return None
    year = int(m.group("year_code")[:4])
    sem = _SEMESTER_CN[m.group("sem_cn")]
    if sem != semester or year != int(year_dir):
        return None  # 文件名与目录不一致，视为脏数据
    return PaperMeta(
        subject=m.group("subject"),
        grade=m.group("grade"),
        grade_band=_LEVEL_TO_BAND[level],
        semester=semester,
        year=year,
        district=m.group("district"),
        exam_type=m.group("exam_type"),
        file_type=m.group("file_type"),
        title=f"{year} {m.group('district')} {m.group('grade')} {m.group('exam_type')}",
    )


def parse_paper_meta(rel_path: str) -> PaperMeta | None:
    parts = rel_path.replace("\\", "/").split("/")
    if len(parts) < 5:
        return None
    # 平面布局：{subject}/{level}/{semester}/{year}/{文件}.jsonl
    meta = _parse_with_dirs(parts[-4], parts[-3], parts[-2], parts[-1])
    if meta is not None:
        return meta
    # 嵌套布局：{subject}/{level}/{semester}/{year}/{试卷名目录}/{文件}.jsonl
    # 要求试卷名目录与文件名 stem 一致（不一致视为脏数据）。
    if len(parts) >= 6 and parts[-1].endswith(".jsonl"):
        stem = parts[-1][: -len(".jsonl")]
        if parts[-2] != stem:
            return None
        return _parse_with_dirs(parts[-5], parts[-4], parts[-3], parts[-1])
    return None
