"""学科目录名 -> subject code 的映射（extract 选切题策略的第一个入口）。"""

from pathlib import Path

from subject_codes import SUBJECT_NAME_TO_CODE, subject_code_for_parts, subject_code_for_path


def test_daofa_alias_maps_to_politics():
    """爬虫目录叫「道法」，subjects.name 叫「道德与法治」，两个都要能反查。"""
    assert SUBJECT_NAME_TO_CODE["道法"] == "politics"
    assert SUBJECT_NAME_TO_CODE["道德与法治"] == "politics"
    assert subject_code_for_parts(("道法", "初中", "first", "2026"), default=None) == "politics"


def test_unknown_subject_stays_none_when_no_default():
    """目录名写错/新学科没登记时返回 None，让 extract 立刻报错，不静默当数学。"""
    assert subject_code_for_parts(("未知学科",), default=None) is None


def test_path_helper_keeps_default_for_legacy_assets():
    assert subject_code_for_path(Path("数学/初中/second/2025/卷")) == "math"
    assert subject_code_for_path(Path("随便/某处"), default="math") == "math"
