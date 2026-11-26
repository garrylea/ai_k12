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


def test_read_images_keeps_typed_order_and_dedupes(tmp_path, monkeypatch):
    a = tmp_path / "a.png"
    b = tmp_path / "b.png"
    a.write_bytes(b"A")
    b.write_bytes(b"B")
    monkeypatch.setattr("sys.stdin", io.StringIO(f"1\n{b},{a},{b}\neof\n"))

    mode, paths = ed.read_images(_c(), [], tmp_path)

    assert mode == "append"
    assert [p.name for p in paths] == ["b.png", "a.png"], "按书写顺序，重复路径被 hash 去重"


def test_read_images_clear(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("3\n"))

    assert ed.read_images(_c(), ["images/old.jpg"], tmp_path) == ("clear", [])


def test_read_images_collects_clipboard_until_empty(tmp_path, monkeypatch):
    one = tmp_path / "one.png"
    two = tmp_path / "two.png"
    one.write_bytes(b"one-content")
    two.write_bytes(b"two-content")
    seq = iter([one, two, None])
    monkeypatch.setattr(ed, "_clipboard_to_path", lambda d: next(seq, None))
    monkeypatch.setattr(ed, "_clear_clipboard", lambda: None)
    monkeypatch.setattr("sys.stdin", io.StringIO("\n\n\n"))

    mode, paths = ed.read_images(_c(), [], tmp_path)

    assert mode == "append"
    assert [p.name for p in paths] == ["one.png", "two.png"], "第三次无图 = eof"


def test_read_images_stops_when_clipboard_keeps_same_image(tmp_path, monkeypatch):
    """剪贴板停在上一张时，回车不能无限循环：收下第一张后视为结束。"""
    one = tmp_path / "one.png"
    one.write_bytes(b"same-content")
    monkeypatch.setattr(ed, "_clipboard_to_path", lambda d: one)
    monkeypatch.setattr(ed, "_clear_clipboard", lambda: None)
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n\n\n\n"))

    mode, paths = ed.read_images(_c(), [], tmp_path)

    assert mode == "append"
    assert [p.name for p in paths] == ["one.png"]


class _TTY(io.StringIO):
    def isatty(self):
        return True


def test_file_edit_offers_install_hints_then_retries(tmp_path, monkeypatch, capsys):
    """没装编辑器时要给安装命令，装好后回车能重新检测并继续。"""
    monkeypatch.setattr(ed, "ROOT", tmp_path)
    seq = iter([None, (["true"], False)])
    monkeypatch.setattr(ed, "_find_editor", lambda: next(seq))
    launched = []
    monkeypatch.setattr(ed.subprocess, "call", lambda argv: launched.append(argv))
    monkeypatch.setattr("sys.stdin", _TTY("\n\n"))

    got, _path = ed._file_edit("原始题干")

    out = capsys.readouterr().out
    assert ("brew install" in out) or ("apt install" in out) or ("winget" in out)
    assert "装好后按回车重新检测" in out
    assert launched and got == "原始题干"


def test_file_edit_no_editor_q_cancels(tmp_path, monkeypatch):
    monkeypatch.setattr(ed, "ROOT", tmp_path)
    monkeypatch.setattr(ed, "_find_editor", lambda: None)
    monkeypatch.setattr("sys.stdin", _TTY("q\n"))

    got, path = ed._file_edit("原始题干")

    assert got is None and path.exists()


def test_read_slot_prints_hint_on_its_own_line(monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    ed.read_slot(_c(), label="题干/选项", hint=":e 编辑器 · :c 清空",
                 current="", paper_md_dir=Path("."))
    assert ":e 编辑器" in capsys.readouterr().out
