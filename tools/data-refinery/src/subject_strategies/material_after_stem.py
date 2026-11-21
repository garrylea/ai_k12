"""语文「题后材料」找回：题号之后出现的独立材料块归到引用它的题。

切题状态机只把「题号之前」的材料挂给当前/下一题（`between_material` 是单向的），
题后材料遇到下一节标题就被清掉（海淀 202507 模拟二题12 的《行香子》就是这么丢的）。
本模块作为 `split_page` 的后置钩子运行，读原始 lines，不改状态机：

1. 找候选块：题号之后、下一节/大题/答案区之前的独立标题 + 长正文；
2. 定归属：优先题干里的 `《标题》` 精确引用，其次是「本节唯一带未决指代标记的题目」；
3. 判不出时留 pending 记录交 LLM 兜底（`question_extract._resolve_post_material_llm`），
   绝不猜、绝不写进题干。
"""

from __future__ import annotations

import re

from question_splitter import (
    is_answer_keyword, is_group_header, is_main_stem, is_part_header, is_section_header,
)

_BOOK_TITLE_RE = re.compile(r"《([^》]{1,40})》")
_UNRESOLVED_RE = re.compile(
    r"本诗|这首词|该诗|上述材料|上面材料|以上材料|上文|画线句|相关句子|结合材料|下面材料"
)
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_HEAD_RE = re.compile(r"^\s*#{1,6}\s*(.+?)\s*$")
_PUNCT_RE = re.compile(r"[。！？；：:，,、0-9A-Za-z《》]")
MIN_BLOCK_CJK = 40
MIN_BODY_CHARS = 30


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _cjk_len(text: str) -> int:
    return len(_CJK_RE.findall(text or ""))


def _is_boundary(line: str) -> bool:
    """小节/大题/部分/答案区边界；普通 `##` 标题（如 `## 秦观`）不是边界。"""
    return bool(
        is_section_header(line)
        or is_group_header(line)[0]
        or is_part_header(line)[0]
        or is_answer_keyword(line)
    )


def _stem_lines(lines: list[str]) -> list[tuple[int, int]]:
    """[(题号, 行号)]，答案区之后不再收，避免答案题号冒充主题号。"""
    out: list[tuple[int, int]] = []
    for i, line in enumerate(lines):
        if is_answer_keyword(line):
            break
        ok, number = is_main_stem(line)
        if ok and number is not None:
            out.append((number, i))
    return out


def _title_at(lines: list[str], i: int) -> str | None:
    """i 行是否是一个独立材料标题（短、纯中文、后面有长正文）。"""
    line = lines[i].strip()
    if not line or _is_boundary(line) or is_main_stem(line)[0]:
        return None
    m = _HEAD_RE.match(line)
    title = (m.group(1) if m else line).strip()
    if not (2 <= len(title) <= 12) or _PUNCT_RE.search(title):
        return None
    scanned = 0
    for j in range(i + 1, min(i + 6, len(lines))):
        nxt = lines[j].strip()
        if not nxt:
            continue
        if _is_boundary(nxt) or is_main_stem(nxt)[0]:
            return None
        if len(nxt) >= MIN_BODY_CHARS:
            return title
        scanned += 1
        if scanned >= 4:
            return None
    return None


def find_post_material_blocks(lines: list[str]) -> list[dict]:
    """找题号之后、边界之前的独立材料块；每道题最多取一块。

    返回 dict：``start``/``end``（0-based，end 不含）、``title``、``text``。
    """
    stems = _stem_lines(lines)
    stem_indexes = {idx for _, idx in stems}
    blocks: list[dict] = []
    seen: set[str] = set()

    for _number, stem_idx in stems:
        end = len(lines)
        for j in range(stem_idx + 1, len(lines)):
            if j in stem_indexes or _is_boundary(lines[j]):
                end = j
                break
        for i in range(stem_idx + 1, end):
            title = _title_at(lines, i)
            if not title:
                continue
            text = "\n".join(lines[i:end]).rstrip()
            if _cjk_len(text) < MIN_BLOCK_CJK:
                break
            key = _norm(title)
            if key in seen:
                break
            seen.add(key)
            blocks.append({"start": i, "end": end, "title": title, "text": text})
            break
    return blocks


def _section_start(lines: list[str], block_start: int) -> int:
    for i in range(block_start - 1, -1, -1):
        if is_section_header(lines[i]):
            return i
    return 0


def _candidates(questions, lines: list[str], block: dict) -> list:
    """与材料块同一小节、且位于块之前的题（按题号顺序）。"""
    section = _section_start(lines, block["start"])
    by_order = {}
    for order, idx in _stem_lines(lines):
        by_order.setdefault(order, idx)
    out = [q for q in questions
           if section <= by_order.get(q.group_order, -1) < block["start"]]
    return sorted(out, key=lambda q: q.group_order)


def resolve_owner(questions, block: dict, lines: list[str]) -> tuple[int | None, str]:
    """返回 (题号, 口径)；口径 = exact | nearest | ambiguous | none。"""
    candidates = _candidates(questions, lines, block)
    if not candidates:
        return None, "none"

    section_line = lines[_section_start(lines, block["start"])]
    title = _norm(block["title"])

    exact: list = []
    marked: list = []
    for q in candidates:
        content = q.content or ""
        current = q.material_text or ""
        refs = {_norm(t) for t in _BOOK_TITLE_RE.findall(content)}
        refs = {t for t in refs if t and t not in _norm(current) and t not in _norm(section_line)}
        if title in refs:
            exact.append(q)
        if _UNRESOLVED_RE.search(content):
            marked.append(q)

    if len(exact) == 1:
        return exact[0].group_order, "exact"
    if len(exact) > 1:
        return None, "ambiguous"
    if len(marked) == 1:
        return marked[0].group_order, "nearest"
    if len(marked) > 1:
        return None, "ambiguous"
    return None, "none"


def append_block(question, text: str) -> None:
    """把找回块追加到 material_text，同时记下原标题给人标注/写 JSONL 时拆分。"""
    base = getattr(question, "post_material_base", None)
    if base is None:
        base = question.material_text or ""
        question.post_material_base = base
    question.material_text = base.rstrip() + "\n\n" + text.strip()
    question.post_material_appended = text.strip()


def attach_post_material(questions, lines: list[str], paper_stem: str = "") -> int:
    """split_page 后置钩子：真正挂材料，模糊块留 pending 交 LLM。返回挂上的块数。"""
    blocks = find_post_material_blocks(lines)
    hits = 0
    for block_id, block in enumerate(blocks):
        already = any(
            _norm(block["title"]) in _norm(q.material_text or "") for q in questions
        )
        if already:
            continue
        owner, status = resolve_owner(questions, block, lines)
        candidates = _candidates(questions, lines, block)
        if status in ("exact", "nearest"):
            for q in questions:
                if q.group_order == owner:
                    append_block(q, block["text"])
                    hits += 1
                    print(f"[post-material] {paper_stem}: 题{owner} ← 《{block['title']}》"
                          f"@{block['start'] + 1}（{status}）", flush=True)
                    break
        elif status == "ambiguous":
            pending = {
                "block_id": block_id,
                "block_text": block["text"],
                "block_line": block["start"] + 1,
                "candidate_orders": [q.group_order for q in candidates],
                "section_key": lines[_section_start(lines, block["start"])],
                "stems": {str(q.group_order): (q.content or "")[:200] for q in candidates},
                "block_excerpt": block["text"][:200],
            }
            for q in candidates:
                q.post_material_pending = (q.post_material_pending or []) + [pending]
            print(f"[post-material] {paper_stem}: 题后材料《{block['title']}》归属不明"
                  f"（候选 {pending['candidate_orders']}），交 LLM 复核", flush=True)
    return hits