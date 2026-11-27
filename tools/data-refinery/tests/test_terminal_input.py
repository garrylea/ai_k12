from prompt_toolkit.formatted_text import to_formatted_text
from prompt_toolkit.input.defaults import create_pipe_input
from prompt_toolkit.output import DummyOutput

import review_editor
import terminal_input


def test_read_line_moves_cursor_and_submits():
    with create_pipe_input() as pipe:
        pipe.send_text("ab\x1b[DX\r")
        got = terminal_input.read_line(
            "> ", input=pipe, output=DummyOutput(),
            history=terminal_input.new_history(),
        )
    assert got == "aXb"


def test_read_line_keeps_history_across_calls():
    history = terminal_input.new_history()
    with create_pipe_input() as pipe:
        pipe.send_text("first\r")
        first = terminal_input.read_line(
            "", input=pipe, output=DummyOutput(), history=history
        )
    with create_pipe_input() as pipe:
        pipe.send_text("\x1b[A\r")
        second = terminal_input.read_line(
            "", input=pipe, output=DummyOutput(), history=history
        )
    assert first == "first"
    assert second == "first"


def test_read_block_accepts_eof_marker():
    with create_pipe_input() as pipe:
        pipe.send_text("第一行\n第二行\nEOF\r")
        got = terminal_input.read_block(
            "", input=pipe, output=DummyOutput(),
            history=terminal_input.new_history(),
        )
    assert got == "第一行\n第二行\nEOF"


def test_read_line_ctrl_d_returns_none():
    with create_pipe_input() as pipe:
        pipe.send_text("\x04")
        got = terminal_input.read_line(
            "", input=pipe, output=DummyOutput(),
            history=terminal_input.new_history(),
        )
    assert got is None


def test_ansi_prompt_is_parsed_not_printed_literally():
    """带 ANSI 色码的提示必须转成 prompt_toolkit 的格式化文本，别把码当字打出来。"""
    message = "\x1b[36m› \x1b[0m"
    formatted = to_formatted_text(terminal_input._prompt_message(message))
    assert ("ansicyan", "›") in formatted
    assert not any("\x1b" in text for _style, text in formatted)


def test_read_line_renders_ansi_prompt_once():
    class CapturingOutput(DummyOutput):
        def __init__(self):
            super().__init__()
            self.written = []

        def write(self, data):
            self.written.append(data)
            super().write(data)

    out = CapturingOutput()
    with create_pipe_input() as pipe:
        pipe.send_text("\r")
        terminal_input.read_line(
            "\x1b[36m› \x1b[0m", input=pipe, output=out,
            history=terminal_input.new_history(),
        )
    rendered = "".join(out.written)
    # prompt_toolkit 把控制字符用 caret 记法显示：ESC -> '^['
    assert "^[[36m› ^[[0m" not in rendered
    assert "›" in rendered


def test_read_prompt_non_tty_prints_once(monkeypatch):
    prompts = []

    class FakeConsole:
        def prompt(self, text):
            prompts.append(text)

        def paint(self, text, *_styles):
            return text

    monkeypatch.setattr(review_editor.sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr(review_editor, "_read_line", lambda: "answer")
    assert review_editor.read_prompt(FakeConsole(), "题目 › ") == "answer"
    assert prompts == ["题目 › "]
