"""统一范围过滤（scope_filter）单测：维度解析 / 别名归一 / 交集匹配 / 关键词分词。"""

from pathlib import Path

from scope_filter import (
    build_scope, describe, match_keyword, match_scope, parse_dimensions,
    scope_argv, split_keyword,
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


def test_match_scope_file_tokens():
    """`--file "2026 海淀"`：分词后逐个命中，不再要求整串连续。"""
    scope = build_scope(file="2026 海淀")
    paper = "道法/初中/first/2026/2026北京海淀初三（上）期中道德与法治"
    assert match_scope(paper, scope)
    assert not match_scope("道法/初中/first/2026/2026北京西城初三（上）期中道德与法治", scope)
    assert not match_scope("道法/初中/first/2025/2025北京海淀初三（上）期中道德与法治", scope)


def test_match_keyword_separators_and_case():
    paper = Path("语文/初中/second/2025/语文-初三(下)-202507-海淀-模拟二-试卷")
    # 空格 / 全角空格 / 横线 / 下划线 / 斜杠 / 中点 / 顿号 都算分隔符
    for keyword in ("2025 海淀", "2025　海淀", "2025-海淀", "2025_海淀",
                    "2025/海淀", "海淀·2025", "2025、海淀"):
        assert match_keyword(paper, keyword), keyword
    # 顺序无关
    assert match_keyword(paper, "海淀 2025 模拟二")
    # 有一个词不命中就整体不命中
    assert not match_keyword(paper, "2025 西城")
    # 大小写无关
    assert match_keyword(Path("英语/初中/second/2025/Unit1-ABC"), "unit1 abc")


def test_match_keyword_ignores_known_suffixes():
    assert match_keyword(Path("语文/初中/second/2025/卷-x.md"), "卷-x")
    assert match_keyword(Path("语文/初中/second/2025/卷-x.jsonl"), "卷-x.md") is False
    # 点号是卷名的一部分时不剥（只有已知产物后缀才剥）
    assert match_keyword(Path("数学/初中/second/2025/模拟.二"), "模拟.二")


def test_match_keyword_empty_does_not_filter():
    assert match_keyword("任意/路径", None)
    assert match_keyword("任意/路径", "")
    assert match_keyword("任意/路径", "  -／、 ")   # 纯分隔符 = 没给关键词


def test_split_keyword_dedupes_and_keeps_order():
    assert split_keyword("2026 海淀 2026") == ("2026", "海淀")
    assert split_keyword(None) == ()


def test_scope_file_tokens_cached():
    scope = build_scope(file="2026 海淀")
    assert scope.file_tokens == ("2026", "海淀")
    assert scope.active
    assert describe(scope) == "file~2026 海淀"   # describe 仍显示原串


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
