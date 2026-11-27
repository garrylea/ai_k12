# 题解内嵌分段拆分与存量整理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 从题解的明确分段标题中拆出答案、思路和详解，并同时修复未来数据管线与存量 `questions` 数据。

**Architecture:** 新增无数据库依赖的共享解析器，先由答案块解析器归属题号，再把每个答案 fragment 拆成三个字段；extract、publish、图片物化与 db_loader 全程透传 `approach`。存量 CLI 复用同一解析器，在单事务中备份、追加合并、写入并复查。

**Tech Stack:** Python 3、pytest、PyMySQL、Pydantic、Markdown/JSONL 管线

## Global Constraints

- 映射固定为：`答案 / 正确答案 / 参考答案` → `answer`；`解析 / 分析 / 思路 / 解题思路` → `approach`；`详解 / 解答 / 点睛` → `explanation`。
- 裸 `解：`、`证明：`、`原式：` 不单独作为分段标题。
- 必须先按题号归属答案 fragment，再拆题解字段。
- 存量已有 `approach` / `explanation` 时，旧内容在前，新内容在后，以两个换行分隔。
- 已存在的新内容不重复追加。
- 存量整理保持 `answer_verified` 原值，不重算 `content_hash`。
- 疑似混入多道题答案的数据只报告并跳过，不猜测。
- 不新增数据库字段、迁移或触发器。
- 所有用户入口收敛为一条可复制命令；`--apply` 内完成预览、确认、备份、写入和复查。
- Python 目录只使用 `tools/data-refinery/src/`，不新增 `scripts/`。
- 组件以外的新增 Python 代码必须有纯函数单测；涉及 published 透传的字段必须有转换测试。

---

## File Structure

**Create**

- `tools/data-refinery/src/answer_sections.py`：共享的题解分段解析、合并与异常定义。
- `tools/data-refinery/src/normalize_embedded_answers_cli.py`：存量库扫描、报告、备份、事务写入和复查。
- `tools/data-refinery/tests/test_answer_sections.py`：共享解析器单测。
- `tools/data-refinery/tests/test_normalize_embedded_answers_cli.py`：存量计划、合并与 fake DB 测试。

**Modify**

- `tools/data-refinery/src/answer_blocks.py`：`AnswerFragment` 增加 `approach`、`explanation`。
- `tools/data-refinery/src/answer_region.py`：fragment 归属题号后调用共享解析器。
- `tools/data-refinery/src/question_splitter.py`：`RawQuestion` 增加 `approach`，分布三字段。
- `tools/data-refinery/src/question_extract.py`：extract JSONL 输出 `approach`。
- `tools/data-refinery/src/subject_strategies/generic.py`：返回已拆分的三字段。
- `tools/data-refinery/src/subject_strategies/chinese.py`：语文答案聚合后调用共享解析器。
- `tools/data-refinery/src/answer_extract_cli.py`：答案文档渲染 `思路：` 与 `解析：`。
- `tools/data-refinery/src/models.py`：`ExamQuestion` 保留 `approach`。
- `tools/data-refinery/src/image_rewrite.py`：物化 `approach` 图片。
- `tools/data-refinery/src/publish_cli.py`：页码清洗包含 `approach`。
- `tools/data-refinery/src/db_loader.py`：入库图片守卫检查 `approach`。
- `tools/data-refinery/tests/test_answer_blocks.py`、`test_question_splitter.py`、`test_answer_extract_cli.py`、`test_models.py`、`test_publish_cli.py`、`test_db_loader.py`：回归测试。
- `tools/data-refinery/README.md`、`docs/data-refinery-使用手册.md`、`docs/constraints/数据管线.md`、`docs/ai-core-changelog.md`：使用说明、硬约束和变更记录。

---

### Task 1: 共享题解分段解析器

**Files:**
- Create: `tools/data-refinery/src/answer_sections.py`
- Create: `tools/data-refinery/tests/test_answer_sections.py`

**Interfaces:**
- Produces: `AnswerSections(answer: str, approach: str, explanation: str, recognized: bool, issues: tuple[str, ...])`
- Produces: `split_answer_sections(text: str) -> AnswerSections`
- Produces: `merge_old_then_new(old: str | None, new: str | None) -> str | None`

- [x] **Step 1: Write the failing parser tests**

Create `tests/test_answer_sections.py`:

```python
import pytest

from answer_sections import merge_old_then_new, split_answer_sections


def test_splits_bracket_sections():
    got = split_answer_sections(
        "【答案】C\n"
        "【分析】先判断函数图象。\n"
        "【详解】由题意得到 y=x+1。\n"
        "【点睛】注意定义域。"
    )
    assert got.recognized is True
    assert got.answer == "C"
    assert got.approach == "先判断函数图象。"
    assert got.explanation == "由题意得到 y=x+1。\n\n注意定义域。"
    assert got.issues == ()


def test_splits_colon_sections_and_markdown():
    got = split_answer_sections(
        "- **答案：** B\n"
        "__解析__：先配方。\n"
        "**详解：** 完整过程如下。"
    )
    assert got.answer == "B"
    assert got.approach == "先配方。"
    assert got.explanation == "完整过程如下。"


def test_keeps_body_and_code_fence():
    got = split_answer_sections(
        "答案：\n"
        "```svg\n"
        "【分析】代码块内不是标题\n"
        "```\n"
        "详解：\n"
        "正文"
    )
    assert got.answer == "```svg\n【分析】代码块内不是标题\n```"
    assert got.explanation == "正文"


def test_without_heading_keeps_original_answer():
    text = "解：x=2"
    got = split_answer_sections(text)
    assert got.recognized is False
    assert got.answer == text
    assert got.approach == ""
    assert got.explanation == ""


def test_preamble_before_first_heading_stays_in_answer():
    got = split_answer_sections("C\n解析：因为……")
    assert got.answer == "C"
    assert got.approach == "因为……"


def test_missing_answer_body_falls_back_with_issue():
    got = split_answer_sections("【解析】只给了思路\n【详解】过程")
    assert got.answer == "【解析】只给了思路\n【详解】过程"
    assert "answer_body_missing" in got.issues


def test_multiple_answer_sections_are_ambiguous():
    got = split_answer_sections("答案：A\n解析：第一题\n答案：B")
    assert "multiple_answer_sections" in got.issues


def test_numbered_answer_heading_is_ambiguous():
    got = split_answer_sections("1. 答案：A\n解析：第一题")
    assert "numbered_answer_heading" in got.issues


def test_unclosed_fence_is_ambiguous():
    got = split_answer_sections("答案：C\n详解：\n```text\n未闭合")
    assert "unclosed_code_fence" in got.issues


def test_merges_old_first_and_new_after():
    assert merge_old_then_new("旧思路", "新思路") == "旧思路\n\n新思路"
    assert merge_old_then_new(None, "新思路") == "新思路"
    assert merge_old_then_new("旧思路", None) == "旧思路"
    assert merge_old_then_new("旧思路", "旧思路") == "旧思路"
```

- [x] **Step 2: Run the tests and verify failure**

Run:

```bash
cd tools/data-refinery
pytest tests/test_answer_sections.py -q
```

Expected: FAIL because `answer_sections` does not exist.

- [x] **Step 3: Implement the shared parser**

Create `src/answer_sections.py`:

```python
"""题解内嵌分段解析：把 答案/解析/详解 标题拆回独立字段。"""

import re
from dataclasses import dataclass


_LABELS = (
    "答案", "正确答案", "参考答案",
    "解析", "分析", "思路", "解题思路",
    "详解", "解答", "点睛",
)
_TARGET = {
    "答案": "answer", "正确答案": "answer", "参考答案": "answer",
    "解析": "approach", "分析": "approach",
    "思路": "approach", "解题思路": "approach",
    "详解": "explanation", "解答": "explanation", "点睛": "explanation",
}
_LABEL_ALT = "|".join(sorted(_LABELS, key=len, reverse=True))
_HEADING_RE = re.compile(
    r"^[ \t]*(?:#{1,6}[ \t]*)?(?:[-*+][ \t]+)?"
    r"(?:\*\*|__)?[ \t]*"
    rf"(?:(?:[【\[])[ \t]*(?P<bracket>{_LABEL_ALT})[ \t]*(?:[】\]])"
    rf"|(?P<plain>{_LABEL_ALT})[ \t]*(?:\*\*|__)?[ \t]*[:：])"
    r"[ \t]*(?:\*\*|__)?[ \t]*(?P<rest>.*)$",
    re.MULTILINE,
)
_NUMBERED_ANSWER_RE = re.compile(
    r"(?m)^[ \t]*\d{1,2}[ \t]*[.．][ \t]*答案[ \t]*[:：]"
)


@dataclass(frozen=True)
class AnswerSections:
    answer: str
    approach: str
    explanation: str
    recognized: bool
    issues: tuple[str, ...] = ()


def _join(parts: list[str]) -> str:
    return "\n\n".join(part.strip() for part in parts if part.strip())


def _fence_positions(text: str) -> list[int]:
    return [match.start() for match in re.finditer(r"(?m)^[ \t]*```", text)]


def _heading_matches(text: str):
    fences = _fence_positions(text)
    for match in _HEADING_RE.finditer(text):
        inside = sum(1 for pos in fences if pos < match.start()) % 2 == 1
        if not inside:
            yield match


def split_answer_sections(text: str) -> AnswerSections:
    raw = text or ""
    if len(_fence_positions(raw)) % 2:
        return AnswerSections(raw.strip(), "", "", True, ("unclosed_code_fence",))

    matches = list(_heading_matches(raw))
    if not matches:
        return AnswerSections(raw.strip(), "", "", False)

    issues: list[str] = []
    if _NUMBERED_ANSWER_RE.search(raw):
        issues.append("numbered_answer_heading")

    answer_parts: list[str] = []
    approach_parts: list[str] = []
    explanation_parts: list[str] = []
    preamble = raw[:matches[0].start()].strip()
    if preamble:
        answer_parts.append(preamble)

    answer_headings = 0
    for index, match in enumerate(matches):
        label = match.group("bracket") or match.group("plain")
        target = _TARGET[label]
        end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
        body = (match.group("rest") + raw[match.end():end]).strip()
        if target == "answer":
            answer_headings += 1
            if body:
                answer_parts.append(body)
        elif target == "approach" and body:
            approach_parts.append(body)
        elif target == "explanation" and body:
            explanation_parts.append(body)

    if answer_headings > 1:
        issues.append("multiple_answer_sections")

    answer = _join(answer_parts)
    if not answer:
        issues.append("answer_body_missing")
        answer = raw.strip()

    return AnswerSections(
        answer=answer,
        approach=_join(approach_parts),
        explanation=_join(explanation_parts),
        recognized=True,
        issues=tuple(issues),
    )


def merge_old_then_new(old: str | None, new: str | None) -> str | None:
    left = (old or "").strip()
    right = (new or "").strip()
    if not right or right in left:
        return left or None
    if not left:
        return right
    return f"{left}\n\n{right}"
```

- [x] **Step 4: Run parser tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_answer_sections.py -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tools/data-refinery/src/answer_sections.py tools/data-refinery/tests/test_answer_sections.py
git commit -m "feat(refinery): parse embedded answer sections"
```

---

### Task 2: 答案块产出三字段 fragment

**Files:**
- Modify: `tools/data-refinery/src/answer_blocks.py`
- Modify: `tools/data-refinery/src/answer_region.py`
- Test: `tools/data-refinery/tests/test_answer_blocks.py`

**Interfaces:**
- Consumes: `split_answer_sections(text: str) -> AnswerSections`
- Produces: `AnswerFragment.approach: str`、`AnswerFragment.explanation: str`
- Produces: `parse_answer_region(...).fragments[*]` 中 `text/approach/explanation` 已拆分

- [x] **Step 1: Add failing answer-region tests**

Append to `tests/test_answer_blocks.py`:

```python
def test_answer_region_splits_embedded_sections_after_number_assignment():
    result = parse_answer_region(
        [
            AnswerLine(1, "1. 【答案】C"),
            AnswerLine(2, "【分析】先配方。"),
            AnswerLine(3, "【详解】因此顶点为 (1, 2)。"),
            AnswerLine(4, "2. B"),
        ],
        [AnswerQuestion(no=1, group_id=None), AnswerQuestion(no=2, group_id=None)],
        first_line_no=1,
    )
    q1 = next(fragment for fragment in result.fragments if fragment.question_no == 1)
    assert q1.text == "C"
    assert q1.approach == "先配方。"
    assert q1.explanation == "因此顶点为 (1, 2)。"
    assert not any(issue.question_no == 1 for issue in result.issues)


def test_answer_region_skips_multiquestion_contamination():
    result = parse_answer_region(
        [AnswerLine(1, "1. 答案：A\n解析：第一题\n2. 答案：B")],
        [AnswerQuestion(no=1, group_id=None)],
        first_line_no=1,
    )
    assert not any(fragment.question_no == 1 for fragment in result.fragments)
    assert any(issue.code == "answer_sections_ambiguous" for issue in result.issues)
```

Add imports if absent:

```python
from answer_blocks import AnswerLine, AnswerQuestion
```

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
cd tools/data-refinery
pytest tests/test_answer_blocks.py -q
```

Expected: FAIL because `AnswerFragment` has no `approach`.

- [x] **Step 3: Extend fragment and normalize parsed fragments**

In `src/answer_blocks.py`, extend `AnswerFragment`:

```python
@dataclass(frozen=True)
class AnswerFragment:
    question_no: int
    text: str
    block_kind: str
    line_start: int
    line_end: int
    approach: str = ""
    explanation: str = ""
```

In `src/answer_region.py`, import:

```python
from dataclasses import replace
from answer_sections import split_answer_sections
```

Add helper:

```python
def _split_fragment(
    fragment: AnswerFragment,
) -> tuple[AnswerFragment | None, list[AnswerIssue]]:
    sections = split_answer_sections(fragment.text)
    if sections.issues:
        return None, [AnswerIssue(
            code="answer_sections_ambiguous",
            severity="error",
            message=(
                f"第 {fragment.question_no} 题题解分段无法安全拆分："
                f"{', '.join(sections.issues)}"
            ),
            question_no=fragment.question_no,
            line_start=fragment.line_start,
            line_end=fragment.line_end,
            excerpt=fragment.text[:200],
        )]
    return replace(
        fragment,
        text=sections.answer,
        approach=sections.approach,
        explanation=sections.explanation,
    ), []
```

In the fragment loop inside `parse_answer_region`, before duplicate/assignment:

```python
for fragment in block_fragments:
    normalized, split_issues = _split_fragment(fragment)
    issues.extend(split_issues)
    if normalized is None:
        continue
    fragment = normalized
    if fragment.question_no in assigned:
        issues.append(_duplicate_issue(fragment))
        continue
    assigned[fragment.question_no] = fragment.text
    fragments.append(fragment)
```

- [x] **Step 4: Run answer block tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_answer_blocks.py tests/test_answer_sections.py -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tools/data-refinery/src/answer_blocks.py tools/data-refinery/src/answer_region.py tools/data-refinery/tests/test_answer_blocks.py
git commit -m "feat(refinery): carry approach and explanation in answer fragments"
```

---

### Task 3: RawQuestion 与 JSONL extract 透传

**Files:**
- Modify: `tools/data-refinery/src/question_splitter.py`
- Modify: `tools/data-refinery/src/question_extract.py`
- Modify: `tools/data-refinery/src/subject_strategies/generic.py`
- Test: `tools/data-refinery/tests/test_question_splitter.py`
- Test: `tools/data-refinery/tests/test_answer_extract_cli.py`

**Interfaces:**
- Consumes: `AnswerFragment.text/approach/explanation`
- Produces: `RawQuestion.approach: str = ""`
- Produces: `ExtractedAnswer.answer/approach/explanation`
- Produces: extract JSONL key `approach`

- [x] **Step 1: Write failing splitter and generic tests**

Append to `tests/test_question_splitter.py`:

```python
def test_split_page_result_distributes_answer_sections():
    from pathlib import Path
    from question_splitter import split_page_result
    from subject_strategies import get_strategy

    text = """1. 已知函数

2. 求值

# 参考答案

1. 【答案】C
【分析】先观察图象。
【详解】所以选 C。

2. B
"""
    result = split_page_result(
        text,
        Path("数学/初中/first/2025/test.md"),
        strategy=get_strategy("math"),
    )
    q1 = next(q for q in result.questions if q.group_order == 1)
    assert q1.answer == "C"
    assert q1.approach == "先观察图象。"
    assert q1.explanation == "所以选 C。"
```

Append to `tests/test_answer_extract_cli.py`:

```python
def test_generic_extract_answers_carries_approach_and_explanation():
    text = """1. 已知函数

# 参考答案

1. 【答案】C
【分析】先观察图象。
【详解】所以选 C。
"""
    answers = get_strategy("math").extract_answers(
        text,
        Path("数学/初中/first/2025/test.md"),
    )
    q1 = next(item for item in answers if item.no == 1)
    assert q1.answer == "C"
    assert q1.approach == "先观察图象。"
    assert q1.explanation == "所以选 C。"
```

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
cd tools/data-refinery
pytest tests/test_question_splitter.py::test_split_page_result_distributes_answer_sections tests/test_answer_extract_cli.py::test_generic_extract_answers_carries_approach_and_explanation -q
```

Expected: FAIL because `RawQuestion` has no `approach` and generic extraction discards it.

- [x] **Step 3: Add approach to RawQuestion and extraction**

In `RawQuestion`:

```python
answer: str = ""
approach: str = ""
explanation: str | None = None
```

In `split_page_result`, replace the fragment assignment block with:

```python
by_number: dict[int, list] = {}
for fragment in answer_result.fragments:
    by_number.setdefault(fragment.question_no, []).append(fragment)
for question in questions:
    parts = by_number.get(question.group_order, [])
    question.answer = "\n".join(
        fragment.text for fragment in parts if fragment.text
    )
    question.approach = "\n\n".join(
        fragment.approach for fragment in parts if fragment.approach
    )
    question.explanation = (
        "\n\n".join(
            fragment.explanation for fragment in parts if fragment.explanation
        )
        or None
    )
```

In `question_extract`, add:

```python
"approach": q.approach,
```

next to `"explanation": q.explanation`.

In `generic.extract_generic_answers`, construct:

```python
answers.append(ExtractedAnswer(
    no=question.group_order,
    answer=(question.answer or "").strip(),
    approach=(question.approach or "").strip(),
    explanation=(question.explanation or "").strip(),
    issues=[detail["message"] for detail in details],
    issue_details=details,
))
```

- [x] **Step 4: Run the focused tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_question_splitter.py::test_split_page_result_distributes_answer_sections tests/test_answer_extract_cli.py::test_generic_extract_answers_carries_approach_and_explanation -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tools/data-refinery/src/question_splitter.py tools/data-refinery/src/question_extract.py tools/data-refinery/src/subject_strategies/generic.py tools/data-refinery/tests/test_question_splitter.py tools/data-refinery/tests/test_answer_extract_cli.py
git commit -m "feat(refinery): propagate split approach through extraction"
```

---

### Task 4: 语文策略与规范答案文档

**Files:**
- Modify: `tools/data-refinery/src/subject_strategies/chinese.py`
- Modify: `tools/data-refinery/src/answer_extract_cli.py`
- Test: `tools/data-refinery/tests/subject_strategies/test_chinese_answers.py`
- Test: `tools/data-refinery/tests/test_answer_extract_cli.py`

**Interfaces:**
- Consumes: `split_answer_sections()`、`merge_old_then_new()`
- Produces: 语文 `ExtractedAnswer.approach/explanation`
- Produces: answer doc 的 `思路：` 与 `解析：`

- [x] **Step 1: Write failing tests**

Append to `tests/subject_strategies/test_chinese_answers.py`:

```python
def test_chinese_answer_headings_are_split_before_scoring_notes():
    from pathlib import Path
    from subject_strategies.chinese import extract_chinese_answers

    text = """# 语文试卷答案及评分参考

1.【答案】C（2 分）
【分析】先看上下文。
【详解】结合语境可知 C。
"""
    got = extract_chinese_answers(text, Path("语文/初中/first/2025/test.md"))
    q1 = next(item for item in got if item.no == 1)
    assert q1.answer == "C"
    assert q1.approach == "先看上下文。"
    assert "结合语境可知 C。" in q1.explanation
    assert "2 分" in q1.explanation
```

Append to `tests/test_answer_extract_cli.py`:

```python
def test_render_doc_includes_approach_and_explanation_fields():
    doc = render_answer_doc(
        "卷",
        [ExtractedAnswer(
            no=1,
            answer="C",
            approach="先观察图象。",
            explanation="所以选 C。",
        )],
    )
    parsed = parse_answer_doc(doc)
    item = parsed.items[0]
    assert item.answer == "C"
    assert item.approach == "先观察图象。"
    assert item.explanation == "所以选 C。"
```

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
cd tools/data-refinery
pytest tests/subject_strategies/test_chinese_answers.py::test_chinese_answer_headings_are_split_before_scoring_notes tests/test_answer_extract_cli.py::test_render_doc_includes_approach_and_explanation_fields -q
```

Expected: FAIL because Chinese extraction and document rendering do not populate `approach`.

- [x] **Step 3: Integrate the shared parser**

In `chinese.py`, import:

```python
from answer_sections import merge_old_then_new, split_answer_sections
```

In `extract_chinese_answers`, replace raw scoring extraction with:

```python
sections = split_answer_sections(raw_answer)
if sections.issues:
    results.append(ExtractedAnswer(
        no=no,
        answer=raw_answer,
        issues=[f"第 {no} 题题解分段无法安全拆分：{', '.join(sections.issues)}"],
    ))
    continue

answer, scoring_explanation = _extract_scoring_notes(sections.answer)
explanation = merge_old_then_new(scoring_explanation, sections.explanation) or ""
issues: list[str] = []
if not answer:
    issues.append(f"第 {no} 题剥离评分说明后答案为空，已保留原文")
results.append(ExtractedAnswer(
    no=no,
    answer=answer,
    approach=sections.approach,
    explanation=explanation,
    issues=issues,
))
```

In `render_answer_doc`, after the answer lines, add:

```python
if (item.approach or "").strip():
    parts.append("思路：" + item.approach.strip().split("\n")[0])
    for ln in item.approach.strip().split("\n")[1:]:
        if ln.strip():
            parts.append(ln.rstrip())
```

Keep the existing `解析：` block sourced from `item.explanation`.

- [x] **Step 4: Run focused tests**

Run:

```bash
cd tools/data-refinery
pytest tests/subject_strategies/test_chinese_answers.py tests/test_answer_extract_cli.py -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tools/data-refinery/src/subject_strategies/chinese.py tools/data-refinery/src/answer_extract_cli.py tools/data-refinery/tests/subject_strategies/test_chinese_answers.py tools/data-refinery/tests/test_answer_extract_cli.py
git commit -m "feat(refinery): split Chinese embedded answer sections"
```

---

### Task 5: publish、图片物化与 db_loader 保留 approach

**Files:**
- Modify: `tools/data-refinery/src/models.py`
- Modify: `tools/data-refinery/src/image_rewrite.py`
- Modify: `tools/data-refinery/src/publish_cli.py`
- Modify: `tools/data-refinery/src/db_loader.py`
- Test: `tools/data-refinery/tests/test_models.py`
- Test: `tools/data-refinery/tests/test_publish_cli.py`
- Test: `tools/data-refinery/tests/test_db_loader.py`

**Interfaces:**
- Produces: `ExamQuestion.approach: str | None`
- Produces: `rewrite_fields(...)` 返回 `(content, answer, approach, explanation, material_text, options, materialized)`
- Produces: db_loader 拒绝未物化 `approach` 图片

- [x] **Step 1: Write failing propagation tests**

Append to `tests/test_models.py`:

```python
def test_exam_question_keeps_approach_through_model_dump():
    q = ExamQuestion(
        subject_id="math",
        type="choice",
        difficulty=2,
        content="题干",
        answer="C",
        approach="先判断函数类型。",
        explanation="完整过程。",
    )
    dumped = q.model_dump(mode="json")
    assert dumped["approach"] == "先判断函数类型。"
```

Append to `tests/test_publish_cli.py`:

```python
def test_publish_keeps_approach_and_materializes_image(tmp_path):
    out = tmp_path / "out"
    ext = out / "extracted" / "数学" / "试卷"
    ext.mkdir(parents=True)
    image = out / "md" / "数学" / "试卷" / "images" / "a.jpg"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"fake-image")
    row = {
        "subject_id": "math",
        "type": "choice",
        "difficulty": 2,
        "content": "题干",
        "answer": "C",
        "approach": "先看图 ![](images/a.jpg)",
        "explanation": "详细过程",
    }
    (ext / "试卷.jsonl").write_text(
        json.dumps(row, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    with patch("publish_cli.RefineryConfig") as mock_config:
        mock_config.from_env.return_value = MagicMock(output_dir=out)
        main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

    got = json.loads(
        (out / "published" / "数学" / "试卷" / "试卷.jsonl")
        .read_text(encoding="utf-8")
        .strip()
    )
    assert got["approach"].startswith("先看图 ![](questions/math/")
    assert "explanation" in got and got["explanation"] == "详细过程"
```

Append to `tests/test_db_loader.py`:

```python
def test_materialized_image_guard_checks_approach():
    with pytest.raises(ValueError, match="图片引用未物化"):
        assert_materialized_images(approach="![](images/approach.jpg)")
```

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
cd tools/data-refinery
pytest tests/test_models.py::test_exam_question_keeps_approach_through_model_dump tests/test_publish_cli.py::test_publish_keeps_approach_and_materializes_image tests/test_db_loader.py::test_materialized_image_guard_checks_approach -q
```

Expected: FAIL because the model and rewrite chain drop or ignore `approach`.

- [x] **Step 3: Implement model and rewrite propagation**

In `models.ExamQuestion`:

```python
approach: str | None = None
```

In `image_rewrite.rewrite_fields`, add parameter:

```python
approach: str | None,
```

Rewrite `approach` before `explanation`, with asset names:

```python
new_approach = approach
if new_approach:
    new_approach, m, _ = _rewrite_text(
        new_approach,
        md_images_dir,
        asset_store,
        asset_prefix,
        lambda i, ext: f"approach_{i:02d}{ext}",
        strict=strict,
    )
    materialized += m
```

Change return and docstring to:

```python
return (
    new_content, new_answer, new_approach, new_exp,
    new_material, options, materialized,
)
```

In `rewrite_question`, assign:

```python
(
    q.content,
    q.answer,
    q.approach,
    q.explanation,
    q.material_text,
    q.options,
    materialized,
) = rewrite_fields(
    content=q.content,
    answer=q.answer,
    approach=q.approach,
    explanation=q.explanation,
    material_text=q.material_text,
    options=q.options,
    md_images_dir=md_images_dir,
    asset_store=asset_store,
    asset_prefix=asset_prefix,
    strict=strict,
)
```

Update every direct `rewrite_fields(...)` test/call to pass `approach=...` and unpack seven values.

In `publish_cli._QUESTION_TEXT_FIELDS` add:

```python
"approach",
```

In `db_loader.assert_materialized_images`, add parameter and text input:

```python
def assert_materialized_images(*, content=None, answer=None, approach=None,
                               explanation=None, material_text=None, options=None,
                               context: str = "") -> None:
    ...
    texts = [
        content or "", answer or "", approach or "",
        explanation or "", material_text or "",
    ]
```

At the `load_questions` call site pass:

```python
approach=q.get("approach"),
```

- [x] **Step 4: Run the focused tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_models.py tests/test_publish_cli.py tests/test_db_loader.py -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tools/data-refinery/src/models.py tools/data-refinery/src/image_rewrite.py tools/data-refinery/src/publish_cli.py tools/data-refinery/src/db_loader.py tools/data-refinery/tests/test_models.py tools/data-refinery/tests/test_publish_cli.py tools/data-refinery/tests/test_db_loader.py
git commit -m "feat(refinery): preserve approach through publish and load"
```

---

### Task 6: 存量整理 CLI

**Files:**
- Create: `tools/data-refinery/src/normalize_embedded_answers_cli.py`
- Create: `tools/data-refinery/tests/test_normalize_embedded_answers_cli.py`

**Interfaces:**
- Consumes: `split_answer_sections()`、`merge_old_then_new()`
- Produces: `CleanupRow(question_id, subject, type, answer, approach, explanation, answer_verified)`
- Produces: `CleanupChange(question_id, before: CleanupRow, after_answer: str, after_approach: str | None, after_explanation: str | None, added_approach: bool, added_explanation: bool)`
- Produces: `build_cleanup_changes(rows: list[CleanupRow]) -> tuple[list[CleanupChange], list[tuple[CleanupRow, list[str]]]]`
- CLI: `python3 src/normalize_embedded_answers_cli.py --apply`

- [x] **Step 1: Write failing pure-function and fake-DB tests**

Create `tests/test_normalize_embedded_answers_cli.py`:

```python
import json
from pathlib import Path

import pytest

import normalize_embedded_answers_cli as cli


def _row(qid=1, answer="答案：C\n解析：先判断。\n详解：完整过程。"):
    return cli.CleanupRow(
        question_id=qid,
        subject="math",
        type_="choice",
        answer=answer,
        approach=None,
        explanation=None,
        answer_verified=0,
    )


def test_build_changes_splits_and_appends_old_first():
    row = cli.CleanupRow(
        question_id=1,
        subject="math",
        type_="choice",
        answer="答案：C\n解析：新思路\n详解：新详解",
        approach="旧思路",
        explanation="旧详解",
        answer_verified=1,
    )
    changes, skipped = cli.build_cleanup_changes([row])
    assert skipped == []
    change = changes[0]
    assert change.after_answer == "C"
    assert change.after_approach == "旧思路\n\n新思路"
    assert change.after_explanation == "旧详解\n\n新详解"
    assert change.before.answer_verified == 1


def test_build_changes_skips_ambiguous_and_plain_text():
    rows = [
        _row(1, "答案：A\n解析：第一题\n答案：B"),
        _row(2, "解：x=2"),
    ]
    changes, skipped = cli.build_cleanup_changes(rows)
    assert changes == []
    assert skipped[0][0].question_id == 1
    assert "multiple_answer_sections" in skipped[0][1]
    assert len(skipped) == 1


class FakeCursor:
    def __init__(self, updates=None):
        self.updates = updates or {}
        self.executed = []
        self.rowcount = 1
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if sql.lstrip().startswith("SELECT"):
            self._rows = []
        elif sql.lstrip().startswith("UPDATE"):
            self.rowcount = self.updates.get(params[-1], 1)

    def fetchall(self):
        return self._rows


class FakeConn:
    def __init__(self):
        self.cursor_obj = FakeCursor()
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return self.cursor_obj

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


def test_apply_writes_backup_before_transaction(tmp_path, monkeypatch):
    conn = FakeConn()
    changes, _ = cli.build_cleanup_changes([_row()])
    backup = tmp_path / "backup.jsonl"
    cli.write_backup(backup, changes)
    cli.apply_changes(conn, changes)
    assert backup.exists()
    assert json.loads(backup.read_text(encoding="utf-8"))["question_id"] == 1
    assert conn.committed is True


def test_apply_rolls_back_on_concurrent_change(tmp_path):
    conn = FakeConn()
    conn.cursor_obj.updates = {1: 0}
    changes, _ = cli.build_cleanup_changes([_row()])
    with pytest.raises(cli.ConcurrentChangeError):
        cli.apply_changes(conn, changes)
    assert conn.rolled_back is True
```

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
cd tools/data-refinery
pytest tests/test_normalize_embedded_answers_cli.py -q
```

Expected: FAIL because the CLI module does not exist.

- [x] **Step 3: Implement pure planning and DB write functions**

Create `src/normalize_embedded_answers_cli.py` with these public definitions and behavior:

```python
@dataclass(frozen=True)
class CleanupRow:
    question_id: int
    subject: str
    type_: str
    answer: str
    approach: str | None
    explanation: str | None
    answer_verified: int


@dataclass(frozen=True)
class CleanupChange:
    question_id: int
    before: CleanupRow
    after_answer: str
    after_approach: str | None
    after_explanation: str | None
    added_approach: bool
    added_explanation: bool


class ConcurrentChangeError(RuntimeError):
    pass
```

`build_cleanup_changes`:

```python
def build_cleanup_changes(rows: list[CleanupRow]):
    changes: list[CleanupChange] = []
    skipped: list[tuple[CleanupRow, list[str]]] = []
    for row in rows:
        sections = split_answer_sections(row.answer)
        if not sections.recognized:
            continue
        if sections.issues:
            skipped.append((row, list(sections.issues)))
            continue
        answer = sections.answer.strip()
        if not answer:
            skipped.append((row, ["answer_empty_after_split"]))
            continue
        approach = merge_old_then_new(row.approach, sections.approach)
        explanation = merge_old_then_new(row.explanation, sections.explanation)
        if (
            answer == (row.answer or "").strip()
            and approach == row.approach
            and explanation == row.explanation
        ):
            continue
        changes.append(CleanupChange(
            question_id=row.question_id,
            before=row,
            after_answer=answer,
            after_approach=approach,
            after_explanation=explanation,
            added_approach=bool(
                sections.approach.strip()
                and sections.approach.strip() not in (row.approach or "")
            ),
            added_explanation=bool(
                sections.explanation.strip()
                and sections.explanation.strip() not in (row.explanation or "")
            ),
        ))
    return changes, skipped
```

`write_backup` writes one JSON object per change:

```python
{
    "question_id": change.before.question_id,
    "subject": change.before.subject,
    "type": change.before.type_,
    "answer": change.before.answer,
    "approach": change.before.approach,
    "explanation": change.before.explanation,
    "answer_verified": change.before.answer_verified,
}
```

`apply_changes`:

```python
def apply_changes(conn, changes: list[CleanupChange]) -> None:
    try:
        with conn.cursor() as cur:
            for change in changes:
                cur.execute(
                    "UPDATE questions SET answer=%s, approach=%s, explanation=%s "
                    "WHERE id=%s AND answer=%s "
                    "AND COALESCE(approach,'')=COALESCE(%s,'') "
                    "AND COALESCE(explanation,'')=COALESCE(%s,'') "
                    "AND answer_verified=%s",
                    (
                        change.after_answer,
                        change.after_approach,
                        change.after_explanation,
                        change.question_id,
                        change.before.answer,
                        change.before.approach,
                        change.before.explanation,
                        change.before.answer_verified,
                    ),
                )
                if cur.rowcount != 1:
                    raise ConcurrentChangeError(
                        f"questions#{change.question_id} 在扫描后被修改"
                    )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
```

`load_rows` queries:

```sql
SELECT q.id, s.code, q.type, q.answer, q.approach, q.explanation, q.answer_verified
FROM questions q
JOIN subjects s ON s.id = q.subject_id
WHERE q.answer REGEXP '【[^】]*(答案|解析|分析|思路|详解|解答|点睛)[^】]*】|(答案|正确答案|参考答案|解析|分析|思路|解题思路|详解|解答|点睛)[[:space:]]*[:：]'
ORDER BY q.id
```

`verify_changes` re-queries affected ids and compares exact three fields plus unchanged `answer_verified`.

The main path:

1. Parse `--apply`、`--yes`、`--limit`（默认 5000）。
2. Load rows and build changes/skips.
3. Print subject counts, change counts, added-field counts, first 50 details, and every skip.
4. `--apply` without `--yes` prompts `yes`.
5. Create `output/backups/embedded_answers_<UTC timestamp>.jsonl`.
6. Write backup before opening transaction.
7. Apply and verify.
8. Return 0 on success, 1 on user cancel/concurrency, 2 on invalid input.

- [x] **Step 4: Add CLI argument and report tests**

Append to `tests/test_normalize_embedded_answers_cli.py`:

```python
def test_preview_reports_merge_and_never_writes(monkeypatch, capsys):
    conn = FakeConn()
    monkeypatch.setattr(cli, "connect", lambda: conn)
    monkeypatch.setattr(cli, "load_rows", lambda _conn: [_row()])

    rc = cli.main([])

    out = capsys.readouterr().out
    assert rc == 0
    assert "旧字段后追加" in out
    assert "异常跳过" in out
    assert conn.committed is False
    assert not any(
        sql.lstrip().startswith("UPDATE")
        for sql, _params in conn.cursor_obj.executed
    )


def test_help_documents_apply_flag(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])
    assert exc.value.code == 0
    assert "--apply" in capsys.readouterr().out
```

Run:

```bash
cd tools/data-refinery
pytest tests/test_normalize_embedded_answers_cli.py -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tools/data-refinery/src/normalize_embedded_answers_cli.py tools/data-refinery/tests/test_normalize_embedded_answers_cli.py
git commit -m "feat(refinery): add embedded answer cleanup CLI"
```

---

### Task 7: 全量回归、真实库整理与文档

**Files:**
- Modify: `tools/data-refinery/README.md`
- Modify: `docs/data-refinery-使用手册.md`
- Modify: `docs/constraints/数据管线.md`
- Modify: `docs/ai-core-changelog.md`

**Interfaces:**
- Consumes: completed parser, pipeline propagation, cleanup CLI
- Produces: documented one-command workflow and real database cleanup evidence

- [x] **Step 1: Run all data-refinery tests**

Run:

```bash
cd tools/data-refinery
pytest -q
```

Expected: all tests PASS.

- [x] **Step 2: Run the cleanup preview against the real database**

Run:

```bash
cd tools/data-refinery
python3 src/normalize_embedded_answers_cli.py
```

Expected:

- candidate counts match the current mixed-answer scan;
- ambiguous multi-question rows are listed and skipped;
- no DB writes occur.

- [x] **Step 3: Inspect representative diffs before applying**

Inspect at least:

- one math `【答案】【分析】【详解】` row;
- one Chinese `答案：/分析/解答` row;
- one row with existing `approach` or `explanation`, confirming old content is first.

If any sampled split is wrong, add the exact fixture and regression test under `tests/test_answer_sections.py` or `tests/test_normalize_embedded_answers_cli.py` before proceeding.

- [x] **Step 4: Apply the cleanup**

Run the single user-facing command:

```bash
cd tools/data-refinery
python3 src/normalize_embedded_answers_cli.py --apply
```

Enter `yes` after reviewing the report.

Expected:

- backup file path is printed;
- transaction commits;
- post-write verification passes;
- rerunning preview returns zero changes for already cleaned rows.

- [x] **Step 5: Verify database invariants**

Run read-only SQL:

```sql
SELECT id, answer, approach, explanation, answer_verified
FROM questions
WHERE answer REGEXP '【(答案|解析|分析|详解|解答|点睛)】'
ORDER BY id;
```

Expected:

- returned ids equal the CLI’s skipped ids, not any successfully changed id;
- every returned `answer_verified` is unchanged for rows that were intentionally skipped;
- the CLI’s own post-write verification confirms old `approach` / `explanation` content appears before appended new content.

- [x] **Step 6: Update docs**

Add to `tools/data-refinery/README.md`:

- shared section mapping;
- `normalize_embedded_answers_cli.py` command and backup/verification behavior.

Add to `docs/data-refinery-使用手册.md`:

- one-command preview/confirm/apply workflow;
- report and backup path;
- old-before-new merge rule.

Add to `docs/constraints/数据管线.md`:

```text
**题解内嵌分段（2026-11-27）**：答案块必须先按题号归属，再由
`answer_sections.py` 拆分。`答案/正确答案/参考答案` → answer，
`解析/分析/思路/解题思路` → approach，
`详解/解答/点睛` → explanation。裸 `解：/证明：` 不拆。
存量整理旧字段在前、新内容追加在后；answer_verified 保持原值。
extract/publish/db_loader 必须透传 approach，图片走 approach_NN 物化。
```

Add to `docs/ai-core-changelog.md`:

- implementation date;
- affected subjects/counts;
- backup path;
- verification results;
- any ambiguous rows intentionally skipped.

- [x] **Step 7: Run docs diff check and commit**

Run:

```bash
git diff --check
cd tools/data-refinery
pytest -q
```

Expected: PASS and no whitespace errors.

Commit:

```bash
git add tools/data-refinery/README.md docs/data-refinery-使用手册.md docs/constraints/数据管线.md docs/ai-core-changelog.md
git commit -m "docs(refinery): document embedded answer splitting"
```

---

## Self-Review

- Spec §2 字段口径：Task 1 的正则和目标映射覆盖全部标题。
- Spec §4 共享解析器与异常：Task 1 实现，Task 2 把 issue 转入答案区报告。
- Spec §5 合并语义：Task 1 提供 `merge_old_then_new`，Task 6 落实备份与事务。
- Spec §6.1 答案块层：Task 2 覆盖。
- Spec §6.2 RawQuestion 与 extract：Task 3 覆盖。
- Spec §6.3 语文：Task 4 覆盖。
- Spec §6.4 答案文档：Task 4 覆盖。
- Spec §6.5 publish / db_loader：Task 5 覆盖。
- Spec §7 存量 CLI：Task 6 覆盖。
- Spec §8 可观测性：Task 6 报告，Task 7 真实库执行。
- Spec §9 测试：Task 1-6 分别覆盖纯函数、管线、CLI、fake DB。
- Spec §10 文档同步：Task 7 覆盖。
- Spec §11 验收：Task 7 覆盖自动化测试、真实库预览、写入和复查。
- 类型一致性：`AnswerSections` 三字段；`AnswerFragment.text/approach/explanation`；`RawQuestion.answer/approach/explanation`；`ExtractedAnswer.answer/approach/explanation`；CLI `CleanupRow/CleanupChange` 名称前后一致。
