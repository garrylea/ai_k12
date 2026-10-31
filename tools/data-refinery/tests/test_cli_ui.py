"""cli_ui：中文宽度、截断、折行、配色开关。"""

import io

import pytest

from cli_ui import (Console, display_width, install_interrupt_handler, pad,
                    truncate_middle, wrap_items)


def test_display_width_counts_cjk_as_two():
    assert display_width("abc") == 3
    assert display_width("中文") == 4
    assert display_width("题28") == 4      # 题=2 格，2 和 8 各 1 格


def test_truncate_middle_respects_display_width():
    """按字符数截断会让中文串超宽 —— 这里必须按显示宽度。"""
    text = "物理-初三(上)-202407-海淀·一零一中学-（上）期中-试卷"
    cut = truncate_middle(text, 20)
    assert display_width(cut) <= 20
    assert cut.startswith("物理")          # 保留头部
    assert "试卷" in cut                    # 保留尾部（学校/卷别在末尾）


def test_truncate_middle_keeps_short_text():
    assert truncate_middle("短文本", 20) == "短文本"


def test_pad_uses_display_width():
    assert display_width(pad("卷", 6)) == 6
    assert display_width(pad("abc", 6)) == 6


def test_wrap_items_breaks_by_display_width():
    items = ["上一题 1171 字（全卷中位 257 字）", "上一题里出现了第二组小问", "原 Markdown 里找不到该题号"]
    lines = wrap_items(items, 40)
    assert all(display_width(l) <= 40 for l in lines)
    flat = [x for line in lines for x in line.split(" · ")]
    assert flat == items, "折行只能断在分隔处，不能切断句子"


def test_color_disabled_for_non_tty():
    buf = io.StringIO()
    c = Console(stream=buf, width=80)
    assert c.color is False
    c.write(c.paint("x", "bold"))
    assert "\033[" not in buf.getvalue()


def test_color_forced_on_wraps_ansi():
    buf = io.StringIO()
    c = Console(stream=buf, color=True, width=80)
    c.write(c.paint("x", "bold"))
    assert "\033[1m" in buf.getvalue()


def test_no_color_env_disables(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "1")

    class Tty(io.StringIO):
        def isatty(self):
            return True

    assert Console(stream=Tty()).color is False


def test_kv_aligns_labels_by_display_width(capsys):
    c = Console(stream=None, color=False, width=80)
    c.kv([("卷", "a"), ("原卷", "b")])
    out = capsys.readouterr().out.splitlines()
    # 两个值应从同一**显示列**开始（中文占 2 格，不能用字符下标比）
    assert display_width(out[0][: out[0].index("a")]) == display_width(out[1][: out[1].index("b")])


def test_block_folds_images_and_caps_lines(capsys):
    c = Console(stream=None, color=False, width=60)
    c.block("证据", "\n".join([f"第{i}行 ![](images/abc{i}.jpg)" for i in range(9)]), max_lines=3)
    out = capsys.readouterr().out
    assert "[图]" in out and "abc1.jpg" not in out
    assert "还有 6 行" in out


# ---------- Ctrl+C 处理器 ----------

def test_install_interrupt_handler_sets_own_handler(monkeypatch):
    import signal

    monkeypatch.setattr(signal, "getsignal", lambda sig: signal.default_int_handler)
    captured = {}
    monkeypatch.setattr(signal, "signal", lambda sig, h: captured.update(sig=sig, h=h))

    assert install_interrupt_handler() is True
    assert captured["sig"] == signal.SIGINT and callable(captured["h"])


def test_install_interrupt_handler_leaves_foreign_handler(monkeypatch):
    """pytest / 调用方已经接管 SIGINT 时不许抢。"""
    import signal

    monkeypatch.setattr(signal, "getsignal", lambda sig: lambda *a: None)
    called = []
    monkeypatch.setattr(signal, "signal", lambda *a: called.append(a))

    assert install_interrupt_handler() is False
    assert called == []


def test_interrupt_handler_restores_default_and_raises(monkeypatch):
    """第一次按 Ctrl+C：提示 + 恢复默认动作（第二次必退）+ 抛 KeyboardInterrupt。"""
    import signal

    installs = []
    monkeypatch.setattr(signal, "getsignal", lambda sig: signal.default_int_handler)
    monkeypatch.setattr(signal, "signal", lambda sig, h: installs.append((sig, h)))

    install_interrupt_handler()
    handler = installs[0][1]
    # 模拟第二次安装（处理器内部把 SIGINT 恢复默认）
    installs.clear()

    try:
        handler(signal.SIGINT, None)
    except KeyboardInterrupt:
        pass
    else:
        raise AssertionError("处理器应该抛 KeyboardInterrupt")

    assert installs and installs[0][1] == signal.SIG_DFL
