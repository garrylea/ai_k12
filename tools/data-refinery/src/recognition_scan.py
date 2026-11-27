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

from question_splitter import is_answer_keyword  # noqa: E402
from scope_filter import match_keyword  # noqa: E402
from subject_codes import subject_code_for_path  # noqa: E402

ISSUES_FILE = ROOT / "output" / "recognition_issues.jsonl"
# 全局题号链扫描产物：消费它的 error/warning 条目进人工队列（info 已解决的不进）
STEM_ISSUES_FILE = ROOT / "output" / "stem_chain_issues.jsonl"
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

# 这些学科的「原文缺失型」缺陷（画线句/加点字/图片内表格/未随卷给出的材料）在标注阶段
# 按设计 is_complete=false、只报告不修复（真源 question_labeler._UNREPAIRED_OK）。
# 2026-11-19 起**语文不再豁免扫描上报**：语文的原文缺失型缺陷同样进人工补题队列，由人
# 决定是否从 PDF 补。此前语文被静默关掉 → 题以 is_active=0 入库、既不进抽题池也不通知
# 任何人（八中 2026 期中题 7/21 因此从 26 题变成 24 题，用户实测发现）。
#
# 注意：这里与 question_labeler._UNREPAIRED_OK **刻意不同步**。那边是标注开关——把语文
# 删掉会逼 LLM 编造原文（实测大兴题5 编出【甲】【乙】、房山题25 编出不存在的 D）；
# 这边只控制「是否报给人工」，两者职责不同，不要为了对称而改回去。
# 道法/历史/地理/生物仍豁免；数学/物理/化学本来就不在名单里（照常上报）。
_UNREPAIRED_OK_SUBJECTS = frozenset({"politics", "history", "geography", "biology"})

# 确定性判据前缀：命中这些说明问题真在（空题干/小问从2起/前后题合并），
# 不能因为 LLM 标记消失就自动收口。其余 reason 是 LLM 自由文本。
_DETERMINISTIC_REASON_PREFIXES = (
    "empty_stem", "subq_starts_at_2", "body_contains_stem_", "body_belongs_to_stem_",
    "options_",
)


def _is_llm_only_reasons(reasons: list | None) -> bool:
    """这条 issue 是否只由 LLM 标记触发（无确定性判据）→ 标记消失即可自动收口。"""
    rs = [r for r in (reasons or []) if r]
    has_llm = any(r in ("llm_marked_incomplete", "flagged_needs_review") for r in rs)
    has_det = any(str(r).startswith(_DETERMINISTIC_REASON_PREFIXES) for r in rs)
    return has_llm and not has_det


def _auto_close_stale(records: list[dict], current: set, scanned: set,
                      *, answers_checked: bool = False,
                      present: dict[str, set[int]] | None = None) -> int:
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
        key_opts = (rec["source"], rec.get("group_order"), "options_incomplete")
        key_ans = (rec["source"], rec.get("group_order"), "answer_missing")
        if (rec.get("kind") in ("missing", "punct_stem")
                and rec.get("group_order") in (present or {}).get(rec["source"], set())):
            rec["status"] = "resolved"
            rec["note"] = "重抽后该题号已恢复，自动收口"
            rec["auto_closed"] = True
            closed += 1
        elif rec.get("kind") == "junk_question" and key_junk not in current:
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
        elif rec.get("kind") == "options_incomplete" and key_opts not in current:
            rec["status"] = "resolved"
            rec["note"] = "重抽/补题后选项已齐，自动收口"
            rec["auto_closed"] = True
            closed += 1
        elif (answers_checked and rec.get("kind") == "answer_missing"
                and key_ans not in current):
            # 只有本次真查过题库答案才敢收口；DB 不可用时不能把旧记录全关掉
            rec["status"] = "resolved"
            rec["note"] = "重抽/答案回填后已有答案，自动收口"
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


def stem_issue_to_recognition(
    row: dict, md_path: Path, pdf_path: Path | None,
) -> dict | None:
    """题号链 issue → 人工复核条目；info（如 llm 已解决）不进队列。"""
    if row.get("severity") == "info":
        return None
    question_no = row.get("question_no")
    if not isinstance(question_no, int):
        return None
    code = str(row.get("code") or "")
    return {
        "source": row.get("source"),
        "group_order": question_no,
        "kind": code,
        "reasons": [code, "stem_chain"],
        "excerpt": _excerpt(row.get("excerpt") or ""),
        "line_no": row.get("line_no"),
        "candidate_ids": row.get("candidate_ids") or [],
        "pdf": str(pdf_path) if pdf_path else None,
        "md": str(md_path),
        "status": "pending",
    }


def load_stem_issues_for_source(
    source: str, md_path: Path, pdf_path: Path | None,
) -> list[dict]:
    return [
        converted
        for row in _read_jsonl(STEM_ISSUES_FILE)
        if row.get("source") == source
        for converted in [stem_issue_to_recognition(row, md_path, pdf_path)]
        if converted is not None
    ]


def _issue_key(i: dict) -> tuple:
    """issue 身份：(source, group_order, sub_no, kind[, related][, line])。

    `sub_no` 纳入身份，旧记录缺字段按 0；`related_group_order` 纳入身份，避免同一 suspect
    被不同缺号题引用时互相覆盖。`line_no` 仍只在非空时加入。
    """
    base = (
        i["source"],
        int(i.get("group_order") or 0),
        int(i.get("sub_no") or 0),
        str(i.get("kind") or ""),
    )
    related = i.get("related_group_order")
    if related is not None:
        base += ("related", int(related))
    line_no = i.get("line_no")
    return base if line_no is None else base + ("line", line_no)


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


def fixed_numbers(
    source: str, fixes_dir: Path | None = None,
) -> dict[tuple[int, int], bool]:
    """该卷人工补过的 (题号, 小问号) -> 是否已写进库（applied）。

    用来判断一条已标记的识别问题到底还算不算数：补题文件被删/作废、
    或者补了但从没 `apply_fixes_cli --apply`，都说明问题还在。
    旧记录缺 `sub_no` 时按 0 解释。
    """
    path = Path(fixes_dir or FIXES_DIR) / f"{source}.jsonl"
    out: dict[tuple[int, int], bool] = {}
    for rec in _read_jsonl(path):
        try:
            key = (int(rec["group_order"]), int(rec.get("sub_no") or 0))
        except (KeyError, TypeError, ValueError):
            continue
        out[key] = bool(rec.get("applied"))
    return out


def _suspect_merged_issue(
    *, source: str, rel_path: Path, md_path: Path, pdf_path: Path | None,
    missing_no: int, suspect_row: dict, missing_reasons: list[str],
) -> dict:
    """缺号题的 suspect 上一题单独成卡：只带上一题的理由 + 吞并线索 + 指纹。

    绝不复制缺号题自己的理由（`missing_stem` / `md_has_no_such_stem` /
    `next_starts_with_subq_no_stem`），否则两张卡看着像同一道题（2026-11-27 设计 §4.2）。
    """
    reasons = [r for r in missing_reasons if str(r).startswith("prev_")]
    reasons.insert(0, f"body_contains_stem_{missing_no}")
    body = suspect_row.get("content") or ""
    return {
        "source": source,
        "rel_path": str(rel_path),
        "group_order": int(suspect_row["group_order"]),
        "sub_no": int(suspect_row.get("sub_no") or 0),
        "kind": "merged_content",
        "reasons": reasons,
        "excerpt": _excerpt(body),
        "pdf": str(pdf_path) if pdf_path else None,
        "md": str(md_path),
        "content_sig": content_sig(body),
        "related_group_order": missing_no,
        "related_issue_kind": "missing",
        "status": "pending",
    }


def scan_paper(source: str, rel_path: Path, md_path: Path, rows: list[dict],
               pdf_path: Path | None, labeling_issues: list[dict],
               fixes_dir: Path | None = None,
               db_answers: dict[int, str] | None = None) -> list[dict]:
    """单卷扫描，返回 issue 列表（一条=一处需要人工确认的问题）。

    ``db_answers``：题库里该卷每题答案（group_order → answer）。给了才做「答案缺失」
    检查——extracted JSONL 的 answer 可能为空（答案在第 6 步才回填入库），只有 DB 是准的。
    """
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
        sub_no = extra.pop("sub_no", by_no.get(no, {}).get("sub_no", 0))
        issue = {
            "source": source,
            "rel_path": str(rel_path),
            "group_order": no,
            "sub_no": sub_no,
            "kind": kind,
            "reasons": reasons,
            "excerpt": _excerpt(excerpt),
            "pdf": str(pdf_path) if pdf_path else None,
            "md": str(md_path),
            "status": "pending",
            **extra,
        }
        issues.append(issue)
        return issue

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
        if suspect is not None and suspect in by_no:
            issues.append(
                _suspect_merged_issue(
                    source=source,
                    rel_path=rel_path,
                    md_path=md_path,
                    pdf_path=pdf_path,
                    missing_no=n,
                    suspect_row=by_no[suspect],
                    missing_reasons=reasons,
                )
            )

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
                ["content_looks_like_page_chrome"], body, sub_no=r.get("sub_no", 0))

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

        # 内容不完整：小问从 (2) 起（丢了 (1)），或标注时 LLM 判过不完整。
        # 小问拆分后的题（sub_no>0）本来就只含自己那一问，不能按「缺 (1)」报。
        if not r.get("sub_no") and _SUBQ2_RE.search(body) and not _SUBQ1_RE.search(body):
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
                content_sig=content_sig(body), sub_no=r.get("sub_no", 0))

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

    # ⑧ 选择题选项不全（MinerU 丢选项，脚本找不回来；2026-11-17 35中题8 实测：
    #    md 里只有 A/B/C，D 整个丢了）。记录下来让人工补，不阻断入库。
    #    只查 JSONL 里带 options 字段的行（真实产物必有，单测的裸 rows 不触发）。
    _subject = subject_code_for_path(rel_path, default="")
    min_options = 3 if _subject == "chinese" else 4
    for r in rows:
        no = r.get("group_order")
        if not isinstance(no, int) or "options" not in r:
            continue
        if str(r.get("type") or "") not in ("choice", "multi_choice"):
            continue
        opts = r.get("options") or []
        if len(opts) >= min_options:
            continue
        reason = f"options_{len(opts)}of{min_options}"
        # 同一题已经有内容层问题时，把「选项缺失」并进那条记录，不重复占一条
        existing = next((i for i in issues if i.get("group_order") == no
                         and i.get("sub_no") == r.get("sub_no", 0)), None)
        if existing is not None:
            existing.setdefault("reasons", []).append(reason)
            continue
        add(no, "options_incomplete", [reason], r.get("content") or "",
            sub_no=r.get("sub_no", 0))

    # ⑨ 答案缺失：以题库为准（答案在第 6 步才回填，JSONL 里的不一定是最新）。
    #    只在「md 自带答案区」时检查：答案靠第 6 步答案回填的卷，这里本来就会空，
    #    报出来只是噪音（全库 752 题里绝大多数属于这种）。
    md_has_answers = any(is_answer_keyword(ln) for ln in md_text.splitlines())
    if db_answers is not None and md_has_answers:
        for r in rows:
            no = r.get("group_order")
            if not isinstance(no, int) or no not in db_answers:
                continue
            if (db_answers.get(no) or "").strip():
                continue
            add(no, "answer_missing", ["answer_empty"], r.get("content") or "",
                sub_no=r.get("sub_no", 0))

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
    existing = {_issue_key(r): r for r in records}
    fix_cache: dict[str, dict[tuple[int, int], bool]] = {}
    reopened = 0
    for it in all_issues:
        rec = existing.get(_issue_key(it))
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
        applied = fix_cache[it["source"]].get(
            (int(it["group_order"]), int(it.get("sub_no") or 0))
        )
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
    fresh = {_issue_key(i): i for i in all_issues}
    reopened = 0
    for rec in records:
        if rec.get("verdict") != "no_change":
            continue
        it = fresh.get(_issue_key(rec))
        old_sig, new_sig = rec.get("content_sig"), (it or {}).get("content_sig")
        if not old_sig or not new_sig or old_sig == new_sig:
            continue
        rec["status"] = "pending"
        rec["note"] = "题目内容已变化，之前的「确认无问题」作废，请重新确认"
        for key in ("verdict", "resolved_at", "content_sig"):
            rec.pop(key, None)
        reopened += 1
    return reopened


def _load_db_answers(keys: list[str]) -> dict[str, dict[int, str]] | None:
    """按 source_key 批量取题库答案（group_order → answer）。

    DB 不可用返回 None，调用方跳过「答案缺失」检查（不能让扫描整体失败）。
    """
    if not keys:
        return {}
    try:
        import pymysql

        from config import RefineryConfig

        cfg = RefineryConfig.from_env(input_dir=None, output_dir=None)
        conn = pymysql.connect(
            host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
            password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
        )
    except Exception as e:
        print(f"[WARN] 答案缺失检查跳过（数据库不可用）：{e}", flush=True)
        return None

    out: dict[str, dict[int, str]] = {}
    try:
        with conn.cursor() as cur:
            for i in range(0, len(keys), 200):
                part = keys[i:i + 200]
                ph = ",".join(["%s"] * len(part))
                cur.execute(
                    "SELECT p.source_key, q.group_order, q.answer "
                    "FROM exam_papers p "
                    "JOIN paper_questions pq ON pq.paper_id=p.id "
                    "JOIN questions q ON q.id=pq.question_id "
                    f"WHERE p.source_key IN ({ph})",
                    part,
                )
                for key, no, ans in cur.fetchall():
                    if no is None:
                        continue
                    out.setdefault(str(key), {})[int(no)] = ans or ""
    finally:
        conn.close()
    return out


def _prune_records_for_redo(records: list[dict], jobs: list[tuple]) -> tuple[list[dict], int]:
    """redo：丢弃本次重扫卷的旧记录（栅格化/MinerU 重转后，旧 excerpt/理由已失效）。

    只清本次实际重扫的卷（jobs），不碰同科其它卷。返回 (保留记录, 清除条数)。
    """
    in_scope = {src for _, _, src in jobs}
    kept = [r for r in records if r.get("source") not in in_scope]
    return kept, len(records) - len(kept)


def run(subject: str, file: str | None = None, *, write: bool = True,
        sources: set[str] | None = None, redo: bool = False) -> list[dict]:
    """扫描一个学科（可再按卷名子串 / 精确卷名集合收窄），返回本次检出的问题列表。

    write=True 时把新条目追加进 output/recognition_issues.jsonl（按
    (source, group_order, kind) 去重，可重复执行）。`sources` 给 just-written 的卷用：
    写库后只复扫这几卷，不惊动同科其它卷。`redo=True` 时先清掉本次重扫卷的旧记录，
    再由新扫描重建——否则栅格化后已修好的题（如选项从 0/4 变 4/4）的旧误报会一直挂着。
    """
    extracted_root = ROOT / "output" / "extracted"
    md_root = ROOT / "output" / "md"
    pdf_root = ROOT.parent / "crawler" / "data"
    labeling_issues = _read_jsonl(ROOT / "output" / "labeling_issues.jsonl")

    all_issues: list[dict] = []
    present_by_source: dict[str, set[int]] = {}

    # 先收齐本次要扫的卷，再一次性取题库答案（答案缺失检查用；DB 不可用就跳过）
    jobs: list[tuple[Path, Path, str]] = []
    for jsonl_path in sorted(extracted_root.rglob("*.jsonl")):
        rel_dir = jsonl_path.parent.relative_to(extracted_root)
        if str(rel_dir).split("/")[0] != subject:
            continue
        source = jsonl_path.stem
        if file and not match_keyword(source, file):
            continue
        if sources is not None and source not in sources:
            continue
        jobs.append((jsonl_path, rel_dir, source))

    keys = [(rel_dir / f"{source}.jsonl").as_posix()[: -len(".jsonl")]
            for _jsonl, rel_dir, source in jobs]
    answers_by_source = _load_db_answers(keys)

    for jsonl_path, rel_dir, source in jobs:
        md_path = md_root / rel_dir / f"{source}.md"
        pdf_path = locate_pdf(pdf_root, rel_dir, source)
        rows = _read_jsonl(jsonl_path)
        present_by_source[source] = {
            r["group_order"] for r in rows if isinstance(r.get("group_order"), int)
        }
        key = (rel_dir / f"{source}.jsonl").as_posix()[: -len(".jsonl")]
        found = scan_paper(
            source, rel_dir, md_path, rows,
            pdf_path if pdf_path.exists() else None, labeling_issues,
            db_answers=None if answers_by_source is None else answers_by_source.get(key, {}),
        )
        found.extend(load_stem_issues_for_source(
            source,
            md_path,
            pdf_path if pdf_path.exists() else None,
        ))
        all_issues.extend(found)
        flag = f"，{len(found)} 处待确认" if found else ""
        print(f"[scan] {source}: {len(rows)} 题{flag}", flush=True)

    if not write:
        return all_issues

    ISSUES_FILE.parent.mkdir(parents=True, exist_ok=True)
    records = _read_jsonl(ISSUES_FILE)
    pruned = 0
    if redo:
        records, pruned = _prune_records_for_redo(records, jobs)
        if pruned:
            print(f"[redo] 清除 {pruned} 条旧 issue 记录（本次重扫的卷，旧快照已失效）", flush=True)
    current = {_issue_key(i) for i in all_issues}
    scanned = {source for _jsonl, _rel_dir, source in jobs}
    closed = _auto_close_stale(
        records, current, scanned,
        answers_checked=answers_by_source is not None,
        present=present_by_source,
    )
    # 老记录里 pdf 为空（早期版本路径算错）时，用这次算出来的补上
    by_key = {_issue_key(i): i for i in all_issues}
    filled = 0
    for rec in records:
        key = _issue_key(rec)
        fresh = by_key.get(key)
        if fresh and fresh.get("pdf") and not rec.get("pdf"):
            rec["pdf"] = fresh["pdf"]
            filled += 1
    reopened = reopen_unbacked(records, all_issues, present=present_by_source)
    changed = reopen_changed(records, all_issues)

    if closed or filled or reopened or changed or pruned:
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
    known = {_issue_key(i) for i in records}
    added = 0
    with ISSUES_FILE.open("a", encoding="utf-8") as f:
        for it in all_issues:
            key = _issue_key(it)
            if key in known:
                continue
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
            added += 1
            known.add(key)
    # 本次扫到的卷里还有多少条没处理 —— 这才是「要不要进人工」的判据，
    # 只看「新增 0」会误以为全部解析正常。
    pending_by_source: dict[str, list] = {}
    for rec in records + [{"source": i["source"], "group_order": i["group_order"],
                           "kind": i["kind"], "line_no": i.get("line_no"),
                           "status": "pending"} for i in all_issues
                          if _issue_key(i) not in
                          {_issue_key(r) for r in records}]:
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
