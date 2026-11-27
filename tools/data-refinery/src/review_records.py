"""人工校对的补题记录生成：三态草稿（``ReviewDraft``）→ manual_fixes 记录。

从 ``manual_fix.py`` 搬出（2026-11-26 人工校对重构 Task 4）。分层：
``review_records`` ← ``review_content`` ← ``review_queue``；本模块可以 import
``review_content`` / ``review_queue``，但 ``review_content`` **不得**反过来 import
本模块（否则循环）。``manual_fix`` 用具名 import 把搬走的名字导回去，旧流程不变。

三态的含义（设计 §5.2）：``UNSET`` 是「这一段没改」，``None`` 是「显式清空」，
其他值是「改成了这个」。材料两段（共享文章 / 题内素材）必须分别判三态 ——
把「没改」当成「清空」会让只补题干的用户丢掉整篇文章。
"""

import getpass
import hashlib
import re
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from review_content import (
    _append_missing_images,
    _apply_image_placeholders,
    _current_question,
    _image_refs,
    _option_image_refs,
)
from review_editor import console
from review_queue import FIXES_DIR, _read_jsonl, _write_jsonl
from scope_filter import match_keyword

UNSET = object()


@dataclass
class MaterialPatch:
    article: str | None | object = UNSET
    inline: str | None | object = UNSET
    url_claim: object = UNSET
    share_with: list[int] | None = None


@dataclass
class Patch:
    content: str | None = None
    options: list[dict] | None = None
    answer: str | None = None
    clear_answer: bool = False
    material: MaterialPatch = field(default_factory=MaterialPatch)
    images: list[str] = field(default_factory=list)
    images_mode: str = "keep"
    content_only: bool = False


class ReviewDraft:
    """字段级修改入口；禁止外部整体替换 ``patch.material``（后改的槽位会覆盖先改的）。"""

    def __init__(self, snap):
        self.snap = snap
        self.patch = Patch()
        self.revision = 0

    def _touch(self):
        self.revision += 1

    def _regular_edit(self):
        self.patch.content_only = False
        self._touch()

    def set_content(self, content, options):
        self._regular_edit()
        self.patch.content = content
        self.patch.options = options

    def set_answer(self, answer):
        self._regular_edit()
        self.patch.answer = answer
        self.patch.clear_answer = False

    def clear_answer(self):
        self._regular_edit()
        self.patch.answer = ""
        self.patch.clear_answer = True

    def set_article(self, article):
        self._regular_edit()
        self.patch.material.article = article
        # 新正文会生成新文档：先前认领的旧 URL 必须作废（apply 见到两者同时在场会整条跳过）
        self.patch.material.url_claim = UNSET

    def set_inline(self, inline):
        self._regular_edit()
        self.patch.material.inline = inline

    def clear_inline(self):
        self.set_inline(None)

    def claim_url(self, url):
        self._regular_edit()
        self.patch.material.url_claim = url

    def set_share_with(self, numbers):
        self._regular_edit()
        self.patch.material.share_with = list(numbers)

    def clear_materials(self):
        self._regular_edit()
        self.patch.material.article = None
        self.patch.material.inline = None
        self.patch.material.url_claim = None
        self.patch.material.share_with = None

    def set_images(self, refs, mode):
        self._regular_edit()
        self.patch.images = list(refs)
        self.patch.images_mode = mode

    def use_restore_original(self, content):
        # 刻意不调 _regular_edit：`u` 是「用修复前原文整题替换」，
        # 之后再改别的字段时才降级成普通记录（content 已是原文）。
        self.patch.content = content
        self.patch.content_only = True
        self._touch()


def has_changes(patch: Patch) -> bool:
    m = patch.material
    return any(
        (
            patch.content is not None,
            patch.options is not None,
            patch.answer is not None,
            patch.clear_answer,
            patch.content_only,
            patch.images_mode != "keep",
            m.article is not UNSET,
            m.inline is not UNSET,
            m.url_claim is not UNSET,
            m.share_with is not None,
        )
    )


def strip_all_images(text: str) -> str:
    """删掉全部图片引用（清图用）。文章正文里的图由调用方按 target 放过。"""
    out = re.sub(r"!\[[^\]]*\]\([^)]+\)\n?", "", text or "")
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def preserve_images(text: str, refs: list[str]) -> str:
    """保留原图：正文里没出现的旧图补到末尾（只改文字，不丢图）。"""
    return _append_missing_images(text, list(refs or []))


def _strip_image_refs(text: str, refs: list[str]) -> str:
    """只删除指定图片引用，保留题干独有的配图。"""
    wanted = set(refs or [])
    if not wanted:
        return text

    def repl(match: re.Match) -> str:
        return "" if match.group(1) in wanted else match.group(0)

    out = re.sub(r"!\[[^\]]*\]\(([^)]+)\)\n?", repl, text or "")
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _apply_images_to_record(rec: dict, patch: Patch, snap) -> None:
    mode = patch.images_mode
    if mode in ("clear", "replace"):
        rec["content"] = strip_all_images(rec.get("content") or "")
        rec["options"] = [
            {**o, "text": strip_all_images(o.get("text") or "")}
            for o in (rec.get("options") or [])
        ]
        # material_text 在 target=article/both 时承载共享文章正文，清它会删掉文章里的图。
        if rec.get("material_target") not in ("article", "both") and "material_text" in rec:
            rec["material_text"] = strip_all_images(rec.get("material_text") or "")
        if "material_inline_text" in rec:
            rec["material_inline_text"] = strip_all_images(rec.get("material_inline_text") or "")
    if mode in ("append", "replace") and patch.images:
        rec["content"] = _apply_image_placeholders(rec["content"], patch.images)
    elif mode == "keep":
        option_refs = _option_image_refs(rec.get("options"))
        rec["content"] = _strip_image_refs(rec["content"], option_refs)
        stem_images = [ref for ref in snap.images if ref not in option_refs]
        rec["content"] = preserve_images(rec["content"], stem_images)


def _material_record_values(patch: Patch, snap, subject: str) -> dict:
    """材料两段的三态 → 记录字段（设计 §5.3 的逐行实现）。"""
    m = patch.material
    out: dict = {}
    if m.url_claim is not UNSET:
        out["material_url"] = m.url_claim
    if m.article is UNSET and m.inline is UNSET:
        # 材料一段都没改：语文不带键（apply 用 existing_text 保留原值）；
        # 非语文必须带原 material_text，否则 apply 的 rec.get() 会把它写成 NULL。
        if subject != "chinese" and (snap.inline or "").strip():
            out.update(material_target="inline", material_text=snap.inline)
        return out
    article = snap.article if m.article is UNSET else m.article
    inline = snap.inline if m.inline is UNSET else m.inline
    if article is None and inline is None:
        if m.article is not UNSET and m.inline is not UNSET and m.url_claim is None:
            return out
        if m.inline is None:
            out.update(
                material_target="inline",
                material_text="",
                material_scope="inline",
            )
        return out
    if article is not None and m.inline is None:
        out.update(
            material_target="both",
            material_text=article,
            material_inline_text="",
        )
    elif article is not None and inline is not None:
        out.update(
            material_target="both",
            material_text=article,
            material_inline_text=inline,
        )
    elif article is not None:
        out.update(
            material_target="article",
            material_text=article,
            material_scope="article",
        )
    else:
        out.update(
            material_target="inline",
            material_text=inline,
            material_scope="inline",
        )
    return out


def build_record(
    item,
    group_order: int,
    sub_no: int,
    patch: Patch,
    snap,
    *,
    dominant_type: str | None = None,
) -> dict:
    flag = next(
        (
            f for f in item.flags
            if int(f.get("group_order") or item.group_order) == group_order
            and int(f.get("sub_no") or 0) == sub_no
        ),
        item.flags[0] if item.flags else {},
    )
    head = {
        "source": item.source,
        "rel_path": item.rel_path,
        "group_order": group_order,
        "sub_no": sub_no,
        "issue_kind": flag.get("kind") or "manual_override",
        "issue_reasons": flag.get("reasons") or [],
        "pdf": flag.get("pdf"),
        "md": flag.get("md"),
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "operator": getpass.getuser(),
        "status": "ready",
        "applied": False,
    }
    # `u` 之后又按了 `:c` 就不能退回 content_only：否则清答案被吞掉（2026-11-26 裁决）。
    if patch.content_only and not patch.clear_answer:
        return {
            **head,
            "content": patch.content or snap.content,
            "content_only": True,
            "issue_kind": "repair_truncated",
        }
    if set(item.kinds) == {"answer_missing"} and patch.answer and not patch.clear_answer:
        return {
            **head,
            "content": snap.content,
            "options": snap.options,
            "answer": patch.answer,
            "material_text": None,
            "answer_only": True,
            "expected_type": None,
        }
    rec = {
        **head,
        "content": (patch.content if patch.content is not None else snap.content).strip(),
        "options": patch.options if patch.options is not None else snap.options,
        "answer": patch.answer if patch.answer is not None else snap.answer,
        "expected_type": dominant_type,
    }
    if patch.clear_answer:
        rec["answer"] = ""
        rec["clear_answer"] = True
    if patch.material.share_with is not None:
        rec["material_share_with"] = patch.material.share_with
    rec.update(_material_record_values(patch, snap, item.subject))
    _apply_images_to_record(rec, patch, snap)
    return rec


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


def _save_records(source: str, records: list[dict], out_dir: Path) -> Path:
    """把补题记录并入 manual_fixes/<source>.jsonl（同题号+小问号覆盖），返回输出路径。"""
    out_file = out_dir / f"{source}.jsonl"
    rows = _read_jsonl(out_file)
    batch: dict[tuple[int, int], dict] = {}
    for record in records:
        key = (int(record["group_order"]), int(record.get("sub_no") or 0))
        _keep_prior_images(batch.get(key), record)
        rows = [
            r for r in rows
            if (int(r["group_order"]), int(r.get("sub_no") or 0)) != key
        ]
        rows.append(record)
        batch[key] = record
    _write_jsonl(out_file, rows)
    return out_file


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
