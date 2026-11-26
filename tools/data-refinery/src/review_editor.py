"""人工校对的输入原语：终端读行/读块、取文件与图片、逐行编辑、槽位与图片槽。

从 ``manual_fix.py`` 整段搬出（2026-11-26 人工校对重构 Task 1），函数体保持原行为；
``manual_fix`` 用具名 import 把这些名字导回去，旧调用点不受影响。

对外新增三块能力：
- ``render_copyable``：原样打印可整段拷贝的内容（不折行、不截断、不加边框）；
- ``read_slot``：四个文字槽共用的输入循环（回车=不改，``:`` 开头的已知命令）；
- ``read_images``：图片槽（追加/替换/清空/回车读剪贴板），按内容 hash 去重。
"""

import atexit
import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from cli_ui import Console

ROOT = Path(__file__).resolve().parents[1]

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_END_MARKERS = {"EOF", "END", "结束"}


_CONSOLE: Console | None = None


def console() -> Console:
    """进程内复用一个 Console（颜色/宽度只探测一次）。"""
    global _CONSOLE
    if _CONSOLE is None:
        _CONSOLE = Console()
    return _CONSOLE


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


_OPTION_LINE_HEAD_RE = re.compile(r"^\s*([A-F])[.．、]\s*\S")
_LOST_LABEL_HEAD_RE = re.compile(r"^(\s*)([.．、]\s*\S)")


def _restore_swallowed_option_label(lines: list[str]) -> list[str]:
    """修 TTY 粘贴/编辑时选项字母被吞（`C.` → `.`）。

    两条线索合用（2026-11-23 补）：
    1. 上一非空行是 A–F 选项 → 按序补下一个字母（原逻辑）；
    2. 整段里 A–F 中恰好缺一个字母 → 裸点号行补这个缺的字母。
       场景：选项行后面夹了说明行（A./说明/B./说明/./说明/D.），
       上一行不是选项，原逻辑救不回来，实测 35 中物理卷就是这么丢的 C。
    ".5 分" 这类小数/编号不补；补回会打 WARN 让用户看见。
    """
    seen = {m.group(1).upper() for line in lines
            if (m := _OPTION_LINE_HEAD_RE.match(line))}
    missing = [ch for ch in "ABCDEF" if ch not in seen]

    out: list[str] = []
    prev: str | None = None
    last_letter: str | None = None
    for line in lines:
        if pm := _OPTION_LINE_HEAD_RE.match(line):
            last_letter = pm.group(1).upper()
        lost = _LOST_LABEL_HEAD_RE.match(line)
        if lost and not lost.group(2)[1:2].isdigit():
            candidates: list[str] = []
            # 线索一：上一行就是选项（紧挨着丢字母）
            if prev and (pm := _OPTION_LINE_HEAD_RE.match(prev)):
                nxt = chr(ord(pm.group(1).upper()) + 1)
                if nxt <= "F":
                    candidates.append(nxt)
            # 线索二：这段里最后一个见到的选项的下一个字母（选项与说明交替时）
            if last_letter:
                nxt = chr(ord(last_letter) + 1)
                if nxt <= "F":
                    candidates.append(nxt)
            # 线索三：A–F 里恰好缺一个
            if len(missing) == 1:
                candidates.insert(0, missing[0])
            for cand in candidates:
                if cand not in seen:
                    line = f"{lost.group(1)}{cand}{lost.group(2)}"
                    seen.add(cand)
                    last_letter = cand
                    if cand in missing:
                        missing.remove(cand)
                    console().warn(f"粘贴/编辑时选项字母被终端吞掉，已补回「{cand}」")
                    break
        out.append(line)
        if line.strip():
            prev = line
    return out


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
        elif not done and not chunk.strip():
            # 空行是**段落边界**，必须原样留下；以前这里只收非空 body，
            # 用户粘的段间空行被吃掉，两段就被连成一段（2026-11-22 实测）。
            lines.append("")
    c.ok(f"已收到 {len(lines)} 行")
    return "\n".join(_restore_swallowed_option_label(lines)).strip()


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


_EDIT_HINT = ("d N 删第N行 · c N 内容 改第N行（单行） · r N 整段替换（可多行） · "
              "i N 内容 在第N行后插入 · p 重看 · w 完成 · q 放弃")


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
        c.block(f"题面（共 {len(lines)} 行）", numbered,
                max_lines=max(len(lines), 1) + 1)

    show()
    c.legend([("d N", "删第 N 行"), ("c N 内容", "改第 N 行（单行）"),
              ("r N", "整段替换（多行，EOF 结束）"), ("i N 内容", "第 N 行后插入"),
              ("p", "重看"), ("w", "完成"), ("q", "放弃")])
    while True:
        c.prompt("编辑› ")
        raw = _read_line()
        if raw is None:
            return "\n".join(_restore_swallowed_option_label(lines))
        raw = raw.strip()
        if not raw:
            continue
        cmd, _, rest = raw.partition(" ")
        cmd = cmd.lower()
        if cmd in ("w", "save"):
            return "\n".join(_restore_swallowed_option_label(lines))
        if cmd in ("q", "quit"):
            return None
        if cmd == "p":
            show()
            continue
        if cmd == "r":
            # 整段替换：一个长段落必须能整段粘进来（c N 只能输一行）。
            try:
                no = int(rest.strip())
            except ValueError:
                c.warn("用法：r 行号，然后粘贴整段（EOF 结束）")
                continue
            if not 1 <= no <= len(lines):
                c.warn(f"行号超出范围（1–{max(len(lines), 1)}）")
                continue
            c.info(f"粘贴第 {no} 行的新内容（可多行；空行保留；EOF 结束）")
            block = _read_block()
            if not block.strip():
                c.warn("没有收到内容，未改动")
                continue
            lines[no - 1:no] = block.splitlines()
            c.ok(f"已用 {len(block.splitlines())} 行替换第 {no} 行，"
                 f"现在共 {len(lines)} 行")
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
                c.warn("缺少新内容，例如：c 3 新的这一行（整段请用 r 3）")
            elif cmd == "c":
                lines[no - 1] = body
                c.ok(f"已改第 {no} 行")
            else:
                lines.insert(no, body)
                c.ok(f"已在第 {no} 行后插入，现在共 {len(lines)} 行")
            continue
        c.warn("指令不认识；" + _EDIT_HINT)


def _editor_install_hints() -> list[str]:
    """按平台给出装编辑器的命令（找不到编辑器时提示一次，不自动装）。"""
    if sys.platform == "darwin":
        return [
            "macOS：brew install --cask visual-studio-code"
            "（装完在 VS Code 里执行 Shell Command: Install 'code' command in PATH）",
            "或：brew install vim（macOS 自带 /usr/bin/vi，找不到请检查 PATH）",
        ]
    if sys.platform.startswith("win"):
        return [
            "Windows：winget install Microsoft.VisualStudioCode",
            "或：winget install vim.vim",
        ]
    return [
        "Linux：sudo apt install vim（Debian/Ubuntu）",
        "或：sudo dnf install vim（Fedora）/ sudo pacman -S vim（Arch）",
        "VS Code：https://code.visualstudio.com/",
    ]


def _find_editor() -> tuple[list[str], bool] | None:
    """返回 (命令, 是否 VS Code)；VS Code 用 --reuse-window 打开、不阻塞。

    为什么不对 VS Code 用 `--wait`：它要等**标签页关闭**才返回，用户往往只保存不关闭，
    终端就永远停在「没下文」。改成打开后由下面统一等回车（2026-11-24 用户反馈）。
    """
    code = shutil.which("code")
    if not code:
        mac = Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
        if mac.exists():
            code = str(mac)
    if code:
        return [code, "--reuse-window"], True
    for name in ("vim", "vi", "nano"):
        p = shutil.which(name)
        if p:
            return [p], False
    return None


def _file_edit(text: str | None, label: str = "题干",
               *, path: Path | None = None) -> tuple[str | None, Path]:
    """把内容写到 output/edits/ 下的文件并打开编辑器，返回 (编辑后正文或 None, 文件路径)。

    flow（2026-11-24 用户裁决）：
    - VS Code 非阻塞打开 → 提示「改完保存后按回车」；vim/vi 退出后同样提示回车确认；
    - 回车=确认并读回；`c`=取消，返回 None，由调用方决定跳过/重试/退出；
    - `path` 传入时复用已有文件（取消后重试不覆盖用户刚才的修改）。
    """
    c = console()
    if path is None:
        edits = ROOT / "output" / "edits"
        edits.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        # label 里可能带「/」（如「题干/选项」）：不能直接进文件名，否则会去写不存在的子目录
        safe = re.sub(r'[\\/:*?"<>|\s]+', "_", label).strip("_") or "编辑"
        path = edits / f"{safe}_{stamp}.md"
        try:
            path.write_text((text or "").rstrip() + "\n", encoding="utf-8")
        except OSError as exc:
            c.warn(f"写不了编辑文件：{exc}")
            return None, path
    c.info(f"编辑文件：{path}")

    # 非交互环境（管道/测试）不拉起图形编辑器，避免 code --wait 之类把管道挂住
    editor = _find_editor() if sys.stdin.isatty() else None
    if editor is None and sys.stdin.isatty():
        c.warn("没找到 VS Code / vim / vi，无法自动打开编辑器")
        for line in _editor_install_hints():
            c.write(f"  {line}")
        c.info(f"文件已写好，也可以手动打开：{path}")
        while True:
            c.prompt("装好后按回车重新检测 / q 取消 › ")
            raw = _read_line()
            if raw is None or raw.strip().lower() in ("q", "quit"):
                return None, path
            editor = _find_editor()
            if editor:
                break
            c.warn("还是没找到；确认已安装并在 PATH 里，再回车重试，或 q 取消")
    if editor:
        argv, is_code = editor
        try:
            if is_code:
                subprocess.Popen([*argv, str(path)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                c.info("已在 VS Code 打开；改完保存后回到终端继续")
            else:
                subprocess.call([*argv, str(path)])
                c.info("编辑器已退出；确认后继续")
        except OSError as exc:
            c.warn(f"编辑器启动失败：{exc}")
            c.info(f"请手动打开这个文件改：{path}")
    elif not sys.stdin.isatty():
        c.warn("没找到 VS Code / vim / vi，请手动打开这个文件改：")
        c.write(f"  {path}")

    while True:
        c.prompt("改完按回车确认 / c 取消 › ")
        raw = _read_line()
        if raw is None:
            return None, path
        ans = raw.strip().lower()
        if ans in ("", "1", "y", "yes"):
            break
        if ans in ("c", "cancel", "2", "n", "no"):
            return None, path
        c.warn("回车=确认这版；c=取消")

    try:
        new = path.read_text(encoding="utf-8")
    except OSError as exc:
        c.warn(f"读不回文件：{exc}")
        return None, path
    if not new.strip():
        c.warn("文件是空的，未采用")
        return None, path
    return new.rstrip("\n"), path


def _clear_clipboard() -> None:
    """尽量清空系统剪贴板（macOS/Linux）；失败无所谓，只是防重复收图。"""
    try:
        if sys.platform == "darwin":
            subprocess.run(["osascript", "-e", 'set the clipboard to ""'],
                           capture_output=True, timeout=5)
        elif shutil.which("xclip"):
            subprocess.run(["xclip", "-selection", "clipboard", "/dev/null"],
                           capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass


def looks_like_wrapped_copy(text: str) -> bool:
    """判断一段材料是不是从终端/界面里带折行复制出来的。

    典型痕迹：行首 ``│``（`Console.block` 的左边框）成片出现，或 HTML 标签
    被硬换行截断（``<span clas`` + 换行 + ``s=...``）。这类文本直接入库会变成
    一行一段、标签失效，页面排版全乱（2026-11-22 西城模拟一 Q19 实测）。
    """
    t = text or ""
    lines = t.splitlines()
    prefixed = sum(1 for line in lines if re.match(r"^\s*│", line))
    split_tag = bool(re.search(r"<[a-zA-Z][^>\n]*\n\s*[a-zA-Z-]+=", t))
    return prefixed >= 2 or split_tag


def from_any(paper_md_dir: Path) -> str | None:
    """`:f` 取外部内容：回车读剪贴板；输入路径则按文件读（图片走 MinerU）。"""
    path = _ask_path("文件路径（回车=读剪贴板）› ")
    if path is None:
        return _from_clipboard(paper_md_dir)
    return _from_file(paper_md_dir, str(path))


def render_copyable(c, label: str, text: str, *, max_lines: int | None = None) -> None:
    """原样打印可整段拷贝的内容：不折行、不截断、不加 ``│`` 边框。

    卡片上的内容要能直接选中复制回槽位；``Console.block`` 会折行并补
    ``│`` 前缀，复制回去会带折行痕迹（``looks_like_wrapped_copy`` 会拒收）。
    """
    lines = (text or "").splitlines()
    if not lines:
        c.write(f"  {c.paint(label, 'dim')}  无")
        return
    shown = lines if max_lines is None else lines[:max_lines]
    c.write(f"  {c.paint(label, 'dim')}")
    for line in shown:
        c.write(f"  {line}")
    if len(lines) > len(shown):
        c.write(f"  {c.paint(f'... 还有 {len(lines) - len(shown)} 行，输入 :p 看全文', 'dim')}")


def read_slot(
    c,
    *,
    label: str,
    hint: str,
    current: str | None,
    paper_md_dir: Path,
    allow_clear: bool = True,
    allow_line_edit: bool = True,
    allow_peek: bool = True,
    reject_wrapped: bool = False,
    first_line: str | None = None,
) -> tuple[str, str]:
    """读一个文字槽，返回 (动作, 正文)，动作 ∈ unchanged / value / clear。

    槽内规则（设计 §4.4）：回车=不改；``:`` 开头的已知命令按命令处理；
    其他所有输入都是内容（``e`` / ``@foo`` 不再被当成命令或路径）。
    """
    pre = first_line
    while True:
        if pre is None:
            if hint:
                c.write("  " + c.paint(hint, "dim"))
            c.prompt(f"{label} › ")
            raw = _read_line()
        else:
            raw, pre = pre, None
        if raw is None:
            return "unchanged", ""
        s = raw.strip()
        if not s:
            return "unchanged", ""
        low = s.lower()
        if low in (":e", ":edit"):
            edited, _path = _file_edit(current or "", label)
            if edited is None:
                c.warn("没有改内容")
                continue
            return "value", edited
        if low in (":l", ":line"):
            if not allow_line_edit:
                c.warn("这个槽不支持逐行改，请用 :e")
                continue
            edited = _line_edit(current or "")
            if edited is None:
                c.warn("已放弃编辑")
                continue
            return "value", edited
        if low in (":c", ":clear"):
            if not allow_clear:
                c.warn("这个槽不能单独清空；清全部材料请用 R")
                continue
            return "clear", ""
        if low in (":p", ":peek"):
            if not allow_peek:
                c.warn("这个槽没有可重看的内容")
                continue
            render_copyable(c, f"当前{label}", current or "", max_lines=None)
            continue
        if low in (":f", ":from"):
            text = from_any(paper_md_dir)
            if text is None:
                continue
            render_copyable(c, f"{label}已收到", text, max_lines=6)
            return "value", text
        text = _read_block(raw)
        if not text.strip():
            c.warn("没有收到内容，请重新输入")
            continue
        if looks_like_ui_echo(text):
            c.err("这段像是界面文字，已拒收")
            continue
        if reject_wrapped and looks_like_wrapped_copy(text):
            c.err("这段带终端折行痕迹，请清理后重新复制")
            continue
        return "value", text


def _collect_image_paths(c, *, clipboard_only: bool = False) -> list[Path]:
    """收图片路径：显式路径（逗号分隔）或剪贴板图，按文件内容 hash 去重。

    ``clipboard_only=True``（菜单处直接回车）时只读剪贴板，连续回车可连续收图；
    没有图即结束，等价于 ``eof``（设计 §4.5）。
    剪贴板 png 落在临时目录里，必须活到调用方拷图之后，所以这里不立即清理；
    但要在**进程退出时**删掉，否则每次调用都会在 /tmp 留下一份用户截图。
    """
    root = Path(tempfile.mkdtemp(prefix="refinery-clip-"))
    atexit.register(shutil.rmtree, root, ignore_errors=True)
    paths: list[Path] = []
    seen: set[str] = set()
    grabs = 0                    # 每次读剪贴板换一个子目录，避免同一文件被覆盖

    def take(path: Path) -> bool:
        """收一张图；返回 False 表示内容重复（调用方据此结束剪贴板连收）。"""
        try:
            digest = hashlib.sha1(path.read_bytes()).hexdigest()
        except OSError:
            c.warn(f"读不了图片：{path}")
            return False
        if digest in seen:
            c.warn(f"这张和已收的图内容相同，已跳过：{path.name}")
            return False
        seen.add(digest)
        paths.append(path)
        return True

    while True:
        if clipboard_only:
            c.prompt(f"图片{len(paths) + 1}：回车收剪贴板 / eof 结束 › ")
        else:
            c.prompt("图片路径（多个用逗号；回车读剪贴板；eof 结束）› ")
        raw = _read_line()
        if raw is None:
            break
        s = raw.strip()
        if s.lower() in ("eof", "end", "结束"):
            break
        if s:
            for part in re.split(r"[,，]", s):
                token = part.strip().strip("'\"")
                if not token:
                    continue        # 末尾/连续逗号：空片段不等于当前目录
                p = Path(token).expanduser()
                if not p.is_absolute():
                    p = Path.cwd() / p
                if not p.exists():
                    c.warn(f"找不到文件：{p}")
                    continue
                if p.suffix.lower() not in IMAGE_SUFFIXES:
                    c.warn(f"不是图片：{p.name}")
                    continue
                take(p)
            continue
        sub = root / str(grabs)
        grabs += 1
        sub.mkdir(parents=True, exist_ok=True)
        clip = _clipboard_to_path(sub)
        if clip is None:
            break                # 没有图 = eof
        if clip.suffix.lower() not in IMAGE_SUFFIXES:
            c.warn("剪贴板里不是图片")
            continue
        if not take(clip):
            # 剪贴板还停在上一张：把它当成「收图结束」，否则回车会永远循环
            c.info("剪贴板还是同一张图，收图结束（重新裁剪后再回车可继续）")
            break
        c.ok(f"已收到第 {len(paths)} 张；再回车继续收，eof 结束")
        _clear_clipboard()
    return paths


def read_images(c, current, paper_md_dir: Path) -> tuple[str, list[Path]]:
    """图片槽：返回 (动作, 新图片路径)，动作 ∈ unchanged / append / replace / clear。

    设计 §4.5：路径按书写顺序编号（不再问「顺序对吗」）；回车读剪贴板图片，
    连续回车可连续收图，无图等价于 ``eof``；显式路径和剪贴板图都按内容 hash 去重。
    """
    c.write("")
    if current:
        shown = " · ".join(f"图{i} {Path(ref).name}" for i, ref in enumerate(current, 1))
        c.write(f"  图（当前 {len(current)} 张：{shown}）")
    else:
        c.write("  图（当前 0 张）")
    c.legend([("1", "追加图片"), ("2", "替换全部"), ("3", "清空"), ("回车", "不改")])
    while True:
        c.prompt("选择 1/2/3（回车=不改）› ")
        raw = _read_line()
        if raw is None:
            return "unchanged", []
        s = raw.strip()
        if not s:
            paths = _collect_image_paths(c, clipboard_only=True)
            if not paths:
                return "unchanged", []
            return "append", paths
        if s == "3":
            return "clear", []
        if s in ("1", "2"):
            paths = _collect_image_paths(c, clipboard_only=False)
            if not paths:
                c.warn("没有收到图片，未改动")
                return "unchanged", []
            return ("append" if s == "1" else "replace"), paths
        c.warn("请输入 1、2、3，或直接回车")
