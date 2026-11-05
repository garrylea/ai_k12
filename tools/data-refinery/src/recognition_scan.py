"""识别问题扫描：切题后发现问题，产出一份清单供人工逐条确认。

两类问题（2026-11-01 起）：
① 题号层：缺号、顿号题号、修复砍短、噪声题 —— 题号能不能对上；
② 内容层：**内容不全**（小问从 (2) 起、LLM 判过不完整）与**前后题合并**
   （正文里出现别的题号、正文其实属于 md 里另一个题号）—— 题号对上了，
   但这道题的话不是它自己的/不全。只查①会漏掉「题号齐、内容坏」的卷
   （2026-10-31 人大附物理：34 题号全在，第 27 题缺小问 (1)、第 24 题吞了
   第 25 题、第 25 题装着第 23 题的正文，一张卷 3 处内容缺陷全没报）。

背景（2026-10-30 实测，物理 2024 上学期三张卷）：
- MinerU 会整行漏掉题号（一零一题28、人大附题7/23），正文仍在，被并进上一题；
- 题号被 OCR 认错（人大附「16.」认成「6.」），切题器按重复题号跳过；
- 顿号题号（人大附「18、」）不在识别字符集里，整题丢失；
- LLM「修复」判定题干混入另一题后直接删掉那段（人大附题6 714→124 字，题7 就此消失）。

本脚本只读：读 extracted/*.jsonl + 对应 md + labeling_issues.jsonl，产出一份结构化清单，
供 `fix_question_cli.py` 逐条引导人工补题，再由 `apply_fixes_cli.py` 统一入库。
人工确认「没问题」的条目不写库，只落 `verdict=no_change`，重扫不再打扰（内容变了才重开）。

入口：
    import_cli 第 6 步自动调用 run()；也可以单独跑 src/scan_recognition_issues.py。
"""

import argparse
import hashlib
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

from subject_codes import subject_code_for_path  # noqa: E402

ISSUES_FILE = ROOT / "output" / "recognition_issues.jsonl"
# 人工补题的落盘目录；只认顶层 *.jsonl（`_discarded/` 里的作废记录不参与判定）
FIXES_DIR = ROOT / "output" / "manual_fixes"

# 卷面题号：句点/全角点/顿号三种写法（顿号只有「序号连续」才该算题号，这里只用于诊断）
_STEM_ANY_RE = re.compile(r"(?m)^\s*#{0,6}\s*(\d{1,2})\s*[.．、]\s*\S")
# 同上但用前瞻收尾：m.end() 正好落在题干第一个字，取「题号后面那段话」时不会被吃掉一个字
_STEM_HEAD_RE = re.compile(r"(?m)^\s*#{0,6}\s*(\d{1,2})\s*[.．、]\s*(?=\S)")
_OPTION_BLOCK_RE = re.compile(r"(?m)^\s*[A-D]\s*[.．、]\s*\S")
_EXCERPT_LIMIT = 600
# 卷首/卷尾的非题目文字（北师大实验卷实测：试卷说明的第 4 条「命题人:…」被切成第 4 题）
_JUNK_RE = re.compile(r"命题人|审核人|校对人|命题学校|第\s*\d+\s*页\s*共|共\s*\d+\s*页")

# ---- 内容层（2026-11-01）----
# 正文中间出现的「18、」「25.」：题号前必须是行首/空白/句读，后跟非数字，
# 才不会把「0.5」「2024、」这类数字误当题号。
_INLINE_STEM_RE = re.compile(r"(?:^|[\s。；，、])[（(]?(\d{1,2})[)）]?\s*[、.．]\s*(?=[^\s\d])")
_SUBQ2_RE = re.compile(r"[（(]\s*2\s*[）)]")
_SUBQ1_RE = re.compile(r"[（(]\s*1\s*[）)]")
# 归一化口径：只保留中英文/数字/下划线，去掉空白与标点 —— md 与 content 同一套剥法后可直接比对
_NORM_RE = re.compile(r"[^\w\u4e00-\u9fff]")
# 取正文开头多少个归一化字符去 md 里定位归属（太短会命中图注/表格里的重复短语）
_BODY_KEY_LEN = 14

# 这些学科的「原文缺失型」缺陷（画线句/加点字/图片内表格/未随卷给出的材料）按设计
# 就是 is_complete=false、只报告不修复（真源 question_labeler._UNREPAIRED_OK）。
# 把它们也当「内容不完整」报出来，30 张语文卷能出 197 条，真正要修的结构缺陷会被淹没
# —— 这类学科只保留确定性判据（小问从 (2) 起 / 前后题合并）。改 _UNREPAIRED_OK 时两边同步。
_UNREPAIRED_OK_SUBJECTS = frozenset({"chinese", "politics", "history", "geography", "biology"})

# 确定性判据前缀：命中这些说明问题真在（空题干/小问从2起/前后题合并），
# 不能因为 LLM 标记消失就自动收口。其余 reason 是 LLM 自由文本。
_DETERMINISTIC_REASON_PREFIXES = (
    "empty_stem", "subq_starts_at_2", "body_contains_stem_", "body_belongs_to_stem_",
)


def _is_llm_only_reasons(reasons: list | None) -> bool:
    """这条 issue 是否只由 LLM 标记触发（无确定性判据）→ 标记消失即可自动收口。"""
    rs = [r for r in (reasons or []) if r]
    has_llm = any(r in ("llm_marked_incomplete", "flagged_needs_review") for r in rs)
    has_det = any(str(r).startswith(_DETERMINISTIC_REASON_PREFIXES) for r in rs)
    return has_llm and not has_det


def _auto_close_stale(records: list[dict], current: set, scanned: set) -> int:
    """自动收口本次不再检出的旧记录，返回条数。

    - junk_question：噪声题已被切题过滤修掉（该行不再被当成题目）；
    - incomplete_content 且 reasons 纯 LLM 标记：重抽后 needs_review=False，
      LLM 标记消失说明题已完整（2026-11-03 题18）。含确定性判据的不收口。
    收口的记录打 `auto_closed=True`，`reopen_unbacked` 会跳过，避免又变回幽灵条目。
    """
    closed = 0
    for rec in records:
        if rec.get("status") != "pending" or rec.get("source") not in scanned:
            continue
        key_junk = (rec["source"], rec.get("group_order"), "junk_question")
        key_inc = (rec["source"], rec.get("group_order"), "incomplete_content")
        key_lf = (rec["source"], rec.get("group_order"), "label_failed")
        if rec.get("kind") == "junk_question" and key_junk not in current:
            rec["status"] = "resolved"
            rec["note"] = "已由切题过滤修复（该行不再被当成题目）"
            rec["auto_closed"] = True
            closed += 1
        elif (rec.get("kind") == "incomplete_content"
                and key_inc not in current
                and _is_llm_only_reasons(rec.get("reasons"))):
            rec["status"] = "resolved"
            rec["note"] = "重抽后该题不再被标 needs_review，自动收口"
            rec["auto_closed"] = True
            closed += 1
        elif rec.get("kind") == "label_failed" and key_lf not in current:
            # 重抽后该题标注成功（本次不再检出 label_failed）→ 收口
            rec["status"] = "resolved"
            rec["note"] = "重抽后该题标注成功，自动收口"
            rec["auto_closed"] = True
            closed += 1
    return closed


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _excerpt(text: str, limit: int = _EXCERPT_LIMIT) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit] + "…"


def _option_block_count(text: str) -> int:
    """数「A. B. C. D.」这样的连续选项块有几组（一组=连续四个字母）。"""
    labels = [m.group(0).strip()[0] for m in _OPTION_BLOCK_RE.finditer(text or "")]
    blocks, run = 0, []
    for lab in labels:
        want = "ABCD"[len(run)] if len(run) < 4 else None
        if want and lab == want:
            run.append(lab)
            if len(run) == 4:
                blocks += 1
                run = []
        else:
            run = [lab] if lab == "A" else []
    return blocks


def _norm_text(text: str) -> str:
    """只留中英文/数字/下划线，去掉空白与标点（md 与 content 用同一套剥法才能比对）。"""
    return _NORM_RE.sub("", text or "")


def content_sig(text: str) -> str:
    """正文指纹：人工确认「没问题」时存一份，内容变了才让旧结论失效。"""
    return hashlib.md5(_norm_text(text).encode("utf-8")).hexdigest()


def _normalized_md(text: str) -> tuple[str, list[int]]:
    """归一化整篇 md，并记住每个字符在原文里的下标（用于反查它属于哪一题）。"""
    chars: list[str] = []
    index: list[int] = []
    for i, ch in enumerate(text):
        if not _NORM_RE.fullmatch(ch):
            chars.append(ch)
            index.append(i)
    return "".join(chars), index


def _body_owners(norm_md: str, index: list[int], md_stems: list[tuple[int, int]],
                 body: str) -> set[int]:
    """这段正文在原 md 里可能归属哪些题（开头在 md 中每处命中位置之前的最后一个题号）。

    返回集合而不是单值：同一段开头可能出现在多道题里（如两题都以「如图所示, 电源两端
    电压 U 保持不变…」起头），这时不能断定装错，只有**唯一**归属且不是自己才报。
    命中不了（正文被 LLM 改写过、开头是图片/公式）或开头太短时返回空集。
    """
    key = _norm_text(body)[:_BODY_KEY_LEN]
    if len(key) < 10:
        return set()
    owners: set[int] = set()
    pos = norm_md.find(key)
    while pos >= 0:
        orig = index[pos]
        owner = None
        for start, no in md_stems:
            if start >= orig:
                break
            owner = no
        if owner is not None:
            owners.add(owner)
        pos = norm_md.find(key, pos + 1)
    return owners


def _md_stem_bodies(text: str) -> dict[int, list[str]]:
    """题号 -> 该题号后面那段正文的开头（归一化后前 12 字），用于验证「正文里真有 N 题」。"""
    out: dict[int, list[str]] = {}
    for m in _STEM_HEAD_RE.finditer(text):
        head = _norm_text(text[m.end(): m.end() + 80])[:12]
        if head:
            out.setdefault(int(m.group(1)), []).append(head)
    return out


def locate_pdf(pdf_root: Path, rel_dir: Path, source: str) -> Path:
    """素材 PDF 的位置：`<学科>/<学段>/<学期>/<年>/<卷名>.pdf`。

    注意 md 是 `<...>/<年>/<卷名>/<卷名>.md`，比 PDF 多一层目录 ——
    早期版本按 md 的结构去找，永远找不到（2026-10-31 实测「未找到对应 PDF」）。
    """
    candidate = Path(pdf_root) / rel_dir.parent / f"{rel_dir.name}.pdf"
    if candidate.exists():
        return candidate
    legacy = Path(pdf_root) / rel_dir / f"{source}.pdf"
    return legacy if legacy.exists() else candidate


def fixed_numbers(source: str, fixes_dir: Path | None = None) -> dict[int, bool]:
    """该卷人工补过的题号 -> 是否已写进库（applied）。

    用来判断一条已标记的识别问题到底还算不算数：补题文件被删/作废、
    或者补了但从没 `apply_fixes_cli --apply`，都说明问题还在。
    """
    path = Path(fixes_dir or FIXES_DIR) / f"{source}.jsonl"
    out: dict[int, bool] = {}
    for rec in _read_jsonl(path):
        try:
            out[int(rec["group_order"])] = bool(rec.get("applied"))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def scan_paper(source: str, rel_path: Path, md_path: Path, rows: list[dict],
               pdf_path: Path | None, labeling_issues: list[dict],
               fixes_dir: Path | None = None) -> list[dict]:
    """单卷扫描，返回 issue 列表（一条=一处需要人工确认的问题）。"""
    if not rows:
        return []

    nums = sorted({r.get("group_order") for r in rows if isinstance(r.get("group_order"), int)})
    if not nums:
        return []
    present = set(nums)
    missing = [n for n in range(1, max(nums) + 1) if n not in present]

    by_no = {r["group_order"]: r for r in rows}
    lengths = [len(r.get("content") or "") for r in rows]
    median_len = statistics.median(lengths) if lengths else 0

    md_text = md_path.read_text(encoding="utf-8", errors="ignore") if md_path.exists() else ""
    md_stem_counts: dict[int, int] = {}
    for m in _STEM_ANY_RE.finditer(md_text):
        no = int(m.group(1))
        md_stem_counts[no] = md_stem_counts.get(no, 0) + 1

    issues: list[dict] = []

    def add(no: int | None, kind: str, reasons: list[str], excerpt: str = "", **extra):
        issues.append({
            "source": source,
            "rel_path": str(rel_path),
            "group_order": no,
            "kind": kind,
            "reasons": reasons,
            "excerpt": _excerpt(excerpt),
            "pdf": str(pdf_path) if pdf_path else None,
            "md": str(md_path),
            "status": "pending",
            **extra,
        })

    # ① 缺号：看前/后相邻题谁像"吸收了它"
    # 修复步骤删过内容的题（③）是同一条线索：题号消失往往和"上一题被判定混入另一题"同时出现
    truncated_by_no = {
        rec.get("group_order"): rec for rec in labeling_issues
        if rec.get("source") == source
        and (rec.get("regenerated") or {}).get("content")
        and len(rec.get("original_content") or "") * 0.7
        > len((rec.get("regenerated") or {}).get("content") or "")
    }

    for n in missing:
        prev, nxt = by_no.get(n - 1), by_no.get(n + 1)
        reasons: list[str] = ["missing_stem"]
        suspect = None
        if prev is not None:
            body = prev.get("content") or ""
            if median_len and len(body) > median_len * 2.5:
                reasons.append(f"prev_len_{len(body)}_vs_median_{int(median_len)}")
                suspect = n - 1
            if _option_block_count(body) >= 2:
                reasons.append("prev_has_two_option_blocks")
                suspect = n - 1
            if re.search(r"(?m)^\s*[（(]\s*1\s*[）)]", body[20:] or ""):
                reasons.append("prev_has_second_subq_series")
                suspect = n - 1
        if n - 1 in truncated_by_no:
            # 上一题被 LLM"修复"砍过内容 —— 被砍掉的那段极可能就是本题的正文
            rec = truncated_by_no[n - 1]
            reasons.append(
                f"prev_repair_shrank_{len(rec.get('original_content') or '')}"
                f"_to_{len((rec.get('regenerated') or {}).get('content') or '')}")
            excerpt = rec.get("original_content") or ""
        else:
            excerpt = (by_no.get(suspect, {}).get("content") or "") if suspect else ""
        if nxt is not None and re.match(r"^\s*[（(]\s*1\s*[）)]", nxt.get("content") or ""):
            reasons.append("next_starts_with_subq_no_stem")
        if md_stem_counts.get(n, 0) == 0:
            reasons.append("md_has_no_such_stem")
        if md_stem_counts.get(n, 0) > 1:
            reasons.append(f"md_stem_appears_{md_stem_counts[n]}x")
        add(n, "missing", reasons, excerpt, suspect_group_order=suspect)

    # ② 顿号题号：md 里有「N、」但没被切成题
    for no, _count in sorted(md_stem_counts.items()):
        if no in present:
            continue
        m = re.search(rf"(?m)^\s*{no}\s*、\s*\S.*$", md_text)
        if m:
            add(no, "punct_stem", ["md_uses_punct_separator"],
                m.group(0), )

    # ④ 不是题的"题"：卷首说明/卷尾署名被当成题目（占掉了真实题号）
    for r in rows:
        body = (r.get("content") or "").strip()
        if body and len(body) <= 60 and _JUNK_RE.search(body) and not r.get("options"):
            add(r.get("group_order"), "junk_question",
                ["content_looks_like_page_chrome"], body)

    # ③ 修复步骤删过内容：把被删片段留档（原文还能在这里找回）
    for rec in labeling_issues:
        if rec.get("source") != source:
            continue
        regen = rec.get("regenerated") or {}
        before = len(rec.get("original_content") or "")
        after = len(regen.get("content") or "")
        if before and after and after < before * 0.7:
            add(rec.get("group_order"), "repair_truncated",
                [f"repair_shrank_{before}_to_{after}"],
                rec.get("original_content") or "",
                regenerated_excerpt=_excerpt(regen.get("content") or ""))

    # ⑤ 内容层：题号对得上，但「话」不是它自己的 —— 缺小问 / 吞了下一题 / 装着别题正文
    applied = fixed_numbers(source, fixes_dir)
    label_by_no = {
        rec.get("group_order"): rec for rec in labeling_issues
        if rec.get("source") == source
    }
    norm_md, norm_index = _normalized_md(md_text)
    md_stems = [(m.start(), int(m.group(1))) for m in _STEM_ANY_RE.finditer(md_text)]
    stem_bodies = _md_stem_bodies(md_text)
    max_no = max(nums)
    report_llm_flag = subject_code_for_path(rel_path, default="") not in _UNREPAIRED_OK_SUBJECTS

    for r in rows:
        no = r.get("group_order")
        if not isinstance(no, int):
            continue
        # 注意：**不能**因为「这题人工补过」就跳过内容检查。补了但写坏（题干空、
        # 合并没拆干净）必须还能被检出来 —— 2026-11-01 人大附题2 就是补完仍然空，
        # 因为这里按 applied 跳过，扫不出来，也永远不会重开。
        body = r.get("content") or ""
        material = r.get("material_text") or ""
        # 人工复核看的是整题（题干 + 材料）：只贴 content 会让审阅者以为题缺内容，
        # 实际另一半在图/材料里（2026-11-03 题18：content 只有小问、图乙在 material）。
        full_text = body + (f"\n\n[材料]\n{material}" if material.strip() else "")
        reasons: list[str] = []
        suspect: int | None = None

        # 题干为空：正文和材料都没有有效字符（图片被拆进选项、题干整段丢失都长这样）
        if not _norm_text(body) and not _norm_text(material):
            reasons.append("empty_stem")

        # 内容不完整：小问从 (2) 起（丢了 (1)），或标注时 LLM 判过不完整
        if _SUBQ2_RE.search(body) and not _SUBQ1_RE.search(body):
            reasons.append("subq_starts_at_2")
        rec = label_by_no.get(no)
        if report_llm_flag and r.get("needs_review"):
            if rec and rec.get("issues"):
                reasons.append("llm_marked_incomplete")
                reasons.extend(str(x) for x in rec["issues"] if x)
            else:
                reasons.append("flagged_needs_review")

        # 前后题合并①：正文里出现了另一个题号，且 md 里那个题号后面确实是这段话
        # （只认题号不够：「盐水 1、盐水 2」「图 18」这类数字会被误伤）
        for m in _INLINE_STEM_RE.finditer(body):
            other = int(m.group(1))
            if other == no or not 1 <= other <= max_no:
                continue
            tail = _norm_text(body[m.end(): m.end() + 60])[:8]
            if len(tail) < 5:
                continue
            if not any(b.startswith(tail[:6]) for b in stem_bodies.get(other, [])):
                continue
            reasons.append(f"body_contains_stem_{other}")
            suspect = suspect or other
            break

        # 前后题合并②：本题正文开头在 md 里只出现在另一个题号下面 —— 装错了内容
        owners = _body_owners(norm_md, norm_index, md_stems, body)
        if len(owners) == 1 and no not in owners:
            owner = next(iter(owners))
            if 1 <= owner <= max_no:
                reasons.append(f"body_belongs_to_stem_{owner}")
                suspect = suspect or owner

        if reasons:
            kind = ("merged_content" if suspect is not None and any(
                re.match(r"body_(contains|belongs_to)_stem_", x) for x in reasons)
                else "incomplete_content")
            add(no, kind, reasons, full_text, suspect_group_order=suspect,
                content_sig=content_sig(body))

    # ⑥ 题型与同大题不一致：选择题区里冒出「简答题」= 选项丢了（2026-11-01 人大附题9/10：
    #    单项选择 14 题里 12 题 choice，只有 9/10 是 short_answer，实际是图片选项没拆出来）
    by_group: dict[str, list[dict]] = {}
    for r in rows:
        g = r.get("group_id")
        if g and isinstance(r.get("group_order"), int):
            by_group.setdefault(str(g), []).append(r)
    for g, items in by_group.items():
        if len(items) < 5:          # 小题太少不足以判断「这个大题都是同一题型」
            continue
        counts = Counter(str(r.get("type") or "") for r in items)
        top, n = counts.most_common(1)[0]
        if not top or n / len(items) < 0.8:
            continue                # 实验题这类本来混排的大题不动
        for r in items:
            if str(r.get("type") or "") == top:
                continue
            add(r["group_order"], "type_mismatch",
                [f"type_outlier_{top}_{n}of{len(items)}"],
                r.get("content") or "", group_id=g, dominant_type=top)

    # ⑦ LLM 标注失败兜底（2026-11-03 用户反馈）：题入库了但 metadata（type/difficulty/KP）
    #    是确定性兜底的——type 按 Python 拆选项判（大概率对）、difficulty=2（默认）、KP 空。
    #    题仍进抽题池可用（needs_review=False，不阻断"不丢题"设计），只报出来让用户知道
    #    "这题 metadata 是兜底的，建议 --re-extract 重标或人工补 KP/difficulty"。
    for rec in labeling_issues:
        if rec.get("source") != source:
            continue
        if rec.get("type") != "label_failed_fallback":
            continue
        no = rec.get("group_order")
        if not isinstance(no, int):
            continue
        # 已被 ①~⑥ 报过的题不重复报（避免一份兜底同时出现在 multiple kinds）
        if any(i.get("group_order") == no for i in issues):
            continue
        add(no, "label_failed",
            list(rec.get("issues") or ["llm_label_failed_fallback"]),
            (by_no.get(no, {}).get("content") or ""))

    return issues


def reopen_unbacked(records: list[dict], all_issues: list[dict],
                    fixes_dir: Path | None = None,
                    present: dict[str, set[int]] | None = None) -> int:
    """把「标了已处理、但补题并不成立」的记录退回待处理，返回条数。

    判据（2026-10-31 / 2026-11-01 两次事故驱动）：
    - resolved 必须有 applied=true 的补题记录（真写进库了）；
    - recorded 必须有补题记录（写了但还没入库）；
    - 补题文件被删/移进 `_discarded/` 时两者都不成立 → 重新打开；
    - **补题记录说已入库，但这次切题产物里仍然没有这个题号** → 补题被后续导入冲掉了
      （2026-11-01 人大附：题 7/16/18/23 确实补过，之后一次重导把人工题摘掉，
      清单却一直显示已解决。`applied=true` 只证明「当时写过库」，不证明「现在还活着」，
      所以还要拿当前 extracted 的题号集合对一次）。

    事故经过：补题时连终端界面一起粘进去，补题文件被作废，但清单仍标 resolved，
    于是这张卷的缺题再也不会提示（一零一题28、人大附题7 因此消失）。
    """
    existing = {(r["source"], r["group_order"], r["kind"]): r for r in records}
    fix_cache: dict[str, dict[int, bool]] = {}
    reopened = 0
    for it in all_issues:
        rec = existing.get((it["source"], it["group_order"], it["kind"]))
        if rec is None or rec.get("status") == "pending":
            continue
        # 自动收口的（LLM 标记消失/噪声题被过滤）不按「补题未落库」重新打开——
        # 它们不是靠人工补题解决的，重开会变成永远关不掉的幽灵条目。
        if rec.get("auto_closed"):
            continue
        # 人工确认「没问题」的条目不靠补题记录收口 —— 本来就没有要写库的东西
        if rec.get("verdict") == "no_change":
            continue
        if it["source"] not in fix_cache:
            fix_cache[it["source"]] = fixed_numbers(it["source"], fixes_dir)
        applied = fix_cache[it["source"]].get(int(it["group_order"]))
        ok = bool(applied) if rec.get("status") == "resolved" else applied is not None
        lost = False
        # 内容层：这次还检出同一个问题，说明那次补写没生效（题干仍是空、合并没拆干净），
        # 「已解决」是假的 —— 重新打开让人再修一次。
        if ok and rec.get("status") == "resolved" and rec.get("kind") in (
                "incomplete_content", "merged_content"):
            ok, lost = False, True
        if ok and present is not None and rec.get("kind") in ("missing", "punct_stem"):
            have = present.get(it["source"])
            if have is not None and int(it["group_order"]) not in have:
                ok, lost = False, True
        if ok:
            continue
        rec["status"] = "pending"
        if lost and rec.get("kind") in ("incomplete_content", "merged_content"):
            rec["note"] = ("补写后仍能检出同一个内容问题（题干还是空 / 合并没拆干净），"
                           "已重新打开；请重新录入一次")
        elif lost:
            rec["note"] = ("补题记录显示已入库，但当前切题产物里仍缺这个题号 —— "
                           "补题被后续导入冲掉了；内容还在 manual_fixes，"
                           "下次正常导入会自动重放（不用重录）")
        else:
            rec["note"] = ("补题文件不存在或已作废，已重新打开"
                           if applied is None else "补了但还没写库，已重新打开")
        rec.pop("resolved_at", None)
        rec.pop("fix_file", None)
        reopened += 1
    return reopened


def reopen_changed(records: list[dict], all_issues: list[dict]) -> int:
    """内容变了就把「人工确认无问题」退回待确认，返回条数。

    只认内容指纹：同一段正文 → 同一个结论可以一直沿用；重新切题/补题后正文变了，
    旧结论不一定还成立，必须让人再看一眼（否则一次「没问题」会永久闭麦）。
    """
    fresh = {(i["source"], i["group_order"], i["kind"]): i for i in all_issues}
    reopened = 0
    for rec in records:
        if rec.get("verdict") != "no_change":
            continue
        it = fresh.get((rec["source"], rec.get("group_order"), rec.get("kind")))
        old_sig, new_sig = rec.get("content_sig"), (it or {}).get("content_sig")
        if not old_sig or not new_sig or old_sig == new_sig:
            continue
        rec["status"] = "pending"
        rec["note"] = "题目内容已变化，之前的「确认无问题」作废，请重新确认"
        for key in ("verdict", "resolved_at", "content_sig"):
            rec.pop(key, None)
        reopened += 1
    return reopened


def run(subject: str, file: str | None = None, *, write: bool = True,
        sources: set[str] | None = None) -> list[dict]:
    """扫描一个学科（可再按卷名子串 / 精确卷名集合收窄），返回本次检出的问题列表。

    write=True 时把新条目追加进 output/recognition_issues.jsonl（按
    (source, group_order, kind) 去重，可重复执行）。`sources` 给 just-written 的卷用：
    写库后只复扫这几卷，不惊动同科其它卷。
    """
    extracted_root = ROOT / "output" / "extracted"
    md_root = ROOT / "output" / "md"
    pdf_root = ROOT.parent / "crawler" / "data"
    labeling_issues = _read_jsonl(ROOT / "output" / "labeling_issues.jsonl")

    all_issues: list[dict] = []
    present_by_source: dict[str, set[int]] = {}
    for jsonl_path in sorted(extracted_root.rglob("*.jsonl")):
        rel_dir = jsonl_path.parent.relative_to(extracted_root)
        if str(rel_dir).split("/")[0] != subject:
            continue
        source = jsonl_path.stem
        if file and file not in source:
            continue
        if sources is not None and source not in sources:
            continue
        md_path = md_root / rel_dir / f"{source}.md"
        pdf_path = locate_pdf(pdf_root, rel_dir, source)
        rows = _read_jsonl(jsonl_path)
        present_by_source[source] = {
            r["group_order"] for r in rows if isinstance(r.get("group_order"), int)
        }
        found = scan_paper(source, rel_dir, md_path, rows,
                           pdf_path if pdf_path.exists() else None, labeling_issues)
        all_issues.extend(found)
        flag = f"，{len(found)} 处待确认" if found else ""
        print(f"[scan] {source}: {len(rows)} 题{flag}", flush=True)

    if not write:
        return all_issues

    ISSUES_FILE.parent.mkdir(parents=True, exist_ok=True)
    records = _read_jsonl(ISSUES_FILE)
    current = {(i["source"], i["group_order"], i["kind"]) for i in all_issues}
    scanned = {i["source"] for i in all_issues}
    closed = _auto_close_stale(records, current, scanned)
    # 老记录里 pdf 为空（早期版本路径算错）时，用这次算出来的补上
    by_key = {(i["source"], i["group_order"], i["kind"]): i for i in all_issues}
    filled = 0
    for rec in records:
        key = (rec.get("source"), rec.get("group_order"), rec.get("kind"))
        fresh = by_key.get(key)
        if fresh and fresh.get("pdf") and not rec.get("pdf"):
            rec["pdf"] = fresh["pdf"]
            filled += 1
    reopened = reopen_unbacked(records, all_issues, present=present_by_source)
    changed = reopen_changed(records, all_issues)

    if closed or filled or reopened or changed:
        _write_jsonl(ISSUES_FILE, records)
        if closed:
            print(f"[ok] 自动收口 {closed} 条噪声题记录", flush=True)
        if filled:
            print(f"[ok] 补全 {filled} 条记录的原 PDF 路径", flush=True)
        if reopened:
            print(f"[ok] 重新打开 {reopened} 条（此前标为已处理，但补题未落库/已作废/被后续导入冲掉）",
                  flush=True)
        if changed:
            print(f"[ok] 重新打开 {changed} 条（题目内容已变化，旧的「确认无问题」作废）",
                  flush=True)
    known = {(i["source"], i["group_order"], i["kind"]) for i in records}
    added = 0
    with ISSUES_FILE.open("a", encoding="utf-8") as f:
        for it in all_issues:
            key = (it["source"], it["group_order"], it["kind"])
            if key in known:
                continue
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
            added += 1
            known.add(key)
    # 本次扫到的卷里还有多少条没处理 —— 这才是「要不要进人工」的判据，
    # 只看「新增 0」会误以为全部解析正常。
    pending_by_source: dict[str, list] = {}
    for rec in records + [{"source": i["source"], "group_order": i["group_order"],
                           "kind": i["kind"], "status": "pending"} for i in all_issues
                          if (i["source"], i["group_order"], i["kind"]) not in
                          {(r["source"], r["group_order"], r["kind"]) for r in records}]:
        if rec.get("status") == "pending" and rec.get("source") in scanned:
            pending_by_source.setdefault(rec["source"], []).append(
                f"{rec['group_order']}({rec['kind']})")
    total_pending = sum(len(v) for v in pending_by_source.values())
    for src in sorted(pending_by_source):
        items = pending_by_source[src]
        head = "、".join(items[:8]) + (f" 等 {len(items)} 条" if len(items) > 8 else "")
        print(f"[pending] {src}: {head}", flush=True)
    print(f"[ok] 本次检出 {len(all_issues)} 处，其中 {total_pending} 条待人工处理"
          f"（新增 {added} 条记录）；补题命令：python3 src/fix_question_cli.py --source <卷名>",
          flush=True)

    # 补录了但没写库的也别闷着：不提醒的话用户会以为已经修完
    recorded: dict[str, list[str]] = {}
    for rec in records:
        if rec.get("status") == "recorded" and rec.get("source") in scanned:
            recorded.setdefault(rec["source"], []).append(str(rec["group_order"]))
    for src in sorted(recorded):
        print(f"[待入库] {src}: 题 {'、'.join(recorded[src])} 已补录，"
              f"尚未写库（python3 src/apply_fixes_cli.py --apply）", flush=True)
    return all_issues
