"""toc_merge：card 分析发现的目录结构合并进初始 TOC。

数据流：toc_parse 产出的初始 toc.json（前几页目录页的 LLM 解析结果） +
publish 产出的 published/*.jsonl（每张卡的 lesson_id 标签）。

合并产物为 sidecar 文件（不回写 toc.json，保护 toc_parse 的原始产物与
--reconvert 语义）：
  - ``output/toc/{book_key}.merged.json``        合并后的目录（下游 db_loader 的唯一事实源）
  - ``output/toc/{book_key}.merge_report.json``  合并报告（新增/补齐/未解析）

merge 是 (toc.json, published/*.jsonl) 的确定性纯函数，无 LLM 调用、无副作用，
每次全量重算即可（无需 checkpoint）。
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

# parse_lesson_id 是纯函数（db_loader 模块级只依赖 re/pymysql 连接发生在 DbLoader 实例化）
from db_loader import parse_lesson_id
from extract_cli import _flatten_toc_labels

_CN_DIGITS = "零一二三四五六七八九"
_PAGE_NUM_RE = re.compile(r"page_(\d+)")


def _int_to_cn(n: int) -> str:
    """阿拉伯数字 -> 中文数字（1-99，用于补建章 label）。"""
    if n < 0:
        return str(n)
    if n < 10:
        return _CN_DIGITS[n]
    if n < 20:
        return "十" + (_CN_DIGITS[n % 10] if n % 10 else "")
    tens, ones = divmod(n, 10)
    return _CN_DIGITS[tens] + "十" + (_CN_DIGITS[ones] if ones else "")


def _page_sort_key(path: Path):
    m = _PAGE_NUM_RE.search(path.name)
    return int(m.group(1)) if m else 10**9


def collect_card_labels(published_dir: Path, book_key: str) -> dict[str, dict]:
    """按页序扫描某书已 publish 的卡片，收集 lesson_id 标签。

    Returns:
        {label: {"first_page": int | None, "count": int}}（按首次出现顺序）
    """
    labels: dict[str, dict] = {}
    book_dir = Path(published_dir) / book_key
    if not book_dir.exists():
        return labels
    for jsonl in sorted(book_dir.glob("page_*.jsonl"), key=_page_sort_key):
        try:
            lines = jsonl.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                card = json.loads(line)
            except json.JSONDecodeError:
                continue
            lid = card.get("lesson_id")
            if not lid or not isinstance(lid, str):
                continue
            if lid not in labels:
                m = re.search(r"\d+", str(card.get("textbook_page") or ""))
                labels[lid] = {"first_page": int(m.group()) if m else None, "count": 1}
            else:
                labels[lid]["count"] += 1
    return labels


def _find_chapter(chapters: list[dict], num: int) -> dict | None:
    for ch in chapters:
        if ch.get("number") == num:
            return ch
    return None


def _find_section(chapter: dict, num: int, m: int) -> dict | None:
    for sec in chapter.get("sections", []):
        sn = sec.get("number") or []
        if len(sn) >= 2 and sn[0] == num and sn[1] == m:
            return sec
    return None


def _find_subsection(section: dict, num: int, m: int, k: int) -> dict | None:
    for sub in section.get("subsections", []):
        sn = sub.get("number") or []
        if len(sn) >= 3 and sn[0] == num and sn[1] == m and sn[2] == k:
            return sub
    return None


def _ensure_chapter(chapters: list[dict], num: int) -> dict:
    """找 chapter；没有则新建（无标题信息的兜底形态），并保持按 number 有序。"""
    ch = _find_chapter(chapters, num)
    if ch is not None:
        return ch
    ch = {"number": num, "title": None, "label": f"第{_int_to_cn(num)}章",
          "sections": [], "supplements": [], "source": "card"}
    chapters.append(ch)
    chapters.sort(key=lambda c: c.get("number", 0))
    return ch


def _sort_sections(chapter: dict) -> None:
    chapter.setdefault("sections", []).sort(
        key=lambda s: (s.get("number") or [0, 0])[1] if len(s.get("number") or []) > 1 else 0)


def _sort_subsections(section: dict) -> None:
    section.setdefault("subsections", []).sort(
        key=lambda s: (s.get("number") or [0, 0, 0])[2] if len(s.get("number") or []) > 2 else 0)


def merge_toc(toc: dict, card_labels: dict[str, dict]) -> tuple[dict, dict]:
    """把卡片标签合并进 TOC 结构。

    Args:
        toc: toc_parse 产出的初始 TOC JSON
        card_labels: collect_card_labels 的输出（顺序即首见页序）

    Returns:
        (merged_toc, report)。merged_toc 是深拷贝，不修改入参。
        新增节点带 "source": "card" 标记（load_toc_structure 忽略未知字段，无害）。
    """
    merged = copy.deepcopy(toc)
    toc_label_set = set(_flatten_toc_labels(toc))
    report: dict = {
        "book": toc.get("book", ""),
        "matched": [],
        "filled_chapters": [],
        "new_chapters": [],
        "new_sections": [],
        "new_subsections": [],
        "section_created_from_subsection": [],
        "unresolved": [],
        "summary": "",
    }
    chapters = merged.setdefault("chapters", [])

    # 分类：命中的 / 解析失败的 / 待合并的（章综述 → 节 → 子节 依序处理）
    parsed_entries: list[tuple[str, dict, dict]] = []
    for label, info in card_labels.items():
        if label in toc_label_set:
            report["matched"].append(label)
            continue
        parsed = parse_lesson_id(label)
        if parsed is None:
            report["unresolved"].append(label)
            continue
        parsed_entries.append((label, info, parsed))

    # Pass 1：章综述（第N章 X）—— 新建章 / 补齐已有章的缺失 title/label
    for label, info, p in parsed_entries:
        if not p["is_overview"]:
            continue
        ch = _find_chapter(chapters, p["chapter"])
        if ch is None:
            chapters.append({"number": p["chapter"], "title": p["title"], "label": label,
                             "sections": [], "supplements": [], "source": "card"})
            chapters.sort(key=lambda c: c.get("number", 0))
            report["new_chapters"].append(label)
        elif not ch.get("title") or not ch.get("label"):
            if not ch.get("title"):
                ch["title"] = p["title"]
            if not ch.get("label"):
                ch["label"] = label
            report["filled_chapters"].append(label)

    # Pass 2：节（N.M X）
    for label, info, p in parsed_entries:
        if p["is_overview"] or p["section"] is None or len(p["section"]) != 1:
            continue
        n, m = p["chapter"], p["section"][0]
        ch = _ensure_chapter(chapters, n)
        if _find_section(ch, n, m) is None:
            ch.setdefault("sections", []).append({
                "number": [n, m], "title": p["title"], "label": label,
                "printed_page": info.get("first_page"), "subsections": [], "source": "card",
            })
            _sort_sections(ch)
            report["new_sections"].append(label)

    # Pass 3：子节（N.M.K X）；父节缺失时连父节一起补（title 用子节标题兜底，报告标注）
    for label, info, p in parsed_entries:
        if p["is_overview"] or p["section"] is None or len(p["section"]) != 2:
            continue
        n, m, k = p["chapter"], p["section"][0], p["section"][1]
        ch = _ensure_chapter(chapters, n)
        sec = _find_section(ch, n, m)
        if sec is None:
            sec_label = f"{n}.{m} {p['title']}"
            ch.setdefault("sections", []).append({
                "number": [n, m], "title": p["title"], "label": sec_label,
                "printed_page": info.get("first_page"), "subsections": [], "source": "card",
            })
            _sort_sections(ch)
            report["new_sections"].append(sec_label)
            report["section_created_from_subsection"].append(sec_label)
            sec = _find_section(ch, n, m)
        if _find_subsection(sec, n, m, k) is None:
            sec.setdefault("subsections", []).append({
                "number": [n, m, k], "title": p["title"], "label": label,
                "printed_page": info.get("first_page"), "source": "card",
            })
            _sort_subsections(sec)
            report["new_subsections"].append(label)

    report["summary"] = (
        f"{len(report['matched'])} matched, "
        f"{len(report['new_chapters'])} new chapters, "
        f"{len(report['new_sections'])} new sections "
        f"({len(report['section_created_from_subsection'])} created from subsection), "
        f"{len(report['new_subsections'])} new subsections, "
        f"{len(report['filled_chapters'])} filled chapters, "
        f"{len(report['unresolved'])} unresolved"
    )
    return merged, report


def _match_source_key(book_key: str, source: str) -> bool:
    name = book_key.rsplit("/", 1)[-1]
    if source == "all":
        return True
    if source == "zgkao":
        return "试卷" in name or "答案" in name
    if source == "smartedu":
        return "试卷" not in name and "答案" not in name
    return False


def run_merge(output_dir: Path, source: str = "all", dry_run: bool = False) -> list[Path]:
    """扫描 output/toc 下的初始 TOC，与 published 卡片标签合并，写 merged sidecar。

    Returns:
        写出（或 dry-run 时本应写出）的 merged 文件路径列表
    """
    output_dir = Path(output_dir)
    toc_dir = output_dir / "toc"
    published_dir = output_dir / "published"
    merged_paths: list[Path] = []
    if not toc_dir.exists():
        return merged_paths

    for toc_file in sorted(toc_dir.rglob("*.json")):
        if toc_file.name.endswith(".merged.json") or toc_file.name.endswith(".merge_report.json"):
            continue
        book_key = toc_file.relative_to(toc_dir).with_suffix("").as_posix()
        if not _match_source_key(book_key, source):
            continue
        try:
            toc = json.loads(toc_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"[WARN] 跳过无效 TOC 文件 {toc_file}: {e}", flush=True)
            continue

        card_labels = collect_card_labels(published_dir, book_key)
        merged, report = merge_toc(toc, card_labels)

        merged_file = toc_file.with_suffix(".merged.json")
        report_file = toc_file.with_suffix(".merge_report.json")
        if dry_run:
            print(f"[dry-run] {book_key}: {report['summary']}", flush=True)
        else:
            merged_file.write_text(
                json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
            report_file.write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[merge] {book_key}: {report['summary']}", flush=True)
        merged_paths.append(merged_file)
    return merged_paths
