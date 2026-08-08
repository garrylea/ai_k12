# card_splitter 同行题拆行 + db_loader content 重组 + 前端删除 step 2.5 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 practice 卡同行题在管线阶段拆成独立行，db_loader 用 LLM 标注的 questions[].text 重组 content 兜底，前端删除运行时拆题正则

**Architecture:** 三处变更分布在数据管线（Python card_splitter + db_loader）和前端（TypeScript CourseDetailPage）。card_splitter 新增 `_split_inline_questions` 在 `_split_paragraphs` 内按 `(N)` 边界拆同行题；db_loader 的 `_insert_card` 对 practice 卡用已验证的 questions 重组 content 为每题独立段；前端删除 `preprocessContent` step 2.5 的正则替换

**Tech Stack:** Python 3 (pytest), TypeScript/React (Vite)

**Spec:** `docs/superpowers/specs/2026-08-06-practice-answer-judging-design.md` §5.0, §5.2, §6.1
**设计文档:** `docs/K12智学系统-Card内容生成与渲染设计文档.md` §9.4

---

### Task 1: card_splitter 新增 `_split_inline_questions`（同行题拆行）

**Files:**
- Modify: `tools/data-refinery/src/card_splitter.py` — 新增 `_split_inline_questions`，修改 `_split_paragraphs`
- Modify: `tools/data-refinery/tests/test_card_splitter.py` — 新增单测

- [ ] **Step 1: 在 card_splitter.py 新增正则和 `_split_inline_questions` 函数**

在 `_split_paragraphs` 函数上方（约 line 65）插入：

```python
# 同行题拆行正则：(N) 前必须是句末标点或分号，排除正文续接如"与(2)类似"
_INLINE_Q_SPLIT_RE = re.compile(r'(?<=[；;])\s*(?=\([1-9]\d?\))|(?<=[。！？])\s*(?=\([1-9]\d?\))')


def _split_inline_questions(paragraph: str) -> list[str]:
    """将同一段内的同行题按 (N) 边界拆成独立段。

    正则覆盖 ; 和 。！？后的 (N)，防「与(2)类似」等正文括号误拆。
    无拆分点时返回原段落（单元素列表）。
    """
    parts = _INLINE_Q_SPLIT_RE.split(paragraph)
    return [p.strip() for p in parts if p.strip()]
```

- [ ] **Step 2: 修改 `_split_paragraphs`，调用 `_split_inline_questions`**

替换现有的 `_split_paragraphs`（lines 65-68）：

```python
def _split_paragraphs(text: str) -> list[str]:
    """按双换行拆分段落，再对每段做同行题拆行，过滤纯空行。"""
    parts = re.split(r"\n\n+", text)
    flat: list[str] = []
    for p in [p.strip() for p in parts if p.strip()]:
        inline_parts = _split_inline_questions(p)
        flat.extend(inline_parts)
    return flat
```

同时更新文件顶部的 import 处的函数引用说明（无需改 import，仅确保 `_split_inline_questions` 在 `_split_paragraphs` 之前定义）。

- [ ] **Step 3: 更新测试文件的 import**

在 `tools/data-refinery/tests/test_card_splitter.py` 的 import 行（line 4）加入 `_split_inline_questions`：

```python
from card_splitter import split_page, _count_text_chars, _CHARS_PER_LINE
from card_splitter import _split_paragraphs, _make_bundles, _current_heading, _split_inline_questions
```

- [ ] **Step 4: 新增 `_split_inline_questions` 单测**

在 `test_card_splitter.py` 末尾追加测试类：

```python
class TestSplitInlineQuestions:
    def test_semicolon_separated(self):
        """分号分隔的同行题拆为多段"""
        para = "(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$"
        result = _split_inline_questions(para)
        assert len(result) == 2
        assert result[0].startswith("(1)")
        assert result[1].startswith("(2)")

    def test_period_separated(self):
        """句号分隔的同行题拆为多段"""
        para = "(1) 解方程 $x^{2}=4$。(2) 求 $y$ 的值。"
        result = _split_inline_questions(para)
        assert len(result) == 2
        assert "(1)" in result[0]
        assert "(2)" in result[1]

    def test_no_split_on_text_ref(self):
        """正文引用 (2) 不误拆，如「与(2)类似」"""
        para = "由(1)可知，与(2)类似的方法也可解此题。"
        result = _split_inline_questions(para)
        assert len(result) == 1
        assert result[0] == para

    def test_single_question_no_split(self):
        """单题无拆分点原样返回"""
        para = "(1) $x^{2}+2x+1=0$"
        result = _split_inline_questions(para)
        assert len(result) == 1
        assert result[0] == para

    def test_no_numbered_items(self):
        """无编号段落不拆分"""
        para = "解下列方程："
        result = _split_inline_questions(para)
        assert len(result) == 1
        assert result[0] == para

    def test_chinese_semicolon_separated(self):
        """中文分号；分隔同行题"""
        para = "(1) $x^{2}=9$；(2) $y^{2}=16$"
        result = _split_inline_questions(para)
        assert len(result) == 2
        assert "(1)" in result[0]
        assert "(2)" in result[1]

    def test_mixed_inline_and_newline_already_split(self):
        """已换行分隔的题保持独立"""
        para = "(1) $x^{2}=9$\n\n(2) $y^{2}=16$"
        # _split_paragraphs 先拆双换行，所以此段传入时已只有 (1)
        result = _split_inline_questions("(1) $x^{2}=9$")
        assert len(result) == 1
```

- [ ] **Step 5: 跑 card_splitter 测试确认通过**

```bash
cd tools/data-refinery && python -m pytest tests/test_card_splitter.py -v
```

Expected: 所有测试 PASS（包括既有测试和新增的 TestSplitInlineQuestions）。

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/card_splitter.py tools/data-refinery/tests/test_card_splitter.py
git commit -m "feat(card_splitter): add _split_inline_questions to split inline practice questions on (N) boundaries

Splits paragraphs containing multiple numbered questions on the same
line (e.g. '(1) x²=4 ; (2) y²=9') into separate segments. Uses
lookbehind for sentence-ending punctuation or semicolons before (N)
to avoid false splits on parenthetical references like '与(2)类似'.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: db_loader practice 卡 content 重组（LLM 兜底）

**Files:**
- Modify: `tools/data-refinery/src/db_loader.py` — 新增 `rebuild_practice_content`，修改 `_insert_card`
- Modify: `tools/data-refinery/tests/test_db_loader.py` — 新增单测

- [ ] **Step 1: 在 db_loader.py 新增 `rebuild_practice_content` 函数**

在 `build_content_metadata` 函数之后（约 line 103）、`parse_book_rel_path` 之前插入：

```python
def rebuild_practice_content(intro: str | None, questions: list[dict]) -> str:
    """用 labeler 输出的 questions[].text 重组 practice 卡的 content。

    intro 在前（若有），每题 text 用 \\n\\n 分隔接在后面。
    重组后每题独立成段，LLM 语义拆分兜底正则拆不开的边缘案（如无分号同行题）。
    """
    parts: list[str] = []
    if intro and intro.strip():
        parts.append(intro.strip())
    for q in questions:
        text = q.get("text", "")
        if text.strip():
            parts.append(text.strip())
    return "\n\n".join(parts)
```

- [ ] **Step 2: 修改 `_insert_card`，对 practice 卡重组 content**

在 `_insert_card` 方法中（约 line 667），修改 practice 卡 content_metadata 处理段落。当前逻辑：

```python
def _insert_card(self, lesson_id: int, sort_order: int, c: dict):
    cm = c.get("content_metadata")
    card_content = c.get("content") or ""

    # practice 卡：从 content_metadata 提取 intro/questions 做子串校验
    if cm and (cm.get("intro") is not None or cm.get("questions") is not None):
        intro = cm.get("intro")
        questions = cm.get("questions")
        existing = {k: v for k, v in cm.items() if k not in ("intro", "questions")}
        cm = build_content_metadata(intro, questions, card_content, existing)

    kp = c.get("knowledge_point_ids") or []
    self._exec(
        "INSERT INTO cards (...) VALUES (...)",
        (lesson_id, sort_order, c.get("card_type"), c.get("title"), c.get("content"),
         json.dumps(cm, ensure_ascii=False) if cm else None,
         ...),
    )
```

替换为：

```python
def _insert_card(self, lesson_id: int, sort_order: int, c: dict):
    cm = c.get("content_metadata")
    card_content = c.get("content") or ""
    card_type = c.get("card_type")

    # practice 卡：从 content_metadata 提取 intro/questions 做子串校验
    if cm and (cm.get("intro") is not None or cm.get("questions") is not None):
        intro = cm.get("intro")
        questions = cm.get("questions")
        existing = {k: v for k, v in cm.items() if k not in ("intro", "questions")}
        # 子串校验在重组前对原文做（§5.2）
        cm = build_content_metadata(intro, questions, card_content, existing)
        # practice 卡 content 重组：用已验证的 questions[].text 重建 content
        # 每题独立成行，LLM 兜底正则拆不开的边缘案
        validated_qs = cm.get("questions") if cm else None
        if card_type == "practice" and validated_qs:
            card_content = rebuild_practice_content(cm.get("intro"), validated_qs)

    kp = c.get("knowledge_point_ids") or []
    self._exec(
        "INSERT INTO cards (lesson_id, sort_order, card_type, title, content, "
        "content_metadata, knowledge_point_ids, textbook_page) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (lesson_id, sort_order, card_type, c.get("title"), card_content,
         json.dumps(cm, ensure_ascii=False) if cm else None,
         json.dumps(kp, ensure_ascii=False),
         c.get("textbook_page")),
    )
```

注意：`card_content` 原来是 `c.get("content")` 不变，仅在 practice 卡有 validated questions 时替换为重组后的 content。

- [ ] **Step 3: 更新测试文件的 import**

在 `tools/data-refinery/tests/test_db_loader.py` 的 import 行加入 `rebuild_practice_content`：

```python
from db_loader import (
    build_content_metadata,
    chinese_to_int,
    normalize_subject,
    parse_book_rel_path,
    parse_lesson_id,
    question_text_valid,
    rebuild_practice_content,
    renumber_sort_order,
)
```

- [ ] **Step 4: 新增 `rebuild_practice_content` 单测**

在 `test_db_loader.py` 末尾追加测试类：

```python
class TestRebuildPracticeContent:
    def test_with_intro_and_questions(self):
        result = rebuild_practice_content(
            intro="解下列方程：",
            questions=[
                {"n": 1, "text": "(1) $5x^{2}-1=4x$"},
                {"n": 2, "text": "(2) $4x^{2}=81$"},
            ],
        )
        expected = "解下列方程：\n\n(1) $5x^{2}-1=4x$\n\n(2) $4x^{2}=81$"
        assert result == expected

    def test_no_intro(self):
        result = rebuild_practice_content(
            intro=None,
            questions=[
                {"n": 1, "text": "(1) 计算 $2+3$"},
                {"n": 2, "text": "(2) 计算 $5-1$"},
            ],
        )
        assert result == "(1) 计算 $2+3$\n\n(2) 计算 $5-1$"

    def test_empty_questions(self):
        result = rebuild_practice_content(intro="题目：", questions=[])
        assert result == "题目："

    def test_empty_intro_and_questions(self):
        result = rebuild_practice_content(intro=None, questions=[])
        assert result == ""

    def test_intro_whitespace_only(self):
        result = rebuild_practice_content(
            intro="   ",
            questions=[{"n": 1, "text": "(1) $x=1$"}],
        )
        assert result == "(1) $x=1$"

    def test_preserves_latex(self):
        """重组后的 content 保持 LaTeX 原样"""
        result = rebuild_practice_content(
            intro=None,
            questions=[{"n": 1, "text": "(1) $\\frac{1}{2}x^{2}+3x-5=0$"}],
        )
        assert "$\\frac{1}{2}x^{2}+3x-5=0$" in result
```

- [ ] **Step 5: 跑 db_loader 测试确认通过**

```bash
cd tools/data-refinery && python -m pytest tests/test_db_loader.py -v
```

Expected: 所有测试 PASS（包括既有测试和新增的 TestRebuildPracticeContent）。

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/db_loader.py tools/data-refinery/tests/test_db_loader.py
git commit -m "feat(db_loader): rebuild practice card content from labeler questions[].text

For practice cards with validated questions in content_metadata, rebuilds
the card content so each question is on its own line (intro first, then
each question.text separated by \n\n). LLM semantic splitting serves as
fallback for edge cases the regex splitter can't handle (e.g. no
semicolons, LaTeX blocking split points).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 前端删除 `preprocessContent` step 2.5

**Files:**
- Modify: `apps/web/src/pages/student/CourseDetailPage.tsx` — 删除 lines 167-169

- [ ] **Step 1: 删除 step 2.5 的代码和注释**

在 `apps/web/src/pages/student/CourseDetailPage.tsx`，删除 lines 167-169：

删除内容（含注释行和正则替换行）：
```typescript
  // 2.5 同一行内的题目编号 (1) xxx (2) yyy 拆成独立段落
  //    要求 (N) 前后都有空格，避免误拆 "与(2)类似" 等正文括号
  result = result.replace(/([^\n])\s+\(([1-9]\d?)\)(?=\s)/g, '$1\n\n($2)');
```

使用 Edit 工具精确删除这三行。删除后，原 line 166（step 2 的 replace）应直接接原 line 170（step 3 的 replace）。

- [ ] **Step 2: 验证前端构建通过**

```bash
cd apps/web && npm run build
```

Expected: tsc 类型检查 + Vite 构建均成功，无新增错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/student/CourseDetailPage.tsx
git commit -m "feat(web): remove preprocessContent step 2.5 inline question splitting

Pipeline now guarantees each practice question is on its own line
(card_splitter._split_inline_questions + db_loader content rebuild),
so the runtime regex split in the frontend is no longer needed.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 文档同步

**Files:**
- Modify: `docs/K12智学系统-Card内容生成与渲染设计文档.md` — 更新 §9.4 状态

- [ ] **Step 1: 将 §9.4 标记从"待实施"改为"已实施"**

修改 `docs/K12智学系统-Card内容生成与渲染设计文档.md` 中 §9.4 的标题：

```
### 9.4 card_splitter 同行题拆行（2026-08-08 待实施）
```

改为：

```
### 9.4 card_splitter 同行题拆行（2026-08-08 已实施）
```

并在末尾（line 471 之后）追加一行状态摘要：

```markdown
  - 实施日期：2026-08-08；card_splitter._split_inline_questions ✅ / db_loader.rebuild_practice_content ✅ / 前端 step 2.5 已删除 ✅
```

- [ ] **Step 2: Commit**

```bash
git add docs/K12智学系统-Card内容生成与渲染设计文档.md
git commit -m "docs: mark card_splitter inline question splitting as implemented

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 实施顺序

Task 1 → Task 2 → Task 3 → Task 4（依赖关系：card_splitter 先拆 → db_loader 重组兜底 → 前端才能安全删除 step 2.5；文档最后更新状态）
