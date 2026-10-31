"""import_cli 单测：各阶段 argv 拼装 + 阶段顺序/跳过。"""

import import_cli
from import_cli import (
    convert_argv, extract_argv, load_argv, parse_args, publish_argv,
)


def _args(extra=None):
    return parse_args(["--subject", "语文", "--year", "2025", "--file", "海淀"] + (extra or []))


def test_convert_maps_file_to_materials_and_scope():
    argv = convert_argv(_args(["--dry-run", "--reconvert"]))
    assert "--subject" in argv and "语文" in argv
    assert "--year" in argv and "2025" in argv
    assert "--materials" in argv and "海淀" in argv
    assert "--file" not in argv  # convert 没有 --file
    assert "--dry-run" in argv and "--reconvert" in argv


def test_extract_keeps_file_and_throttle():
    a = _args(["--interval", "2", "--batch-size", "5", "--batch-sleep", "1", "--re-extract"])
    argv = extract_argv(a)
    assert "--file" in argv and "海淀" in argv
    assert argv[argv.index("--interval") + 1] == "2.0"
    assert argv[argv.index("--batch-size") + 1] == "5"
    assert argv[argv.index("--batch-sleep") + 1] == "1.0"
    assert "--reconvert" in argv  # re-extract 映射到 extract 的 --reconvert


def test_publish_maps_file_to_book():
    argv = publish_argv(_args(["--re-publish"]))
    assert "--book" in argv and "海淀" in argv
    assert "--file" not in argv
    assert "--reconvert" in argv


def test_load_always_incremental_and_kind_flags():
    argv = load_argv(_args(["--questions-only"]))
    assert "--load-cards" in argv
    assert "--purge-business-data" not in argv
    assert "--questions-only" in argv
    assert "--file" in argv and "海淀" in argv
    # 未要求 dry-run 时不传
    assert "--dry-run" not in argv


def test_redo_expands_to_all_three_redos():
    a = _args(["--redo"])
    assert "--reconvert" in convert_argv(a)
    assert "--reconvert" in extract_argv(a)
    assert "--reconvert" in publish_argv(a)


def test_main_runs_stages_in_order(monkeypatch):
    calls = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: calls.append((n, argv)))
    assert import_cli.main(["--subject", "语文", "--dry-run"]) == 0
    assert [c[0] for c in calls] == ["convert_main", "extract_main", "publish_main", "db_loader_main"]
    # 每阶段都带范围参数
    for _, argv in calls:
        assert "--subject" in argv and "语文" in argv


def test_main_skip_flags(monkeypatch):
    calls = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: calls.append(n))
    import_cli.main(["--subject", "语文", "--skip-convert", "--skip-load"])
    assert calls == ["extract_main", "publish_main"]


def test_questions_and_cards_only_mutually_exclusive():
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--questions-only", "--cards-only"])


def _stub_stages(monkeypatch):
    calls = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: calls.append(n))
    return calls


def test_file_only_multi_subject_refused(monkeypatch, capsys):
    calls = _stub_stages(monkeypatch)
    monkeypatch.setattr(import_cli, "_subjects_for_file", lambda args: {"语文", "数学", "物理"})
    rc = import_cli.main(["--file", "202507-海淀-模拟二-试卷"])
    out = capsys.readouterr().out
    assert rc == 2
    assert "命中了多个学科" in out and "拒绝执行" in out
    assert calls == []  # 一步都不跑


def test_file_only_multi_subject_dry_run_continues(monkeypatch, capsys):
    calls = _stub_stages(monkeypatch)
    monkeypatch.setattr(import_cli, "_subjects_for_file", lambda args: {"语文", "数学"})
    rc = import_cli.main(["--file", "202507-海淀", "--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "dry-run 继续" in out
    assert calls == ["convert_main", "extract_main", "publish_main", "db_loader_main"]


def test_file_with_subject_skips_guard(monkeypatch):
    calls = _stub_stages(monkeypatch)

    def boom(args):
        raise AssertionError("指定 --subject 时不应再扫描学科")

    monkeypatch.setattr(import_cli, "_subjects_for_file", boom)
    rc = import_cli.main(["--file", "202507-海淀", "--subject", "语文"])
    assert rc == 0
    assert len(calls) == 4


def _stub_all(monkeypatch):
    calls = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: calls.append(n))
    monkeypatch.setattr(
        import_cli, "answers_backfill",
        lambda cfg, scope, **kw: calls.append(("answers", kw)),
    )
    return calls


def test_answers_stage_runs_after_db_loader(monkeypatch):
    calls = _stub_all(monkeypatch)
    assert import_cli.main(["--subject", "语文"]) == 0
    assert calls == [
        "convert_main", "extract_main", "publish_main", "db_loader_main",
        ("answers", {"dry_run": False, "overwrite": False}),
    ]


def test_skip_answers(monkeypatch):
    calls = _stub_all(monkeypatch)
    import_cli.main(["--subject", "语文", "--skip-answers"])
    assert all(not (isinstance(c, tuple) and c[0] == "answers") for c in calls)


def test_skip_load_also_skips_answers(monkeypatch):
    calls = _stub_all(monkeypatch)
    import_cli.main(["--subject", "语文", "--skip-load"])
    assert "db_loader_main" not in calls
    assert all(not (isinstance(c, tuple) and c[0] == "answers") for c in calls)


def test_cards_only_does_not_backfill_answers(monkeypatch):
    calls = _stub_all(monkeypatch)
    import_cli.main(["--subject", "数学", "--cards-only"])
    assert all(not (isinstance(c, tuple) and c[0] == "answers") for c in calls)


def test_re_answer_passes_overwrite(monkeypatch):
    calls = _stub_all(monkeypatch)
    import_cli.main(["--subject", "语文", "--re-answer"])
    assert ("answers", {"dry_run": False, "overwrite": True}) in calls


def test_stops_when_stage_returns_nonzero(monkeypatch, capsys):
    """子 CLI 用 return 2 报错（MinerU token 过期等），不能忽略返回值继续跑。"""
    calls = []

    def boom(argv):
        calls.append("convert")
        return 2

    monkeypatch.setattr(import_cli, "convert_main", boom)
    monkeypatch.setattr(import_cli, "extract_main", lambda argv: calls.append("extract"))
    monkeypatch.setattr(import_cli, "publish_main", lambda argv: calls.append("publish"))
    monkeypatch.setattr(import_cli, "db_loader_main", lambda argv: calls.append("db_loader"))
    monkeypatch.setattr(import_cli, "answers_backfill", lambda *a, **k: calls.append("answers"))

    rc = import_cli.main(["--subject", "语文"])
    assert rc == 2
    assert calls == ["convert"]
    assert "已停止" in capsys.readouterr().out


# ---------- --files（一次导入多份卷） ----------

def test_files_splits_keywords_and_tolerates_chinese_comma():
    args = parse_args(["--subject", "物理",
                       "--files", "一零一中学, 人大附中，北师大实验 "])
    assert import_cli._file_keywords(args) == ["一零一中学", "人大附中", "北师大实验"]


def test_files_empty_when_not_given():
    args = parse_args(["--subject", "物理"])
    assert import_cli._file_keywords(args) == []


def test_files_and_file_are_mutually_exclusive():
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--subject", "物理", "--file", "海淀", "--files", "人大附中"])


# ---------- 第 7 步：人工补题的触发条件 ----------

class _FakeStdin:
    def __init__(self, tty: bool):
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


def _fix_entry_args(extra=None, sources=("卷A",)):
    args = parse_args(["--subject", "物理"] + (extra or []))
    args._scanned_sources = set(sources)
    return args


def test_fix_entry_skips_when_nothing_scanned(monkeypatch, capsys):
    args = _fix_entry_args(sources=())
    import_cli._fix_entry(args)([])
    assert "没有待人工处理的题" in capsys.readouterr().out


def test_fix_entry_dry_run_does_not_prompt(monkeypatch, capsys):
    args = _fix_entry_args(["--dry-run"])
    monkeypatch.setattr("sys.stdin", _FakeStdin(tty=True))
    import_cli._fix_entry(args)([])
    assert "[dry-run]" in capsys.readouterr().out


def test_fix_entry_non_tty_prints_hint_instead_of_blocking(monkeypatch, capsys):
    args = _fix_entry_args()
    monkeypatch.setattr("sys.stdin", _FakeStdin(tty=False))
    import_cli._fix_entry(args)([])
    out = capsys.readouterr().out
    assert "非交互终端" in out and "fix_question_cli.py" in out


def test_fix_entry_skip_review_flag(monkeypatch, capsys):
    args = _fix_entry_args(["--skip-review"])
    monkeypatch.setattr("sys.stdin", _FakeStdin(tty=True))
    import_cli._fix_entry(args)([])
    assert "非交互终端" in capsys.readouterr().out


def test_fix_entry_tty_calls_review_with_scanned_sources(monkeypatch):
    seen = {}

    def fake_review(sources=None, **kw):
        seen["sources"] = sources
        return {"pending": 1, "fixed": 0, "skipped": 0}

    import manual_fix

    monkeypatch.setattr(manual_fix, "review_pending", fake_review)
    monkeypatch.setattr("sys.stdin", _FakeStdin(tty=True))
    import_cli._fix_entry(_fix_entry_args(sources=("卷A", "卷B")))([])

    assert seen["sources"] == {"卷A", "卷B"}


# ---------- Ctrl+C：一次就停（批量不再往下走） ----------

def _stub_stages_with_first(monkeypatch, first):
    """把四个子阶段换成桩；first 是「第一阶段」的行为。"""
    calls = []
    monkeypatch.setattr(import_cli, "convert_main", first)
    for name in ("extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: calls.append(n))
    return calls


def test_execute_returns_130_and_stops_remaining_stages(monkeypatch, capsys):
    def interrupted(argv):
        raise KeyboardInterrupt

    calls = _stub_stages_with_first(monkeypatch, interrupted)

    rc = import_cli.main(["--subject", "语文"])

    assert rc == 130
    assert calls == [], "中断后不能再跑后面的阶段"
    assert "中断" in capsys.readouterr().out


def test_files_batch_stops_after_one_interrupt(monkeypatch, capsys):
    """--files 三份：第一次 Ctrl+C 就整批退出，不能一份一份停。"""
    seen = []

    def fake_execute(args):
        seen.append(args.file)
        return 130

    monkeypatch.setattr(import_cli, "_execute", fake_execute)

    rc = import_cli.main(["--subject", "物理", "--files", "A,B,C"])

    assert rc == 130
    assert seen == ["A"], "中断后不该继续处理 B、C"
    assert "剩余 2 份未处理" in capsys.readouterr().out


def test_keyboard_interrupt_outside_stage_loop_is_130(monkeypatch):
    def boom(args):
        raise KeyboardInterrupt

    monkeypatch.setattr(import_cli, "_execute", boom)

    assert import_cli.main(["--subject", "物理"]) == 130


# ---------- 第 8 步：补题入库（预览 + 确认） ----------

class _TtyStdin:
    def __init__(self, text=""):
        self._lines = text.splitlines(keepends=True)

    def isatty(self):
        return True

    def readline(self):
        return self._lines.pop(0) if self._lines else ""


def _apply_args(extra=None):
    return parse_args(["--subject", "物理"] + (extra or []))


def test_apply_entry_no_pending(monkeypatch, capsys):
    import apply_fixes
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f: [])

    assert import_cli._apply_entry(_apply_args())([]) == 0
    assert "没有待入库的补题记录" in capsys.readouterr().out


def test_apply_entry_dry_run_only_previews(monkeypatch):
    import apply_fixes
    calls = []
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f: [{"source": "卷A"}])
    monkeypatch.setattr(apply_fixes, "run", lambda argv, **kw: calls.append(argv))

    assert import_cli._apply_entry(_apply_args(["--dry-run"]))([]) == 0
    assert len(calls) == 1 and "--dry-run" in calls[0]


def test_apply_entry_non_tty_prints_command(monkeypatch, capsys):
    import apply_fixes
    calls = []
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f: [{"source": "卷A"}])
    monkeypatch.setattr(apply_fixes, "run", lambda argv, **kw: calls.append(argv))
    monkeypatch.setattr("sys.stdin", _FakeStdin(tty=False))

    import_cli._apply_entry(_apply_args())([])
    out = capsys.readouterr().out
    assert "确认后写入" in out and "apply_fixes_cli.py --apply" in out
    assert len(calls) == 1 and "--dry-run" in calls[0], "非交互只预览，不许写库"


def test_apply_entry_writes_after_yes(monkeypatch, capsys):
    import apply_fixes
    calls = []
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f: [{"source": "卷A"}])
    monkeypatch.setattr(apply_fixes, "run", lambda argv, **kw: calls.append(argv))
    monkeypatch.setattr("sys.stdin", _TtyStdin("y\n"))

    import_cli._apply_entry(_apply_args())([])

    assert calls[-1][0] == "--apply", "确认后要真写"
    assert "--dry-run" not in calls[-1]


def test_apply_entry_declined_keeps_records(monkeypatch, capsys):
    import apply_fixes
    calls = []
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f: [{"source": "卷A"}])
    monkeypatch.setattr(apply_fixes, "run", lambda argv, **kw: calls.append(argv))
    monkeypatch.setattr("sys.stdin", _TtyStdin("\n"))

    import_cli._apply_entry(_apply_args())([])

    assert all("--apply" not in c for c in calls)
    out = capsys.readouterr().out
    assert "未写库，本次未写入的 1 条" in out and "卷A" in out, "回车后要把清单再贴一遍"


def test_preview_log_written_with_records(tmp_path, monkeypatch, capsys):
    import import_cli as ic

    monkeypatch.setattr(ic, "__file__", str(tmp_path / "src" / "import_cli.py"))
    recs = [{"source": "物理-卷A-试卷", "group_order": 27, "_file": "/x/a.jsonl"},
            {"source": "物理-卷A-试卷", "group_order": 28, "_file": "/x/a.jsonl"}]

    path = ic._write_preview_log(recs, ["--subject", "物理"])

    assert path is not None and path.exists()
    text = path.read_text(encoding="utf-8")
    assert "待写入 2 条" in text and "题27" in text and "题28" in text
    assert "清单已存到" in capsys.readouterr().out
