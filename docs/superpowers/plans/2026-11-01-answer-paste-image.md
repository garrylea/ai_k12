# 作答区粘贴图片 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让物理/化学作答区（`LatexEditor` + 右侧 `LatexPreview`）支持粘贴/拖入图片：图片上传后在光标处插入 `![图N](/uploads/…)`，预览与结果页按大图显示，图片顺序即作答顺序、alt 可写「第2问」。

**Architecture:** 图片走 Markdown 图片语法写进答案文本本身（`answer_text` 是 TEXT，零 schema 改动）；上传复用现有 `POST /api/files/upload`；顺序由图片在文本流中的位置决定，归属由 alt 承载。前端拆成三层：纯压缩工具（`image-compress`）→ 编辑器（粘贴拦截、占位、替换）→ 渲染（`LatexPreview` / `AnswerResultList` 的图片样式覆盖）。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind（全 token 配色）、vitest + React Testing Library（`globals: false`）、ReactMarkdown + KaTeX、Nest 既有上传端点（本期不改）。

## Global Constraints

- **不改后端 / 不改 schema / 不改判题链路**：只动 `apps/web`。上传走既有 `POST /api/files/upload`（JWT，20MB，`uploaded_files.source` 仍为 `'auxiliary'`）。
- **测试纪律**：`globals: false`，每个测试文件自写 `afterEach(() => cleanup())`；组件改动必须补渲染测试，不能只靠 `tsc + lint + build`。
- **测试与设计冲突时测试错**：断言与 spec 不一致，改测试不改 spec。
- **UI 硬规则**：不用 emoji；图标用线性 SVG；配色只走 CSS 变量（`var(--brand-500)` 等），不写死色值；不加装饰元素。
- **注释写「为什么」**：每个非显然分支（占位为什么是纯文本、为什么等图片 `load` 再同步滚动、为什么编号取最大值 +1）必须留一行原因，避免后来者"优化"掉。
- **命令一律在 `apps/web` 下执行**：`npm test` / `npm run lint` / `npm run build`。
- **本机已有 dev server 时不要重启或杀进程**（用户自己开着 :5173/:3001）；需要看页面就直接用现有实例。
- 参考 spec：`docs/superpowers/specs/2026-11-01-answer-paste-image-design.md`。

---

### Task 1: 前置真机验证（阻断，不写代码）

**为什么先做**：整案建立在"iPad Safari 里把图片粘贴进 `<textarea>` 能触发 `paste` 且 `clipboardData.items` 带图片"这个假设上。iOS 对 textarea 的图片剪贴板支持不稳定，验不过就要走 Task 10 的兜底入口，否则做完也是死路。

**Files:** 无（人工验证）

- [ ] **Step 1: 确认服务在跑**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/health
```

Expected: 两个都返回 `200`。若有 4xx/连接失败，只启动缺的那个（`apps/web` 下 `npm run dev`；后端 `node dist/main.js`），**不要 pkill 任何进程**。

- [ ] **Step 2: 在 iPad Safari 上验证粘贴**

1. 打开一个物理作答页（`/student/training/…` 或主线答题弹窗，进入任何需要 LaTeX 作答的题）。
2. 在 iPad 上连 Mac，Safari → 开发 → 选中 iPad → Console，**先**执行下面这段临时探针（验证完删掉，不提交）：

```js
const ta = document.querySelector('textarea');
ta.addEventListener('paste', (e) => {
  console.log('paste event', {
    types: Array.from(e.clipboardData?.types ?? []),
    items: Array.from(e.clipboardData?.items ?? []).map(i => ({ kind: i.kind, type: i.type })),
    files: e.clipboardData?.files?.length ?? 0,
  });
}, { once: true });
```

3. 回到 iPad：相册里对一张图长按 → 拷贝 → 点进作答编辑框 → 长按 → 粘贴。
4. 看 Console 输出。

- [ ] **Step 3: 记录结论并决定分支**

- 探针输出里出现 `kind: 'file'`、`type: 'image/png'`（或 `image/jpeg`）→ 假设成立，继续 Task 2。
- 只有 `text/plain`、或 `paste` 事件根本没触发 → 假设不成立：**先跳过 Task 10 之外的全部任务，直接做 Task 10**（最小选图入口），再回来按顺序做 Task 2–9。把结论一句话写进 `docs/ai-core-changelog.md` 的对应条目（Task 9 会用到）。

---

### Task 2: 图片压缩工具（纯函数 + 上传用 File）

**Files:**
- Create: `apps/web/src/utils/image-compress.ts`
- Test: `apps/web/src/utils/image-compress.test.ts`

**Interfaces:**
- Produces: `MAX_IMAGE_BYTES: number`（5MB）、`MAX_IMAGE_EDGE: number`（1600）、`scaleSize(w, h, maxEdge?): { w: number; h: number }`、`compressImageFile(file: File): Promise<File>`

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/utils/image-compress.test.ts
// 只测纯计算：jsdom 没有 canvas 和图片解码，DOM 路径（重编码/白底）靠手工验证。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { MAX_IMAGE_EDGE, scaleSize } from './image-compress';

afterEach(() => cleanup());

describe('scaleSize', () => {
  it('宽边超限：等比缩到 1600', () => {
    expect(scaleSize(2000, 1000)).toEqual({ w: 1600, h: 800 });
  });

  it('高边超限：等比缩到 1600', () => {
    expect(scaleSize(1000, 2500)).toEqual({ w: 640, h: 1600 });
  });

  it('未超限：原样返回', () => {
    expect(scaleSize(800, 600)).toEqual({ w: 800, h: 600 });
    expect(scaleSize(1600, 1200)).toEqual({ w: 1600, h: 1200 });
  });

  it('取整后长边不超过上限', () => {
    const { w, h } = scaleSize(1601, 1599);
    expect(Math.max(w, h)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/utils/image-compress.test.ts`
Expected: FAIL —— `Failed to resolve import "./image-compress"`.

- [ ] **Step 3: 写实现**

```ts
// apps/web/src/utils/image-compress.ts
// 作答区贴图压缩：最长边 ≤1600 转 JPEG，供 POST /api/files/upload。
// 为什么不复用 draft-image-utils：那边产出 data URL（草稿画布内存贴图），这里要可上传的 File。
// 为什么铺白底：canvas 默认透明，PNG 转 JPEG 后透明区会变黑。

export const MAX_IMAGE_EDGE = 1600;
/** 单张上限（压缩前），与辅线答疑输入栏一致 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const JPEG_QUALITY = 0.85;
/** 小于该体积且未超尺寸就不重编码，省一次画布往返（截图类图片通常已足够小） */
const PASS_THROUGH_BYTES = 1024 * 1024;

/** 等比缩放到最长边 ≤ maxEdge，不放大。纯函数，单测覆盖。 */
export function scaleSize(w: number, h: number, maxEdge = MAX_IMAGE_EDGE): { w: number; h: number } {
  const edge = Math.max(w, h);
  if (edge <= maxEdge) return { w, h };
  const k = maxEdge / edge;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** File → HTMLImageElement（objectURL 在解码完成后释放，避免泄漏） */
async function decode(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function compressImageFile(file: File): Promise<File> {
  const img = await decode(file);
  if (Math.max(img.naturalWidth, img.naturalHeight) <= MAX_IMAGE_EDGE && file.size <= PASS_THROUGH_BYTES) {
    return file;
  }
  const { w, h } = scaleSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file; // 无 canvas 的极端环境：宁可传原图，也不能把学生的图弄丢
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) return file;
  const name = `${file.name.replace(/\.[^./\\]+$/, '')}.jpg`;
  return new File([blob], name, { type: 'image/jpeg' });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/utils/image-compress.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/utils/image-compress.ts apps/web/src/utils/image-compress.test.ts
git commit -m "feat(web): 作答贴图压缩工具（最长边 1600 / JPEG 白底）"
```

---

### Task 3: 共享的「作答大图」Markdown 配置

**Files:**
- Modify: `apps/web/src/components/markdown.tsx:228-241`（`MarkdownImgProps` 导出）、`:446` 之后（新增常量与工厂）

**Interfaces:**
- Produces: `ANSWER_IMG_CLASS: string`、`makeAnswerComponents(imgClassName?: string)`（返回可直接传给 `<ReactMarkdown components>` 的对象，`img` 固定用大图样式）

- [ ] **Step 1: 写失败测试**

在 `apps/web/src/components/markdown.test.tsx` 末尾追加（该文件用 `createElement`、无 JSX，保持同样写法）：

```tsx
import { makeAnswerComponents, ANSWER_IMG_CLASS } from './markdown';

it('makeAnswerComponents：图片使用作答大图样式而非题面 50px 小图', () => {
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, { components: makeAnswerComponents() }, '![图1](/uploads/a/b.png)'),
  );
  expect(html).toContain('max-h-[40vh]');
  expect(html).not.toContain('h-[50px]');
});

it('makeAnswerComponents：可覆盖样式串', () => {
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, { components: makeAnswerComponents('max-h-[10vh]') }, '![图1](/uploads/a.png)'),
  );
  expect(html).toContain('max-h-[10vh]');
  expect(html).not.toContain(ANSWER_IMG_CLASS);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/markdown.test.tsx -t "makeAnswerComponents"`
Expected: FAIL —— `makeAnswerComponents is not a function`.

- [ ] **Step 3: 写实现**

把 `interface MarkdownImgProps` 改成 `export interface MarkdownImgProps`，并在 `markdownComponents` 定义之后追加：

```tsx
/**
 * 作答/结果页的大图样式：与题面小图（默认 `h-[50px]`）区分。
 * 物理电路图、化学装置图按题面规格会被压成一条细线，必须用这套。
 * 40vh 上限是为了让"文字 + 图 + 文字"能在同一屏里读，点开还能放大（zoomable）。
 */
export const ANSWER_IMG_CLASS =
  'block max-w-full max-h-[40vh] my-2 rounded-lg object-contain cursor-zoom-in';

/**
 * 学生作答内容专用的 components 工厂。
 * 必须是工厂/模块级常量、不能在 render 里现造箭头函数——`img` 的组件类型一旦每次渲染都变，
 * React 会把 `<img>` 卸载重挂，等于每次输入都重新下载图片。
 */
export function makeAnswerComponents(imgClassName: string = ANSWER_IMG_CLASS) {
  return {
    ...markdownComponents,
    img: ({ node: _node, ...rest }: MarkdownImgProps & { node?: unknown }) => (
      <MarkdownImg {...rest} className={imgClassName} />
    ),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/markdown.test.tsx`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/markdown.tsx apps/web/src/components/markdown.test.tsx
git commit -m "feat(web): 作答内容的大图 Markdown 配置（ANSWER_IMG_CLASS）"
```

---

### Task 4: 预览区按大图渲染 + 图片加载后重放滚动

**Files:**
- Modify: `apps/web/src/components/business/LatexPreview.tsx:102-155`
- Modify: `apps/web/src/components/markdown.tsx:49-50`（`resolveAsset` 放行 `/uploads/` 前缀）
- Test: `apps/web/src/components/business/LatexPreview.test.tsx`、`apps/web/src/components/markdown.test.tsx`（`resolveAsset` 单测）

**Interfaces:**
- Consumes: `makeAnswerComponents`（Task 3）
- Produces: `<LatexPreview value scrollSync imgClassName? />` —— 新增可选 `imgClassName`，不传时行为与现在完全一致

- [ ] **Step 1: 写失败测试**

在 `LatexPreview.test.tsx` 末尾追加：

```tsx
import { ANSWER_IMG_CLASS } from '@/components/markdown';

describe('LatexPreview 作答图片', () => {
  it('传 imgClassName 时图片用大图样式，不是题面 50px', () => {
    render(<LatexPreview value="![图1](/uploads/a/b.png)" imgClassName={ANSWER_IMG_CLASS} />);
    const img = screen.getByRole('img');
    expect(img.className).toContain('max-h-[40vh]');
    expect(img.className).not.toContain('h-[50px]');
  });

  it('不传 imgClassName 时沿用默认（题干预览不受影响）', () => {
    render(<LatexPreview value="![图1](/uploads/a/b.png)" />);
    expect(screen.getByRole('img').className).toContain('h-[50px]');
  });

  it('/uploads/ 相对路径原样透传：src 不得被补成 /assets/uploads/…（否则 404）', () => {
    render(<LatexPreview value="![第2问](/uploads/a/b.png)" imgClassName={ANSWER_IMG_CLASS} />);
    expect(screen.getByRole('img').getAttribute('src')).toBe('/uploads/a/b.png');
  });

  it('已知限制：data: 内联图不被渲染（react-markdown 默认 urlTransform 清空）', () => {
    render(<LatexPreview value="![第2问](data:image/png;base64,iVBORw0KGgo=)" imgClassName={ANSWER_IMG_CLASS} />);
    expect(screen.getByRole('img').getAttribute('src')).toBe('');
  });

  it('图片 load 后重放滚动同步（防抖重放发生时图还没加载完）', () => {
    const sync: { current: PreviewScrollSync } = { current: { ratio: 0.5, apply: vi.fn() } };
    render(<LatexPreview value="![图1](/uploads/a/b.png)" imgClassName={ANSWER_IMG_CLASS} scrollSync={sync} />);
    const img = screen.getByRole('img');
    fireEvent.load(img);
    expect(sync.current.apply).toHaveBeenCalled();
  });
});
```

文件顶部若未引入 `fireEvent` / `vi`，补进现有 import：`import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';`、`import { afterEach, describe, expect, it, vi } from 'vitest';`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/LatexPreview.test.tsx -t "作答图片"`
Expected: FAIL —— TS/运行时都不认识 `imgClassName`，且 `getByRole('img')` 拿不到。

- [ ] **Step 3: 写实现**

`LatexPreview.tsx` 顶部补 `useMemo` 与 `makeAnswerComponents` 引入：

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { makeAnswerComponents, markdownComponents, markdownRemarkPluginsWithBreaks, markdownRehypePlugins } from '@/components/markdown';
```

组件签名与组件表：

```tsx
export function LatexPreview({
  value,
  scrollSync,
  imgClassName,
}: {
  value: string;
  scrollSync?: { current: PreviewScrollSync };
  /** 作答预览传 ANSWER_IMG_CLASS（大图）；不传沿用题面默认小图样式 */
  imgClassName?: string;
}) {
  // 组件表必须稳定：每次渲染新建 img 函数会让 React 卸载重挂 <img>，等于重新下载
  const components = useMemo(
    () => (imgClassName ? makeAnswerComponents(imgClassName) : markdownComponents),
    [imgClassName],
  );
```

把 `:130-132` 的重放 effect 换成：

```tsx
  // 内容（防抖）变化后重放：渲染高度变了，按最新比例重新定位。
  // 图片解码完成后高度才最终确定，而防抖重放时图还没加载完——必须再等一次 load，
  // 否则学生看到的是"插了图，右侧跳到别处"。
  useEffect(() => {
    const sync = scrollSync?.current;
    const el = containerRef.current;
    if (!sync || !el) return;
    sync.apply?.();
    const pending = Array.from(el.querySelectorAll('img')).filter((img) => !img.complete);
    if (pending.length === 0) return;
    const onLoad = () => sync.apply?.();
    for (const img of pending) img.addEventListener('load', onLoad);
    return () => {
      for (const img of pending) img.removeEventListener('load', onLoad);
    };
  }, [debounced, scrollSync, components]);
```

渲染处把 `components={markdownComponents}` 改成 `components={components}`（`:146`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/LatexPreview.test.tsx`
Expected: PASS（含既有 autoWrapMath / 滚动用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/business/LatexPreview.tsx apps/web/src/components/business/LatexPreview.test.tsx
git commit -m "feat(web): 预览区支持作答大图 + 图片加载后重放滚动同步"
```

---

### Task 5: PreviewDraftPanel 透传图片样式（两个分支）

**Files:**
- Modify: `apps/web/src/components/business/PreviewDraftPanel.tsx:10-46`
- Test: `apps/web/src/components/business/PreviewDraftPanel.test.tsx`（新建）

**Interfaces:**
- Consumes: `LatexPreview` 的 `imgClassName`（Task 4）
- Produces: `<PreviewDraftPanel ... imgClassName? />`

**注意**：物理/化学走的是 `enabled=false` 分支（直接 `return <LatexPreview/>`，`:19-22`），只改 tab 分支会导致"物理题预览没变"。

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/components/business/PreviewDraftPanel.test.tsx
// 物理/化学走 enabled=false 分支（直接返回 LatexPreview），数学走 tab 分支，
// 两条路都必须把作答大图样式透传下去——漏一条就会出现"物理题里图被压成 50px"。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PreviewDraftPanel } from './PreviewDraftPanel';
import { ANSWER_IMG_CLASS } from '@/components/markdown';

afterEach(() => cleanup());

const ANSWER = '![图1](/uploads/a/b.png)';

describe('PreviewDraftPanel 图片样式透传', () => {
  it('enabled=false（物理/化学）：大图样式生效', () => {
    render(<PreviewDraftPanel answer={ANSWER} questionId="q1" enabled={false} imgClassName={ANSWER_IMG_CLASS} />);
    expect(screen.getByRole('img').className).toContain('max-h-[40vh]');
  });

  it('enabled=true（数学）：默认 tab 是预览，大图样式同样生效', () => {
    render(<PreviewDraftPanel answer={ANSWER} questionId="q1" enabled imgClassName={ANSWER_IMG_CLASS} />);
    expect(screen.getByRole('img').className).toContain('max-h-[40vh]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/PreviewDraftPanel.test.tsx`
Expected: FAIL —— 图片 className 仍是 `h-[50px]`（透传不存在）。

- [ ] **Step 3: 写实现**

```tsx
interface Props {
  answer: string;
  questionId: string;
  /** 仅数学学科启用草稿白板（PRD §7.12） */
  enabled: boolean;
  /** 左输入区 → 右预览区的滚动跟随通道（透传给 LatexPreview） */
  scrollSync?: { current: PreviewScrollSync };
  /** 作答图样式（大图）。物理/化学走 enabled=false 分支，同样必须透传 */
  imgClassName?: string;
}

export function PreviewDraftPanel({ answer, questionId, enabled, scrollSync, imgClassName }: Props) {
  const [tab, setTab] = useState<Tab>('preview');

  if (!enabled) {
    return <LatexPreview value={answer} scrollSync={scrollSync} imgClassName={imgClassName} />;
  }
```

tab 分支的渲染处（原 `:45`）改成：

```tsx
      <div className="flex-1 min-h-0">
        {tab === 'preview' ? (
          <LatexPreview value={answer} scrollSync={scrollSync} imgClassName={imgClassName} />
        ) : (
          <DraftWhiteboard questionId={questionId} />
        )}
      </div>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/PreviewDraftPanel.test.tsx`
Expected: PASS（2 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/business/PreviewDraftPanel.tsx apps/web/src/components/business/PreviewDraftPanel.test.tsx
git commit -m "feat(web): 作答预览透传大图样式（含物理/化学的 enabled=false 分支）"
```

---

### Task 6: LatexEditor 粘贴 / 拖拽 / 占位 / 上传

**Files:**
- Modify: `apps/web/src/components/business/LatexEditor.tsx`
- Test: `apps/web/src/components/business/LatexEditor.test.tsx`

**Interfaces:**
- Consumes: `uploadFile(file, signal?)`（`@/services/api`，返回 `{ fileId, url }`）、`ensureJpeg(file)`（`@/utils/image-convert`）、`compressImageFile` / `MAX_IMAGE_BYTES`（Task 2）、`toast('error', msg)`（`@/components/base/Toast`）
- Produces: `<LatexEditor ... onUploadingChange?: (uploading: boolean) => void />`

- [ ] **Step 1: 写失败测试**

在 `LatexEditor.test.tsx` 顶部补 mock（放在 import 之前也可以，vitest 会提升）：

```tsx
vi.mock('@/services/api', () => ({ uploadFile: vi.fn() }));
vi.mock('@/utils/image-convert', () => ({
  // 真实实现里 HEIC 会转成 JPEG；mock 也要模拟这一点，否则断言上传物类型时失真
  ensureJpeg: vi.fn(async (f: File) =>
    f.type === 'image/heic'
      ? new File([f], f.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' })
      : f,
  ),
}));
vi.mock('@/utils/image-compress', () => ({
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  compressImageFile: vi.fn(async (f: File) => f),
}));
vi.mock('@/components/base/Toast', () => ({ toast: vi.fn() }));
```

测试内引 `import { uploadFile } from '@/services/api'; import { toast } from '@/components/base/Toast'; import { ensureJpeg } from '@/utils/image-convert';`

```tsx
const img = (name = 'a.png', type = 'image/png', bytes = 10) =>
  new File([new Uint8Array(bytes)], name, { type });

/** 直接构造 paste 事件：jsdom 的 ClipboardEvent 不认 clipboardData 初始化，键要手挂 */
function pasteImages(el: HTMLElement, files: File[]) {
  const evt = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
    clipboardData?: unknown;
  };
  Object.defineProperty(evt, 'clipboardData', {
    value: { items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })) },
  });
  return fireEvent(el, evt);
}

function dropFiles(el: HTMLElement, files: File[]) {
  const evt = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
  Object.defineProperty(evt, 'dataTransfer', { value: { files, types: ['Files'] } });
  return fireEvent(el, evt);
}

function renderControlled(initial = '', extra?: { onUploadingChange?: (v: boolean) => void }) {
  const onChange = vi.fn();
  function Wrapper() {
    const [v, setV] = useState(initial);
    return (
      <LatexEditor
        value={v}
        onChange={(n) => { setV(n); onChange(n); }}
        onUploadingChange={extra?.onUploadingChange}
      />
    );
  }
  render(<Wrapper />);
  return { el: screen.getByRole('textbox') as HTMLTextAreaElement, onChange };
}

describe('LatexEditor 贴图', () => {
  it('粘贴图片：占位插在光标处，上传成功后替换为 Markdown 图片', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ fileId: 7, url: '/uploads/auxiliary/a.jpg' });
    const { el } = renderControlled('12V;2A');
    el.focus();
    el.setSelectionRange(3, 3); // "12V" 之后
    pasteImages(el, [img()]);

    await waitFor(() => expect(el.value).toContain('![图1](/uploads/auxiliary/a.jpg)'));
    expect(el.value.startsWith('12V')).toBe(true);
    expect(el.value).not.toContain('上传中');
  });

  it('一次粘贴两张：只触发一次 onChange（避免受控组件光标漂移），编号顺延', async () => {
    vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {})); // 永挂起
    const { el, onChange } = renderControlled('起点');
    onChange.mockClear();
    pasteImages(el, [img('a.png'), img('b.png')]);

    await waitFor(() => expect(el.value).toContain('［图1 上传中…］'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(el.value).toContain('［图2 上传中…］');
  });

  it('上传失败：占位替换为失败标记并 toast，不抛', async () => {
    vi.mocked(uploadFile).mockRejectedValue(new Error('boom'));
    const { el } = renderControlled('');
    pasteImages(el, [img()]);

    await waitFor(() => expect(el.value).toContain('［图1 上传失败］'));
    expect(vi.mocked(toast)).toHaveBeenCalledWith('error', '图片上传失败，请重试');
  });

  it('纯文本剪贴板：不拦截默认行为，不上传', () => {
    const { el } = renderControlled('');
    const evt = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    Object.defineProperty(evt, 'clipboardData', {
      value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
    });
    const notPrevented = fireEvent(el, evt);
    expect(notPrevented).toBe(true);
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled();
  });

  it('编号防撞：已有失败标记时，新图从 2 开始', async () => {
    vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
    const { el } = renderControlled('［图1 上传失败］');
    pasteImages(el, [img()]);
    await waitFor(() => expect(el.value).toContain('［图2 上传中…］'));
  });

  it('超过 5MB：不调用上传，toast，文本不变', () => {
    const { el } = renderControlled('');
    pasteImages(el, [img('big.png', 'image/png', 6 * 1024 * 1024)]);
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled();
    expect(vi.mocked(toast)).toHaveBeenCalledWith('error', '图片过大（最大 5MB）');
    expect(el.value).toBe('');
  });

  it('上传途中学生删掉占位：结果丢弃，不追加', async () => {
    let resolve!: (v: { fileId: number; url: string }) => void;
    vi.mocked(uploadFile).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { el } = renderControlled('');
    pasteImages(el, [img()]);
    await waitFor(() => expect(el.value).toContain('上传中'));

    fireEvent.change(el, { target: { value: '' } });
    resolve({ fileId: 1, url: '/uploads/x.jpg' });

    await waitFor(() => expect(vi.mocked(uploadFile)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(el.value).toBe('');
  });

  it('拖入图片文件：与粘贴同一路径', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ fileId: 1, url: '/uploads/auxiliary/d.jpg' });
    const { el } = renderControlled('');
    dropFiles(el, [img()]);
    await waitFor(() => expect(el.value).toContain('![图1](/uploads/auxiliary/d.jpg)'));
  });

  it('HEIC 先转 JPEG 再上传', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ fileId: 1, url: '/uploads/auxiliary/h.jpg' });
    const { el } = renderControlled('');
    pasteImages(el, [img('h.heic', 'image/heic')]);
    await waitFor(() => expect(vi.mocked(ensureJpeg)).toHaveBeenCalled());
    expect(vi.mocked(uploadFile).mock.calls[0][0].type).toBe('image/jpeg');
  });

  it('上传中回调 true，完成后 false（上层据此禁用提交）', async () => {
    let resolve!: (v: { fileId: number; url: string }) => void;
    vi.mocked(uploadFile).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const onUploadingChange = vi.fn();
    const { el } = renderControlled('', { onUploadingChange });
    pasteImages(el, [img()]);
    await waitFor(() => expect(onUploadingChange).toHaveBeenCalledWith(true));
    resolve({ fileId: 1, url: '/uploads/x.jpg' });
    await waitFor(() => expect(onUploadingChange).toHaveBeenCalledWith(false));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/LatexEditor.test.tsx -t "贴图"`
Expected: FAIL —— `pasteImages` 后 value 无变化（编辑器没有 onPaste）。

- [ ] **Step 3: 写实现**

`LatexEditor.tsx` 改成（保留原有 `insertAtCursor` / `pinToBottomIfCaretAtEnd` / 滚动逻辑不变）：

```tsx
import { useEffect, useRef, useState } from 'react';
import { SymbolPalette } from './SymbolPalette';
import type { PreviewScrollSync } from './preview-scroll-sync';
import { uploadFile } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';
import { compressImageFile, MAX_IMAGE_BYTES } from '@/utils/image-compress';
import { toast } from '@/components/base/Toast';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 左输入区 → 右预览区的滚动跟随通道 */
  scrollSync?: { current: PreviewScrollSync };
  /** 有图片正在上传时回调 true：上层据此禁用提交，避免占位文本落库（spec §4.1 第 8 步） */
  onUploadingChange?: (uploading: boolean) => void;
}

const CARET_MARKER = '$0';
const UPLOAD_TIMEOUT_MS = 15_000;
/** 占位用纯文本：不产生 <img>，预览区不会闪破图；失败标记与它同构，编号扫描才认得出 */
const pendingToken = (n: number) => `［图${n} 上传中…］`;
const failedToken = (n: number) => `［图${n} 上传失败］`;
const IMG_INDEX_RE = /图(\d+)/g;

/** 下一个可用图片编号 = 文中所有「图N」标记（含失败/上传中）的最大值 + 1，避免撞号 */
function nextImageIndex(text: string): number {
  let max = 0;
  for (const m of text.matchAll(IMG_INDEX_RE)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max + 1;
}
```

组件内部新增（`insertAtCursor` 里所有 `onChange(x)` 换成 `emit(x)`）：

```tsx
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  // valueRef 让异步替换永远基于"最新文本"：await 期间学生可能继续打字或删占位
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);

  const emit = (next: string) => { valueRef.current = next; onChange(next); };

  useEffect(() => { onUploadingChange?.(uploading > 0); }, [uploading, onUploadingChange]);

  /** 整段插入（批量占位用），光标落在插入内容之后 */
  const insertBlock = (block: string) => {
    const ta = ref.current;
    const base = valueRef.current;
    const start = ta?.selectionStart ?? base.length;
    const end = ta?.selectionEnd ?? base.length;
    const needsLead = start > 0 && base[start - 1] !== '\n';
    const needsTail = end < base.length && base[end] !== '\n';
    const text = `${needsLead ? '\n' : ''}${block}${needsTail ? '\n' : ''}`;
    emit(base.slice(0, start) + text + base.slice(end));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  };

  /** 精确替换一个占位串；找不到（学生已删除）就丢弃结果，绝不追加或复活 */
  const replaceToken = (token: string, replacement: string) => {
    const cur = valueRef.current;
    const idx = cur.indexOf(token);
    if (idx < 0) return;
    emit(cur.slice(0, idx) + replacement + cur.slice(idx + token.length));
    const el = ref.current;
    const sel = el?.selectionStart;
    if (!el || sel == null || sel <= idx) return;
    // 光标在占位之后：按长度差平移，别让它落进替换后的文字里
    const pos = sel >= idx + token.length ? sel + (replacement.length - token.length) : idx + replacement.length;
    requestAnimationFrame(() => el.setSelectionRange(pos, pos));
  };

  const handleImageFiles = async (files: File[]) => {
    const accepted: File[] = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMAGE_BYTES) { toast('error', '图片过大（最大 5MB）'); continue; }
      accepted.push(f);
    }
    if (accepted.length === 0) return;
    if (accepted.length > 6) toast('error', '图片较多，建议精简');

    const startIdx = nextImageIndex(valueRef.current);
    const tokens = accepted.map((_, i) => pendingToken(startIdx + i));
    insertBlock(tokens.join('\n')); // 一次 onChange 插入全部占位：逐张插会让受控光标漂移

    setUploading((n) => n + accepted.length);
    for (let i = 0; i < accepted.length; i++) {
      const token = tokens[i];
      const n = startIdx + i;
      try {
        const jpeg = await ensureJpeg(accepted[i]);
        const compressed = await compressImageFile(jpeg);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
        try {
          const { url } = await uploadFile(compressed, ctrl.signal);
          replaceToken(token, `![图${n}](${url})`);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        replaceToken(token, failedToken(n));
        toast('error', '图片上传失败，请重试');
      } finally {
        setUploading((n2) => n2 - 1);
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    // 必须在 await 之前同步读完 clipboardData（事件对象随后就失效）
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const f = item.getAsFile();
      if (f) files.push(f);
    }
    if (files.length === 0) return; // 纯文本：放行浏览器原生粘贴
    e.preventDefault();
    void handleImageFiles(files);
  };

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    void handleImageFiles(files);
  };
```

textarea 上补：

```tsx
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        className={`flex-1 w-full p-3 resize-none outline-none bg-transparent text-[var(--text-primary)] font-mono text-sm leading-relaxed${dragging ? ' ring-2 ring-[var(--brand-500)]' : ''}`}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/LatexEditor.test.tsx`
Expected: PASS（既有符号面板/滚动用例 + 新增 10 条）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/business/LatexEditor.tsx apps/web/src/components/business/LatexEditor.test.tsx
git commit -m "feat(web): 作答区粘贴/拖入图片（占位-上传-替换，纯文本占位防破图）"
```

---

### Task 7: QuestionRunner 接上（大图样式 + 上传中禁提交）

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx:601-606`（预览）、`:650-656`（提交按钮）、组件状态区
- Test: `apps/web/src/components/business/answer/QuestionRunner.test.tsx`

**Interfaces:**
- Consumes: `LatexEditor.onUploadingChange`（Task 6）、`PreviewDraftPanel.imgClassName`（Task 5）、`ANSWER_IMG_CLASS`（Task 3）

- [ ] **Step 1: 写失败测试**

`QuestionRunner.test.tsx` 顶部加 mock（必须透传原模块，`@/analytics/tracker` 也依赖 `@/services/api`）：

```tsx
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, uploadFile: vi.fn(() => new Promise(() => {})) };
});
```

追加用例：

```tsx
it('作答图上传中：提交按钮禁用，上传完成恢复（防占位文本落库）', async () => {
  const questions = [{ n: '1', text: '电路图题', type: 'short_answer' }];
  render(
    <QuestionRunner
      questions={questions}
      subjectId={1}
      answerInput="latex"
      draftKeyPrefix="img"
      variant="embedded"
      draftDisabled
      hints={{}}
      onRequestHint={async () => 'hint'}
      headerActions={() => null}
      onQuestionChange={() => {}}
      onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: null, method: 'self_assess' })}
      onFinish={async () => {}}
    />,
  );
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement;

  const evt = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
  Object.defineProperty(evt, 'clipboardData', {
    value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['x'], 'a.png', { type: 'image/png' }) }] },
  });
  fireEvent(ta, evt);

  await waitFor(() => expect((screen.getByRole('button', { name: '提交' }) as HTMLButtonElement).disabled).toBe(true));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx -t "上传中"`
Expected: FAIL —— 粘贴后按钮仍可点（`onUploadingChange` 没接）。

- [ ] **Step 3: 写实现**

`QuestionRunner.tsx`：

```tsx
import { ANSWER_IMG_CLASS } from '@/components/markdown'; // 若已从该模块多路引入，合并进现有 import

// 组件状态区（与 selfAssess 等并列）
const [answerUploading, setAnswerUploading] = useState(false);
```

LatexEditor（`:591` 一带）：

```tsx
<LatexEditor
  value={answer}
  onChange={updateAnswer}
  scrollSync={previewScrollSync}
  onUploadingChange={setAnswerUploading}
/>
```

PreviewDraftPanel（`:601`）：

```tsx
<PreviewDraftPanel
  answer={answer}
  questionId={`${draftKeyPrefix}-${q.n}`}
  enabled={!draftDisabled && subjectId === MATH_SUBJECT_ID}
  scrollSync={previewScrollSync}
  imgClassName={ANSWER_IMG_CLASS}
/>
```

提交按钮（`:650`）：

```tsx
<button
  onClick={handleSubmit}
  disabled={!answer.trim() || answerUploading}
  title={answerUploading ? '图片上传中' : '提交'}
  aria-label="提交"
  className="w-12 h-12 rounded-full bg-[var(--brand-500)] text-white flex items-center justify-center disabled:opacity-40 hover:bg-[var(--brand-600)] transition-all shadow-md"
>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx`
Expected: PASS（既有用例 + 新增 1 条）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/business/answer/QuestionRunner.tsx apps/web/src/components/business/answer/QuestionRunner.test.tsx
git commit -m "feat(web): 答题器使用大图预览，上传中禁用提交"
```

---

### Task 8: 结果页学生答案按大图显示

**Files:**
- Modify: `apps/web/src/components/business/AnswerResultList.tsx:219-224`
- Test: `apps/web/src/components/business/AnswerResultList.test.tsx`（新建）

**Interfaces:**
- Consumes: `makeAnswerComponents`（Task 3）

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/components/business/AnswerResultList.test.tsx
// 学生答案里的手绘图在结果页必须能看清（默认题面小图样式会压成 50px 细条）。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AnswerResultList } from './AnswerResultList';

afterEach(() => cleanup());

it('学生答案含图片：结果页按作答大图样式渲染', () => {
  render(
    <AnswerResultList
      questions={[{ n: '1', text: '电路图题' }]}
      answers={{ '1': { isCorrect: false, method: 'self_assess', studentAnswer: '2. ![图1](/uploads/a/b.png)' } }}
      onClose={() => {}}
    />,
  );
  const img = screen.getByRole('img');
  expect(img.getAttribute('src')).toBe('/uploads/a/b.png');
  expect(img.className).toContain('max-h-[40vh]');
  expect(img.className).not.toContain('h-[50px]');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/AnswerResultList.test.tsx`
Expected: FAIL —— className 含 `h-[50px]`。

- [ ] **Step 3: 写实现**

```tsx
import { makeAnswerComponents } from '@/components/markdown';

/** 模块级常量：渲染里现造组件表会让 <img> 每次重挂、反复下载 */
const answerComponents = makeAnswerComponents();
```

把 `:221` 的 `components={markdownComponents}` 换成 `components={answerComponents}`（只换学生答案这一处，参考答案/解析保持原样）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/AnswerResultList.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/business/AnswerResultList.tsx apps/web/src/components/business/AnswerResultList.test.tsx
git commit -m "feat(web): 结果页学生答案里的手绘图按大图显示"
```

---

### Task 9: 全量回归 + 文档

**Files:**
- Modify: `docs/ai-core-changelog.md`（顶部追加条目）

- [ ] **Step 1: 跑全量前端测试**

```bash
cd apps/web && npm test
```

Expected: 全绿。若出现与本次无关的既有失败，记录在提交说明里，不要顺手改。

- [ ] **Step 2: 类型与构建**

```bash
cd apps/web && npm run lint && npm run build
```

Expected: 均通过（`tsc -b` 无 error）。

- [ ] **Step 3: 走一遍 spec §11.2 手工清单**

按 `docs/superpowers/specs/2026-11-01-answer-paste-image-design.md` §11.2 逐条验（含 iPad 粘贴、弱网、断网、暗色、7 张上限）。任何一条不通，回到对应 Task 修，不要跳过。

- [ ] **Step 4: 写 changelog**

在 `docs/ai-core-changelog.md` 顶部（`---` 之后、最新条目之前）插入：

```markdown
## 2026-11-01 新增：作答区粘贴图片（物理/化学手绘图）

**问题**：`LatexEditor` 是纯 textarea，图片剪贴板粘进去毫无反应（静默失败）；草稿板能画能贴但提交即清空，学生"草稿画→截图→粘贴"断在最后一步。题目又不保证分小问、分空（题干可能整段不换行），系统无法推断"这题几个空"。

**方案**：图片走 Markdown 图片语法写进答案文本（`answer_text` 是 TEXT，零 schema 改动）。
- 粘贴/拖入 → 压到最长边 1600 转 JPEG（白底）→ `POST /api/files/upload` → 光标处插入 `![图N](/uploads/…)`。
- 占位是**纯文本** `［图N 上传中…］`，不产生 `<img>`，预览不会闪破图；失败留 `［图N 上传失败］`，不阻断作答。
- 排序由图片在文本流中的位置决定（不解析学生的编号/分隔符）；归属由 alt 声明（`第2问`），未写则按出现顺序。
- 上传中禁用提交，防止占位文本落库。

**已知缺口**：模型不读图（只看到 `![第2问](url)` 文本）；`/uploads` 是静态公开目录、无清理策略；判题前未剥离 Markdown 图片。均记在 spec §10。
```

- [ ] **Step 5: 提交**

```bash
git add docs/ai-core-changelog.md
git commit -m "docs: 记录作答区贴图变更与已知缺口"
```

---

### Task 10（条件执行）：iPad 粘贴不可达时的最小入口

**触发条件**：Task 1 Step 3 判定"paste 事件拿不到图片"。

**Files:**
- Modify: `apps/web/src/components/business/LatexEditor.tsx`
- Test: `apps/web/src/components/business/LatexEditor.test.tsx`

**Interfaces:**
- Produces: 编辑器底部一个「插入图片」按钮（线性 SVG 图标），点击打开 `<input type="file" accept="image/*" multiple hidden>`，选中文件走**同一个** `handleImageFiles`

- [ ] **Step 1: 写失败测试**

```tsx
it('点「插入图片」选文件：走同一上传路径（iPad 无粘贴时的兜底入口）', async () => {
  vi.mocked(uploadFile).mockResolvedValue({ fileId: 1, url: '/uploads/auxiliary/p.jpg' });
  const { container } = render(<LatexEditor value="" onChange={() => {}} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  fireEvent.change(input, { target: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } });
  await waitFor(() => expect(vi.mocked(uploadFile)).toHaveBeenCalled());
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/LatexEditor.test.tsx -t "插入图片"`
Expected: FAIL —— `input` 为 null。

- [ ] **Step 3: 写实现**

`LatexEditor.tsx` 的 `SymbolPalette` 下方加一行工具条（不放进 textarea 内，避免影响光标）：

```tsx
      <div className="flex items-center gap-2 px-3 pb-1">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="h-8 px-3 rounded-lg border border-[var(--bg-subtle)] text-[var(--text-secondary)] text-xs hover:bg-[var(--bg-base)] transition-colors"
        >
          插入图片
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ''; // 允许连续选同一张
            if (files.length) void handleImageFiles(files);
          }}
        />
      </div>
```

补 `const fileInputRef = useRef<HTMLInputElement>(null);`。图标用线性 SVG（`stroke="currentColor"`），不要 emoji。

- [ ] **Step 4: 跑测试确认通过并全量回归**

Run: `cd apps/web && npx vitest run src/components/business/LatexEditor.test.tsx && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/business/LatexEditor.tsx apps/web/src/components/business/LatexEditor.test.tsx
git commit -m "feat(web): iPad 无图片粘贴时的兜底入口（插入图片按钮）"
```

---

## 自审记录

**Spec 覆盖**：§4.1 粘贴流程 → Task 6；§4.2 拖拽 → Task 6；§5 alt → 无需代码（文本自带）；§6 预览 → Task 3/4；§6.1 滚动 → Task 4；§6.2（无需加固，只补回归）→ Task 4 测试；§7 结果页 → Task 8；§8 边界（禁提交/删占位/超限/HEIC/白底）→ Task 6/7；§9 文件表 → Task 2–8；§11 测试 → 各 Task；§8 iPad 风险 → Task 1/10。

**未覆盖（有意）**：图片数量软限制的 UI 提示只说 toast、不做计数面板；`/uploads` 权限与清理（spec §10）。

**类型一致性**：`scaleSize`/`compressImageFile`/`MAX_IMAGE_BYTES`（Task 2）→ Task 6 引用一致；`ANSWER_IMG_CLASS`/`makeAnswerComponents`（Task 3）→ Task 4/5/7/8 引用一致；`onUploadingChange`（Task 6）→ Task 7 引用一致。
