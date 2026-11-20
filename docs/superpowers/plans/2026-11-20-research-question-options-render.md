# Step1 教研编辑抽屉选项卡片渲染 + 点选答案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在教研试卷编辑的选择题抽屉里，把选项渲染成可点选卡片，点选即写标准答案 label；选项 JSON 文本域保留。

**Architecture:** 单文件改动 `ResearchQuestionEditDrawer.tsx`：从实时 `drafts.options` 派生 `choiceOptions`（仅 choice/multi_choice/true_false 且 JSON 合法非空），在 `FIELD_KEYS.map` 中用 `<Fragment>` 在选项 `<EditField>` 前插入 `ChoiceOptionCards`；点选经既有 `setField('answer', ...)` 走原 dirty/保存/审计链路。配套向既有测试文件纯追加 7 个用例。

**Tech Stack:** React 19 + TypeScript + Tailwind + Vitest / @testing-library/react（`apps/web`）。

## Global Constraints

- 只改 `answer` 字段，经既有 `setField('answer', next)`；**不改 options**（无 isCorrect 字段）、不改状态机 / 上传 / 保存 / 审计逻辑。
- 显示范围：仅 `type ∈ {choice, multi_choice, true_false}` 且 `parseChoiceOptions` 返回非空数组；其余题型 / 非法 JSON / 空选项 → 不渲染卡片，且不报错、不弹提示。
- 卡片在上、JSON 文本域在下，并存实时同步；不改 `EditField` 组件本身；不新增「增删选项」UI。
- 单选/判断题：点 label 置 `answer`，再点同一项清空；多选：按 options 出现顺序拼接（A、C → `AC`），再点取消。
- 选中态用 `border-[var(--brand-500)] bg-orange-50` + `aria-pressed`；不用 emoji；仓库无 `--brand-50` token，不新增主题变量。
- `disabled={busy}`（上传/校验/保存中禁点选），与 textarea 一致。
- 选项正文复用既有 `MarkdownBlock`（支持 latex / 图片 / HTML）。
- 不改后端 / DB / openapi.yaml / 判题；不做草稿 / X 关闭行为调整（Step 2 另起）。
- 测试文件必须**纯追加**（既有 30 例一个都不能删）、手动 `afterEach(() => cleanup())` 保留（`globals:false`）。
- 每一步命令在 `apps/web` 执行（除 git 可在仓库根）。

---

### Task 1: 选项解析 + 卡片组件 + 点选写答案（测试 + 实现）

**Files:**
- Modify: `apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx`
- Modify: `apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx`

**Interfaces:**
- Consumes: 既有 `FieldKey`/`Drafts`/`setField`/`busy`/`MarkdownBlock`/`EditField`；测试侧既有 `q()`、`renderDrawer()`、`field(label)`、`within`、`fireEvent`、`screen`。
- Produces: `parseChoiceOptions(type, json): ChoiceOption[] | null`、`toggleAnswer(current, label, multi, options): string`、`ChoiceOptionCards` 组件、`data-testid="choice-options"` 容器、`aria-label="将X设为正确答案"` 按钮。

- [ ] **Step 1: 向既有测试文件末尾追加以下完整 describe（7 个失败用例）**

```tsx
describe('ResearchQuestionEditDrawer 选项卡片点选', () => {
  it('选择题渲染选项卡片，正文走 markdown', () => {
    renderDrawer(q({ options: [
      { label: 'A', text: '**甲**选项' },
      { label: 'B', text: '乙选项' },
    ] }));
    const cards = screen.getByTestId('choice-options');
    expect(within(cards).getByRole('button', { name: '将A设为正确答案' })).toBeInTheDocument();
    expect(within(cards).getByRole('button', { name: '将B设为正确答案' })).toBeInTheDocument();
    expect(within(cards).getByText('甲').tagName).toBe('STRONG');
  });

  it('点 A → 标准答案为 A，A 卡片 aria-pressed=true', () => {
    renderDrawer(q({ answer: '' }));
    fireEvent.click(screen.getByRole('button', { name: '将A设为正确答案' }));
    expect(field('标准答案').value).toBe('A');
    expect(screen.getByRole('button', { name: '将A设为正确答案' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('再点 A → 取消选中，答案清空', () => {
    renderDrawer(q({ answer: '' }));
    const a = screen.getByRole('button', { name: '将A设为正确答案' });
    fireEvent.click(a);
    fireEvent.click(a);
    expect(field('标准答案').value).toBe('');
    expect(a).toHaveAttribute('aria-pressed', 'false');
  });

  it('多选题点 A、C → AC；再点 A → C', () => {
    renderDrawer(q({
      type: 'multi_choice',
      options: [
        { label: 'A', text: '甲' }, { label: 'B', text: '乙' }, { label: 'C', text: '丙' },
      ],
      answer: '',
    }));
    fireEvent.click(screen.getByRole('button', { name: '将A设为正确答案' }));
    fireEvent.click(screen.getByRole('button', { name: '将C设为正确答案' }));
    expect(field('标准答案').value).toBe('AC');
    fireEvent.click(screen.getByRole('button', { name: '将A设为正确答案' }));
    expect(field('标准答案').value).toBe('C');
  });

  it('改选项 JSON → 卡片即时新增 D', () => {
    renderDrawer();
    fireEvent.change(field('选项'), {
      target: { value: JSON.stringify([
        { label: 'A', text: '甲' }, { label: 'B', text: '乙' }, { label: 'D', text: '丁' },
      ]) },
    });
    expect(screen.getByRole('button', { name: '将D设为正确答案' })).toBeInTheDocument();
  });

  it('非选项题（fill_blank + options=null）→ 无卡片', () => {
    renderDrawer(q({ type: 'fill_blank', options: null }));
    expect(screen.queryByTestId('choice-options')).not.toBeInTheDocument();
  });

  it('选项 JSON 非法 → 无卡片且不抛错', () => {
    renderDrawer();
    fireEvent.change(field('选项'), { target: { value: '{ 不是合法 JSON' } });
    expect(screen.queryByTestId('choice-options')).not.toBeInTheDocument();
  });
});
```

> 该文件已 import `describe/it/expect/vi`、`fireEvent/screen/within`、`afterEach/cleanup` 并定义 `q()/renderDrawer()/field()`，无需新增 import。

- [ ] **Step 2: 运行测试，确认 7 个新用例失败、原 30 例通过**

Run: `cd apps/web && npm test -- ResearchQuestionEditDrawer`
Expected: FAIL（7 个新用例找不到 `choice-options` / 按钮；原 30 例 PASS）。

- [ ] **Step 3: 首行 import 补 `Fragment`**

把 `apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx:1`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
```

改为：

```ts
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
```

- [ ] **Step 4: 在 `initialDrafts` 之后、`MarkdownBlock` 之前插入解析与 toggle 逻辑**

在 `ResearchQuestionEditDrawer.tsx` 的 `initialDrafts` 函数结束（约 71 行）后插入：

```ts
/** 选项卡片仅在这三种题型 + 合法非空 options 时渲染；与判题侧选择题类型一致。 */
const CHOICE_TYPES: ReadonlySet<string> = new Set(['choice', 'multi_choice', 'true_false']);

interface ChoiceOption {
  label: string;
  text: string;
}

/** 从实时选项 JSON 派生卡片数据；JSON 正在编辑或不合法时返回 null，不报错。 */
function parseChoiceOptions(type: string, optionsJson: string): ChoiceOption[] | null {
  if (!CHOICE_TYPES.has(type)) return null;
  if (!optionsJson.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(optionsJson);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (
      !parsed.every(
        (o) => o !== null && typeof o === 'object' &&
          typeof (o as { label?: unknown }).label === 'string' &&
          typeof (o as { text?: unknown }).text === 'string',
      )
    ) return null;
    return parsed as ChoiceOption[];
  } catch {
    return null;
  }
}

/** 点选写 answer：单选/判断再点同一项取消；多选按 options 出现顺序拼接。 */
function toggleAnswer(
  current: string,
  label: string,
  multi: boolean,
  options: ChoiceOption[],
): string {
  if (!multi) return current === label ? '' : label;
  const picked = new Set(current.split(''));
  if (picked.has(label)) picked.delete(label);
  else picked.add(label);
  return options.map((o) => o.label).filter((l) => picked.has(l)).join('');
}
```

- [ ] **Step 5: 在 `MarkdownBlock` 之后插入 `ChoiceOptionCards` 组件**

在 `MarkdownBlock` 函数结束（约 89 行）后、`interface EditFieldProps` 之前插入：

```tsx
interface ChoiceOptionCardsProps {
  options: ChoiceOption[];
  answer: string;
  multi: boolean;
  disabled: boolean;
  onSelect: (answer: string) => void;
}

/** 选项卡片：点选即写标准答案（label 字符串），只改 answer，不动 options。 */
function ChoiceOptionCards({ options, answer, multi, disabled, onSelect }: ChoiceOptionCardsProps) {
  return (
    <div data-testid="choice-options" className="mt-2 flex flex-col gap-2">
      {options.map((opt) => {
        const selected = multi ? answer.split('').includes(opt.label) : answer === opt.label;
        return (
          <button
            key={opt.label}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            aria-label={`将${opt.label}设为正确答案`}
            onClick={() => onSelect(toggleAnswer(answer, opt.label, multi, options))}
            className={`w-full flex items-start gap-2 rounded-lg border p-2 text-left text-sm transition-colors ${selected ? 'border-[var(--brand-500)] bg-orange-50' : 'border-gray-200 hover:bg-gray-50'}`}
          >
            <span className="shrink-0 font-semibold" style={{ color: 'var(--text-primary)' }}>{opt.label}</span>
            <span className="min-w-0"><MarkdownBlock text={opt.text} /></span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: 组件内派生 `choiceOptions`**

在 `const [uploadCount, setUploadCount] = useState(0);` 之后插入：

```tsx
  /** 选项卡片数据：从实时 JSON 派生，改 JSON 即时更新；非选择题/非法 JSON → null。 */
  const choiceOptions = parseChoiceOptions(question.type, drafts.options);
```

- [ ] **Step 7: 用 `<Fragment>` 在选项字段前插入卡片**

把 `FIELD_KEYS.map(...)` 整段（约 511–521 行）：

```tsx
      {FIELD_KEYS.map((key) => (
        <EditField
          key={key}
          fieldKey={key}
          value={drafts[key]}
          markdown={MARKDOWN_FIELDS.has(key)}
          busy={busy}
          onChange={(v) => setField(key, v)}
          onFiles={(files) => handleFiles(key, files)}
        />
      ))}
```

替换为：

```tsx
      {FIELD_KEYS.map((key) => (
        <Fragment key={key}>
          {key === 'options' && choiceOptions && (
            <ChoiceOptionCards
              options={choiceOptions}
              answer={drafts.answer}
              multi={question.type === 'multi_choice'}
              disabled={busy}
              onSelect={(next) => setField('answer', next)}
            />
          )}
          <EditField
            fieldKey={key}
            value={drafts[key]}
            markdown={MARKDOWN_FIELDS.has(key)}
            busy={busy}
            onChange={(v) => setField(key, v)}
            onFiles={(files) => handleFiles(key, files)}
          />
        </Fragment>
      ))}
```

> `key` 移到 `Fragment` 上，`EditField` 自身不再带 key。其余字段渲染结果与改前完全一致。

- [ ] **Step 8: 运行测试，确认 37 个用例全过**

Run: `cd apps/web && npm test -- ResearchQuestionEditDrawer`
Expected: PASS（37 passed：原 30 + 新 7）。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx
git commit -m "feat(web): 教研编辑抽屉渲染选项卡片，点选即设标准答案"
```

---

### Task 2: 全量验证

**Files:** 无代码改动（验证用）。

- [ ] **Step 1: 类型检查 + 构建**

Run: `cd apps/web && npm run build`
Expected: 退出码 0，无 tsc 报错（`Fragment`/`ChoiceOption`/`bg-orange-50` 均合法）。

- [ ] **Step 2: 全量单测**

Run: `cd apps/web && npm test`
Expected: PASS（此前基线 191 文件 / 1878 例，本任务追加 7 例 → 1885 例）。

- [ ] **Step 3: lint（仅看自有文件）**

Run: `cd apps/web && npm run lint 2>&1 | grep -i ResearchQuestionEditDrawer || echo "no lint findings in owned files"`
Expected: 无输出/无自有文件告警（全仓既有的 3 个 error 在 tracker.test.ts / markdown.tsx / MobilePointsPage.test.tsx，与本任务无关）。

- [ ] **Step 4: 文档同步检查**

本任务不改 API / 数据流，无需同步 openapi.yaml 或 API 设计文档。若实现偏离 spec（显示范围、拼接顺序、选中态样式），回到 `docs/superpowers/specs/2026-11-20-research-question-options-render-design.md` 修订后再收尾。

---

## Self-Review（写完计划后已执行）

- **Spec 覆盖**：§1 解析 → Task 1 Step 4/6；§2 卡片 UI + 渲染位置 + `Fragment` import → Step 3/5/7；§3 toggle 语义 → Step 4/5；§4 边界（实时同步/切题/busy/异常答案/无选项题）→ Step 4/5/6/7 + 测试 5/6/7；§5 测试 7 例 → Step 1；手测清单 → Task 2 说明；§6 不在范围 → Global Constraints；§7 涉及文件 → Task 1 Files。无遗漏。
- **Placeholder 扫描**：无 TBD / TODO / "similar to Task N"；每个代码步骤给出完整代码，`...` 仅出现在 spec 原文的示意片段，Task 内均写全。
- **类型一致性**：`ChoiceOption`、`parseChoiceOptions`、`toggleAnswer`、`ChoiceOptionCardsProps`、`choiceOptions`、`setField('answer', next)`、`data-testid="choice-options"`、`aria-label="将X设为正确答案"` 在定义与使用处完全一致；`FieldKey`、`busy`、`MarkdownBlock` 均为既有符号，未改名。
