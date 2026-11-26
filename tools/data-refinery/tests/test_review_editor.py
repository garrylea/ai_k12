"""review_editor：槽位输入与原样渲染（人工校对重构的输入原语）。"""

import io
from pathlib import Path

import review_editor as ed
from cli_ui import Console


def _c():
    return Console(color=False, width=60)


def test_read_slot_enter_is_unchanged(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    assert ed.read_slot(
        _c(), label="答案", hint="", current="旧答案", paper_md_dir=Path(".")
    ) == ("unchanged", "")


def test_read_slot_single_letters_are_content(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("e\nEOF\n"))
    assert ed.read_slot(
        _c(), label="答案", hint="", current="", paper_md_dir=Path(".")
    ) == ("value", "e")


def test_read_slot_at_path_is_content(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("@foo\nEOF\n"))
    assert ed.read_slot(
        _c(), label="答案", hint="", current="", paper_md_dir=Path(".")
    ) == ("value", "@foo")


def test_read_slot_clear(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO(":c\n"))
    assert ed.read_slot(
        _c(), label="答案", hint="", current="旧答案", paper_md_dir=Path(".")
    ) == ("clear", "")


def test_render_copyable_keeps_full_line_and_image_ref():
    stream = io.StringIO()
    c = Console(stream=stream, color=False, width=20)
    text = "甲" * 40 + "\n![](images/a.jpg)"
    ed.render_copyable(c, "题干", text)
    shown = stream.getvalue()
    assert "甲" * 40 in shown
    assert "![](images/a.jpg)" in shown
    assert "│" not in shown
