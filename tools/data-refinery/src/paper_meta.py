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

# 北京区县（不带「区」字，与库里既有值一致）。放在这里而不是 paper_head，
# 是因为 location 切分（parse_paper_meta）与卷面识别（paper_head）都要用，
# 而 paper_head 已经依赖本模块；放这里避免循环 import。
DISTRICTS = (
    "东城", "西城", "朝阳", "海淀", "丰台", "石景山", "门头沟", "房山", "通州",
    "顺义", "昌平", "大兴", "怀柔", "平谷", "密云", "延庆", "经开",
)

# 地点段的分隔符：中点/间隔号/横线/下划线/斜杠/顿号/逗号/空白。
# 用户手工命名时不必打「·」（输入法难找），`西城35中` 也能被无分隔符规则拆开。
_LOCATION_SPLIT_RE = re.compile(r"[·•・\-_/、，,\s]+")


def split_location(location: str) -> tuple[str, str | None]:
    """地点段 → (区县, 学校)。

    支持 `西城·35中` / `西城-35中` / `西城 35中` / `西城35中`；
    无分隔符时按已知区县做前缀切分（`西城35中` → 西城 / 35中）。
    切不出区县（如 `北京四中`）时整段当区县返回，学校为 None —— 交给调用方决定。
    """
    loc = (location or "").strip()
    if not loc:
        return "", None
    parts = _LOCATION_SPLIT_RE.split(loc, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[0].strip(), parts[1].strip()
    for d in DISTRICTS:
        if loc.startswith(d) and len(loc) > len(d):
            return d, loc[len(d):].strip() or None
    return loc, None

# 文件名：subject-grade(学期)-YYYYMM-district-exam_type-file_type[-来源ID]
# 来源 ID 后缀是爬虫防重名时加的（tools/crawler/src/core/storage.py）：
# 文件名冲突时 `…-试卷.pdf` 会存成 `…-试卷-86419.pdf`。这个 id 与卷子无关，
# 只是去重用的，必须容忍，否则整卷只进题、不建 exam_papers（看不到卷子）。
_FILENAME_RE = re.compile(
    r"^(?P<subject>[^-]+)-(?P<grade>[^-()]+)\((?P<sem_cn>[上下])\)"
    r"-(?P<year_code>\d{6})-(?P<district>[^-]+)-(?P<exam_type>[^-]+)"
    r"-(?P<file_type>试卷|答案)(?:-\d+)?\.jsonl$"
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
    # 文件名里的原始地点段（`海淀` 或 `海淀·一零一中学`）。title 会用它重建，
    # 卷面元数据补全后可原样保留学校名，不必把 school 再拆一次。
    location: str | None = None


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
    # 地点字段可能是 `海淀` / `海淀·一零一中学` / `海淀人大附中` / `海淀-人大附中`
    # （爬虫汇总表带学校列、或手工命名时的写法）。入库的 district 只留区县，
    # 保证 /exams 的 district 精确筛选能命中；学校仍保留在 title 里。
    district, school = split_location(m.group("district"))
    location = f"{district}·{school}" if (district and school) else (district or school or "")
    return PaperMeta(
        subject=m.group("subject"),
        grade=m.group("grade"),
        grade_band=_LEVEL_TO_BAND[level],
        semester=semester,
        year=year,
        district=district,
        exam_type=m.group("exam_type"),
        file_type=m.group("file_type"),
        title=f"{year} {location} {m.group('grade')} {m.group('exam_type')}",
        location=location,
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


@dataclass(frozen=True)
class PathParts:
    """目录段能确定的四项：学科 / 学段 / 学期 / 年份。

    这四项本来就写在路径里，不需要从文件名抠。文件名不合规时用它兜底
    （2026-11-03：手工丢进来的卷子名字不规范，第 4 步直接 0 命中）。
    """

    subject: str
    level: str
    grade_band: str
    semester: str
    year: int


def parse_path_parts(rel_path: str) -> PathParts | None:
    parts = rel_path.replace("\\", "/").split("/")
    if len(parts) < 5:
        return None
    dirs = parts[:-1]
    # 嵌套布局：{...}/{试卷名目录}/{试卷名}.jsonl → 再退一层
    if len(dirs) >= 2 and parts[-1].endswith(".jsonl") and dirs[-1] == parts[-1][: -len(".jsonl")]:
        dirs = dirs[:-1]
    if len(dirs) < 4:
        return None
    subject, level, semester, year_dir = dirs[-4], dirs[-3], dirs[-2], dirs[-1]
    if level not in _LEVEL_TO_BAND or semester not in ("first", "second") or not year_dir.isdigit():
        return None
    return PathParts(subject, level, _LEVEL_TO_BAND[level], semester, int(year_dir))


def build_paper_meta(parts: PathParts, grade: str, exam_type: str,
                     district: str = "", school: str | None = None,
                     file_type: str = "试卷") -> PaperMeta:
    """目录段 + 卷面/询问得到的 年级、考试类型 → PaperMeta（文件名不合规时的兜底）。"""
    location = f"{district}·{school}" if (district and school) else (district or school or "")
    title = " ".join(x for x in (str(parts.year), location, grade, exam_type) if x)
    return PaperMeta(
        subject=parts.subject,
        grade=grade,
        grade_band=parts.grade_band,
        semester=parts.semester,
        year=parts.year,
        district=district,
        exam_type=exam_type,
        file_type=file_type,
        title=title,
        location=location or None,
    )
