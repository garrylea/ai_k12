# 语文专项手写输入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 语文专项两个作答页（默写/解释）每个输入框加「手写」入口：手写 → 后端大模型转写 → 弹层内校对 → 确认回填；判题/积分流不变。

**Architecture:** 前端把 demo 的 DemoSketchPad 泛化为共享 `HandwritingPad`（屏显笔迹随主题、导出恒白底黑字）+ 新 `HandwritingInputModal`（分批识别追加 + 可编辑校对区）；后端 ai 模块新增学生端点 `POST /api/ai/handwriting/transcribe`，经 `ModelRouter` 按新 scene `'handwriting'` 路由（DB/yaml 配 local 优先、qwen3.8-max 兜底）。

**Tech Stack:** React 19 + Tailwind（web）；NestJS + ai-core ModelRouter/ModelClient（server）；无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-08-chinese-special-handwriting-input-design.md`（已获批）

## Global Constraints

- 判题端点/判题逻辑/积分/错题流**一行不动**；本计划只新增「字怎么进输入框」。
- UI 无 emoji；颜色一律 `var(--token)`（新组件所在中文页现有 token：`--text-primary`、`--text-secondary`、`--bg-subtle`、`--brand-500`、`--brand-600`、`--radius-button`、`--radius-card`、`--error`）。
- 组件测试自写 `afterEach(() => cleanup())`（`globals: false`）；jsdom 无 canvas/pointer capture/ResizeObserver，stub 模式同 `DraftWhiteboard.test.tsx:24-39`。
- `HandwritingService` **不写 `@Injectable()`**（构造参数含对象字面量类型，DI 坑），AIModule 用 `useFactory`。
- LLM 调用 `meta: { capability: 'handwriting_transcribe' }`，**不写 studentId 键**（HTTP 路径 ALS 自动归属学生）；`thinking: false`；timeout 用 `timeoutConfig.timeout.default`（retry.yaml 不加新键）。
- 屏显笔迹颜色读 CSS 变量随主题（`DraftWhiteboard.tsx:515` 模式）；**导出恒白底（#FFFFFF）黑字（#111827）**，scale 2。
- 迁移 SQL 幂等，放 `tools/db/migrations/2026-10-08_handwriting_scene.sql`；不新建表/列，schema.sql 不动。
- API 文档两份必须同步：`docs/API接口与数据流设计文档.md`（主稿）+ `docs/api/openapi.yaml`（本端点为正式 MVP 功能，**要**收进 openapi）。

## File Structure

```
apps/web/src/components/business/
  HandwritingPad.tsx            — 由 pages/dev/DemoSketchPad.tsx git mv 泛化（屏显色随主题）
  HandwritingPad.test.tsx       — 由 DemoSketchPad.test.tsx mv
  handwriting/HandwritingInputModal.tsx     — 弹层：pad + 识别追加 + 校对区 + 确认回填
  handwriting/HandwritingInputModal.test.tsx
  dictation/DictationAnswerForm.tsx         — 3 字段加手写按钮 + 1 个共享弹层
  interpretation/SentenceBlock.tsx          — 词/翻译加手写按钮 + 1 个共享弹层
apps/web/src/pages/dev/
  HandwritingDemoPage.tsx       — 改 import HandwritingPad；DemoSketchPad.tsx/.test.tsx 删除
  HandwritingDemoPage.test.tsx  — mock 路径同步更新
apps/web/src/services/api.ts   — transcribeHandwriting()
apps/server/src/ai-core/types.ts              — Scene union 加 'handwriting'
apps/server/src/ai-core/model-routes.yaml     — handwriting 场景路由
apps/server/src/modules/ai/
  handwriting.service.ts        — 转写 service（ModelRouter + ModelClient）
  handwriting.service.test.ts
  ai.controller.ts              — 加 @Post('handwriting/transcribe')
  ai.module.ts                  — HandwritingService useFactory
tools/db/migrations/2026-10-08_handwriting_scene.sql
docs/API接口与数据流设计文档.md + docs/api/openapi.yaml
```

---

### Task 1: HandwritingPad 泛化 + demo 页迁移

**Files:**
- Modify（git mv）: `apps/web/src/pages/dev/DemoSketchPad.tsx` → `apps/web/src/components/business/HandwritingPad.tsx`
- Modify（git mv）: `apps/web/src/pages/dev/DemoSketchPad.test.tsx` → `apps/web/src/components/business/HandwritingPad.test.tsx`
- Modify: `apps/web/src/pages/dev/HandwritingDemoPage.tsx`（import 改 HandwritingPad）
- Modify: `apps/web/src/pages/dev/HandwritingDemoPage.test.tsx`（mock 模块路径同步）
- Delete: 上述两个旧文件（mv 后自然消失）

**Interfaces:**
- Produces（Task 2/3 消费）：默认导出 `HandwritingPad`，`forwardRef<DemoSketchPadHandle 同名改为 HandwritingPadHandle>`；props `{ onStrokesChange?: (count: number) => void }`；句柄 `{ exportImage(): string | null; clear(): void }` 语义不变。

- [ ] **Step 1: git mv 两个文件**

```bash
git mv apps/web/src/pages/dev/DemoSketchPad.tsx apps/web/src/components/business/HandwritingPad.tsx
git mv apps/web/src/pages/dev/DemoSketchPad.test.tsx apps/web/src/components/business/HandwritingPad.test.tsx
```

- [ ] **Step 2: 改组件名与屏显笔迹颜色**

`HandwritingPad.tsx` 内：
1. 组件函数名与导出：`DemoSketchPad` → `HandwritingPad`（默认导出与 `HandwritingPadHandle` interface 保留原名 `HandwritingPadHandle`）。
2. 屏显笔迹颜色随主题——把 `redraw` 与 `handlePointerDown/Move` 里写死的 `'#111827'` 屏显路径改为读 CSS 变量（**只改屏显，导出路径 `exportImage` 里的 `#FFFFFF`/`#111827` 一字不动**）。redraw 改为（模式同 `DraftWhiteboard.tsx:515`）：

```tsx
const redraw = useCallback(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, BOARD_W, BOARD_H);
  const ink = (getComputedStyle(canvas).getPropertyValue('--text-primary') || '#333').trim();
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  for (const s of strokesRef.current) strokePath(ctx, s);
  if (drawingStrokeRef.current) strokePath(ctx, drawingStrokeRef.current);
}, []);
```

进行中的笔画绘制（`handlePointerDown`/`handlePointerMove` 里的 redraw 前着色）同样删掉硬编码色值，统一由 redraw 里的 ink 着色（把原在 handler 里设 strokeStyle/fillStyle 的行删除即可，strokePath 自身不设色）。
3. 顶部加主题订阅（主题切换时重绘，同 `DraftWhiteboard.tsx:504,1004`）：

```tsx
import { useThemeStore } from '@/store/themeStore';
// 组件体内：
const themeMode = useThemeStore((s) => s.mode);
// redraw 定义之后：
useEffect(() => { redraw(); }, [themeMode, redraw]);
```

- [ ] **Step 3: demo 页与测试改 import**

- `HandwritingDemoPage.tsx`：`import DemoSketchPad, { type DemoSketchPadHandle } from './DemoSketchPad'` → `import HandwritingPad, { type HandwritingPadHandle } from '@/components/business/HandwritingPad'`，JSX 与 ref 类型同步改名。
- `HandwritingDemoPage.test.tsx`：`vi.mock('./DemoSketchPad', ...)` → `vi.mock('@/components/business/HandwritingPad', ...)`，getter 返回键名同步 `default: MockPad`。
- `HandwritingPad.test.tsx`：import 改 `./HandwritingPad`、`type HandwritingPadHandle`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npm test -- --run HandwritingPad HandwritingDemoPage`
Expected: PASS（迁移后用例数不变：pad 3 个 + demo 页 3 个）

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/pages/dev apps/web/src/components/business
git commit -m "refactor: DemoSketchPad 泛化为共享 HandwritingPad（屏显色随主题）"
```

---

### Task 2: api 函数 + HandwritingInputModal 弹层

**Files:**
- Modify: `apps/web/src/services/api.ts`（`judgeDictation`（:1223 附近）之前的语文专项区块里加一段）
- Create: `apps/web/src/components/business/handwriting/HandwritingInputModal.tsx`
- Test: `apps/web/src/components/business/handwriting/HandwritingInputModal.test.tsx`

**Interfaces:**
- Consumes: Task 1 `HandwritingPad`（默认导出 + `HandwritingPadHandle`）；后端 Task 4 端点 `{ text, modelKey, elapsedMs }`（前端只消费 `text`）。
- Produces（Task 3 消费）：`transcribeHandwriting(image: string): Promise<HandwritingTranscribeResult>`（api.ts）；`HandwritingInputModal` props `{ open: boolean; title: string; onConfirm(value: string): void; onClose(): void }`。

- [ ] **Step 1: api.ts 加函数**

在 `judgeDictation` 定义之前插入：

```ts
// --- 语文专项手写输入：手写图 → 大模型转写（2026-10-08，正式学生端点） ---

export interface HandwritingTranscribeResult {
  text: string;
  modelKey: string;
  elapsedMs: number;
}

export function transcribeHandwriting(image: string): Promise<HandwritingTranscribeResult> {
  return fetchApi<HandwritingTranscribeResult>('/ai/handwriting/transcribe', {
    method: 'POST',
    body: JSON.stringify({ image }),
  });
}
```

- [ ] **Step 2: 写弹层失败测试**

```tsx
// apps/web/src/components/business/handwriting/HandwritingInputModal.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import HandwritingInputModal from './HandwritingInputModal';
import { transcribeHandwriting } from '@/services/api';

vi.mock('@/services/api', () => ({ transcribeHandwriting: vi.fn() }));

const PNG = 'data:image/png;base64,AAA';

beforeEach(() => {
  // jsdom 无 canvas 2d（模式同 DraftWhiteboard.test.tsx）
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

/** 渲染打开态弹层，画一笔，返回常用句柄 */
function setup() {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<HandwritingInputModal open title="手写输入：作者" onConfirm={onConfirm} onClose={onClose} />);
  const canvas = document.querySelector('canvas')!;
  fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 50 });
  fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 160, clientY: 50 });
  fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 160, clientY: 50 });
  return { onConfirm, onClose, canvas };
}

it('初始：校对区空，确认填入禁用；识别成功追加到校对区并清空面板', async () => {
  vi.mocked(transcribeHandwriting).mockResolvedValue({ text: '范仲淹', modelKey: 'local', elapsedMs: 100 });
  const { onConfirm } = setup();
  const confirmBtn = screen.getByRole('button', { name: '确认填入' });
  expect(confirmBtn).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  const pad = document.querySelector('canvas')!;
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('范仲淹'));
  // 识别后面板已清空（无笔画 → 识别按钮禁用）
  expect(screen.getByRole('button', { name: '识别并追加' })).toBeDisabled();
  expect(confirmBtn).not.toBeDisabled();
  // 确认回填：onConfirm 收到校对区全文
  fireEvent.click(confirmBtn);
  expect(onConfirm).toHaveBeenCalledWith('范仲淹');
  expect(pad).toBeTruthy();
});

it('分批追加：校对区非空且结尾非换行时自动补换行', async () => {
  vi.mocked(transcribeHandwriting)
    .mockResolvedValueOnce({ text: '先天下之忧而忧', modelKey: 'local', elapsedMs: 90 })
    .mockResolvedValueOnce({ text: '后天下之乐而乐', modelKey: 'local', elapsedMs: 90 });
  const { canvas } = setup();
  const pad = canvas;
  const stroke = () => {
    fireEvent.pointerDown(pad, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 50 });
    fireEvent.pointerUp(pad, { pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 50 });
  };
  stroke();
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('先天下之忧而忧'));
  stroke();
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  await waitFor(() =>
    expect(screen.getByRole('textbox')).toHaveValue('先天下之忧而忧\n后天下之乐而乐'),
  );
});

it('识别失败：显示错误、笔迹保留可重试；成功后错误消失', async () => {
  vi.mocked(transcribeHandwriting)
    .mockRejectedValueOnce(new Error('识别模型调用失败：boom'))
    .mockResolvedValueOnce({ text: '宋', modelKey: 'local', elapsedMs: 80 });
  setup();
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
  // 失败后笔迹保留 → 识别按钮仍可用（重试）
  expect(screen.getByRole('button', { name: '识别并追加' })).not.toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('宋'));
  expect(screen.queryByText(/boom/)).toBeNull();
});

it('open=false 不渲染；onClose 在点关闭时被调', () => {
  const onClose = vi.fn();
  const { rerender } = render(
    <HandwritingInputModal open={false} title="t" onConfirm={vi.fn()} onClose={onClose} />,
  );
  expect(document.querySelector('canvas')).toBeNull();
  rerender(<HandwritingInputModal open title="t" onConfirm={vi.fn()} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalled();
});
```

（实施时若 `screen.getByRole('textbox')` 命中多个可编辑区，给校对区加 `aria-label="校对区"` 并用 `getByRole('textbox', { name: '校对区' }`。）

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/web && npm test -- --run HandwritingInputModal`
Expected: FAIL（组件不存在）

- [ ] **Step 4: 实现弹层组件**

```tsx
// apps/web/src/components/business/handwriting/HandwritingInputModal.tsx
import { useRef, useState } from 'react';
import HandwritingPad, { type HandwritingPadHandle } from '../HandwritingPad';
import { transcribeHandwriting } from '@/services/api';

/**
 * 手写输入弹层（spec 2026-10-08 §4.2）：手写 → 识别 → 校对 → 确认回填。
 * open 控制显隐不卸载：误关后笔迹与校对区保留；「确认填入」是唯一回填路径。
 */
interface Props {
  open: boolean;
  title: string;
  onConfirm(value: string): void;
  onClose(): void;
}

export default function HandwritingInputModal({ open, title, onConfirm, onClose }: Props) {
  const padRef = useRef<HandwritingPadHandle>(null);
  const [strokes, setStrokes] = useState(0);
  const [draft, setDraft] = useState('');
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const recognizeDisabled = strokes === 0 || recognizing;
  const confirmDisabled = draft.trim() === '' || recognizing;

  const onRecognize = async () => {
    const image = padRef.current?.exportImage();
    if (!image) return;
    setRecognizing(true);
    setError(null);
    try {
      const res = await transcribeHandwriting(image);
      setDraft((prev) => {
        if (prev === '') return res.text;
        return prev.endsWith('\n') ? prev + res.text : prev + '\n' + res.text;
      });
      padRef.current?.clear();
      setStrokes(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '识别失败');
    } finally {
      setRecognizing(false);
    }
  };

  const onConfirmClick = () => {
    onConfirm(draft);
    // 回填后清空弹层状态（下次打开是干净的）
    setDraft('');
    setStrokes(0);
    setError(null);
    padRef.current?.clear();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label={title}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-[var(--radius-card)] bg-white p-5 sm:p-6"
        style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black text-[var(--text-primary)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-button)] bg-[var(--bg-subtle)] px-3 py-1 text-sm text-[var(--text-primary)]"
          >
            关闭
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
          <span className="text-xs text-[var(--text-secondary)]">
            可分批书写，识别结果会逐批续到下方校对区
          </span>
        </div>

        {error && <p className="text-sm text-[var(--error)]">识别失败：{error}（笔迹已保留，可直接重试）</p>}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold text-[var(--text-primary)]">校对区（识别结果，可直接修改）</span>
          <textarea
            aria-label="校对区"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            className="w-full p-3 rounded-[var(--radius-button)] bg-white text-[var(--text-primary)] leading-loose outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
            style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
            placeholder="识别结果会出现在这里，请核对修改"
          />
        </label>

        <button
          type="button"
          onClick={onConfirmClick}
          disabled={confirmDisabled}
          className="h-12 rounded-[var(--radius-button)] bg-[var(--brand-600)] text-sm font-bold text-white disabled:opacity-50"
        >
          确认填入
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npm test -- --run HandwritingInputModal`
Expected: PASS（4 用例）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/components/business/handwriting
git commit -m "feat: 手写输入弹层（分批识别追加+校对回填）与 transcribe API"
```

---

### Task 3: 语文专项两页接入

**Files:**
- Modify: `apps/web/src/components/business/dictation/DictationAnswerForm.tsx`（3 字段）
- Modify: `apps/web/src/components/business/interpretation/SentenceBlock.tsx`（词 + 翻译）
- Modify: `apps/web/src/components/business/interpretation/SentenceBlock.test.tsx`（补接入用例）
- Test: `apps/web/src/components/business/dictation/DictationAnswerForm.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 2 `HandwritingInputModal`（props 见上）；两表单自身的受控 value/onChange（**不改对外 Props 签名**）。
- Produces: 无（叶子接入）。

- [ ] **Step 1: 写失败测试**

`DictationAnswerForm.test.tsx`（新建，文件不存在）：

```tsx
// apps/web/src/components/business/dictation/DictationAnswerForm.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import DictationAnswerForm, { type DictationAnswerValue } from './DictationAnswerForm';

vi.mock('../handwriting/HandwritingInputModal', () => ({
  default: ({ open, title, onConfirm }: { open: boolean; title: string; onConfirm: (v: string) => void }) =>
    open ? (
      <button type="button" data-testid="mock-pad-confirm" onClick={() => onConfirm('手写内容')}>
        mock-confirm:{title}
      </button>
    ) : null,
}));

afterEach(() => cleanup());

const VALUE: DictationAnswerValue = { author: '', dynasty: '', body: '' };

function setup(overrides: Partial<React.ComponentProps<typeof DictationAnswerForm>> = {}) {
  const onChange = vi.fn();
  render(<DictationAnswerForm value={VALUE} onChange={onChange} {...overrides} />);
  return { onChange };
}

it('三个字段各有一个「手写」按钮，disabled 联动输入框', () => {
  const { rerender } = setup();
  const buttons = screen.getAllByRole('button', { name: '手写' });
  expect(buttons).toHaveLength(3);
  rerender(<DictationAnswerForm value={VALUE} onChange={vi.fn()} disabled />);
  for (const b of screen.getAllByRole('button', { name: '手写' })) expect(b).toBeDisabled();
});

it('点手写 → 弹层确认 → 值回填到对应字段', () => {
  const { onChange } = setup();
  // 作者
  fireEvent.click(screen.getAllByRole('button', { name: '手写' })[0]);
  fireEvent.click(screen.getByTestId('mock-pad-confirm'));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ author: '手写内容' }));
});
```

`SentenceBlock.test.tsx` 追加 describe（沿用该文件现有 `makeProps` 与 SENTENCE）：

```tsx
vi.mock('../handwriting/HandwritingInputModal', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: (v: string) => void }) =>
    open ? (
      <button type="button" data-testid="mock-pad-confirm" onClick={() => onConfirm('手写释义')}>
        mock-confirm
      </button>
    ) : null,
}));

describe('SentenceBlock — 手写入口', () => {
  it('editing 态每个词与翻译各有手写按钮；judged 态锁定禁用', () => {
    const { rerender } = render(<SentenceBlock {...makeProps()} />);
    expect(screen.getAllByRole('button', { name: '手写' })).toHaveLength(3); // 2 词 + 1 翻译
    rerender(<SentenceBlock {...makeProps({ state: 'judged', result: JUDGED })} />);
    for (const b of screen.getAllByRole('button', { name: '手写' })) expect(b).toBeDisabled();
  });

  it('词的手写确认回填 terms；翻译确认回填 translation', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SentenceBlock {...makeProps({ onChange })} />);
    fireEvent.click(screen.getAllByRole('button', { name: '手写' })[0]);
    fireEvent.click(screen.getByTestId('mock-pad-confirm'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ terms: expect.objectContaining({ '滕子京谪（zhé）守巴陵郡': '手写释义' }) }),
    );
    rerender(<SentenceBlock {...makeProps({ onChange })} />);
    fireEvent.click(screen.getAllByRole('button', { name: '手写' })[2]); // 翻译是最后一个
    fireEvent.click(screen.getByTestId('mock-pad-confirm'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ translation: '手写释义' }));
  });
});
```

（若该文件尚未 import `fireEvent`，在 import 行补上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npm test -- --run DictationAnswerForm SentenceBlock`
Expected: FAIL（按钮不存在）

- [ ] **Step 3: 接入 DictationAnswerForm**

```tsx
// DictationAnswerForm.tsx 改造后全文（文件小，直接给全文）
import { useState } from 'react';
import HandwritingInputModal from '../handwriting/HandwritingInputModal';

export interface DictationAnswerValue {
  author: string;
  dynasty: string;
  body: string;
}

interface Props {
  value: DictationAnswerValue;
  onChange: (next: DictationAnswerValue) => void;
  /** 提交后锁定输入 */
  disabled?: boolean;
}

type Field = 'author' | 'dynasty' | 'body';

const FIELD_TITLE: Record<Field, string> = {
  author: '手写输入：作者',
  dynasty: '手写输入：朝代',
  body: '手写输入：正文',
};

const FIELD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/** 三字段作答（作者 / 朝代 / 正文）——设计 spec §3 决策 5；每字段带手写入口（spec 2026-10-08 §4.3）。 */
export default function DictationAnswerForm({ value, onChange, disabled = false }: Props) {
  const shortInputClass =
    'w-full h-12 px-4 rounded-xl bg-white text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70';
  const [padField, setPadField] = useState<Field | null>(null);

  const padButton = (field: Field) => (
    <button
      type="button"
      onClick={() => setPadField(field)}
      disabled={disabled}
      className="self-start rounded-[var(--radius-button)] bg-[var(--bg-subtle)] px-3 py-1 text-xs font-bold text-[var(--text-primary)] disabled:opacity-50"
    >
      手写
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-bold text-[var(--text-primary)]">作者</span>
          <input
            className={shortInputClass}
            style={FIELD_BORDER}
            value={value.author}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, author: e.target.value })}
            placeholder="例如：范仲淹"
          />
          {padButton('author')}
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-bold text-[var(--text-primary)]">朝代</span>
          <input
            className={shortInputClass}
            style={FIELD_BORDER}
            value={value.dynasty}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, dynasty: e.target.value })}
            placeholder="例如：宋"
          />
          {padButton('dynasty')}
        </label>
      </div>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-bold text-[var(--text-primary)]">正文</span>
        <textarea
          className="w-full min-h-[220px] p-4 rounded-xl bg-white text-[var(--text-primary)] leading-loose outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70"
          style={FIELD_BORDER}
          value={value.body}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, body: e.target.value })}
          placeholder="默写整篇正文（标点与空格不计）"
        />
        {padButton('body')}
      </label>

      <HandwritingInputModal
        open={padField !== null}
        title={padField ? FIELD_TITLE[padField] : ''}
        onConfirm={(v) => {
          if (padField) onChange({ ...value, [padField]: v });
          setPadField(null);
        }}
        onClose={() => setPadField(null)}
      />
    </div>
  );
}
```

- [ ] **Step 4: 接入 SentenceBlock**

`SentenceBlock.tsx`（改动点，其余不动）：

1. 顶部加：

```tsx
import { useState } from 'react';
import HandwritingInputModal from '../handwriting/HandwritingInputModal';
```

2. 组件体内（`const locked = ...` 之后）：

```tsx
  /** 当前打开手写弹层的字段：词名 或 'translation'；null = 关闭 */
  const [padField, setPadField] = useState<string | null>(null);
```

3. 词循环内，`<input ... />` 之后（`{r && ...}` 之前）加按钮——注意别破坏现有 label 结构，把 `label.flex.items-center.gap-3` 里的 input 包一层并放按钮：

```tsx
                  <input
                    className={INPUT_CLASS}
                    style={FIELD_BORDER}
                    value={value.terms[term] ?? ''}
                    disabled={locked}
                    onChange={(e) => onChange({
                      ...value,
                      terms: { ...value.terms, [term]: e.target.value },
                    })}
                    placeholder="写出这个词的意思"
                  />
                  <button
                    type="button"
                    onClick={() => setPadField(term)}
                    disabled={locked}
                    className="shrink-0 rounded-[var(--radius-button)] bg-[var(--bg-subtle)] px-3 py-1.5 text-xs font-bold text-[var(--text-primary)] disabled:opacity-50"
                  >
                    手写
                  </button>
```

（label 是 `flex items-center gap-3`，按钮作为第三个子元素自然排在右侧，不改布局骨架。）

4. 整句翻译 textarea 之后（同 label 内）加同款按钮 `onClick={() => setPadField('translation')}`。
5. 组件 return 的最外层 `<section>` 末尾（`</section>` 之前）加共享弹层：

```tsx
      <HandwritingInputModal
        open={padField !== null}
        title={padField === 'translation' ? '手写输入：整句翻译' : `手写输入：${padField ?? ''}`}
        onConfirm={(v) => {
          if (padField === 'translation') onChange({ ...value, translation: v });
          else if (padField) onChange({ ...value, terms: { ...value.terms, [padField]: v } });
          setPadField(null);
        }}
        onClose={() => setPadField(null)}
      />
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npm test -- --run DictationAnswerForm SentenceBlock DictationRunPage InterpretationRunPage`
Expected: PASS（新用例 + 两页既有回归全过）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/business/dictation apps/web/src/components/business/interpretation
git commit -m "feat: 默写/解释作答字段接入手写输入弹层"
```

---

### Task 4: 后端端点 + scene 路由 + 配置与文档

**Files:**
- Modify: `apps/server/src/ai-core/types.ts:15`（Scene union）
- Modify: `apps/server/src/ai-core/model-routes.yaml`（routes 末尾加 handwriting）
- Create: `apps/server/src/modules/ai/handwriting.service.ts`
- Create: `apps/server/src/modules/ai/handwriting.service.test.ts`
- Modify: `apps/server/src/modules/ai/ai.controller.ts`（加一个 @Post 方法）
- Modify: `apps/server/src/modules/ai/ai.module.ts`（provider useFactory）
- Create: `tools/db/migrations/2026-10-08_handwriting_scene.sql`
- Modify: `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml`

**Interfaces:**
- Consumes: `ModelRouter.route({scene, subject}): RouteResult`（`ai-core/infra/model-router.ts`，RouteResult.primary/fallback 为 RoutedModel，scene/modelKey 已打标）；`ModelClient.chat(request)`。
- Produces: `POST /api/ai/handwriting/transcribe`（学生角色）→ `{ text, modelKey, elapsedMs }`；400/4001、400/4002、502/5502。Task 2 的 `transcribeHandwriting` 按此消费（已实现）。

- [ ] **Step 1: Scene union 与枚举引用点**

1. `types.ts:15` 的 `Scene` union 里追加 `| 'handwriting'`（放在 `chinese_meaning_judge` 之后）。
2. 找出所有需要跟着扩的枚举引用点并逐个加 `'handwriting'`（只加枚举值，不改行为）：

```bash
grep -rn "chinese_meaning_judge" apps/server/src apps/web/src --include="*.ts" --include="*.tsx" -l
```

重点核对：admin 模型路由保存接口的 scene 校验（`apps/server/src/modules/admin/` 下）、`apps/web/src/pages/admin/AdminModelsPage.tsx` 的 scene 下拉/文案表。凡是有 scene 字面量清单的地方加 `'handwriting'`（展示名可用「手写识别」）。

- [ ] **Step 2: yaml 路由**

`model-routes.yaml` 的 `routes:` 里、`chinese_meaning_judge` 段之后加：

```yaml
  # 手写识别转写（语文专项手写输入，2026-10-08）：图片 → 汉字文本。
  # 与 judgment/dictation_feedback 同策略：本地 llama.cpp（mtmd 多模态）优先，
  # 不可用回退 qwen3.8-max；切云端只改 llm_routes 表（或 admin 端），零发版。
  handwriting:
    - subject: chinese
      primary: local
      fallback: qwen3.8-max
```

- [ ] **Step 3: 写 service 失败测试**

```ts
// apps/server/src/modules/ai/handwriting.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../ai-core/infra/model-config-registry.js', () => ({
  getModelConfigRegistry: vi.fn(),
}));

import { getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import type { ModelRouter } from '../../ai-core/infra/model-router.js';
import { HandwritingService, HANDWRITING_TRANSCRIBE_PROMPT } from './handwriting.service.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const ROUTED = {
  modelId: 'Qwen3.8-27B', provider: 'local', baseUrl: 'http://localhost:8080',
  contextWindow: 32768, maxOutputTokens: 4096,
  costPer1K: { input: 0, output: 0 }, supportsStreaming: true,
  apiKey: 'sk-test', scene: 'handwriting', subject: 'chinese', modelKey: 'local',
} as const;

function makeService(opts: { route?: typeof ROUTED; chat?: (req: unknown) => Promise<unknown> } = {}) {
  const chat = vi.fn(opts.chat ?? (async () => ({ content: '  庆历四年春  ' })));
  const route = vi.fn(() => ({ primary: opts.route ?? ROUTED, reason: 'test' }));
  const service = new HandwritingService({
    modelRouter: { route } as unknown as ModelRouter,
    modelClient: { chat } as never,
  });
  return { service, chat, route };
}

beforeEach(() => {
  vi.mocked(getModelConfigRegistry).mockReturnValue({ getSnapshot: () => ({ models: {}, routes: {}, default: { primary: '', fallback: '' } }) } as never);
});

describe('HandwritingService.transcribe', () => {
  it('走 ModelRouter(scene handwriting, subject chinese)，system prompt + image_url 部件，thinking:false，meta 无 studentId', async () => {
    const { service, chat, route } = makeService();
    const res = await service.transcribe(PNG);
    expect(res).toMatchObject({ text: '庆历四年春', modelKey: 'local' });
    expect(route).toHaveBeenCalledWith({ scene: 'handwriting', subject: 'chinese' });
    const req = chat.mock.calls[0][0] as Record<string, any>;
    expect(req.model).toBe(ROUTED);
    expect(req.messages[0]).toEqual({ role: 'system', content: HANDWRITING_TRANSCRIBE_PROMPT });
    expect(req.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '转写' },
        { type: 'image_url', image_url: { url: PNG } },
      ],
    });
    expect(req.thinking).toBe(false);
    expect(req.meta).toEqual({ capability: 'handwriting_transcribe' });
  });

  it('image 前缀非法 → 400；解码 >4MB → 400', async () => {
    const { service } = makeService();
    await expect(service.transcribe('not-a-url')).rejects.toMatchObject({ status: 400 });
    const big = 'data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    await expect(service.transcribe(big)).rejects.toMatchObject({ status: 400 });
  });

  it('上游失败 → 502', async () => {
    const { service } = makeService({ chat: async () => { throw new Error('boom'); } });
    await expect(service.transcribe(PNG)).rejects.toMatchObject({ status: 502 });
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd apps/server && npm test -- --run handwriting.service`
Expected: FAIL（模块不存在）

- [ ] **Step 5: 实现 service**

```ts
// apps/server/src/modules/ai/handwriting.service.ts
import { BadRequestException, BadGatewayException } from '@nestjs/common';
import { ModelRouter } from '../../ai-core/infra/model-router.js';
import { getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import { ModelClient } from '../../ai-core/infra/model-client/index.js';
import { timeoutConfig } from '../../ai-core/config.js';
import type { ChatMessage } from '../../ai-core/types.js';

/**
 * 手写识别转写（语文专项手写输入，spec 2026-10-08 §5.1）。
 * 与 dev 调研端点的三点不同：走 ModelRouter（fallback+账本打标）；
 * meta 不带 studentId（HTTP 路径 ALS 归属学生）；thinking:false。
 * **不写 @Injectable()**（DI 坑），AIModule 用 useFactory。
 */
export const HANDWRITING_TRANSCRIBE_PROMPT =
  '你是 OCR 引擎。把图片中的手写汉字逐字转写为简体中文纯文本，只输出转写结果本身，不要输出任何解释或多余符号。无法辨认的字输出最接近的猜测。';

const IMAGE_PREFIX = /^data:image\/(png|jpeg);base64,/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface HandwritingTranscribeResult {
  text: string;
  modelKey: string;
  elapsedMs: number;
}

export class HandwritingService {
  private modelRouter: ModelRouter;
  private modelClient: ModelClient;

  constructor(deps?: { modelRouter?: ModelRouter; modelClient?: ModelClient }) {
    this.modelRouter = deps?.modelRouter ?? new ModelRouter(getModelConfigRegistry());
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async transcribe(image: string): Promise<HandwritingTranscribeResult> {
    if (typeof image !== 'string' || !IMAGE_PREFIX.test(image)) {
      throw new BadRequestException({ code: 4001, message: 'image 必须是 data:image/png|jpeg;base64 格式' });
    }
    const base64 = image.slice(image.indexOf(',') + 1);
    if (Buffer.from(base64, 'base64').length > MAX_IMAGE_BYTES) {
      throw new BadRequestException({ code: 4002, message: '图片解码后超过 4MB' });
    }
    const routeResult = this.modelRouter.route({ scene: 'handwriting', subject: 'chinese' });
    const messages: ChatMessage[] = [
      { role: 'system', content: HANDWRITING_TRANSCRIBE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '转写' },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ];
    const start = Date.now();
    try {
      const res = await this.modelClient.chat({
        model: routeResult.primary,
        messages,
        timeout: timeoutConfig.timeout.default,
        thinking: false,
        meta: { capability: 'handwriting_transcribe' },
      });
      return {
        text: res.content.trim(),
        modelKey: routeResult.primary.modelKey ?? '',
        elapsedMs: Date.now() - start,
      };
    } catch (err) {
      throw new BadGatewayException({
        code: 5502,
        message: `识别模型调用失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}
```

- [ ] **Step 6: controller + module**

`ai.controller.ts`：构造器加 `private readonly handwritingService: HandwritingService`（import 之），类内加方法：

```ts
  // 手写识别转写（语文专项手写输入，spec 2026-10-08）：图片 → 汉字文本。
  // 类级 @Roles('student') 继承；非流式；错误 400/502 由 service 抛、全局过滤器统一包装。
  @Post('handwriting/transcribe')
  transcribeHandwriting(@Body() dto: { image?: string }) {
    return this.handwritingService.transcribe(dto?.image as string);
  }
```

（`dto?.image` 防 undefined body → service 的 `typeof image !== 'string'` 落 400。）

`ai.module.ts` providers 数组加：

```ts
    {
      provide: HandwritingService,
      // 不写 @Injectable()（DI 坑），useFactory 手动实例化（同 TutoringCapability 策略）
      useFactory: () => new HandwritingService(),
    },
```

（import `HandwritingService` 加到文件头。）

- [ ] **Step 7: controller 守卫测试**

新建 `apps/server/src/modules/ai/ai.controller.test.ts`（无则建；同 `points.controller.test.ts` 先例，断言 `@Roles('student')` 元数据经 RolesGuard 生效）：

```ts
import { describe, it, expect } from 'vitest';
import { AIController } from './ai.controller.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';
import 'reflect-metadata';

describe('AIController — 手写转写端点守卫', () => {
  it('继承类级 @Roles(student)；路由为 POST api/ai/handwriting/transcribe', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AIController);
    expect(roles).toEqual(['student']);
    const path = Reflect.getMetadata('path', AIController.prototype.transcribeHandwriting);
    expect(path).toBe('handwriting/transcribe');
  });
});
```

（若 points.controller.test 的先例写法不同，以先例为准调整，断言目标不变：student 放行、parent/admin 403、未登录 401 由 RolesGuard/JwtAuthGuard 语义保证。）

- [ ] **Step 8: 跑后端测试确认通过**

Run: `cd apps/server && npm test -- --run handwriting ai.controller`
Expected: PASS（service 3 + controller 守卫 1；既有 ai 模块测试不受影响）

- [ ] **Step 9: 迁移 SQL**

`tools/db/migrations/2026-10-08_handwriting_scene.sql`：

```sql
-- 手写识别转写路由（语文专项手写输入，2026-10-08）：幂等，依赖 llm_models 已有 model_key='local' 行。
INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'handwriting', 'chinese', 'local', 'qwen3.8-max'
WHERE NOT EXISTS (
  SELECT 1 FROM llm_routes WHERE scene = 'handwriting' AND subject = 'chinese'
);
```

（schema.sql 无新表/列，不动；`scene VARCHAR(30)`/`subject VARCHAR(20)` 容量足够。手工 apply：`mysql ai_k12 < tools/db/migrations/2026-10-08_handwriting_scene.sql`；DB 没跑迁移时 yaml 兜底同路由，系统照常工作。）

- [ ] **Step 10: API 文档同步（两份）**

1. `docs/API接口与数据流设计文档.md`：§4 新增小节（建议 §4.27，紧随现有 ai/dev 相关小节），内容：`POST /api/ai/handwriting/transcribe`（学生角色）——用途（语文专项手写输入转写）、body `{image: dataURL(png|jpeg, ≤4MB)}`、返回 `{text, modelKey, elapsedMs}`、错误 400/4001、400/4002、502/5502、成功 201（`@Post` 默认）、模型由 scene `handwriting` + subject `chinese` 路由（local 优先 qwen3.8-max 兜底）、不留档只有 LLM 账本。§5 数据流如该文档对 ai 端点有清单，同步补一行。§9 变更日志加一行。
2. `docs/api/openapi.yaml`：`paths` 加 `/api/ai/handwriting/transcribe`（post，requestBody `{image: string}`，`'201'` 响应 `{text, modelKey, elapsedMs}`，400/502；security student bearer）——对照文件内既有 POST 端点条目格式。
3. 核对清单：两文档端点路径列表一致（CLAUDE.md API 同步规则）。

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/ai-core/types.ts apps/server/src/ai-core/model-routes.yaml \
  apps/server/src/modules/ai tools/db/migrations/2026-10-08_handwriting_scene.sql \
  docs/API接口与数据流设计文档.md docs/api/openapi.yaml
git commit -m "feat: 手写转写端点 /api/ai/handwriting/transcribe + scene handwriting 路由"
```

---

### Task 5: 全量回归 + 手测清单

**Files:** 无新文件（验证收尾）

- [ ] **Step 1: 全量测试 + 类型 + lint**

```bash
cd apps/web && npm test && npm run lint && npx tsc -b --noEmit
cd ../server && npm test && npm run build
```
Expected: 全 PASS、0 error（web lint 既有 MobilePointsPage.test.tsx:46 error 属历史遗留，不在本计划范围）；server build 覆盖 dist 需向用户披露（正在跑的后端要重启）。

- [ ] **Step 2: 手测清单（用户执行）**

1. `mysql ai_k12 < tools/db/migrations/2026-10-08_handwriting_scene.sql`；重启后端 `node dist/main.js`（dist 已重建）；web 刷新。
2. 学生账号 → 训练 → 语文 → 专项 → 默写：三字段各点「手写」→ 分批写正文 → 校对区改错 → 确认填入 → 提交，判题结果与键盘输入一致。
3. 解释页：词/翻译手写各走一遍；判后锁定态按钮应禁用。
4. 夜间主题下（18:00 后或沉浸页手动切）面板笔迹颜色可读；导出识别仍正常。
5. 识别失败重试、误关弹层重开内容保留。
6. admin 端模型路由页（若有 scene 下拉）确认出现「handwriting/手写识别」。

- [ ] **Step 3: Commit（如有微调）**

```bash
git add -A && git commit -m "chore: 语文专项手写输入回归收尾"
```

---

## Self-Review 结论

- **Spec 覆盖**：§4.1→Task 1；§4.2→Task 2；§4.3→Task 3；§5.1/5.2→Task 4（含 yaml/迁移/文档两份同步）；§6 边界→弹层状态机与 controller 校验；§7 测试→各任务内嵌；§2 非目标未实现即符合。
- **占位符扫描**：无 TBD/TODO；Task 2 Step 2 里的错误 import 行已就地给出正确写法并显式标注；「grep 引用点逐一加枚举」是具体命令+明确动作，非占位。
- **类型一致性**：`HandwritingPadHandle`（Task 1 = Task 2）；`HandwritingInputModal` props `{open,title,onConfirm,onClose}`（Task 2 = Task 3）；`transcribeHandwriting` 返回 `{text,modelKey,elapsedMs}`（Task 2 api = Task 4 端点）；`HandwritingService.transcribe(image)` 签名一致。
- **一处对 spec 的具体化**：spec「fallback 可空」→ 计划定为 `fallback: qwen3.8-max`（与仓内全部 local 优先场景同策略，本地挂了有兜底）。
