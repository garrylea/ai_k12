"""apply_fixes_cli：人工补题的写库分支（新增/更新/跳过/幂等）。"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import apply_fixes_cli as A  # noqa: E402


class FakeCursor:
    """按 SQL 片段返回预设结果，记录所有执行过的语句。"""

    def __init__(self, paper=None, existing=None, renumber_rows=None):
        self.sql: list[tuple[str, tuple | None]] = []
        self.paper = paper                # (paper_id, subject_id)
        self.existing = existing          # question_id 或 None
        self.renumber_rows = renumber_rows or []
        self.rowcount = 1
        self.lastrowid = 777
        self._rows: list = []

    def execute(self, sql, args=None):
        self.sql.append((sql, args))
        if "FROM exam_papers WHERE source_key" in sql:
            self._rows = [self.paper] if self.paper else []
        elif "SELECT question_id FROM paper_questions" in sql:
            self._rows = [(self.existing,)] if self.existing else []
        elif "SELECT question_id, group_order FROM paper_questions" in sql:
            self._rows = list(self.renumber_rows)
        else:
            self._rows = []

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


REC = {
    "source": "物理-卷A-试卷",
    "rel_path": "物理/初中/first/2024/卷A",
    "group_order": 28,
    "content": "题干",
    "options": [{"label": "A", "text": "甲"}],
    "answer": "A",
    "material_text": None,
}


def test_skips_when_paper_missing_from_db():
    cur = FakeCursor(paper=None)
    msg = A.apply_record(cur, REC, apply=True)

    assert msg.startswith("跳过")
    assert not any(sql.startswith(("INSERT", "UPDATE")) for sql, _ in cur.sql)


def test_inserts_new_question_when_group_order_absent():
    cur = FakeCursor(paper=(54, 4), existing=None, renumber_rows=[(777, 28)])
    msg = A.apply_record(cur, REC, apply=True)

    inserts = [a for sql, a in cur.sql if sql.startswith("INSERT INTO questions")]
    assert len(inserts) == 1
    assert msg.startswith("新增")
    # 题号、题干、选项 JSON 都要落到 INSERT 参数里
    assert inserts[0][1] == 28
    assert inserts[0][4] == "题干"
    assert '"A"' in inserts[0][5]
    # 新题必须挂到卷上
    assert any("INSERT IGNORE INTO paper_questions" in sql for sql, _ in cur.sql)


def test_updates_existing_question_in_place():
    cur = FakeCursor(paper=(54, 4), existing=6058, renumber_rows=[(6058, 28)])
    msg = A.apply_record(cur, REC, apply=True)

    assert msg.startswith("更新")
    updates = [a for sql, a in cur.sql if sql.startswith("UPDATE questions SET")]
    assert len(updates) == 1
    assert updates[0][-1] == 6058
    assert not any(sql.startswith("INSERT INTO questions") for sql, _ in cur.sql)


def test_dry_run_writes_nothing_but_reports_action():
    cur = FakeCursor(paper=(54, 4), existing=6058)
    msg = A.apply_record(cur, REC, apply=False)

    assert "更新" in msg and "6058" in msg
    assert not any(sql.startswith(("INSERT", "UPDATE", "DELETE")) for sql, _ in cur.sql)


def test_renumbers_and_refreshes_question_count():
    cur = FakeCursor(paper=(54, 4), existing=None, renumber_rows=[(777, 28), (778, 29)])
    A.apply_record(cur, REC, apply=True)

    renumber = [sql for sql, _ in cur.sql if "ROW_NUMBER()" in sql]
    count = [sql for sql, _ in cur.sql if "SET question_count" in sql]
    assert len(renumber) == 1 and len(count) == 1


def test_hash_includes_options_so_same_stem_does_not_collide():
    """两条同题干不同选项 = 两个哈希（配合 db_loader 的唯一索引）。"""
    from db_loader import content_hash

    a = content_hash("下列说法正确的是", [{"label": "A", "text": "甲"}])
    b = content_hash("下列说法正确的是", [{"label": "A", "text": "乙"}])
    assert a != b


def test_refuses_record_that_is_terminal_ui_echo():
    """界面文字被误当题目录进来时，写库这一步必须拦住。"""
    cur = FakeCursor(paper=(54, 4), existing=6058)
    rec = dict(REC, content="1\n──────────────\n请提供真题：1) 直接粘贴 Markdown")

    msg = A.apply_record(cur, rec, apply=True)

    assert msg.startswith("跳过")
    assert not any(sql.startswith(("INSERT", "UPDATE")) for sql, _ in cur.sql)


# ---------- 待入库记录的筛选 ----------

def _write_fix(tmp_path, rows):
    f = tmp_path / "fixes" / "卷A.jsonl"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                 encoding="utf-8")
    return f.parent


def test_pending_records_skips_applied(tmp_path):
    d = _write_fix(tmp_path, [
        {"source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
         "group_order": 28, "applied": True},
        {"source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
         "group_order": 27, "applied": False},
    ])
    assert [r["group_order"] for r in A.pending_records(fixes_dir=d)] == [27]


def test_pending_records_filters_subject_and_source(tmp_path):
    d = _write_fix(tmp_path, [
        {"source": "物理-海淀·一零一中学-试卷", "rel_path": "物理/初中/first/2024/一零一"},
        {"source": "物理-海淀·人大附中-试卷", "rel_path": "物理/初中/first/2024/人大附中"},
        {"source": "语文-海淀·一零一中学-试卷", "rel_path": "语文/初中/first/2024/一零一"},
    ])
    assert len(A.pending_records("物理", fixes_dir=d)) == 2
    assert [r["source"] for r in A.pending_records("物理", "人大附中", fixes_dir=d)] == \
        ["物理-海淀·人大附中-试卷"]


def test_pending_records_ignores_discarded_dir(tmp_path):
    d = tmp_path / "fixes"
    (d / "_discarded").mkdir(parents=True)
    (d / "_discarded" / "旧.jsonl").write_text(
        json.dumps({"source": "物理-卷A", "rel_path": "物理/x", "group_order": 1}) + "\n",
        encoding="utf-8")
    assert A.pending_records(fixes_dir=d) == []
