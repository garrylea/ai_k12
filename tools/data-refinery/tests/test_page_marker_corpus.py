"""页码清洗的全量语料回归。

- `page_marker_cases.jsonl`：6 个真实片段的最小回归；
- 若 `output/md` 存在：扫描全部试卷/答案 md，把「像页码」的行分成
  auto / negative / manual 三类；未分类的新形态直接失败，强制更新清单。
"""

import json
import re
from collections import defaultdict
from pathlib import Path

import pytest

from page_markers import (
    BARE_PAGE_RE,
    BARE_TOTAL_RE,
    PAGE_MARKER_RE,
    strip_page_markers,
)

FIXTURES = Path(__file__).parent / "fixtures"
CASES = FIXTURES / "page_marker_cases.jsonl"
MANUAL_SNAPSHOT = FIXTURES / "page_marker_manual.txt"
OUTPUT_MD = Path(__file__).resolve().parents[1] / "output" / "md"

_PAGE_ANY_RE = re.compile(r"第\s*[0-9０-９]{1,3}\s*页")
_TOTAL_ANY_RE = re.compile(r"共\s*[0-9０-９]{1,3}\s*页")
_PAGE_EN_RE = re.compile(r"(?i)\bpage\s*\d{1,3}\s*(?:of|/)\s*\d{1,3}\b")
_BARE_DIGIT_RE = re.compile(r"^\s*[—–-]?\s*\d{1,3}\s*[—–-]?\s*$")
_FRACTION_RE = re.compile(r"\b\d{1,3}\s*/\s*\d{1,3}\b")


def _is_exam(p: Path) -> bool:
    s = p.as_posix()
    if p.name.startswith("page_"):
        return False
    if "人教版" in s or "统编版" in s:
        return False
    return ("试卷" in s or "答案" in s or "期中" in s or "期末" in s or "模拟" in s)


def _manual_snapshot() -> set[str]:
    if not MANUAL_SNAPSHOT.exists():
        return set()
    return {
        line.rstrip()
        for line in MANUAL_SNAPSHOT.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }


def test_real_case_fixtures():
    cases = [
        json.loads(line)
        for line in CASES.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(cases) == 6
    for case in cases:
        got, _ = strip_page_markers(case["input"])
        assert got == case["expect"], case["name"]


def test_corpus_has_no_unclassified_page_like_lines():
    if not OUTPUT_MD.is_dir():
        pytest.skip(f"没有生成物目录：{OUTPUT_MD}")

    auto = 0
    negative = 0
    scanned = 0
    manual: set[str] = set()
    unclassified: list[str] = []

    for md in sorted(OUTPUT_MD.rglob("*.md")):
        if not _is_exam(md):
            continue
        scanned += 1
        text = md.read_text(encoding="utf-8", errors="ignore")
        cleaned, hits = strip_page_markers(text)
        _ = cleaned
        hits_by_line: dict[int, list] = defaultdict(list)
        for h in hits:
            hits_by_line[h.line_no].append(h)

        rel = md.relative_to(OUTPUT_MD).as_posix()
        for line_no, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if not s:
                continue

            has_strong = bool(PAGE_MARKER_RE.search(s))
            has_weak = bool(BARE_PAGE_RE.match(s) or BARE_TOTAL_RE.match(s))
            has_page_any = bool(_PAGE_ANY_RE.search(s))
            has_total = bool(_TOTAL_ANY_RE.search(s))
            has_page_en = bool(_PAGE_EN_RE.search(s))
            has_bare_digit = bool(_BARE_DIGIT_RE.match(s))
            has_fraction = bool(_FRACTION_RE.search(s))

            if not (has_strong or has_weak or has_page_any or has_total
                    or has_page_en or has_bare_digit or has_fraction):
                continue

            line_hits = hits_by_line.get(line_no, [])
            if line_hits:
                for h in line_hits:
                    if h.removed:
                        auto += 1
                    else:
                        manual.add(f"{rel}:{line_no}: {h.raw.strip()}")
                continue

            if has_strong or has_weak:
                # 有强/弱锚点却没被 cleaner 处理：新形态，必须人工看
                unclassified.append(f"{rel}:{line_no}: {s[:160]}")
                continue

            if has_page_any:
                # 正文里的「第 N 页」引用：不是页脚
                if re.search(r"请阅读|见第|参看|第\s*\d+\s*页的", s):
                    negative += 1
                    assert strip_page_markers(line)[0] == line
                    continue
                # 「数学试卷 第5页」这类无「共/斜杠」的页眉，当前不支持
                unclassified.append(f"{rel}:{line_no}: {s[:160]}")
                continue

            if has_total:
                # 本试卷共8页 / 答题卡共4页 等考生须知
                negative += 1
                assert strip_page_markers(line)[0] == line
                continue

            if has_bare_digit:
                # 图片标号 1/2/3/4 等
                negative += 1
                assert strip_page_markers(line)[0] == line
                continue

            if has_fraction:
                # 数学分数/比例 28/7 等
                negative += 1
                assert strip_page_markers(line)[0] == line
                continue

            if has_page_en:
                unclassified.append(f"{rel}:{line_no}: (Page N of M 未支持) {s[:160]}")
                continue

    assert not unclassified, (
        "发现未分类的页码候选行；请先确认是页脚还是正文，再更新 page_markers.py / "
        "page_marker_manual.txt：\n" + "\n".join(unclassified[:50])
    )

    if scanned == 0:
        pytest.skip("没有扫到试卷/答案 md")

    expected_manual = _manual_snapshot()
    assert manual == expected_manual, (
        "manual 清单变化：\n"
        f"新增：{sorted(manual - expected_manual)}\n"
        f"消失：{sorted(expected_manual - manual)}"
    )

    # 防止测试在空语料上静默通过；当前语料至少有 6 处 auto。
    assert auto >= 1
    assert negative >= 1
