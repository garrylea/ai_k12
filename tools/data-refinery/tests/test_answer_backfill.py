"""answer_backfill 单测：范围/类型筛选、只补空、覆盖开关、无答案跳过。"""

from pathlib import Path
from types import SimpleNamespace

import answer_backfill
from scope_filter import build_scope
from subject_cases import ExtractedAnswer


def _cfg(tmp_path: Path):
    return SimpleNamespace(
        output_dir=tmp_path, db_host="h", db_port=3306,
        db_user="u", db_pass="", db_name="d",
    )


def _make_paper(tmp_path: Path, rel: str = "语文/初中/first/2025",
                stem: str = "语文-初三(上)-202507-海淀-（上）期中-试卷"):
    pub = tmp_path / "published" / rel / stem
    pub.mkdir(parents=True, exist_ok=True)
    jsonl = pub / f"{stem}.jsonl"
    jsonl.write_text('{"content": "x"}\n', encoding="utf-8")
    md = tmp_path / "md" / rel / stem / f"{stem}.md"
    md.parent.mkdir(parents=True, exist_ok=True)
    md.write_text("# 试卷\n\n参考答案\n1. A\n", encoding="utf-8")
    return jsonl, md


def _stub_case(answers):
    return lambda text, md_path: list(answers)


def test_iter_paper_jsonl_filters_scope_and_kind(tmp_path):
    _make_paper(tmp_path)
    # 教材卡文件名不含「试卷/答案」→ 不参与答案回填
    other = tmp_path / "published" / "数学/初中/人教版/九年级/上册/教材"
    other.mkdir(parents=True)
    (other / "数学-九上.jsonl").write_text("{}\n", encoding="utf-8")

    hits = answer_backfill.iter_paper_jsonl(
        tmp_path / "published", build_scope(subject="语文"),
    )
    assert [p.name for p in hits] == ["语文-初三(上)-202507-海淀-（上）期中-试卷.jsonl"]


def test_source_key_matches_db_loader(tmp_path):
    jsonl, _ = _make_paper(tmp_path)
    rel = jsonl.relative_to(tmp_path / "published")
    assert answer_backfill.source_key(rel) == (
        "语文/初中/first/2025/语文-初三(上)-202507-海淀-（上）期中-试卷/"
        "语文-初三(上)-202507-海淀-（上）期中-试卷"
    )


def _run(tmp_path, monkeypatch, *, overwrite=False, answers=None):
    _make_paper(tmp_path)
    payload = answers if answers is not None else [ExtractedAnswer(no=1, answer="A", explanation="")]
    monkeypatch.setattr(answer_backfill, "get_case", lambda subject: _stub_case(payload))
    monkeypatch.setattr(answer_backfill, "detect_subject", lambda rel: "chinese")
    monkeypatch.setattr(answer_backfill, "_connect", lambda cfg: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(answer_backfill, "_lookup_paper_id", lambda conn, key: 42)
    calls = []
    monkeypatch.setattr(
        answer_backfill, "importer_main", lambda argv: calls.append(argv) or 0,
    )
    stats = answer_backfill.backfill(
        _cfg(tmp_path), build_scope(subject="语文"), overwrite=overwrite,
    )
    return stats, calls, tmp_path


def test_fills_only_empty_by_default(tmp_path, monkeypatch):
    stats, calls, root = _run(tmp_path, monkeypatch)
    assert stats["filled"] == 1
    assert len(calls) == 1
    argv = calls[0]
    assert "--paper-id" in argv and "42" in argv
    assert "--apply" in argv and "--yes" in argv
    assert argv[argv.index("--where") + 1] == "answer_empty"
    assert (root / "answers" / "语文-初三(上)-202507-海淀-（上）期中-试卷.md").exists()


def test_reanswer_omits_empty_filter(tmp_path, monkeypatch):
    _, calls, _ = _run(tmp_path, monkeypatch, overwrite=True)
    assert "--where" not in calls[0]


def test_skips_when_no_answer_section(tmp_path, monkeypatch, capsys):
    stats, calls, root = _run(tmp_path, monkeypatch, answers=[ExtractedAnswer(no=1, answer="")])
    assert stats["no_answer"] == 1
    assert calls == []
    assert not (root / "answers").exists()
    assert "没有参考答案段" in capsys.readouterr().out


def test_skips_when_md_missing(tmp_path, monkeypatch, capsys):
    _make_paper(tmp_path)
    (tmp_path / "md").rename(tmp_path / "md_moved")
    monkeypatch.setattr(answer_backfill, "get_case", _stub_case([]))
    monkeypatch.setattr(answer_backfill, "_connect", lambda cfg: SimpleNamespace(close=lambda: None))
    stats = answer_backfill.backfill(_cfg(tmp_path), build_scope(subject="语文"))
    assert stats["no_md"] == 1
    assert "无 md 1" in capsys.readouterr().out
