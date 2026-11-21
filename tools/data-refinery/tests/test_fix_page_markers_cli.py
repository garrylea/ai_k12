import json
from pathlib import Path
from types import SimpleNamespace

import fix_page_markers_cli
from fix_page_markers_cli import (
    FieldFix,
    RowFix,
    apply_fixes,
    main,
    plan_fixes,
)
from page_markers import PageMarkerHit


def _row(**over):
    row = {
        "id": 1,
        "content": "",
        "material_text": None,
        "answer": None,
        "explanation": None,
        "approach": None,
        "options": None,
        "content_hash": None,
        "answer_verified": 0,
    }
    row.update(over)
    return row


def test_plan_fixes_content_change_recomputes_hash():
    rows = [_row(
        id=1,
        content="题干\n\n第5页（共8页）\n",
        options="[]",
        content_hash="a" * 64,
    )]
    fixes, manual, conflicts = plan_fixes(rows, {1: (2, 3)})
    assert manual == [] and conflicts == []
    assert len(fixes) == 1
    fix = fixes[0]
    assert fix.paper_id == 2 and fix.question_no == 3
    assert "第5页" not in fix.fields["content"]
    assert "题干" in fix.fields["content"]
    assert fix.new_content_hash is not None and len(fix.new_content_hash) == 64
    assert len(fix.field_fixes) == 1


def test_plan_fixes_skips_article_row():
    rows = [_row(
        id=1,
        content="题干\n\n第5页（共8页）\n",
        material_url="materials/chinese/a/content.md",
        content_hash="a" * 64,
    )]
    fixes, manual, conflicts = plan_fixes(rows, {1: (2, 3)})
    assert fixes == [] and manual == [] and conflicts == []


def test_plan_fixes_material_change_no_hash():
    rows = [_row(
        id=2,
        material_text="…一桥一水一九年级（语文）第8页（共11页）\n人家之间了",
        content_hash="b" * 64,
    )]
    fixes, _, _ = plan_fixes(rows, {2: (1, 19)})
    assert len(fixes) == 1
    fix = fixes[0]
    assert "第8页" not in fix.fields["material_text"]
    assert "一桥一水一人家之间了" in fix.fields["material_text"]
    assert fix.new_content_hash is None


def test_plan_fixes_manual_table_hit_not_changed():
    rows = [_row(
        id=3,
        content="<table><tr><td>第5页（共8页）</td></tr></table>",
    )]
    fixes, manual, _ = plan_fixes(rows, {})
    assert fixes == []
    assert len(manual) == 1
    assert "id=3" in manual[0]


def test_plan_fixes_hash_conflict_skips_whole_row():
    rows = [_row(
        id=4,
        content="题干\n第5页（共8页）",
        answer="答案\n第5页（共8页）",
        options="[]",
        content_hash="c" * 64,
    )]
    fixes, manual, conflicts = plan_fixes(
        rows, {4: (1, 4)}, hash_exists=lambda h, qid: True,
    )
    assert fixes == []
    assert manual == []
    assert len(conflicts) == 1
    assert "id=4" in conflicts[0]


class _Cursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        if self.conn.fail:
            raise RuntimeError("boom")
        self.conn.executed.append((sql, params))


class _Conn:
    def __init__(self, fail=False):
        self.fail = fail
        self.executed = []
        self.begins = 0
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return _Cursor(self)

    def begin(self):
        self.begins += 1

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        pass


def _row_fix():
    hits = (PageMarkerHit(line_no=3, raw="第5页（共8页）", whole_line=True),)
    return RowFix(
        question_id=7,
        fields={"content": "新题干", "answer": "新答案"},
        new_content_hash="d" * 64,
        paper_id=1,
        question_no=7,
        answer_verified=True,
        field_fixes=(
            FieldFix(7, "content", "旧题干\n第5页（共8页）", "新题干", hits),
            FieldFix(7, "answer", "旧答案\n第5页（共8页）", "新答案", hits),
        ),
    )


def test_apply_fixes_groups_row_update_and_writes_backup(tmp_path):
    conn = _Conn()
    backup = tmp_path / "backup.jsonl"
    updated = apply_fixes(conn, [_row_fix()], backup_path=backup)

    assert updated == 1
    assert conn.begins == 1 and conn.commits == 1 and conn.rollbacks == 0
    assert len(conn.executed) == 1
    sql, params = conn.executed[0]
    assert "content=%s" in sql and "answer=%s" in sql and "content_hash=%s" in sql
    assert params == ["新题干", "新答案", "d" * 64, 7]

    lines = [json.loads(x) for x in backup.read_text(encoding="utf-8").splitlines()]
    assert len(lines) == 2
    assert lines[0]["question_id"] == 7
    assert lines[0]["old"].startswith("旧题干")


def test_apply_fixes_rolls_back_on_failure(tmp_path):
    conn = _Conn(fail=True)
    try:
        apply_fixes(conn, [_row_fix()], backup_path=tmp_path / "backup.jsonl")
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")
    assert conn.rollbacks == 1
    assert conn.commits == 0


def test_main_requires_yes_for_apply(capsys):
    assert main(["--apply"]) == 2
    assert "--yes" in capsys.readouterr().err
    assert main(["--yes"]) == 2
    assert main(["--apply", "--dry-run", "--yes"]) == 2
    assert main(["--limit", "0"]) == 2


def test_main_dry_run_previews_without_write(tmp_path, monkeypatch, capsys):
    conn = _Conn()
    monkeypatch.setattr(fix_page_markers_cli, "_connect", lambda cfg: conn)
    monkeypatch.setattr(
        fix_page_markers_cli, "load_rows",
        lambda conn, **kw: [_row(id=8, content="题干\n第5页（共8页）")],
    )
    monkeypatch.setattr(
        fix_page_markers_cli, "load_paper_map",
        lambda conn, ids: {8: (3, 8)},
    )
    monkeypatch.setattr(
        fix_page_markers_cli, "RefineryConfig",
        SimpleNamespace(from_env=lambda **kw: SimpleNamespace(output_dir=tmp_path)),
    )

    assert main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "[scan] 扫描 5 个文本字段：命中 1 行 / 1 个字段" in out
    assert "[dry-run]" in out
    assert conn.executed == []


def test_main_apply_one_command_writes_and_verifies(tmp_path, monkeypatch, capsys):
    conn = _Conn()
    monkeypatch.setattr(fix_page_markers_cli, "_connect", lambda cfg: conn)
    monkeypatch.setattr(
        fix_page_markers_cli, "load_rows",
        lambda conn, **kw: [_row(id=9, content="题干\n第5页（共8页）")],
    )
    monkeypatch.setattr(
        fix_page_markers_cli, "load_paper_map",
        lambda conn, ids: {9: (4, 9)},
    )
    monkeypatch.setattr(
        fix_page_markers_cli, "RefineryConfig",
        SimpleNamespace(from_env=lambda **kw: SimpleNamespace(output_dir=tmp_path)),
    )
    monkeypatch.setattr(
        fix_page_markers_cli, "verify",
        lambda conn, **kw: (0, []),
    )

    assert main(["--apply", "--yes"]) == 0
    out = capsys.readouterr().out
    assert "[backup]" in out
    assert "[apply] 1 行更新" in out
    assert "[verify] 可自动清理的标记：0" in out
    assert len(conn.executed) == 1
    assert list(tmp_path.glob("page_marker_backup_*.jsonl"))
