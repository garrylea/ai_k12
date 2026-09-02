"""页眉/页脚（page chrome）剥离：书级频率统计自动发现。

背景：MinerU OCR 会把教材的运行页眉（如「# 人民教育出版社」）和 PDF 水印页脚
（「仅供个人学习使用，未经授权不得另做他用」）带进 md 正文。前者导致 is_front_matter
的「出版社」子串误杀正文页，后者同理；且页眉文字会混进卡片内容。

算法（2026-09-01，新书 186 页实测校准）：
1. 书级预扫描：每页取开头 2 + 结尾 2 个非空行，归一化（去 # 前缀/首尾空白）统计出现页数。
2. 双重条件判定（缺一不可）：
   - 频率：出现页数 >= CHROME_MIN_PAGES（防偶发内容行被剥，如题干里「某出版社…」）
   - 安全模式：含出版社/版权水印/纯页码数字/ISBN（防高频内容标题被剥，如「练习」8 页）
3. 逐页剥行：整行归一化后命中集合的行删除（任意位置，OCR 偶把页眉排到页中）。
"""

import re
from pathlib import Path

# 频率门槛：同一行至少出现在这么多页才可能是固定版式
CHROME_MIN_PAGES = 3

# 每页取开头/结尾各几个非空行参与统计
_EDGE_LINES = 2

# 安全模式：命中其一才允许作为 chrome 行（与频率条件叠加）
_CHROME_PATTERNS = [
    re.compile(r"出版社"),
    re.compile(r"仅供个人学习|未经授权|版权所有"),
    re.compile(r"^\d{1,3}$"),      # 纯页码行
    re.compile(r"^ISBN\b", re.IGNORECASE),
]


def _normalize(line: str) -> str:
    """归一化：去 # 前缀与首尾空白（`# 人民教育出版社` ≡ `人民教育出版社`）。"""
    return re.sub(r"^#{1,6}\s*", "", line.strip()).strip()


def _is_chrome_pattern(normalized: str) -> bool:
    return any(p.search(normalized) for p in _CHROME_PATTERNS)


def _candidate_lines(text: str) -> set[str]:
    """取一页开头/结尾各 _EDGE_LINES 个非空行的归一化形式。"""
    lines = [l for l in text.splitlines() if l.strip()]
    edges = lines[:_EDGE_LINES] + lines[-_EDGE_LINES:]
    return {_normalize(l) for l in edges} - {""}


def compute_book_chrome(md_dir: Path) -> set[str]:
    """扫描书目录下全部 page_*.md，返回页眉/页脚行集合（归一化形式）。

    注意：必须扫目录下全部页（调用方不要只传 --pages 过滤后的子集），
    否则频率统计失真导致漏剥。
    """
    counts: dict[str, int] = {}
    if not md_dir.is_dir():
        return set()
    for md_path in sorted(md_dir.glob("page_*.md")):
        text = md_path.read_text(encoding="utf-8", errors="ignore")
        for line in _candidate_lines(text):
            counts[line] = counts.get(line, 0) + 1
    return {line for line, n in counts.items()
            if n >= CHROME_MIN_PAGES and _is_chrome_pattern(line)}


def strip_chrome(text: str, chrome: set[str]) -> str:
    """删除整行归一化后命中 chrome 集合的行（任意位置）。"""
    if not chrome:
        return text
    kept = [l for l in text.splitlines()
            if _normalize(l) not in chrome]
    return "\n".join(kept)
