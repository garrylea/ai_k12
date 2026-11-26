"""逐条引导人工补题：把识别漏掉的题目补回来，落到 manual_fixes/，稍后统一入库。

入口：
    import_cli 第 7 步在 TTY 下自动调用 review_pending()；
    也可以单独跑 src/fix_question_cli.py（同一套逻辑）。

一次交互的输入约定（2026-10-31 改为显式菜单）：
- 修已有题时先问**图怎么处理**：`1` 保留原图（只改文字）、`2` 换图（给图片路径，
  原样拷入 images/，不走 MinerU）、`3` 重新截图识别（MinerU，可能再认错）、
  `4` 只改文本（原题材料/选项/图片/文章一律不留，只用新粘的纯文本）；
  原题没有图时跳过这一步；
- 再选文字录入方式：`1` 粘贴文本 / `2` 图片路径（走 MinerU）/ `3` 本地文件 /
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
import hashlib
import re
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from scope_filter import match_keyword
from subject_codes import subject_code_for_path
from subject_strategies import get_strategy

from review_content import (  # noqa: F401
    _IMG_PLACEHOLDER_RE,
    _append_missing_images,
    _apply_image_placeholders,
    _article_similarity,
    _copyable_question_text,
    _current_question,
    _image_refs,
    _material_slots,
    _one_question_body,
    _paper_question_rows,
    _published_material_urls,
    _question_article,
    _repair_original,
    _subject_of,
    split_material_and_options,
    split_questions,
)
from review_editor import (  # noqa: F401
    IMAGE_SUFFIXES,
    ROOT,
    _ECHO_MARKERS,
    _ask_path,
    _clear_clipboard,
    _clipboard_to_path,
    _file_edit,
    _from_clipboard,
    _from_file,
    _from_image,
    _line_edit,
    _read_block,
    _read_line,
    _restore_swallowed_option_label,
    _split_at_marker,
    console,
    looks_like_ui_echo,
    looks_like_wrapped_copy,
)
from review_queue import (  # noqa: F401
    CONTENT_KINDS,
    FIXES_DIR,
    ISSUES_FILE,
    KIND_TEXT,
    _read_jsonl,
    _write_jsonl,
    humanize_reasons,
    mark_issue,
    pending_issues,
)

def _confirm_text(text: str, label: str = "题干") -> tuple[str, str]:
    """录入后必须显式选号确认；返回 (动作, 正文)，动作 ∈ ok / redo / clear / skip。

    为什么不再用「回车=确认」：粘贴内容尾部常带空行，回车会被这些空行瞬间吃掉，
    用户还没看清就跳到下一步，然后在答案处敲编辑指令、以为程序没反应。
    `label` 区分「题干 / 答案」：答案语境的提示词、第 4 项（放弃整题 vs 留空答案）不同；
    答案第 4 项返回 clear（留空答案、本题照常记录），不是 skip（放弃整题）。
    """
    c = console()
    is_answer = label == "答案"
    give_up = "留空（不填答案）" if is_answer else "放弃本题"
    while True:
        # 全文都给出来：确认前要能逐段核对，不能只显示前 6 行（2026-11-22 用户反馈）。
        c.block(f"{label}已收到", text, max_lines=max(len(text.splitlines()), 1) + 1)
        c.legend([("1", "确认继续"), ("2", "逐行编辑"), ("3", "重新输入"),
                  ("4", give_up), ("5", "用编辑器打开文件改")])
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
            return ("clear" if is_answer else "skip"), ""
        if ans == "5" or low in ("f", "file"):
            edited, _path = _file_edit(text, label)
            if edited is None:
                c.warn("没有改内容，保留原样")
                continue
            text = edited
            continue
        if re.match(r"^[dci]\s+\d+", ans):
            c.warn("要删/改行，请先按 2 进入编辑（或按 5 用文件编辑）")
            continue
        c.warn("请按 1/2/3/4/5 选择（1 确认 / 2 逐行编辑 / 3 重新输入 / "
               "4 " + give_up + " / 5 文件编辑）")


def _copy_new_images(paths: list[Path], paper_md_dir: Path) -> list[str]:
    """把用户给的图片**原样**拷进该卷 images/，返回 md 相对引用（不走 MinerU）。"""
    dst = paper_md_dir / "images"
    dst.mkdir(parents=True, exist_ok=True)
    refs: list[str] = []
    for path in paths:
        try:
            data = path.read_bytes()
        except OSError:
            continue
        name = f"manual_{hashlib.sha1(data).hexdigest()[:16]}{path.suffix.lower()}"
        target = dst / name
        if not target.exists():
            target.write_bytes(data)
        refs.append(f"images/{name}")
    return refs


def _keep_prior_images(old: dict | None, new: dict) -> None:
    """同一批粘贴里同题号的后一条覆盖前一条时，别把前一条的配图吞掉。

    截图 OCR 常把配图排在题号行之前，旧版会被切成两条同号记录；第二条没图，
    覆盖后图就没了（2026-11-23 西城模拟一题19）。现在带图的那条被覆盖时，
    把图补回新记录，宁可多一张图，也不要静默丢图。
    """
    if old is None:
        return
    old_imgs = _image_refs(old.get("content") or "", old.get("material_text") or "")
    new_imgs = _image_refs(new.get("content") or "", new.get("material_text") or "")
    if not old_imgs or new_imgs:
        return
    block = "\n\n" + "\n".join(f"![]({r})" for r in old_imgs)
    if (new.get("material_text") or "").strip():
        new["material_text"] = new["material_text"].rstrip() + block
    else:
        new["content"] = (new.get("content") or "").rstrip() + block
    console().warn("同题号的后一条记录没有配图，已把前一条的图补回（避免图被覆盖丢失）")


def discard_fixes_for_source(source_file: str, *, fixes_dir: Path | None = None,
                             exact: bool = False) -> int:
    """重转卷后只作废「已经被重新抽出来」的旧补题，保留仍需人工补的记录。

    - `applied=True` 永远保留：这是 `needing_replay` 在重导清掉关联后恢复题号的唯一信号，
      整文件丢弃会让补过的题永久消失（2026-11-21 语文模拟二 Q20 实测）。
    - pending 记录：重抽后该题已出现在 extracted 里 → 旧补题过时，作废归档；
      仍缺题 → 保留，等第 9 步写库，不必让用户再录一遍。
    返回作废的记录条数。
    """
    out_dir = Path(fixes_dir) if fixes_dir else FIXES_DIR
    if not out_dir.exists():
        return 0
    discarded = out_dir / "_discarded"
    moved = 0
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    for f in sorted(out_dir.glob("*.jsonl")):
        # 文件名就是卷名（manual_fix 落盘约定）。source_file 通常是精确卷名（import_cli
        # 解析后的 chosen.name）；也兼容关键词——只要两边分词互相命中即可。
        matched = (
            f.stem.casefold() == source_file.casefold()
            if exact
            else match_keyword(f.stem, source_file) or match_keyword(source_file, f.stem)
        )
        if not matched:
            continue
        rows = _read_jsonl(f)
        keep: list[dict] = []
        drop: list[dict] = []
        for rec in rows:
            if rec.get("applied"):
                keep.append(rec)
                continue
            current = _current_question(rec)
            if current and (current.get("content") or "").strip():
                drop.append(rec)       # 重抽已恢复：旧补题过时
            else:
                keep.append(rec)       # 仍缺题：保留用户补题
        if not drop:
            continue
        discarded.mkdir(parents=True, exist_ok=True)
        dest = discarded / f"{f.stem}.{stamp}{f.suffix}"
        if keep:
            _write_jsonl(dest, drop)
            _write_jsonl(f, keep)
        else:
            shutil.move(str(f), str(dest))
        moved += len(drop)
    return moved


def _ask_image_mode(count: int) -> str:
    """修复已有题时先问图片怎么处理，返回 keep / replace / ocr / text。"""
    c = console()
    c.write("")
    c.write(f"这一题原有 {count} 张图，怎么处理？")
    c.legend([("1", "保留原图（只改文字）"),
              ("2", "换图/配图（给图片路径，正文可写 [图1][图2]，不识别文字）"),
              ("3", "重新截图识别（MinerU，可能再认错）"),
              ("4", "只改文本（原题内容一律不留）")])
    while True:
        c.prompt("选择 1/2/3/4（回车=1）› ")
        raw = _read_line()
        if raw is None:
            return "keep"
        raw = raw.strip()
        if raw in ("", "1"):
            return "keep"
        if raw == "2":
            return "replace"
        if raw == "3":
            return "ocr"
        if raw == "4":
            return "text"
        c.warn("请输入 1、2、3 或 4")


def _ask_new_images(paper_md_dir: Path) -> list[str]:
    """配图：图片路径（多个用逗号，按书写顺序即图1、图2…）/ 回车剪贴板 → 原样拷进 images/。

    剪贴板取到的 png 落在临时目录里，它必须活到「拷图」之后才删：
    临时目录只包住取图那一步的话，用户一回车就只剩「拷图失败」（2026-11-26）。
    """
    c = console()
    with tempfile.TemporaryDirectory(prefix="refinery-clip-") as clip_dir:
        while True:
            c.prompt("图片路径（多个用逗号；回车读剪贴板；s 取消）› ")
            raw = _read_line()
            if raw is None:
                return []
            raw = raw.strip()
            if raw.lower() == "s":
                return []
            paths: list[Path] = []
            if not raw:
                clip = _clipboard_to_path(Path(clip_dir))
                if clip is not None and clip.suffix.lower() in IMAGE_SUFFIXES:
                    paths = [clip]
                elif clip is not None:
                    c.warn("剪贴板里不是图片")
                    continue
            else:
                for part in re.split(r"[,，]", raw):
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
                    paths.append(p)
            if not paths:
                c.warn("没有收到图片，请重新给路径，或按 s 取消本题")
                continue
            refs = _copy_new_images(paths, paper_md_dir)
            if refs:
                c.ok(f"已拷入 {len(refs)} 张图" + (
                    "" if len(refs) == 1
                    else "：" + "、".join(r.split("/")[-1] for r in refs)))
                if len(refs) > 1:
                    c.info("[图1]=第1张、[图2]=第2张…（正文里按这个写占位符）")
                return refs
            c.warn("拷图失败，请重新给路径，或按 s 取消本题")


def _collect_multi_image_flow(paper_md_dir: Path, out_refs: list[str]) -> str | None:
    """多图+题干处理：逐张「裁剪→⌘C→回车」收图，eof 结束；再读带 [图N] 的题干。

    每张图从剪贴板读出后立刻存进临时目录、清空剪贴板（防止没重新裁剪就重复收同一张），
    最后统一拷进该卷 images/，refs 写入 out_refs 供占位符替换。返回题干正文。
    """
    c = console()
    tmp_root = Path(tempfile.mkdtemp(prefix="refinery-multi-"))
    try:
        paths: list[Path] = []
        seen_hashes: set[str] = set()
        i = 1
        while True:
            c.prompt(f"请裁剪图{i} 并复制（⌘C），完成后回车；图片给完输入 eof › ")
            raw = _read_line()
            if raw is None:
                return None
            raw = raw.strip().lower()
            if raw in ("eof", "end", "结束"):
                break
            with tempfile.TemporaryDirectory(prefix="refinery-clip-") as tmp:
                clip = _clipboard_to_path(Path(tmp))
                if clip is None or not clip.exists() or clip.stat().st_size == 0:
                    c.warn("剪贴板里没有图片：先裁好图并复制，再回车；或输入 eof 结束")
                    continue
                if clip.suffix.lower() not in IMAGE_SUFFIXES:
                    c.warn("剪贴板里不是图片（是文件？）：请直接复制图片本身")
                    continue
                data = clip.read_bytes()
                # 内容去重：剪贴板清空在 macOS 上不一定生效，没重新裁剪就回车会重复收同一张。
                # 和已收图内容相同 → 默认拒收重裁；确需同一张可输入 y 强制收下。
                chash = hashlib.sha1(data).hexdigest()
                if chash in seen_hashes:
                    c.prompt("这张和已收的某张完全相同——是忘了重新裁剪吗？"
                             " 回车=重新裁 / y=确实要同一张 › ")
                    ans = (_read_line() or "").strip().lower()
                    if ans != "y":
                        continue
                saved = tmp_root / f"fig_{i:02d}{clip.suffix.lower()}"
                saved.write_bytes(data)
                paths.append(saved)
                seen_hashes.add(chash)
            _clear_clipboard()          # 尽力清空（失败也不影响去重兜底）
            c.ok(f"图{i} 已收下 → {saved}")
            i += 1
        if not paths:
            c.warn("一张图片都没收到，已取消本题")
            return None
        out_refs.extend(_copy_new_images(paths, paper_md_dir))
        c.info(f"已收 {len(paths)} 张图：[图1]=第1张、[图2]=第2张…")
        c.write("请输入题干，在要显示图片的地方写 [图1]/[图2]…，输入 EOF 结束：")
        text = _read_block("")
        return text or None
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _collect_content(paper_md_dir: Path, *, allow_images: bool = True,
                     out_refs: list[str] | None = None,
                     first_line: str | None = None,
                     label: str = "题干",
                     menu: bool = True) -> str | None:
    """读人工输入；返回 Markdown 正文，跳过时返回 None。

    默认先问用哪种方式（1 粘贴 / 2 图片路径 / 3 文件 / 4 剪贴板 / 5 多图+题干），再预览确认。
    直接粘贴正文也认：首行不是这些命令就当成正文的第一行。
    空行也认：截图后按 ⌘V 时终端送不出任何字符，用户接着按的回车就是这里读到的
    空行 —— 此时先探一次剪贴板，有图就按图片处理，没图再走原来的「粘贴文本」。
    `out_refs` 非空列表时，选 5 会把配好的图片引用写进去。
    `first_line`：调用方已读好的首行（答案录入要先识别 e/r/s 命令），有则不重复读。
    `label`：提示词语境，'题干' 或 '答案'（答案的确认框第 4 项是留空而非放弃整题）。
    `menu=False`：归属提示里已经选了「粘正文」（如材料选「题内素材」），不必再问
    输入方式 —— 直接提示粘贴正文，首行即正文（2026-11-22 用户反馈二次选择多余）。
    """
    c = console()
    pre_read = first_line
    while True:
        tip = (f"选择{label}输入方式 1/3（纯文字；或直接粘贴{label}）› " if not allow_images
               else f"选择{label}输入方式 1/2/3/4/5（5=多图+{label}；或直接粘贴{label} / ⌘V 图片后回车）› ")
        # 调用方（只补答案）已在同一条提示上读到选择并传进来；这里再打一条
        # 长得像菜单的提示会诱使用户多敲一次「1」，那个 1 会被当成正文第一行。
        if not menu:
            # 上一步已选「粘正文」，只收正文：不解析输入方式命令，首行即正文。
            c.prompt(f"请粘贴{label}（EOF 结束）› ")
        elif pre_read is None:
            c.prompt(tip)
        else:
            c.info(f"已选输入方式：接着粘贴{label}，EOF 结束")
        first = pre_read if pre_read is not None else _read_line()
        pre_read = None
        if first is None:
            return None
        first = first.strip()
        low = first.lower()
        if low == "s":
            return None
        if low == "q":
            raise SystemExit(0)

        if not menu:
            # 归属提示里已选「粘正文」：首行就是正文，不把 1/3/@ 等当输入方式命令
            text = _read_block(first)
        elif first in ("e", "r"):
            # 还没录内容就想改：说清楚该按什么，别把这个字母吃进正文
            c.warn("还没有可修改的内容；请按 1 粘贴正文 / 2 图片路径 / "
                   "3 文件路径 / 4 剪贴板图片 / 5 多图+题干")
            continue
        elif low in ("2", "4") and not allow_images:
            c.warn("当前是「纯文字」模式：图片请在上一步按 1/2 处理，这里只收文字")
            continue
        elif low == "5":
            if out_refs is None:
                c.warn("当前流程不支持多图+题干（纯文字模式）")
                continue
            text = _collect_multi_image_flow(paper_md_dir, out_refs)
        elif low == "4":
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

        action, text = _confirm_text(text, label=label)
        if action == "redo":
            continue
        if action == "clear":       # 答案留空：返回空串（不是 None，本题照常记录）
            return ""
        if action == "skip":
            return None
        return text


# 队列层常量已搬到 review_queue（Task 3）；旧名保留给本模块的交互文案用。
_KIND_TEXT = KIND_TEXT
_CONTENT_KINDS = CONTENT_KINDS


# material_url 的三态哨兵：_KEEP_URL=字段不写（兼容旧记录，apply_fixes 不碰该列），
# None=人工确认本题无材料（显式写 NULL），字符串=写入该 URL。
# 题号/小节标题都可能在 PDF→MD 时丢失，归属只能由人看着原卷确认，工具不猜。
_KEEP_URL = object()


def _ask_material_url(c, issue: dict) -> object:
    """问这道题的 material_url 怎么处理：序号沿用 / 粘贴 URL / n=无材料 / 回车=不动。

    返回 _KEEP_URL / None / 字符串（见 _KEEP_URL 注释）。题号丢失时切题器无法判断
    本题有没有共享文章，这一步让人看着原卷明确表态，不再由工具猜。
    """
    candidates = _published_material_urls(issue)
    current = None
    for no, url in candidates:
        if no == issue.get("group_order"):
            current = url
            break
    c.write("")
    c.write("材料 URL（题号/小节标题可能在转换中丢失，请对照原卷确认）")
    c.write(f"  当前：{current or '（无）'}")
    for i, (no, url) in enumerate(candidates, 1):
        c.write(f"  {i}) 第{no}题  {url}")
    c.prompt("  序号=沿用该题 URL / 直接粘贴 URL / n=确认本题无材料 / 回车=不动 › ")
    raw = (_read_line() or "").strip()
    if not raw:
        return _KEEP_URL
    if raw.lower() in ("n", "none", "null", "无"):
        return None
    if raw.isdigit() and 1 <= int(raw) <= len(candidates):
        return candidates[int(raw) - 1][1]
    return raw


def _print_context(issue: dict, index: int | None = None, total: int | None = None) -> None:
    c = console()
    kind = _KIND_TEXT.get(issue.get("kind"), issue.get("kind") or "识别问题")
    counter = f"[{index}/{total}]" if index and total else ""
    no_text = f"第 {_issue_no(issue)} 题"
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
    # 完整题干 + 选项，逐行原样输出（不按终端宽度截断），可整段拷贝下来改。
    full = _copyable_question_text(issue)
    c.write("")
    c.write(f"  {c.paint('当前题目（完整，可整段拷贝；只需改选项就复制题干再补选项）', 'dim')}")
    for line in full.splitlines():
        c.write(f"  {line}")


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
        elif issue.get("kind") == "options_incomplete":
            note = ("这一题选项不全（PDF 转换时丢了，脚本找不回），"
                    "请录入完整题目（含 A–D 选项）；题型会按选项自动判定")
        elif issue.get("kind") == "answer_missing":
            note = "这一题答案缺失，请录入完整题目和答案（题干也一起贴，避免覆盖错）"
        else:
            note = "这一题内容不完整（缺小问），请录入完整题目"
        return [(issue["group_order"], note)]

    suspect = issue.get("suspect_group_order")
    seq: list[tuple[int, str]] = []
    if isinstance(suspect, int) and suspect != issue["group_order"]:
        seq.append((suspect, "这一题的正文里混进了下一题，请只保留本题自己的内容"))
    seq.append((issue["group_order"], "这一题是缺失/被吞的，请录入完整题目"))
    return seq


def _collect_answer(paper_md_dir: Path, c) -> str | None:
    """答案录入：支持富输入（1文本/2图片/3文件/4剪贴板/5多图+答案）。

    规则（和题干行为一致，但不打断简单的单行答案）：
    - e/r/s → 返工/跳过命令，原样返回给调用方识别（e 改题面 / r 重录题面 / s 放弃整题）；
    - 1/2/3/4/5/@路径/含 `[图N]` → 进富输入菜单；确认框里「3 重新输入」只重输答案，
      「4 留空」= 本题不填答案（照常记录），都不会重输题干；
    - 其它（含空行=留空）→ 直接当答案文本（不用每次都敲 EOF）。
    返回的答案可能含 `![](images/...)`，由 apply_fixes 的 rewrite_fields 物化。
    """
    first = _read_line()
    if first is None:
        return None
    raw = first.strip()
    cmd = raw.lower()
    # 命令只认小写：英语选项答案可能是大写 E/S，不能被当命令吞掉
    if raw == cmd and cmd in ("s", "skip", "e", "edit", "r", "redo"):
        return cmd
    # 富输入触发：菜单命令 / @文件 / 占位符。空行仍当「答案为空」（原行为）。
    rich = (cmd in ("1", "2", "3", "4", "5") or first.strip().startswith("@")
            or bool(_IMG_PLACEHOLDER_RE.search(first)))
    if not rich:
        return first.strip()
    answer_refs: list[str] = []
    text = _collect_content(paper_md_dir, allow_images=True,
                            out_refs=answer_refs, first_line=first, label="答案")
    if text is None:
        return None
    if text.strip() == "":
        return ""            # 选「留空」：即使收了图也不往空答案里塞
    if answer_refs:
        text = _apply_image_placeholders(text, answer_refs)
    return text


def _ask_answer_only(issue: dict, target_no: int, original: dict,
                     c) -> list[dict]:
    """只补答案：题面/选项/图片一律不动，写库时也走 answer_only 分支。"""
    c.info("只补答案：题面、选项、图片都不动")
    md_path = Path(issue.get("md") or "")
    paper_md_dir = md_path.parent if md_path.name else (FIXES_DIR.parent / "md")
    answer = ""
    while True:
        c.prompt(f"第 {target_no} 题答案（1文本/2图片/3文件/4剪贴板/5多图+答案）› ")
        text = _collect_answer(paper_md_dir, c)
        if text is None or text in ("s", "skip"):
            c.warn(f"第 {target_no} 题已跳过")
            return []
        if text in ("e", "edit", "r", "redo"):   # 只补答案模式下 e/r 就是重来
            continue
        if any(m in text for m in _ECHO_MARKERS):
            c.warn("答案里混进了界面文字，请重输")
            continue
        answer = text
        break

    # 正文已在 _collect_content 的确认框里展示并确认过，不再二次确认。
    return [{
        "source": issue["source"],
        "rel_path": issue["rel_path"],
        "group_order": target_no,
        "sub_no": issue.get("sub_no", 0),
        "content": original.get("content") or "",
        "options": original.get("options"),
        # 只补答案时不碰材料：复制原 material_text 会让答案修正被材料归属判定误拦
        "material_text": None,
        "answer": answer,
        "answer_only": True,
        "issue_kind": issue["kind"],
        "issue_reasons": issue.get("reasons") or [],
        "expected_type": None,
        "pdf": issue.get("pdf"),
        "md": issue.get("md"),
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "operator": getpass.getuser(),
        "status": "ready",
        "applied": False,
    }]


def _issue_no(issue: dict) -> str:
    """题号展示：26(1) / 26（扫描 issue 带 sub_no）。"""
    sub = issue.get("sub_no") or 0
    return f"{issue['group_order']}({sub})" if sub else str(issue["group_order"])


def _editable_body(original: dict) -> str:
    """把当前题拼成可编辑的 Markdown（题干 + 选项 + 题内材料）。

    外置共享文章不拼进来：那是另一份文档，改题干时会把它整篇当正文写回去。
    """
    lines = [(original.get("content") or "").strip()]
    for opt in original.get("options") or []:
        label = (opt.get("label") or "").strip()
        text = (opt.get("text") or "").strip()
        if label:
            lines.append(f"{label}. {text}".rstrip())
    if not (original.get("material_url") or "").strip():
        mat = (original.get("material_text") or "").strip()
        if mat:
            lines += ["", mat]
    inline = (original.get("_post_material_text") or "").strip()
    if inline:
        lines += ["", inline]
    return "\n".join(lines).strip()


def _ask_edit_mode() -> str:
    """已有内容时怎么改：直接在编辑器里改现有内容 / 重新录入。"""
    c = console()
    c.write("")
    c.write("这一题已有内容，怎么改？")
    c.legend([("1", "用编辑器打开现有内容改（推荐）"),
              ("2", "重新录入（粘贴/截图识别）"),
              ("s", "跳过本题"), ("q", "退出")])
    while True:
        c.prompt("选择 › ")
        raw = _read_line()
        if raw is None:
            return "skip"
        ans = raw.strip().lower()
        if ans in ("", "1", "e", "edit"):
            return "edit"
        if ans in ("2", "r", "redo", "reinput"):
            return "reinput"
        if ans in ("s", "skip"):
            return "skip"
        if ans in ("q", "quit"):
            raise SystemExit(0)
        c.warn("请按 1（编辑器改）/ 2（重新录入）/ s（跳过）/ q（退出）选择")


def _ask_cancel_action(target_no: int) -> str:
    """取消编辑后怎么办：跳过本题 / 重新打开编辑器 / 结束程序。"""
    c = console()
    c.write("")
    c.warn(f"第 {target_no} 题未确认修改")
    c.legend([("1", "重新打开编辑器"), ("2", "跳过本题"), ("q", "结束程序")])
    while True:
        c.prompt("选择 › ")
        raw = _read_line()
        if raw is None:
            return "skip"
        ans = raw.strip().lower()
        if ans in ("", "1", "r", "retry", "e", "edit"):
            return "retry"
        if ans in ("2", "s", "skip"):
            return "skip"
        if ans in ("q", "quit"):
            return "quit"
        c.warn("请按 1（重新编辑）/ 2（跳过）/ q（结束）选择")


def _ask_one(issue: dict, target_no: int, note: str, paper_md_dir: Path,
             strategy, index: int = 1, total: int = 1) -> list[dict]:
    """引导录入一道题（允许粘贴里带多个题号，但提示按一题一录）。"""
    c = console()
    c.step(index, total, f"录入第 {target_no} 题", note)

    # 已有题：先问图怎么处理（保留原图 / 换图 / 重新识别），再收文字
    original = _current_question(issue)
    if issue.get("kind") == "answer_missing" and original is not None:
        return _ask_answer_only(issue, target_no, original, c)
    orig_refs: list[str] = []
    if original is not None:
        opts_old = original.get("options") or []
        orig_refs = _image_refs(
            original.get("content") or "",
            original.get("material_text") or "",
            *(str((o or {}).get("text") or "") for o in opts_old),
        )

    mode: str | None = None
    content: str | None = None
    if original is not None and (original.get("content") or "").strip():
        pick = _ask_edit_mode()
        if pick == "skip":
            return []
        if pick == "edit":
            body = _editable_body(original)
            edit_path = None
            while True:
                edited, edit_path = _file_edit(
                    body if edit_path is None else None,
                    f"第{target_no}题题干", path=edit_path)
                if edited is not None and edited.strip():
                    content = edited
                    # 编辑器里删掉的图不能被 prep 自动补回：编辑路径一律不追加原图
                    mode = "text"
                    break
                choice = _ask_cancel_action(target_no)
                if choice == "retry":
                    continue
                if choice == "skip":
                    return []
                raise SystemExit(0)

    new_refs: list[str] = []
    if mode is None:
        mode = _ask_image_mode(len(orig_refs)) if orig_refs else "ocr"
        if mode == "replace":
            new_refs = _ask_new_images(paper_md_dir)
            if not new_refs:
                c.warn(f"第 {target_no} 题没有换图，已跳过")
                return []
    # ocr 模式选「多图+题干」（菜单 5）时，图片引用会从 _collect_content 回填到这里
    multi_refs: list[str] = []

    def prep(text: str) -> str:
        """按图片策略加工文字：保留原图补引用 / 换图替换占位符。

        ocr 模式下：选了多图流程 → 用刚收的图替换 [图N]；或正文写了 [图N] 但没走
        多图流程 → 这时才问图片路径、拷图并替换。没写占位符就完全走原 ocr 流程。
        """
        if mode == "text":
            return text
        if mode == "keep":
            out = _append_missing_images(text, orig_refs)
            if out != text:
                c.info(f"已把原图 {len(orig_refs)} 张补到末尾（正文里没写图片引用）")
            return out
        if mode == "replace":
            return _apply_image_placeholders(text, new_refs)
        # ocr 模式
        if multi_refs:
            return _apply_image_placeholders(text, multi_refs)
        if _IMG_PLACEHOLDER_RE.search(text):
            refs = _ask_new_images(paper_md_dir)
            if refs:
                return _apply_image_placeholders(text, refs)
            c.warn("正文写了 [图N] 但没配图，占位符保留原样")
        return text

    if content is None:
        if mode != "ocr":
            c.legend([("1", "粘贴文本"), ("3", "文件路径"),
                      ("s", "跳过本题"), ("q", "退出")])
        else:
            c.legend([("1", "粘贴文本"), ("2", "图片路径"), ("3", "文件路径"),
                      ("4", "剪贴板图片"), ("5", "多图+题干（逐张裁剪配图）"),
                      ("s", "跳过本题"), ("q", "退出")])
        content = _collect_content(paper_md_dir, allow_images=(mode == "ocr"),
                                   out_refs=multi_refs)
        if content is None:
            c.warn(f"第 {target_no} 题未录入，已跳过")
            return []
        if not content.strip():
            c.warn("内容为空，未记录")
            return []
        content = prep(content)

    parts = split_questions(content, strategy)
    merged = _one_question_body(parts)
    if merged is not None:
        # 只有一个题号：前置配图/说明和正文是同一条，别拆成会互相覆盖的两条
        parts = merged
    elif len(parts) > 1:
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
            # 普通选择题不受影响；语文/英语没有该钩子，跳过），再对剩下的题干/小问拆选项。
            material, stem, options = split_material_and_options(strategy, body)
            if not stem.strip() and options and body.strip():
                # 选项字母写在内容下方（图在上、名称居中、字母在下）时，切分器会把
                # 题干那一段当成 A 的内容 → 题干空串。直接拒收：写进去就是一道空题
                # （2026-11-01 人大附题2 实测，写库后真题库显示空白题干）。
                c.err("题干被解析成了空串（选项字母写在内容下面的排版会造成这样），本条未记录")
                c.info("请按「题干单独一行 → A. 内容 → B. 内容 …」重粘；"
                       "没有配图的选项只写文字即可，例如：A. 塑料笔杆")
                fresh = _collect_content(paper_md_dir, allow_images=(mode == "ocr"))
                if fresh and fresh.strip():
                    body = prep(fresh)
                continue
            # 护栏：粘贴内容如果就是本题的共享文章，绝不能写进题干。
            # 整题重录以前没有这道门，整篇文章会被当成题干、把原题覆盖掉
            # （2026-11-22 海淀 Q21 实测）。纯文章 → 自动按「只改材料」记录；
            # 文章夹着题干 → 拒收，要求用户分开粘。
            from chinese_material_doc import same_article

            article = _question_article(issue)
            if article and same_article(stem, article):
                if _article_similarity(stem, article) >= 0.9:
                    row = _current_question(issue) or {}
                    c.warn("这段是本题的共享文章，不是题干；已自动按「只改材料」记录，题干保持原样")
                    records.append({
                        "source": issue["source"],
                        "rel_path": issue["rel_path"],
                        "group_order": target,
                        "sub_no": issue.get("sub_no", 0),
                        "content": row.get("content") or "",
                        "options": row.get("options"),
                        "answer": row.get("answer") or "",
                        "material_target": "article",
                        "material_text": stem,
                        "material_scope": "article",
                        "issue_kind": issue.get("kind"),
                        "issue_reasons": issue.get("reasons") or [],
                        "expected_type": None,
                        "pdf": issue.get("pdf"),
                        "md": issue.get("md"),
                        "created_at": datetime.now().isoformat(timespec="seconds"),
                        "operator": getpass.getuser(),
                        "status": "ready",
                        "applied": False,
                    })
                    c.ok(f"已记录第 {target} 题的材料修订（{len(stem.strip())} 字）")
                    break
                c.err("这段里包含了本题的共享文章，不能当题干写入")
                c.info("改文章请回到上一菜单选 1，在「共享材料」那一步粘；"
                       "改题干请不要带文章，只粘题目本身")
                fresh = _collect_content(paper_md_dir, allow_images=(mode == "ocr"))
                if fresh and fresh.strip():
                    body = prep(fresh)
                continue
            mat_note = f" · 材料 {len(material)} 字" if material else ""
            if options:
                c.ok(f"第 {target} 题 · 题干 {len(stem)} 字{mat_note} · 选项 "
                     f"{'/'.join(o['label'] for o in options)}")
            else:
                c.ok(f"第 {target} 题 · 题干 {len(stem)} 字{mat_note} · 无选项（按简答题处理）")
            # 材料：自动拆出的题内素材直接记 inline（不再问存储通道）。
            # 题号丢失且没材料时，可认领同卷兄弟文章（这是「归属哪篇」，不是「写哪列」）。
            material_url = None if mode == "text" else _KEEP_URL
            if (mode != "text" and sys.stdin.isatty() and not material
                    and issue.get("kind") in ("missing", "punct_stem", "repair_truncated")):
                url = _ask_material_url(c, issue)
                if url is not _KEEP_URL:
                    material_url = url
            hint = ("答案（1文本/2图片/3文件/4剪贴板/5多图+答案；直接输入或回车留空；"
                    "e 改题面 / r 重录 / s 放弃本题）› ")
            c.prompt(f"第 {target} 题{hint}" if multi else hint)
            answer = _collect_answer(paper_md_dir, c)
            if answer is None or answer in ("s", "skip"):
                c.warn(f"第 {target} 题已放弃，不记录")
                break

            # _collect_answer 把 e/r 原样返回，交给这里做「改题面/重录」（针对 stem）
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
                fresh = _collect_content(paper_md_dir, allow_images=(mode == "ocr"))
                if fresh and fresh.strip():
                    body = prep(fresh)
                else:
                    c.warn("没有收到新内容，保留原题面")
                continue

            if re.match(r"^[dci]\s+\d+", answer):
                c.warn("要删/改行，请按 e 进入编辑后再改")
                answer = ""
            if any(m in answer for m in _ECHO_MARKERS):
                c.warn("答案里混进了界面文字，已置空")
                answer = ""
            if not answer.strip():
                c.warn(f"第 {target} 题答案留空：复扫会再次报「答案缺失」，下次还会问你")
            record = {
                "source": issue["source"],
                "rel_path": issue["rel_path"],
                "group_order": target,
                "sub_no": issue.get("sub_no", 0),
                "content": stem.strip(),
                "options": options,
                "answer": answer,
                "material_text": material,
                # 自动拆出的材料是题内素材；不再有「题内/共享」通道选择
                "material_scope": "inline" if material else None,
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
            }
            if material_url is not _KEEP_URL:
                record["material_url"] = material_url
            records.append(record)
            c.ok(f"已记录第 {target} 题（{len(stem.strip())} 字）")
            break
    return records


def _ask_verdict(issue: dict) -> str:
    """内容层问题先问「你看来有没有问题」：problem 进三槽位 / ok 保持原样 / skip 稍后再说。"""
    c = console()
    c.legend([("1", "有问题，我来修正"), ("2", "没有问题，保持原样（不写库）"),
              ("s", "跳过，下次再问"), ("q", "退出")])
    while True:
        c.prompt(f"第 {_issue_no(issue)} 题你看来有问题吗 › ")
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


def _ask_repair_verdict() -> str:
    """砍短类专用门：两版摆在眼前，人工决定丢哪一版（不再强制重录）。"""
    c = console()
    c.legend([("1", "修复后没问题，保留现状"),
              ("2", "原文才对，恢复原文（丢弃修复）"),
              ("3", "两版都不对，我来改一次"),
              ("s", "跳过，下次再问"), ("q", "退出")])
    while True:
        c.prompt("修复后还是原文对 › ")
        raw = _read_line()
        if raw is None:
            return "skip"
        ans = raw.strip().lower()
        if ans in ("1", "ok", "y", "yes"):
            return "keep"
        if ans in ("2", "restore", "r"):
            return "restore"
        if ans in ("3", "fix", "problem", "n"):
            return "fix"
        if ans in ("s", "skip"):
            return "skip"
        if ans in ("q", "quit"):
            raise SystemExit(0)
        c.warn("请按 1（保留修复后）/ 2（恢复原文）/ 3（我来改）/ s（跳过）/ q（退出）选择")


def _restore_original_record(issue: dict, original: str) -> dict:
    """只带题干的写回记录：由 apply_fixes 的 content_only 分支原地恢复原文。"""
    return {
        "source": issue["source"],
        "rel_path": issue["rel_path"],
        "group_order": issue["group_order"],
        "sub_no": issue.get("sub_no", 0),
        "content": original.strip(),
        "content_only": True,
        "issue_kind": "repair_truncated",
        "issue_reasons": issue.get("reasons") or [],
        "pdf": issue.get("pdf"),
        "md": issue.get("md"),
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "operator": getpass.getuser(),
        "status": "ready",
        "applied": False,
    }


def _ask_repair_truncated(issue: dict, paper_md_dir: Path,
                          index: int | None, total: int | None) -> list[dict]:
    """自动修复砍短：把「修复前原文」和「当前修复后」一起摆出来，人工校对一次。

    旧逻辑把它当「题缺失/被吞」强制整题重录，导致同一道题换个 kind 再问一遍
    （2026-11-23 西城模拟一题18）。现在两版并列，人工只做一次裁决：
    保留修复后 / 恢复原文（丢弃修复）/ 两版都不对才录入一次。
    """
    c = console()
    _print_context(issue, index, total)
    original = _repair_original(issue)
    if not original:
        c.warn("找不到自动修复前的原文，只能人工录入本题")
        return _ask_slots(issue, paper_md_dir)
    c.write("")
    c.write(f"  {c.paint('自动修复前原文（完整，可整段拷贝）', 'dim')}")
    for line in original.splitlines():
        c.write(f"  {line}")
    c.write("")
    c.info("两版请对照原卷看：修复后常被 LLM 删掉真内容，也可能正是它清掉了脏字符/邻题图")
    verdict = _ask_repair_verdict()
    if verdict == "skip":
        return []
    if verdict == "keep":
        # 修复后没问题：按卷+题号关掉该题所有 flag，一个字段都不写库
        mark_issue(issue["source"], issue["group_order"], "resolved",
                   sub_no=issue.get("sub_no"),
                   note="人工校对：保留修复后版本", verdict="no_change",
                   content_sig=issue.get("content_sig"))
        c.ok(f"第 {_issue_no(issue)} 题已标记「确认无问题」，题库未改动")
        return []
    if verdict == "restore":
        c.ok(f"已记录第 {_issue_no(issue)} 题：写回自动修复前原文（写库时仅改题干）")
        return [_restore_original_record(issue, original)]
    return _ask_slots(issue, paper_md_dir)


def _collect_optional_block(paper_md_dir: Path, label: str, current: str | None,
                            *, hint: str = "这段不改") -> str | None:
    """收「修正后的某段材料」；直接回车=hint，有当前正文时可用 e 逐行编辑。"""
    c = console()
    if current:
        c.block(f"当前{label}", current, max_lines=8)
    edit_hint = "；e=编辑当前正文" if current else ""
    while True:
        c.prompt(f"粘贴{label}（EOF 结束；直接回车={hint}{edit_hint}）› ")
        first = _read_line()
        if first is None:
            return None
        raw = first.strip()
        if not raw:
            return None
        if raw.lower() in ("e", "edit") and current:
            edited = _line_edit(current)
            if edited is None:
                continue
            action, text = _confirm_text(edited, label=label)
            if action == "redo":
                continue
            if action in ("skip", "clear"):
                return None
            return text
        text = _collect_content(paper_md_dir, allow_images=False, label=label,
                                menu=False, first_line=first)
        if text is None:
            return None
        if looks_like_wrapped_copy(text):
            c.err("这段带终端折行痕迹（行首 │ / 标签被换行截断），写进去会一行一段、排版乱套")
            c.info("请从原卷 md 或网页正文复制；有当前正文时也可输入 e 直接改，别整段重粘")
            continue
        return text


def _ask_yes(c, prompt: str) -> bool:
    """材料槽位的开关：回车=不改，1=改。"""
    while True:
        c.prompt(prompt)
        raw = _read_line()
        if raw is None:
            return False
        ans = raw.strip().lower()
        if ans in ("", "n", "no"):
            return False
        if ans in ("1", "y", "yes"):
            return True
        c.warn("回车=不改，1=改")


def _parse_question_numbers(raw: str) -> list[int] | None:
    """解析 12-14 / 12,13,14 / 12、13；认不出返回 None。"""
    nums: list[int] = []
    for part in re.split(r"[,，、\s]+", (raw or "").strip()):
        if not part:
            continue
        m = re.fullmatch(r"(\d+)\s*[-~—–至]\s*(\d+)", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            nums.extend(range(min(a, b), max(a, b) + 1))
        elif part.isdigit():
            nums.append(int(part))
        else:
            return None
    return nums or None


def _ask_choice(c, prompt: str, allowed: tuple[str, ...]) -> str | None:
    """多选一：回车=None，命中 allowed 返回该选项。"""
    while True:
        c.prompt(prompt)
        raw = _read_line()
        if raw is None:
            return None
        ans = raw.strip().lower()
        if not ans:
            return None
        if ans in allowed:
            return ans
        c.warn("请按 " + " / ".join(allowed) + " 选择，或回车不改")


def _edit_material_file(issue: dict, label: str, current: str | None,
                        *, slug: str, source_url: str | None = None) -> str | None:
    """把当前正文写成项目内的普通文件，让用户用自己的编辑器改。

    原文档不动：这里是副本，改坏/取消都不会污染线上。保存后回车读取，工具再按
    原来的「重算 key → 同步同卷 → 回写库」流程处理。2026-11-22 用户提出：
    在 tty 里整段粘特别容易把终端折行和 │ 一起带进来。
    """
    c = console()
    source = re.sub(r'[\\/:*?"<>|\s]+', "_", str(issue.get("source") or "未命名"))
    path = ROOT / "output" / "manual_edits" / source / f"{int(issue['group_order']):02d}-{slug}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(((current or "").rstrip() + "\n") if current else "",
                    encoding="utf-8")
    c.write("")
    c.write(f"{label}副本（原文档不会被直接修改）：")
    c.write(f"  {path}")
    url = source_url
    if url:
        c.write(f"  （原文档：output/assets/{url}）")
    if current:
        c.info("用你自己的编辑器改这个文件，保存后回到这里")
    else:
        c.info("把文章正文（含标题）写进这个文件，保存后回到这里")
    while True:
        c.prompt("改好并保存后按回车读取（q=取消）› ")
        raw = _read_line()
        if raw is None or raw.strip().lower() in ("q", "quit"):
            return None
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            c.warn(f"读不到文件：{exc}")
            continue
        if not text:
            c.warn("文件是空的，没有收到正文")
            continue
        if looks_like_wrapped_copy(text):
            c.err("文件里仍有终端折行痕迹（行首 │ / 标签被换行截断），请清理后再读")
            continue
        if current is not None and text == (current or "").strip():
            c.warn("文件内容没有变化")
            return None
        c.block(f"{label}（{len(text.splitlines())} 行）", text,
                max_lines=max(len(text.splitlines()), 1) + 1)
        c.prompt("1=使用这份 / 2=重新读取 / 回车=取消 › ")
        ans = (_read_line() or "").strip().lower()
        if ans in ("1", "y", "yes"):
            return text
        if ans in ("2", "r"):
            continue
        return None


def _ask_share_with(issue: dict) -> list[int]:
    """新建共享材料时问共用题号：默认仅本题，工具不猜归属。"""
    c = console()
    current = int(issue["group_order"])
    taken = {no for no, _url in _published_material_urls(issue)}
    candidates = [(no, text) for no, _sub, text in _paper_question_rows(issue)
                  if no != current and no not in taken]
    # 题号整段丢失的题不在 extracted 里，但常常和问题题共用同一篇也丢掉的文章。
    # 把这些题号也列入候选，否则「19-22 一起丢」时给 Q19 挂文章根本填不进 20-22
    # （校验当它们不存在而拒收），只能每题重粘一遍（2026-11-22 海淀模拟一）。
    known = {no for no, _ in candidates} | {current} | taken
    for it in _read_jsonl(ISSUES_FILE):
        if (it.get("source") == issue.get("source")
                and it.get("kind") == "missing"
                and it.get("status") == "pending"):
            no = int(it.get("group_order", -1))
            if no > 0 and no not in known:
                candidates.append((no, "（题号丢失，待补）"))
                known.add(no)
    candidates.sort(key=lambda x: x[0])
    c.write("")
    c.write("这篇共享材料还给哪些题用？（回车=仅本题；可填 12-14 或 12,13,14）")
    for no, text in candidates[:15]:
        c.write(f"  {no}  {text[:28]}")
    if len(candidates) > 15:
        c.write(f"  …还有 {len(candidates) - 15} 题")
    allowed = {no for no, _ in candidates}
    while True:
        c.prompt("共用题号 › ")
        raw = _read_line()
        if raw is None or not raw.strip():
            return [current]
        nums = _parse_question_numbers(raw)
        if nums is None:
            c.warn("没认出题号，请输入如 12-14 或 12,13,14")
            continue
        bad = [n for n in nums if n not in allowed and n != current]
        if bad:
            c.warn(f"第 {'、'.join(map(str, bad))} 题不在可选范围"
                   "（可能已有共享材料），请重输")
            continue
        return [current] + sorted({n for n in nums if n != current})


def _ask_slots(issue: dict, paper_md_dir: Path) -> list[dict]:
    """语文内容题：依次问题干 / 共享材料 / 题内材料，改哪段由人工当场决定。

    槽位不存在也照样问 —— PDF→MD 丢材料时，没有入口就没法补。
    题干走 `_ask_one`（保留选项/答案/图片处理）；材料按内容归位：文章进
    content.md 并同步同卷，素材进 material_text；两者都改记 both。
    """
    c = console()
    original = _current_question(issue)
    strategy = get_strategy(_subject_of(issue))
    base = None
    stem_changed = False

    if original is not None:
        c.info("题干只粘题目本身；整篇文章留到「共享材料」那一步")
        stem_changed = _ask_yes(c, "题干要改吗？（1=改 / 回车=不改）› ")
    elif issue.get("kind") == "missing":
        # 题号丢失的题本来就没有「当前题干」，按整题补录处理，不是报错。
        c.info("本题题号/正文整段丢失：下面先补题干，再补共享材料与题内素材")
        stem_changed = True
    else:
        c.err("读不到本题当前题干（extracted 里没有这道题），只能整题重录")
        stem_changed = True

    if stem_changed:
        recs = _ask_one(issue, issue["group_order"], "按原卷修正题干",
                        paper_md_dir, strategy)
        if not recs:
            return []
        if len(recs) > 1:
            c.warn("这次录入了多道题，材料修改请对每道题分别再跑一次")
            return recs
        base = recs[0]
    else:
        base = {
            "source": issue["source"],
            "rel_path": issue["rel_path"],
            "group_order": issue["group_order"],
            "sub_no": issue.get("sub_no", 0),
            "content": original.get("content") or "",
            "options": original.get("options"),
            # 带回原题答案：_patch_extracted 会把 answer 写回 extracted，留空会抹掉
            "answer": original.get("answer") or "",
            "issue_kind": issue["kind"],
            "issue_reasons": issue.get("reasons") or [],
            "expected_type": None,
            "pdf": issue.get("pdf"),
            "md": issue.get("md"),
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "operator": getpass.getuser(),
            "status": "ready",
            "applied": False,
        }

    slots = _material_slots(issue)
    has_article = bool(slots["article_url"] or slots["article"])
    article = inline = None
    share_with: list[int] | None = None

    c.write("")
    if has_article:
        if slots["article"]:
            c.info(f"共享材料：当前 {len(slots['article'])} 字")
        else:
            c.info("共享材料：库里挂着文档但读不到正文")
        choice = _ask_choice(
            c, "共享材料要改吗？（1=在文件里改 / 2=粘贴文本 / 回车=不改）› ",
            ("1", "2"))
        if choice == "1":
            article = _edit_material_file(issue, "共享材料", slots["article"],
                                          slug="共享材料",
                                          source_url=slots["article_url"])
        elif choice == "2":
            article = _collect_optional_block(paper_md_dir, "共享材料全文",
                                              slots["article"])
    else:
        c.info("共享材料：本题没有（PDF 转换丢了可以在这里补）")
        choice = _ask_choice(
            c, "要新增共享材料吗？（1=在文件里写 / 2=粘贴文本 / 回车=不加）› ",
            ("1", "2"))
        if choice == "1":
            article = _edit_material_file(issue, "共享材料", None, slug="共享材料")
        elif choice == "2":
            article = _collect_optional_block(paper_md_dir, "共享材料全文", None,
                                              hint="取消")
        if article:
            share_with = _ask_share_with(issue)

    c.write("")
    inline_now = slots["inline"]
    c.info(f"题内材料：{'当前 ' + str(len(inline_now)) + ' 字' if inline_now else '（无）'}")
    choice = _ask_choice(
        c, "题内材料要改/补吗？（1=在文件里改 / 2=粘贴文本 / 回车=不改）› ",
        ("1", "2"))
    if choice == "1":
        inline = _edit_material_file(issue, "题内材料", inline_now, slug="题内材料")
    elif choice == "2":
        inline = _collect_optional_block(paper_md_dir, "题内材料", inline_now)

    if article is None and inline is None:
        if stem_changed:
            return [base]
        # 三段都没改：用户看过原卷后确认无事，按「确认无问题」收口
        mark_issue(issue["source"], issue["group_order"], "resolved",
                   sub_no=issue.get("sub_no"),
                   note="人工确认无问题，未改动",
                   verdict="no_change", content_sig=issue.get("content_sig"))
        c.ok(f"第 {_issue_no(issue)} 题已标记「确认无问题」，题库未改动")
        return []

    # 整题重录时若粘的是文章，_ask_one 已自动转成 material_target=article；
    # 后面的槽位合并不能把这段新文章丢掉。
    if article is None and base.get("material_target") in ("article", "both"):
        article = base.get("material_text")

    if (inline is not None and article is None
            and not slots["article_url"] and slots["article"]):
        # 文章还没外置、正文就在 material_text 里：只补题内素材也必须把文章一起
        # 带出，否则 apply 会把 inline 当成唯一 material_text，把文章冲掉。
        article = slots["article"]

    if article is not None:
        # 题号丢失题在 _ask_one 里答过「认领某篇已有文章 URL」，这里又粘了新正文。
        # 两者同时进 apply_fixes 会被「指认 URL 与改文章正文不能同时进行」整条跳过
        # （apply_fixes.py:781）。新建文档会算出新 URL 直接写库，丢掉旧 URL 才对。
        if isinstance(base.get("material_url"), str) and base["material_url"].strip():
            c.warn("本题已认领的旧 URL 被新粘的正文取代（正文会生成新文档）")
            base.pop("material_url", None)

    if article is not None and inline is not None:
        base["material_target"] = "both"
        base["material_text"] = article
        base["material_inline_text"] = inline
        base.pop("material_scope", None)
    elif article is not None:
        base["material_target"] = "article"
        base["material_text"] = article
        base["material_scope"] = "article"
    else:
        base["material_target"] = "inline"
        base["material_text"] = inline
        base["material_scope"] = "inline"
    if share_with:
        base["material_share_with"] = share_with
    return [base]


def _ask(issue: dict, paper_md_dir: Path,
         index: int | None = None, total: int | None = None) -> list[dict]:
    """逐题引导：先修被吞的那一题，再补缺失的那一题；每题各自以 EOF 结束。

    内容层问题（不完整/前后题合并）多一道门：先问人工「有没有问题」。
    确认没问题 → 只把结论写进清单（verdict=no_change），一个字段都不改库；
    确认有问题 → 依次问「题干 / 共享材料 / 题内材料」，每段都能回车跳过，
    槽位不存在也允许新增（PDF→MD 丢材料时这是唯一入口）。

    repair_truncated 单独走双版本校对（_ask_repair_truncated），不再强制整题重录。
    """
    if issue.get("kind") == "repair_truncated":
        return _ask_repair_truncated(issue, paper_md_dir, index, total)
    strategy = get_strategy(_subject_of(issue))
    _print_context(issue, index, total)

    if issue.get("kind") in _CONTENT_KINDS and issue.get("kind") != "answer_missing":
        verdict = _ask_verdict(issue)
        if verdict == "ok":
            mark_issue(issue["source"], issue["group_order"], "resolved",
                       sub_no=issue.get("sub_no"),
                       note="人工确认无问题，未改动",
                       verdict="no_change",
                       content_sig=issue.get("content_sig"))
            console().ok(f"第 {_issue_no(issue)} 题已标记「确认无问题」，题库未改动")
            return []
        if verdict == "skip":
            return []
        # 有问题 → 依次问题干 / 共享材料 / 题内材料（三段都可不改）
        return _ask_slots(issue, paper_md_dir)

    # 题号整段丢失的语文题：PDF→MD 常把题干和跨题共享文章一起丢掉。这类题以前
    # 走 _ask_one，只能补题干 + 认领一个已存在的 URL，没有录入共享文章正文的入口。
    # 改成走三段式：题干仍由 _ask_one 录入（original 为空时它本来就做整题补录），
    # 共享材料可新建/粘贴。这样和「内容不完整」题用同一套槽位，不再有盲区。
    if issue.get("kind") == "missing" and _subject_of(issue) == "chinese":
        return _ask_slots(issue, paper_md_dir)

    targets = _targets(issue)
    records: list[dict] = []
    for i, (no, note) in enumerate(targets, 1):
        records.extend(_ask_one(issue, no, note, paper_md_dir, strategy, i, len(targets)))
    return records


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
            c.warn(f"第 {_issue_no(issue)} 题缺少 md 路径，已跳过")
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
        batch: dict[int, dict] = {}
        for record in records:
            _keep_prior_images(batch.get(record["group_order"]), record)
            rows = [r for r in rows if r["group_order"] != record["group_order"]]
            rows.append(record)
            batch[record["group_order"]] = record
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

def papers_in_scope(subject: str | None, file: str | None,
                    sources: set[str] | None = None) -> list[dict]:
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
        if sources is not None and source not in sources:
            continue
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
    batch: dict[int, dict] = {}
    for record in records:
        _keep_prior_images(batch.get(record["group_order"]), record)
        rows = [r for r in rows if r["group_order"] != record["group_order"]]
        rows.append(record)
        batch[record["group_order"]] = record
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
                      fixes_dir: Path | None = None,
                      *, sources: set[str] | None = None) -> int:
    """主动重录：用户直接说「第 N 题有问题」，不依赖扫描清单。

    为什么需要：扫描只报它认得出的结构问题；PDF→MD 阶段丢图/丢字它未必能发现
    （2026-11-03 汇文题6 一张图没截出来）。这时要能主动点名重录。

    粘贴内容可以是一整段「材料 + 题干 + 小问 + 选项 + 图片」：
    `_ask_one` 先 `split_material` 拆材料、再 `split_options` 拆选项，
    分别落到 material_text / content / options；图片引用由 apply_fixes 统一物化。

    Returns: 本次记录的题数。
    """
    c = console()
    papers = papers_in_scope(subject, file, sources=sources)
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
           "程序会分别拆到材料/题干/选项；已有题会先问图怎么处理："
           "保留原图只改文字 / 换图（不识别）/ 重新截图识别 / 只改文本（原内容全清）")

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
                "sub_no": 0,
                "kind": "manual_override",
                "reasons": ["用户主动指定重录"],
                "md": str(md_path),
                "pdf": str(paper["pdf"]) if paper["pdf"] else None,
            }
            records = (
                _ask_slots(issue, md_path.parent)
                if subject_code_for_path(Path(paper["rel_path"]), default="") == "chinese"
                and _current_question(issue) is not None
                else _ask_one(issue, no, "用户主动指定这道题有问题，请录入完整内容",
                              md_path.parent, strategy, i, len(nums))
            )
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
