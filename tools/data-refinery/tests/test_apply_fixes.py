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
                 existing_active=1, hash_row=None, existing_hash=None, orphan_id=None,
                 material_url=None, siblings=None, existing_options_json=None,
                 existing_material_text=None, siblings_by_paper=None,
                 paper_question_rows=None):
        self.sql: list[tuple[str, tuple | None]] = []
        self.paper = paper                # (paper_id, subject_id)
        self.existing = existing          # question_id 或 None
        self.existing_active = existing_active
        self.hash_row = hash_row          # 同 content_hash 的行（重导后遗留的孤儿题）
        self.existing_hash = existing_hash
        self.orphan_id = orphan_id        # 同卷同题号、但没挂关联的旧行
        self.material_url = material_url  # 已外置的文章文档路径
        self.siblings = siblings or []    # 共用旧 material_url 的兄弟题
        self.existing_options_json = existing_options_json
        self.existing_material_text = existing_material_text
        self.siblings_by_paper = siblings_by_paper
        self.paper_question_rows = paper_question_rows
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
        elif "SELECT pq.group_order, q.id" in sql:
            self._rows = list(self.paper_question_rows or [])
        elif ("FROM questions q JOIN paper_questions pq" in sql
              and "pq.paper_id=%s" in sql and "q.material_url" in sql):
            self._rows = list(self.paper_question_rows or [])
        elif "JOIN paper_questions pq" in sql and "q.material_url=%s" in sql:
            if self.siblings_by_paper is not None and self.paper:
                self._rows = list(self.siblings_by_paper.get(self.paper[0], []))
            else:
                self._rows = list(self.siblings)
        elif "FROM questions WHERE material_url=%s" in sql:
            self._rows = list(self.siblings)
        elif "SELECT material_url, material_method, options, material_text FROM questions" in sql:
            self._rows = [(self.material_url, None, self.existing_options_json,
                           self.existing_material_text)]
        elif "SELECT material_url, material_method, options FROM questions" in sql:
            self._rows = [(self.material_url, None, self.existing_options_json)]
        elif "SELECT material_url FROM questions" in sql:
            self._rows = [(self.material_url,)]
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


def test_write_back_keeps_existing_type_and_difficulty(tmp_path):
    """无选项的题（填空/计算/证明）做内容修复时，不得把题型降级成简答题。

    2026-11-19 北师大实验第 14 题：填空题丢图后补图，回写按「无选项 = short_answer」
    重算，extracted 变 short_answer，重导后库里也变，被扫描报成「同大题题型不一致」。
    """
    out = tmp_path / "output"
    rel = "数学/初中/first/2025/卷C"
    src = "卷C"
    ext_file = out / "extracted" / rel / f"{src}.jsonl"
    ext_file.parent.mkdir(parents=True)
    rows = [{"group_order": 14, "content": "原题", "answer": "", "type": "fill_blank",
             "difficulty": 3, "group_id": "二"}]
    ext_file.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                        encoding="utf-8")

    rec = dict(REC, rel_path=rel, source=src, group_order=14, content="补图后的题",
               options=None, answer="")
    cur = FakeCursor(paper=(54, 4), existing=9001)

    A.apply_record(cur, rec, apply=True, assets_root=tmp_path / "assets", output_dir=out)

    row = json.loads(ext_file.read_text(encoding="utf-8").strip())
    assert row["content"] == "补图后的题"
    assert row["type"] == "fill_blank"
    assert row["difficulty"] == 3


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


def test_answer_only_updates_answer_without_touching_content(tmp_path):
    """只补答案：题面/选项/图片一律不动，只写 answer。"""
    cur = FakeCursor(paper=(54, 4), existing=6058)
    rec = {**REC, "answer_only": True, "answer": "42"}

    msg = _impl.apply_record(cur, rec, apply=True, output_dir=tmp_path)

    updates = [(sql, args) for sql, args in cur.sql
               if sql.startswith("UPDATE questions SET answer")]
    assert len(updates) == 1
    assert updates[0][1] == ("42", 6058)
    assert not any("SET content=" in sql for sql, _ in cur.sql)
    assert msg.startswith("更新答案")


def test_answer_only_preview_does_not_write(tmp_path):
    cur = FakeCursor(paper=(54, 4), existing=6058)
    rec = {**REC, "answer_only": True, "answer": "42"}

    msg = _impl.apply_record(cur, rec, apply=False, output_dir=tmp_path)

    assert "只补答案" in msg and "题面不动" in msg
    assert not any(sql.startswith("UPDATE") for sql, _ in cur.sql)


def test_orphan_relink_allowed_when_fix_has_no_material_text():
    """Q20 类：文章已外置但补题不带 material_text，必须允许重挂卷。"""
    rec = {**REC, "source": "语文-模拟二", "group_order": 20,
           "content": "阅读第一封信，填写形容词并说明理由。", "material_text": None}
    cur = FakeCursor(paper=(17, 2), orphan_id=5182,
                     material_url="materials/chinese/x/content.md")
    msg = A.apply_record(cur, rec, apply=True)
    assert not msg.startswith("跳过"), msg
    relinks = [a for sql, a in cur.sql
               if "INSERT IGNORE INTO paper_questions" in sql and len(a or ()) >= 4]
    assert (17, 5182, 20, 20) in relinks


def test_externalized_material_still_blocks_when_fix_carries_material_text():
    rec = {**REC, "content": "阅读下文作答。", "material_text": "## 另一篇文章\n正文很长。"}
    cur = FakeCursor(paper=(17, 2), orphan_id=5182,
                     material_url="materials/chinese/x/content.md")
    msg = A.apply_record(cur, rec, apply=True)
    assert msg.startswith("跳过：材料归属未标明")
    assert not any("INSERT IGNORE INTO paper_questions" in sql for sql, _ in cur.sql)


def test_group_order_filter_limits_apply_scope(monkeypatch, tmp_path):
    """--group-order 只处理指定题号，避免把同卷其它 pending 补题一起写进去。"""
    import apply_fixes as impl

    recs = [
        {**REC, "group_order": 20, "applied": False},
        {**REC, "group_order": 24, "applied": False},
    ]
    called = []
    monkeypatch.setattr(impl, "_read_jsonl", lambda f: [dict(r) for r in recs])
    monkeypatch.setattr(impl, "apply_record",
                        lambda cur, rec, apply: called.append(rec["group_order"]) or "更新")
    monkeypatch.setattr(impl, "_write_jsonl", lambda f, rows: None)
    monkeypatch.setattr(impl, "mark_issue", lambda *a, **kw: 0)
    monkeypatch.setattr(impl, "_rescan", lambda *a, **kw: None)

    class FakeConn:
        def cursor(self):
            class Cur:
                def __enter__(self): return self
                def __exit__(self, *a): return False
                def execute(self, sql, args=None): return None
                def fetchone(self): return None
                def fetchall(self): return []
            return Cur()
        def commit(self):
            pass
        def rollback(self):
            pass
        def close(self):
            pass
    monkeypatch.setattr(impl.pymysql, "connect", lambda *a, **kw: FakeConn())
    (tmp_path / "卷A.jsonl").write_text("{}\n", encoding="utf-8")
    assert impl.run(["--fixes-dir", str(tmp_path), "--apply",
                     "--group-order", "20"]) == 0
    assert called == [20]


def test_inline_material_fix_on_externalized_row_keeps_article(tmp_path, monkeypatch):
    """题内素材修正（Q12 类）：可写 material_text，文章 URL 与 extracted 原文不动。"""
    import apply_fixes as impl

    calls = []
    monkeypatch.setattr(impl, "_patch_extracted",
                        lambda rec, **kw: calls.append(kw))
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "group_order": 12, "content": "题干",
           "material_text": "## 行香子\n秦观\n树绕村庄。",
           "material_scope": "inline"}
    cur = FakeCursor(paper=(17, 2), existing=5174,
                     material_url="materials/chinese/x/content.md")
    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert "跳过" not in msg
    assert calls and calls[0]["post_material_text"] == rec["material_text"]
    assert calls[0]["preserve_existing_material"] is True
    upd = [a for sql, a in cur.sql
           if sql.startswith("UPDATE questions SET content=")]
    assert upd and upd[0][6] == "manual"          # material_method
    assert upd[0][5] == rec["material_text"]       # DB 写题内素材；文章仍在 material_url


def test_article_fix_same_doc_key_rewrites_file_in_place(tmp_path, monkeypatch):
    """规范化后 key 不变：只改 content.md，URL/hash 不变，写 override 供 redo 用。"""
    import apply_fixes as impl

    written = []
    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)

    def fake_write(body, *, dry_run, **kwargs):
        written.append((body, dry_run))
        return ("samekey", "materials/chinese/samekey/content.md")

    import chinese_material_doc
    monkeypatch.setattr(chinese_material_doc, "write_material_doc", fake_write)
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "group_order": 9, "content": "题干",
           "material_text": "## 游山西村\n陆游\n修正后的诗文。",
           "material_scope": "article"}
    cur = FakeCursor(paper=(17, 2), existing=5171,
                     material_url="materials/chinese/samekey/content.md")
    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert "doc_key 不变" in msg
    assert len(written) == 2 and written[1][1] is False
    overrides = (tmp_path / "material_doc_overrides.jsonl").read_text(encoding="utf-8")
    assert "samekey" in overrides and "修正后的诗文" in overrides
    upd = [a for sql, a in cur.sql if sql.startswith("UPDATE questions SET content=")]
    assert upd and upd[0][5] is None                 # 不写 material_text


def test_legacy_inline_without_url_is_written(tmp_path, monkeypatch):
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    rec = {**REC, "rel_path": "物理/卷A", "source": "物理-卷A-试卷",
           "content": "阅读以下材料作答。(1)甲 (2)乙",
           "material_text": "材料正文很长很长。", "material_scope": "legacy_inline"}
    cur = FakeCursor(paper=(9, 5))
    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert "跳过" not in msg
    ins = [a for sql, a in cur.sql if sql.startswith("INSERT INTO questions")]
    assert ins and ins[0][8] == "manual"             # material_method


def test_hash_uses_material_url(tmp_path, monkeypatch):
    import apply_fixes as impl

    seen = []
    real = impl.content_hash
    monkeypatch.setattr(impl, "content_hash",
                        lambda *a: seen.append(a) or real(*a))
    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "content": "题干", "material_scope": "inline",
           "material_text": "题内素材"}
    cur = FakeCursor(paper=(17, 2), existing=5174,
                     material_url="materials/chinese/x/content.md")
    A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert seen and len(seen[0]) == 4 and seen[0][3] == "materials/chinese/x/content.md"


def test_skips_terminal_wrapped_material(tmp_path):
    """材料里带 │ 折行 / 标签被换行截断：拒收，不能写进库。"""
    rec = {**REC, "content": "│ 第一行\n│ 第二行"}
    cur = FakeCursor(paper=(17, 2))

    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)

    assert msg.startswith("跳过") and "折行" in msg
    assert not any(sql.startswith(("INSERT", "UPDATE")) for sql, _ in cur.sql)


def test_new_shared_article_writes_url_for_shared_groups(tmp_path, monkeypatch):
    """原本没有文章：新建 content.md，并把 material_url/哈希直接挂到共用题号。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    written = []

    def fake_write(body, *, dry_run, **kwargs):
        written.append((body, dry_run, kwargs.get("paper_scope")))
        return ("newkey", "materials/chinese/newkey/content.md")

    import chinese_material_doc
    monkeypatch.setattr(chinese_material_doc, "write_material_doc", fake_write)
    rec = {**REC, "source": "语文-模拟一", "rel_path": "语文/初中/second/2026/模拟一",
           "group_order": 14, "content": "阅读《鱼我所欲也》及下面两则材料…",
           "material_target": "article", "material_scope": "article",
           "material_text": "## 鱼我所欲也\n《孟子》\n鱼，我所欲也……",
           "material_share_with": [12, 13, 14]}
    cur = FakeCursor(
        paper=(17, 2), existing=5171, material_url=None,
        paper_question_rows=[
            (12, 5169, "第十二题", None, "h12", None, None),
            (13, 5170, "第十三题", None, "h13", None, None),
            (14, 5171, "第十四题", None, "h14", None, None),
        ],
    )

    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)

    assert "新建共享文章" in msg and "3 题" in msg
    assert written and written[-1][1] is False          # 真写盘
    url_updates = [a for sql, a in cur.sql
                   if sql.startswith("UPDATE questions SET material_url=")]
    assert len(url_updates) == 3
    assert {a[0] for a in url_updates} == {"materials/chinese/newkey/content.md"}


def test_article_fix_new_doc_key_syncs_same_paper_siblings(tmp_path, monkeypatch):
    """正文真变了：换 doc_key，只同步**同一份卷**里引用旧 URL 的题（不同卷各自独立）。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)

    def fake_write(body, *, dry_run, **kwargs):
        return ("newkey", "materials/chinese/newkey/content.md")

    import chinese_material_doc
    monkeypatch.setattr(chinese_material_doc, "write_material_doc", fake_write)
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "group_order": 9, "content": "题干",
           "material_text": "## 完全另一篇文章\n正文。", "material_scope": "article"}
    cur = FakeCursor(
        paper=(17, 2), existing=5171,
        material_url="materials/chinese/oldkey/content.md",
        paper_question_rows=[
            (5171, "语文-模拟二", "题干", None, "oldhash",
             "materials/chinese/oldkey/content.md"),
        ],
    )
    # 兄弟题补题记录里的 applied_hash 也要跟着换，否则 needing_replay 每次误报
    fixes = tmp_path / "manual_fixes"
    fixes.mkdir()
    (fixes / "模拟二.jsonl").write_text(json.dumps({
        "source": "语文-模拟二", "group_order": 9, "applied": True,
        "applied_hash": "oldhash",
    }, ensure_ascii=False) + "\n", encoding="utf-8")

    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert "doc_key oldkey→newkey" in msg and "1 道同卷题" in msg
    url_updates = [a for sql, a in cur.sql
                   if sql.startswith("UPDATE questions SET material_url=")]
    assert len(url_updates) == 1
    assert url_updates[0][0] == "materials/chinese/newkey/content.md"
    assert all(a[-1] != 9999 for a in url_updates), "别的卷不能被改"
    # applied_hash 已同步
    rows = [json.loads(l) for l in (fixes / "模拟二.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    assert rows[0]["applied_hash"] != "oldhash"
    overrides = (tmp_path / "material_doc_overrides.jsonl").read_text(encoding="utf-8")
    assert '"old_key": "oldkey"' in overrides and '"new_key": "newkey"' in overrides
    updated_rec = json.loads((fixes / "模拟二.jsonl").read_text(encoding="utf-8").strip())
    expected = impl.content_hash("题干", None, None,
                                 "materials/chinese/newkey/content.md")
    assert updated_rec["applied_hash"] == expected


def test_answer_only_record_with_material_is_not_blocked(tmp_path, monkeypatch):
    """旧 answer_only 记录带着 material_text 时不能被材料归属护栏拦住。"""
    import apply_fixes as impl

    called = []
    monkeypatch.setattr(impl, "_patch_extracted_answer", lambda *a, **kw: called.append(a))
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "group_order": 12, "answer": "示例", "answer_only": True,
           "material_text": "## 行香子\n题内素材（旧记录误带）"}
    cur = FakeCursor(paper=(17, 2), existing=5174,
                     material_url="materials/chinese/x/content.md")
    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert msg.startswith("更新答案")
    assert called and not any("材料归属未标明" in m for m in [msg])


def test_article_new_key_hash_collision_keeps_old_hash(tmp_path, monkeypatch):
    """换 URL 时撞 UNIQUE(content_hash)：保留旧 hash 并写冲突清单，不整批失败。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)

    def fake_write(body, *, dry_run, **kwargs):
        return ("newkey", "materials/chinese/newkey/content.md")

    import chinese_material_doc
    monkeypatch.setattr(chinese_material_doc, "write_material_doc", fake_write)
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "group_order": 9, "content": "题干",
           "material_text": "## 另一篇\n正文。", "material_scope": "article"}
    cur = FakeCursor(
        paper=(17, 2), existing=5171,
        material_url="materials/chinese/oldkey/content.md",
        paper_question_rows=[
            (5171, "语文-模拟二", "题干", None, "oldhash",
             "materials/chinese/oldkey/content.md"),
        ],
    )
    orig_exec = cur.execute

    def flaky(sql, args=None):
        if sql.startswith("UPDATE questions SET material_url=%s, content_hash=%s"):
            raise RuntimeError("Duplicate entry for key 'uniq_q_content_hash'")
        return orig_exec(sql, args)

    cur.execute = flaky
    A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert "5171" in (tmp_path / "content_hash_conflicts.jsonl").read_text(encoding="utf-8")
    assert any(sql.startswith("UPDATE questions SET material_url=%s WHERE id=%s")
               for sql, _ in cur.sql)


def test_inline_material_fix_without_url(tmp_path, monkeypatch):
    """文章还没外置时，inline 材料直接写 material_text，method=manual。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "group_order": 12, "content": "题干", "material_text": "## 短文\n正文",
           "material_scope": "inline"}
    cur = FakeCursor(paper=(17, 2), existing=5173)   # material_url=None
    A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    upd = [a for sql, a in cur.sql if sql.startswith("UPDATE questions SET content=")]
    assert upd and upd[0][5] == "## 短文\n正文" and upd[0][6] == "manual"


def test_stem_only_fix_preserves_existing_options(tmp_path, monkeypatch):
    """只补题干时 options=None，不能把原题 A/B/C/D 选项整列抹掉。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    opts = [{"label": "A", "text": "甲"}, {"label": "B", "text": "乙"},
            {"label": "C", "text": "丙"}, {"label": "D", "text": "丁"}]
    rec = {**REC, "source": "语文-卷", "rel_path": "语文/卷",
           "group_order": 7, "content": "选出下列词语正确的一项（修正）",
           "options": None}
    cur = FakeCursor(paper=(17, 2), existing=5174,
                     existing_options_json=json.dumps(opts, ensure_ascii=False))
    A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    upd = [a for sql, a in cur.sql if sql.startswith("UPDATE questions SET content=")]
    assert upd and [o["label"] for o in json.loads(upd[0][1])] == ["A", "B", "C", "D"]


def test_one_bad_record_does_not_roll_back_whole_batch(tmp_path, monkeypatch):
    """单条异常只回滚它自己：其它题照常写库，坏记录原因落清单。"""
    import apply_fixes as impl

    (tmp_path / "A.jsonl").write_text(json.dumps({
        "source": "A", "rel_path": "语文/A", "group_order": 1,
        "content": "甲", "applied": False,
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    (tmp_path / "B.jsonl").write_text(json.dumps({
        "source": "B", "rel_path": "语文/B", "group_order": 1,
        "content": "乙", "applied": False,
    }, ensure_ascii=False) + "\n", encoding="utf-8")

    commits: list[bool] = []
    notes: list[tuple] = []

    class Cur:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def execute(self, sql, args=None): return None
        def fetchone(self): return None
        def fetchall(self): return []

    class Conn:
        def cursor(self): return Cur()
        def commit(self): commits.append(True)
        def rollback(self): pass
        def close(self): pass

    monkeypatch.setattr(impl.pymysql, "connect", lambda *a, **kw: Conn())
    monkeypatch.setattr(impl, "mark_issue",
                        lambda src, go, status, **kw: notes.append((src, go, status, kw)))

    def flaky(cur, rec, apply, **kw):
        if rec["source"] == "B":
            raise RuntimeError("boom")
        rec["applied"] = True
        return "更新：ok"

    monkeypatch.setattr(impl, "apply_record", flaky)
    assert impl.run(["--fixes-dir", str(tmp_path), "--apply"]) == 0
    assert commits == [True]
    a = json.loads((tmp_path / "A.jsonl").read_text(encoding="utf-8").strip())
    b = json.loads((tmp_path / "B.jsonl").read_text(encoding="utf-8").strip())
    assert a["applied"] is True and b["applied"] is False
    assert any("boom" in str(n[3].get("note")) for n in notes)


def test_invalid_group_order_is_rejected_without_crashing(tmp_path, monkeypatch):
    """题号非数字的补题记录被单独退回，不影响整批。"""
    import apply_fixes as impl

    (tmp_path / "A.jsonl").write_text(json.dumps({
        "source": "A", "rel_path": "语文/A", "group_order": "第七题",
        "content": "甲", "applied": False,
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    assert impl.run(["--fixes-dir", str(tmp_path), "--apply"]) == 0
    row = json.loads((tmp_path / "A.jsonl").read_text(encoding="utf-8").strip())
    assert row["applied"] is False


# ---- material_url 三态（2026-11-21：题号丢失时人工指认文章归属）----

def _update_args(cur):
    """取 apply_record 写主表的 UPDATE 参数：index 8 = material_url。"""
    ups = [a for sql, a in cur.sql if sql.startswith("UPDATE questions SET content=")]
    assert ups, "没有写主表的 UPDATE"
    return ups[0]


def _fake_doc(tmp_path, url):
    """造一个已物化的文章文档，供指认 URL 的边界校验通过。"""
    path = tmp_path / "assets" / url
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# 文章\n正文", encoding="utf-8")


def test_explicit_material_url_written_and_hash_uses_it(tmp_path, monkeypatch):
    """显式 URL：写入该 URL，content_hash 也按它重算，不再走 _correct_article_doc。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    url = "materials/chinese/8e5d0eab131b/content.md"
    _fake_doc(tmp_path, url)
    seen = []
    real = impl.content_hash
    monkeypatch.setattr(impl, "content_hash", lambda *a: seen.append(a) or real(*a))
    monkeypatch.setattr(impl, "_correct_article_doc",
                        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("不应重算 doc_key")))

    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "group_order": 20, "content": "阅读第一封信，填空并说明理由。",
           "material_url": url}
    cur = FakeCursor(paper=(17, 2), existing=5182, material_url=None)
    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)

    assert "跳过" not in msg
    assert _update_args(cur)[8] == url               # 写库用的是指认的 URL
    assert seen[-1][3] == url                        # hash 也按它算
    assert rec["applied_hash"] == real(*seen[-1]) and len(rec["applied_hash"]) == 64


def test_explicit_null_clears_material_url(tmp_path, monkeypatch):
    """显式 null：人工确认本题无材料，把库里旧 URL 清成 NULL。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "content": "题干", "material_url": None}
    cur = FakeCursor(paper=(17, 2), existing=5182,
                     material_url="materials/chinese/oldkey/content.md")
    A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert _update_args(cur)[8] is None


def test_missing_url_field_keeps_db_url(tmp_path, monkeypatch):
    """字段不存在（旧记录 / 非 TTY 补题）：不动库里已有 material_url。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    old = "materials/chinese/8e5d0eab131b/content.md"
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二", "content": "题干"}
    cur = FakeCursor(paper=(17, 2), existing=5182, material_url=old)
    A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert _update_args(cur)[8] == old


def test_explicit_url_missing_doc_is_rejected(tmp_path, monkeypatch):
    """指认的 URL 没有对应文档：拒绝写库，避免前端 404。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "content": "题干", "material_url": "materials/chinese/nope/content.md"}
    cur = FakeCursor(paper=(17, 2), existing=5182, material_url=None)
    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert msg.startswith("跳过")
    assert not any(sql.startswith("UPDATE questions SET content=") for sql, _ in cur.sql)


def test_duplicate_inline_text_is_healed_to_article(tmp_path, monkeypatch):
    """Q5 类：material_text 与文档是同段（仅差错字）→ 按文章修正并清空 material_text。"""
    import apply_fixes as impl

    calls = {}

    def fake_correct(cur, rec, text, old_url, output_dir, **kw):
        calls["text"] = text
        calls["old"] = old_url
        return ("materials/chinese/new/content.md", "doc_key old→new")

    monkeypatch.setattr(impl, "_correct_article_doc", fake_correct)
    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    doc_dir = tmp_path / "assets" / "materials" / "chinese" / "old"
    doc_dir.mkdir(parents=True)
    (doc_dir / "content.md").write_text(
        "## 第三站\n该中心舟搔传统展馆局限，融入市民生活。", encoding="utf-8")
    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二", "group_order": 5,
           "content": "文段中的画线句存在一处问题，请你修改。", "answer": "x",
           "material_text": "该中心开拓传统展馆局限，融入市民生活。"}
    cur = FakeCursor(paper=(17, 2), existing=5171,
                     material_url="materials/chinese/old/content.md",
                     existing_material_text="该中心开拓传统展馆局限，融入市民生活。")
    A.apply_record(cur, rec, apply=True, output_dir=tmp_path)
    assert calls.get("text", "").startswith("该中心开拓")
    args = _update_args(cur)
    assert args[5] is None, "重复的题内素材应被清空（不能 url+text 并存）"
    assert args[8] == "materials/chinese/new/content.md"


def _write_doc(root: Path, url: str, body: str) -> None:
    p = root / "assets" / url
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")


def test_article_fix_syncs_forked_sibling_by_content(tmp_path, monkeypatch):
    """同卷里同一篇文章被拆成两个 URL（分叉）：改文章时两处都要并到新 URL。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)

    old_url = "materials/chinese/oldkey/content.md"
    fork_url = "materials/chinese/forkkey/content.md"
    new_url = "materials/chinese/newkey/content.md"
    body = "## 同一篇\n正文一句。"
    _write_doc(tmp_path, old_url, body)
    _write_doc(tmp_path, fork_url, body)

    def fake_write(body, *, dry_run, **kwargs):
        return ("newkey", new_url)

    import chinese_material_doc
    monkeypatch.setattr(chinese_material_doc, "write_material_doc", fake_write)

    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "group_order": 9, "content": "题干",
           "material_text": "## 同一篇\n<u>正文一句。</u>", "material_scope": "article"}
    cur = FakeCursor(
        paper=(17, 2), existing=5171, material_url=old_url,
        paper_question_rows=[
            (5171, "语文-模拟二", "题干", None, "h1", old_url),
            (5172, "语文-模拟二", "题干", None, "h2", fork_url),
        ],
    )

    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)

    assert "2 道同卷题" in msg
    updated = [a for sql, a in cur.sql
               if sql.startswith("UPDATE questions SET material_url=%s, content_hash=%s")]
    assert {a[0] for a in updated} == {new_url}


def test_article_fix_in_place_pulls_forked_sibling_back(tmp_path, monkeypatch):
    """只改标注（doc_key 不变）：原地重写文档，同时把分叉的兄弟题并回同一个 URL。"""
    import apply_fixes as impl

    monkeypatch.setattr(impl, "_patch_extracted", lambda rec, **kw: None)
    old_url = "materials/chinese/oldkey/content.md"
    fork_url = "materials/chinese/forkkey/content.md"
    body = "## 同一篇\n正文一句。"
    _write_doc(tmp_path, old_url, body)
    _write_doc(tmp_path, fork_url, body)

    def fake_write(body, *, dry_run, **kwargs):
        return ("oldkey", old_url)

    import chinese_material_doc
    monkeypatch.setattr(chinese_material_doc, "write_material_doc", fake_write)

    rec = {**REC, "source": "语文-模拟二", "rel_path": "语文/模拟二",
           "group_order": 9, "content": "题干",
           "material_text": "## 同一篇\n<u>正文一句。</u>", "material_scope": "article"}
    cur = FakeCursor(
        paper=(17, 2), existing=5171, material_url=old_url,
        paper_question_rows=[
            (5171, "语文-模拟二", "题干", None, "h1", old_url),
            (5172, "语文-模拟二", "题干", None, "h2", fork_url),
        ],
    )

    msg = A.apply_record(cur, rec, apply=True, output_dir=tmp_path)

    assert "doc_key 不变" in msg
    updated = [(sql, a) for sql, a in cur.sql
               if sql.startswith("UPDATE questions SET material_url=%s, content_hash=%s")]
    assert len(updated) == 1 and updated[0][1][0] == old_url
    assert updated[0][1][2] == 5172, "只应把分叉出去的那道题并回来"
