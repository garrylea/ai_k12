"""apply_fixes_cli 端到端：连真实 MySQL，造一张临时卷 → 应用补题 → 校验 → 整体回滚。

与 test_db_loader_integration 不同，这里**不清空任何现有表**：
所有写入都在一个事务里，测试结束 rollback，库里不留痕（dev 库可直接跑）。

连不上库 / subjects 未 seed 时自动 skip。
"""

import sys
from pathlib import Path

import pymysql
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "src"))

import apply_fixes_cli as A  # noqa: E402
from config import RefineryConfig  # noqa: E402

SOURCE = "__pytest__-物理-写库验证-试卷"
REL = "物理/__pytest__/first/2024/__pytest__-物理-写库验证-试卷"
KEY = f"{REL}/{SOURCE}"


@pytest.fixture
def conn():
    cfg = RefineryConfig.from_env()
    try:
        c = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                            password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
                            autocommit=False)
    except Exception as e:                       # 本机没库就跳过
        pytest.skip(f"DB 不可用：{e}")
    try:
        with c.cursor() as cur:
            cur.execute("SELECT id FROM subjects WHERE code='physics'")
            row = cur.fetchone()
        if not row:
            pytest.skip("subjects 未 seed")
        yield c, int(row[0])
    finally:
        c.rollback()                              # 不留痕
        c.close()


def _make_paper(cur, subject_id: int) -> int:
    cur.execute(
        "INSERT INTO exam_papers (subject_id, title, grade, grade_band, semester, year, "
        "district, exam_type, source_key) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (subject_id, "__pytest__ 写库验证", "初三", "junior", "first", 2024,
         None, "期中", KEY))
    return int(cur.lastrowid)


def _rec(group_order: int, content: str, options=None, answer="") -> dict:
    return {"source": SOURCE, "rel_path": REL, "group_order": group_order,
            "content": content, "options": options, "answer": answer,
            "material_text": None}


def _count(cur, sql, args):
    cur.execute(sql, args)
    return int(cur.fetchone()[0])


def test_insert_then_update_keeps_one_row(conn):
    c, subject_id = conn
    with c.cursor() as cur:
        paper_id = _make_paper(cur, subject_id)
        rec = _rec(7, "__pytest__ 题干甲", [{"label": "A", "text": "甲"}], "A")

        assert A.apply_record(cur, rec, apply=True).startswith("新增")
        assert _count(cur, "SELECT COUNT(*) FROM questions WHERE source=%s", (SOURCE,)) == 1

        # questions 表没有 needs_review 列，人工确认只体现为 is_active=1
        cur.execute("SELECT q.id, q.is_active, q.answer FROM paper_questions pq "
                    "JOIN questions q ON q.id=pq.question_id WHERE pq.paper_id=%s", (paper_id,))
        qid, active, answer = cur.fetchone()
        assert (int(active), answer) == (1, "A")

        # 同一题号再来一次：原址更新，不新增
        rec2 = _rec(7, "__pytest__ 题干乙", [{"label": "A", "text": "乙"}], "B")
        assert A.apply_record(cur, rec2, apply=True).startswith("更新")
        assert _count(cur, "SELECT COUNT(*) FROM questions WHERE source=%s", (SOURCE,)) == 1
        cur.execute("SELECT q.content, q.answer FROM questions q WHERE q.id=%s", (qid,))
        assert cur.fetchone() == ("__pytest__ 题干乙", "B")


def test_question_no_follows_group_order_and_gap_is_preserved(conn):
    """补回缺题后，question_no 用卷面题号，缺号保持空缺（与 db_loader 同口径）。"""
    c, subject_id = conn
    with c.cursor() as cur:
        paper_id = _make_paper(cur, subject_id)
        for go in (1, 2, 4):                       # 缺 3
            A.apply_record(cur, _rec(go, f"__pytest__ 题{go}"), apply=True)

        cur.execute("SELECT question_no, group_order FROM paper_questions "
                    "WHERE paper_id=%s ORDER BY question_no", (paper_id,))
        assert cur.fetchall() == ((1, 1), (2, 2), (4, 4))

        # 补上题 3 后重排，题号对齐且仍然保留卷面编号
        A.apply_record(cur, _rec(3, "__pytest__ 题3"), apply=True)
        cur.execute("SELECT question_no, group_order FROM paper_questions "
                    "WHERE paper_id=%s ORDER BY question_no", (paper_id,))
        assert cur.fetchall() == ((1, 1), (2, 2), (3, 3), (4, 4))
        assert _count(cur, "SELECT question_count FROM exam_papers WHERE id=%s",
                      (paper_id,)) == 4


def test_dry_run_writes_nothing(conn):
    c, subject_id = conn
    with c.cursor() as cur:
        paper_id = _make_paper(cur, subject_id)
        msg = A.apply_record(cur, _rec(5, "__pytest__ 干跑"), apply=False)

        assert "新增" in msg
        assert _count(cur, "SELECT COUNT(*) FROM questions WHERE source=%s", (SOURCE,)) == 0
        assert _count(cur, "SELECT COUNT(*) FROM paper_questions WHERE paper_id=%s",
                      (paper_id,)) == 0


def test_same_stem_different_options_land_as_two_questions(conn):
    """题干相同、选项不同 → 两题（哈希含选项，不会撞唯一索引）。"""
    c, subject_id = conn
    with c.cursor() as cur:
        paper_id = _make_paper(cur, subject_id)
        A.apply_record(cur, _rec(7, "下列说法正确的是",
                                 [{"label": "A", "text": "甲"}], ""), apply=True)
        A.apply_record(cur, _rec(17, "下列说法正确的是",
                                 [{"label": "A", "text": "乙"}], ""), apply=True)

        assert _count(cur, "SELECT COUNT(*) FROM paper_questions WHERE paper_id=%s",
                      (paper_id,)) == 2
        assert _count(cur, "SELECT COUNT(*) FROM questions WHERE source=%s", (SOURCE,)) == 2
