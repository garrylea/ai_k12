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

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from scope_filter import match_keyword
from subject_strategies import get_strategy

from review_content import (  # noqa: F401
    _IMG_PLACEHOLDER_RE,
    Snapshot,
    editable_body,
    snapshot,
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
    read_images,
    read_slot,
    render_copyable,
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
    ReviewItem,
    ReviewTarget,
    _read_jsonl,
    _write_jsonl,
    group_items,
    humanize_reasons,
    mark_issue,
    pending_issues,
    pending_items,
    recorded_flags,
)
from review_records import (  # noqa: F401
    UNSET,
    MaterialPatch,
    Patch,
    ReviewDraft,
    _copy_new_images,
    _keep_prior_images,
    _save_records,
    build_record,
    discard_fixes_for_source,
    has_changes,
)


# ── 新流程：一题一卡、一张菜单、五个槽位 ──────────────────────────────

@dataclass
class QuestionPart:
    group_order: int
    sub_no: int
    content: str
    options: list[dict] | None
    material: str | None


@dataclass
class CardResult:
    action: str                       # record / ok / skip / batch / noop
    patch: Patch | None = None
    batch: list[QuestionPart] = field(default_factory=list)


@dataclass
class RunResult:
    records: list[dict] = field(default_factory=list)
    outcome: str = "skipped"          # recorded / ok / skipped


@dataclass
class View:
    content: str
    options: list[dict]
    answer: str
    article_url: str | None
    article: str | None
    inline: str | None
    images: list[str]


@dataclass
class CardState:
    item: ReviewItem
    target: ReviewTarget
    snap: Snapshot
    draft: ReviewDraft
    paper_dir: Path
    index: int = 1
    total: int = 1

    @property
    def view(self) -> View:
        p = self.draft.patch
        m = p.material
        article = self.snap.article if m.article is UNSET else m.article
        inline = self.snap.inline if m.inline is UNSET else m.inline
        if p.images_mode != "keep":
            images = list(p.images)
        else:
            images = list(self.snap.images)
        answer = "" if p.clear_answer else (
            p.answer if p.answer is not None else self.snap.answer)
        if isinstance(m.url_claim, str):
            article_url = m.url_claim
        elif m.url_claim is None:
            article_url = None
        else:
            article_url = self.snap.article_url
        return View(
            content=p.content if p.content is not None else self.snap.content,
            options=p.options if p.options is not None else self.snap.options,
            answer=answer,
            article_url=article_url,
            article=article,
            inline=inline,
            images=images,
        )


def _label(group_order: int, sub_no: int = 0) -> str:
    return f"{group_order}({sub_no})" if sub_no else str(group_order)


def _issue_for(item: ReviewItem, group_order: int, sub_no: int) -> dict:
    flag = next(
        (
            f for f in item.flags
            if int(f.get("group_order") or item.group_order) == group_order
            and int(f.get("sub_no") or 0) == sub_no
        ),
        item.flags[0] if item.flags else {},
    )
    return {
        "source": item.source,
        "rel_path": item.rel_path,
        "group_order": group_order,
        "sub_no": sub_no,
        "kind": flag.get("kind"),
        "reasons": flag.get("reasons") or [],
        "md": flag.get("md"),
        "pdf": flag.get("pdf"),
        "content_sig": flag.get("content_sig"),
        "suspect_group_order": flag.get("suspect_group_order"),
        "suspect_sub_no": flag.get("suspect_sub_no"),
    }


def snapshot_for(item: ReviewItem, group_order: int, sub_no: int, *,
                 load_repair: bool = False) -> Snapshot:
    return snapshot(_issue_for(item, group_order, sub_no), load_repair=load_repair)


def _reasons_for(item: ReviewItem) -> list[str]:
    out: list[str] = []
    for f in item.flags:
        for r in humanize_reasons(f.get("reasons") or []):
            if r not in out:
                out.append(r)
    return out


def render_card(state: CardState) -> None:
    c = console()
    item, target, view = state.item, state.target, state.view
    kinds = " + ".join(KIND_TEXT.get(k, k) for k in sorted(item.kinds))
    c.step(state.index, state.total, f"第 {_label(target.group_order, target.sub_no)} 题",
           target.note)
    c.write("  " + c.paint(kinds, "cyan"))
    flag = item.flags[0] if item.flags else {}
    c.kv([("卷", item.source),
          ("原卷", flag.get("pdf") or "（未找到对应 PDF）"),
          ("文本", flag.get("md") or "—")], label_width=4)
    reasons = _reasons_for(item)
    if reasons:
        from cli_ui import wrap_items
        for i, line in enumerate(wrap_items(reasons, c.width - 8)):
            c.write(f"  {c.paint('依据' if i == 0 else '    ', 'dim')}  {line}")
    if any(f.get("suspect_group_order") for f in item.flags):
        c.warn("关联题的正文里可能混进了本题：先核对关联题，再回到本题")
    render_copyable(c, "题干（可整段拷贝）", view.content, max_lines=None)
    if view.options:
        c.write("  选项  " + "  ".join(
            f"{o.get('label')}. {o.get('text')}" for o in view.options))
    render_copyable(c, "共享材料（可整段拷贝）", view.article, max_lines=8)
    render_copyable(c, "题内材料", view.inline, max_lines=8)
    c.write(f"  {c.paint('答案', 'dim')}      {view.answer or '空'}")
    imgs = "、".join(f"图{i} {r.split('/')[-1]}" for i, r in enumerate(view.images, 1))
    c.write(f"  {c.paint('图片', 'dim')}      {len(view.images)} 张"
            + (f"（{imgs}）" if imgs else ""))
    if state.snap.repair_original:
        render_copyable(c, "自动修复前（完整，可整段拷贝）",
                        state.snap.repair_original, max_lines=None)


def ask_menu(c, *, is_repair: bool, has_original: bool,
             has_content: bool) -> tuple[str, str | None]:
    c.write("")
    c.write("  要改哪段？ " + c.paint(
        "1 题干/选项 · 2 共享材料 · 3 题内材料 · 4 答案 · 5 图", "dim"))
    tail = []
    if has_content:
        tail.append("E 编辑器改整题")
    tail += ["R 全换（清空材料/图）", "k 确认无问题"]
    if is_repair and has_original:
        tail.append("u 用修复前原文")
    c.write("           " + c.paint(" · ".join(tail), "dim"))
    c.write("           " + c.paint("回车=结束本题 · s 稍后再说 · q 退出", "dim"))
    while True:
        c.prompt("› ")
        raw = _read_line()
        if raw is None:
            return "skip", None
        ans = raw.strip()
        if not ans:
            return "enter", None
        if ans in ("1", "2", "3", "4", "5"):
            return "slot", ans
        low = ans.lower()
        if low == "e":
            return "edit_all", None
        if low == "r":
            return "replace", None
        if low in ("k", "ok"):
            return "ok", None
        if low in ("s", "skip"):
            return "skip", None
        if low in ("q", "quit"):
            return "quit", None
        if low == "u" and is_repair and has_original:
            return "restore", None
        c.warn("请按 1–5 / E / R / k / u / 回车 / s / q")


def close_as_ok(item: ReviewItem, target: ReviewTarget) -> None:
    c = console()
    note = "人工确认无问题，未改动"
    if item.kinds == {"junk_question"}:
        note = "人工确认：这行不是题目，忽略"
    elif ("missing" in item.kinds
          and target.group_order == item.group_order
          and not snapshot_for(item, target.group_order, target.sub_no).content):
        note = "人工确认：卷面本来没有这道题"
    sig = next((f.get("content_sig") for f in item.flags if f.get("content_sig")), None)
    mark_issue(item.source, target.group_order, "resolved", note=note,
               verdict="no_change", content_sig=sig, sub_no=target.sub_no)
    c.ok(f"第 {_label(target.group_order, target.sub_no)} 题已标记「确认无问题」，题库未改动")


def edit_content_slot(state: CardState) -> CardResult | None:
    kind, text = read_slot(
        console(),
        label="题干/选项",
        hint="回车=不改；粘贴=整段替换，EOF 结束；:e 编辑器 · :l 逐行 · :f 文件/剪贴板 · :c 清空",
        current=state.view.content,
        paper_md_dir=state.paper_dir,
    )
    if kind == "unchanged":
        return None
    if kind == "clear":
        state.draft.set_content("", [])
        return None
    parts = split_questions(text, get_strategy(state.item.subject))
    parts = _one_question_body(parts) or parts
    if len(parts) > 1:
        batch: list[QuestionPart] = []
        for no, body in parts:
            material, stem, options = split_material_and_options(
                get_strategy(state.item.subject), body)
            if not stem.strip():
                console().err(f"第 {no} 题解析出的题干为空，这批未记录")
                return None
            sub_no = state.item.sub_no if no == state.item.group_order else 0
            batch.append(QuestionPart(no, sub_no, stem.strip(), options, material))
        return CardResult("batch", batch=batch)
    material, stem, options = split_material_and_options(
        get_strategy(state.item.subject), text)
    if not stem.strip():
        console().err("题干解析为空（选项字母写在内容下面的排版会造成这样），本条未记录")
        return None
    if not options and state.view.options:
        console().warn(f"这段没有选项，保留原题 {len(state.view.options)} 个选项")
        options = state.view.options
    state.draft.set_content(stem.strip(), options)
    if material:
        console().info(f"这段里的材料已归到题内材料（{len(material)} 字）")
        state.draft.set_inline(material)
    if _IMG_PLACEHOLDER_RE.search(stem):
        console().warn("正文里还有 [图N]，按 5 配图（不配会原样保留）")
    return None


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


def _ask_share_with(issue: dict) -> list[int]:
    """新建共享材料时问共用题号：默认仅本题，工具不猜归属。"""
    c = console()
    current = int(issue["group_order"])
    taken = {no for no, _url in _published_material_urls(issue)}
    candidates = [
        (no, sub_no, text)
        for no, sub_no, text in _paper_question_rows(issue)
        if no != current and no not in taken
    ]
    c.write("")
    c.write("这篇共享材料还给哪些题用？（回车=仅本题；可填 12-14 或 12,13,14）")
    for no, sub_no, text in candidates[:15]:
        c.write(f"  {_label(no, sub_no)}  {text[:28]}")
    allowed = {no for no, _sub, _text in candidates} | {current}
    while True:
        c.prompt("共用题号 › ")
        raw = _read_line()
        if raw is None or not raw.strip():
            return [current]
        nums = _parse_question_numbers(raw)
        if nums is None:
            c.warn("没认出题号，请输入如 12-14 或 12,13,14")
            continue
        bad = [no for no in nums if no not in allowed]
        if bad:
            c.warn(f"第 {'、'.join(map(str, bad))} 题不在可选范围"
                   "（可能已有共享材料），请重输")
            continue
        return [current] + sorted({no for no in nums if no != current})


def edit_article_slot(state: CardState) -> None:
    c = console()
    issue = _issue_for(state.item, state.target.group_order, state.target.sub_no)
    cands = [] if state.view.article_url else _published_material_urls(issue)
    if cands:
        c.write("  同卷已有文章：")
        for i, (no, url) in enumerate(cands[:8], 1):
            c.write(f"    {i}) 第{no}题  {url}")
    hint = "回车=不改；粘贴=替换全文；:e · :f · :p 看全文"
    if cands:
        hint += " · 序号=沿用 · n=本题无材料"
    c.prompt(f"共享材料 › （{hint}）")
    first = _read_line()
    if first is None or not first.strip():
        return
    text = first.strip()
    if cands and text.isdigit() and 1 <= int(text) <= len(cands):
        state.draft.claim_url(cands[int(text) - 1][1])
        return
    if cands and text.lower() == "n":
        state.draft.clear_materials()
        return
    kind, article = read_slot(
        c, label="共享材料", current=state.view.article,
        paper_md_dir=state.paper_dir, allow_clear=False,
        allow_line_edit=False, first_line=text,
    )
    if kind != "value":
        return
    state.draft.set_article(article)
    if not state.view.article_url and not state.view.article:
        state.draft.set_share_with(_ask_share_with(issue))


def edit_inline_slot(state: CardState) -> None:
    kind, text = read_slot(
        console(),
        label="题内材料",
        hint="回车=不改；粘贴=替换；:e · :l · :f · :c 删除",
        current=state.view.inline,
        paper_md_dir=state.paper_dir,
        reject_wrapped=True,
    )
    if kind == "unchanged":
        return
    if kind == "clear":
        state.draft.clear_inline()
    else:
        state.draft.set_inline(text)


def edit_answer_slot(state: CardState) -> None:
    kind, text = read_slot(
        console(),
        label="答案",
        hint="回车=不改；粘贴答案；:e · :f · :c 置空",
        current=state.view.answer,
        paper_md_dir=state.paper_dir,
    )
    if kind == "unchanged":
        return
    if kind == "clear":
        state.draft.clear_answer()
    else:
        state.draft.set_answer(text)


def edit_image_slot(state: CardState) -> None:
    mode, paths = read_images(console(), state.view.images, state.paper_dir)
    if mode == "unchanged":
        return
    if mode == "clear":
        state.draft.set_images([], "clear")
        return
    refs = _copy_new_images(paths, state.paper_dir)
    if not refs:
        console().warn("拷图失败，未改动")
        return
    if mode == "append":
        state.draft.set_images([*state.view.images, *refs], "append")
    else:
        state.draft.set_images(refs, "replace")


def replace_all(state: CardState) -> None:
    c = console()
    c.prompt("全换（题干/选项/材料/图清空，答案保留） "
             "1 粘贴文本 · 2 图片识别（MinerU）· 3 文件 · 回车=取消 › ")
    raw = _read_line()
    if raw is None or not raw.strip():
        return
    ans = raw.strip()
    if ans == "2":
        text = _from_image(state.paper_dir)
    elif ans == "3":
        text = _from_file(state.paper_dir)
    else:
        kind, text = read_slot(c, label="新题面", hint="粘贴全文，EOF 结束",
                               current="", paper_md_dir=state.paper_dir)
        if kind != "value":
            return
    if not text or not text.strip():
        c.warn("没有收到内容")
        return
    material, stem, options = split_material_and_options(
        get_strategy(state.item.subject), text)
    if not stem.strip():
        c.err("题干解析为空，未改动")
        return
    state.draft.clear_materials()
    state.draft.set_content(stem.strip(), options or [])
    state.draft.set_images([], "clear")
    if material:
        state.draft.set_inline(material)


def edit_whole_in_editor(state: CardState) -> None:
    body = editable_body(state.snap)
    edited, _path = _file_edit(body, f"第{state.target.group_order}题题干")
    if edited is None or not edited.strip():
        console().warn("没有收到修改")
        return
    material, stem, options = split_material_and_options(
        get_strategy(state.item.subject), edited)
    if not stem.strip():
        console().err("题干解析为空，未改动")
        return
    state.draft.set_content(stem.strip(), options)
    state.draft.set_images([], "explicit")
    if material:
        state.draft.set_inline(material)


def run_card(item: ReviewItem, target: ReviewTarget, snap: Snapshot,
             index: int, total: int) -> CardResult:
    c = console()
    md = next((f.get("md") for f in item.flags if f.get("md")), None)
    state = CardState(item=item, target=target, snap=snap,
                      draft=ReviewDraft(snap), paper_dir=Path(md).parent,
                      index=index, total=total)
    if item.kinds == {"answer_missing"} and snap.content:
        edit_answer_slot(state)
        changed = has_changes(state.draft.patch)
        return CardResult("record" if changed else "noop",
                          patch=state.draft.patch if changed else None)
    while True:
        render_card(state)
        action, arg = ask_menu(
            c, is_repair=item.is_repair,
            has_original=bool(snap.repair_original),
            has_content=bool(state.view.content))
        if action == "slot":
            if arg == "1":
                res = edit_content_slot(state)
                if res is not None:
                    return res
            elif arg == "2":
                edit_article_slot(state)
            elif arg == "3":
                edit_inline_slot(state)
            elif arg == "4":
                edit_answer_slot(state)
            elif arg == "5":
                edit_image_slot(state)
        elif action == "edit_all":
            edit_whole_in_editor(state)
        elif action == "replace":
            replace_all(state)
        elif action == "restore":
            state.draft.use_restore_original(snap.repair_original or "")
        elif action == "ok":
            close_as_ok(item, target)
            return CardResult("ok")
        elif action == "skip":
            return CardResult("skip")
        elif action == "enter":
            changed = has_changes(state.draft.patch)
            return CardResult("record" if changed else "noop",
                              patch=state.draft.patch if changed else None)
        elif action == "quit":
            raise SystemExit(0)


def run_item(item: ReviewItem, index: int, total: int) -> RunResult:
    out = RunResult()
    primary_ok = False
    for target in item.targets():
        snap = snapshot_for(item, target.group_order, target.sub_no,
                            load_repair=item.is_repair)
        result = run_card(item, target, snap, index, total)
        if result.action == "skip":
            out.outcome = "recorded" if out.records else "skipped"
            return out
        if result.action == "ok":
            if (target.group_order, target.sub_no) == (item.group_order, item.sub_no):
                primary_ok = True
                break
            continue
        if result.action == "noop":
            continue
        if result.action == "batch":
            for part in result.batch:
                part_snap = snapshot_for(item, part.group_order, part.sub_no)
                patch = Patch(
                    content=part.content,
                    options=part.options,
                    material=MaterialPatch(
                        article=UNSET,
                        inline=part.material if part.material is not None else UNSET,
                    ),
                )
                out.records.append(
                    build_record(item, part.group_order, part.sub_no, patch, part_snap))
            out.outcome = "recorded"
            return out
        if result.action == "record" and result.patch is not None:
            out.records.append(
                build_record(
                    item, target.group_order, target.sub_no, result.patch, snap,
                    dominant_type=(item.dominant_type
                                   if "type_mismatch" in item.kinds else None),
                )
            )
    if out.records:
        out.outcome = "recorded"
    elif primary_ok:
        out.outcome = "ok"
    return out


def _print_table(items: list[ReviewItem]) -> None:
    """只列清单：一题一行，问题列合并该题全部 kind。"""
    from cli_ui import pad, truncate_middle

    c = console()
    w_src = min(44, c.width - 24)
    c.write("")
    c.write("  " + c.paint(f"{pad('卷', w_src)}  题号  问题", "dim"))
    c.rule("─")
    for item in items:
        kinds = " + ".join(KIND_TEXT.get(k, k) for k in sorted(item.kinds))
        src = pad(truncate_middle(item.source, w_src), w_src)
        no = _label(item.group_order, item.sub_no)
        c.write(f"  {src}  {no:>6}  {c.paint(kinds, 'cyan')}")
        reasons = [r for r in _reasons_for(item) if r not in kinds]
        if reasons:
            from cli_ui import wrap_items
            for line in wrap_items(reasons, c.width - 8):
                c.write("      " + c.paint(line, "dim"))
    c.write("")
    c.info(f"共 {len(items)} 题待处理")


def review_pending(sources: set[str] | None = None,
                   file: str | None = None,
                   *, list_only: bool = False,
                   fixes_dir: Path | None = None,
                   limit: int | None = None) -> dict:
    """逐题引导补题。返回 {"pending", "fixed", "skipped", "confirmed_ok"}。"""
    c = console()
    items = pending_items(sources, file)
    result = {"pending": len(items), "fixed": 0, "skipped": 0, "confirmed_ok": 0}
    if not items:
        c.write("")
        c.ok("没有待人工处理的题")
        return result

    if list_only:
        _print_table(items)
        return result

    # 先打整张清单：中途 q 或被打断时，用户仍知道后面还有哪几题
    _print_table(items)
    c.banner("识别问题补录",
             f"待处理 {len(items)} 题 · 一题一卡 · 回车=结束本题 · k=确认无问题 · s=稍后 · q=退出")

    out_dir = Path(fixes_dir) if fixes_dir else FIXES_DIR
    todo = items[:limit] if limit else items
    try:
        _review_loop(todo, out_dir, result, c)
    except SystemExit:
        c.warn("已退出（未处理的条目会保留，下次运行同一条命令继续问）")

    remaining = len(pending_items(sources, file))
    if remaining:
        _print_remaining(sources, file)
    unapplied = 0
    try:
        from apply_fixes import pending_records
        unapplied = len(pending_records())
    except Exception:                              # noqa: BLE001 - 统计失败不能挡住收尾
        unapplied = 0
    stats = [("本次补录", f"{result['fixed']} 题"),
             ("确认无问题", f"{result['confirmed_ok']} 题"),
             ("稍后", f"{result['skipped']} 题"),
             ("仍待处理", f"{remaining} 题")]
    if unapplied:
        stats.append(("另有待写库", f"{unapplied} 条"))
    stats.append(("落盘", str(out_dir)))
    c.summary(stats)
    if result["fixed"]:
        c.info("补录内容会随本次命令一起入库（结束时还会问一次）")
    return result


def _print_remaining(sources: set[str] | None, file: str | None) -> None:
    """把还没处理的题列出来（题号 + 类型），保证中途退出也能看见剩余项。"""
    left = pending_items(sources, file)
    if not left:
        return
    c = console()
    by_src: dict[str, list[str]] = {}
    for item in left:
        kinds = "/".join(KIND_TEXT.get(k, k) for k in sorted(item.kinds))
        by_src.setdefault(item.source, []).append(
            f"第{_label(item.group_order, item.sub_no)}题（{kinds}）")
    c.write("")
    c.write("  还没处理：")
    for src, lst in by_src.items():
        head = "、".join(lst[:8]) + (f" 等 {len(lst)} 题" if len(lst) > 8 else "")
        c.write(f"  {src}：{head}")


def _review_loop(todo: list[ReviewItem], out_dir: Path, result: dict, c) -> None:
    """逐题引导的主体（抽出来是为了让 q 退出时还能打印剩余条目）。"""
    for n, item in enumerate(todo, 1):
        live = {i.key for i in pending_items()}
        if item.key not in live:
            continue                 # 前面的粘贴已顺带补好该题
        if not next((f.get("md") for f in item.flags if f.get("md")), None):
            c.warn(f"第 {_label(item.group_order, item.sub_no)} 题缺少 md 路径，已跳过")
            result["skipped"] += 1
            continue
        res = run_item(item, n, len(todo))
        if res.outcome == "recorded":
            out_file = _save_records(item.source, res.records, out_dir)
            ts = res.records[0]["created_at"]
            for go, sub in {(int(r["group_order"]), int(r.get("sub_no") or 0))
                            for r in res.records}:
                recorded_flags(
                    ReviewItem(source=item.source, rel_path=item.rel_path,
                               group_order=go, sub_no=sub),
                    str(out_file), ts,
                )
            result["fixed"] += len(res.records)
        elif res.outcome == "ok":
            result["confirmed_ok"] += 1
        else:
            result["skipped"] += 1


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
    out_dir = Path(fixes_dir) if fixes_dir else FIXES_DIR

    c.banner("主动重录",
             f"{paper['source']} · 输入题号（多个用逗号），回车结束 · q 退出")
    c.info("粘贴内容可以是「材料 + 题干 + 小问 + 选项 + 图片」一整段，"
           "程序会分别拆到材料/题干/选项；改完在卡片上按回车落记录")

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
            item = ReviewItem(
                source=paper["source"],
                rel_path=str(paper["rel_path"]),
                group_order=no,
                sub_no=0,
                manual=True,
                flags=[{
                    "kind": "manual_override",
                    "reasons": ["用户主动指定重录"],
                    "md": str(md_path),
                    "pdf": str(paper["pdf"]) if paper["pdf"] else None,
                }],
            )
            res = run_item(item, i, len(nums))
            if res.records:
                _save_records(paper["source"], res.records, out_dir)
                total += len(res.records)
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
