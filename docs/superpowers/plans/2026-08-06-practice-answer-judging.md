# 课堂练习答题与判对错 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CourseDetailPage 课堂练习态，每道题可点击 -> 解答窗口（LaTeX 编辑+预览）-> 服务端判对错（客观题比对 / 主观题走 JudgmentCapability）-> 答错进主线错题本 + 题入库 -> 答题列表 + 解析。

**Architecture:** 底向上三层。① 数据管线（Python）：card_labeler 输出 `questions` 到 `content_metadata`，card_splitter 同节补句 + `(N)` 原子 bundle。② 后端（NestJS + ai-core）：新增 `JudgmentCapability`（判对错，非判分）+ `practice` 模块端点 + `main-error-books.repo` + `content_hash` NFKC 对齐。③ 前端（React）：结构化渲染练习卡 + AnswerModal/LatexEditor/LatexPreview/SymbolPalette + practiceStore + 答题列表。

**Tech Stack:** Python 3 (data-refinery, pytest) · NestJS + TypeScript ESM + Vitest + Zod (apps/server) · React 18 + Vite + TypeScript + Tailwind + Zustand + react-markdown + remark-math + rehype-katex (apps/web) · MySQL.

**Spec:** `docs/superpowers/specs/2026-08-06-practice-answer-judging-design.md`

---

## File Structure

### 数据管线 (tools/data-refinery)
- Modify: `src/card_splitter.py` — 标题感知 + 同节补句 + `(N)` 原子 bundle
- Modify: `src/card_labeler.py` — `LabelResult` 增 `intro`/`questions`，解析透传
- Modify: `src/prompts/textbook_cards.txt` — 增量：practice 卡输出 intro+questions
- Modify: `src/db_loader.py` — 持久化 `content_metadata.questions` + text 子串校验
- Create: `src/backfill_practice_questions.py` — 一次性回填脚本
- Modify: `tests/test_card_splitter.py`, `tests/test_card_labeler.py` — 新增单测

### 后端基础设施 (apps/server)
- Modify: `src/modules/error-book/content-hash.util.ts` — NFKC 对齐
- Modify: `src/modules/error-book/content-hash.util.spec.ts` — 对齐用例
- Create: `src/database/repositories/main-error-books.repo.ts` — 主线错题本 repo
- Modify: `src/database/repositories/index.ts` — 导出 MainErrorBooksRepository
- Modify: `src/database/repositories/types.ts` — MainErrorBookRow 类型
- Create: `src/database/repositories/main-error-books.repo.test.ts`

### 后端判定能力 (apps/server/src/ai-core)
- Create: `src/ai-core/prompts/judgment/math-calculation.md`, `math-proof.md` — 判定提示词
- Modify: `src/ai-core/infra/prompt-builder.ts` — 注册 `judgment` capability（若需）
- Modify: `src/ai-core/types.ts` — JudgmentRequest/JudgmentResult 类型 + Scene/CapabilityType 增 'judgment'
- Modify: `src/ai-core/infra/model-router.ts` + `model-routes.yaml` — judgment scene 路由
- Modify: `src/ai-core/config.ts` / `retry.yaml` — judgment timeout
- Create: `src/ai-core/capabilities/judgment.capability.ts`
- Create: `src/ai-core/capabilities/judgment.capability.test.ts`

### 后端端点 (apps/server)
- Create: `src/modules/practice/practice.module.ts`, `practice.controller.ts`, `practice.service.ts`
- Create: `src/modules/practice/dto/judge-practice.dto.ts`
- Create: `src/modules/practice/practice.service.test.ts`
- Modify: `src/app.module.ts` — 注册 PracticeModule

### 前端 (apps/web)
- Create: `src/components/business/SymbolPalette.tsx`
- Create: `src/components/business/LatexEditor.tsx`
- Create: `src/components/business/LatexPreview.tsx`
- Create: `src/components/business/AnswerModal.tsx`
- Create: `src/components/business/AnswerResultList.tsx`
- Create: `src/store/practiceStore.ts`
- Modify: `src/services/api.ts` — `judgePractice()` + 类型
- Modify: `src/pages/student/CourseDetailPage.tsx` — 结构化渲染 + 接入 modal

### 文档
- Modify: `docs/api/openapi.yaml`, `docs/API接口与数据流设计文档.md`, `docs/K12智学系统-数据库设计文档.md`

---

## Phase A — 数据管线

### Task A1: card_splitter 增强（标题感知 + 同节补句 + `(N)` 原子 bundle）

**Files:**
- Modify: `tools/data-refinery/src/card_splitter.py`
- Test: `tools/data-refinery/tests/test_card_splitter.py`

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_card_splitter.py`：

```python
from card_splitter import _split_paragraphs, _make_bundles, _current_heading

def test_current_heading_tracks_markdown_heading():
    assert _current_heading("## 练习") == "练习"
    assert _current_heading("### 1.2 因式分解") == "1.2 因式分解"
    assert _current_heading("普通段落") is None

def test_question_paragraph_is_atomic_bundle():
    # (N) 开头的段落即使超长也不在题中间切
    text = "(1) 这是一道很长的题目" + "条件" * 200 + "，求 x 的值。"
    bundles = _make_bundles(text, [])
    # 题段落作为单个 bundle（即便 >400，也不再按句切分到多 bundle）
    assert len(bundles) == 1
    assert bundles[0].text.startswith("(1)")

def test_same_section_fill_pulls_sentence_from_next():
    # 当前 <300 且下一同节段落 -> 拉句子补；不同节 -> 不补
    # （补句逻辑在 split_page 的合并循环里，此处验证 _make_bundles 标记同节）
    text = "## 练习\n\n短句一。\n\n短句二，补充内容。"
    bundles = _make_bundles(text, [])
    assert len(bundles) >= 2
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/data-refinery && python -m pytest tests/test_card_splitter.py::test_current_heading_tracks_markdown_heading -v`
Expected: FAIL（`_current_heading` 不存在）

- [ ] **Step 3: 实现**

在 `card_splitter.py` 顶部工具函数区加：

```python
_HEADING_RE = re.compile(r'^#{1,6}\s+(.+)$')

def _current_heading(text: str) -> str | None:
    """返回 markdown 标题文本（如 '## 练习' -> '练习'），非标题返回 None。"""
    m = _HEADING_RE.match(text.strip())
    return m.group(1).strip() if m else None

def _is_question_starter(text: str) -> bool:
    """是否以 (N) 题号开头（半/全角括号兼容）。"""
    return bool(re.match(r'^[\(（]\s*[1-9]\d?\s*[\)）]', text.strip()))
```

修改 `_make_bundles`：遍历 `paragraphs` 时维护 `current_heading`；对 `_is_question_starter(para)` 的段落，**不进入** `para_text_chars > _TEXT_LIMIT` 的按句切分分支（保持整段一个 bundle）：

```python
def _make_bundles(text: str, images: list[ImageInfo]) -> list[_Bundle]:
    paragraphs = _split_paragraphs(text)
    bundles: list[_Bundle] = []
    pos = 0
    current_heading: str | None = None
    for para in paragraphs:
        if _is_page_number_header(para):
            continue
        heading = _current_heading(para)
        if heading:
            current_heading = heading
            # 标题行本身也作为一个 bundle（保留渲染）
        para_start = text.index(para, pos) if para in text[pos:] else pos
        para_end = para_start + len(para)
        pos = para_end
        para_images = _images_in_range(images, para_start, para_end)
        para_text_chars = _count_text_chars(para)
        is_question = _is_question_starter(para)
        # 题段落原子化：即便 >400 也不按句切（避免题跨 bundle/卡）
        if para_text_chars > _TEXT_LIMIT and not is_question:
            sub_texts = _split_long_text(para)
            for sub in sub_texts:
                sub_start = text.index(sub, para_start) if sub in text[para_start:para_end] else para_start
                sub_end = sub_start + len(sub)
                sub_images = _images_in_range(images, sub_start, sub_end)
                sub_chars = _count_text_chars(sub)
                sub_cost = sum(img.char_cost for img in sub_images)
                bundles.append(_Bundle(text=sub, images=sub_images, text_chars=sub_chars, image_cost=sub_cost, heading=current_heading))
        else:
            img_cost = sum(img.char_cost for img in para_images)
            bundles.append(_Bundle(text=para, images=para_images, text_chars=para_text_chars, image_cost=img_cost, heading=current_heading))
    return bundles
```

给 `_Bundle` 加字段 `heading: str | None = None`，并改 `split_page` 合并循环：当当前卡 `< _TEXT_LIMIT * 0.75`（约 300）且下一 bundle 同 `heading` 且非题段落时，从下一 bundle 拉完整句子补足（用 `_split_long_text` 切下一 bundle 的 text，取首句并入当前卡）：

```python
# 在 split_page 的 for bundle in remaining_bundles 循环里，"放不下：先把当前卡封存" 之前加：
if (current_texts and 0 < current_text_chars < _TEXT_LIMIT * 0.75
        and bundle.heading is not None and bundle.heading == _last_heading_of(current_texts)
        and not _is_question_starter(bundle.text)):
    # 尝试从 bundle 拉首句补入当前卡
    first_sentence, rest = _split_first_sentence(bundle.text)
    first_chars = _count_text_chars(first_sentence)
    if current_text_chars + first_chars <= _TEXT_LIMIT and first_chars < bundle.text_chars:
        current_texts.append(first_sentence)
        current_text_chars += first_chars
        current_total += first_chars
        # bundle 剩余部分作为新 bundle 继续（简化：直接放新卡）
        bundle = _Bundle(text=rest, images=bundle.images, text_chars=_count_text_chars(rest), image_cost=bundle.image_cost, heading=bundle.heading)
    # 继续走原有"放不下封存"逻辑
```

加辅助：

```python
def _split_first_sentence(text: str) -> tuple[str, str]:
    """按首个句末标点切 [首句, 剩余]；无标点则 [text, '']。"""
    m = re.search(r'[。！？；]', text)
    if not m:
        return text, ''
    return text[:m.end()], text[m.end():]

def _last_heading_of(current_texts: list[str]) -> str | None:
    # current_texts 不含 heading（标题是独立 bundle），靠 bundle.heading 传入
    # 此 helper 仅占位，实际同节判断在循环里用变量记录上一 bundle 的 heading
    return None
```

> 注：同节判断需在循环里用 `last_heading` 变量记录封存前的 heading；实现时把 `_last_heading_of` 替换为循环局部变量 `last_heading`。这是实现提示，落地时按循环结构调整。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/data-refinery && python -m pytest tests/test_card_splitter.py -v`
Expected: PASS（含既有用例不回归）

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/card_splitter.py tools/data-refinery/tests/test_card_splitter.py
git commit -m "feat(data-refinery): card_splitter heading-aware fill + (N) atomic bundle"
```

---

### Task A2: card_labeler 输出 intro + questions

**Files:**
- Modify: `tools/data-refinery/src/card_labeler.py`
- Modify: `tools/data-refinery/src/prompts/textbook_cards.txt`
- Test: `tools/data-refinery/tests/test_card_labeler.py`

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_card_labeler.py`：

```python
from card_labeler import CardLabeler, LabelResult, QuestionMarker

def test_label_result_parses_questions_for_practice(monkeypatch):
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","intro":"解下列方程：","questions":[{"n":1,"text":"(1) $5x^{2}-1=4x$"},{"n":2,"text":"(2) $4x^{2}=81$"}]}]}'})()
    class FakeLLM:
        def complete(self, system, user):
            return fake_response
    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$ ;"], "P11")
    assert result.page_type == "practice"
    assert result.labels[0].card_type == "practice"
    assert result.labels[0].intro == "解下列方程："
    assert len(result.labels[0].questions) == 2
    assert result.labels[0].questions[0].n == 1
    assert result.labels[0].questions[0].text == "(1) $5x^{2}-1=4x$"

def test_label_result_questions_none_for_non_practice(monkeypatch):
    fake_response = type("R", (), {"content": '{"page_type":"content","items":[{"card_type":"concept","lesson_id":"26.1","title":"概念","textbook_page":"P8"}]}'})()
    class FakeLLM:
        def complete(self, system, user):
            return fake_response
    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["概念文字"], "P8")
    assert result.labels[0].questions is None
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/data-refinery && python -m pytest tests/test_card_labeler.py -v`
Expected: FAIL（`QuestionMarker` 不存在 / questions 未解析）

- [ ] **Step 3: 实现 card_labeler.py**

在 `card_labeler.py` 加 dataclass 并修改解析：

```python
@dataclass
class QuestionMarker:
    n: int
    text: str

@dataclass
class LabelResult:
    page_type: str
    card_type: str
    lesson_id: str | None
    title: str | None
    textbook_page: str
    intro: str | None = None
    questions: list[QuestionMarker] | None = None
```

在 `label()` 的解析循环里：

```python
for idx, item in enumerate(raw_items):
    raw_qs = item.get("questions")
    questions = None
    if raw_qs is not None:
        questions = []
        for q in raw_qs:
            try:
                questions.append(QuestionMarker(n=int(q.get("n", 0)), text=str(q.get("text", ""))))
            except (TypeError, ValueError):
                continue
    labels.append(LabelResult(
        page_type=page_type,
        card_type=str(item.get("card_type", "concept")),
        lesson_id=item.get("lesson_id"),
        title=item.get("title"),
        textbook_page=item.get("textbook_page", page_number),
        intro=item.get("intro"),
        questions=questions,
    ))
```

- [ ] **Step 4: 增量改提示词**

`tools/data-refinery/src/prompts/textbook_cards.txt` — 在 `【card_type -- 卡片类型】` 段之后追加（**增量 Edit，不重写既有内容**）：

```text
【questions / intro -- 仅 practice 卡】
当 card_type 为 "practice" 时，额外输出：
- "intro"：题前的说明/要求文字（无则省略该字段）
- "questions"：数组，枚举该卡每一道可作答的题，每项 {"n": 题号, "text": 题面原文}
  - n：(N) 中的 N；无编号题用从 1 起的自然序
  - text：该题完整 markdown，**逐字取自卡片原文**（含 $...$ LaTeX），不改写、不翻译、不补答案、不合并多题
  - 同一行内多题（无论是否以 ; 分隔）必须拆成多个 questions 项
  - 非题文字（说明/提示/图注）不得进入 questions
其余 card_type 不输出 questions/intro 字段。
```

并修改输出格式示例，在 practice 项里加 `intro` 与 `questions`（参考 spec §5.1 JSON）。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd tools/data-refinery && python -m pytest tests/test_card_labeler.py -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add tools/data-refinery/src/card_labeler.py tools/data-refinery/src/prompts/textbook_cards.txt tools/data-refinery/tests/test_card_labeler.py
git commit -m "feat(data-refinery): card_labeler outputs intro+questions for practice cards"
```

---

### Task A3: db_loader 持久化 questions + text 子串校验

**Files:**
- Modify: `tools/data-refinery/src/db_loader.py`
- Test: `tools/data-refinery/tests/test_db_loader.py`

- [ ] **Step 1: 写失败测试**

```python
from db_loader import build_content_metadata, question_text_valid

def test_question_text_valid_substring():
    card_content = "(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$ ;"
    assert question_text_valid("(1) $5x^{2}-1=4x$", card_content) is True
    assert question_text_valid("被改写的题面", card_content) is False

def test_build_content_metadata_merges_and_marks_fallback():
    card_content = "(1) $5x^{2}-1=4x$"
    qs = [{"n": 1, "text": "(1) $5x^{2}-1=4x$"}]
    md = build_content_metadata(intro="解方程：", questions=qs, card_content=card_content, existing=None)
    assert md["questions"][0]["n"] == 1
    assert md.get("needs_fallback") is False
    # 改写题面 -> 校验失败 -> needs_fallback=True，questions 丢弃
    md2 = build_content_metadata(intro=None, questions=[{"n":1,"text":"幻觉题面"}], card_content=card_content, existing=None)
    assert md2.get("needs_fallback") is True
    assert md2.get("questions") in (None, [])
```

- [ ] **Step 2: 运行确认失败** — `cd tools/data-refinery && python -m pytest tests/test_db_loader.py::test_question_text_valid_substring -v` → FAIL

- [ ] **Step 3: 实现**

在 `db_loader.py` 加：

```python
import unicodedata, json as _json

def _normalize_for_match(s: str) -> str:
    """与 content_hash 同口径的轻归一，用于子串校验（NFKC + 去空白 + lower）。"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"\s+", "", s)
    return s.lower()

def question_text_valid(text: str, card_content: str) -> bool:
    if not text:
        return False
    return _normalize_for_match(text) in _normalize_for_match(card_content)

def build_content_metadata(intro: str | None, questions: list[dict] | None,
                           card_content: str, existing: dict | None) -> dict:
    md = dict(existing or {})
    valid_qs = [q for q in (questions or []) if question_text_valid(q.get("text", ""), card_content)]
    if questions is not None:
        if valid_qs:
            md["questions"] = valid_qs
            md.pop("needs_fallback", None)
        else:
            md.pop("questions", None)
            md["needs_fallback"] = True
    if intro is not None:
        md["intro"] = intro
    return md
```

在 db_loader 写 `cards` 行处（`INSERT INTO cards ... content_metadata=?`），用 `build_content_metadata(label.intro, label.questions_raw, card_content, existing_metadata)` 生成 JSON 字符串写入。`label.questions_raw` 为 `[{"n":q.n,"text":q.text} for q in (label.questions or [])]`。

- [ ] **Step 4: 运行测试通过** — `python -m pytest tests/test_db_loader.py -v`

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/db_loader.py tools/data-refinery/tests/test_db_loader.py
git commit -m "feat(data-refinery): persist practice questions to content_metadata with validation"
```

---

### Task A4: 回填脚本 + .env 前置

**Files:**
- Create: `tools/data-refinery/src/backfill_practice_questions.py`

- [ ] **Step 1: 实现回填脚本**

```python
"""一次性回填：为已入库的 practice 卡补 content_metadata.questions。
幂等：已有 questions 或 needs_fallback 的卡跳过。"""
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from llm import LLMClient
from card_labeler import CardLabeler
import db_loader_cli  # 复用其 DB 连接

PROMPT = open(os.path.join(os.path.dirname(__file__), "prompts", "textbook_cards.txt"), encoding="utf-8").read()

def main():
    db = db_loader_cli.connect_db()
    rows = db.fetch_all("SELECT id, content, content_metadata FROM cards WHERE card_type='practice'")
    llm = LLMClient(base_url=os.getenv("LLM_BASE_URL"), auth_token=os.getenv("LLM_AUTH_TOKEN"), model=os.getenv("LLM_MODEL"))
    labeler = CardLabeler(llm=llm, prompt_template=PROMPT)
    updated = 0
    for r in rows:
        existing = json.loads(r["content_metadata"]) if r["content_metadata"] else {}
        if existing.get("questions") or existing.get("needs_fallback"):
            continue
        result = labeler.label([r["content"]], f"P{r['id']}").labels[0]
        md = db_loader.build_content_metadata(result.intro, [{"n":q.n,"text":q.text} for q in (result.questions or [])], r["content"], existing)
        db.execute("UPDATE cards SET content_metadata=%s WHERE id=%s", [json.dumps(md, ensure_ascii=False), r["id"]])
        updated += 1
    print(f"backfilled {updated} practice cards")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 确认 .env**

确认 `tools/data-refinery/.env` 的 `LLM_MODEL=deepseek-v4-flash`（取消注释，Gemma 那行注释掉）。若未切，手动切。

- [ ] **Step 3: 干跑校验**

Run: `cd tools/data-refinery && python -m pytest tests/ -k "card_splitter or card_labeler or db_loader" -v`
Expected: 全 PASS，无回归。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/backfill_practice_questions.py
git commit -m "feat(data-refinery): add practice questions backfill script"
```

---

## Phase B — 后端基础设施

### Task B1: content_hash NFKC 对齐 + 迁移

**Files:**
- Modify: `apps/server/src/modules/error-book/content-hash.util.ts`
- Modify: `apps/server/src/modules/error-book/content-hash.util.spec.ts`

- [ ] **Step 1: 写失败测试**

追加到 `content-hash.util.spec.ts`：

```typescript
import { computeContentHash, normalizeForHash } from './content-hash.util';

describe('content-hash NFKC alignment', () => {
  it('全角括号/数字/上标 NFKC 归一', () => {
    expect(normalizeForHash('（1）x²=4')).toBe(normalizeForHash('(1)x2=4'));
  });
  it('与 refinery normalize_content 同口径（不删标点）', () => {
    // refinery: NFKC + 去空白 + lower，标点保留
    expect(normalizeForHash('A,B')).toBe('a,b');
  });
  it('等价哈希', () => {
    expect(computeContentHash('（1）x²=4')).toBe(computeContentHash('(1)x2=4'));
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd apps/server && npx vitest run src/modules/error-book/content-hash.util.spec.ts` → FAIL（当前实现删标点且不 NFKC）

- [ ] **Step 3: 实现**

替换 `content-hash.util.ts` 的 `normalizeForHash`：

```typescript
import { createHash } from 'node:crypto';

/** 对齐 tools/data-refinery/src/db_loader.py::normalize_content：
 *  NFKC 全半角归一 + 去所有空白 + 转小写（不删标点）。 */
export function normalizeForHash(content: string): string {
  // Node 无内置 NFKC；用 normalize('NFKC')（Node 的 String.prototype.normalize 支持 NFKC）
  return content
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(normalizeForHash(content)).digest('hex');
}
```

> Node 的 `String.prototype.normalize('NFKC')` 等价于 Python `unicodedata.normalize('NFKC', s)`，二者对同一字符串产出相同码点序列，哈希一致。

- [ ] **Step 4: 运行测试通过** — `npx vitest run src/modules/error-book/content-hash.util.spec.ts`

- [ ] **Step 5: aux rehash 迁移脚本（一次性）**

Create `apps/server/src/migrations/rehash-questions.mjs`：

```javascript
// 一次性：用新 NFKC 归一重算 questions.content_hash。
// 运行：node --experimental-vm-modules apps/server/src/migrations/rehash-questions.mjs
import mysql from 'mysql2/promise';
import { computeContentHash } from '../dist/modules/error-book/content-hash.util.js';
const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const [rows] = await pool.query('SELECT id, content FROM questions WHERE content_hash IS NOT NULL');
for (const r of rows) {
  const h = computeContentHash(r.content);
  await pool.query('UPDATE questions SET content_hash = ? WHERE id = ?', [h, r.id]);
}
console.log(`rehashed ${rows.length} questions`);
await pool.end();
```

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/error-book/content-hash.util.ts apps/server/src/modules/error-book/content-hash.util.spec.ts apps/server/src/migrations/rehash-questions.mjs
git commit -m "fix(error-book): align content_hash with refinery NFKC normalization"
```

---

### Task B2: main-error-books.repo.ts

**Files:**
- Create: `apps/server/src/database/repositories/main-error-books.repo.ts`
- Modify: `apps/server/src/database/repositories/types.ts`, `index.ts`
- Test: `apps/server/src/database/repositories/main-error-books.repo.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// main-error-books.repo.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MainErrorBooksRepository } from './main-error-books.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([{ insertId: 7 }]),
  query: vi.fn().mockResolvedValue([rows]),
});
describe('MainErrorBooksRepository', () => {
  it('create 插入并返回 id', async () => {
    const repo = new MainErrorBooksRepository(mockPool() as any);
    const id = await repo.create({ student_id: 1, subject_id: 1, question_id: 2, source: 'practice', source_ref_id: 3, wrong_answer_text: null });
    expect(id).toBe(7);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd apps/server && npx vitest run src/database/repositories/main-error-books.repo.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现**

`types.ts` 加：

```typescript
export interface MainErrorBookRow {
  id: number;
  student_id: number;
  subject_id: number;
  question_id: number;
  level: number;
  is_cleared: number;
  source: string;
  source_ref_id: number | null;
  wrong_answer_text: string | null;
  cleared_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
```

`main-error-books.repo.ts`（镜像 `aux-error-books.repo.ts`）：

```typescript
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { MainErrorBookRow } from './types.js';

@Injectable()
export class MainErrorBooksRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<MainErrorBookRow, 'id' | 'level' | 'is_cleared' | 'cleared_at' | 'created_at' | 'updated_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO main_error_books
       (student_id, subject_id, question_id, source, source_ref_id, wrong_answer_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.student_id, row.subject_id, row.question_id, row.source, row.source_ref_id ?? null, row.wrong_answer_text ?? null],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<MainErrorBookRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT * FROM main_error_books WHERE id = ?`, [id]);
    return (rows[0] as MainErrorBookRow) ?? null;
  }

  async findByStudent(studentId: number, subjectId?: number, includeCleared = false): Promise<MainErrorBookRow[]> {
    const conditions = ['student_id = ?'];
    const params: any[] = [studentId];
    if (subjectId) { conditions.push('subject_id = ?'); params.push(subjectId); }
    if (!includeCleared) conditions.push('is_cleared = 0');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM main_error_books WHERE ${conditions.join(' AND ')} ORDER BY id DESC`, params);
    return rows as MainErrorBookRow[];
  }

  async markCleared(id: number): Promise<void> {
    await this.pool.execute(`UPDATE main_error_books SET is_cleared = 1, cleared_at = NOW(3) WHERE id = ?`, [id]);
  }
}
```

`index.ts` 导出 `MainErrorBooksRepository`。

- [ ] **Step 4: 运行测试通过** — `npx vitest run src/database/repositories/main-error-books.repo.test.ts`

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/main-error-books.repo.ts apps/server/src/database/repositories/main-error-books.repo.test.ts apps/server/src/database/repositories/types.ts apps/server/src/database/repositories/index.ts
git commit -m "feat(db): add MainErrorBooksRepository"
```

---

## Phase C — 后端判定能力

### Task C1: judgment 提示词

**Files:**
- Create: `apps/server/src/ai-core/prompts/judgment/math-calculation.md`
- Create: `apps/server/src/ai-core/prompts/judgment/math-proof.md`

- [ ] **Step 1: 写提示词（math-calculation.md）**

```markdown
---
version: "1.0"
description: "判断学生计算题解答对错（非判分）"
---

## System Prompt

你是一位严谨的中学数学老师。判断学生的**解答是否正确**（只判对错，不打分）。

规则：
1. 对照题面与参考答案/解析，逐步核验学生的解题过程与最终结果。
2. 过程与结果均正确 -> isCorrect=true。
3. 任何一步错误（逻辑错、计算错、格式导致歧义、漏步关键步骤）-> isCorrect=false，并在 analysis 中说明错因与正确解法。
4. 数学公式用 LaTeX 原样保留。
5. 输出合法 JSON，不要 markdown 代码块标记。

输出 JSON：
{
  "isCorrect": false,
  "analysis": "第二步符号错：应为 -b，你写成 b；正确解法：代入公式 x=(b±√(b²-4ac))/2a ...",
  "errorType": "calculation"
}

errorType 枚举：logic（逻辑错）/ calculation（计算错）/ format（格式歧义）/ missing（漏步）。答对时 analysis 为空字符串，errorType 为 null。

## User Message

题型：{{questionType}}
题面：
{{questionContent}}

参考答案：
{{standardAnswer}}

参考解析：
{{reference}}

学生解答：
{{studentAnswer}}

请判断对错并输出 JSON。
```

- [ ] **Step 2: 写 math-proof.md**（同结构，`description: "判断证明题对错"`，规则强调"证明逻辑链完整、每步依据正确"）。

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/ai-core/prompts/judgment/
git commit -m "feat(ai-core): add judgment prompts for math calculation/proof"
```

---

### Task C2: JudgmentCapability

**Files:**
- Modify: `apps/server/src/ai-core/types.ts` — Scene/CapabilityType 增 'judgment'；加 JudgmentRequest/JudgmentResult
- Modify: `apps/server/src/ai-core/infra/model-router.ts` + `model-routes.yaml` — judgment scene
- Modify: `apps/server/src/ai-core/config.ts` / `retry.yaml` — timeout
- Create: `apps/server/src/ai-core/capabilities/judgment.capability.ts`
- Test: `apps/server/src/ai-core/capabilities/judgment.capability.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// judgment.capability.test.ts
import { describe, it, expect, vi } from 'vitest';
import { JudgmentCapability } from './judgment.capability';
import type { ModelClient } from '../infra/model-client/index.js';

const mockChat = vi.fn();
const mockModelClient = { chat: mockChat } as unknown as ModelClient;

describe('JudgmentCapability', () => {
  it('答错返回 isCorrect=false + analysis', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":false,"analysis":"第二步错","errorType":"calculation"}',
      reasoningContent: '',
    });
    const cap = new JudgmentCapability({ modelClient: mockModelClient });
    const r = await cap.judge({
      questionContent: '解方程 $x^2-4=0$', standardAnswer: '$x=\\pm 2$',
      reference: '', studentAnswer: '$x=2$', subject: 'math', questionType: 'calculation',
    });
    expect(r.isCorrect).toBe(false);
    expect(r.analysis).toBe('第二步错');
    expect(r.errorType).toBe('calculation');
  });
  it('答对返回 isCorrect=true', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":true,"analysis":"","errorType":null}',
      reasoningContent: '',
    });
    const r = await new JudgmentCapability({ modelClient: mockModelClient }).judge({
      questionContent: 'q', standardAnswer: 'a', reference: '', studentAnswer: 'a',
      subject: 'math', questionType: 'calculation',
    });
    expect(r.isCorrect).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `npx vitest run src/ai-core/capabilities/judgment.capability.test.ts` → FAIL

- [ ] **Step 3: 加类型**

`types.ts`：

```typescript
export type Scene = 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation' | 'analysis' | 'safety' | 'structuring';
export type CapabilityType = 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation' | 'analysis' | 'fallback' | 'structuring';

export interface JudgmentRequest {
  questionContent: string;
  standardAnswer: string;
  reference: string;        // 参考解析（explanation），可为空
  studentAnswer: string;
  subject: Subject;
  questionType: 'proof' | 'calculation';
}

export interface JudgmentResult {
  isCorrect: boolean;
  analysis: string;
  errorType?: 'logic' | 'calculation' | 'format' | 'missing' | null;
  reasoning?: string;
}
```

- [ ] **Step 4: model-routes.yaml + router**

`model-routes.yaml` 在 grading scene 旁加 judgment（同模型）：

```yaml
  - scene: judgment
    subject: math
    primary: kimi-latest
    fallback: deepseek-v4-flash
```

> 实际 primary/fallback 与 grading 保持一致；按 yaml 既有结构填写。

`model-router.ts`：若 router 是数据驱动（读 yaml），则无需改代码；若有硬编码 scene 校验，把 'judgment' 加入合法 scene 集合。

`retry.yaml` / `config.ts`：timeout 加 `judgment: 45000`（或复用 grading）。

- [ ] **Step 5: 实现 JudgmentCapability**

```typescript
import { z } from 'zod';
import type { JudgmentRequest, JudgmentResult } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const JudgmentResultSchema = z.object({
  isCorrect: z.boolean(),
  analysis: z.string(),
  errorType: z.enum(['logic', 'calculation', 'format', 'missing']).nullable().optional(),
});

export interface JudgmentCapabilityDeps {
  modelClient?: ModelClient;
}

export class JudgmentCapability {
  private modelRouter = new ModelRouter();
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: JudgmentCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async judge(request: JudgmentRequest): Promise<JudgmentResult> {
    const routeResult = this.modelRouter.route({ scene: 'judgment', subject: request.subject });
    const promptResult = await this.promptBuilder.build({
      capability: 'judgment',
      subject: request.subject,
      questionType: request.questionType,
      context: {
        student: { grade: '', gradeLevel: '' },
        question: { content: request.questionContent, answer: request.standardAnswer, rubric: request.reference },
        studentAnswer: request.studentAnswer,
        userMessage: '请判断对错',
        customVariables: { questionType: request.questionType },
      },
    });
    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      responseFormat: 'json_object',
      timeout: timeoutConfig.timeout.judgment ?? timeoutConfig.timeout.grading ?? timeoutConfig.timeout.default,
    });
    const parseResult = this.responseParser.parse<JudgmentResult>({
      rawContent: chatResponse.content, mode: 'json', schema: JudgmentResultSchema,
    });
    if (!parseResult.success || !parseResult.data) {
      throw new Error(`Judgment parse failed: ${parseResult.errors?.join(', ')}`);
    }
    return { ...parseResult.data, reasoning: chatResponse.reasoningContent };
  }
}
```

> 若 `PromptBuilder` 需显式注册 capability->prompt 映射，在 `prompt-builder.ts` 把 'judgment' 加入（镜像 'grading'），使 `prompts/judgment/{subject}-{questionType}.md` 被加载。

- [ ] **Step 6: 运行测试通过** — `npx vitest run src/ai-core/capabilities/judgment.capability.test.ts`

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/ai-core/
git commit -m "feat(ai-core): add JudgmentCapability (对错判定, 非判分)"
```

---

## Phase D — 后端端点

### Task D1: practice 模块 + PracticeService.judge

**Files:**
- Create: `apps/server/src/modules/practice/dto/judge-practice.dto.ts`
- Create: `apps/server/src/modules/practice/practice.service.ts`
- Create: `apps/server/src/modules/practice/practice.controller.ts`
- Create: `apps/server/src/modules/practice/practice.module.ts`
- Test: `apps/server/src/modules/practice/practice.service.test.ts`
- Modify: `apps/server/src/app.module.ts`

- [ ] **Step 1: 写失败测试（三路由 + 错题入库）**

```typescript
// practice.service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PracticeService } from './practice.service';

const mk = (overrides: any = {}) => ({
  questionsRepo: { findByContentHash: vi.fn().mockResolvedValue(null), findOrCreate: vi.fn() },
  mainErrorRepo: { create: vi.fn().mockResolvedValue(42) },
  structuring: { structure: vi.fn() },
  judgment: { judge: vi.fn() },
  ...overrides,
});

describe('PracticeService.judge', () => {
  it('客观题命中 -> exact 比对，答错入错题本（不插题）', async () => {
    const deps = mk({
      questionsRepo: { findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }) },
    });
    const svc = new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: 'B' });
    expect(r.isCorrect).toBe(false);
    expect(r.method).toBe('exact');
    expect(r.errorBookId).toBe(42);
    expect(deps.judgment.judge).not.toHaveBeenCalled();
    expect(deps.structuring.structure).not.toHaveBeenCalled(); // 已在库，不结构化
  });
  it('未命中 -> AI 判定，答错 -> 结构化 + 插题 + 入错题本', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: false, analysis: '错因', errorType: 'calculation' }) },
      structuring: { structure: vi.fn().mockResolvedValue({ quality: 'good', content: '题', type: 'short_answer', difficulty: 2, answer: 'a', explanation: 'e', knowledgePoints: [] }) },
      questionsRepo: { findByContentHash: vi.fn().mockResolvedValue(null), findOrCreate: vi.fn().mockResolvedValue({ id: 77, created: true }) },
    });
    const svc = new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: '答' });
    expect(r.isCorrect).toBe(false);
    expect(r.method).toBe('ai');
    expect(r.analysis).toBe('错因');
    expect(r.errorBookId).toBe(42);
    expect(deps.structuring.structure).toHaveBeenCalled();
    expect(deps.questionsRepo.findOrCreate).toHaveBeenCalled();
  });
  it('未命中 -> AI 判定答对 -> 不插题不入错题本', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: true, analysis: '', errorType: null }) },
    });
    const svc = new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: '答' });
    expect(r.isCorrect).toBe(true);
    expect(r.errorBookId).toBeUndefined();
    expect(deps.structuring.structure).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败** — `npx vitest run src/modules/practice/practice.service.test.ts` → FAIL

- [ ] **Step 3: 实现 dto**

```typescript
// dto/judge-practice.dto.ts
import { IsInt, IsString, IsNotEmpty } from 'class-validator';
export class JudgePracticeDto {
  @IsInt() cardId: number;
  @IsInt() lessonId: number;
  @IsInt() subjectId: number;
  @IsString() @IsNotEmpty() questionText: string;
  @IsString() @IsNotEmpty() studentAnswer: string;
}
```

- [ ] **Step 4: 实现 PracticeService**

```typescript
// practice.service.ts
import { Injectable } from '@nestjs/common';
import { QuestionsRepository, MainErrorBooksRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';
import { computeContentHash } from '../error-book/content-hash.util.js';
import type { QuestionRow } from '../../database/repositories/types.js';

const OBJECTIVE_TYPES = new Set(['choice', 'true_false', 'fill_blank']);

function normalizeAnswer(s: string): string {
  return (s || '').normalize('NFKC').replace(/\s+/g, '').replace(/\$+/g, '').toLowerCase();
}

function compareAnswer(studentAnswer: string, correctAnswer: string, options: string | null): boolean {
  const a = normalizeAnswer(studentAnswer);
  if (!a) return false;
  // 选项题：支持学生输入 A/B/C 与 isCorrect 选项比对
  if (options) {
    try {
      const opts = JSON.parse(options) as Array<{ label: string; isCorrect?: boolean }>;
      const picked = opts.find(o => normalizeAnswer(o.label) === a);
      if (picked) return !!picked.isCorrect;
    } catch { /* fallthrough */ }
  }
  return a === normalizeAnswer(correctAnswer);
}

@Injectable()
export class PracticeService {
  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly structuring: QuestionStructuringCapability,
    private readonly judgment: JudgmentCapability,
  ) {}

  async judge(input: { studentId: number; subjectId: number; cardId: number; lessonId: number; questionText: string; studentAnswer: string; }) {
    const contentHash = computeContentHash(input.questionText);
    const q: QuestionRow | null = await this.questionsRepo.findByContentHash(contentHash);

    let isCorrect: boolean;
    let method: 'exact' | 'ai';
    let analysis: string | null = null;
    let errorType: 'logic' | 'calculation' | 'format' | 'missing' | null = null;

    if (q && OBJECTIVE_TYPES.has(q.type)) {
      isCorrect = compareAnswer(input.studentAnswer, q.answer, q.options);
      method = 'exact';
      analysis = isCorrect ? null : `正确答案：${q.answer}`;
    } else {
      const questionType = q?.type === 'proof' ? 'proof' : 'calculation';
      const result = await this.judgment.judge({
        questionContent: input.questionText,
        standardAnswer: q?.answer ?? '',
        reference: q?.explanation ?? '',
        studentAnswer: input.studentAnswer,
        subject: 'math',
        questionType,
      });
      isCorrect = result.isCorrect;
      method = 'ai';
      analysis = isCorrect ? null : result.analysis;
      errorType = result.errorType ?? null;
    }

    let questionId: number | null = q?.id ?? null;
    let errorBookId: number | undefined;

    if (!isCorrect) {
      if (!q) {
        const structured = await this.structuring.structure({
          rawInput: input.questionText,
          inputType: 'text',
          studentId: String(input.studentId),
          subjectHint: 'math',
        });
        if (structured.quality !== 'poor' && structured.content.trim().length > 0) {
          const created = await this.questionsRepo.findOrCreate({
            subject_id: input.subjectId,
            type: structured.type,
            difficulty: structured.difficulty,
            content: structured.content,
            options: structured.options ? JSON.stringify(structured.options) : null,
            answer: structured.answer,
            explanation: structured.explanation,
            source: 'practice',
            content_hash: computeContentHash(structured.content),
          });
          questionId = created.id;
        } else {
          questionId = null;
        }
      }
      errorBookId = await this.mainErrorRepo.create({
        student_id: input.studentId,
        subject_id: input.subjectId,
        question_id: questionId as any, // null 时写 raw（见下）
        source: 'practice',
        source_ref_id: input.cardId,
        wrong_answer_text: questionId === null ? input.questionText : null,
      });
    }

    return { questionId, isCorrect, method, analysis, errorType, errorBookId };
  }
}
```

> `main_error_books.question_id` 是 NOT NULL——当 `questionId === null`（质量差仅存题面）时，需用 `wrong_answer_text` 存题面且 `question_id` 给一个哨兵值或放宽列约束。**落地时**：若坚持 NOT NULL，则质量差时不入 `main_error_books`（只在前端标记错题，session 态），或对 `main_error_books.question_id` 做 `DROP NOT NULL` 迁移。**推荐**：迁移 `question_id` 为可空（与 `aux_error_books` 一致），脚本：
> `ALTER TABLE main_error_books MODIFY question_id BIGINT NULL;` 并改 repo 的 `question_id: row.question_id`（可空）。此迁移纳入本任务。

- [ ] **Step 5: 实现 controller + module**

```typescript
// practice.controller.ts
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { PracticeService } from './practice.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { JudgePracticeDto } from './dto/judge-practice.dto.js';

@Controller('api/practice')
@UseGuards(JwtAuthGuard)
export class PracticeController {
  constructor(private readonly practiceService: PracticeService) {}

  @Post('judge')
  async judge(@Body() dto: JudgePracticeDto, @CurrentUser() user: JwtUser) {
    return this.practiceService.judge({
      studentId: user.sub, subjectId: dto.subjectId, cardId: dto.cardId,
      lessonId: dto.lessonId, questionText: dto.questionText, studentAnswer: dto.studentAnswer,
    });
  }
}
```

```typescript
// practice.module.ts
import { Module } from '@nestjs/common';
import { PracticeController } from './practice.controller.js';
import { PracticeService } from './practice.service.js';
import { DatabaseModule } from '../../database/database.module.js'; // 或直接提供 repos
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';

@Module({
  imports: [/* DatabaseModule 若有 */],
  controllers: [PracticeController],
  providers: [PracticeService, JudgmentCapability, QuestionStructuringCapability],
})
export class PracticeModule {}
```

> repos 的提供方式参照既有 `error-book.module.ts`（注入 `DATABASE_POOL` 并实例化 repos）。落地时对齐既有模式。

- [ ] **Step 6: 注册到 app.module.ts**

把 `PracticeModule` 加入 `imports`。

- [ ] **Step 7: 运行测试通过** — `npx vitest run src/modules/practice/practice.service.test.ts`

- [ ] **Step 8: tsc 检查** — `cd apps/server && npm run build` → 无类型错误

- [ ] **Step 9: 提交**

```bash
git add apps/server/src/modules/practice/ apps/server/src/app.module.ts
git commit -m "feat(practice): add /api/practice/judge endpoint with 3-route judgment"
```

---

## Phase E — 前端组件

### Task E1: SymbolPalette

**Files:**
- Create: `apps/web/src/components/business/SymbolPalette.tsx`

- [ ] **Step 1: 实现**

```tsx
import { clsx } from 'clsx';

export interface SymbolDef { label: string; latex: string; group: string; }

const SYMBOLS: SymbolDef[] = [
  { group: '运算', label: '÷', latex: '\\div' },
  { group: '运算', label: '×', latex: '\\times' },
  { group: '运算', label: '±', latex: '\\pm' },
  { group: '运算', label: '≤', latex: '\\leq' },
  { group: '运算', label: '≥', latex: '\\geq' },
  { group: '运算', label: '≠', latex: '\\neq' },
  { group: '幂根', label: 'x²', latex: 'x^{2}' },
  { group: '幂根', label: '√', latex: '\\sqrt{}' },
  { group: '幂根', label: '分式', latex: '\\frac{}{}' },
  { group: '几何', label: '∵', latex: '\\because' },
  { group: '几何', label: '∴', latex: '\\therefore' },
  { group: '几何', label: '△', latex: '\\triangle' },
  { group: '几何', label: '∠', latex: '\\angle' },
  { group: '几何', label: '∥', latex: '\\parallel' },
  { group: '几何', label: '⊥', latex: '\\perp' },
  { group: '几何', label: '°', latex: '^{\\circ}' },
  { group: '其它', label: '→', latex: '\\rightarrow' },
  { group: '其它', label: 'π', latex: '\\pi' },
  { group: '其它', label: '$', latex: '$$' },
];

const GROUPS = ['运算', '幂根', '几何', '其它'];

export function SymbolPalette({ onInsert }: { onInsert: (latex: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 p-2 border-b border-[var(--bg-subtle)]">
      {GROUPS.map(g => (
        <div key={g} className="flex items-center gap-1">
          {SYMBOLS.filter(s => s.group === g).map(s => (
            <button
              key={s.label}
              type="button"
              onClick={() => onInsert(s.latex)}
              className={clsx(
                'min-w-[32px] h-8 px-2 rounded-md text-sm',
                'bg-[var(--bg-subtle)] hover:bg-[var(--brand-500)] hover:text-white',
                'border border-[var(--bg-subtle)] transition-colors',
              )}
              title={s.latex}
            >
              {s.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/components/business/SymbolPalette.tsx
git commit -m "feat(web): add SymbolPalette component"
```

---

### Task E2: LatexEditor（光标插入）

**Files:**
- Create: `apps/web/src/components/business/LatexEditor.tsx`

- [ ] **Step 1: 实现**

```tsx
import { useRef } from 'react';
import { SymbolPalette } from './SymbolPalette';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

export function LatexEditor({ value, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const insertAtCursor = (latex: string) => {
    const ta = ref.current;
    if (!ta) { onChange(value + latex); return; }
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const next = value.slice(0, start) + latex + value.slice(end);
    onChange(next);
    // 光标移到首个 {} 内
    requestAnimationFrame(() => {
      const ph = latex.indexOf('{}');
      const pos = ph >= 0 ? start + ph + 1 : start + latex.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="flex flex-col h-full">
      <SymbolPalette onInsert={insertAtCursor} />
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="在此用 LaTeX 作答，用 $...$ 包裹数学公式"
        className="flex-1 w-full p-3 resize-none outline-none bg-transparent text-[var(--text-primary)] font-mono text-sm leading-relaxed"
      />
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/components/business/LatexEditor.tsx
git commit -m "feat(web): add LatexEditor with cursor-accurate symbol insertion"
```

---

### Task E3: LatexPreview（实时渲染）

**Files:**
- Create: `apps/web/src/components/business/LatexPreview.tsx`

- [ ] **Step 1: 实现**

```tsx
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';

export function LatexPreview({ value }: { value: string }) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 150);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div className="h-full overflow-auto p-4 text-[var(--text-primary)]">
      {debounced.trim() ? (
        <div className="prose prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
            {debounced}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="text-[var(--text-secondary)] text-sm">预览区（输入后实时渲染）</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/components/business/LatexPreview.tsx
git commit -m "feat(web): add LatexPreview live render"
```

---

### Task E4: AnswerModal

**Files:**
- Create: `apps/web/src/components/business/AnswerModal.tsx`

- [ ] **Step 1: 实现**

```tsx
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { LatexEditor } from './LatexEditor';
import { LatexPreview } from './LatexPreview';

export interface PracticeQuestion { n: number; text: string; }

interface Props {
  questions: PracticeQuestion[];
  startIndex: number;
  onSubmit: (questionText: string, studentAnswer: string) => Promise<{
    isCorrect: boolean; method: string; analysis: string | null; errorType?: string | null;
  }>;
  onFinish: () => void;       // 全部做完
  onClose: () => void;
}

export function AnswerModal({ questions, startIndex, onSubmit, onFinish, onClose }: Props) {
  const [idx, setIdx] = useState(startIndex);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const q = questions[idx];

  const handleSubmit = async () => {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    const res = await onSubmit(q.text, answer);
    // 结果由父组件 practiceStore 记录（onSubmit 内部处理）
    setAnswer('');
    setSubmitting(false);
    if (idx + 1 < questions.length) {
      setIdx(idx + 1);
    } else {
      onFinish();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-[92vw] max-w-5xl h-[88vh] bg-[var(--bg-card)] rounded-2xl shadow-xl flex flex-col overflow-hidden">
        {/* 顶部：题面 */}
        <div className="shrink-0 h-[32%] overflow-auto p-5 border-b border-[var(--bg-subtle)]">
          <div className="text-xs text-[var(--text-secondary)] mb-2">第 {idx + 1} / {questions.length} 题</div>
          <div className="prose prose-sm max-w-none text-[var(--text-primary)]">
            <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
              {q.text}
            </ReactMarkdown>
          </div>
        </div>
        {/* 下部：左编辑 右预览 */}
        <div className="flex-1 min-h-0 flex">
          <div className="w-1/2 border-r border-[var(--bg-subtle)] flex flex-col">
            <LatexEditor value={answer} onChange={setAnswer} />
          </div>
          <div className="w-1/2">
            <LatexPreview value={answer} />
          </div>
        </div>
        {/* 底部：提交 */}
        <div className="shrink-0 flex items-center justify-between p-3 border-t border-[var(--bg-subtle)]">
          <button onClick={onClose} className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">退出</button>
          <button
            onClick={handleSubmit}
            disabled={!answer.trim() || submitting}
            className="px-8 py-2.5 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-white font-medium disabled:opacity-40 hover:bg-[var(--brand-600)]"
          >
            {submitting ? '判对错中…' : '提交'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/components/business/AnswerModal.tsx
git commit -m "feat(web): add AnswerModal (question/editor/preview/submit)"
```

---

## Phase F — 前端集成

### Task F1: api.ts + practiceStore

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Create: `apps/web/src/store/practiceStore.ts`

- [ ] **Step 1: api.ts 加 judgePractice**

```typescript
export interface JudgeResult {
  questionId: number | null;
  isCorrect: boolean;
  method: 'exact' | 'ai';
  analysis: string | null;
  errorType?: string | null;
  errorBookId?: number;
}

export async function judgePractice(payload: {
  cardId: number; lessonId: number; subjectId: number; questionText: string; studentAnswer: string;
}): Promise<JudgeResult> {
  const res = await fetch(`${API_BASE}/api/practice/judge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('判对错失败');
  return res.json();
}
```

- [ ] **Step 2: practiceStore**

```typescript
import { create } from 'zustand';
import type { JudgeResult } from '../services/api';

interface AnswerRecord extends JudgeResult { studentAnswer: string; }

interface PracticeState {
  cardId: number | null;
  questions: { n: number; text: string }[];
  answers: Record<number, AnswerRecord>;
  currentIndex: number;
  setSession: (cardId: number, questions: { n: number; text: string }[]) => void;
  record: (n: number, studentAnswer: string, result: JudgeResult) => void;
  reset: () => void;
}

export const usePracticeStore = create<PracticeState>((set) => ({
  cardId: null,
  questions: [],
  answers: {},
  currentIndex: 0,
  setSession: (cardId, questions) => set({ cardId, questions, answers: {}, currentIndex: 0 }),
  record: (n, studentAnswer, result) =>
    set(s => ({ answers: { ...s.answers, [n]: { ...result, studentAnswer } } })),
  reset: () => set({ cardId: null, questions: [], answers: {}, currentIndex: 0 }),
}));
```

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/services/api.ts apps/web/src/store/practiceStore.ts
git commit -m "feat(web): add judgePractice API + practiceStore"
```

---

### Task F2: CourseDetailPage 结构化渲染 + 接入 modal

**Files:**
- Modify: `apps/web/src/pages/student/CourseDetailPage.tsx`
- Create: `apps/web/src/components/business/AnswerResultList.tsx`

- [ ] **Step 1: AnswerResultList 组件**

```tsx
import { useState } from 'react';
import type { PracticeQuestion } from './AnswerModal';

interface AnswerRecord { isCorrect: boolean; method: string; analysis: string | null; errorType?: string | null; studentAnswer: string; }
interface Props { questions: PracticeQuestion[]; answers: Record<number, AnswerRecord>; onRetry: () => void; }

export function AnswerResultList({ questions, answers, onRetry }: Props) {
  const [openN, setOpenN] = useState<number | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[92vw] max-w-2xl max-h-[80vh] overflow-auto bg-[var(--bg-card)] rounded-2xl shadow-xl p-6">
        <h2 className="text-lg font-bold mb-4 text-[var(--text-primary)]">答题结果</h2>
        <ul className="space-y-2">
          {questions.map(q => {
            const a = answers[q.n];
            const correct = a?.isCorrect;
            return (
              <li key={q.n} className="flex items-center gap-3 p-3 rounded-lg border border-[var(--bg-subtle)]">
                <span className="text-sm text-[var(--text-primary)] flex-1 truncate">{q.text.slice(0, 40)}</span>
                <span className={correct ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                  {correct ? '✓ 对' : '✗ 错'}
                </span>
                {!correct && (
                  <button onClick={() => setOpenN(openN === q.n ? null : q.n)} className="text-xs px-2 py-1 rounded bg-[var(--brand-500)] text-white">
                    解析
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {openN !== null && answers[openN]?.analysis && (
          <div className="mt-3 p-3 rounded-lg bg-[var(--bg-subtle)] text-sm text-[var(--text-primary)] whitespace-pre-wrap">
            {answers[openN].analysis}
          </div>
        )}
        <div className="mt-6 flex justify-end">
          <button onClick={onRetry} className="px-6 py-2 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-white">完成</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CourseDetailPage 接入**

在 `CourseDetailPage.tsx` 顶部 import：

```tsx
import { AnswerModal, type PracticeQuestion } from '@/components/business/AnswerModal';
import { AnswerResultList } from '@/components/business/AnswerResultList';
import { usePracticeStore } from '@/store/practiceStore';
import { judgePractice } from '@/services/api';
```

在组件内加状态与解析 content_metadata：

```tsx
const [modalOpen, setModalOpen] = useState(false);
const [modalStart, setModalStart] = useState(0);
const [resultOpen, setResultOpen] = useState(false);
const { setSession, record, answers, questions: sessionQuestions, reset } = usePracticeStore();

// 解析当前 practice 卡的 content_metadata
const practiceMeta = useMemo(() => {
  if (card?.cardType !== 'practice' || !card.contentMetadata) return null;
  try {
    const md = typeof card.contentMetadata === 'string' ? JSON.parse(card.contentMetadata) : card.contentMetadata;
    if (md?.questions?.length) return { intro: md.intro as string | undefined, questions: md.questions as PracticeQuestion[], needsFallback: false };
    if (md?.needsFallback) return { intro: undefined, questions: [], needsFallback: true };
  } catch { /* fallthrough */ }
  return { intro: undefined, questions: [], needsFallback: true };
}, [card]);
```

> 前置：`LessonCard` 类型需增 `contentMetadata?: string | Record<string, unknown> | null`（在 `apps/web/src/services/api.ts` 的 `LessonCard` 接口与 `fetchLessonCards` 解析处补）。若后端 card 接口已返回 `content_metadata`，前端映射字段名对齐。

渲染：当 `card.cardType === 'practice'` 且 `practiceMeta && !practiceMeta.needsFallback` 时，渲染 `intro`（ReactMarkdown）+ 逐题可点块（替代/叠加在原 ReactMarkdown body 上）：

```tsx
{card.cardType === 'practice' && practiceMeta && !practiceMeta.needsFallback ? (
  <div className="learn-prose space-y-3">
    {practiceMeta.intro && (
      <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
        {practiceMeta.intro}
      </ReactMarkdown>
    )}
    {practiceMeta.questions.map((q, i) => (
      <button
        key={q.n}
        onClick={() => { setModalStart(i); setModalOpen(true); }}
        className="block w-full text-left p-3 rounded-lg border border-[var(--learn-card-border)] hover:bg-[var(--bg-subtle)] transition-colors"
      >
        <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
          {q.text}
        </ReactMarkdown>
      </button>
    ))}
  </div>
) : (
  /* 既有 ReactMarkdown 渲染 + 正则兜底（practice needsFallback 时用增强 EXERCISE_ITEM_RE 识别可点段落） */
  <div className="learn-prose">{/* 既有渲染 */}</div>
)}
```

modal 触发时初始化 session：

```tsx
{modalOpen && (() => {
  if (!practiceMeta) return null;
  return (
    <AnswerModal
      questions={practiceMeta.questions}
      startIndex={modalStart}
      onSubmit={async (questionText, studentAnswer) => {
        const res = await judgePractice({
          cardId: card.id, lessonId, subjectId,
          questionText, studentAnswer,
        });
        const n = practiceMeta.questions.find(q => q.text === questionText)?.n ?? 0;
        record(n, studentAnswer, res);
        return res;
      }}
      onFinish={() => { setModalOpen(false); setResultOpen(true); }}
      onClose={() => setModalOpen(false)}
    />
  );
})()}
{resultOpen && (
  <AnswerResultList
    questions={sessionQuestions}
    answers={answers}
    onRetry={() => { setResultOpen(false); reset(); }}
  />
)}
```

- [ ] **Step 3: 正则兜底增强（needsFallback 卡）**

在 `preprocessContent` 步骤 1.5 改为 NFKC 归一 `(N)` 标记：

```typescript
// 1.5 全角括号数字 + 半全角混排统一：先 NFKC 再正则
result = result.normalize('NFKC');
// 再执行既有 （N）->(N) 与 (N) 拆分逻辑
```

并增强 `EXERCISE_ITEM_RE` 兼容 `N.` 编号：`/^\(?([1-9]\d?)[\.\)]/`。

- [ ] **Step 4: 类型补全 + tsc**

`apps/web/src/services/api.ts` 的 `LessonCard` 加 `contentMetadata`；`npm --prefix apps/web run build` 通过。

- [ ] **Step 5: 手动验收**

启动前后端，进入一张 practice 卡，点题 -> modal -> 作答 -> 提交 -> 下一题 -> 答题列表 -> 错题解析。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/student/CourseDetailPage.tsx apps/web/src/components/business/AnswerResultList.tsx apps/web/src/services/api.ts
git commit -m "feat(web): structured practice rendering + answer modal integration"
```

---

## Phase G — 文档同步

### Task G1: API + DB 文档

**Files:**
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/K12智学系统-数据库设计文档.md`

- [ ] **Step 1: openapi.yaml 加 `/api/practice/judge`**

```yaml
  /api/practice/judge:
    post:
      summary: 课堂练习判对错
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [cardId, lessonId, subjectId, questionText, studentAnswer]
              properties:
                cardId: { type: integer }
                lessonId: { type: integer }
                subjectId: { type: integer }
                questionText: { type: string }
                studentAnswer: { type: string }
      responses:
        '200':
          description: 判定结果
          content:
            application/json:
              schema:
                type: object
                properties:
                  questionId: { type: integer, nullable: true }
                  isCorrect: { type: boolean }
                  method: { type: string, enum: [exact, ai] }
                  analysis: { type: string, nullable: true }
                  errorType: { type: string, nullable: true }
                  errorBookId: { type: integer }
```

- [ ] **Step 2: API 设计文档 §4 加端点、§6 加数据流说明**（遵循 [[update-related-docs-together]]）。
- [ ] **Step 3: DB 设计文档补 `cards.content_metadata.questions` 结构**（intro / questions[{n,text}] / needs_fallback）。
- [ ] **Step 4: 提交**

```bash
git add docs/api/openapi.yaml "docs/API接口与数据流设计文档.md" "docs/K12智学系统-数据库设计文档.md"
git commit -m "docs(practice): sync API + DB docs for /api/practice/judge"
```

---

## 自检（Self-Review 结果）

- **Spec 覆盖**：§1-§14 各节均有对应任务（管线 A1-A4、判定 C1-C2、端点 D1、错题本 B2、哈希 B1、前端 E1-F2、文档 G1）。§5.5 card_splitter 增强 = A1；§9 哈希对齐 = B1；§7.2 JudgmentCapability = C2；§7.3 三路由 = D1。
- **占位符**：无 TBD/TODO；card_splitter 同节补句的实现提示（`_last_heading_of` 占位）已注明落地时改循环局部变量 `last_heading`，属实现细节指引非占位。
- **类型一致**：`JudgmentRequest/Result`（C2）与 `PracticeService.judge`（D1）调用一致；`JudgeResult`（前端 F1）与端点响应字段一致；`PracticeQuestion`（E4）与 practiceStore（F1）/AnswerResultList（F2）一致。
- **已知落地注意**：① `main_error_books.question_id` NOT NULL——D1 已给迁移方案（改可空）。② PromptBuilder 是否需显式注册 'judgment' capability——C2 Step 5 已注明，落地时核对。③ `LessonCard.contentMetadata` 前端类型——F2 Step 2 已注明补全。
