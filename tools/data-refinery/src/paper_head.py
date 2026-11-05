"""卷面元数据：从试卷 md 首屏抽取 区县 / 学校 / 年级（文件名缺信息时用）。

背景（2026-11-02）：爬虫的「北京各」是"北京市各区"集合名，不是区县；文件名里
既没有区县也没有学校，入库后 `exam_papers.title` 只能是「2025 北京各 初三 期中」，
学生认不出是哪张卷。卷面首屏其实写了（`2025 北京海淀初三（上）期中` /
`北京市西城区德胜中学…`），所以这里按"路径管结构、卷面管内容"补：

- 学科 / 学段 / 学期 / 年份仍用路径（paper_meta）；
- 区县 / 学校 / 年级用卷面；规则抽不到才调 LLM，且只允许从原文摘取、允许 null；
- 区县抽不到就留空，**不按学校推断**（2026-11-02 用户裁决）。

产物是 sidecar（`output/meta/<published rel>.json`），可人工修改后只重跑入库。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from pathlib import Path

from extract import _parse_json_object
from paper_meta import DISTRICTS, PaperMeta

# 爬虫会把「北京各区」的合集卷命名为 `北京各`；它不是区县，入库时必须当缺失。
COLLECTIVE_LOCATIONS = {"北京各", "北京各区", "各区", "待确认", "未知", "不详", ""}

# 学校名两种写法：
#   1) 带明确后缀：…中学 / …学校 / …附中 / …附小 / …小学 / …教育集团
#   2) 简称：数字或中文数字 + 中（35中 / 八十中 / 十二中 / 北京三十五中）
# 第 2 种必须限定「数字在前」，否则「初中 / 高中 / 期中 / 其中」全会被当成学校。
# 明确后缀优先（贪婪，`昌平二中教育集团` 不能被截成 `昌平二中`），
# 简称分支放后面兜底（`西城35中` / `朝阳八十中`）。
_SCHOOL_RE = re.compile(
    r"[\u4e00-\u9fff]{2,16}(?:中学|学校|附中|附小|小学|教育集团)"
    r"|[\u4e00-\u9fff]{0,8}?[一二三四五六七八九十百零〇0-9]{1,3}中"
)
_SCHOOL_NUM_RE = re.compile(r"[一二三四五六七八九十百零〇0-9]{1,3}中$")
_SCHOOL_STOPWORDS = (
    "填写", "答题卡", "答题纸", "考生", "名称", "所在", "试卷", "草稿纸", "正确填涂",
)
# 学校名前面常粘着这些套话（`学年第一学期昌平二中教育集团`），要剥掉
_SCHOOL_PREFIXES = (
    "学年度", "学年", "第一学期", "第二学期", "上学期", "下学期", "期中", "期末",
    "练习", "考试", "试卷", "调研", "联合", "质量检测", "初三年级", "初三", "九年级",
    "区", "市", "县",
)

_GRADE_PATTERNS = (
    (r"初\s*一|七年级|７年级", "初一"),
    (r"初\s*二|八年级|８年级", "初二"),
    (r"初\s*三|九年级|９年级", "初三"),
    (r"高\s*一|高中一年级", "高一"),
    (r"高\s*二|高中二年级", "高二"),
    (r"高\s*三|高中三年级", "高三"),
)


@dataclass
class HeadMeta:
    """卷面能提供、且路径可能缺失的字段。"""

    district: str | None = None
    school: str | None = None
    grade: str | None = None
    evidence: dict[str, str] | None = None
    source: str = "rule"          # rule | llm | mixed

    def to_json(self) -> dict:
        return {
            "district": self.district,
            "school": self.school,
            "grade": self.grade,
            "evidence": self.evidence or {},
            "source": self.source,
        }


def head_text(md_text: str, max_lines: int = 15) -> str:
    """取 md 首屏：前 N 个非空行，去掉 markdown 标题符号 / 表格 / 纯图片行。"""
    out: list[str] = []
    for raw in (md_text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("<table") or line.startswith("|"):
            continue
        if line.startswith("![](") or line.startswith("!["):
            continue
        line = line.lstrip("#").strip()
        if not line:
            continue
        out.append(line)
        if len(out) >= max_lines:
            break
    return "\n".join(out)


def detect_district(head: str) -> tuple[str | None, str | None]:
    """返回 (区县, 命中原句)。区县统一不带「区」字，与库里既有值一致。"""
    for line in head.splitlines():
        # 先认「XX区」这种明确写法
        m = re.search(rf"(?:北京市)?({'|'.join(DISTRICTS)})区", line)
        if m:
            return m.group(1), line[:80]
    # 标题行里的「北京海淀」/「海淀初三」/「人大附中朝阳学校」：只在第一行认
    first = head.splitlines()[0] if head else ""
    m = re.search(rf"({'|'.join(DISTRICTS)})", first)
    if m:
        return m.group(1), first[:80]
    return None, None


def _clean_school(name: str) -> str:
    name = name.strip()
    changed = True
    while changed:
        changed = False
        # 无分隔符写法：`海淀区人大附中` 先把「海淀区」的区字去掉；
        # `西城35中` 再剥区县前缀。只在剩余的是「数字+中」简称时剥，
        # 避免把 `昌平二中教育集团` 这类完整校名拆残（既有行为）。
        for d in DISTRICTS:
            if name.startswith(d + "区"):
                name = name[len(d) + 1:]
                changed = True
                break
        for d in DISTRICTS:
            rest = name[len(d):]
            if name.startswith(d) and len(rest) >= 3 and _SCHOOL_NUM_RE.search(rest):
                name = rest
                changed = True
                break
        for prefix in _SCHOOL_PREFIXES:
            if name.startswith(prefix) and len(name) > len(prefix) + 2:
                name = name[len(prefix):]
                changed = True
                break
    # 「2026北京北京中学」这种：年份后面紧跟的地点把学校名前缀重复了一遍。
    # 只消完全重复的 2–4 字前缀，不动真正的「北京中学」。
    for size in (2, 3, 4):
        if len(name) > size * 2 and name[:size] == name[size:size * 2]:
            name = name[size:]
            break
    return name


def _is_school_name(name: str) -> bool:
    """学校名合法性：明确后缀至少 4 字；`35中` 这类简称至少 3 字。"""
    if name.endswith(("中学", "学校", "附中", "附小", "小学", "教育集团")):
        return len(name) >= 4
    return bool(_SCHOOL_NUM_RE.search(name)) and len(name) >= 3


def detect_school(head: str) -> tuple[str | None, str | None]:
    """返回 (学校名, 命中原句)。取最长且不像套话的匹配。

    同时认「…中学/学校/附中」与「数字+中」两种写法，后者覆盖 `西城35中`、
    `朝阳八十中`、`北京四中`、`西城·北京三十五中` —— 手工命名不必输入难打的 `·`。
    """
    best: tuple[str, str] | None = None
    for line in head.splitlines():
        for m in _SCHOOL_RE.finditer(line):
            raw = m.group(0)
            if any(w in raw for w in _SCHOOL_STOPWORDS):
                continue
            name = _clean_school(raw)
            if not _is_school_name(name):
                continue
            if best is None or len(name) > len(best[0]):
                best = (name, line[:80])
    return best if best else (None, None)


def detect_grade(head: str) -> tuple[str | None, str | None]:
    for pattern, grade in _GRADE_PATTERNS:
        for line in head.splitlines():
            if re.search(pattern, line):
                return grade, line[:80]
    return None, None


# 考试类型：长词优先（「第一次模拟」不能先被「模拟」吃掉）
_EXAM_TYPES = (
    (r"期中", "期中"),
    (r"期末", "期末"),
    (r"一模|第一次模拟", "一模"),
    (r"二模|第二次模拟", "二模"),
    (r"模拟", "模拟"),
    (r"月考", "月考"),
    (r"联考|联合质量检测|联合考试", "联考"),
    (r"开学考|开学测", "开学考"),
    (r"学业水平", "学业水平"),
    (r"质量检测|质量监测", "质量检测"),
)


def detect_exam_type(text: str) -> tuple[str | None, str | None]:
    """从文件名或卷面首屏认考试类型；认不出返回 (None, None)，由调用方问用户。"""
    head = head_text(text, max_lines=8)
    for pattern, label in _EXAM_TYPES:
        m = re.search(pattern, head)
        if m:
            return label, head.splitlines()[0][:80] if head else ""
    return None, None


def detect_grade_from_name(name: str) -> str | None:
    for pattern, grade in _GRADE_PATTERNS:
        if re.search(pattern, name):
            return grade
    return None


def extract_head_meta(md_text: str, llm=None) -> HeadMeta:
    """规则优先；区县/年级缺失时调一次 LLM（只许摘原文，非法值丢弃）。"""
    head = head_text(md_text)
    evidence: dict[str, str] = {}

    district, ev = detect_district(head)
    if ev:
        evidence["district"] = ev
    school, ev = detect_school(head)
    if ev:
        evidence["school"] = ev
    grade, ev = detect_grade(head)
    if ev:
        evidence["grade"] = ev

    meta = HeadMeta(district=district, school=school, grade=grade, evidence=evidence)
    if not llm or (meta.district and meta.grade):
        return meta

    try:
        filled = _ask_llm(head, meta, llm)
    except Exception as exc:                     # LLM 不可用绝不阻断导入
        print(f"[meta] LLM 补全失败（{exc}），按规则结果继续", flush=True)
        return meta

    changed = False
    if not meta.district and filled.get("district") in DISTRICTS:
        meta.district = filled["district"]
        evidence["district"] = "llm"
        changed = True
    if not meta.school and filled.get("school"):
        school_name = _clean_school(str(filled["school"]))
        if len(school_name) >= 4:
            meta.school = school_name
            evidence["school"] = "llm"
            changed = True
    allowed_grades = {g for _, g in _GRADE_PATTERNS}
    if not meta.grade and filled.get("grade") in allowed_grades:
        meta.grade = filled["grade"]
        evidence["grade"] = "llm"
        changed = True
    if changed:
        meta.source = "mixed" if (meta.district or meta.school or meta.grade) else "rule"
    return meta


def _ask_llm(head: str, meta: HeadMeta, llm) -> dict:
    system = (
        "你是试卷元数据抽取器。只从给定文本里摘取区县、学校、年级，"
        "不允许凭常识推断；文本没写就返回 null。只输出 JSON。"
    )
    user = (
        f"已知：区县={meta.district or '未知'}，学校={meta.school or '未知'}，"
        f"年级={meta.grade or '未知'}。\n"
        f"文本：\n{head[:800]}\n\n"
        '返回：{"district": "海淀|null", "school": "学校全名|null", '
        '"grade": "初一|初二|初三|高一|高二|高三|null"}'
    )
    resp = llm.complete(system, user)
    return _parse_json_object(resp.content or "")


def merge_meta(meta: PaperMeta, head: HeadMeta | None) -> tuple[PaperMeta, list[str]]:
    """路径 + 卷面 -> 最终元数据。返回 (新 meta, 需要打印的提示)。"""
    notes: list[str] = []
    if head is None:
        return meta, notes

    collective = (meta.district or "") in COLLECTIVE_LOCATIONS
    if collective:
        district = head.district
        school = head.school
    else:
        district = meta.district
        school = None

    grade = head.grade or meta.grade
    if head.grade and meta.grade and head.grade != meta.grade:
        notes.append(f"文件名写{meta.grade}，卷面是{head.grade}（以卷面为准）")

    if collective:
        if district and school:
            location = f"{district}·{school}"
        else:
            location = district or school or meta.location or meta.district
    else:
        location = meta.location or meta.district

    title = f"{meta.year} {location} {grade} {meta.exam_type}" if location \
        else f"{meta.year} {grade} {meta.exam_type}"
    return replace(meta, district=district, grade=grade, title=title), notes


def sidecar_path(output_dir: Path, rel_jsonl: str | Path) -> Path:
    """published 相对路径 -> sidecar 路径（同结构，后缀换 .json）。"""
    return Path(output_dir) / "meta" / Path(str(rel_jsonl)).with_suffix(".json")


def load_sidecar(output_dir: Path, rel_jsonl: str | Path) -> dict | None:
    path = sidecar_path(output_dir, rel_jsonl)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[meta] sidecar 读取失败（{path}）：{exc}", flush=True)
        return None


def apply_sidecar(meta: PaperMeta, sidecar: dict) -> PaperMeta:
    """把 sidecar 里的合并结果套回 PaperMeta（缺字段时保持原值）。"""
    merged = sidecar.get("merged") or {}
    district = merged.get("district", sidecar.get("district")) or meta.district
    grade = merged.get("grade", sidecar.get("grade")) or meta.grade
    title = merged.get("title") or sidecar.get("title") or meta.title
    return replace(meta, district=district, grade=grade, title=title)


def write_sidecar(output_dir: Path, rel_jsonl: str | Path, head: HeadMeta,
                  merged: PaperMeta, notes: list[str] | None = None) -> Path:
    path = sidecar_path(output_dir, rel_jsonl)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = head.to_json()
    # 年份/学期/考试类型也落盘：文件名不合规时 db_loader 全靠这份 sidecar 建卷，
    # 少一个字段就归不了组（2026-11-03）
    payload["merged"] = {
        "title": merged.title,
        "district": merged.district,
        "grade": merged.grade,
        "year": merged.year,
        "semester": merged.semester,
        "exam_type": merged.exam_type,
    }
    if notes:
        payload["notes"] = notes
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def meta_from_sidecar(rel_jsonl: str | Path, sidecar: dict) -> PaperMeta | None:
    """文件名不合规时，用 sidecar（目录 + 卷面/用户选择）拼出 PaperMeta。

    字段不全就返回 None —— 宁可不归组，也不拼一张字段缺失的假卷子。
    """
    from paper_meta import build_paper_meta, parse_path_parts

    merged = sidecar.get("merged") or {}
    parts = parse_path_parts(str(rel_jsonl).replace("\\", "/"))
    if parts is None:
        return None
    grade = merged.get("grade") or sidecar.get("grade")
    exam_type = merged.get("exam_type")
    title = merged.get("title")
    if not (grade and exam_type and title):
        return None
    district = merged.get("district", sidecar.get("district")) or ""
    school = sidecar.get("school")
    meta = build_paper_meta(parts, grade, exam_type, district or "", school)
    return replace(meta, title=title)
