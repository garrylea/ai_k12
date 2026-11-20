# 教研编辑抽屉 Step 1：选项卡片渲染 + 点选答案设计

日期：2026-11-20 ｜ 状态：整体方案已与用户确认（四决策均选推荐值）；本文只覆盖 Step 1

> 背景：用户要求「先实现选项的渲染，第二步增加【草稿】功能」。本 spec 只定义 Step 1；
> Step 2（localStorage 自动暂存草稿 + X 关闭行为调整）另起 spec，待 Step 1 落地后再设计。

## 背景与目标

教研试卷详情的编辑抽屉（`ResearchQuestionEditDrawer`）中，选择题的选项目前只是「选项」字段里的一段 JSON 文本
（`[{"label":"A","text":"..."}]`），标准答案要靠教研员手动填 label。用户要求：把选项渲染出来，
教研员直接点选项即可设定正确答案，减少手填与对照成本。

目标：只做「渲染 + 点选写答案」，不改选项的编辑方式（JSON 文本域保留）、不改后端 / DB / 判题。

## 数据事实（来自代码，勿重新发明）

- `ResearchQuestionDetail`（`apps/web/src/services/api.ts:1151-1165`）：`type: string`、`options: Array<{label:string; text:string}> | null`、`answer: string`。
- 答案存的是 **label 字符串**：单选 `"B"`，多选拼接且按字母序（`"AC"`）——与现有
  `QuestionRunner.tsx:414-421` 的 `toggleMulti` 完全一致（`[...picked].sort().join('')`，注释说明与判题侧集合比对一致）。
- `options` **没有 isCorrect 字段**（`tools/db/schema.sql` 的 questions 表 + `parse-options.util.ts`）；
  所以点选只能改 `answer`，绝不写 `options`。
- `type` 字符串集合（`apps/server/src/ai-core/capabilities/freeform-tag.capability.ts:13`）：
  `choice / multi_choice / true_false / fill_blank / short_answer / proof / calculation`。
- 抽屉已有 `MarkdownBlock`（`ResearchQuestionEditDrawer.tsx:75-89`）复用 `@/components/markdown` 的
  插件与组件，支持 latex / 图片 / HTML；选项正文可直接复用它。
- 选项 JSON 文本域**故意不在** `MARKDOWN_FIELDS`（`:53-55`）：给它上传按钮会把 `![图N](url)` 写进 JSON，
  使题目不可保存（注释 `:51-52` + 拖拽守卫 `:146,159-163`）。本 spec 不触碰这个约束。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 选项 UI | 卡片在上、原 JSON 文本域在下，并存且实时同步；不改选项的编辑能力 |
| 点选行为 | 点选即写 `answer`：单选/判断题点一项置 label（再点取消）；多选点多项拼接排序（再点取消） |
| 显示范围 | 仅 `type ∈ {choice, multi_choice, true_false}` 且 options 解析为非空数组时显示卡片；其余题型不显示 |
| 数据写入 | 只改 `answer` 字段，经既有 `setField('answer', ...)` 走同一条 dirty / 保存链路 |
| 范围 | 不改后端 / DB / 判题；草稿功能不在本 spec |

## 1. 选项解析

在组件内用**普通变量**在渲染期派生（不用 `useMemo`——依赖 JSON 字符串解析极快，不值得引入依赖数组；也不要写进 `draftsRef`）：

```ts
const CHOICE_TYPES: ReadonlySet<string> = new Set(['choice', 'multi_choice', 'true_false']);

function parseChoiceOptions(type: string, optionsJson: string): Array<{label: string; text: string}> | null {
  if (!CHOICE_TYPES.has(type)) return null;
  if (!optionsJson.trim()) return null;
  try {
    const parsed = JSON.parse(optionsJson) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((o) => o && typeof o === 'object' &&
        typeof (o as {label?: unknown}).label === 'string' &&
        typeof (o as {text?: unknown}).text === 'string')) return null;
    return parsed as Array<{label: string; text: string}>;
  } catch {
    return null; // JSON 正在编辑、暂不合法 → 不显示卡片，文本域照常可改
  }
}
```

关键点：
- 从 `drafts.options`（实时值）解析，不从 `question.options`（原值）——改 JSON 时卡片即时更新。
- 解析失败 / 非选择题 / 空选项 → 返回 `null`，卡片区不渲染；不报错、不弹提示（教研员正在打字是常态）。
- label 重复不做去重校验：后端已有校验（multi_choice 重复 label 会拒），前端只负责显示与写答案。

## 2. 卡片 UI

新组件 `ChoiceOptionCards`（可放同文件内，因只此一处使用，YAGNI），props：

```ts
{
  options: Array<{label: string; text: string}>;
  answer: string;          // drafts.answer
  multi: boolean;          // type === 'multi_choice'
  disabled: boolean;       // busy（上传/校验/保存中）时禁用点选
  onSelect: (answer: string) => void;
}
```

渲染位置：在 `FIELD_KEYS.map(...)` 里用 `<Fragment key={key}>` 包一层，当 `key === 'options'` 且
`choiceOptions !== null` 时，在 `<EditField>` **之前**渲染卡片区——这样卡片在上、JSON 文本域在下，
且**无需改 `EditField` 组件本身**。结构：

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
    <EditField ... />
  </Fragment>
))}
```

卡片区自身结构：

```tsx
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
```

实现需在首行 import 中补 `Fragment`（`import { Fragment, useCallback, useEffect, useRef, useState } from 'react'`）。

要点：
- 图标/选中态只用**边框色 + 背景色 + label 徽标**表达，不用 emoji；`aria-pressed` 供读屏。
- 选项正文走 `MarkdownBlock`，与题干/解析预览一致（latex、图片、HTML 均可）。
- `MarkdownImg` 的图片点击已 `stopPropagation`（`markdown.tsx:562-564`），放大会误触选答案的问题不存在。
- `disabled={busy}`：上传/校验/保存期间禁止点选，与现有 textarea `disabled={busy}` 一致。
- 选中态用 Tailwind 内置 `bg-orange-50` + `border-[var(--brand-500)]`（brand orange 已是双轨统一色）；
  仓库无 `--brand-50` token，不新增主题变量。

## 3. 点选逻辑

```ts
function toggleAnswer(
  current: string,
  label: string,
  multi: boolean,
  options: Array<{label: string; text: string}>,
): string {
  if (!multi) return current === label ? '' : label; // 单选/判断：再点同一项取消
  const picked = new Set(current.split(''));
  if (picked.has(label)) picked.delete(label);
  else picked.add(label);
  // 按 options 中 label 的出现顺序输出，保证稳定且与判题侧集合比对一致
  return options.map((o) => o.label).filter((l) => picked.has(l)).join('');
}
```

- 结果经既有 `setField('answer', next)` 写回 → `dirty` 自动反映差异，保存校验与审计链路**完全不变**。
- 多选输出按 options 顺序（而非字母排序）即可：判题侧是集合比对（`QuestionRunner` 排序只为显示稳定），
  本设计用 options 顺序更贴合卷面；两者都满足「集合一致」。
- 判断题按单选处理（`multi=false`），label 直接取选项里的值（可能是 `A`/`B` 或 `对`/`错`）。

## 4. 交互细节与边界

- 卡片区与 JSON 文本域双向同步：卡片读 `drafts.options`，点选写 `drafts.answer`；手改 JSON 后卡片立即重渲染。
- 切题：父组件换题时既有 `useEffect`（`:290-304`）重置全部 drafts，卡片随新题 options 重算，无需额外处理。
- 在途上传：卡片 `disabled={busy}`，与 textarea 一致。
- 答案不是任何 label（如手填的「无答案」）：所有卡片均未选中，不报错；点任一卡片即覆盖为 label。
- 空答案 + 点选：`answer` 从 `''` 变为 label，`dirty` 正确置位。
- 无选项题（填空/简答/证明）：`type` 不在集合或 options 为 null → 卡片区不渲染，UI 与现状完全一致。

## 5. 测试

在既有 `ResearchQuestionEditDrawer.test.tsx`（30 个用例，纯追加）新增 `describe('选项卡片点选')`：
1. 选择题 + 非空 options → `getByTestId('choice-options')` 存在，A/B 两张卡片可见，正文 markdown 渲染。
2. 点 A → 「标准答案」textarea 值为 `A`，A 卡片 `aria-pressed="true"`。
3. 再点 A → 答案清空，取消选中。
4. `multi_choice` 点 A、C → 答案为 `AC`（按 options 顺序）；再点 A → `C`。
5. 改「选项」JSON 文本域后卡片即时更新（新增选项 D 出现）。
6. 非选项题（`fill_blank` + options=null）→ 无 `choice-options`。
7. JSON 非法 → 无卡片，且不抛错。

手测清单（不进单测，避免为构造 busy 态引入复杂上传 mock）：
- 上传图片进行中（`busy`）→ 卡片按钮 disabled，与 textarea 一致。
- 点选项后点正式「保存」→ 审计里 `answer` 变更正确落库。

验证：`npm --prefix apps/web test -- --run src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx`
+ `npm --prefix apps/web run build`。

## 6. 不在本次范围

- 不做草稿 / 自动暂存 / X 关闭行为调整（Step 2 另起 spec）。
- 不改选项的编辑方式（JSON 文本域保留，不加「增删选项」UI）。
- 不改 `answer` 文本域（仍可手填）；不引入 isCorrect 字段。
- 不改后端 / DB / openapi.yaml / 判题。
- 不改 `ResearchPaperDetailPage` 与其 stub 测试。

## 7. 涉及文件

修改：
- `apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx`（选项解析 + 卡片组件 + 点选写 answer）
- `apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx`（追加选项卡片用例）

不动：
- 后端 / API / openapi.yaml / schema / migrations
- `QuestionRunner.tsx`（只借鉴其多选 toggle 语义，不改它）
- Step 2 草稿功能的相关代码
