"""db_loader 集成测试：连真实 MySQL ai_k12 库，验证 find-or-create 与入库。

每个测试前清空派生表（cards/questions/lessons/units/semesters/textbook_versions），保留 subjects seed。
需要本机 MySQL 已用 install_mysql.sh 初始化、subjects 已 seed。

dev 库若有业务数据（错题本/answers/progress 等 FK 引用 questions/cards）会挡住清理：
默认 skip（防止测试悄悄清空业务数据）；显式传 REFINERY_TEST_PURGE=1 才允许先清业务表再跑。
"""
import json
import os
from pathlib import Path

import pymysql
import pytest

from config import RefineryConfig
from db_loader import DbLoader

_BOOK_REL = "数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册/page_008.jsonl"


def _card(lid, sort_order, card_type="concept", content="c"):
    return {"lesson_id": lid, "sort_order": sort_order, "card_type": card_type,
            "title": None, "content": content, "content_metadata": None,
            "knowledge_point_ids": [], "textbook_page": "P1"}


def _q(subject_id, group_order=1, qtype="choice", answer="B", content="题干"):
    return {"subject_id": subject_id, "group_id": "一", "group_order": group_order,
            "type": qtype, "difficulty": 2, "content": content,
            "options": [{"label": "A", "text": "1"}, {"label": "B", "text": "2"}],
            "answer": answer, "explanation": None, "material_text": None,
            "material_url": None, "grade_band": None, "source": "测试卷", "source_year": 2024}


@pytest.fixture
def db():
    cfg = RefineryConfig.from_env()
    try:
        loader = DbLoader(cfg.db_host, cfg.db_port, cfg.db_user, cfg.db_pass, cfg.db_name)
    except Exception as e:
        pytest.skip(f"DB 不可用: {e}")
    # 业务数据守卫：错题本/answers/progress 等的 FK（RESTRICT）会挡住 DELETE FROM questions/cards。
    # 默认 skip 防止测试悄悄清空业务数据；REFINERY_TEST_PURGE=1 时显式清空后继续。
    blocking = {t: n for t, n in loader.business_data_summary(
        reset_cards=True, reset_questions=True).items() if n > 0}
    if blocking:
        if os.environ.get("REFINERY_TEST_PURGE") != "1":
            loader.close()
            detail = ", ".join(f"{t}={n}" for t, n in sorted(blocking.items()))
            pytest.skip(
                f"dev 库业务数据挡住清理（{detail}）："
                "确认可清空后传 REFINERY_TEST_PURGE=1 重跑（会先 DELETE 这些业务表）")
        purged = loader.purge_business_data(reset_cards=True, reset_questions=True)
        for t, n in purged.items():
            if n:
                print(f"[purge] DELETE {t}: {n} 行")
    # 清派生表（子先父后），保留 subjects
    def _clean():
        for t in ("cards", "questions", "lessons", "units", "semesters", "textbook_versions"):
            loader._exec(f"DELETE FROM {t}")
        loader._conn.commit()

    _clean()
    yield loader
    _clean()  # teardown：避免测试数据污染真实库
    loader.close()


class TestFindOrCreate:
    def test_textbook_version_idempotent(self, db):
        a = db._find_or_create_textbook_version("math", "人教版", "junior")
        b = db._find_or_create_textbook_version("math", "人教版", "junior")
        assert a == b and a > 0

    def test_unit_lesson_idempotent(self, db):
        tv = db._find_or_create_textbook_version("math", "人教版", "junior")
        sem = db._find_or_create_semester(tv, "grade_9", "second", "九年级下册")
        u1 = db._find_or_create_unit(sem, 26, "第二十六章 反比例函数")
        u2 = db._find_or_create_unit(sem, 26, "第二十六章 反比例函数")
        assert u1 == u2
        l1 = db._find_or_create_lesson(u1, "26.1.1 反比例函数", 1)
        l2 = db._find_or_create_lesson(u1, "26.1.1 反比例函数", 1)
        assert l1 == l2


class TestLoadCards:
    def test_insert_and_lesson_mapped(self, db):
        cards = [
            _card("第二十六章 反比例函数", 1, "reading", "章前"),
            _card("26.1.1 反比例函数", 1, "concept", "概念"),
            _card("26.1.1 反比例函数", 1, "example", "例题"),  # 次页同 lesson，sort_order 碰撞
        ]
        n = db.load_book_cards(_BOOK_REL, cards)
        assert n == 3
        assert db._count("cards") == 3
        # 所有 card 的 lesson_id（FK）都已映射，非空
        rows = db._query("SELECT lesson_id FROM cards")
        assert all(r[0] for r in rows), "存在 lesson_id 未映射的 card"

    def test_sort_order_renumbered(self, db):
        cards = [
            _card("26.1.1 反比例函数", 1),
            _card("26.1.1 反比例函数", 1),  # 跨页碰撞 -> 重排为 2
            _card("26.1.1 反比例函数", 2),  # -> 3
        ]
        db.load_book_cards(_BOOK_REL, cards)
        rows = db._query("SELECT sort_order FROM cards ORDER BY sort_order")
        assert [r[0] for r in rows] == [1, 2, 3]

    def test_chapter_overview_lesson(self, db):
        db.load_book_cards(_BOOK_REL, [_card("第二十六章 反比例函数", 1, "reading", "章前")])
        # 章综述应建一个 lesson（sort_order=0）+ unit
        assert db._count("units") == 1
        assert db._count("lessons") == 1
        rows = db._query("SELECT sort_order FROM lessons")
        assert rows[0][0] == 0


class TestLoadQuestions:
    def test_insert(self, db):
        n = db.load_questions([_q("math", content="题干1"), _q("chem", content="题干2")])  # chem 别名 -> chemistry
        assert n == 2
        assert db._count("questions") == 2

    def test_subject_alias_mapped(self, db):
        db.load_questions([_q("chem")])
        rows = db._query("SELECT subject_id FROM questions")
        chem_id = db._subject_id_by_code("chemistry")
        assert rows[0][0] == chem_id

    def test_dedup_by_content_hash(self, db):
        # 同 content_hash 命中已有题 -> 跳过插入（PRD §7.10 去重）
        db.load_questions([_q("math", content="相同题干")])
        n = db.load_questions([_q("math", content="相同题干")])
        assert n == 0
        assert db._count("questions") == 1


class TestIdempotent:
    def test_reload_cards_same_count(self, db):
        cards = [_card("26.1.1 反比例函数", 1), _card("26.1.2 反比例函数的图象和性质", 1)]
        db.load_book_cards(_BOOK_REL, cards)
        assert db._count("cards") == 2
        db.reset_cards()  # full-reload：先清 card
        db.load_book_cards(_BOOK_REL, cards)
        assert db._count("cards") == 2  # 不是 4
