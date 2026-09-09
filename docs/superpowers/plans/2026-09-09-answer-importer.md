# answer_importer 答案补全导入工具实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** data-refinery 新增 `answer_importer` CLI——把「人工+AI 产出的试卷答案 Markdown 文档」匹配到库内试卷题目并回写 `questions.answer/explanation/type`，dry-run 出 diff、确认后写入、幂等可重跑。

**Architecture:** 三层——`answer_doc.py`（纯函数：Markdown → 结构化）、`answer_importer.py`（纯函数：题目匹配 + diff 构建 + 报告格式化）、`answer_importer_cli.py`（pymysql 连库 + 编排：定位试卷 → 匹配 → dry-run 报告 → `--apply` 写入）。纯函数全部可单测，不依赖真库。

**Tech Stack:** Python 3 + pymysql + pytest（tools/data-refinery 既有栈，模板：`backfill_question_kps.py` 的连库与 argparse 模式）。

**设计文档:** `docs/superpowers/specs/2026-09-09-judging-rework-design.md` §4

**已核实的关键数据事实（2026-09-09 实测）:**

- `paper_questions.question_no` = **原卷印刷题号**（行序 1..n，每题一行；大题的多个小问嵌在 `questions.content` 内，不拆行）——文档 `## 25` 直接对 `question_no=25`，无需二次映射。
- `exam_papers.title` **存在重名**（如「2024 海淀 初三 模拟二」出现两次）——按题名定位必须列候选让人选，或直接传 `--paper-id`。
- 存量：547 题中 188 道 `answer=''`、451 道无解析；`questions.type` 无 CHECK 约束（calculation 回写无需改类型列）。

---

### Task 1: DB migration — questions.answer_verified 标记列

**Files:**
- Create: `tools/db/migrations/2026-09-09_add_questions_answer_verified.sql`
- Modify: `tools/db/schema.sql`（questions 表折回）
- Modify: `docs/K12智学系统-数据库设计文档.md`（questions 字段表）

- [ ] **Step 1: 写迁移并折回 schema.sql**

`tools/db/migrations/2026-09-09_add_questions_answer_verified.sql`：

```sql
-- 2026-09-09 判题体系重构：答案人工核验标记。
-- answer_importer 回写的题置 1，与管线提取的原始数据（0）区分——
-- ExplanationCacheService 等后续链路可据此区分答案可信度。
ALTER TABLE questions ADD COLUMN answer_verified TINYINT(1) NOT NULL DEFAULT 0;
```

`tools/db/schema.sql` 的 questions 表（:209-235）在 `is_active` 之前插入：

```sql
  answer_verified TINYINT(1) NOT NULL DEFAULT 0,  -- 答案人工核验标记（answer_importer 回写置 1）
```

（带上折回注释：`-- 折回自 migrations/2026-09-09_add_questions_answer_verified.sql`，先例见训练模块表区块。）

同时检查 `tools/data-refinery/src/db_loader.py:1113` 的 `INSERT INTO questions (...)` 列清单——若显式列出全部列则不需动（新列走 DEFAULT 0）；若用 `SELECT *` 语义则同步补列。执行时 grep 确认。

- [ ] **Step 2: 应用 + 验证**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-09_add_questions_answer_verified.sql
mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW COLUMNS FROM questions LIKE 'answer_verified';"
```

Expected: 一行，Default `0`。

- [ ] **Step 3: 更新 DB 设计文档 + Commit**

`docs/K12智学系统-数据库设计文档.md` questions 字段表加 `answer_verified` 行（说明同上）。

```bash
git add tools/db/ docs/K12智学系统-数据库设计文档.md
git commit -m "feat(db): questions.answer_verified 人工核验标记列"
```

---

### Task 2: answer_doc.py — Markdown 答案文档解析

**Files:**
- Create: `tools/data-refinery/src/answer_doc.py`
- Test: `tools/data-refinery/tests/test_answer_doc.py`

- [ ] **Step 1: 写失败测试**

```python
"""answer_doc：答案文档 Markdown 解析。"""

import pytest

from answer_doc import AnswerDocError, parse_answer_doc


class TestParseBasic:
    def test_标题与单题(self):
        doc = parse_answer_doc(
            "# 试卷：2024 海淀 初三 模拟二\n"
            "\n"
            "## 1\n"
            "答案：B\n"
            "解析：由顶点式可知顶点为 $(2,3)$。\n"
        )
        assert doc.title == "2024 海淀 初三 模拟二"
        assert len(doc.items) == 1
        it = doc.items[0]
        assert it.no == 1
        assert it.answer == "B"
        assert it.explanation == "由顶点式可知顶点为 $(2,3)$。"
        assert it.type_override is None

    def test_多题与可选字段(self):
        doc = parse_answer_doc(
            "# 试卷：X\n"
            "## 2\n"
            "答案：$x=3$ 或 $x=-1$\n"
            "## 17\n"
            "答案：解：设……所以 x=2。\n"
            "解析：考查一元二次方程……\n"
            "题型：calculation\n"
        )
        assert [i.no for i in doc.items] == [2, 17]
        assert doc.items[1].type_override == "calculation"

    def test_多行答案与解析续行(self):
        doc = parse_answer_doc(
            "# 试卷：X\n"
            "## 25\n"
            "答案：（1）挥发性\n"
            "（2）$2H_2+O_2=2H_2O$\n"
            "解析：\n"
            "第（1）问考查物理性质。\n"
            "第（2）问考查化学方程式书写。\n"
        )
        it = doc.items[0]
        assert it.answer == "（1）挥发性\n（2）$2H_2+O_2=2H_2O$"
        assert it.explanation.startswith("第（1）问")
        assert it.explanation.count("\n") == 1

    def test_全角冒号与空解析(self):
        doc = parse_answer_doc("# 试卷：X\n## 3\n答案：对\n解析：\n")
        assert doc.items[0].answer == "对"
        assert doc.items[0].explanation == ""


class TestValidation:
    def test_缺答案报错并列出题号(self):
        with pytest.raises(AnswerDocError, match="第 4 题.*答案"):
            parse_answer_doc("# 试卷：X\n## 4\n解析：只有解析\n")

    def test_非法题型标注报错(self):
        with pytest.raises(AnswerDocError, match="第 5 题.*题型"):
            parse_answer_doc("# 试卷：X\n## 5\n答案：B\n题型：单选题\n")

    def test_无试卷标题报错(self):
        with pytest.raises(AnswerDocError, match="试卷标题"):
            parse_answer_doc("## 1\n答案：B\n")

    def test_无任何题目标记报错(self):
        with pytest.raises(AnswerDocError, match="题目"):
            parse_answer_doc("# 试卷：X\n")


class TestIdempotentShape:
    def test_题号去重_后写覆盖前写(self):
        doc = parse_answer_doc("# 试卷：X\n## 1\n答案：A\n## 1\n答案：B\n")
        assert len(doc.items) == 1
        assert doc.items[0].answer == "B"
```

Run: `cd tools/data-refinery && pytest tests/test_answer_doc.py -q`
Expected: FAIL（模块不存在）。

**注意**：tests/ 的 import 风格以既有测试为准——先看 `tests/test_answer_merger.py` 头部（`from answer_merger import ...` 还是 `from src.answer_merger import ...`），本计划按前者写，若为后者则统一调整 import 行。

- [ ] **Step 2: 实现**

```python
"""答案文档解析：把「人工+AI 产出」的试卷答案 Markdown 解析成结构化数据。

文档格式（spec 2026-09-09-judging-rework §4.1）：
    # 试卷：<试卷标题>          —— 标题用于定位 exam_papers（可重名，CLI 列候选）
    ## <印刷题号>               —— 对应 paper_questions.question_no（原卷题号，每题一行）
    答案：<内容，可多行>         —— 必填；数学公式用 $...$ LaTeX
    解析：<内容，可多行>         —— 可选；包含答题思路与完整过程
    题型：calculation          —— 可选；仅当需改标（short_answer<->calculation 等）时写

多行续接：字段行之后的非空行接续到该字段（换行拼接），空行断开。
"""

import re
from dataclasses import dataclass, field

HEADING_PAPER_RE = re.compile(r"^#\s*试卷[:：]\s*(.+?)\s*$")
HEADING_ITEM_RE = re.compile(r"^##\s*(\d+)\s*$")
FIELD_RE = re.compile(r"^(答案|解析|题型)[:：]\s*(.*)$")

VALID_TYPE_OVERRIDES = {"choice", "fill_blank", "true_false", "short_answer", "proof", "calculation"}


class AnswerDocError(ValueError):
    """文档格式/内容不合法（缺答案、非法题型标注、缺标题等）。"""


@dataclass
class AnswerDocItem:
    no: int
    answer: str = ""
    explanation: str = ""
    type_override: str | None = None


@dataclass
class AnswerDoc:
    title: str = ""
    items: list[AnswerDocItem] = field(default_factory=list)


def parse_answer_doc(text: str) -> AnswerDoc:
    doc = AnswerDoc()
    by_no: dict[int, AnswerDocItem] = {}
    current: AnswerDocItem | None = None
    field: str | None = None

    def append_current(value: str) -> None:
        nonlocal field
        assert current is not None and field is not None
        value = value.strip()
        if field == "答案":
            current.answer = f"{current.answer}\n{value}" if current.answer else value
        elif field == "解析":
            current.explanation = f"{current.explanation}\n{value}" if current.explanation else value

    for raw in text.splitlines():
        line = raw.rstrip()

        m = HEADING_PAPER_RE.match(line)
        if m:
            doc.title = m.group(1)
            current, field = None, None
            continue

        m = HEADING_ITEM_RE.match(line)
        if m:
            no = int(m.group(1))
            current = by_no.get(no)
            if current is None:
                current = AnswerDocItem(no=no)
                by_no[no] = current
                doc.items.append(current)
            field = None
            continue

        if current is None:
            continue  # 标题前的杂项行（如 <!-- 注释 -->）忽略

        m = FIELD_RE.match(line)
        if m:
            field = m.group(1)
            value = m.group(2).strip()
            if field == "答案":
                current.answer = value
            elif field == "解析":
                current.explanation = value
            else:
                current.type_override = value or None
        elif line.strip():
            if field in ("答案", "解析"):
                append_current(line)
        else:
            field = None  # 空行断开续接

    _validate(doc)
    return doc


def _validate(doc: AnswerDoc) -> None:
    if not doc.title:
        raise AnswerDocError("缺少试卷标题（首行应为「# 试卷：<标题>」）")
    if not doc.items:
        raise AnswerDocError("文档中没有任何题目（需要「## <题号>」标记）")
    for it in doc.items:
        if not it.answer.strip():
            raise AnswerDocError(f"第 {it.no} 题缺少「答案：」字段（每题必写答案）")
        if it.type_override is not None and it.type_override not in VALID_TYPE_OVERRIDES:
            raise AnswerDocError(
                f"第 {it.no} 题题型标注非法：{it.type_override}（仅允许 {' | '.join(sorted(VALID_TYPE_OVERRIDES))}）"
            )
```

Run: `cd tools/data-refinery && pytest tests/test_answer_doc.py -q`
Expected: PASS（全部用例）。

- [ ] **Step 3: Commit**

```bash
git add tools/data-refinery/src/answer_doc.py tools/data-refinery/tests/test_answer_doc.py
git commit -m "feat(data-refinery): answer_doc 答案文档 Markdown 解析"
```

---

### Task 3: answer_importer.py — 匹配 + diff + 报告（纯函数）

**Files:**
- Create: `tools/data-refinery/src/answer_importer.py`
- Test: `tools/data-refinery/tests/test_answer_importer.py`

- [ ] **Step 1: 写失败测试**

```python
"""answer_importer：题目匹配 + diff 构建 + 报告格式化（纯函数，不连库）。"""

from answer_doc import AnswerDocItem
from answer_importer import (
    PaperQuestionRow,
    build_diff,
    format_report,
    locate_paper,
    match_items,
)


def row(no, qid, type_="short_answer", answer="", explanation=None):
    return PaperQuestionRow(question_id=qid, question_no=no, type=type_, answer=answer, explanation=explanation)


class TestMatch:
    def test_按题号匹配(self):
        items = [AnswerDocItem(no=1, answer="B"), AnswerDocItem(no=25, answer="过程…")]
        rows = [row(1, 101, "choice"), row(25, 125, "short_answer")]
        m = match_items(items, rows)
        assert [(i.no, r.question_id) for i, r in m.matched] == [(1, 101), (25, 125)]
        assert m.unmatched_doc == []
        assert m.missing_rows == []

    def test_文档题号库里没有(self):
        items = [AnswerDocItem(no=99, answer="X")]
        m = match_items(items, [row(1, 101)])
        assert [i.no for i in m.unmatched_doc] == [99]
        assert m.matched == []

    def test_缺口报告_库里空答案且文档未覆盖(self):
        items = [AnswerDocItem(no=1, answer="B")]
        rows = [row(1, 101, "choice"), row(2, 102, "choice", answer=""), row(3, 103, "short_answer", answer="", explanation="有解析")]
        m = match_items(items, rows)
        # 题 2 空答案未被文档覆盖 -> 缺口；题 3 有解析但答案空 -> 仍算缺口（answer 必须补）
        assert [r.question_no for r in m.missing_rows] == [2, 3]


class TestDiff:
    def test_答案变化_解析新增_题型改写(self):
        matched = [
            (AnswerDocItem(no=1, answer="B", explanation="新解析", type_override=None), row(1, 101, "choice", answer="A")),
            (AnswerDocItem(no=17, answer="x=2", explanation="", type_override="calculation"), row(17, 117, "short_answer", answer="", explanation="旧解析")),
        ]
        diff = build_diff(matched)
        assert len(diff) == 2
        d0, d1 = diff
        assert (d0.question_id, d0.old_answer, d0.new_answer) == (101, "A", "B")
        assert d0.explanation_change == (False, True)
        assert d1.type_change == ("short_answer", "calculation")
        assert d1.explanation_change == (True, False)  # 文档解析为空 -> 保留旧解析

    def test_完全一致的题不出现在diff_幂等(self):
        matched = [(AnswerDocItem(no=1, answer="B", explanation="同"), row(1, 101, "choice", answer="B", explanation="同"))]
        assert build_diff(matched) == []


class TestLocatePaper:
    def test_唯一精确命中(self):
        assert locate_paper("X 卷", [("X 卷", 3, 30)]) == (3, [])

    def test_重名列候选(self):
        papers = [("X 卷", 2, 37), ("X 卷", 6, 28), ("Y 卷", 9, 28)]
        pid, candidates = locate_paper("X 卷", papers)
        assert pid is None
        assert [c[1] for c in candidates] == [2, 6]

    def test_无精确命中_fallback子串(self):
        papers = [("2024 海淀 初三 模拟二", 2, 37)]
        pid, candidates = locate_paper("海淀", papers)
        assert pid == 2


class TestReport:
    def test_报告包含各区段(self):
        matched = [(AnswerDocItem(no=1, answer="B"), row(1, 101, "choice", answer="A"))]
        m = match_items(
            [AnswerDocItem(no=1, answer="B"), AnswerDocItem(no=99, answer="X")],
            [row(1, 101, "choice", answer="A"), row(2, 102, answer="")],
        )
        report = format_report(
            title="X 卷", paper_id=3,
            diff=build_diff(matched),
            unmatched_doc=m.unmatched_doc,
            missing_rows=m.missing_rows,
        )
        assert "试卷 #3 X 卷" in report
        assert "将更新 1 题" in report
        assert "#99" in report          # 未匹配题号
        assert "缺口" in report          # 空答案未覆盖
```

Run: `cd tools/data-refinery && pytest tests/test_answer_importer.py -q`
Expected: FAIL。

- [ ] **Step 2: 实现**

```python
"""answer_importer：题目匹配 + diff 构建 + 报告格式化（纯函数层）。

DB 编排（定位试卷 SQL / 读题 / UPDATE 回写）在 answer_importer_cli.py；
本模块只做可单测的数据变换。回写语义（spec §4.2）：
- answer：每题必写（文档必填），无条件覆盖；
- explanation：文档提供则覆盖，留空则保留库内既有解析（不抹掉）；
- type：仅文档标了「题型：」且与库内不同才改；
- answer_verified 置 1（人工核验标记）。
幂等：同文档重跑 -> diff 为空 -> 不发 UPDATE。
"""

from dataclasses import dataclass

from answer_doc import AnswerDocItem


@dataclass
class PaperQuestionRow:
    question_id: int
    question_no: int
    type: str
    answer: str
    explanation: str | None


@dataclass
class MatchResult:
    matched: list[tuple[AnswerDocItem, PaperQuestionRow]]
    unmatched_doc: list[AnswerDocItem]
    missing_rows: list[PaperQuestionRow]


@dataclass
class DiffEntry:
    question_id: int
    question_no: int
    type: str
    old_answer: str
    new_answer: str
    explanation_change: tuple[bool, bool]     # (旧有无, 新是否提供)
    type_change: tuple[str, str] | None       # (旧, 新)；None = 不改


def locate_paper(title: str, papers: list[tuple[str, int, int]]) -> tuple[int | None, list[tuple[str, int, int]]]:
    """在 (title, id, question_count) 列表中定位试卷：唯一精确命中返回 id；
    重名/多条候选返回 (None, 候选列表)；无精确命中时子串匹配兜底（仍多条则列候选）。
    papers 通常由 CLI 的 LIKE 查询预过滤后传入。"""
    exact = [p for p in papers if p[0] == title]
    if len(exact) == 1:
        return exact[0][1], []
    hits = exact or [p for p in papers if title in p[0]]
    if len(hits) == 1:
        return hits[0][1], []
    return None, hits


def match_items(items: list[AnswerDocItem], rows: list[PaperQuestionRow]) -> MatchResult:
    by_no = {r.question_no: r for r in rows}
    covered: set[int] = set()
    matched: list[tuple[AnswerDocItem, PaperQuestionRow]] = []
    unmatched_doc: list[AnswerDocItem] = []
    for it in items:
        r = by_no.get(it.no)
        if r is None:
            unmatched_doc.append(it)
        else:
            covered.add(it.no)
            matched.append((it, r))
    # 缺口：库里 answer 为空且文档未覆盖的题（导入后仍判不了的题，报告提醒补齐）
    missing_rows = [r for r in rows if not r.answer.strip() and r.question_no not in covered]
    return MatchResult(matched=matched, unmatched_doc=unmatched_doc, missing_rows=missing_rows)


def build_diff(matched: list[tuple[AnswerDocItem, PaperQuestionRow]]) -> list[DiffEntry]:
    diff: list[DiffEntry] = []
    for it, r in matched:
        old_answer = r.answer or ""
        new_answer = it.answer.strip()
        old_has_expl = bool((r.explanation or "").strip())
        new_has_expl = bool(it.explanation.strip())
        type_change = (r.type, it.type_override) if it.type_override and it.type_override != r.type else None
        answer_changed = old_answer.strip() != new_answer
        expl_changed = new_has_expl and not old_has_expl  # 旧有新空 = 保留旧，不算变化
        if not (answer_changed or expl_changed or type_change):
            continue  # 幂等：无变化不出 diff
        diff.append(DiffEntry(
            question_id=r.question_id,
            question_no=r.question_no,
            type=it.type_override or r.type,
            old_answer=old_answer,
            new_answer=new_answer,
            explanation_change=(old_has_expl, new_has_expl),
            type_change=type_change,
        ))
    return diff


def _trunc(s: str, n: int = 40) -> str:
    s = s.replace("\n", " ")
    return s if len(s) <= n else s[:n] + "…"


def format_report(
    title: str,
    paper_id: int,
    diff: list[DiffEntry],
    unmatched_doc: list[AnswerDocItem],
    missing_rows: list[PaperQuestionRow],
) -> str:
    lines = [f"=== 试卷 #{paper_id} {title} ===", f"将更新 {len(diff)} 题（dry-run 预览，--apply 才写入）", ""]
    if diff:
        lines.append("—— 更新明细 ——")
        for d in diff:
            lines.append(f"  题 {d.question_no} (questions#{d.question_id}, {d.type})")
            lines.append(f"    答案: {_trunc(d.old_answer)} -> {_trunc(d.new_answer)}")
            if d.explanation_change[1] and not d.explanation_change[0]:
                lines.append("    解析: (无 -> 新增)")
            elif d.explanation_change[1] and d.explanation_change[0]:
                lines.append("    解析: (覆盖既有)")
            if d.type_change:
                lines.append(f"    题型: {d.type_change[0]} -> {d.type_change[1]}")
        lines.append("")
    if unmatched_doc:
        nos = "、".join(f"#{i.no}" for i in unmatched_doc)
        lines.append(f"—— 文档题号在库中未找到（不写入）: {nos} ——")
        lines.append("    请核对题号或该卷题单是否完整。")
        lines.append("")
    if missing_rows:
        nos = "、".join(f"#{r.question_no}(questions#{r.question_id})" for r in missing_rows)
        lines.append(f"—— 缺口提醒：库内 {len(missing_rows)} 题空答案且本文档未覆盖: {nos} ——")
        lines.append("")
    if not diff and not unmatched_doc and not missing_rows:
        lines.append("（无变化——文档与库内数据一致，幂等重跑）")
    return "\n".join(lines)
```

Run: `cd tools/data-refinery && pytest tests/test_answer_importer.py -q`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add tools/data-refinery/src/answer_importer.py tools/data-refinery/tests/test_answer_importer.py
git commit -m "feat(data-refinery): answer_importer 匹配/diff/报告纯函数层"
```

---

### Task 4: answer_importer_cli.py — 连库编排 + --apply 回写

**Files:**
- Create: `tools/data-refinery/src/answer_importer_cli.py`
- Test: `tools/data-refinery/tests/test_answer_importer_cli.py`

- [ ] **Step 1: 写失败测试**（argparse 与回写 SQL 生成可单测；真库操作走 Task 6 集成验证）

```python
"""answer_importer_cli：参数解析与回写 SQL 语句构造。"""

from answer_doc import AnswerDocItem
from answer_importer import DiffEntry
from answer_importer_cli import build_apply_sql, parse_args


class TestArgs:
    def test_默认dry_run_须显式apply(self):
        args = parse_args(["--doc", "a.md"])
        assert args.apply is False
        assert args.paper_id is None

    def test_paper_id与apply(self):
        args = parse_args(["--doc", "a.md", "--paper-id", "3", "--apply"])
        assert args.paper_id == 3
        assert args.apply is True


class TestApplySql:
    def test_不改题型时不含type列(self):
        d = DiffEntry(question_id=101, question_no=1, type="choice",
                      old_answer="A", new_answer="B",
                      explanation_change=(False, True), type_change=None)
        sql, params = build_apply_sql(d, explanation="新解析")
        assert "type =" not in sql
        assert "answer_verified = 1" in sql
        assert params[-1] == 101

    def test_改题型时含type列_参数序一致(self):
        d = DiffEntry(question_id=117, question_no=17, type="calculation",
                      old_answer="", new_answer="x=2",
                      explanation_change=(True, False), type_change=("short_answer", "calculation"))
        sql, params = build_apply_sql(d, explanation=None)
        assert "type = ?" in sql
        assert params == ["x=2", None, "calculation", 117]
```

Run: `cd tools/data-refinery && pytest tests/test_answer_importer_cli.py -q`
Expected: FAIL。

- [ ] **Step 2: 实现 CLI**

```python
"""answer_importer_cli：答案文档回写题库（人工+AI 补全的入库通道）。

用法（tools/data-refinery 目录下）：
    python src/answer_importer_cli.py --doc 答案文档.md                    # dry-run：定位+匹配+diff 报告
    python src/answer_importer_cli.py --doc 答案文档.md --apply            # 确认后写入（交互输 yes）
    python src/answer_importer_cli.py --doc 答案文档.md --paper-id 3       # 重名卷直接指定
    python src/answer_importer_cli.py --list-papers 关键词                 # 列候选试卷

语义：answer 无条件覆盖；explanation 文档留空则保留库内；type 仅标注时改；
answer_verified 置 1。幂等：同文档重跑 diff 为空不写。
"""

import argparse
import sys

import pymysql

from answer_importer import DiffEntry, PaperQuestionRow, build_diff, format_report, locate_paper, match_items
from answer_doc import parse_answer_doc


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="答案文档回写题库（dry-run 预览 / --apply 写入）")
    parser.add_argument("--doc", help="答案 Markdown 文档路径（# 试卷：标题 + ## 题号 + 答案/解析/题型）")
    parser.add_argument("--paper-id", type=int, default=None, help="直接指定 exam_papers.id（标题重名时用）")
    parser.add_argument("--apply", action="store_true", help="实际写入（默认 dry-run 只出报告）")
    parser.add_argument("--list-papers", metavar="KEYWORD", help="按关键词列候选试卷（title/id/题数），不导入")
    return parser.parse_args(argv)


def build_apply_sql(entry: DiffEntry, explanation: str | None) -> tuple[str, list]:
    """构造回写 UPDATE。占位符用 ?（单测断言可读），execute 前由调用方 replace 为 %s。
    type_change 为 None 时不改 type 列；explanation 走 COALESCE(NULLIF(?, ''), explanation)
    ——文档留空保留库内既有解析。"""
    sets = ["answer = ?", "explanation = COALESCE(NULLIF(?, ''), explanation)", "answer_verified = 1"]
    params: list = [entry.new_answer, explanation]
    if entry.type_change is not None:
        sets.append("type = ?")
        params.append(entry.type_change[1])
    sets.append("updated_at = CURRENT_TIMESTAMP(3)")
    params.append(entry.question_id)
    sql = f"UPDATE questions SET {', '.join(sets)} WHERE id = ?"
    return sql, params


def connect():
    from config import RefineryConfig  # 延迟导入：单测不触发 .env 加载

    cfg = RefineryConfig.from_env()
    return pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4")


def load_papers(conn, keyword: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT title, id, question_count FROM exam_papers WHERE title LIKE %s ORDER BY id",
            (f"%{keyword}%",),
        )
        return cur.fetchall()


def load_paper_questions(conn, paper_id: int) -> list[PaperQuestionRow]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT pq.question_no, pq.question_id, q.type, q.answer, q.explanation "
            "FROM paper_questions pq JOIN questions q ON q.id = pq.question_id "
            "WHERE pq.paper_id = %s ORDER BY pq.question_no",
            (paper_id,),
        )
        return [
            PaperQuestionRow(question_id=r[1], question_no=r[0], type=r[2], answer=r[3] or "", explanation=r[4])
            for r in cur.fetchall()
        ]


def main(argv=None):
    args = parse_args(argv)

    if args.list_papers:
        conn = connect()
        try:
            for title, pid, count in load_papers(conn, args.list_papers):
                print(f"  #{pid}\t{count} 题\t{title}")
        finally:
            conn.close()
        return 0

    if not args.doc:
        print("错误：--doc 或 --list-papers 必填", file=sys.stderr)
        return 2

    doc = parse_answer_doc(open(args.doc, encoding="utf-8").read())
    conn = connect()
    try:
        paper_id = args.paper_id
        if paper_id is None:
            papers = [(t, i, c) for t, i, c in load_papers(conn, doc.title)]
            paper_id, candidates = locate_paper(doc.title, papers)
            if paper_id is None:
                print(f"试卷「{doc.title}」无法唯一定位，候选如下（用 --paper-id 指定）：")
                for t, i, c in candidates or papers:
                    print(f"  #{i}\t{c} 题\t{t}")
                return 2

        rows = load_paper_questions(conn, paper_id)
        m = match_items(doc.items, rows)
        diff = build_diff(m.matched)
        print(format_report(title=doc.title, paper_id=paper_id, diff=diff,
                            unmatched_doc=m.unmatched_doc, missing_rows=m.missing_rows))

        if not args.apply:
            print("\n（dry-run，未写入。确认无误后加 --apply 执行。）")
            return 0

        if diff:
            answer = input(f"确认写入 {len(diff)} 题到试卷 #{paper_id}？输入 yes 执行：").strip()
            if answer != "yes":
                print("已取消。")
                return 1
            diff_by_qid = {d.question_id: d for d in diff}
            written = 0
            with conn.cursor() as cur:
                for it, r in m.matched:
                    entry = diff_by_qid.get(r.question_id)
                    if entry is None:
                        continue  # 无变化（幂等）
                    sql, params = build_apply_sql(entry, it.explanation.strip() or None)
                    cur.execute(sql.replace("?", "%s"), params)
                    written += 1
            conn.commit()
            print(f"已写入 {written} 题（answer_verified=1）。")
        else:
            print("（无变化，未写入——幂等重跑。）")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
```

Run: `cd tools/data-refinery && pytest tests/test_answer_importer_cli.py -q`
Expected: PASS。

- [ ] **Step 3: 全量回归 + Commit**

Run: `cd tools/data-refinery && pytest -q`
Expected: 全绿（既有用例不回归）。

```bash
git add tools/data-refinery/src/answer_importer_cli.py tools/data-refinery/tests/test_answer_importer_cli.py
git commit -m "feat(data-refinery): answer_importer_cli 连库编排（定位/匹配/dry-run/--apply 回写）"
```

---

### Task 5: 文档同步

**Files:**
- Modify: `docs/data-refinery-使用手册.md`（新增 answer_importer 使用章节）
- Modify: `docs/data-refinery-管线总结与后续.md`（后续清单记录）

- [ ] **Step 1: 使用手册加章节**（增量 Edit，对齐文件内既有 CLI 章节格式；**勿整体重写**——memory 约定）：

```markdown
## answer_importer：答案文档回写题库

人工+AI 产出试卷答案后，经本工具回写 `questions.answer/explanation/type`。答案文档格式：

    # 试卷：2024 海淀 初三 模拟二
    ## 1
    答案：B
    解析：由顶点式 $y=(x-2)^2+3$ 可知顶点为 $(2,3)$……
    ## 17
    答案：解：设……所以 $x=2$。
    解析：考查一元二次方程的应用……
    题型：calculation

规则：每题必写「答案」；「解析」留空则保留库内既有解析；「题型」仅 short_answer/calculation 等归属需调整时写；公式用 `$...$` LaTeX；多行内容直接换行续写（空行断开）。

    python src/answer_importer_cli.py --doc 答案.md            # dry-run：报告将更新的题（旧->新 diff、未匹配题号、空答案缺口）
    python src/answer_importer_cli.py --doc 答案.md --apply    # 确认后写入（输 yes）
    python src/answer_importer_cli.py --list-papers 海淀       # 按关键词找卷（标题重名时用 --paper-id 指定）

回写语义：answer 无条件覆盖、explanation 不抹旧、type 按标注改、`answer_verified=1`（人工核验标记）。幂等：同文档重跑报告「无变化」不写。**首次导入先小批验证**：拿一份试卷的 2-3 题跑 dry-run 确认匹配无误再放量；全量导入前先 `mysqldump ... questions` 做快照。
```

- [ ] **Step 2: 管线总结文档**：后续待办区加记录「answer_importer 已建成（2026-09-09），存量 188 道空答案/451 道无解析待按卷补全」。

- [ ] **Step 3: Commit**

```bash
git add docs/data-refinery-使用手册.md docs/data-refinery-管线总结与后续.md
git commit -m "docs(data-refinery): answer_importer 使用手册与管线总结同步"
```

---

### Task 6: 真库端到端验证（小批先行）

- [ ] **Step 1: 列候选试卷**

```bash
cd tools/data-refinery && python src/answer_importer_cli.py --list-papers 模拟
```

Expected: 输出 `#id  题数  标题` 列表。

- [ ] **Step 2: 造一份 2-3 题的小文档 dry-run**

选一个 paper_id，取其 2-3 道题的题号：

```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT pq.question_no, q.id, q.type, SUBSTRING(q.content,1,50), q.answer FROM paper_questions pq JOIN questions q ON q.id=pq.question_id WHERE pq.paper_id=<id> ORDER BY pq.question_no LIMIT 3;"
```

按查到的题号写 `/tmp/test_answers.md`（含一个故意写错的题号 999 验证 unmatched 报告），跑：

```bash
python src/answer_importer_cli.py --doc /tmp/test_answers.md --paper-id <id>
```

Expected: 报告「将更新 N 题」+ 旧→新 diff + `#999 未找到` 提示；**未写入**（无 --apply）。

- [ ] **Step 3: --apply 写入并验证幂等**

```bash
python src/answer_importer_cli.py --doc /tmp/test_answers.md --paper-id <id> --apply   # 输 yes
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT id, type, answer_verified, SUBSTRING(answer,1,40), SUBSTRING(explanation,1,40) FROM questions WHERE id IN (<查到的题id>);"
python src/answer_importer_cli.py --doc /tmp/test_answers.md --paper-id <id>          # 幂等重跑
```

Expected: answer/explanation 已更新、`answer_verified=1`、type 按标注改写；重跑报告「无变化——幂等重跑」且不发 UPDATE。

- [ ] **Step 4: Commit（如有零星修正）**

```bash
git add -A tools/data-refinery && git commit -m "fix(data-refinery): answer_importer 真库联调修正"
```

---

## Self-Review 记录

- **Spec 覆盖**：§4.1 文档格式 → Task 2；§4.2 四步流程（定位→匹配→dry-run→回写）→ Task 3/4；「人工核验标记」→ Task 1；「先小批验证再放量」→ Task 5 手册 + Task 6 端到端；幂等重跑 → Task 3 diff 为空语义 + Task 6 Step 3 验证。
- **占位符扫描**：无 TBD/TODO；所有代码完整。
- **类型一致性**：`PaperQuestionRow`/`MatchResult`/`DiffEntry` 在 Task 3 定义、Task 4 消费；`build_apply_sql(entry, explanation)` 参数序与 Task 4 测试断言一致（answer, explanation, [type], question_id）。
- **已知风险**：① `answer_verified` 新列后 db_loader full-reload 的 INSERT 列清单需确认（Task 1 Step 1 已含检查步骤）；② 重名试卷定位依赖人工选择，`--list-papers` 提供通道；③ UPDATE 无自动回滚——全量导入前 mysqldump 快照已写入使用手册。
