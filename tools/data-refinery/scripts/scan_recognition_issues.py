"""识别问题扫描：切题后发现缺号，回看相邻题，判断"哪一题吸收了它"。

背景（2026-10-30 实测，物理 2024 上学期三张卷）：
- MinerU 会整行漏掉题号（一零一题28、人大附题7/23），正文仍在，被并进上一题；
- 题号被 OCR 认错（人大附「16.」认成「6.」），切题器按重复题号跳过；
- 顿号题号（人大附「18、」）不在识别字符集里，整题丢失；
- LLM「修复」判定题干混入另一题后直接删掉那段（人大附题6 714→124 字，题7 就此消失）。

本脚本只读：读 extracted/*.jsonl + 对应 md + labeling_issues.jsonl，产出一份结构化清单，
供 `fix_question_cli.py` 逐条引导人工补题，再由 `apply_fixes_cli.py` 统一入库。

用法：
    python3 scripts/scan_recognition_issues.py --subject 物理
    python3 scripts/scan_recognition_issues.py --file 人大附中 --dry-run
"""

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from subject_codes import subject_code_for_path  # noqa: E402

ISSUES_FILE = ROOT / "output" / "recognition_issues.jsonl"

# 卷面题号：句点/全角点/顿号三种写法（顿号只有「序号连续」才该算题号，这里只用于诊断）
_STEM_ANY_RE = re.compile(r"(?m)^\s*#{0,6}\s*(\d{1,2})\s*[.．、]\s*\S")
_OPTION_BLOCK_RE = re.compile(r"(?m)^\s*[A-D]\s*[.．、]\s*\S")
_EXCERPT_LIMIT = 600


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--subject", default="物理", help="学科中文名过滤")
    parser.add_argument("--file", help="卷名子串过滤")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    args = parser.parse_args()

    extracted_root = ROOT / "output" / "extracted"
    md_root = ROOT / "output" / "md"
    pdf_root = ROOT.parents[0] / "crawler" / "data"

    labeling_issues = _read_jsonl(ROOT / "output" / "labeling_issues.jsonl")

    all_issues: list[dict] = []
    for jsonl_path in sorted(extracted_root.rglob("*.jsonl")):
        rel_dir = jsonl_path.parent.relative_to(extracted_root)
        if str(rel_dir).split("/")[0] != args.subject:
            continue
        source = jsonl_path.stem
        if args.file and args.file not in source:
            continue
        md_dir = md_root / rel_dir
        md_path = md_dir / f"{source}.md"
        pdf_path = pdf_root / rel_dir / f"{source}.pdf"
        rows = _read_jsonl(jsonl_path)
        found = scan_paper(source, rel_dir, md_path, rows,
                           pdf_path if pdf_path.exists() else None, labeling_issues)
        all_issues.extend(found)
        print(f"[scan] {source}: {len(rows)} 题，{len(found)} 处待确认")

    if args.dry_run:
        for it in all_issues:
            print(f"[issue] {it['source'][:24]} 题{it['group_order']} {it['kind']}："
                  f"{'；'.join(it['reasons'])}")
            if it.get("suspect_group_order"):
                print(f"        疑被题{it['suspect_group_order']}吸收")
            if it.get("excerpt"):
                print(f"        片段：{it['excerpt'][:80]!r}")
        return 0

    ISSUES_FILE.parent.mkdir(parents=True, exist_ok=True)
    known = {(i["source"], i["group_order"], i["kind"]) for i in _read_jsonl(ISSUES_FILE)}
    added = 0
    with ISSUES_FILE.open("a", encoding="utf-8") as f:
        for it in all_issues:
            key = (it["source"], it["group_order"], it["kind"])
            if key in known:
                continue
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
            added += 1
    print(f"[ok] 新增 {added} 条 -> {ISSUES_FILE}（已有 {len(known)} 条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
