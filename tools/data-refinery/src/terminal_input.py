"""prompt_toolkit-backed terminal editing used only on a TTY."""

from prompt_toolkit import PromptSession
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings


def new_history() -> InMemoryHistory:
    return InMemoryHistory()


def _prompt_message(message):
    """把带 ANSI 色码的提示转成 prompt_toolkit 的格式化文本。

    `Console.paint` 生成的是 `\x1b[36m...\x1b[0m`，直接喂给 prompt_toolkit 会被
    当成普通文本，终端上显示成字面的 `^[[36m...^[[0m`（2026-11-27）。
    """
    if isinstance(message, str) and "\x1b" in message:
        return ANSI(message)
    return message


_LINE_HISTORY = new_history()
_LINE_SESSION = PromptSession(history=_LINE_HISTORY)


def read_line(message="", *, input=None, output=None, history=None):
    message = _prompt_message(message)
    session = (
        PromptSession(
            message=message,
            history=history or _LINE_HISTORY,
            input=input,
            output=output,
        )
        if input is not None or output is not None or history is not None
        else _LINE_SESSION
    )
    try:
        if session is _LINE_SESSION:
            return session.prompt(message)
        return session.prompt()
    except EOFError:
        return None


def _block_bindings():
    bindings = KeyBindings()

    @bindings.add("enter")
    def _enter(event):
        line = event.current_buffer.document.current_line_before_cursor
        upper = line.strip().upper()
        if "EOF" in upper or upper in {"END", "结束"}:
            event.current_buffer.validate_and_handle()
        else:
            event.current_buffer.insert_text("\n")

    @bindings.add("escape", "enter")
    @bindings.add("c-d")
    def _submit(event):
        event.current_buffer.validate_and_handle()

    return bindings


_BLOCK_SESSION = PromptSession(
    multiline=True,
    key_bindings=_block_bindings(),
    history=new_history(),
)


def read_block(message="", *, default="", input=None, output=None, history=None):
    message = _prompt_message(message)
    session = (
        PromptSession(
            message=message,
            multiline=True,
            key_bindings=_block_bindings(),
            history=history or new_history(),
            input=input,
            output=output,
        )
        if input is not None or output is not None or history is not None
        else _BLOCK_SESSION
    )
    try:
        if session is _BLOCK_SESSION:
            return session.prompt(message, default=default)
        return session.prompt(default=default)
    except EOFError:
        return default
