import json

import pytest

import normalize_embedded_answers_cli as cli


def _row(qid=1, answer="答案：C\n解析：先判断。\n详解：完整过程。"):
    return cli.CleanupRow(
        question_id=qid,
        subject="math",
        type_="choice",
        answer=answer,
        approach=None,
        explanation=None,
        answer_verified=0,
    )


def test_build_changes_splits_and_appends_old_first():
    row = cli.CleanupRow(
        question_id=1,
        subject="math",
        type_="choice",
        answer="答案：C\n解析：新思路\n详解：新详解",
        approach="旧思路",
        explanation="旧详解",
        answer_verified=1,
    )
    changes, skipped = cli.build_cleanup_changes([row])
    assert skipped == []
    change = changes[0]
    assert change.after_answer == "C"
    assert change.after_approach == "旧思路\n\n新思路"
    assert change.after_explanation == "旧详解\n\n新详解"
    assert change.before.answer_verified == 1


def test_build_changes_skips_ambiguous_and_plain_text():
    rows = [
        _row(1, "答案：A\n解析：第一题\n答案：B"),
        _row(2, "解：x=2"),
    ]
    changes, skipped = cli.build_cleanup_changes(rows)
    assert changes == []
    assert skipped[0][0].question_id == 1
    assert "multiple_answer_sections" in skipped[0][1]
    assert len(skipped) == 1


class FakeCursor:
    def __init__(self, updates=None, select_rows=None):
        self.updates = updates or {}
        self.executed = []
        self.rowcount = 1
        self._rows = list(select_rows or [])

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if sql.lstrip().startswith("SELECT"):
            self._rows = list(self._select_rows or [])
        elif sql.lstrip().startswith("UPDATE"):
            self.rowcount = self.updates.get(params[-1], 1)

    def fetchall(self):
        return self._rows


class FakeConn:
    def __init__(self, select_rows=None):
        self.cursor_obj = FakeCursor(select_rows=select_rows)
        self.cursor_obj._select_rows = select_rows
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return self.cursor_obj

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


def test_write_backup_and_apply_changes(tmp_path):
    conn = FakeConn()
    changes, _ = cli.build_cleanup_changes([_row()])
    backup = tmp_path / "backup.jsonl"
    cli.write_backup(backup, changes)
    cli.apply_changes(conn, changes)
    assert backup.exists()
    assert json.loads(backup.read_text(encoding="utf-8"))["question_id"] == 1
    assert conn.committed is True
    assert conn.rolled_back is False


def test_apply_rolls_back_on_concurrent_change():
    conn = FakeConn()
    conn.cursor_obj.updates = {1: 0}
    changes, _ = cli.build_cleanup_changes([_row()])
    with pytest.raises(cli.ConcurrentChangeError):
        cli.apply_changes(conn, changes)
    assert conn.committed is False
    assert conn.rolled_back is True


def test_verify_changes_reports_mismatch():
    change = cli.build_cleanup_changes([_row()])[0][0]
    rows = [(
        change.question_id,
        change.after_answer,
        change.after_approach,
        change.after_explanation,
        0,
    )]
    assert cli.verify_changes(FakeConn(select_rows=rows), [change]) == []

    bad_rows = [(
        change.question_id,
        "旧值",
        change.after_approach,
        change.after_explanation,
        0,
    )]
    problems = cli.verify_changes(FakeConn(select_rows=bad_rows), [change])
    assert problems and "questions#1" in problems[0]


def test_preview_reports_merge_and_never_writes(monkeypatch, capsys):
    conn = FakeConn()
    monkeypatch.setattr(cli, "connect", lambda: conn)
    monkeypatch.setattr(cli, "load_rows", lambda _conn, _limit: [_row()])

    rc = cli.main([])

    out = capsys.readouterr().out
    assert rc == 0
    assert "旧字段后追加" in out
    assert "异常跳过" in out
    assert conn.committed is False
    assert not any(
        sql.lstrip().startswith("UPDATE")
        for sql, _params in conn.cursor_obj.executed
    )


def test_help_documents_apply_flag(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])
    assert exc.value.code == 0
    assert "--apply" in capsys.readouterr().out
