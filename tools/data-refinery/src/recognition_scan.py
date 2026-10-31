"""识别问题扫描：切题后发现缺号，回看相邻题，判断"哪一题吸收了它"。

背景（2026-10-30 实测，物理 2024 上学期三张卷）：
- MinerU 会整行漏掉题号（一零一题28、人大附题7/23），正文仍在，被并进上一题；
- 题号被 OCR 认错（人大附「16.」认成「6.」），切题器按重复题号跳过；
- 顿号题号（人大附「18、」）不在识别字符集里，整题丢失；
- LLM「修复」判定题干混入另一题后直接删掉那段（人大附题6 714→124 字，题7 就此消失）。

本脚本只读：读 extracted/*.jsonl + 对应 md + labeling_issues.jsonl，产出一份结构化清单，
供 `fix_question_cli.py` 逐条引导人工补题，再由 `apply_fixes_cli.py` 统一入库。

入口：
    import_cli 第 6 步自动调用 run()；也可以单独跑 scripts/scan_recognition_issues.py。
"""

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

from subject_codes import subject_code_for_path  # noqa: E402

ISSUES_FILE = ROOT / "output" / "recognition_issues.jsonl"
# 人工补题的落盘目录；只认顶层 *.jsonl（`_discarded/` 里的作废记录不参与判定）
FIXES_DIR = ROOT / "output" / "manual_fixes"

# 卷面题号：句点/全角点/顿号三种写法（顿号只有「序号连续」才该算题号，这里只用于诊断）
_STEM_ANY_RE = re.compile(r"(?m)^\s*#{0,6}\s*(\d{1,2})\s*[.．、]\s*\S")
_OPTION_BLOCK_RE = re.compile(r"(?m)^\s*[A-D]\s*[.．、]\s*\S")
_EXCERPT_LIMIT = 600
# 卷首/卷尾的非题目文字（北师大实验卷实测：试卷说明的第 4 条「命题人:…」被切成第 4 题）
_JUNK_RE = re.compile(r"命题人|审核人|校对人|命题学校|第\s*\d+\s*页\s*共|共\s*\d+\s*页")


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
               pdf_path: Path | None, labeling_issues: list[dict]) -> list[dict]:
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

    return issues


def reopen_unbacked(records: list[dict], all_issues: list[dict],
                    fixes_dir: Path | None = None) -> int:
    """把「标了已处理、但补题并不成立」的记录退回待处理，返回条数。

    判据（2026-10-31 事故驱动）：
    - resolved 必须有 applied=true 的补题记录（真写进库了）；
    - recorded 必须有补题记录（写了但还没入库）；
    - 补题文件被删/移进 `_discarded/` 时两者都不成立 → 重新打开。

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
        if it["source"] not in fix_cache:
            fix_cache[it["source"]] = fixed_numbers(it["source"], fixes_dir)
        applied = fix_cache[it["source"]].get(int(it["group_order"]))
        ok = bool(applied) if rec.get("status") == "resolved" else applied is not None
        if ok:
            continue
        rec["status"] = "pending"
        rec["note"] = ("补题文件不存在或已作废，已重新打开"
                       if applied is None else "补了但还没写库，已重新打开")
        rec.pop("resolved_at", None)
        rec.pop("fix_file", None)
        reopened += 1
    return reopened


def run(subject: str, file: str | None = None, *, write: bool = True) -> list[dict]:
    """扫描一个学科（可再按卷名子串收窄），返回本次检出的问题列表。

    write=True 时把新条目追加进 output/recognition_issues.jsonl（按
    (source, group_order, kind) 去重，可重复执行）。
    """
    extracted_root = ROOT / "output" / "extracted"
    md_root = ROOT / "output" / "md"
    pdf_root = ROOT.parent / "crawler" / "data"
    labeling_issues = _read_jsonl(ROOT / "output" / "labeling_issues.jsonl")

    all_issues: list[dict] = []
    for jsonl_path in sorted(extracted_root.rglob("*.jsonl")):
        rel_dir = jsonl_path.parent.relative_to(extracted_root)
        if str(rel_dir).split("/")[0] != subject:
            continue
        source = jsonl_path.stem
        if file and file not in source:
            continue
        md_path = md_root / rel_dir / f"{source}.md"
        pdf_path = locate_pdf(pdf_root, rel_dir, source)
        rows = _read_jsonl(jsonl_path)
        found = scan_paper(source, rel_dir, md_path, rows,
                           pdf_path if pdf_path.exists() else None, labeling_issues)
        all_issues.extend(found)
        flag = f"，{len(found)} 处待确认" if found else ""
        print(f"[scan] {source}: {len(rows)} 题{flag}", flush=True)

    if not write:
        return all_issues

    ISSUES_FILE.parent.mkdir(parents=True, exist_ok=True)
    records = _read_jsonl(ISSUES_FILE)
    # 旧条目自动收口：噪声题（卷首页脚）已被切题过滤修掉时，别让人工再去"补"一次
    current = {(i["source"], i["group_order"], i["kind"]) for i in all_issues}
    scanned = {i["source"] for i in all_issues}
    closed = 0
    for rec in records:
        if (rec.get("status") == "pending" and rec.get("kind") == "junk_question"
                and rec.get("source") in scanned
                and (rec["source"], rec["group_order"], "junk_question") not in current):
            rec["status"] = "resolved"
            rec["note"] = "已由切题过滤修复（该行不再被当成题目）"
            closed += 1
    # 老记录里 pdf 为空（早期版本路径算错）时，用这次算出来的补上
    by_key = {(i["source"], i["group_order"], i["kind"]): i for i in all_issues}
    filled = 0
    for rec in records:
        key = (rec.get("source"), rec.get("group_order"), rec.get("kind"))
        fresh = by_key.get(key)
        if fresh and fresh.get("pdf") and not rec.get("pdf"):
            rec["pdf"] = fresh["pdf"]
            filled += 1
    reopened = reopen_unbacked(records, all_issues)

    if closed or filled or reopened:
        _write_jsonl(ISSUES_FILE, records)
        if closed:
            print(f"[ok] 自动收口 {closed} 条噪声题记录", flush=True)
        if filled:
            print(f"[ok] 补全 {filled} 条记录的原 PDF 路径", flush=True)
        if reopened:
            print(f"[ok] 重新打开 {reopened} 条（此前标为已处理，但补题未落库/已作废）",
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
          f"（新增 {added} 条记录）；补题命令：python3 scripts/fix_question_cli.py --source <卷名>",
          flush=True)

    # 补录了但没写库的也别闷着：不提醒的话用户会以为已经修完
    recorded: dict[str, list[str]] = {}
    for rec in records:
        if rec.get("status") == "recorded" and rec.get("source") in scanned:
            recorded.setdefault(rec["source"], []).append(str(rec["group_order"]))
    for src in sorted(recorded):
        print(f"[待入库] {src}: 题 {'、'.join(recorded[src])} 已补录，"
              f"尚未写库（python3 scripts/apply_fixes_cli.py --apply）", flush=True)
    return all_issues
