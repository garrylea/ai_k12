"""逐条引导人工补题：把识别漏掉的题目补回来，落到 manual_fixes/，稍后统一入库。

入口：
    import_cli 第 7 步在 TTY 下自动调用 review_pending()；
    也可以单独跑 scripts/fix_question_cli.py（同一套逻辑）。

一次交互的输入约定（2026-10-31 改为显式菜单）：
- 先选方式：`1` 粘贴文本 / `2` 图片路径（走 MinerU）/ `3` 本地文件；直接粘贴正文也行；
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
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from cli_ui import Console
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


def _editor_command() -> list[str] | None:
    for env in ("VISUAL", "EDITOR"):
        value = os.environ.get(env)
        if value:
            return shlex.split(value)
    for cand in ("nano", "vim", "vi"):
        if shutil.which(cand):
            return [cand]
    return None


def _edit_in_editor(text: str) -> str | None:
    """把内容丢进 $EDITOR 让人改（终端里粘错的多行没法逐字删，只能这样改）。

    返回改后的正文；没有编辑器或编辑失败时返回 None，调用方保留原内容。
    """
    cmd = _editor_command()
    if cmd is None:
        return None
    fd, name = tempfile.mkstemp(suffix=".md", prefix="k12-fix-")
    path = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        try:
            code = subprocess.call(cmd + [str(path)])
        except OSError:
            return None
        if code != 0:
            return None
        return path.read_text(encoding="utf-8").strip()
    finally:
        path.unlink(missing_ok=True)


def _confirm_text(text: str) -> tuple[str, str]:
    """录入后确认；返回 (动作, 正文)，动作 ∈ ok / redo / skip。"""
    c = console()
    c.block("将记录这一题", text, max_lines=8)
    c.legend([("回车", "确认"), ("e", "编辑"), ("r", "重新输入"), ("s", "跳过本题")])
    c.prompt("› ")
    ans = (_read_line() or "").strip().lower()
    if ans in ("s", "skip"):
        return "skip", ""
    if ans in ("r", "redo"):
        return "redo", ""
    if ans in ("e", "edit"):
        edited = _edit_in_editor(text)
        if edited is None:
            c.warn("没找到可用的编辑器（$VISUAL/$EDITOR/nano/vim），已保留原内容")
            return "ok", text
        if not edited.strip():
            c.warn("编辑后内容为空，已退回重输")
            return "redo", ""
        return "ok", edited
    return "ok", text


def _collect_content(paper_md_dir: Path) -> str | None:
    """读人工输入；返回 Markdown 正文，跳过时返回 None。

    先问用哪种方式（1 粘贴 / 2 图片 / 3 文件），再预览确认。
    直接粘贴正文也认：首行不是 1/2/3/s/q 就当成正文的第一行。
    """
    c = console()
    while True:
        c.prompt("选择方式 1/2/3（或直接粘贴正文）› ")
        first = _read_line()
        if first is None:
            return None
        first = first.strip()
        low = first.lower()
        if low == "s":
            return None
        if low == "q":
            raise SystemExit(0)

        if low == "1" or first == "":
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
}


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
    """
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
              ("s", "跳过本题"), ("q", "退出")])

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
        if looks_like_ui_echo(body) or len(body.strip()) < 2:
            c.err("这段内容不像题目（过短或含界面文字），已跳过本条")
            continue
        target = no if no is not None else target_no
        stem, options = strategy.split_options(body)
        if options:
            c.ok(f"第 {target} 题 · 题干 {len(stem)} 字 · 选项 "
                 f"{'/'.join(o['label'] for o in options)}")
        else:
            c.ok(f"第 {target} 题 · 题干 {len(body)} 字 · 无选项（按简答题处理）")
        c.prompt(f"第 {target} 题答案（可留空）› " if multi else "答案（可留空）› ")
        answer = (_read_line() or "").strip()
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
            "material_text": None,
            "issue_kind": issue["kind"],
            "issue_reasons": issue.get("reasons") or [],
            "pdf": issue.get("pdf"),
            "md": issue.get("md"),
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "operator": getpass.getuser(),
            "status": "ready",
            "applied": False,
        })
        c.ok(f"已记录第 {target} 题（{len(stem.strip())} 字）")
    return records


def _ask(issue: dict, paper_md_dir: Path,
         index: int | None = None, total: int | None = None) -> list[dict]:
    """逐题引导：先修被吞的那一题，再补缺失的那一题；每题各自以 EOF 结束。"""
    strategy = get_strategy(_subject_of(issue))
    _print_context(issue, index, total)

    targets = _targets(issue)
    records: list[dict] = []
    for i, (no, note) in enumerate(targets, 1):
        records.extend(_ask_one(issue, no, note, paper_md_dir, strategy, i, len(targets)))
    return records


def mark_issue(source: str, group_order: int, status: str, *,
               note: str | None = None, fix_file: str | None = None) -> int:
    """把某卷某题的所有识别问题切到指定状态；返回改动条数。

    状态语义（2026-10-31 修订）：
    - pending  ：待人工补录
    - recorded ：已补录，但还没写进库（等 apply_fixes_cli --apply）
    - resolved ：已写进库
    """
    rows = _read_jsonl(ISSUES_FILE)
    changed = 0
    for rec in rows:
        if rec.get("source") != source or int(rec.get("group_order", -1)) != int(group_order):
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
        changed += 1
    if changed:
        _write_jsonl(ISSUES_FILE, rows)
    return changed


def pending_issues(sources: set[str] | None = None,
                   file: str | None = None) -> list[dict]:
    """取待处理的识别问题；sources 精确限定卷（import_cli 用），file 是卷名子串。"""
    issues = [i for i in _read_jsonl(ISSUES_FILE) if i.get("status") == "pending"]
    if sources is not None:
        issues = [i for i in issues if i["source"] in sources]
    if file:
        issues = [i for i in issues if file in i["source"]]
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
    """逐条引导补题。返回 {"pending", "fixed", "skipped"}。"""
    c = console()
    issues = pending_issues(sources, file)
    result = {"pending": len(issues), "fixed": 0, "skipped": 0}
    if not issues:
        c.write("")
        c.ok("没有待人工处理的题")
        return result

    if list_only:
        _print_table(issues)
        return result

    c.banner("识别问题补录",
             f"待处理 {len(issues)} 条 · 一题一录，出现 EOF 结束 · s 跳过 · q 退出")

    all_issues = _read_jsonl(ISSUES_FILE)   # 写回时要用全量
    out_dir = Path(fixes_dir) if fixes_dir else FIXES_DIR
    todo = issues[:limit] if limit else issues
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
                    and it["kind"] in ("missing", "punct_stem", "repair_truncated")):
                it["status"] = "recorded"
                it["recorded_at"] = records[0]["created_at"]
                it["fix_file"] = str(out_file)
        _write_jsonl(ISSUES_FILE, all_issues)
        result["fixed"] += len(records)

    remaining = len(pending_issues(sources, file))
    c.summary([("本次补录", f"{result['fixed']} 题"),
               ("跳过", f"{result['skipped']} 条"),
               ("仍待处理", f"{remaining} 条"),
               ("落盘", str(out_dir))])
    if result["fixed"]:
        c.info("下一步：python3 scripts/apply_fixes_cli.py --dry-run 预览，再加 --apply 入库")
    return result


def main() -> int:
    global ISSUES_FILE
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="卷名子串过滤，如 人大附中")
    parser.add_argument("--fixes-dir", default=str(FIXES_DIR))
    parser.add_argument("--list", action="store_true", help="只列清单，不进入交互")
    args = parser.parse_args()

    review_pending(file=args.source, list_only=args.list, fixes_dir=Path(args.fixes_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
