"""统一范围过滤（scope_filter）单测：维度解析 / 别名归一 / 交集匹配。"""

from pathlib import Path

from scope_filter import (
    build_scope, describe, match_scope, parse_dimensions, scope_argv,
)


def test_parse_dimensions_paper_and_book():
    paper = Path("语文/初中/second/2025/语文-初三(下)-202507-海淀-模拟二-试卷")
    book = Path("数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册")
    p = parse_dimensions(paper)
    assert p == {"subject": "语文", "stage": "junior", "term": "second", "year": "2025"}
    b = parse_dimensions(book)
    assert b["subject"] == "数学" and b["stage"] == "junior"
    assert b["term"] == "second" and b["year"] is None


def test_build_scope_normalizes_aliases():
    s = build_scope(subject="chinese,数学", stage="初中", term="上册", year="2025")
    assert s.subjects == frozenset({"语文", "数学"})
    assert s.stages == frozenset({"junior"})
    assert s.terms == frozenset({"first"})
    assert s.years == frozenset({"2025"})


def test_match_scope_intersection():
    scope = build_scope(subject="语文", year="2025")
    assert match_scope("语文/初中/second/2025/卷", scope)
    assert not match_scope("语文/初中/second/2024/卷", scope)
    assert not match_scope("数学/初中/second/2025/卷", scope)


def test_match_scope_file_substring():
    scope = build_scope(file="202507-海淀")
    assert match_scope("语文/初中/second/2025/语文-初三(下)-202507-海淀-模拟二-试卷", scope)
    assert not match_scope("语文/初中/second/2025/语文-初三(下)-202507-西城-模拟二-试卷", scope)


def test_match_scope_inactive_matches_all():
    scope = build_scope()
    assert not scope.active
    assert match_scope("任意/路径", scope)


def test_book_path_term_alias():
    scope = build_scope(term="下册")
    # 下册 = second：教材 下册 与试卷 second 同义
    assert match_scope("数学/初中/人教版/九年级/下册/某书/page_001", scope)
    assert match_scope("语文/初中/second/2025/某卷", scope)
    assert not match_scope("语文/初中/first/2025/某卷", scope)


def test_scope_argv_and_describe():
    class A:
        subject = "chinese"
        stage = None
        term = "上"
        year = None
        file = "海淀"

    assert scope_argv(A) == ["--subject", "chinese", "--term", "上", "--file", "海淀"]
    assert describe(build_scope(subject="语文", term="下册")) == "subject=语文 term=second"
