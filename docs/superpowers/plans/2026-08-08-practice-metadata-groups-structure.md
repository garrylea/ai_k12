# 练习卡 content_metadata 从扁平改为分组结构

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 将 practice 卡 `content_metadata` 从 `{intro, questions:[]}` 扁平结构改为 `{groups: [{intro, questions:[]}]}` 分组结构，支持一卡多题干+多题组

**Architecture:** 数据模型从"一个 intro + 一个 questions 数组"变为"一个 groups 数组，每组独立 intro + questions"。每个 group 内 `n` 保持 number（组内题号），前端用 `"groupIdx-n"` 复合键避免不同组题号冲突。AnswerModal 仍显示顺序编号 1..N。

**Tech Stack:** Python 3 (pytest), TypeScript/React (Vite), MySQL

---

## 变更范围总览

```
labeler prompt (groups 输出)
  → card_labeler.py (LabelResult.groups 解析)
    → extract_cli.py (content_metadata 组装)
      → publish_cli (追加 images, 不改)
        → db_loader.py (build_content_metadata / rebuild_practice_content / _insert_card)
          → MySQL cards.content_metadata
            → API 透传 JSON
              → 前端 (api.ts types / practiceMeta / practiceStore / 渲染)
```

涉及 8 个文件。

---

### Task 1: Labeler prompt @ `textbook_cards.txt`

**Files:**
- Modify: `tools/data-refinery/src/prompts/textbook_cards.txt`

**变更：** 在已有提示词中增量编辑（遵循 [[incremental-edit-prompt-files]]），将 practice 卡输出格式从 flat `intro`+`questions` 改为 `groups`。

1. 输出示例从：
```json
{"items":[{"card_type":"practice","intro":"解下列方程：","questions":[{"n":1,"text":"..."}]}]}
```
改为：
```json
{"items":[{"card_type":"practice","groups":[{"intro":"解下列方程：","questions":[{"n":1,"text":"(1) $5x^{2}-1=4x$"}]}]}]}
```

2. 将 `【questions / intro -- 仅 practice 卡】` 节改为 `【groups -- 仅 practice 卡】`：
```
当 card_type 为 "practice" 时，额外输出 "groups" 数组。每组包含：
- "intro"：该组题前的说明/要求文字（无则省略）
- "questions"：该组每道可作答的题，{"n": 题号, "text": 题面原文}，题号从 1 开始
- 当 practice 卡有多个题干各自带题时（如"1. 解方程：(1)...(2)..." + "2. 列方程：(1)...(2)..."），拆为多个 group
- 单一题干的普通练习卡使用单个 group
其余 card_type 不输出 groups
```

3. 删除旧的 `"intro"` 和 `"questions"` 输出说明（已合并到 groups）。

---

### Task 2: card_labeler.py 解析

**Files:**
- Modify: `tools/data-refinery/src/card_labeler.py`
- Modify: `tools/data-refinery/tests/test_card_labeler.py`

**变更：**

1. **`LabelResult` dataclass**（line 25-34）：删除 `intro` 和 `questions` 字段，新增：
```python
groups: list[dict] | None = None  # [{"intro": str|None, "questions": [{"n":int,"text":str}]}]
```

2. **`label()` 解析逻辑**（lines 82-109）：将 `item.get("intro")` / `item.get("questions")` 替换为解析 `item.get("groups")`：
```python
raw_groups = item.get("groups")
if card_type == "practice" and isinstance(raw_groups, list):
    groups = []
    for g in raw_groups:
        g_intro = g.get("intro") if isinstance(g.get("intro"), str) and g.get("intro") else None
        g_qs = []
        for q in g.get("questions") or []:
            if not isinstance(q, dict): continue
            try:
                n = int(q.get("n", 0))
                if n < 1: continue
                text = q.get("text")
                if not isinstance(text, str) or not text: continue
                g_qs.append({"n": n, "text": text})
            except (TypeError, ValueError): continue
        if g_qs:
            groups.append({"intro": g_intro, "questions": g_qs})
    label.groups = groups if groups else None
```

3. **测试更新**：所有测试中的 fake LLM 响应从 `"intro"`/`"questions"` 改为 `"groups"` 格式。新增多 group 测试。`QuestionMarker` 可删除（不再使用）。

---

### Task 3: extract_cli.py 组装

**Files:**
- Modify: `tools/data-refinery/src/extract_cli.py`

**变更**（lines 369-379）：将 content_metadata 组装从 flat 改为 groups：
```python
if label.card_type == "practice":
    md_init: dict = {}
    if label.groups is not None:
        md_init["groups"] = label.groups
    if md_init:
        content_metadata = md_init
```

---

### Task 4: db_loader.py 三大函数

**Files:**
- Modify: `tools/data-refinery/src/db_loader.py`
- Modify: `tools/data-refinery/tests/test_db_loader.py`

**变更：**

#### 4a. `build_content_metadata()` 签名和逻辑

从 `(intro, questions, card_content, existing)` 改为 `(groups, card_content, existing)`：
```python
def build_content_metadata(groups: list[dict] | None, card_content: str,
                           existing: dict | None) -> dict:
    md = dict(existing or {})
    if groups is not None:
        valid_groups = []
        for g in groups:
            valid_qs = [q for q in g.get("questions", [])
                        if question_text_valid(q.get("text", ""), card_content)]
            if valid_qs:
                g2 = {"questions": valid_qs}
                if g.get("intro"):
                    g2["intro"] = g["intro"]
                valid_groups.append(g2)
        if valid_groups:
            md["groups"] = valid_groups
            md["needs_fallback"] = False
        else:
            md.pop("groups", None)
            md["needs_fallback"] = True
    return md
```

#### 4b. `rebuild_practice_content()` 签名和逻辑

从 `(intro, questions)` 改为 `(groups)`：
```python
def rebuild_practice_content(groups: list[dict]) -> str:
    parts: list[str] = []
    for g in groups:
        if g.get("intro") and g["intro"].strip():
            parts.append(g["intro"].strip())
        for q in g.get("questions", []):
            text = q.get("text", "")
            if text.strip():
                parts.append(text.strip())
    return "\n\n".join(parts)
```

#### 4c. `_insert_card()` 更新

将 check 从 `cm.get("intro") or cm.get("questions")` 改为 `cm.get("groups")`，并更新调用签名：
```python
if cm and cm.get("groups") is not None:
    groups = cm.get("groups")
    existing = {k: v for k, v in cm.items() if k != "groups"}
    cm = build_content_metadata(groups, card_content, existing)
    validated_groups = cm.get("groups") if cm else None
    if card_type == "practice" and validated_groups:
        card_content = rebuild_practice_content(validated_groups)
```

#### 4d. 测试更新

- `TestBuildContentMetadata`：所有测试改为传 `groups=[{...}]`。新增 `test_multi_group_valid`（两组都有效）和 `test_one_group_invalid`（一组无效一组有效）
- `TestRebuildPracticeContent`：所有测试改为传 `groups=[{...}]`。新增 `test_multi_group_rebuild`（两组各有 intro+questions）

---

### Task 5: 前端类型更新

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Modify: `apps/web/src/components/business/AnswerModal.tsx`
- Modify: `apps/web/src/store/practiceStore.ts`

**变更：**

#### 5a. `api.ts` - 新增类型
```typescript
export interface PracticeGroupMeta {
  intro?: string;
  questions: PracticeQuestionMeta[];
}

export interface CardMetadata {
  // ... existing fields (images, layout_hint, override_scroll, needs_fallback)
  groups?: PracticeGroupMeta[];  // NEW
  // OLD fields kept for migration compat, remove after migration verified:
  intro?: string;
  questions?: PracticeQuestionMeta[];
}
```

#### 5b. `AnswerModal.tsx` - PracticeQuestion n 改为 string
```typescript
export interface PracticeQuestion { n: string; text: string; }
```

#### 5c. `practiceStore.ts` - 全部 key 改为 string
```typescript
interface PracticeState {
  questions: { n: string; text: string }[];
  answers: Record<string, AnswerRecord>;
  setSession: (cardId: number, questions: { n: string; text: string }[]) => void;
  record: (n: string, studentAnswer: string, result: JudgeResult) => void;
}
```

---

### Task 6: 前端渲染逻辑 @ CourseDetailPage.tsx

**Files:**
- Modify: `apps/web/src/pages/student/CourseDetailPage.tsx`

**变更：**

#### 6a. `practiceMeta` useMemo（lines 273-279）

从 groups 中提取问题，生成复合键 `"groupIdx-questionN"`：
```typescript
const practiceMeta = useMemo(() => {
  if (card?.cardType !== 'practice' || !card.metadata) return null;
  const md = card.metadata;
  if (md.groups?.length) {
    const flatQuestions: PracticeQuestion[] = [];
    md.groups.forEach((g, gi) => {
      g.questions.forEach(q => {
        flatQuestions.push({ n: `${gi}-${q.n}`, text: q.text });
      });
    });
    return { groups: md.groups, questions: flatQuestions, needsFallback: false };
  }
  if (md.needs_fallback) return { groups: null, questions: [], needsFallback: true };
  return { groups: null, questions: [], needsFallback: true };
}, [card]);
```

#### 6b. 结构化渲染（lines 558-598）

多 group 时，每组渲染自己的 intro + questions；单 group 时保持现有逻辑：
```tsx
if (isStructured) {
  const groups = practiceMeta?.groups;
  if (groups && groups.length > 1) {
    // 多 group：每组独立 intro + questions
    return (
      <div className="learn-prose space-y-6">
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.intro && <ReactMarkdown ...>{g.intro}</ReactMarkdown>}
            {g.questions.map((q) => {
              const key = `${gi}-${q.n}`;
              const answered = answers[key];
              return <button key={key} onClick={() => handleOpenModal(...)}>...</button>;
            })}
          </div>
        ))}
      </div>
    );
  }
  // 单 group：现有渲染逻辑（key 已为 "0-n"）
}
```

#### 6c. `fallbackPractice` - 兜底路径

保持正则提取，questions 也使用 `"0-n"` 复合键，groups 为单元素数组。

---

### Task 7: 数据库迁移脚本

**Files:**
- Create: `tools/data-refinery/src/migrate_flat_to_groups.py`

将现有 practice 卡的扁平 `content_metadata` 包装为 groups 结构：
```python
# 对每张 practice 卡：
old = json.loads(content_metadata)
if "groups" in old: continue  # 幂等
groups = []
if old.get("questions"):
    groups.append({
        "intro": old.get("intro"),
        "questions": old["questions"],
    })
if groups:
    new_meta = {k: v for k, v in old.items() if k not in ("intro", "questions")}
    new_meta["groups"] = groups
    UPDATE cards SET content_metadata = json.dumps(new_meta) WHERE id = ...
```

**运行：**
```bash
cd tools/data-refinery && python src/migrate_flat_to_groups.py
```

---

### Task 8: 更新 backfill_practice_content.py

**Files:**
- Modify: `tools/data-refinery/backfill_practice_content.py`

从 `cm.get("groups")` 读取，调 `rebuild_practice_content(groups)`。

---

### Task 9: ID=441 端到端验证

1. 运行迁移脚本（ID=441 的 flat metadata → groups）
2. 调 `rebuild_practice_content` 更新 content
3. 调 LLM labeler 重新标注（验证 groups 输出）
4. 检查前端渲染：每个 group 的 intro + 每题可点击

---

### Task 10: 文档更新

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-practice-answer-judging-design.md` — 更新 §5.1/§5.2/§6.1 中的数据结构
- Modify: `docs/K12智学系统-Card内容生成与渲染设计文档.md` — 新增 §9.5 记录 groups 结构设计

---

## 新旧结构对照

```json
// OLD - 扁平结构（问题：双题干挤一个 intro，题号 n 冲突）
{
  "intro": "1. 解方程：\n\n2. 列方程：",
  "questions": [
    {"n":1, "text":"(1) $5x^2-1=4x$"},
    {"n":2, "text":"(2) $4x^2=81$"},
    {"n":1, "text":"(1) 4个正方形面积之和是25..."},  // n 冲突！
    {"n":2, "text":"(2) 矩形长比宽多2..."}
  ],
  "images": [...]
}

// NEW - 分组结构
{
  "groups": [
    {
      "intro": "1. 将下列方程化成一元二次方程的一般形式...",
      "questions": [
        {"n":1, "text":"(1) $5x^2-1=4x$"},
        {"n":2, "text":"(2) $4x^2=81$"},
        {"n":3, "text":"(3) $4x(x+2)=25$"},
        {"n":4, "text":"(4) $(3x-2)(x+1)=8x-3$"}
      ]
    },
    {
      "intro": "2. 根据下列问题，列出关于 $x$ 的方程...",
      "questions": [
        {"n":1, "text":"(1) 4个正方形面积之和是25..."},
        {"n":2, "text":"(2) 矩形长比宽多2..."},
        {"n":3, "text":"(3) 把长为1的木条分成两段..."}
      ]
    }
  ],
  "images": [...]
}
```

## 执行顺序

Task 1 → 2 → 3 → 4（管线） → 5 → 6（前端类型+渲染） → 7（迁移） → 8（backfill 脚本） → 9（验证） → 10（文档）

## 验证

```bash
# 管线测试
cd tools/data-refinery && python -m pytest tests/test_card_labeler.py tests/test_db_loader.py -v

# 前端构建
cd apps/web && npm run build

# 端到端
python src/migrate_flat_to_groups.py          # 迁移 DB
python backfill_practice_content.py --limit 1  # 更新 ID=441 content
python test_labeler_single_card.py --card-id 441  # LLM 验证
# 前端 dev server 检查渲染效果
```
