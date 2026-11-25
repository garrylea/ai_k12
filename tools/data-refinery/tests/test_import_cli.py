"""import_cli 单测：各阶段 argv 拼装 + 阶段顺序/跳过 + --file 入口解析。"""

from pathlib import Path

import pytest

import import_cli
from import_cli import (
    convert_argv, extract_argv, load_argv, meta_argv, parse_args, publish_argv,
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
    # 元数据阶段会读真实 output/md 并调 LLM，答案回填会扫真实 published；单测只管编排顺序
    monkeypatch.setattr(import_cli, "paper_meta_main", lambda argv: 0)
    monkeypatch.setattr(import_cli, "answers_backfill", lambda *a, **k: None)
    assert import_cli.main(["--subject", "语文", "--dry-run"]) == 0
    assert [c[0] for c in calls] == ["convert_main", "extract_main", "publish_main", "db_loader_main"]
    # 每阶段都带范围参数
    for _, argv in calls:
        assert "--subject" in argv and "语文" in argv


def test_main_skip_flags(monkeypatch):
    calls = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: calls.append(n))
    monkeypatch.setattr(import_cli, "paper_meta_main", lambda argv: 0)
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
    # 这两个阶段会读真实 output/ 并调 LLM / 扫 published；只管编排的单测不跑它们
    monkeypatch.setattr(import_cli, "paper_meta_main", lambda argv: 0)
    monkeypatch.setattr(import_cli, "answers_backfill", lambda *a, **k: None)
    return calls


def test_file_only_multi_subject_refused(monkeypatch, capsys):
    """多学科命中不再直接拒绝，而是列出来让人选（非交互终端才报错退出）。"""
    calls = _stub_stages(monkeypatch)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("语文/初中/second/2025/202507-海淀-模拟二-试卷"),
        Path("数学/初中/second/2025/202507-海淀-模拟二-试卷"),
        Path("物理/初中/second/2025/202507-海淀-模拟二-试卷"),
    ], []))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    rc = import_cli.main(["--file", "202507 海淀 模拟二"])
    out = capsys.readouterr().out
    assert rc == 2
    assert "命中 3 份" in out and "非交互终端无法选择" in out
    assert calls == []  # 一步都不跑


def test_file_only_multi_subject_dry_run_continues(monkeypatch, capsys):
    """dry-run 是只读的：多命中列出候选并继续预演，不逼用户选。"""
    calls = _stub_stages(monkeypatch)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("语文/初中/second/2025/202507-海淀-模拟二-试卷"),
        Path("数学/初中/second/2025/202507-海淀-模拟二-试卷"),
    ], []))

    rc = import_cli.main(["--file", "202507 海淀", "--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "命中 2 份" in out and "按全部候选预演" in out
    assert calls == ["convert_main", "extract_main", "publish_main", "db_loader_main"]


def test_file_with_subject_narrows_candidates(monkeypatch):
    calls = _stub_stages(monkeypatch)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("语文/初中/second/2025/202507-海淀-模拟二-试卷"),
        Path("数学/初中/second/2025/202507-海淀-模拟二-试卷"),
    ], []))

    rc = import_cli.main(["--file", "202507 海淀", "--subject", "语文"])
    assert rc == 0
    assert len(calls) == 4


def test_zero_hit_reports_what_is_missing(monkeypatch, capsys):
    """0 命中：说清在哪个范围、缺哪些词，并列出该范围现有素材；不跑任何阶段。"""
    calls = _stub_stages(monkeypatch)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("道法/初中/first/2026/2026北京西城初三（上）期中道德与法治"),
    ], []))

    rc = import_cli.main(["--subject", "道法", "--year", "2026", "--file", "2026 海淀"])
    out = capsys.readouterr().out
    assert rc == 2
    assert "在 道法/初中/first/2026 下没有同时含「2026」「海淀」的素材" in out
    assert "逐词命中：2026 → 1 份；海淀 → 0 份" in out
    assert "该范围现有 1 份" in out
    assert "2026北京西城" in out
    assert calls == []


def test_single_hit_rewrites_selector_for_all_stages(monkeypatch, capsys):
    """1 命中：打印命中的是哪份，并把精确相对路径传给各阶段（不再用模糊关键词）。"""
    seen = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: seen.append((n, argv)))
    monkeypatch.setattr(import_cli, "answers_backfill", lambda *a, **k: None)
    monkeypatch.setattr(import_cli, "paper_meta_main", lambda argv: 0)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("道法/初中/first/2026/2026北京海淀初三（上）期中道德与法治"),
    ], []))

    rc = import_cli.main(["--subject", "道法", "--file", "2026 海淀", "--skip-review"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "[解析] 2026 海淀 → 道法/初中/first/2026/2026北京海淀初三（上）期中道德与法治" in out
    for name, argv in seen:
        flag = "--materials-exact" if name == "convert_main" else "--file-exact"
        assert argv[argv.index(flag) + 1] == "道法/初中/first/2026/2026北京海淀初三（上）期中道德与法治"


def test_multi_hit_tty_selects_one(monkeypatch, capsys):
    """多命中 + 交互终端：选第 2 份后，各阶段只用第 2 份。"""
    seen = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: seen.append((n, argv)))
    monkeypatch.setattr(import_cli, "answers_backfill", lambda *a, **k: None)
    monkeypatch.setattr(import_cli, "paper_meta_main", lambda argv: 0)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("道法/初中/first/2026/2026北京海淀初三（上）期中道德与法治"),
        Path("道法/初中/first/2026/2026北京海淀·人大附中初三（上）期中道德与法治"),
    ], []))
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    answers = iter(["9\n", "2\n"])          # 第一次非法 → 重问；第二次选第 2 份
    monkeypatch.setattr("sys.stdin.readline", lambda: next(answers))

    rc = import_cli.main(["--file", "2026 海淀", "--skip-review"])
    assert rc == 0
    assert "请输入 1–2 之间的编号" in capsys.readouterr().out
    for _, argv in seen:
        joined = " ".join(argv)
        assert "人大附中" in joined
        assert "2026北京海淀初三（上）期中道德与法治" not in joined


def test_short_interactive_selection_uses_exact_path_for_downstream(monkeypatch):
    """选短卷时，长卷包含短卷全部关键词也不能被下游重新命中。"""
    short = Path(
        "英语/初中/first/2026/英语-初三(上)-202607-西城-期末-试卷")
    superset = Path(
        "英语/初中/first/2026/英语-初三(上)-202607-西城·三帆中学-期末-试卷")
    monkeypatch.setattr(import_cli, "_collect_candidates",
                        lambda cfg: ([short, superset], []))
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("sys.stdin.readline", lambda: "1\n")

    args = parse_args([
        "--subject", "英语", "--year", "2026",
        "--file", "初三 西城 期末 试卷",
    ])
    assert import_cli._resolve_file(args, object()) is None

    argv = extract_argv(args)
    assert argv[argv.index("--file-exact") + 1] == short.as_posix()
    assert "--file" not in argv

    for build_argv in (meta_argv, load_argv, publish_argv):
        downstream = build_argv(args)
        assert downstream[downstream.index("--file-exact") + 1] == short.as_posix()
        assert "--file" not in downstream
        assert "--book" not in downstream

    conversion = convert_argv(args)
    assert conversion[conversion.index("--materials-exact") + 1] == short.as_posix()
    assert "--materials" not in conversion


def test_short_interactive_selection_scan_uses_exact_source(monkeypatch):
    """选短卷后，识别扫描按精确 source 收窄，不能再扫到三帆卷。"""
    short = Path(
        "英语/初中/first/2026/英语-初三(上)-202607-西城-期末-试卷")
    superset = Path(
        "英语/初中/first/2026/英语-初三(上)-202607-西城·三帆中学-期末-试卷")
    monkeypatch.setattr(import_cli, "_collect_candidates",
                        lambda cfg: ([short, superset], []))
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("sys.stdin.readline", lambda: "1\n")
    args = parse_args([
        "--subject", "英语", "--year", "2026",
        "--file", "初三 西城 期末 试卷",
    ])
    assert import_cli._resolve_file(args, object()) is None

    seen = {}

    def fake_scan(subject, file, *, write, sources=None, redo=False):
        seen.update(subject=subject, file=file, write=write, sources=sources, redo=redo)
        return []

    import recognition_scan
    monkeypatch.setattr(recognition_scan, "run", fake_scan)
    import_cli._scan_entry(args)([])

    assert seen == {
        "subject": "英语",
        "file": None,
        "write": True,
        "sources": {short.name},
        "redo": False,
    }


def test_short_interactive_selection_manual_review_uses_exact_source(monkeypatch):
    """主动重录也不能把短卷关键词再匹配到三帆卷。"""
    short = Path(
        "英语/初中/first/2026/英语-初三(上)-202607-西城-期末-试卷")
    superset = Path(
        "英语/初中/first/2026/英语-初三(上)-202607-西城·三帆中学-期末-试卷")
    monkeypatch.setattr(import_cli, "_collect_candidates",
                        lambda cfg: ([short, superset], []))
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("sys.stdin.readline", lambda: "1\n")
    args = parse_args([
        "--subject", "英语", "--year", "2026",
        "--file", "初三 西城 期末 试卷",
    ])
    assert import_cli._resolve_file(args, object()) is None

    seen = {}

    def fake_review(subject, file, *, sources=None, fixes_dir=None):
        seen.update(subject=subject, file=file, sources=sources)
        return 0

    import manual_fix
    monkeypatch.setattr(manual_fix, "review_by_numbers", fake_review)
    import_cli._fix_entry(args)([])

    assert seen == {
        "subject": "英语",
        "file": None,
        "sources": {short.name},
    }


def test_short_interactive_selection_applies_fixes_to_exact_source(monkeypatch):
    """补题预览/写库也按精确 source 过滤，不能按短卷名的关键词串到三帆卷。"""
    short = Path(
        "英语/初中/first/2026/英语-初三(上)-202607-西城-期末-试卷")
    superset = Path(
        "英语/初中/first/2026/英语-初三(上)-202607-西城·三帆中学-期末-试卷")
    monkeypatch.setattr(import_cli, "_collect_candidates",
                        lambda cfg: ([short, superset], []))
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("sys.stdin.readline", lambda: "1\n")
    args = parse_args([
        "--subject", "英语", "--year", "2026",
        "--file", "初三 西城 期末 试卷",
    ])
    assert import_cli._resolve_file(args, object()) is None
    args.dry_run = True

    seen = {"pending": [], "replay": [], "run": []}

    def fake_pending(subject, source=None, *, sources=None):
        seen["pending"].append((subject, source, sources))
        return [{"source": short.name, "group_order": 1}]

    def fake_replay(subject, source=None, *, sources=None):
        seen["replay"].append((subject, source, sources))
        return []

    def fake_run(argv, *, via_pipeline=False):
        seen["run"].append((argv, via_pipeline))
        return 0

    import apply_fixes
    monkeypatch.setattr(apply_fixes, "pending_records", fake_pending)
    monkeypatch.setattr(apply_fixes, "needing_replay", fake_replay)
    monkeypatch.setattr(apply_fixes, "run", fake_run)
    import_cli._apply_entry(args)([])

    assert seen["pending"] == [("英语", None, {short.name})]
    assert seen["replay"] == [("英语", None, {short.name})]
    argv, via_pipeline = seen["run"][0]
    assert argv[argv.index("--source-exact") + 1] == short.name
    assert "--source" not in argv
    assert via_pipeline is True


def test_cancel_multi_hit_does_nothing(monkeypatch, capsys):
    calls = _stub_stages(monkeypatch)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("道法/初中/first/2026/卷A"),
        Path("道法/初中/first/2026/卷B"),
    ], []))
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("sys.stdin.readline", lambda: "\n")

    rc = import_cli.main(["--file", "卷"])
    assert rc == 2
    assert "未选择，未做任何改动" in capsys.readouterr().out
    assert calls == []


def test_scan_error_is_not_reported_as_zero_hit(monkeypatch, capsys):
    _stub_stages(monkeypatch)
    monkeypatch.setattr(import_cli, "_collect_candidates",
                        lambda cfg: ([], ["扫描素材目录 /x 失败：boom"]))

    rc = import_cli.main(["--file", "2026 海淀"])
    out = capsys.readouterr().out
    assert rc == 2
    assert "扫描素材目录 /x 失败：boom" in out
    assert "素材目录扫描失败，无法判断是否命中" in out
    assert "未命中" not in out


def _stub_all(monkeypatch):
    calls = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: calls.append(n))
    monkeypatch.setattr(import_cli, "paper_meta_main", lambda argv: 0)
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

    def fake_by_numbers(subject=None, file=None, **kw):
        seen["by_numbers"] = True
        return 0

    import manual_fix

    monkeypatch.setattr(manual_fix, "review_pending", fake_review)
    monkeypatch.setattr(manual_fix, "review_by_numbers", fake_by_numbers)
    monkeypatch.setattr("sys.stdin", _FakeStdin(tty=True))
    import_cli._fix_entry(_fix_entry_args(sources=("卷A", "卷B")))([])

    assert seen["sources"] == {"卷A", "卷B"}
    assert seen["by_numbers"] is True


def test_fix_entry_tty_offers_manual_reenter_without_scan_issues(monkeypatch):
    """没有扫描问题时也要问「还有哪道题要主动重录」（PDF→MD 丢图扫描未必能发现）。"""
    seen = {}

    def fake_by_numbers(subject=None, file=None, **kw):
        seen["called"] = True
        return 0

    import manual_fix

    monkeypatch.setattr(manual_fix, "review_pending",
                        lambda **kw: seen.setdefault("pending_called", True))
    monkeypatch.setattr(manual_fix, "review_by_numbers", fake_by_numbers)
    monkeypatch.setattr("sys.stdin", _FakeStdin(tty=True))
    import_cli._fix_entry(_fix_entry_args(sources=()))([])

    assert seen.get("called") is True
    assert "pending_called" not in seen      # 没问题就不进逐条补题


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
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f, **kw: [])
    monkeypatch.setattr(apply_fixes, "needing_replay", lambda s, f, **kw: [])

    assert import_cli._apply_entry(_apply_args())([]) == 0
    assert "已是最新" in capsys.readouterr().out


def test_apply_entry_dry_run_only_previews(monkeypatch):
    import apply_fixes
    calls = []
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f, **kw: [{"source": "卷A"}])
    monkeypatch.setattr(apply_fixes, "needing_replay", lambda s, f, **kw: [])
    monkeypatch.setattr(apply_fixes, "run", lambda argv, **kw: calls.append(argv))

    assert import_cli._apply_entry(_apply_args(["--dry-run"]))([]) == 0
    assert len(calls) == 1 and "--dry-run" in calls[0]


def test_apply_entry_non_tty_prints_command(monkeypatch, capsys):
    import apply_fixes
    calls = []
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f, **kw: [{"source": "卷A"}])
    monkeypatch.setattr(apply_fixes, "needing_replay", lambda s, f, **kw: [])
    monkeypatch.setattr(apply_fixes, "run", lambda argv, **kw: calls.append(argv))
    monkeypatch.setattr("sys.stdin", _FakeStdin(tty=False))

    import_cli._apply_entry(_apply_args())([])
    out = capsys.readouterr().out
    assert "下次运行同一条导入命令" in out, "只给一条入口，别再甩第二个脚本名"
    assert len(calls) == 1 and "--dry-run" in calls[0], "非交互只预览，不许写库"


def test_apply_entry_replays_lost_records(monkeypatch, capsys):
    """补过但被重导冲掉的记录：没有 pending 也要进闸门、也要问用户。"""
    import apply_fixes
    calls = []
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f, **kw: [])
    monkeypatch.setattr(apply_fixes, "needing_replay",
                            lambda s, f, **kw: [{"source": "卷A", "group_order": 16}])
    monkeypatch.setattr(apply_fixes, "run", lambda argv, **kw: calls.append(argv))
    monkeypatch.setattr("sys.stdin", _TtyStdin("y\n"))

    import_cli._apply_entry(_apply_args())([])

    out = capsys.readouterr().out
    assert "被重导冲掉需重放" in out
    assert calls[-1][0] == "--apply"


def test_apply_entry_writes_after_yes(monkeypatch, capsys):
    import apply_fixes
    calls = []
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f, **kw: [{"source": "卷A"}])
    monkeypatch.setattr(apply_fixes, "needing_replay", lambda s, f, **kw: [])
    monkeypatch.setattr(apply_fixes, "run", lambda argv, **kw: calls.append(argv))
    monkeypatch.setattr("sys.stdin", _TtyStdin("y\n"))

    import_cli._apply_entry(_apply_args())([])

    assert calls[-1][0] == "--apply", "确认后要真写"
    assert "--dry-run" not in calls[-1]


def test_apply_entry_declined_keeps_records(monkeypatch, capsys):
    import apply_fixes
    calls = []
    monkeypatch.setattr(apply_fixes, "pending_records", lambda s, f, **kw: [{"source": "卷A"}])
    monkeypatch.setattr(apply_fixes, "needing_replay", lambda s, f, **kw: [])
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


# ---------- --answers：指定答案/解析文件 ----------

class TestAnswersFileEntry:
    def _run(self, monkeypatch, tmp_path, name, content, *,
             file_kw="西城35中", dry_run=False, paper_id=None, lookup=420):
        from types import SimpleNamespace

        import answer_importer_cli

        path = tmp_path / name
        path.write_text(content, encoding="utf-8")
        calls = []
        monkeypatch.setattr(answer_importer_cli, "main",
                            lambda argv: calls.append(argv) or 0)
        monkeypatch.setattr(import_cli, "_lookup_paper_id", lambda cfg, kw: lookup)
        monkeypatch.setattr(import_cli.RefineryConfig, "from_env",
                            staticmethod(lambda *a, **k: None))
        args = SimpleNamespace(answers=str(path), file=file_kw,
                               dry_run=dry_run, paper_id=paper_id)
        rc = import_cli._answers_file_entry(args)()
        return rc, calls

    def test_md_uses_doc_with_resolved_paper_id(self, monkeypatch, tmp_path):
        rc, calls = self._run(monkeypatch, tmp_path, "a.md", "# 试卷：x\n")
        assert rc == 0
        assert calls == [[
            "--doc", str(tmp_path / "a.md"), "--paper-id", "420",
            "--apply", "--yes",
        ]]

    def test_md_dry_run_does_not_apply(self, monkeypatch, tmp_path):
        _, calls = self._run(monkeypatch, tmp_path, "a.md", "# 试卷：x\n", dry_run=True)
        assert calls == [["--doc", str(tmp_path / "a.md"), "--paper-id", "420"]]

    def test_jsonl_uses_records(self, monkeypatch, tmp_path):
        _, calls = self._run(monkeypatch, tmp_path, "a.jsonl", "{}\n")
        assert calls == [["--records", str(tmp_path / "a.jsonl"), "--apply", "--yes"]]

    def test_missing_file_returns_2(self, monkeypatch, tmp_path):
        from types import SimpleNamespace

        monkeypatch.setattr(import_cli.RefineryConfig, "from_env",
                            staticmethod(lambda *a, **k: None))
        args = SimpleNamespace(answers=str(tmp_path / "nope.md"),
                               file="x", dry_run=False, paper_id=None)
        assert import_cli._answers_file_entry(args)() == 2

    def test_explicit_paper_id_wins_over_file_lookup(self, monkeypatch, tmp_path):
        """卷名重名（昌平一中 = 语文卷 + 数学卷）时，--paper-id 必须原样透传。"""
        # 反查桩返回 420：若实现走反查，argv 里就会是 420 而不是 362
        _, calls = self._run(monkeypatch, tmp_path, "a.md", "# 试卷：昌平一中\n",
                             paper_id=362, lookup=420)
        assert calls == [["--doc", str(tmp_path / "a.md"), "--paper-id", "362",
                          "--apply", "--yes"]]

    def test_jsonl_ignores_paper_id(self, monkeypatch, tmp_path):
        _, calls = self._run(monkeypatch, tmp_path, "a.jsonl", "{}\n", paper_id=362)
        assert calls == [["--records", str(tmp_path / "a.jsonl"), "--apply", "--yes"]]

    def _run_pdf(self, monkeypatch, tmp_path, *, file_kw=None, dry_run=False,
                 paper_id=None, lookup=667, with_md=True):
        from types import SimpleNamespace

        import answer_extract_cli
        import answer_importer_cli

        input_dir = tmp_path / "crawler" / "data"
        rel = Path("语文") / "初中" / "first" / "2026" / "八中试卷答案"
        pdf = input_dir / rel.with_suffix(".pdf")
        pdf.parent.mkdir(parents=True, exist_ok=True)
        pdf.write_bytes(b"%PDF-1.3\n%\xc4\xe5\xf2\xe5\xeb\xa7")  # 不会真读内容
        md = tmp_path / "out" / "md" / rel / f"{rel.name}.md"
        if with_md:
            md.parent.mkdir(parents=True, exist_ok=True)
            md.write_text("# 参考答案\n1. A\n", encoding="utf-8")
        cfg = SimpleNamespace(input_dir=input_dir, output_dir=tmp_path / "out",
                              mineru_bin="mineru", mineru_timeout=1, mineru_token=None)
        monkeypatch.setattr(import_cli.RefineryConfig, "from_env",
                            staticmethod(lambda *a, **k: cfg))
        lookup_kw = []
        monkeypatch.setattr(import_cli, "_lookup_paper_id",
                            lambda c, kw: lookup_kw.append(kw) or lookup)
        extract_calls, import_calls = [], []
        monkeypatch.setattr(answer_extract_cli, "main",
                            lambda argv: extract_calls.append(argv) or 0)
        monkeypatch.setattr(answer_importer_cli, "main",
                            lambda argv: import_calls.append(argv) or 0)
        args = SimpleNamespace(answers=str(pdf), file=file_kw,
                               dry_run=dry_run, paper_id=paper_id)
        rc = import_cli._answers_file_entry(args)()
        return rc, lookup_kw, extract_calls, import_calls, md

    def test_pdf_strips_answer_suffix_and_writes_doc(self, monkeypatch, tmp_path):
        """PDF → 文件名去「答案」定位卷 → 复用 md → 提取文档 → --doc 回写。"""
        rc, lookup_kw, extract_calls, import_calls, md = self._run_pdf(
            monkeypatch, tmp_path)
        assert rc == 0
        assert lookup_kw == ["八中试卷"]  # 「答案」已剥掉，否则查库 0 命中
        doc = tmp_path / "out" / "answers" / "八中试卷答案.md"
        assert extract_calls == [[
            "--input-dir", str(md.parent), "--file", "八中试卷答案",
            "--subject", "chinese", "--out", str(doc),
        ]]
        assert import_calls == [[
            "--doc", str(doc), "--paper-id", "667", "--apply", "--yes",
        ]]

    def test_pdf_dry_run_does_not_apply(self, monkeypatch, tmp_path):
        _, _, _, import_calls, _ = self._run_pdf(monkeypatch, tmp_path, dry_run=True)
        assert import_calls == [[
            "--doc", str(tmp_path / "out" / "answers" / "八中试卷答案.md"),
            "--paper-id", "667",
        ]]

    def test_pdf_explicit_paper_id_skips_lookup(self, monkeypatch, tmp_path):
        _, lookup_kw, _, import_calls, _ = self._run_pdf(
            monkeypatch, tmp_path, paper_id=362)
        assert lookup_kw == []
        assert "--paper-id" in import_calls[0]
        assert import_calls[0][import_calls[0].index("--paper-id") + 1] == "362"

    def test_pdf_no_unique_paper_returns_2_without_extracting(self, monkeypatch, tmp_path):
        rc, _, extract_calls, import_calls, _ = self._run_pdf(
            monkeypatch, tmp_path, lookup=None)
        assert rc == 2
        assert extract_calls == [] and import_calls == []  # 定位失败不浪费 MinerU


def test_parse_args_accepts_answers():
    assert parse_args(["--answers", "a.md"]).answers == "a.md"


def test_parse_args_accepts_paper_id():
    assert parse_args(["--answers", "a.md", "--paper-id", "362"]).paper_id == 362


def test_parse_args_defaults_paired_answer_to_none():
    """不传 --file（全范围跑）时下游也能无条件读取 _paired_answer_rel。"""
    assert parse_args(["--subject", "语文"])._paired_answer_rel is None


def test_paper_id_requires_answers():
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--paper-id", "362"])


def test_paper_id_must_be_positive():
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--answers", "a.md", "--paper-id", "0"])


def test_answers_rejects_conflicting_flags():
    """--answers 只导答案：范围/重建参数与其它动作参数一律硬冲突，直接停下。"""
    import pytest

    for extra in (
        ["--subject", "语文"], ["--stage", "初中"], ["--term", "first"],
        ["--year", "2026"], ["--file", "八中"], ["--files", "八中,海淀"],
        ["--preview"], ["--cards-only"], ["--fix-only"],
        ["--reconvert"], ["--re-extract"], ["--re-publish"], ["--redo"],
    ):
        with pytest.raises(SystemExit):
            parse_args(["--answers", "a.pdf"] + extra)


def test_answers_conflict_message_names_the_flags(capsys):
    """报错要逐一点名冲突参数，用户一眼看到是哪几个要去掉。"""
    import pytest

    with pytest.raises(SystemExit):
        parse_args(["--answers", "a.pdf", "--subject", "语文", "--year", "2026"])
    err = capsys.readouterr().err
    assert "--subject" in err and "--year" in err and "--answers 只做答案导入" in err


def test_answers_only_detection():
    """只给 --answers 时只做答案导入（范围/重建组合已在 parse_args 处硬拒绝）。"""
    from types import SimpleNamespace

    assert import_cli._answers_only(parse_args(["--answers", "a.md"]))
    assert import_cli._answers_only(parse_args(["--answers", "a.md", "--dry-run"]))
    assert import_cli._answers_only(parse_args(["--answers", "a.md", "--paper-id", "667"]))
    base = dict(answers="a.md", file=None, files=None, subject=None, stage=None,
                term=None, year=None, reconvert=False, re_extract=False,
                re_publish=False, redo=False)
    assert not import_cli._answers_only(SimpleNamespace(**{**base, "subject": "数学"}))
    assert not import_cli._answers_only(SimpleNamespace(**{**base, "files": "西城35中"}))
    assert not import_cli._answers_only(SimpleNamespace(**{**base, "re_extract": True}))
    assert not import_cli._answers_only(parse_args(["--subject", "数学"]))


# ---------- --fix-only：只补题 ----------

def _stub_review_stages(monkeypatch):
    """把 1~6 步与 7/8/9 步都换成桩，返回调用序列。"""
    calls = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: calls.append(n))
    monkeypatch.setattr(import_cli, "answers_backfill",
                        lambda *a, **k: calls.append("answers"))

    def entry(name):
        return lambda args: (lambda argv: calls.append(name))

    monkeypatch.setattr(import_cli, "_scan_entry", entry("scan"))
    monkeypatch.setattr(import_cli, "_fix_entry", entry("fix"))
    monkeypatch.setattr(import_cli, "_apply_entry", entry("apply"))
    return calls


def test_fix_only_runs_only_review_stages(monkeypatch):
    """--fix-only 等价于手写那串 --skip-*：只跑扫描 → 补题 → 补题入库。"""
    calls = _stub_review_stages(monkeypatch)

    assert import_cli.main(["--subject", "物理", "--fix-only"]) == 0
    assert calls == ["scan", "fix", "apply"]


def test_fix_only_works_with_skip_review(monkeypatch):
    """--skip-review 只关掉补题交互，补题入库（第 9 步）仍要跑。"""
    calls = _stub_review_stages(monkeypatch)

    assert import_cli.main(["--subject", "物理", "--fix-only", "--skip-review"]) == 0
    assert calls == ["scan", "fix", "apply"]


def test_fix_only_rejects_conflicting_flags():
    """与 --answers / --cards-only / 重建参数同给时报错，别让人以为会顺带做那些事。"""
    import pytest

    for extra in (["--answers", "a.md"], ["--cards-only"], ["--reconvert"],
                  ["--re-extract"], ["--re-publish"], ["--redo"]):
        with pytest.raises(SystemExit):
            parse_args(["--subject", "物理", "--fix-only"] + extra)


def test_fix_only_parses_alone():
    args = parse_args(["--subject", "物理", "--fix-only"])
    assert args.fix_only is True


# ---------- 候选收集（卷/书粒度去重） ----------

def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")


def _cfg(tmp_path):
    from types import SimpleNamespace

    return SimpleNamespace(input_dir=tmp_path / "data", output_dir=tmp_path / "out")


def test_collect_candidates_dedupes_pdf_and_md(tmp_path):
    """同一份卷的 pdf 与已转 md 不能算成两份。"""
    cfg = _cfg(tmp_path)
    _touch(cfg.input_dir / "道法/初中/first/2026/卷子.pdf")
    _touch(cfg.output_dir / "md/道法/初中/first/2026/卷子.md")

    cands, errors = import_cli._collect_candidates(cfg)
    assert [c.as_posix() for c in cands] == ["道法/初中/first/2026/卷子"]
    assert errors == []


def test_collect_candidates_collapses_book_pages(tmp_path):
    """教材拆页 page_001/002 收敛成一本书，不能算成 N 份。"""
    cfg = _cfg(tmp_path)
    book = cfg.output_dir / "md/数学/初中/人教版/九年级/上册/书A"
    _touch(book / "page_001.md")
    _touch(book / "page_002.md")

    cands, _ = import_cli._collect_candidates(cfg)
    assert [c.as_posix() for c in cands] == ["数学/初中/人教版/九年级/上册/书A"]


def test_collect_candidates_nested_layout_not_doubled(tmp_path):
    """嵌套布局 卷名/卷名.md 只算一份（不能变成 卷名/卷名/卷名）。"""
    cfg = _cfg(tmp_path)
    _touch(cfg.output_dir / "md/语文/初中/second/2025/某卷/某卷.md")

    cands, _ = import_cli._collect_candidates(cfg)
    assert [c.as_posix() for c in cands] == ["语文/初中/second/2025/某卷"]


def test_collect_candidates_records_scan_error(tmp_path, monkeypatch):
    """扫描异常必须上报，不能静默吞掉变成「0 命中」。"""
    import scanner

    class Boom:
        def __init__(self, *_a, **_k):
            raise RuntimeError("权限不足")

    monkeypatch.setattr(scanner, "MaterialScanner", Boom)
    cands, errors = import_cli._collect_candidates(_cfg(tmp_path))
    assert cands == []
    assert any("扫描素材目录" in e and "权限不足" in e for e in errors)


def test_files_batch_resolves_each_keyword(monkeypatch):
    """--files 按逗号分份，每份各自解析一次（空格是同份内部的关键词）。"""
    monkeypatch.delenv  # noqa: B018  (占位，说明这里不依赖环境)
    stub_calls = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: 0)
    monkeypatch.setattr(import_cli, "answers_backfill", lambda *a, **k: None)
    monkeypatch.setattr(import_cli, "paper_meta_main", lambda argv: 0)

    def fake_collect(cfg):
        stub_calls.append(1)
        return ([Path("物理/初中/second/2025/一零一中学-期中-试卷"),
                 Path("物理/初中/second/2025/人大附中-期中-试卷")], [])

    monkeypatch.setattr(import_cli, "_collect_candidates", fake_collect)
    import_cli.main(["--subject", "物理", "--files", "一零一中学,人大附中", "--skip-review"])
    assert len(stub_calls) == 2


def test_file_matching_paper_and_answer_pair_resolves_to_paper(monkeypatch, capsys):
    """试卷/答案两个 PDF 时按卷名搜索会命中两份：自动收敛到试卷，不让人二选一。

    回归：旧行为提示「命中 2 份，先选一份」，选到答案那份就只转答案、不切题
    （海淀九年级语文期中 2026，答案没进库）。
    """
    seen = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: seen.append((n, argv)))
    monkeypatch.setattr(import_cli, "answers_backfill", lambda *a, **k: None)
    monkeypatch.setattr(import_cli, "paper_meta_main", lambda argv: 0)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("语文/初中/second/2026/海淀九年级语文（上）期中语文试题"),
        Path("语文/初中/second/2026/海淀九年级语文（上）期中语文试题_答案"),
    ], []))

    rc = import_cli.main(["--file", "海淀九年级语文（上）期中语文试题", "--skip-review"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "含配对答案" in out
    assert "先选一份" not in out
    for name, argv in seen:
        if name == "convert_main":
            value = argv[argv.index("--materials-exact") + 1]
            assert value == ("语文/初中/second/2026/海淀九年级语文（上）期中语文试题,"
                             "语文/初中/second/2026/海淀九年级语文（上）期中语文试题_答案")
        else:
            flag = "--file-exact"
            assert argv[argv.index(flag) + 1] == "语文/初中/second/2026/海淀九年级语文（上）期中语文试题"


def test_scan_entry_passes_redo_to_scan_run(monkeypatch):
    """--redo 必须传到第 7 步扫描，否则重新转出的卷旧 issue 记录不会被清。"""
    seen = {}

    def fake_scan_run(subject, file, *, write, sources=None, redo=False):
        seen.update(subject=subject, file=file, write=write, redo=redo)
        return []

    import recognition_scan
    monkeypatch.setattr(recognition_scan, "run", fake_scan_run)
    # _scan_entry 内部 `from recognition_scan import run as scan_run`，上面已替换模块属性

    args = _args(["--subject", "数学", "--file", "海淀数学(9)", "--redo"])
    import_cli._scan_entry(args)([])
    assert seen["redo"] is True

    # 不带 --redo 时默认为 False
    seen.clear()
    args2 = _args(["--subject", "数学", "--file", "海淀数学(9)"])
    import_cli._scan_entry(args2)([])
    assert seen["redo"] is False


def test_rebuild_flags_discard_old_fix_records(monkeypatch):
    """重转卷（--re-extract/--redo/--reconvert）时作废旧补题记录，避免覆盖新切题结果。"""
    import manual_fix
    _stub_all(monkeypatch)
    # 用真实存在的一份卷名，避免 _resolve_file 0 命中中止
    seen = []
    monkeypatch.setattr(
        manual_fix, "discard_fixes_for_source",
        lambda src, **kw: seen.append(src) or 0,
    )
    # 同时让 import_cli 的延迟 import 拿到同一个函数（延迟 import 在 _execute 内 from manual_fix import）
    monkeypatch.setattr(import_cli._execute.__globals__.get("manual_fix", manual_fix),
                        "discard_fixes_for_source",
                        lambda src, **kw: seen.append(src) or 0)

    import_cli.main(["--subject", "数学", "--file", "数学(9)", "--re-extract", "--skip-review"])
    assert seen, "重转时应调用 discard_fixes_for_source"
    assert "数学(9)" in seen[0] or "数学" in seen[0]

    # 不带重建标志时不调用
    seen.clear()
    import_cli.main(["--subject", "数学", "--file", "数学(9)", "--skip-review"])
    assert seen == []


def test_reload_paper_uses_reload_source_and_purge():
    a = parse_args(["--subject", "道法", "--file", "35中", "--reload-paper"])
    argv = load_argv(a)
    assert "--reload-source" in argv and "35中" in argv
    assert "--purge-paper-data" in argv
    assert "--load-cards" not in argv


def test_reload_paper_conflicts_with_cards_only():
    with pytest.raises(SystemExit):
        parse_args(["--file", "35中", "--reload-paper", "--cards-only"])


def test_reload_paper_conflicts_with_skip_load():
    with pytest.raises(SystemExit):
        parse_args(["--file", "35中", "--reload-paper", "--skip-load"])


def test_reload_paper_aborts_without_tty(monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    a = parse_args(["--file", "35中", "--reload-paper"])
    assert import_cli._confirm_reload(a) == 2


def test_file_resolves_paper_and_records_answer_sibling(monkeypatch):
    """命中只有试卷时，也要主动找到同目录答案，不能等关键词同时命中两份。"""
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("物理/初中/second/2026/X-试卷"),
        Path("物理/初中/second/2026/X-答案"),
    ], []))
    args = parse_args(["--subject", "物理", "--file", "X-试卷"])
    assert import_cli._resolve_file(args, object()) is None
    assert args.file == "X-试卷"
    assert args._resolved_rel == "物理/初中/second/2026/X-试卷"
    assert args._paired_answer_rel == "物理/初中/second/2026/X-答案"


def test_file_without_answer_leaves_pair_empty(monkeypatch):
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("物理/初中/second/2026/Y-试卷"),
    ], []))
    args = parse_args(["--subject", "物理", "--file", "Y"])
    assert import_cli._resolve_file(args, object()) is None
    assert args._paired_answer_rel is None


def test_file_answer_keyword_redirects_to_paper(monkeypatch, capsys):
    """直接输入答案名时改选它的试卷；否则只转答案、extract 跳过，0 题入库。"""
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("物理/初中/second/2026/X-试卷"),
        Path("物理/初中/second/2026/X-答案"),
    ], []))
    args = parse_args(["--subject", "物理", "--file", "X-答案"])
    assert import_cli._resolve_file(args, object()) is None
    assert args.file == "X-试卷"
    assert args._paired_answer_rel == "物理/初中/second/2026/X-答案"
    assert "命中的是答案" in capsys.readouterr().out


def test_two_papers_are_not_auto_paired():
    """两份试卷（不是试卷+答案）不能被当成一对。"""
    hits = [Path("物理/初中/second/2026/A-试卷"), Path("物理/初中/second/2026/B-试卷")]
    assert import_cli._pick_paired_paper(hits) is None


def test_convert_includes_paired_answer():
    a = parse_args(["--subject", "物理", "--file", "X-试卷"])
    a._resolved_rel = "物理/初中/second/2026/X-试卷"
    a._paired_answer_rel = "物理/初中/second/2026/X-答案"
    argv = convert_argv(a)
    value = argv[argv.index("--materials-exact") + 1]
    assert value == "物理/初中/second/2026/X-试卷,物理/初中/second/2026/X-答案"


def test_convert_without_pair_keeps_single_material():
    a = parse_args(["--subject", "物理", "--file", "X-试卷"])
    a._resolved_rel = "物理/初中/second/2026/X-试卷"
    a._paired_answer_rel = None
    argv = convert_argv(a)
    assert argv[argv.index("--materials-exact") + 1] == "物理/初中/second/2026/X-试卷"


def test_files_batch_pairs_each_keyword(monkeypatch):
    seen = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: seen.append((n, argv)))
    monkeypatch.setattr(import_cli, "answers_backfill", lambda *a, **k: None)
    monkeypatch.setattr(import_cli, "paper_meta_main", lambda argv: 0)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("物理/初中/second/2026/A-试卷"),
        Path("物理/初中/second/2026/A-答案"),
        Path("物理/初中/second/2026/B-试卷"),
    ], []))

    import_cli.main(["--subject", "物理", "--files", "A-试卷,B-试卷", "--skip-review"])
    materials = [argv[argv.index("--materials-exact") + 1]
                 for name, argv in seen if name == "convert_main"]
    assert materials[0] == ("物理/初中/second/2026/A-试卷,"
                            "物理/初中/second/2026/A-答案")
    assert materials[1] == "物理/初中/second/2026/B-试卷"
    assert "A-答案" not in materials[1]          # 第二轮不能继承上一轮的答案
