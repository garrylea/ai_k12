"""逐条引导人工补题：把识别漏掉的题目补回来，落到 manual_fixes/，稍后统一入库。

入口：
    import_cli 第 7 步在 TTY 下自动调用 review_pending()；
    也可以单独跑 src/fix_question_cli.py（同一套逻辑）。

一次交互的输入约定（2026-10-31 改为显式菜单）：
- 先选方式：`1` 粘贴文本 / `2` 图片路径（走 MinerU）/ `3` 本地文件 /
  `4` 剪贴板图片；直接粘贴正文也行；
- 截图后按 ⌘V/⌘C 出来的图贴不进来：终端只会往 stdin 送字符，图片在 PTY 里
  没有通道 —— 所以图片只能由进程自己去问系统剪贴板（2026-11-07 起支持）。
  在菜单处 ⌘V 后按回车，或直接选 `4`，都会去读剪贴板；
- 粘贴时出现 `EOF` 即结束（大小写均可，也认 END / 结束）；
- 录入后先预览，`回车` 确认 / `e` 用 $EDITOR 改 / `r` 重输 / `s` 跳过；
- `q` 退出。

为什么要有 `e`/`r`：终端只能编辑「当前这一行」，已经交给程序的多行内容改不动 ——
用户粘错一大段时无法逐字删，只能整段重来或进编辑器改。

输入层用 `sys.stdin.readline()` 而不是 `input()`：终端把整段粘贴当一坨塞进来时
（bracketed paste），readline 会一次返回多行，旧实现只按行匹配 EOF，把标记连同
正文一起吞掉后继续等下一行 —— 用户看到的就是「加了 EOF 还卡住」。
"""

import getpass
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from cli_ui import Console
from scope_filter import match_keyword
from subject_codes import subject_code_for_path
from subject_strategies import get_strategy

ROOT = Path(__file__).resolve().parents[1]
ISSUES_FILE = ROOT / "output" / "recognition_issues.jsonl"
FIXES_DIR = ROOT / "output" / "manual_fixes"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_END_MARKERS = {"EOF", "END", "结束"}


_CONSOLE: Console | None = None


def console() -> Console:
    """进程内复用一个 Console（颜色/宽度只探测一次）。"""
    global _CONSOLE
    if _CONSOLE is None:
        _CONSOLE = Console()
    return _CONSOLE


_REASON_TEXT = {
    "missing_stem": "题号缺失",
    "md_has_no_such_stem": "原 Markdown 里找不到该题号",
    "md_uses_punct_separator": "原 Markdown 用的是顿号题号（如「18、」）",
    "prev_has_two_option_blocks": "上一题里混入了两组选项",
    "prev_has_second_subq_series": "上一题里出现了第二组小问",
    "next_starts_with_subq_no_stem": "下一题以 (1) 开头却没有题干",
    "content_looks_like_page_chrome": "这行是卷首页脚/署名，不是题目",
    "subq_starts_at_2": "小问从 (2) 开始，缺了 (1)",
    "empty_stem": "题干是空的（正文里没有有效文字）",
    "llm_marked_incomplete": "标注时判定题干不完整",
    "flagged_needs_review": "入库时被标为待复核（内容不完整）",
}


def humanize_reasons(reasons: list[str]) -> list[str]:
    """把扫描器的机器标记翻成人话（认不出的原样保留）。"""
    out: list[str] = []
    for reason in reasons or []:
        if reason in _REASON_TEXT:
            out.append(_REASON_TEXT[reason])
            continue
        m = re.match(r"prev_len_(\d+)_vs_median_(\d+)", reason)
        if m:
            out.append(f"上一题 {m.group(1)} 字（全卷中位 {m.group(2)} 字）")
            continue
        m = re.match(r"prev_repair_shrank_(\d+)_to_(\d+)", reason)
        if m:
            out.append(f"上一题被自动修复砍短（{m.group(1)}→{m.group(2)} 字）")
            continue
        m = re.match(r"repair_shrank_(\d+)_to_(\d+)", reason)
        if m:
            out.append(f"自动修复把内容砍短（{m.group(1)}→{m.group(2)} 字）")
            continue
        m = re.match(r"md_stem_appears_(\d+)x", reason)
        if m:
            out.append(f"原 Markdown 里该题号出现 {m.group(1)} 次")
            continue
        m = re.match(r"body_contains_stem_(\d+)$", reason)
        if m:
            out.append(f"本题正文里出现了第 {m.group(1)} 题的题号（下一题可能被吞进来了）")
            continue
        m = re.match(r"body_belongs_to_stem_(\d+)$", reason)
        if m:
            out.append(f"这段正文在原 Markdown 里属于第 {m.group(1)} 题（本题可能装错了内容）")
            continue
        m = re.match(r"type_outlier_(\w+?)_(\d+)of(\d+)$", reason)
        if m:
            name = {"choice": "选择题", "short_answer": "简答题",
                    "fill_blank": "填空题", "calculation": "计算题"}.get(m.group(1), m.group(1))
            out.append(f"同一大题 {m.group(3)} 题里有 {m.group(2)} 题是{name}，本题不是"
                       "（选择题丢选项就会这样）")
            continue
        out.append(reason)
    return out


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                    encoding="utf-8")


def _read_line(prompt: str = "") -> str | None:
    """读一行；输入流结束时返回 None（不抛 EOFError，避免半路崩栈）。"""
    if prompt:
        print(prompt, end="", flush=True)
    line = sys.stdin.readline()
    if line == "":
        return None
    return line.rstrip("\n")


_END_WORD_RE = re.compile(r"(?:^|\s)(END|结束)\s*$", re.IGNORECASE)


def _split_at_marker(text: str) -> tuple[str, bool]:
    """按结束标记切开一段输入；返回 (标记之前的正文, 是否遇到标记)。

    规则（2026-10-31 用户裁决）：**文本里任意位置出现 `EOF` 就算结束**，
    它之后的内容一律丢弃。这样不管 EOF 是独占一行、写在行尾，还是整段粘贴
    里的某一行中间，都能可靠收住 —— 早期只认"独占一行"，用户把标记写在
    最后一行末尾时会被当成正文吞掉，程序就一直等下去。
    另外仍兼容 `END` / `结束`，但这两个要求独占一行（避免误伤正文里的词）。
    """
    idx = text.upper().find("EOF")
    if idx != -1:
        return text[:idx].strip(), True

    kept: list[str] = []
    for line in text.splitlines():
        if line.strip().upper() in _END_MARKERS:
            return "\n".join(kept).strip(), True
        m = _END_WORD_RE.search(line)
        if m:
            tail = line[: m.start()].rstrip()
            if tail:
                kept.append(tail)
            return "\n".join(kept).strip(), True
        kept.append(line)
    return "\n".join(kept).strip(), False


def _read_block(first_chunk: str = "") -> str:
    """读到结束标记为止，返回正文；first_chunk 是已经读到的那一段。"""
    c = console()
    body, done = _split_at_marker(first_chunk)
    lines = body.splitlines() if body else []
    while not done:
        chunk = sys.stdin.readline()
        if chunk == "":          # 输入流结束：当成正文到此为止，不卡死
            break
        body, done = _split_at_marker(chunk)
        if body:
            lines.extend(body.splitlines())
            if len(lines) % 10 == 0:
                c.info(f"已收到 {len(lines)} 行…")
    c.ok(f"已收到 {len(lines)} 行")
    return "\n".join(lines).strip()


_STEM_PREFIX_RE = re.compile(r"^\s*\d{1,2}\s*[.．、:：]\s*")


def split_questions(text: str, strategy) -> list[tuple[int | None, str]]:
    """把一段粘贴按题号拆成多道题；没有题号就整段当一道。

    返回 [(题号 or None, 去掉题号前缀的正文)]。
    """
    parts: list[tuple[int | None, list[str]]] = []
    cur_no: int | None = None
    cur: list[str] = []
    for line in text.splitlines():
        ok, no = strategy.is_stem(line)
        if ok:
            if cur:
                parts.append((cur_no, cur))
            cur_no, cur = no, [_STEM_PREFIX_RE.sub("", line, count=1)]
        else:
            cur.append(line)
    if cur:
        parts.append((cur_no, cur))
    out = [(no, "\n".join(lines).strip()) for no, lines in parts if "\n".join(lines).strip()]
    return out or [(None, text.strip())]


def _image_to_markdown(image: Path, paper_md_dir: Path) -> str:
    """调 MinerU 把图片转成 Markdown，并把产出的图片拷贝进该卷的 images/。"""
    from convert import MineruRunner

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        MineruRunner().run([image], out)
        mds = sorted(out.glob("*.md"))
        if not mds:
            raise RuntimeError("MinerU 没有产出 Markdown")
        text = mds[0].read_text(encoding="utf-8").strip()
        src_images = out / "images"
        if src_images.is_dir():
            dst = paper_md_dir / "images"
            dst.mkdir(parents=True, exist_ok=True)
            for img in src_images.iterdir():
                if not (dst / img.name).exists():
                    shutil.copy2(img, dst / img.name)
    return text


# 这些串只会出现在我们自己的输出里，正文里不可能有 —— 命中任意一条就拒收
_STRONG_ECHO = ("请提供真题", "s) 跳过", "答案（可留空）", "▸ 第",
                "识别问题补录", "本次补录")
# 这些理论上可能出现在题目里（如「已收到」），只在命中多条时才判定为回显
_WEAK_ECHO = ("粘贴 Markdown，出现 EOF", "已收到")
_ECHO_MARKERS = _STRONG_ECHO + _WEAK_ECHO
_ECHO_RULE_RE = re.compile(r"^[─-]{10,}$")


def looks_like_ui_echo(text: str) -> bool:
    """这段输入其实是终端回显/复制的界面文字，不是真题。

    用户从终端里连界面一起复制时，读到的会是「> 1 / ──── / 请提供真题…」
    这类我们自己打印的行；直接入库会把界面文案写进题库。
    """
    lines = [l for l in (text or "").splitlines() if l.strip()]
    if not lines:
        return False
    if any(m in l for l in lines for m in _STRONG_ECHO):
        return True
    if any(_ECHO_RULE_RE.match(l.strip()) for l in lines):
        return True
    weak = sum(1 for l in lines if any(m in l for m in _WEAK_ECHO))
    return weak >= 2


def _ask_path(prompt: str) -> Path | None:
    """读一个路径（去掉引号/空白）；空输入返回 None。"""
    console().prompt(prompt)
    raw = (_read_line() or "").strip().strip("'\"")
    if not raw:
        return None
    return Path(raw).expanduser()


def _from_image(paper_md_dir: Path, path: Path | None = None) -> str | None:
    """图片 → MinerU → Markdown；失败返回 None（调用方继续问）。"""
    c = console()
    if path is None:
        path = _ask_path("图片路径 › ")
        if path is None:
            return None
    if not path.exists():
        c.err(f"找不到文件：{path}")
        return None
    c.info(f"调用 MinerU 识别 {path.name} …（可能要 1–4 分钟）")
    try:
        text = _image_to_markdown(path, paper_md_dir)
    except Exception as exc:                      # noqa: BLE001 - 外部命令，任何失败都退回重输
        c.err(f"MinerU 转换失败：{exc}")
        return None
    if not text.strip():
        c.err("MinerU 没有返回内容")
        return None
    return text


def _from_file(paper_md_dir: Path, raw: str | None = None) -> str | None:
    """读取本地 md/txt（图片则走 MinerU）；读不到返回 None。"""
    c = console()
    if raw is None:
        path = _ask_path("文件路径 › ")
        if path is None:
            return None
    else:
        path = Path(raw.strip().strip("'\"")).expanduser()
    if not path.exists():
        c.err(f"找不到文件：{path}")
        return None
    if path.suffix.lower() in IMAGE_SUFFIXES:
        return _from_image(paper_md_dir, path)
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        c.err(f"读不了文件：{exc}")
        return None


# 剪贴板探测：优先「复制的文件」（Finder 里 ⌘C 一个 .md/.png），其次才是图片本身。
# 为什么不这么做就会错：Finder 复制文件时，剪贴板同时带着文件 URL 和缩略图 TIFF，
# 只读图像数据会把「文件图标」当成题目截图送去 OCR。
_CLIPBOARD_APPLESCRIPT = r"""
on run argv
    set outDir to item 1 of argv
    try
        set f to the clipboard as «class furl»
        return "FILE:" & (POSIX path of f)
    end try
    try
        set d to the clipboard as «class PNGf»
    on error
        return "NONE"
    end try
    set p to outDir & "/clipboard.png"
    set fh to open for access (POSIX file p) with write permission
    set eof fh to 0
    write d to fh
    close access fh
    return "PNG:" & p
end run
"""


def _probe_macos_clipboard(tmp_dir: Path) -> str:
    """→ "FILE:<路径>" / "PNG:<临时png>" / "NONE"。"""
    res = subprocess.run(
        ["osascript", "-e", _CLIPBOARD_APPLESCRIPT, str(tmp_dir)],
        capture_output=True, text=True, timeout=10,
    )
    return (res.stdout or "").strip()


def _probe_linux_clipboard(tmp_dir: Path) -> str:
    if shutil.which("wl-paste"):
        types = subprocess.run(
            ["wl-paste", "--list-types"], capture_output=True, text=True, timeout=5,
        ).stdout
        if "image/png" not in types:
            return "NONE"
        data = subprocess.run(
            ["wl-paste", "--type", "image/png"], capture_output=True, timeout=10,
        ).stdout
    elif shutil.which("xclip"):
        data = subprocess.run(
            ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
            capture_output=True, timeout=10,
        ).stdout
    else:
        return "NONE"
    if not data:
        return "NONE"
    p = tmp_dir / "clipboard.png"
    p.write_bytes(data)
    return f"PNG:{p}"


def _clipboard_to_path(tmp_dir: Path) -> Path | None:
    """从系统剪贴板取图片（落成临时 png）或复制的文件路径；没有则 None。

    终端只往 stdin 送字符，图片在 PTY 里没有通道，所以补题时「截图 → ⌘V」
    必须由进程自己去问系统剪贴板；这里只负责拿到本地文件，识别仍走 MinerU。
    """
    try:
        raw = (_probe_macos_clipboard(tmp_dir) if sys.platform == "darwin"
               else _probe_linux_clipboard(tmp_dir))
    except (OSError, subprocess.SubprocessError):
        return None          # 没 osascript / wl-paste / 超时：当作剪贴板里没图
    if not raw or raw == "NONE":
        return None
    kind, _, value = raw.partition(":")
    path = Path(value).expanduser()
    if not path.exists() or (path.is_file() and path.stat().st_size == 0):
        return None
    return path


def _from_clipboard(paper_md_dir: Path, *, silent: bool = False) -> str | None:
    """剪贴板图片 → MinerU → Markdown；剪贴板是文件则按文件读。

    ``silent=True``：剪贴板没图时不打扰用户（菜单处按回车顺带探测的场景）。
    """
    with tempfile.TemporaryDirectory(prefix="refinery-clip-") as tmp:
        path = _clipboard_to_path(Path(tmp))
        if path is None:
            if not silent:
                console().warn("剪贴板里没有图片：先截图 / ⌘C 复制，再回来选 4")
            return None
        if path.suffix.lower() in IMAGE_SUFFIXES:
            return _from_image(paper_md_dir, path)
        return _from_file(paper_md_dir, str(path))


_EDIT_HINT = "d N 删第N行 · c N 内容 改第N行 · i N 内容 在第N行后插入 · p 重看 · w 完成 · q 放弃"


def _line_edit(text: str) -> str | None:
    """内置逐行编辑：不调用 vim/nano，改完按 w 返回；q 放弃（返回 None）。

    2026-10-31 事故：`e` 直接拉 $EDITOR，用户卡在 vim/nano 里出不来
    （Esc 没用、`:q` 也只是被当正文）。全屏编辑器一旦上手不顺就会把人困住，
    所以改成在终端里逐行改：删行、改行、插入行，都是普通一行文字。
    """
    c = console()
    lines = text.splitlines()

    def show() -> None:
        numbered = "\n".join(f"{i:>3}  {line}" for i, line in enumerate(lines, 1))
        c.block(f"题面（共 {len(lines)} 行）", numbered, max_lines=20)

    show()
    c.legend([("d N", "删第 N 行"), ("c N 内容", "改第 N 行"),
              ("i N 内容", "第 N 行后插入"), ("p", "重看"), ("w", "完成"), ("q", "放弃")])
    while True:
        c.prompt("编辑› ")
        raw = _read_line()
        if raw is None:
            return "\n".join(lines)
        raw = raw.strip()
        if not raw:
            continue
        cmd, _, rest = raw.partition(" ")
        cmd = cmd.lower()
        if cmd in ("w", "save"):
            return "\n".join(lines)
        if cmd in ("q", "quit"):
            return None
        if cmd == "p":
            show()
            continue
        if cmd in ("d", "c", "i"):
            head, _, body = rest.partition(" ")
            try:
                no = int(head)
            except ValueError:
                c.warn("用法：" + _EDIT_HINT)
                continue
            limit = len(lines) + (1 if cmd == "i" else 0)
            if not 1 <= no <= max(limit, 1):
                c.warn(f"行号超出范围（1–{max(len(lines), 1)}）")
                continue
            body = body.strip()
            if cmd == "d":
                del lines[no - 1]
                c.ok(f"已删除第 {no} 行，现在共 {len(lines)} 行")
            elif not body:
                c.warn("缺少新内容，例如：c 3 新的这一行")
            elif cmd == "c":
                lines[no - 1] = body
                c.ok(f"已改第 {no} 行")
            else:
                lines.insert(no, body)
                c.ok(f"已在第 {no} 行后插入，现在共 {len(lines)} 行")
            continue
        c.warn("指令不认识；" + _EDIT_HINT)


def _confirm_text(text: str) -> tuple[str, str]:
    """录入后必须显式选号确认；返回 (动作, 正文)，动作 ∈ ok / redo / skip。

    为什么不再用「回车=确认」：粘贴内容尾部常带空行，回车会被这些空行瞬间吃掉，
    用户还没看清就跳到下一步，然后在答案处敲编辑指令、以为程序没反应。
    """
    c = console()
    while True:
        c.block("内容已收到", text, max_lines=6)
        c.legend([("1", "确认继续"), ("2", "逐行编辑"), ("3", "重新粘贴"), ("4", "放弃本题")])
        c.prompt("选择 › ")
        raw = _read_line()
        if raw is None:                 # 输入流结束：当作放弃，避免死等
            return "skip", ""
        ans = raw.strip()
        if not ans:                     # 粘贴尾巴的空行：不当作确认
            continue
        low = ans.lower()

        if ans == "1" or low in ("y", "yes"):
            return "ok", text
        if ans == "2" or low in ("e", "edit"):
            edited = _line_edit(text)
            if edited is None:
                c.warn("已放弃编辑，保留原内容")
                continue
            if not edited.strip():
                c.warn("编辑后内容为空，请重新选择")
                continue
            text = edited
            continue
        if ans == "3" or low in ("r", "redo"):
            return "redo", ""
        if ans == "4" or low in ("s", "skip"):
            return "skip", ""
        if re.match(r"^[dci]\s+\d+", ans):
            c.warn("要删/改行，请先按 2 进入编辑")
            continue
        c.warn("请按 1/2/3/4 选择（1 确认 / 2 编辑 / 3 重粘 / 4 放弃）")


def _collect_content(paper_md_dir: Path) -> str | None:
    """读人工输入；返回 Markdown 正文，跳过时返回 None。

    先问用哪种方式（1 粘贴 / 2 图片路径 / 3 文件 / 4 剪贴板），再预览确认。
    直接粘贴正文也认：首行不是这些命令就当成正文的第一行。
    空行也认：截图后按 ⌘V 时终端送不出任何字符，用户接着按的回车就是这里读到的
    空行 —— 此时先探一次剪贴板，有图就按图片处理，没图再走原来的「粘贴文本」。
    """
    c = console()
    while True:
        c.prompt("选择方式 1/2/3/4（或直接粘贴正文 / ⌘V 图片后回车）› ")
        first = _read_line()
        if first is None:
            return None
        first = first.strip()
        low = first.lower()
        if low == "s":
            return None
        if low == "q":
            raise SystemExit(0)

        if first in ("e", "r"):
            # 还没录内容就想改：说清楚该按什么，别把这个字母吃进正文
            c.warn("还没有可修改的内容；请按 1 粘贴正文 / 2 图片路径 / "
                   "3 文件路径 / 4 剪贴板图片")
            continue
        if low == "4":
            text = _from_clipboard(paper_md_dir)
        elif low == "1" or first == "":
            text = _from_clipboard(paper_md_dir, silent=True) if first == "" else None
            if text is None:
                text = _read_block("")
        elif low == "2":
            text = _from_image(paper_md_dir)
        elif low == "3":
            text = _from_file(paper_md_dir)
        elif first.startswith("@"):
            text = _from_file(paper_md_dir, first[1:])
        else:
            text = _read_block(first)     # 直接粘贴，首行就是正文

        if text is None:
            continue
        if not text.strip():
            c.warn("没有收到内容，请重新输入")
            continue
        if looks_like_ui_echo(text):
            c.err("这段内容像是把界面文字也粘进来了（含「请提供真题」等），"
                  "已拒收，请只粘贴题目本身")
            continue

        action, text = _confirm_text(text)
        if action == "redo":
            continue
        if action == "skip":
            return None
        return text


def _subject_of(issue: dict) -> str:
    rel = Path(issue["rel_path"])
    return subject_code_for_path(rel, default="") or "generic"


_KIND_TEXT = {
    "missing": "题号缺失",
    "punct_stem": "顿号题号未识别",
    "repair_truncated": "自动修复砍短了内容",
    "junk_question": "卷首页脚被当成题目",
    "incomplete_content": "内容不完整",
    "merged_content": "前后题可能被合并",
    "type_mismatch": "题型与同大题不一致",
    "manual_override": "主动重录",
}

# 内容层问题：先问「你看来有没有问题」，确认没问题就只落结论、不写库
_CONTENT_KINDS = ("incomplete_content", "merged_content", "type_mismatch")


def _print_context(issue: dict, index: int | None = None, total: int | None = None) -> None:
    c = console()
    kind = _KIND_TEXT.get(issue.get("kind"), issue.get("kind") or "识别问题")
    counter = f"[{index}/{total}]" if index and total else ""
    no_text = f"第 {issue['group_order']} 题"
    tail = f"  {c.paint(counter, 'grey')}" if counter else ""
    c.write("")
    c.write(f"{c.paint(no_text, 'bold')}{c.paint(' · ' + kind, 'cyan')}{tail}")
    pairs = [("卷", issue["source"]),
             ("原卷", issue.get("pdf") or "（未找到对应 PDF）"),
             ("文本", issue.get("md") or "—"),
             ("依据", " · ".join(humanize_reasons(issue.get("reasons") or [])))]
    if issue.get("suspect_group_order"):
        if issue.get("kind") == "merged_content":
            pairs.append(("疑点", f"本题与第 {issue['suspect_group_order']} 题可能粘在一起/串位，"
                                  "请对照原卷确认哪段话属于哪一题"))
        else:
            pairs.append(("疑点", f"第 {issue['suspect_group_order']} 题的正文里可能混进了本题"))
    c.kv([p for p in pairs if p[0] != "依据"], label_width=4)
    reasons = humanize_reasons(issue.get("reasons") or [])
    if reasons:
        from cli_ui import wrap_items
        for i, line in enumerate(wrap_items(reasons, c.width - 8)):
            c.write(f"  {c.paint('依据' if i == 0 else '    ', 'dim')}  {line}")
    c.block("证据", issue.get("excerpt") or "", max_lines=5)


def _targets(issue: dict) -> list[tuple[int, str]]:
    """这次要依次录入哪些题号：先修「吸收了内容的那一题」，再补缺的这一题。

    一题一录（2026-10-31 用户裁决）：不要在一次粘贴里塞多道题，而是
    引导完一题再引导下一题，各自以 EOF 结束。

    内容层问题只改「本题」：`suspect_group_order` 在那是给人看的线索
    （这题的正文其实属于谁），不是第二个要重录的题号 —— 那题自己会另有条目。
    """
    if issue.get("kind") in _CONTENT_KINDS:
        if issue.get("kind") == "type_mismatch":
            note = ("这一题与同大题其它题的题型不一致，请录入完整题目（含 A–D 选项）；"
                    "题型会按选项自动判定")
        elif issue.get("kind") == "merged_content":
            note = "这一题混进了别的题的内容，请只录入本题自己的完整内容"
        else:
            note = "这一题内容不完整（缺小问），请录入完整题目"
        return [(issue["group_order"], note)]

    suspect = issue.get("suspect_group_order")
    seq: list[tuple[int, str]] = []
    if isinstance(suspect, int) and suspect != issue["group_order"]:
        seq.append((suspect, "这一题的正文里混进了下一题，请只保留本题自己的内容"))
    seq.append((issue["group_order"], "这一题是缺失/被吞的，请录入完整题目"))
    return seq


def _ask_one(issue: dict, target_no: int, note: str, paper_md_dir: Path,
             strategy, index: int = 1, total: int = 1) -> list[dict]:
    """引导录入一道题（允许粘贴里带多个题号，但提示按一题一录）。"""
    c = console()
    c.step(index, total, f"录入第 {target_no} 题", note)
    c.legend([("1", "粘贴文本"), ("2", "图片路径"), ("3", "文件路径"),
              ("4", "剪贴板图片"), ("s", "跳过本题"), ("q", "退出")])

    content = _collect_content(paper_md_dir)
    if content is None:
        c.warn(f"第 {target_no} 题未录入，已跳过")
        return []
    if not content.strip():
        c.warn("内容为空，未记录")
        return []

    parts = split_questions(content, strategy)
    if len(parts) > 1:
        c.warn(f"这段里出现了 {len(parts)} 个题号，已分别记录（建议下次一题一录）")

    records: list[dict] = []
    multi = len(parts) > 1
    for no, body in parts:
        target = no if no is not None else target_no
        # 录入确认之后仍允许返工：答案这一步也认 e 改题面 / r 重录 / s 放弃
        while True:
            if looks_like_ui_echo(body) or len(body.strip()) < 2:
                c.err("这段内容不像题目（过短或含界面文字），已跳过本条")
                break
            # 粘贴的可能是「材料 + 题干 + 小问 + 选项 + 图片」一整段：
            # 先按物化策略拆材料（split_material 只在「行首 (1) + (2) 连续」时切，
            # 普通选择题不受影响），再对剩下的题干/小问拆选项。
            material, rest = strategy.split_material(body)
            opts_source = rest if material else body
            stem, options = strategy.split_options(opts_source)
            if not stem.strip() and options and body.strip():
                # 选项字母写在内容下方（图在上、名称居中、字母在下）时，切分器会把
                # 题干那一段当成 A 的内容 → 题干空串。直接拒收：写进去就是一道空题
                # （2026-11-01 人大附题2 实测，写库后真题库显示空白题干）。
                c.err("题干被解析成了空串（选项字母写在内容下面的排版会造成这样），本条未记录")
                c.info("请按「题干单独一行 → A. 内容 → B. 内容 …」重粘；"
                       "没有配图的选项只写文字即可，例如：A. 塑料笔杆")
                fresh = _collect_content(paper_md_dir)
                if fresh and fresh.strip():
                    body = fresh
                continue
            mat_note = f" · 材料 {len(material)} 字" if material else ""
            if options:
                c.ok(f"第 {target} 题 · 题干 {len(stem)} 字{mat_note} · 选项 "
                     f"{'/'.join(o['label'] for o in options)}")
            else:
                c.ok(f"第 {target} 题 · 题干 {len(stem)} 字{mat_note} · 无选项（按简答题处理）")
            hint = "答案（可留空；e 改题面 / r 重录 / s 放弃本题）› "
            c.prompt(f"第 {target} 题{hint}" if multi else hint)
            answer = (_read_line() or "").strip()

            # 只认**小写**单字母：英语选项答案可能是大写 E，不能被当成命令
            if answer in ("e", "edit"):
                edited = _line_edit(body)
                if edited is None:
                    c.warn("没找到可用的编辑器（$VISUAL/$EDITOR/nano/vim），题面未改")
                elif not edited.strip():
                    c.warn("编辑后内容为空，已忽略")
                else:
                    body = edited
                continue
            if answer in ("r", "redo"):
                fresh = _collect_content(paper_md_dir)
                if fresh and fresh.strip():
                    body = fresh
                else:
                    c.warn("没有收到新内容，保留原题面")
                continue
            if answer in ("s", "skip"):
                c.warn(f"第 {target} 题已放弃，不记录")
                break

            if re.match(r"^[dci]\s+\d+", answer):
                c.warn("要删/改行，请按 e 进入编辑后再改")
                continue
            if any(m in answer for m in _ECHO_MARKERS):
                c.warn("答案里混进了界面文字，已置空")
                answer = ""
            records.append({
                "source": issue["source"],
                "rel_path": issue["rel_path"],
                "group_order": target,
                "content": stem.strip(),
                "options": options,
                "answer": answer,
                "material_text": material,
                "issue_kind": issue["kind"],
                "issue_reasons": issue.get("reasons") or [],
                # 题型以「同大题」为准（试卷不会同一大题混排）：type_mismatch 的题写库时
                # 直接按大题题型落 type，不再依赖选项有没有拆出来（2026-11-01 用户裁决）
                "expected_type": (issue.get("dominant_type")
                                  if issue.get("kind") == "type_mismatch" else None),
                "pdf": issue.get("pdf"),
                "md": issue.get("md"),
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "operator": getpass.getuser(),
                "status": "ready",
                "applied": False,
            })
            c.ok(f"已记录第 {target} 题（{len(stem.strip())} 字）")
            break
    return records


def _ask_verdict(issue: dict) -> str:
    """内容层问题先问「你看来有没有问题」：problem 改 / ok 保持原样 / skip 稍后再说。"""
    c = console()
    c.legend([("1", "有问题，我来修正"), ("2", "没有问题，保持原样（不写库）"),
              ("s", "跳过，下次再问"), ("q", "退出")])
    while True:
        c.prompt(f"第 {issue['group_order']} 题你看来有问题吗 › ")
        raw = _read_line()
        if raw is None:                 # 输入流结束：当作跳过，别卡死
            return "skip"
        ans = raw.strip().lower()
        if ans in ("1", "y", "yes"):
            return "problem"
        if ans in ("2", "n", "no"):
            return "ok"
        if ans in ("s", "skip"):
            return "skip"
        if ans in ("q", "quit"):
            raise SystemExit(0)
        c.warn("请按 1（有问题）/ 2（没问题）/ s（跳过）/ q（退出）选择")


def _ask(issue: dict, paper_md_dir: Path,
         index: int | None = None, total: int | None = None) -> list[dict]:
    """逐题引导：先修被吞的那一题，再补缺失的那一题；每题各自以 EOF 结束。

    内容层问题（不完整/前后题合并）多一道门：先问人工「有没有问题」。
    确认没问题 → 只把结论写进清单（verdict=no_change），一个字段都不改库；
    确认有问题 → 走和缺题一样的录入流程，由 apply_fixes 原地更新。
    """
    strategy = get_strategy(_subject_of(issue))
    _print_context(issue, index, total)

    if issue.get("kind") in _CONTENT_KINDS:
        verdict = _ask_verdict(issue)
        if verdict == "ok":
            mark_issue(issue["source"], issue["group_order"], "resolved",
                       note="人工确认无问题，未改动", kind=issue.get("kind"),
                       verdict="no_change",
                       content_sig=issue.get("content_sig"))
            console().ok(f"第 {issue['group_order']} 题已标记「确认无问题」，题库未改动")
            return []
        if verdict == "skip":
            return []

    targets = _targets(issue)
    records: list[dict] = []
    for i, (no, note) in enumerate(targets, 1):
        records.extend(_ask_one(issue, no, note, paper_md_dir, strategy, i, len(targets)))
    return records


def mark_issue(source: str, group_order: int, status: str, *,
               note: str | None = None, fix_file: str | None = None,
               kind: str | None = None, **extra) -> int:
    """把某卷某题（可限定 kind）的识别问题切到指定状态；返回改动条数。

    状态语义（2026-10-31 修订）：
    - pending  ：待人工补录
    - recorded ：已补录，但还没写进库（等 apply_fixes_cli --apply）
    - resolved ：已写进库；`verdict=no_change` 是「人工确认无问题、未改动」的收口
    """
    rows = _read_jsonl(ISSUES_FILE)
    changed = 0
    for rec in rows:
        if rec.get("source") != source or int(rec.get("group_order", -1)) != int(group_order):
            continue
        if kind is not None and rec.get("kind") != kind:
            continue

        if rec.get("status") == status and note is None:
            continue
        rec["status"] = status
        if status == "resolved":
            rec["resolved_at"] = datetime.now().isoformat(timespec="seconds")
        else:
            rec.pop("resolved_at", None)
        if fix_file:
            rec["fix_file"] = fix_file
        if note is not None:
            rec["note"] = note
        for key, value in extra.items():
            if value is None:
                continue
            rec[key] = value
        changed += 1
    if changed:
        _write_jsonl(ISSUES_FILE, rows)
    return changed


def pending_issues(sources: set[str] | None = None,
                   file: str | None = None) -> list[dict]:
    """取待处理的识别问题；sources 精确限定卷（import_cli 用），file 是卷名关键词。"""
    issues = [i for i in _read_jsonl(ISSUES_FILE) if i.get("status") == "pending"]
    if sources is not None:
        issues = [i for i in issues if i["source"] in sources]
    if file:
        issues = [i for i in issues if match_keyword(i["source"], file)]
    return issues


def _print_table(issues: list[dict]) -> None:
    """只列清单：每条形如「卷  题号  类型」，下一行缩进给依据。"""
    from cli_ui import pad, truncate_middle

    c = console()
    w_src = min(44, c.width - 24)
    c.write("")
    c.write("  " + c.paint(f"{pad('卷', w_src)}  题号  类型", "dim"))
    c.rule("─")
    for it in issues:
        kind = _KIND_TEXT.get(it.get("kind"), it.get("kind") or "")
        reasons = [h for h in humanize_reasons(it.get("reasons") or []) if h != kind]
        src = pad(truncate_middle(it["source"], w_src), w_src)
        c.write(f"  {src}  {it['group_order']:>4}  {c.paint(kind, 'cyan')}")
        if reasons:
            from cli_ui import wrap_items
            for line in wrap_items(reasons, c.width - 8):
                c.write("      " + c.paint(line, "dim"))
    c.write("")
    c.info(f"共 {len(issues)} 条待处理")


def review_pending(sources: set[str] | None = None,
                   file: str | None = None,
                   *, list_only: bool = False,
                   fixes_dir: Path | None = None,
                   limit: int | None = None) -> dict:
    """逐条引导补题。返回 {"pending", "fixed", "skipped", "confirmed_ok"}。"""
    c = console()
    issues = pending_issues(sources, file)
    result = {"pending": len(issues), "fixed": 0, "skipped": 0, "confirmed_ok": 0}
    if not issues:
        c.write("")
        c.ok("没有待人工处理的题")
        return result

    if list_only:
        _print_table(issues)
        return result

    # 逐条问之前先把整张清单打出来：否则用户不知道后面还有哪几题，
    # 中途 q 或被打断就以为「没发现问题」（2026-11-01 第 2 题就是这样被漏掉的）。
    # 按卷面题号排序：和手边的 PDF 同序，对照着看不用来回找。
    issues.sort(key=lambda i: (i["source"], int(i.get("group_order") or 0), i.get("kind") or ""))
    _print_table(issues)

    c.banner("识别问题补录",
             f"待处理 {len(issues)} 条 · 一题一录，出现 EOF 结束 · s 跳过 · q 退出")

    all_issues = _read_jsonl(ISSUES_FILE)   # 写回时要用全量
    out_dir = Path(fixes_dir) if fixes_dir else FIXES_DIR
    todo = issues[:limit] if limit else issues
    try:
        _review_loop(todo, all_issues, out_dir, result, c)
    except SystemExit:
        # q 退出：不吞掉剩下的条数，最后一次把没处理的题号列出来
        c.warn("已退出（未处理的条目会保留，下次运行同一条命令继续问）")

    remaining = len(pending_issues(sources, file))
    if remaining:
        _print_remaining(sources, file)
    c.summary([("本次补录", f"{result['fixed']} 题"),
               ("确认无问题", f"{result['confirmed_ok']} 条"),
               ("跳过", f"{result['skipped']} 条"),
               ("仍待处理", f"{remaining} 条"),
               ("落盘", str(out_dir))])
    if result["fixed"]:
        c.info("补录内容会随本次命令一起入库（结束时还会问一次）")
    return result


def _print_remaining(sources: set[str] | None, file: str | None) -> None:
    """把还没处理的条目列出来（题号 + 类型），保证中途退出也能看见剩余项。"""
    left = pending_issues(sources, file)
    if not left:
        return
    c = console()
    items = [(i["source"], int(i.get("group_order") or 0),
              _KIND_TEXT.get(i.get("kind"), i.get("kind") or "")) for i in left]
    items.sort(key=lambda x: (x[0], x[1]))
    by_src: dict[str, list[str]] = {}
    for src, no, kind in items:
        by_src.setdefault(src, []).append(f"第{no}题（{kind}）")
    c.write("")
    c.write("  还没处理：")
    for src, lst in by_src.items():
        head = "、".join(lst[:8]) + (f" 等 {len(lst)} 条" if len(lst) > 8 else "")
        c.write(f"  {src}：{head}")


def _review_loop(todo: list[dict], all_issues: list[dict], out_dir: Path,
                 result: dict, c) -> None:
    """逐条引导的主体（抽出来是为了让 q 退出时还能打印剩余条目）。"""
    for n, issue in enumerate(todo, 1):
        total_now = len(todo)
        # 一次粘贴可能顺带补好别的题号：轮到它时已经 resolved，别再问一遍
        live = next((it for it in all_issues
                     if it["source"] == issue["source"]
                     and it["group_order"] == issue["group_order"]
                     and it["kind"] == issue["kind"]), None)
        if live is not None and live.get("status") != "pending":
            continue
        paper_md_dir = Path(issue["md"]).parent if issue.get("md") else None
        if paper_md_dir is None:
            c.warn(f"第 {issue['group_order']} 题缺少 md 路径，已跳过")
            result["skipped"] += 1
            continue
        records = _ask(issue, paper_md_dir, n, total_now)
        if not records:
            # _ask 里「确认无问题」会直接把清单写成 resolved（不产补题记录），
            # 这时要把内存里的副本刷新过来，否则下面的整表回写会把它覆盖回 pending
            all_issues = _read_jsonl(ISSUES_FILE)
            live = next((it for it in all_issues
                         if it["source"] == issue["source"]
                         and it["group_order"] == issue["group_order"]
                         and it["kind"] == issue["kind"]), None)
            if live is not None and live.get("verdict") == "no_change":
                result["confirmed_ok"] += 1
            else:
                result["skipped"] += 1
            continue
        out_file = out_dir / f"{issue['source']}.jsonl"
        rows = _read_jsonl(out_file)
        for record in records:
            rows = [r for r in rows if r["group_order"] != record["group_order"]]
            rows.append(record)
        _write_jsonl(out_file, rows)

        # 本次补到的题号（含一次粘贴里带出来的其它题）对同卷同题的 issue 一并收口
        # 只标「已补录」：还没写库前不能算解决，否则补题文件被作废时会永久丢单
        fixed_numbers = {r["group_order"] for r in records}
        for it in all_issues:
            if (it["source"] == issue["source"] and it.get("status") == "pending"
                    and it["group_order"] in fixed_numbers
                    and it["kind"] in ("missing", "punct_stem", "repair_truncated",
                                       *_CONTENT_KINDS)):
                it["status"] = "recorded"
                it["recorded_at"] = records[0]["created_at"]
                it["fix_file"] = str(out_file)
        _write_jsonl(ISSUES_FILE, all_issues)
        result["fixed"] += len(records)


# ── 主动重录（用户指定题号，不依赖扫描清单）────────────────────────────────

def papers_in_scope(subject: str | None, file: str | None) -> list[dict]:
    """按学科/卷名子串列出范围内已提取的卷，用于主动重录。

    返回 [{source, rel_path, md, pdf}]，按 source 排序。
    """
    from recognition_scan import locate_pdf

    root = ROOT / "output"
    extracted_root = root / "extracted"
    md_root = root / "md"
    pdf_root = ROOT.parent / "crawler" / "data"
    out: list[dict] = []
    for jsonl in sorted(extracted_root.rglob("*.jsonl")):
        rel_dir = jsonl.parent.relative_to(extracted_root)
        if subject and str(rel_dir).split("/")[0] != subject:
            continue
        source = jsonl.stem
        if file and not match_keyword(source, file):
            continue
        md = md_root / rel_dir / f"{source}.md"
        pdf = locate_pdf(pdf_root, rel_dir, source)
        out.append({"source": source, "rel_path": rel_dir, "md": md,
                    "pdf": pdf if pdf.exists() else None})
    return out


def _save_records(source: str, records: list[dict], out_dir: Path) -> None:
    """把补题记录并入 manual_fixes/<source>.jsonl（同题号覆盖）。"""
    out_file = out_dir / f"{source}.jsonl"
    rows = _read_jsonl(out_file)
    for record in records:
        rows = [r for r in rows if r["group_order"] != record["group_order"]]
        rows.append(record)
    _write_jsonl(out_file, rows)


def _pick_paper(papers: list[dict]) -> dict | None:
    """只有一份直接返回；多份时让用户选。回车取消返回 None。"""
    if len(papers) == 1:
        return papers[0]
    c = console()
    c.write("")
    c.write("范围内有多份卷：")
    for i, p in enumerate(papers, 1):
        c.write(f"  {i}. {p['source']}")
    while True:
        c.prompt("选择第几份（回车取消）› ")
        raw = _read_line()
        if raw is None or not raw.strip():
            return None
        raw = raw.strip()
        if raw.isdigit() and 1 <= int(raw) <= len(papers):
            return papers[int(raw) - 1]
        c.warn(f"请输入 1–{len(papers)}")


def review_by_numbers(subject: str | None, file: str | None,
                      fixes_dir: Path | None = None) -> int:
    """主动重录：用户直接说「第 N 题有问题」，不依赖扫描清单。

    为什么需要：扫描只报它认得出的结构问题；PDF→MD 阶段丢图/丢字它未必能发现
    （2026-11-03 汇文题6 一张图没截出来）。这时要能主动点名重录。

    粘贴内容可以是一整段「材料 + 题干 + 小问 + 选项 + 图片」：
    `_ask_one` 先 `split_material` 拆材料、再 `split_options` 拆选项，
    分别落到 material_text / content / options；图片引用由 apply_fixes 统一物化。

    Returns: 本次记录的题数。
    """
    c = console()
    papers = papers_in_scope(subject, file)
    if not papers:
        c.warn("范围内没找到已提取的卷，无法主动重录")
        c.info("先跑一次 import_cli（至少到 extract 阶段）再来重录")
        return 0
    paper = _pick_paper(papers)
    if paper is None:
        return 0
    md_path = Path(paper["md"])
    if not md_path.exists():
        c.err(f"找不到该卷的 md：{md_path}")
        return 0
    strategy = get_strategy(subject_code_for_path(paper["rel_path"], default="") or "generic")
    out_dir = Path(fixes_dir) if fixes_dir else FIXES_DIR

    c.banner("主动重录",
             f"{paper['source']} · 输入题号（多个用逗号），回车结束 · q 退出")
    c.info("粘贴内容可以是「材料 + 题干 + 小问 + 选项 + 图片」一整段，"
           "程序会分别拆到材料/题干/选项；图片写成 ![](images/xxx.jpg) 引用，"
           "或直接给图片路径让 MinerU 识别")

    total = 0
    while True:
        c.prompt("要重录的题号 › ")
        raw = _read_line()
        if raw is None:
            break
        raw = raw.strip()
        if not raw:
            break
        if raw.lower() in ("q", "quit"):
            raise SystemExit(0)
        nums = [int(x) for x in re.split(r"[,，、\s]+", raw) if x.isdigit()]
        if not nums:
            c.warn("没认出题号，请输入如 6 或 6,19,20")
            continue
        for i, no in enumerate(nums, 1):
            issue = {
                "source": paper["source"],
                "rel_path": str(paper["rel_path"]),
                "group_order": no,
                "kind": "manual_override",
                "reasons": ["用户主动指定重录"],
                "md": str(md_path),
                "pdf": str(paper["pdf"]) if paper["pdf"] else None,
            }
            records = _ask_one(issue, no, "用户主动指定这道题有问题，请录入完整内容",
                               md_path.parent, strategy, i, len(nums))
            if records:
                _save_records(paper["source"], records, out_dir)
                total += len(records)
    if total:
        c.ok(f"已记录 {total} 题，随后会随本次导入一起问是否写库")
    else:
        c.info("没有录入任何题")
    return total


def main() -> int:
    """独立入口（src/fix_question_cli.py 调它）：一次 Ctrl+C 就退出。"""
    global ISSUES_FILE
    import argparse

    from cli_ui import install_interrupt_handler

    install_interrupt_handler()
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="卷名子串过滤，如 人大附中")
    parser.add_argument("--fixes-dir", default=str(FIXES_DIR))
    parser.add_argument("--list", action="store_true", help="只列清单，不进入交互")
    args = parser.parse_args()

    try:
        res = review_pending(file=args.source, list_only=args.list,
                             fixes_dir=Path(args.fixes_dir))
        # 录完就地入库 + 复扫：用户只记这一条命令，不用再跑 apply_fixes_cli
        # （2026-11-01 用户裁决「命令只能一条」）。import_cli 第 7 步不走这里。
        if res.get("fixed") and sys.stdin.isatty():
            print(f"\n本次补录 {res['fixed']} 题，是否现在写入题库？"
                  " y=写入 / 直接回车=暂不写 › ", end="", flush=True)
            if (_read_line() or "").strip().lower() in ("y", "yes"):
                from apply_fixes import run as apply_run
                extra = ["--source", args.source] if args.source else []
                apply_run(["--apply", *extra])
            else:
                print("       已保留补题记录；下次运行同一条命令会再问一次", flush=True)
    except KeyboardInterrupt:
        print("\n[中断] 已退出；本题未记录", flush=True)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
