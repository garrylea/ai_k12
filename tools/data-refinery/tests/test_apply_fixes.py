"""apply_fixes_cli：人工补题的写库分支（新增/更新/跳过/幂等）。"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import apply_fixes_cli as A  # noqa: E402
import apply_fixes as _impl  # noqa: E402


class FakeCursor:
    """按 SQL 片段返回预设结果，记录所有执行过的语句。"""

    def __init__(self, paper=None, existing=None, renumber_rows=None,
                 existing_active=1, hash_row=None, existing_hash=None, orphan_id=None):
        self.sql: list[tuple[str, tuple | None]] = []
        self.paper = paper                # (paper_id, subject_id)
        self.existing = existing          # question_id 或 None
        self.existing_active = existing_active
        self.hash_row = hash_row          # 同 content_hash 的行（重导后遗留的孤儿题）
        self.existing_hash = existing_hash
        self.orphan_id = orphan_id        # 同卷同题号、但没挂关联的旧行
        self.renumber_rows = renumber_rows or []
        self.rowcount = 1
        self.lastrowid = 777
        self._rows: list = []

    def execute(self, sql, args=None):
        self.sql.append((sql, args))
        if "FROM exam_papers WHERE source_key" in sql:
            self._rows = [self.paper] if self.paper else []
        elif "SELECT q.id FROM questions q WHERE q.source" in sql:
            self._rows = [(self.orphan_id,)] if self.orphan_id else []
        elif "SELECT question_id FROM paper_questions" in sql:
            self._rows = [(self.existing,)] if self.existing else []
        elif "SELECT q.id, q.is_active, q.content_hash FROM paper_questions" in sql:
            self._rows = ([(self.existing, self.existing_active, self.existing_hash)]
                          if self.existing else [])
        elif "SELECT id FROM questions WHERE content_hash" in sql:
            self._rows = [(self.hash_row,)] if self.hash_row else []
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


def test_reuses_orphan_row_with_same_content_hash():
    """重导只摘了关联、没删题：同 content_hash 的行还在，必须复用而不是 INSERT。

    （2026-11-01 人大附实测：题 7/16/18/23 的补题 hash 与遗留的 6338–6341 完全相同，
    直接 INSERT 会撞 UNIQUE(content_hash)，整批 --apply 失败。）
    """
    cur = FakeCursor(paper=(53, 4), existing=None, renumber_rows=[(6339, 16)],
                     hash_row=6339)
    msg = A.apply_record(cur, REC, apply=True)

    assert msg.startswith("复用") and "6339" in msg
    assert not any(sql.startswith("INSERT INTO questions") for sql, _ in cur.sql)
    assert any("UPDATE questions SET content" in sql and "is_active=1" in sql
               for sql, _ in cur.sql)
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


def test_dry_run_preview_shows_lengths_and_snippet():
    """预览必须能看出「改成什么」，不能只报更新/新增。"""
    cur = FakeCursor(paper=(54, 4), existing=6058, renumber_rows=[(6058, 28)])
    rec = dict(REC, content="新的题干内容" * 3)

    msg = A.apply_record(cur, rec, apply=False)

    assert "更新" in msg and "新内容 18 字" in msg
    assert "内容：新的题干内容" in msg
    assert not any(sql.startswith(("INSERT", "UPDATE")) for sql, _ in cur.sql)


def test_apply_materializes_images_before_writing(tmp_path):
    """补题内容里的 md 相对图必须物化，库里只写规范路径（2026-10-31 事故回归）。"""
    md_dir = tmp_path / "md" / "卷A"
    (md_dir / "images").mkdir(parents=True)
    (md_dir / "images" / "q3.jpg").write_bytes(b"\xff\xd8\xffq3")
    rec = dict(
        REC,
        content="如图 ![](images/q3.jpg) 求电流",
        answer="A",
        md=str(md_dir / "卷A.md"),
    )
    cur = FakeCursor(paper=(54, 4), existing=6061)

    msg = A.apply_record(cur, rec, apply=True, assets_root=tmp_path / "assets")

    assert msg.startswith("更新")
    sql, args = next((s, a) for s, a in cur.sql if s.startswith("UPDATE questions"))
    from apply_fixes import _source_key

    expected = f"questions/physics/{_source_key(rec)}/28/stem_01.jpg"
    assert expected in args[0]
    assert "images/q3.jpg" not in args[0]
    assert (tmp_path / "assets" / expected).exists()


def test_apply_rejects_when_image_source_missing(tmp_path):
    md_dir = tmp_path / "md" / "卷A"
    md_dir.mkdir(parents=True)
    rec = dict(
        REC,
        content="如图 ![](images/gone.jpg)",
        md=str(md_dir / "卷A.md"),
    )
    cur = FakeCursor(paper=(54, 4), existing=6061)

    msg = A.apply_record(cur, rec, apply=True, assets_root=tmp_path / "assets")

    assert msg.startswith("跳过") and "图片源文件缺失" in msg
    assert not any(sql.startswith(("INSERT", "UPDATE")) for sql, _ in cur.sql)


def test_apply_empty_answer_does_not_overwrite_existing():
    """补题记录没填答案时，不得把库里已有答案清空。"""
    rec = dict(REC, answer="")
    cur = FakeCursor(paper=(54, 4), existing=6061)

    A.apply_record(cur, rec, apply=True)

    sql, args = next((s, a) for s, a in cur.sql if s.startswith("UPDATE questions"))
    assert "COALESCE(NULLIF" in sql
    assert "" in args


def test_apply_writes_back_to_extracted_and_clears_publish_checkpoint(tmp_path):
    """补题必须回写 extracted，否则下次 import 会按旧题号对齐并摘掉补的题。"""
    out = tmp_path / "output"
    rel = "物理/初中/first/2024/卷A"
    src = "卷A"
    ext_file = out / "extracted" / rel / f"{src}.jsonl"
    ext_file.parent.mkdir(parents=True)
    rows = [
        {"group_order": 1, "content": "题1", "answer": "A", "subject_id": "physics"},
        {"group_order": 2, "content": "题2", "answer": "A", "subject_id": "physics"},
        {"group_order": 3, "content": "题3", "answer": "A", "subject_id": "physics"},
        {"group_order": 5, "content": "题5", "answer": "A", "subject_id": "physics"},
    ]
    ext_file.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    (out / ".publish_checkpoint.json").write_text(
        json.dumps({"published": [f"{rel}/{src}"], "publish_versions": {f"{rel}/{src}": 2}}),
        encoding="utf-8",
    )

    rec = dict(REC, rel_path=rel, source=src, group_order=4, content="补的第4题", answer="B")
    cur = FakeCursor(paper=(54, 4), existing=None)

    A.apply_record(cur, rec, apply=True, assets_root=tmp_path / "assets", output_dir=out)

    written = [json.loads(l) for l in ext_file.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert [r["group_order"] for r in written] == [1, 2, 3, 4, 5]
    assert written[3]["content"] == "补的第4题"
    ckpt = json.loads((out / ".publish_checkpoint.json").read_text(encoding="utf-8"))
    assert f"{rel}/{src}" not in ckpt.get("published", [])


def test_write_back_keeps_raw_md_refs(tmp_path):
    """extracted 保留 md 原始引用（images/...），物化只发生在 publish。"""
    out = tmp_path / "output"
    rel = "物理/初中/first/2024/卷B"
    src = "卷B"
    ext_file = out / "extracted" / rel / f"{src}.jsonl"
    ext_file.parent.mkdir(parents=True)
    ext_file.write_text(json.dumps({"group_order": 1, "content": "题1", "answer": "A"},
                                   ensure_ascii=False) + "\n", encoding="utf-8")
    md_dir = tmp_path / "md" / "卷B"
    (md_dir / "images").mkdir(parents=True)
    (md_dir / "images" / "q4.jpg").write_bytes(b"\xff\xd8\xffq4")

    rec = dict(REC, rel_path=rel, source=src, group_order=4,
               content="如图 ![](images/q4.jpg)", answer="A", md=str(md_dir / "卷B.md"))
    cur = FakeCursor(paper=(54, 4), existing=None)

    A.apply_record(cur, rec, apply=True, assets_root=tmp_path / "assets", output_dir=out)

    written = [json.loads(l) for l in ext_file.read_text(encoding="utf-8").splitlines() if l.strip()]
    row = next(r for r in written if r["group_order"] == 4)
    assert "images/q4.jpg" in row["content"]
    sql, args = next((s, a) for s, a in cur.sql if s.startswith("INSERT INTO questions"))
    assert "questions/physics/" in args[4] and "images/q4.jpg" not in args[4]


# ---------- 已入库的补题被重导冲掉：自动重放判据（2026-11-01）----------

def _rec16():
    return {"source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
            "group_order": "16"}


def test_replay_when_question_gone():
    cur = FakeCursor(paper=(53, 4), existing=None)
    assert _impl._replay_reason(cur, _rec16()) == "库中已无此题"


def test_replay_when_question_deactivated():
    """重导按 needs_review 重新停用，人工修复被覆盖 → 也要重放。"""
    cur = FakeCursor(paper=(53, 4), existing=6033, existing_active=0)
    assert "is_active=0" in (_impl._replay_reason(cur, _rec16()) or "")


def test_no_replay_when_question_healthy():
    cur = FakeCursor(paper=(53, 4), existing=6339, existing_active=1)
    assert _impl._replay_reason(cur, _rec16()) is None


def test_no_replay_when_paper_absent():
    """卷都没入库时不做判断，交给 apply_record 报「跳过」。"""
    cur = FakeCursor(paper=None)
    assert _impl._replay_reason(cur, _rec16()) is None


def test_update_sets_type_when_options_present():
    """补录带选项时必须把题型改成 choice（人大附题9/10 就是丢了选项后被存成简答题）。"""
    cur = FakeCursor(paper=(54, 4), existing=6058, renumber_rows=[(6058, 28)])
    A.apply_record(cur, REC, apply=True)

    update = next((sql, args) for sql, args in cur.sql
                  if sql.startswith("UPDATE questions SET"))
    assert "COALESCE(%s, IF(%s,'choice',type))" in update[0]
    assert update[1][2] is None, "没有指定大题题型时不强制"
    assert update[1][3] == 1, "有选项 → 置 choice"


def test_update_keeps_type_when_no_options():
    """只录题干（无选项）时不能把 fill_blank 之类的题型降级成简答题。"""
    rec = {**REC, "options": None}
    cur = FakeCursor(paper=(54, 4), existing=6058, renumber_rows=[(6058, 28)])
    A.apply_record(cur, rec, apply=True)

    update = next((sql, args) for sql, args in cur.sql
                  if sql.startswith("UPDATE questions SET"))
    assert update[1][3] == 0, "无选项 → 保持原题型"


def test_update_forces_group_type_for_type_mismatch():
    """type_mismatch 的记录带 expected_type：按大题题型写 type，不看选项拆没拆出来。"""
    rec = {**REC, "options": None, "expected_type": "choice"}
    cur = FakeCursor(paper=(54, 4), existing=6058, renumber_rows=[(6058, 28)])
    A.apply_record(cur, rec, apply=True)

    update = next((sql, args) for sql, args in cur.sql
                  if sql.startswith("UPDATE questions SET"))
    assert update[1][2] == "choice"


def test_replay_when_db_content_overwritten_by_reimport():
    """补题记录里有 applied_hash、库里内容哈希对不上 → 重导覆盖过，自动重放。"""
    rec = {**_rec16(), "applied_hash": "aaa"}
    cur = FakeCursor(paper=(53, 4), existing=6499, existing_active=1, existing_hash="bbb")
    assert _impl._replay_reason(cur, rec) == "库里这题的内容已被重新导入覆盖"


def test_no_replay_when_hash_matches():
    rec = {**_rec16(), "applied_hash": "aaa"}
    cur = FakeCursor(paper=(53, 4), existing=6499, existing_active=1, existing_hash="aaa")
    assert _impl._replay_reason(cur, rec) is None


def test_reuses_orphan_row_for_same_paper_and_number():
    """题号在库、关联被重导摘掉：必须更新那一行并重新挂卷，不能再插入一道同号题。"""
    cur = FakeCursor(paper=(53, 4), existing=None, renumber_rows=[(6340, 18)], orphan_id=6340)
    msg = A.apply_record(cur, REC, apply=True)

    assert "复用同号旧行" in msg and "6340" in msg
    assert not any(sql.startswith("INSERT INTO questions") for sql, _ in cur.sql)
    assert any("UPDATE questions SET content" in sql for sql, _ in cur.sql)
    assert any("INSERT IGNORE INTO paper_questions" in sql for sql, _ in cur.sql)
