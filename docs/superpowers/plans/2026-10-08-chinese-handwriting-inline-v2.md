# 语文手写输入交互 v2（内嵌手写板）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用「输入框旁【手写】/【键盘】切换 + 内嵌手写板（识别并追加进输入框）」取代 v1 弹层交互；判题/提交/后端零改动。

**Architecture:** 新组件 `InlineHandwritingPad`（pad + 识别并追加 + 键盘收起，识别文本经 `onRecognized` 交父组件按字段规则追加）；两作答组件改为 openField 互斥的内嵌展开；删除 `HandwritingInputModal`。后端无任何改动。

**Tech Stack:** React 19 + Tailwind；无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-08-chinese-special-handwriting-input-design.md` §0（v2 修订，已获批）。

## Global Constraints

- 后端、判题、`transcribeHandwriting` API **一行不动**。
- 输入框永远可见可编辑（唯一真源）；切换按钮：收起态输入框旁显「手写」，展开态手写板上显「键盘」（文字按钮，无 emoji）。
- 追加规则：多行字段（body）非空先补 `\n`；短字段（author/dynasty/词/翻译）直接拼接。
- 识别成功后面板清空、**保持展开**；展开/收起不丢内容（pad 卸载即丢 → 展开态不得卸载 pad；收起=卸载可接受，墨迹丢弃，因每次展开即新一批）。
- 每组件 openField 互斥（同页至多一个展开）。
- token：`--text-primary/--text-secondary/--bg-subtle/--brand-500/--brand-600/--radius-button/--radius-card/--error`；测试自写 `afterEach(cleanup)`；jsdom stub 同 `DraftWhiteboard.test.tsx:24-39`。

## File Structure

```
apps/web/src/components/business/handwriting/
  InlineHandwritingPad.tsx       — 新：pad + 识别并追加 + 键盘收起（内嵌，非弹层）
  InlineHandwritingPad.test.tsx  — 新
  HandwritingInputModal.tsx      — 删
  HandwritingInputModal.test.tsx — 删
apps/web/src/components/business/dictation/DictationAnswerForm.tsx(+test) — 弹层改内嵌
apps/web/src/components/business/interpretation/SentenceBlock.tsx(+test)  — 弹层改内嵌
```

---

### Task 1: InlineHandwritingPad 组件

**Files:**
- Create: `apps/web/src/components/business/handwriting/InlineHandwritingPad.tsx`
- Test: `apps/web/src/components/business/handwriting/InlineHandwritingPad.test.tsx`

**Interfaces:**
- Consumes: `HandwritingPad`（默认导出 + HandwritingPadHandle）、`transcribeHandwriting(image)`。
- Produces（Task 2 消费）:

```tsx
function InlineHandwritingPad(props: {
  open: boolean;                 // false 渲染 null
  onRecognized(text: string): void; // 识别成功回调（父组件决定追加规则）
  onClose(): void;               // 【键盘】收起
  multiline?: boolean;           // 追加规则：true=非空先补 \n；false=直接拼接 —— 注意：拼接由父组件做，本组件只回调原文；此 prop 仅控制 UI 提示文案，见下
  disabled?: boolean;            // 字段锁定时禁用识别
}): void  // 实际为 React 组件，无 ref 需求
```

（设计裁决：追加规则**由父组件实现**——本组件只把识别原文交给 `onRecognized`，`multiline` 只用于按钮下方提示文案「识别后换行续写 / 识别后直接拼接」。）

- [ ] **Step 1: 写失败测试**

```tsx
// InlineHandwritingPad.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import InlineHandwritingPad from './InlineHandwritingPad';
import { transcribeHandwriting } from '@/services/api';

vi.mock('@/services/api', () => ({ transcribeHandwriting: vi.fn() }));

const PNG = 'data:image/png;base64,AAA';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    clearRect() {}, setTransform() {}, beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, stroke() {},
    save() {}, restore() {}, fillRect() {},
  }) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => {}, configurable: true });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} disconnect() {} };
});

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

/** 渲染展开态，写一笔，返回回调 mock */
function setup(props: Partial<Parameters<typeof InlineHandwritingPad>[0]> = {}) {
  const onRecognized = vi.fn();
  const onClose = vi.fn();
  render(<InlineHandwritingPad open multiline onRecognized={onRecognized} onClose={onClose} {...props} />);
  const canvas = document.querySelector('canvas')!;
  fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 50 });
  fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 160, clientY: 50 });
  fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 160, clientY: 50 });
  return { onRecognized, onClose };
}

it('open=false 渲染 null；open=true 有 canvas 与「键盘」收起钮', () => {
  const { rerender } = render(<InlineHandwritingPad open={false} onRecognized={vi.fn()} onClose={vi.fn()} />);
  expect(document.querySelector('canvas')).toBeNull();
  rerender(<InlineHandwritingPad open onRecognized={vi.fn()} onClose={vi.fn()} />);
  expect(document.querySelector('canvas')).toBeTruthy();
  expect(screen.getByRole('button', { name: '键盘' })).toBeTruthy();
});

it('识别成功：onRecognized 收到原文，面板清空可继续写（识别按钮仍可用）', async () => {
  vi.mocked(transcribeHandwriting).mockResolvedValue({ text: '先天下之忧而忧', modelKey: 'local', elapsedMs: 90 });
  const { onRecognized } = setup();
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  await waitFor(() => expect(onRecognized).toHaveBeenCalledWith('先天下之忧而忧'));
  expect(screen.getByRole('button', { name: '识别并追加' })).not.toBeDisabled();
});

it('识别失败：显示错误可重试，onRecognized 不被调', async () => {
  vi.mocked(transcribeHandwriting).mockRejectedValue(new Error('识别模型调用失败：boom'));
  const { onRecognized } = setup();
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
  expect(onRecognized).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '识别并追加' })).not.toBeDisabled();
});

it('【键盘】收起调 onClose；无笔画时识别禁用；disabled 时识别禁用', () => {
  const { onClose } = setup();
  fireEvent.click(screen.getByRole('button', { name: '键盘' }));
  expect(onClose).toHaveBeenCalled();
  const { rerender } = render(<InlineHandwritingPad open onRecognized={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole('button', { name: '识别并追加' })).toBeDisabled();
  rerender(<InlineHandwritingPad open disabled onRecognized={vi.fn()} onClose={vi.fn()} />);
  // disabled 但 pad 仍有笔画？无笔画 + disabled 都禁用 —— 本条断言 disabled prop 生效
  expect(screen.getByRole('button', { name: '识别并追加' })).toBeDisabled();
});
```

（最后一个用例第二条 rerender 后 pad 无笔画，识别禁用由「无笔画」就成立——为让 disabled 断言有区分度，先画一笔再 rerender disabled。实施时按此调整：写一笔 → rerender disabled → 断言仍禁用且 disabled 传 истин。）

- [ ] **Step 2: 跑失败** → `cd apps/web && npm test -- --run InlineHandwritingPad`，Expected FAIL（组件不存在）

- [ ] **Step 3: 实现**

```tsx
// InlineHandwritingPad.tsx
import { useRef, useState } from 'react';
import HandwritingPad, { type HandwritingPadHandle } from '../HandwritingPad';
import { transcribeHandwriting } from '@/services/api';

/**
 * 内嵌手写板（spec §0 交互 v2）：输入框下方展开，识别文本经 onRecognized 交父组件
 * 按字段规则追加进输入框（本组件不做拼接）。展开/收起由父组件 open 控制。
 */
interface Props {
  open: boolean;
  onRecognized(text: string): void;
  onClose(): void;
  /** 仅影响提示文案：多行字段=「识别后换行续写」，短字段=「识别后直接拼接」 */
  multiline?: boolean;
  disabled?: boolean;
}

export default function InlineHandwritingPad({ open, onRecognized, onClose, multiline = false, disabled = false }: Props) {
  const padRef = useRef<HandwritingPadHandle>(null);
  const [strokes, setStrokes] = useState(0);
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const recognizeDisabled = strokes === 0 || recognizing || disabled;

  const onRecognize = async () => {
    const image = padRef.current?.exportImage();
    if (!image) return;
    setRecognizing(true);
    setError(null);
    try {
      const res = await transcribeHandwriting(image);
      onRecognized(res.text);
      padRef.current?.clear();
      setStrokes(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '识别失败');
    } finally {
      setRecognizing(false);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-card)] bg-white p-3"
      style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--text-secondary)]">
          {multiline ? '可分批书写，识别后换行续写；写完切回「键盘」校对或直接提交' : '写完点识别，结果直接拼进输入框，可切回键盘修改'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[var(--radius-button)] bg-[var(--bg-subtle)] px-3 py-1 text-xs font-bold text-[var(--text-primary)]"
        >
          键盘
        </button>
      </div>

      <HandwritingPad ref={padRef} onStrokesChange={setStrokes} />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRecognize}
          disabled={recognizeDisabled}
          className="rounded-[var(--radius-button)] bg-[var(--brand-500)] px-5 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {recognizing ? '识别中…' : '识别并追加'}
        </button>
        {error && <p className="text-sm text-[var(--error)]">识别失败：{error}（笔迹已保留，可直接重试）</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑通过** → Expected PASS（4 用例）
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/handwriting
git commit -m "feat: 内嵌手写板组件（识别并追加进输入框，取代弹层的第一步）"
```

---

### Task 2: 两页接入改造 + 删除弹层

**Files:**
- Modify: `apps/web/src/components/business/dictation/DictationAnswerForm.tsx`（+test）
- Modify: `apps/web/src/components/business/interpretation/SentenceBlock.tsx`（+test）
- Delete: `apps/web/src/components/business/handwriting/HandwritingInputModal.tsx` / `.test.tsx`

**Interfaces:**
- Consumes: Task 1 `InlineHandwritingPad`（open/onRecognized/onClose/multiline/disabled）。
- Produces: 无（叶子）。

**追加规则（父组件实现）**：
- body：`onChange({ ...value, body: prev.endsWith('\n') || prev === '' ? prev + text : prev + '\n' + text })`——注意函数式取值：用 `onChange` 回调收到的最新 value；若组件 value 可能陈旧，改用「value.body」即时读（两表单的 value 都是父层受控传下的 props，直接读 props.value 即可，与现实现同模式）。
- author/dynasty/terms/translation：`prev + text` 直接拼接。

- [ ] **Step 1: 改测试（先改测试再改实现）**

`DictationAnswerForm.test.tsx`：把 `vi.mock('../handwriting/HandwritingInputModal')` 换成 `vi.mock('../handwriting/InlineHandwritingPad')`，mock 组件暴露两件事：`data-testid="mock-pad"`（点击 = 调 `onRecognized('手写内容')`）与 `data-testid="mock-pad-close"`（点击 = 调 `onClose`）。用例改造：
1. 三字段「手写」按钮存在、disabled 联动（保留原断言）。
2. 点 author 的手写钮 → mock-pad 出现 → 点 mock-pad → `onChange` 收到 `{author:'手写内容'}`（直接拼接：再点一次 mock-pad → `{author:'手写内容手写内容'}`，需用受控 value 重渲染或改用 stateful 宿主——建议测试里用一个带 useState 的宿主组件包 DictationAnswerForm，使 value 真实流转）。
3. body 的手写：预置 value.body='先天下' → 点识别回调 → 断言 body 变为 `'先天下\n手写内容'`（换行规则）；连续两次 → `'先天下\n手写内容\n手写内容'`。
4. 展开态：该字段手写钮隐藏（queryByRole 该按钮为 null 或仅剩另两个字段的钮）+ 出现 mock-pad-close；点 close → 手写钮恢复。
5. 互斥：展开 author 后点 body 的手写钮 → 仅 body 的 pad 打开。

`SentenceBlock.test.tsx`：同款替换 mock（terms 直接拼接、translation 直接拼接；判定 translation 用 mock-pad 出现位置即可），保留既有守卫断言（锁定态按钮禁用）。删除旧 HandwritingInputModal 相关断言（若有）。

- [ ] **Step 2: 跑失败** → `npm test -- --run DictationAnswerForm SentenceBlock`，Expected FAIL

- [ ] **Step 3: 改造 DictationAnswerForm**

结构（伪代码骨架，风格对齐现有文件）：

```tsx
import InlineHandwritingPad from '../handwriting/InlineHandwritingPad';
// 组件体内：
const [padField, setPadField] = useState<Field | null>(null);

// 字段行：input/textarea 照旧；手写切换钮 —— 收起态才渲染：
{padField !== field && (
  <button type="button" onClick={() => setPadField(field)} disabled={disabled}
    className="self-start rounded-[var(--radius-button)] bg-[var(--bg-subtle)] px-3 py-1 text-xs font-bold text-[var(--text-primary)] disabled:opacity-50">
    手写
  </button>
)}

// 组件末尾（替代原 HandwritingInputModal）：
<InlineHandwritingPad
  open={padField !== null}
  multiline={padField === 'body'}
  disabled={disabled}
  onRecognized={(text) => {
    if (!padField) return;
    if (padField === 'body') {
      const prev = value.body;
      onChange({ ...value, body: prev === '' || prev.endsWith('\n') ? prev + text : prev + '\n' + text });
    } else {
      onChange({ ...value, [padField]: value[padField] + text });
    }
  }}
  onClose={() => setPadField(null)}
/>
```

注意：`InlineHandwritingPad open={padField !== null}` 会把三个字段各自按钮的展开统一为「组件末尾一个 pad 实例」——这符合互斥且 pad 不随字段切换卸载（openField 从 author 改点 body 的手写钮时 pad 保持挂载、墨迹丢失？**注意**：openField 变更时 pad 不卸载（组件未卸载），墨迹保留但归属新字段——可接受还是应丢弃？裁决：**切换字段时清空墨迹**（setPadField 前调 `padRef.clear()`）会让组件持有 padRef……简化方案：**给 InlineHandwritingPad 加 `key={padField ?? 'none'}`**，openField 变更即重挂载、墨迹天然清零，无需父组件持有 ref。计划采用 key 方案（在两处 JSX 上都写 `key={padField ?? 'none'}`）。

- [ ] **Step 4: 改造 SentenceBlock**

同款：`padField: string | null`（词名或 'translation'）；词钮在 label 内 input 之后（收起态才渲染）；翻译钮在翻译 label 内；组件末尾 `<InlineHandwritingPad key={padField ?? 'none'} open={padField !== null} multiline={false} disabled={locked} onRecognized={(text) => { if (padField === 'translation') onChange({ ...value, translation: value.translation + text }); else if (padField) onChange({ ...value, terms: { ...value.terms, [padField]: (value.terms[padField] ?? '') + text } }); }} onClose={() => setPadField(null)} />`。

- [ ] **Step 5: 删除弹层**

```bash
git rm apps/web/src/components/business/handwriting/HandwritingInputModal.tsx apps/web/src/components/business/handwriting/HandwritingInputModal.test.tsx
grep -rn "HandwritingInputModal" apps/web/src   # 必须零命中
```

- [ ] **Step 6: 跑通过** → `npm test -- --run DictationAnswerForm SentenceBlock DictationRunPage InterpretationRunPage HandwritingDemoPage HandwritingPad`，Expected 全 PASS

- [ ] **Step 7: Commit**

```bash
git add -A apps/web/src
git commit -m "feat: 手写板内嵌输入框（键盘/手写双模式切换），删除弹层交互"
```

---

### Task 3: 回归 + 手测清单

- [ ] **Step 1**: `cd apps/web && npm test && npm run lint && npx tsc -b --noEmit`；`cd ../server && npm test`（应与合并时持平：1203+/2004 上下，无新增失败；lint 既有 MobilePointsPage error 不算）。
- [ ] **Step 2**: `npm run build`（web）——覆盖 dist 需向用户披露（preview 服务 5173 刷新即得）。
- [ ] **Step 3: 手测清单（用户执行）**
  1. 默写：正文点【手写】→ 输入框变手写板 → 分批写/识别（换行续写）→ 切【键盘】→ 内容在输入框可改 → 提交判题与键盘路径一致。
  2. 作者/朝代手写：直接拼接、可改。
  3. 解释：词/翻译手写直接拼接；锁定态（判后）按钮禁用。
  4. 互斥：同页同时只开一个手写板；切换字段墨迹清零。
  5. 识别失败重试、笔迹保留。
- [ ] **Step 4**: Commit（如有微调）。

---

## Self-Review 结论

- **Spec 覆盖**：§0 全部要点 → Task 1（组件）/Task 2（接入+删除清单逐项）/Task 3（回归手测）；后端零改动符合「一行不动」。
- **占位符**：无 TBD；Step 1 括注的实施调整（disabled 断言先画一笔）已就地写明。
- **类型一致性**：`InlineHandwritingPad` props 与两处消费一致；`HandwritingPadHandle` 沿用 Task 1 既有导出；mock 路径与文件位置一致。
- **关键裁决**：openField 变更用 `key` 重挂载清墨迹（避免父组件持有 padRef）；追加规则在父组件（组件只回调原文）。
