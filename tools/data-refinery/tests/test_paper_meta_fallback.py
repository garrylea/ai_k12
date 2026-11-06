"""第 4 步（试卷元数据）在文件名不合规时的兜底：目录 → 卷面 → 问用户。

2026-11-03：手工丢进 crawler/data 的卷子名字不带规范前缀，`parse_paper_meta`
返回 None，第 4 步 0 命中、db_loader 不建 exam_papers。现在改成：目录给
学科/学段/学期/年份，卷面/文件名给年级/考试类型，缺的再问用户。
"""

from pathlib import Path
from types import SimpleNamespace

import pytest

import paper_meta_cli
from config import RefineryConfig
from paper_head import detect_exam_type, detect_grade_from_name, detect_school, meta_from_sidecar
from paper_meta import build_paper_meta, parse_path_parts

BAD_REL = ("数学/初中/first/2026/2026北京北京中学初三（上）期中数学/"
           "2026北京北京中学初三（上）期中数学.jsonl")
PAPER_MD = """# 初三年级数学学科试卷

满分 100 分 考试时间 120 分钟

学校：____ 班级：____ 姓名：____
"""


# === 目录段 ===

def test_parse_path_parts_flat_and_nested():
    parts = parse_path_parts(BAD_REL)
    assert (parts.subject, parts.grade_band, parts.semester, parts.year) == \
        ("数学", "junior", "first", 2026)
    flat = parse_path_parts("语文/初中/second/2025/随便.jsonl")
    assert (flat.grade_band, flat.semester, flat.year) == ("junior", "second", 2025)


def test_parse_path_parts_rejects_bad_dirs():
    assert parse_path_parts("数学/初中/上/2026/x.jsonl") is None  # 学期不是 first/second
    assert parse_path_parts("数学/初中/first/二〇二六/x.jsonl") is None


def test_build_paper_meta_title():
    parts = parse_path_parts(BAD_REL)
    meta = build_paper_meta(parts, "初三", "期中", "北京", "北京中学")
    assert meta.title == "2026 北京·北京中学 初三 期中"
    assert meta.district == "北京"
    # 没有区县/学校时不能出现连续空格
    assert build_paper_meta(parts, "初三", "期中").title == "2026 初三 期中"


# === 卷面/文件名 ===

def test_detect_exam_type():
    assert detect_exam_type("2026北京北京中学初三（上）期中数学.pdf")[0] == "期中"
    assert detect_exam_type(PAPER_MD)[0] is None            # 卷首没写考试类型
    assert detect_exam_type("…学年第一学期期中联合质量检测")[0] == "期中"
    assert detect_exam_type("第一次模拟考试")[0] == "一模"     # 长词优先


def test_detect_grade_from_name():
    assert detect_grade_from_name("2026北京北京中学初三（上）期中数学.pdf") == "初三"
    assert detect_grade_from_name("试卷.pdf") is None


def test_split_location_accepts_separator_variants():
    """地点段不该强迫用户输入难点：中点/横线/下划线/空格/直接连写都要能拆。"""
    from paper_meta import split_location

    for loc in ("西城·35中", "西城35中", "西城-35中", "西城 35中",
                "西城_35中", "西城/35中", "西城、35中"):
        assert split_location(loc) == ("西城", "35中"), loc
    assert split_location("海淀") == ("海淀", None)
    assert split_location("北京各") == ("北京各", None)
    assert split_location("") == ("", None)


def test_parse_paper_meta_location_without_separator():
    """crawler 命名里的地点段也可能没中点（手工改名后），仍要拆出区县 + 学校。"""
    from paper_meta import parse_paper_meta

    rel = "数学/初中/first/2026/数学-初三(上)-202607-西城35中-（上）期中-试卷.jsonl"
    m = parse_paper_meta(rel)
    assert m is not None
    assert m.district == "西城"
    assert m.title == "2026 西城·35中 初三 （上）期中"

    # 带中点的写法行为不变
    rel2 = "数学/初中/first/2024/数学-初三(上)-202407-西城·北京三十五中-（上）期中-试卷.jsonl"
    m2 = parse_paper_meta(rel2)
    assert (m2.district, m2.title) == ("西城", "2024 西城·北京三十五中 初三 （上）期中")


def test_detect_school_collapses_duplicated_prefix():
    """「2026北京北京中学」不能抽成「北京北京中学」。"""
    assert detect_school("2026北京北京中学初三（上）期中数学")[0] == "北京中学"
    assert detect_school("北京中学")[0] == "北京中学"


# === sidecar -> PaperMeta ===

def test_meta_from_sidecar():
    sidecar = {
        "school": None,
        "merged": {"title": "2026 北京中学 初三 期中", "district": "", "grade": "初三",
                   "year": 2026, "semester": "first", "exam_type": "期中"},
    }
    meta = meta_from_sidecar(BAD_REL, sidecar)
    assert meta is not None
    assert meta.year == 2026 and meta.exam_type == "期中" and meta.grade == "初三"
    assert meta.title == "2026 北京中学 初三 期中"


def test_meta_from_sidecar_refuses_incomplete():
    """缺字段宁可不归组，也不拼一张假卷子。"""
    assert meta_from_sidecar(BAD_REL, {"merged": {"grade": "初三"}}) is None


# === 第 4 步整体 ===

def _run(tmp_path, md_text, name="2026北京北京中学初三（上）期中数学", file=None):
    md_dir = tmp_path / "md/数学/初中/first/2026" / name
    md_dir.mkdir(parents=True)
    (md_dir / f"{name}.md").write_text(md_text, encoding="utf-8")
    cfg = RefineryConfig.from_env(output_dir=str(tmp_path))
    args = SimpleNamespace(input_dir=None, output_dir=str(tmp_path), file=file,
                           dry_run=False, no_llm=True, source="all", subject="数学",
                           stage=None, term=None, year=None)
    rel = Path("数学/初中/first/2026") / name / f"{name}.jsonl"
    return paper_meta_cli.run(cfg, args), rel


def test_paper_meta_cli_falls_back_to_dirs_and_head(tmp_path):
    rc, rel = _run(tmp_path, PAPER_MD)
    assert rc == 0
    sidecar = tmp_path / "meta" / rel.with_suffix(".json")
    assert sidecar.exists()
    text = sidecar.read_text(encoding="utf-8")
    assert '"exam_type": "期中"' in text          # 来自文件名关键字
    assert '"year": 2026' in text                 # 来自目录
    assert '"grade": "初三"' in text               # 来自卷面


def test_paper_meta_cli_asks_when_exam_type_unknown(tmp_path, monkeypatch):
    """卷面没写、文件名也没有 → 问用户，并把答案写进 sidecar。"""
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr(paper_meta_cli, "_ask_choice", lambda label, options, default=None: "期末")
    rc, rel = _run(tmp_path, PAPER_MD, name="随便起的名字")
    assert rc == 0
    text = (tmp_path / "meta" / rel.with_suffix(".json")).read_text(encoding="utf-8")
    assert '"exam_type": "期末"' in text


def test_paper_meta_cli_file_filter_splits_keywords(tmp_path):
    """第 4 步的 --file 也走分词：差一个词就不该写 sidecar（且只判一次，不重复过滤）。"""
    rc, rel = _run(tmp_path, PAPER_MD, file="2026 期中")
    assert rc == 0
    assert (tmp_path / "meta" / rel.with_suffix(".json")).exists()

    rc2, rel2 = _run(tmp_path, PAPER_MD, name="2026北京西城初三（上）期中数学", file="2026 海淀")
    assert rc2 == 0
    assert not (tmp_path / "meta" / rel2.with_suffix(".json")).exists()


def test_paper_meta_cli_skips_when_not_interactive(tmp_path, monkeypatch):
    """非交互终端：不猜、不写 sidecar，打印可照做的提示。"""
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    rc, rel = _run(tmp_path, PAPER_MD, name="随便起的名字")
    assert rc == 0
    assert not (tmp_path / "meta" / rel.with_suffix(".json")).exists()
