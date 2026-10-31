"""极简终端 UI：对齐、配色、分步提示（零依赖，纯 ANSI）。

为什么不用 rich：这个仓库的 tools/* 只依赖 requirements.txt 里列的包，
为补题这一条命令新增一个三方库不划算。这里只做四件事：
- 中文宽度按 East Asian Width 计算，确保「标签: 值」严格对齐（中文字符占 2 格）；
- 颜色只在 TTY 且未设 NO_COLOR 时启用，重定向到文件时自动退化纯文本；
- 长路径按终端宽度中间省略，不撑破版面；
- 统一的层级：banner / kv / block / step / ok / warn / err。
"""

import os
import re
import shutil
import sys
import unicodedata

_C = {
    "dim": "2",
    "bold": "1",
    "cyan": "36",
    "green": "32",
    "yellow": "33",
    "red": "31",
    "grey": "90",
}


def display_width(text: str) -> int:
    """终端显示宽度：中日韩全角字符算 2 格。"""
    width = 0
    for ch in text:
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return width


def truncate_middle(text: str, limit: int) -> str:
    """按**显示宽度**中间省略，保留头尾（路径用）。

    不能按字符数切：中文占 2 格，按 len 切会让省略后的串仍然超宽、把表格撑歪。
    """
    if limit <= 1 or display_width(text) <= limit:
        return text
    keep = limit - 1
    left_budget, right_budget = keep // 2, keep - keep // 2
    head = ""
    for ch in text:
        if display_width(head + ch) > left_budget:
            break
        head += ch
    tail = ""
    for ch in reversed(text):
        if display_width(ch + tail) > right_budget:
            break
        tail = ch + tail
    return f"{head}…{tail}"


def pad(text: str, width: int) -> str:
    """按显示宽度右侧补空格。"""
    return text + " " * max(0, width - display_width(text))


_IMG_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")


def _simplify_images(line: str) -> str:
    """把 `![](images/hash.jpg)` 折成 `[图]`，证据摘要里不该出现一堆哈希。"""
    return _IMG_RE.sub("[图]", line).strip()


def wrap_items(items: list[str], width: int, sep: str = " · ") -> list[str]:
    """把若干短句按显示宽度贪心折行（每行不超过 width 格）。"""
    lines: list[str] = []
    cur = ""
    for item in items:
        piece = f"{sep}{item}" if cur else item
        if cur and display_width(cur + piece) > width:
            lines.append(cur)
            cur = item
        else:
            cur = cur + piece
    if cur:
        lines.append(cur)
    return lines


class Console:
    def __init__(self, stream=None, color: bool | None = None, width: int | None = None):
        # 不缓存 stdout：pytest 的 capsys 会换掉 sys.stdout 并在用例结束时关闭旧句柄，
        # 缓存后第二次写入就是 "I/O operation on closed file"。
        self._stream = stream
        out = stream or sys.stdout
        if color is None:
            color = (hasattr(out, "isatty") and out.isatty()
                     and not os.environ.get("NO_COLOR")
                     and os.environ.get("TERM") != "dumb")
        self.color = bool(color)
        if width is None:
            try:
                width = shutil.get_terminal_size((100, 24)).columns
            except Exception:
                width = 100
        self.width = max(60, min(int(width), 100))

    # ---------- 基础 ----------
    def paint(self, text: str, *styles: str) -> str:
        if not self.color or not styles:
            return text
        codes = ";".join(_C[s] for s in styles if s in _C)
        return f"\033[{codes}m{text}\033[0m" if codes else text

    @property
    def stream(self):
        return self._stream or sys.stdout

    def write(self, text: str = "") -> None:
        print(text, file=self.stream, flush=True)

    def rule(self, char: str = "─") -> None:
        self.write(self.paint(char * self.width, "grey"))

    # ---------- 结构 ----------
    def banner(self, title: str, subtitle: str = "") -> None:
        self.write("")
        self.write(self.paint(title, "bold"))
        if subtitle:
            self.write(self.paint(subtitle, "dim"))
        self.rule()

    def kv(self, pairs: list[tuple[str, str]], label_width: int | None = None) -> None:
        """「标签  值」对齐输出；标签按显示宽度补空格。"""
        if not pairs:
            return
        width = label_width or max(display_width(k) for k, _ in pairs)
        for label, value in pairs:
            pad = " " * (width - display_width(label))
            room = self.width - width - 2
            text = truncate_middle(value, room) if display_width(value) > room else value
            self.write(f"  {self.paint(label, 'dim')}{pad}  {text}")

    def block(self, label: str, text: str, max_lines: int = 6) -> None:
        """灰框片段：超过 max_lines 行折叠。"""
        lines = [l for l in (text or "").splitlines() if l.strip()]
        if not lines:
            return
        self.write(f"  {self.paint(label, 'dim')}")
        bar = self.paint("│ ", "grey")
        for line in lines[:max_lines]:
            self.write(f"  {bar}{truncate_middle(_simplify_images(line.strip()), self.width - 4)}")
        if len(lines) > max_lines:
            more = len(lines) - max_lines
            self.write(f"  {self.paint('│', 'grey')} "
                       f"{self.paint(f'… 还有 {more} 行，见上面的证据片段', 'dim')}")

    def step(self, index: int, total: int, title: str, note: str = "") -> None:
        head = f"▸ 第 {index}/{total} 步" if total > 1 else "▸ 本题"
        self.write("")
        self.write(f"{self.paint(head, 'cyan', 'bold')}  {title}")
        if note:
            self.write(f"  {self.paint(note, 'dim')}")

    def legend(self, items: list[tuple[str, str]]) -> None:
        """一行式输入图例：1 粘贴文本 · 2 图片 · …"""
        parts = [f"{self.paint(k, 'bold')} {v}" for k, v in items]
        self.write("  " + self.paint(" · ".join(parts), "dim"))

    def prompt(self, text: str = "› ") -> None:
        print(self.paint(text, "cyan"), end="", file=self.stream, flush=True)

    # ---------- 状态 ----------
    def ok(self, text: str) -> None:
        self.write(f"  {self.paint('✓', 'green')} {text}")

    def warn(self, text: str) -> None:
        self.write(f"  {self.paint('!', 'yellow')} {text}")

    def err(self, text: str) -> None:
        self.write(f"  {self.paint('✗', 'red')} {text}")

    def info(self, text: str) -> None:
        self.write(f"  {self.paint('·', 'grey')} {text}")

    def summary(self, stats: list[tuple[str, str]]) -> None:
        self.write("")
        self.rule()
        self.kv(stats)
