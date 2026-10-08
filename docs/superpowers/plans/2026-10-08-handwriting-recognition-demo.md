# 手写汉字识别率调研 demo 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 dev-only 调研页 `/dev/handwriting-demo`：手写汉字 → 多模态模型转写 → 前端 LCS 字级比对出准确率，用于裁决 PRD §15「手写直接作为答案提交」是否立项。

**Architecture:** 前端精简复制草稿白板（笔/橡皮/清空）+ 离屏 canvas 导出 PNG dataURL；后端新增 `modules/dev/` 两个端点，从 `ModelConfigRegistry` 取模型配置、经 `ModelClient` 直调（纯转写 prompt，非流式）；比对是纯前端纯函数（归一化 + LCS）。

**Tech Stack:** React 19 + Vite + Tailwind（web）；NestJS + vitest（server）；无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-08-handwriting-recognition-demo-design.md`（已获批）

## Global Constraints

- UI 不用 emoji；图标用线性 SVG 或文字按钮（本 demo 用文字按钮即可）。
- 页面写死 `data-theme="student-day"`，**不**用 `student-theme-container` 类（它会 18:00 后自动切夜间，违反 spec「写死日间」）；颜色一律 `var(--token)` 形式（参考 `StudentLockedPage.tsx:32-45` 的写法）。
- 服务端不落库、不写 request-log；LLM 调用 `meta: { studentId: null, capability: 'handwriting_demo' }`（显式不归属任何学生）。
- 组件测试必须自写 `afterEach(() => cleanup())`（`globals: false`）。
- jsdom 无 canvas 2d / setPointerCapture / ResizeObserver，统一用 `DraftWhiteboard.test.tsx:24-39` 的 stub 模式。
- Nest DI 坑：`DevHandwritingService` 构造参数是接口/对象字面量类型，**不写 `@Injectable()`**，在 Module 里用 `useFactory` 手动实例化（与 ai-core capabilities 同策略）。
- 测试与文档同步铁律：断言冲突时改测试，不改 config/设计文档。

## File Structure

```
apps/web/src/pages/dev/
  handwriting-diff.ts          — 归一化 + LCS 比对纯函数（无依赖）
  handwriting-diff.test.ts     — 纯函数单测
  DemoSketchPad.tsx            — 精简手写面板（笔/橡皮/清空 + 导出）
  DemoSketchPad.test.tsx       — 渲染测试
  HandwritingDemoPage.tsx      — demo 页（控制条 + 面板 + 结果区，状态机）
  HandwritingDemoPage.test.tsx — 页面状态机测试（mock 子组件与 API）
apps/web/src/routes/routeTable.tsx        — 加一条 /dev/handwriting-demo 路由
apps/web/src/services/api.ts             — 加两个 API 函数
apps/server/src/modules/dev/
  dev-handwriting.service.ts   — 校验 + 构造 messages + 调 ModelClient
  dev-handwriting.service.test.ts
  dev-handwriting.controller.ts
  dev.module.ts
apps/server/src/app.module.ts             — 注册 DevModule
apps/server/src/modules/billing/subscription.guard.ts — SUBSCRIPTION_EXEMPT 加 2 行
```

---

### Task 1: `handwriting-diff.ts` 比对纯函数

**Files:**
- Create: `apps/web/src/pages/dev/handwriting-diff.ts`
- Test: `apps/web/src/pages/dev/handwriting-diff.test.ts`

**Interfaces:**
- Consumes: 无（零依赖纯函数）
- Produces: Task 4 页面使用 —— `normalizeForCompare(s: string): string`、`compareHandwriting(expected: string, recognized: string): CompareResult`，其中

```ts
export interface DiffError { expected: string; got: string | null } // got=null=漏字
export interface CompareResult {
  expected: string;        // 归一化后的期望串
  recognized: string;      // 归一化后的识别串
  matched: number;         // LCS 匹配数
  accuracy: number;        // matched / expected.length；期望为空时：识别也空=1 否则=0
  errors: DiffError[];     // 错字 + 漏字（LCS 对齐产出，按书写顺序）
  extra: string[];         // 多识别出的字（不冲抵准确率）
}
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/pages/dev/handwriting-diff.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeForCompare, compareHandwriting } from './handwriting-diff';

describe('normalizeForCompare', () => {
  it('去空白、去中西文标点、全角转半角、英文小写', () => {
    expect(normalizeForCompare(' 春天，真好！ABC　ｄｅｆ ')).toBe('春天真好abcdef');
    expect(normalizeForCompare('——「引号」、逗号。')).toBe('引号逗号');
  });
});

describe('compareHandwriting', () => {
  it('完全一致 → accuracy 1，无错误', () => {
    const r = compareHandwriting('今天天气很好', '今天，天气很好。');
    expect(r.accuracy).toBe(1);
    expect(r.matched).toBe(6);
    expect(r.errors).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it('错一个字 → 该字进 errors（expected 带 got）', () => {
    const r = compareHandwriting('今天天气很好', '今天田气很好');
    expect(r.accuracy).toBeCloseTo(5 / 6);
    expect(r.errors).toEqual([{ expected: '天', got: '田' }]);
    expect(r.extra).toEqual([]);
  });

  it('漏一个字 → errors 里 got=null', () => {
    const r = compareHandwriting('今天天气很好', '今天气很好');
    expect(r.accuracy).toBeCloseTo(5 / 6);
    expect(r.errors).toEqual([{ expected: '天', got: null }]);
  });

  it('多一个字 → 进 extra，不冲抵准确率', () => {
    const r = compareHandwriting('你好', '你号好呀');
    // LCS 对齐：「你」配「你」→ 期望「好」对识别「号」是错字，识别「呀」是多出
    expect(r.matched).toBe(1);
    expect(r.accuracy).toBeCloseTo(1 / 2);
    expect(r.errors).toEqual([{ expected: '好', got: '号' }]);
    expect(r.extra).toEqual(['呀']);
  });

  it('期望为空：识别也空 = 1，识别非空 = 0 且全进 extra', () => {
    expect(compareHandwriting('', '').accuracy).toBe(1);
    const r = compareHandwriting('', 'abc');
    expect(r.accuracy).toBe(0);
    expect(r.extra).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npm test -- handwriting-diff`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// apps/web/src/pages/dev/handwriting-diff.ts
/** 手写识别率比对的归一化 + LCS 字级对齐。纯函数、零依赖（spec §6）。 */

/** 归一化：NFKC（全角→半角）→ 去空白与全部 Unicode 标点（中西文）→ 英文小写。 */
export function normalizeForCompare(s: string): string {
  return s.normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

export interface DiffError { expected: string; got: string | null }

export interface CompareResult {
  expected: string;
  recognized: string;
  matched: number;
  accuracy: number;
  errors: DiffError[];
  extra: string[];
}

export function compareHandwriting(expected: string, recognized: string): CompareResult {
  const e = [...normalizeForCompare(expected)];
  const r = [...normalizeForCompare(recognized)];
  const m = e.length;
  const n = r.length;

  // dp[i][j] = e 前 i 个与 r 前 j 个的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = e[i - 1] === r[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // 回溯出对齐序列（顺序对）
  type Pair = { expected: string | null; got: string | null };
  const pairs: Pair[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && e[i - 1] === r[j - 1]) {
      pairs.push({ expected: e[i - 1], got: r[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      pairs.push({ expected: null, got: r[j - 1] }); // 多识别
      j--;
    } else {
      pairs.push({ expected: e[i - 1], got: null }); // 漏识别
      i--;
    }
  }
  pairs.reverse();

  const matched = dp[m][n];
  const accuracy = m === 0 ? (n === 0 ? 1 : 0) : matched / m;
  const errors: DiffError[] = [];
  const extra: string[] = [];
  for (const p of pairs) {
    if (p.expected === null) extra.push(p.got as string);
    else if (p.got !== p.expected) errors.push({ expected: p.expected, got: p.got });
  }
  return { expected: e.join(''), recognized: r.join(''), matched, accuracy, errors, extra };
}
```

注意 LCS 错字语义：一对 `expected≠got` 只在「错字」时出现；若期望「天」识别缺字，回溯会给 `expected:'天', got:null`。`errors` 同时覆盖错字与漏字。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npm test -- handwriting-diff`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/dev/handwriting-diff.ts apps/web/src/pages/dev/handwriting-diff.test.ts
git commit -m "feat: 手写识别 demo 字级比对纯函数（归一化+LCS）"
```

---

### Task 2: 后端 dev 模块（两个端点）

**Files:**
- Create: `apps/server/src/modules/dev/dev-handwriting.service.ts`
- Create: `apps/server/src/modules/dev/dev-handwriting.service.test.ts`
- Create: `apps/server/src/modules/dev/dev-handwriting.controller.ts`
- Create: `apps/server/src/modules/dev/dev.module.ts`
- Modify: `apps/server/src/app.module.ts`（import DevModule + imports 数组加一行）
- Modify: `apps/server/src/modules/billing/subscription.guard.ts:15-18`（SUBSCRIPTION_EXEMPT 加 2 行）

**Interfaces:**
- Consumes: `getModelConfigRegistry()`（`apps/server/src/ai-core/infra/model-config-registry.ts:91`）、`ModelClient.chat({ model: RoutedModel, messages, timeout, meta })`（`apps/server/src/ai-core/infra/model-client/index.ts:110`）、`timeoutConfig.timeout.default`（`apps/server/src/ai-core/config.ts`）。
- Produces: `GET /api/dev/handwriting/models` → `{ models: [{ key, provider, modelId }] }`；`POST /api/dev/handwriting/recognize` body `{ image, modelKey }` → `{ text, modelKey, elapsedMs }`。Task 4 的前端 `api.ts` 按此消费。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/modules/dev/dev-handwriting.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../ai-core/infra/model-config-registry.js', () => ({
  getModelConfigRegistry: vi.fn(),
}));

import { getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import {
  DevHandwritingService,
  HANDWRITING_SYSTEM_PROMPT,
} from './dev-handwriting.service.js';

const fakeModelConfig = {
  modelId: 'qwen3.8-max',
  provider: 'qwen',
  baseUrl: 'https://dashscope.example/compatible-mode/v1',
  contextWindow: 8192,
  maxOutputTokens: 2048,
  costPer1K: { input: 0, output: 0 },
  supportsStreaming: true,
  apiKey: 'sk-test',
};

function mockRegistry(models: Record<string, object>) {
  vi.mocked(getModelConfigRegistry).mockReturnValue({
    getSnapshot: () => ({ models, routes: {}, default: { primary: '', fallback: '' } }),
  } as never);
}

function makeService(chatImpl?: () => Promise<unknown>) {
  const chat = vi.fn(chatImpl ?? (async () => ({ content: '  天空很蓝 ' })));
  const service = new DevHandwritingService({
    modelClient: { chat } as never,
  });
  return { service, chat };
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
  vi.clearAllMocks();
  mockRegistry({ 'qwen-test': fakeModelConfig });
});

describe('listModels', () => {
  it('只暴露 key/provider/modelId，绝不带 apiKey', () => {
    const { service } = makeService();
    const res = service.listModels();
    expect(res.models).toEqual([
      { key: 'qwen-test', provider: 'qwen', modelId: 'qwen3.8-max' },
    ]);
    expect(JSON.stringify(res)).not.toContain('sk-test');
  });

  it('registry 未初始化 → 503', () => {
    vi.mocked(getModelConfigRegistry).mockReturnValue(undefined);
    const { service } = makeService();
    expect(() => service.listModels()).toThrowError(
      expect.objectContaining({ status: 503 }),
    );
  });
});

describe('recognize', () => {
  it('正常路径：system+user 消息、image_url 部件、meta 不归属学生、返回 trim 后文本', async () => {
    const { service, chat } = makeService();
    const res = await service.recognize(PNG, 'qwen-test');
    expect(res).toMatchObject({ text: '天空很蓝', modelKey: 'qwen-test' });
    expect(typeof res.elapsedMs).toBe('number');
    const req = chat.mock.calls[0][0] as { messages: unknown[]; meta: unknown };
    expect(req.messages[0]).toEqual({ role: 'system', content: HANDWRITING_SYSTEM_PROMPT });
    expect(req.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '转写' },
        { type: 'image_url', image_url: { url: PNG } },
      ],
    });
    expect(req.meta).toEqual({ studentId: null, capability: 'handwriting_demo' });
  });

  it('image 前缀非法 → 400', async () => {
    const { service } = makeService();
    await expect(service.recognize('data:text/html;base64,xxx', 'qwen-test')).rejects.toMatchObject({ status: 400 });
    await expect(service.recognize('not-a-url', 'qwen-test')).rejects.toMatchObject({ status: 400 });
  });

  it('解码后 >4MB → 400', async () => {
    const { service } = makeService();
    const big = 'data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    await expect(service.recognize(big, 'qwen-test')).rejects.toMatchObject({ status: 400 });
  });

  it('modelKey 不存在 → 404', async () => {
    const { service } = makeService();
    await expect(service.recognize(PNG, 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('上游模型失败 → 502', async () => {
    const { service } = makeService(async () => { throw new Error('upstream boom'); });
    await expect(service.recognize(PNG, 'qwen-test')).rejects.toMatchObject({ status: 502 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npm test -- dev-handwriting`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 service**

```ts
// apps/server/src/modules/dev/dev-handwriting.service.ts
import { BadRequestException, NotFoundException, ServiceUnavailableException, BadGatewayException } from '@nestjs/common';
import { getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import { ModelClient } from '../../ai-core/infra/model-client/index.js';
import { timeoutConfig } from '../../ai-core/config.js';
import type { ChatMessage, RoutedModel } from '../../ai-core/types.js';

/**
 * 手写识别率调研 demo（spec 2026-10-08）：纯转写、不落库、不写 request-log。
 * 注意：**不写 @Injectable()**——构造参数是对象字面量类型（DI 坑），
 * DevModule 用 useFactory 手动实例化。
 */
export const HANDWRITING_SYSTEM_PROMPT =
  '你是 OCR 引擎。把图片中的手写汉字逐字转写为简体中文纯文本，只输出转写结果本身，不要输出任何解释或多余符号。无法辨认的字输出最接近的猜测。';

const IMAGE_PREFIX = /^data:image\/(png|jpeg);base64,/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface DevModelListResult {
  models: { key: string; provider: string; modelId: string }[];
}

export interface DevRecognizeResult {
  text: string;
  modelKey: string;
  elapsedMs: number;
}

export class DevHandwritingService {
  private modelClient: ModelClient;

  constructor(deps?: { modelClient?: ModelClient }) {
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  listModels(): DevModelListResult {
    const registry = getModelConfigRegistry();
    if (!registry) {
      throw new ServiceUnavailableException({ code: 5300, message: '模型配置未初始化' });
    }
    const snapshot = registry.getSnapshot();
    return {
      models: Object.entries(snapshot.models).map(([key, m]) => ({
        key,
        provider: m.provider,
        modelId: m.modelId,
      })),
    };
  }

  async recognize(image: string, modelKey: string): Promise<DevRecognizeResult> {
    // 1. image 格式与大小（spec §5.2 校验表）
    if (typeof image !== 'string' || !IMAGE_PREFIX.test(image)) {
      throw new BadRequestException({ code: 4001, message: 'image 必须是 data:image/png|jpeg;base64 格式' });
    }
    const base64 = image.slice(image.indexOf(',') + 1);
    if (Buffer.from(base64, 'base64').length > MAX_IMAGE_BYTES) {
      throw new BadRequestException({ code: 4002, message: '图片解码后超过 4MB' });
    }
    // 2. modelKey 必须在 registry
    const registry = getModelConfigRegistry();
    const cfg = registry?.getSnapshot().models[modelKey];
    if (!cfg) {
      throw new NotFoundException({ code: 4404, message: `未知模型：${modelKey}` });
    }
    // 3. 构造消息：system 转写指令 + user（text + image_url 部件，与 tutoring 同构）
    const messages: ChatMessage[] = [
      { role: 'system', content: HANDWRITING_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '转写' },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ];
    const model: RoutedModel = { ...cfg, modelKey };
    const start = Date.now();
    try {
      // meta 显式 studentId:null = 明确不归属任何学生（llm 账本不记到学生头上）
      const res = await this.modelClient.chat({
        model,
        messages,
        timeout: timeoutConfig.timeout.default,
        meta: { studentId: null, capability: 'handwriting_demo' },
      });
      return { text: res.content.trim(), modelKey, elapsedMs: Date.now() - start };
    } catch (err) {
      throw new BadGatewayException({
        code: 5502,
        message: `识别模型调用失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}
```

- [ ] **Step 4: 实现 controller + module**

```ts
// apps/server/src/modules/dev/dev-handwriting.controller.ts
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { DevHandwritingService } from './dev-handwriting.service.js';

/** 任一已登录角色可调（RolesGuard 无 @Roles 即放行，JWT 由 JwtAuthGuard 把守）。 */
@Controller('api/dev/handwriting')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DevHandwritingController {
  constructor(private readonly service: DevHandwritingService) {}

  @Get('models')
  listModels() {
    return this.service.listModels();
  }

  @Post('recognize')
  recognize(@Body() dto: { image?: string; modelKey?: string }) {
    return this.service.recognize(dto.image as string, dto.modelKey as string);
  }
}
```

```ts
// apps/server/src/modules/dev/dev.module.ts
import { Module } from '@nestjs/common';
import { DevHandwritingController } from './dev-handwriting.controller.js';
import { DevHandwritingService } from './dev-handwriting.service.js';

@Module({
  controllers: [DevHandwritingController],
  // useFactory 手动实例化：DevHandwritingService 故意不写 @Injectable()（DI 坑，见 Global Constraints）
  providers: [{ provide: DevHandwritingService, useFactory: () => new DevHandwritingService() }],
})
export class DevModule {}
```

- [ ] **Step 5: 注册进 AppModule + 订阅豁免**

`apps/server/src/app.module.ts`：import 区加 `import { DevModule } from './modules/dev/dev.module.js';`，imports 数组末尾（`BillingModule,` 之后）加：

```ts
    // 手写识别率调研 demo（2026-10-08）—— dev-only 两个端点，不落库
    DevModule,
```

`apps/server/src/modules/billing/subscription.guard.ts` 的 `SUBSCRIPTION_EXEMPT` 数组加两行（学生角色未订阅时也能用 demo）：

```ts
  { method: 'GET', pattern: /^\/api\/dev\/handwriting\/models$/ },      // 手写识别 demo（dev-only）
  { method: 'POST', pattern: /^\/api\/dev\/handwriting\/recognize$/ },  // 同上
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/server && npm test -- dev-handwriting`
Expected: PASS（9 个用例）

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/dev apps/server/src/app.module.ts apps/server/src/modules/billing/subscription.guard.ts
git commit -m "feat: 手写识别 demo 后端（/api/dev/handwriting models+recognize）"
```

---

### Task 3: `DemoSketchPad.tsx` 手写面板

**Files:**
- Create: `apps/web/src/pages/dev/DemoSketchPad.tsx`
- Test: `apps/web/src/pages/dev/DemoSketchPad.test.tsx`

**Interfaces:**
- Consumes: 无（自带 Stroke/pointFromEvent/strokePath 精简版，**不 import** `draft-store`/`DraftWhiteboard`，避免与答题弹窗耦合）
- Produces: Task 4 页面使用 ——

```tsx
export interface DemoSketchPadHandle {
  exportImage(): string | null; // 白底黑字 PNG dataURL；无笔画返回 null
  clear(): void;
}
function DemoSketchPad(props: {
  onStrokesChange?: (count: number) => void; // 笔画数变化即回调（页面据此禁用/启用识别按钮）
}): import('react').RefForwardingComponent  // forwardRef 暴露 DemoSketchPadHandle
```

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/pages/dev/DemoSketchPad.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import DemoSketchPad, { type DemoSketchPadHandle } from './DemoSketchPad';

beforeEach(() => {
  // jsdom 无 canvas 2d：记录型 stub（模式同 DraftWhiteboard.test.tsx）
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    clearRect() {}, setTransform() {}, beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, stroke() {},
    save() {}, restore() {}, fillRect() {},
  }) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAA');
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => {}, configurable: true });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} disconnect() {} };
});

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

function penLine(canvas: Element, y: number) {
  fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: y });
  fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 200, clientY: y });
  fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: y });
}

it('初始无笔画：onStrokesChange(0)，exportImage 返回 null', () => {
  const ref = createRef<DemoSketchPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<DemoSketchPad ref={ref} onStrokesChange={onStrokesChange} />);
  expect(onStrokesChange).toHaveBeenCalledWith(0);
  expect(ref.current!.exportImage()).toBeNull();
  expect(container.querySelector('canvas')).toBeTruthy();
});

it('画一条笔画 → count 1；exportImage 返回 dataURL；清空 → count 0 且 export 为 null', () => {
  const ref = createRef<DemoSketchPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<DemoSketchPad ref={ref} onStrokesChange={onStrokesChange} />);
  penLine(container.querySelector('canvas')!, 50);
  expect(onStrokesChange).toHaveBeenLastCalledWith(1);
  expect(ref.current!.exportImage()).toBe('data:image/png;base64,AAA');
  fireEvent.click(container.querySelector('button[title="清空"]')!);
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
  expect(ref.current!.exportImage()).toBeNull();
});

it('橡皮：擦过的笔画整条消失', () => {
  const ref = createRef<DemoSketchPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<DemoSketchPad ref={ref} onStrokesChange={onStrokesChange} />);
  const canvas = container.querySelector('canvas')!;
  penLine(canvas, 50);
  fireEvent.click(container.querySelector('button[title="橡皮"]')!);
  // 划过笔画中段 (150,50)，容差 size(3)+8 → 命中整条擦除
  fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 150, clientY: 50 });
  fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: 'mouse', clientX: 150, clientY: 50 });
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npm test -- DemoSketchPad`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

```tsx
// apps/web/src/pages/dev/DemoSketchPad.tsx
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

/**
 * 手写识别调研 demo 的手写面板：DraftWhiteboard 精简复制（笔/橡皮/清空），
 * 固定 720×360，导出白底黑字 PNG（识别模型对白底黑字最稳，导出不随主题，spec §4.3）。
 * 有意不 import draft-store：无题目隔离需求，笔迹只存组件内。
 */

export interface DemoPoint { x: number; y: number; pressure: number }
export interface DemoStroke { points: DemoPoint[]; size: number }

const BOARD_W = 720;
const BOARD_H = 360;
/** 导出线宽（CSS px）：白板原 2px 偏细，汉字识别需笔画清晰（spec §4.3） */
const INK_WIDTH = 3;
const ERASER_HIT_SLOP = 8;

/** 二次贝塞尔平滑渲染（逻辑同 DraftWhiteboard.strokePath，去掉 center 标记分支） */
function strokePath(ctx: CanvasRenderingContext2D, stroke: DemoStroke): void {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.size;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  ctx.stroke();
}

function distToSegmentSq(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx - px;
  const ey = y1 + t * dy - py;
  return ex * ex + ey * ey;
}

function hitStroke(stroke: DemoStroke, x: number, y: number, threshold: number): boolean {
  const pts = stroke.points;
  if (pts.length === 1) {
    return (pts[0].x - x) ** 2 + (pts[0].y - y) ** 2 <= threshold * threshold;
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegmentSq(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= threshold * threshold) {
      return true;
    }
  }
  return false;
}

export interface DemoSketchPadHandle {
  exportImage(): string | null;
  clear(): void;
}

const DemoSketchPad = forwardRef<DemoSketchPadHandle, { onStrokesChange?: (count: number) => void }>(
  function DemoSketchPad({ onStrokesChange }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const strokesRef = useRef<DemoStroke[]>([]);
    const drawingRef = useRef(false);
    const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
    const toolRef = useRef(tool);
    toolRef.current = tool;
    const drawingStrokeRef = useRef<DemoStroke | null>(null);

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, BOARD_W, BOARD_H);
      // 屏显笔迹颜色：写死深色（本页整体写死日间，spec §4.1）
      ctx.strokeStyle = '#111827';
      ctx.fillStyle = '#111827';
      for (const s of strokesRef.current) strokePath(ctx, s);
      if (drawingStrokeRef.current) {
        ctx.strokeStyle = '#111827';
        ctx.fillStyle = '#111827';
        strokePath(ctx, drawingStrokeRef.current);
      }
    }, []);

    // 固定尺寸画布：一次设置 dpr 缩放（720×360 逻辑 px）
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = BOARD_W * dpr;
      canvas.height = BOARD_H * dpr;
      redraw();
    }, [redraw]);

    const notifyCount = useCallback(() => {
      onStrokesChange?.(strokesRef.current.length);
    }, [onStrokesChange]);

    const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): DemoPoint => {
      const rect = e.currentTarget.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        pressure: e.pointerType === 'mouse' ? 0.5 : e.pressure || 0.5,
      };
    };

    const eraseAt = (x: number, y: number) => {
      const before = strokesRef.current.length;
      strokesRef.current = strokesRef.current.filter((s) => !hitStroke(s, x, y, s.size + ERASER_HIT_SLOP));
      if (strokesRef.current.length !== before) {
        notifyCount();
        redraw();
      }
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = pointFromEvent(e);
      if (toolRef.current === 'eraser') {
        eraseAt(p.x, p.y);
        return;
      }
      drawingRef.current = true;
      drawingStrokeRef.current = { points: [p], size: INK_WIDTH };
      redraw();
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const p = pointFromEvent(e);
      if (toolRef.current === 'eraser') {
        if (e.buttons) eraseAt(p.x, p.y);
        return;
      }
      if (!drawingRef.current || !drawingStrokeRef.current) return;
      drawingStrokeRef.current.points.push(p);
      redraw();
    };

    const handlePointerUp = () => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      if (drawingStrokeRef.current) {
        strokesRef.current.push(drawingStrokeRef.current);
        drawingStrokeRef.current = null;
        notifyCount();
      }
      redraw();
    };

    useImperativeHandle(ref, () => ({
      exportImage(): string | null {
        const strokes = strokesRef.current;
        if (strokes.length === 0) return null;
        const off = document.createElement('canvas');
        const scale = 2; // 导出 1440×720，给模型足够分辨率
        off.width = BOARD_W * scale;
        off.height = BOARD_H * scale;
        const ctx = off.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, off.width, off.height);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.strokeStyle = '#111827';
        ctx.fillStyle = '#111827';
        for (const s of strokes) strokePath(ctx, s);
        return off.toDataURL('image/png');
      },
      clear(): void {
        strokesRef.current = [];
        notifyCount();
        redraw();
      },
    }));

    return (
      <div className="inline-block rounded-[var(--radius-lg)] border border-[var(--border-primary)] bg-white p-2">
        <div className="mb-2 flex gap-2">
          <button
            type="button"
            title="笔"
            onClick={() => setTool('pen')}
            className={`rounded-[var(--radius-md)] px-3 py-1 text-sm ${tool === 'pen' ? 'bg-[var(--brand-600)] text-white' : 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'}`}
          >
            笔
          </button>
          <button
            type="button"
            title="橡皮"
            onClick={() => setTool('eraser')}
            className={`rounded-[var(--radius-md)] px-3 py-1 text-sm ${tool === 'eraser' ? 'bg-[var(--brand-600)] text-white' : 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'}`}
          >
            橡皮
          </button>
          <button
            type="button"
            title="清空"
            onClick={() => {
              strokesRef.current = [];
              notifyCount();
              redraw();
            }}
            className="rounded-[var(--radius-md)] bg-[var(--bg-secondary)] px-3 py-1 text-sm text-[var(--text-primary)]"
          >
            清空
          </button>
        </div>
        <canvas
          ref={canvasRef}
          style={{ width: BOARD_W, height: BOARD_H, touchAction: 'none' }}
          className="block rounded-[var(--radius-md)] border border-[var(--border-secondary)] bg-white"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>
    );
  },
);

export default DemoSketchPad;
```

（若 `var(--radius-lg)` / `var(--border-primary)` 等 token 名与 `apps/web/style.md` §2 实际名不符，以 style.md 为准替换，勿新造 token。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npm test -- DemoSketchPad`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/dev/DemoSketchPad.tsx apps/web/src/pages/dev/DemoSketchPad.test.tsx
git commit -m "feat: demo 手写面板（笔/橡皮/清空 + 白底黑字导出）"
```

---

### Task 4: demo 页面 + API 函数 + 路由

**Files:**
- Modify: `apps/web/src/services/api.ts`（文件末尾追加一段）
- Create: `apps/web/src/pages/dev/HandwritingDemoPage.tsx`
- Test: `apps/web/src/pages/dev/HandwritingDemoPage.test.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（加一条顶层路由 + import）

**Interfaces:**
- Consumes: Task 1 `compareHandwriting/CompareResult`；Task 2 端点形状 `{ models: [{key,provider,modelId}] }`、`{ text, modelKey, elapsedMs }`；Task 3 `DemoSketchPadHandle`。
- Produces: 路由 `/dev/handwriting-demo`。

- [ ] **Step 1: api.ts 追加两个函数**

在 `apps/web/src/services/api.ts` 末尾追加：

```ts
// --- Dev: 手写识别率调研 demo（2026-10-08，dev-only，不进导航） ---

export interface HandwritingModel {
  key: string;
  provider: string;
  modelId: string;
}

export interface HandwritingRecognizeResult {
  text: string;
  modelKey: string;
  elapsedMs: number;
}

export function listHandwritingModels(): Promise<{ models: HandwritingModel[] }> {
  return fetchApi('/dev/handwriting/models');
}

export function recognizeHandwriting(image: string, modelKey: string): Promise<HandwritingRecognizeResult> {
  return fetchApi('/dev/handwriting/recognize', {
    method: 'POST',
    body: JSON.stringify({ image, modelKey }),
  });
}
```

- [ ] **Step 2: 写页面失败测试**

```tsx
// apps/web/src/pages/dev/HandwritingDemoPage.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';

vi.mock('@/services/api', () => ({
  listHandwritingModels: vi.fn(),
  recognizeHandwriting: vi.fn(),
}));

import {
  listHandwritingModels,
  recognizeHandwriting,
} from '@/services/api';
import HandwritingDemoPage from './HandwritingDemoPage';

const MODELS = { models: [{ key: 'qwen-test', provider: 'qwen', modelId: 'qwen3.8-max' }] };

// mock 面板：exportImage 可控，另给一个「写入笔画」按钮驱动 onStrokesChange
let exportValue: string | null = null;
const MockPad = forwardRef(function MockPad(_, ref) {
  useImperativeHandle(ref, () => ({
    exportImage: () => exportValue,
    clear: () => { exportValue = null; },
  }));
  return (
    <button type="button" data-testid="mock-stroke" onClick={() => { exportValue = 'data:image/png;base64,AAA'; }}>
      stroke
    </button>
  );
});
vi.mock('./DemoSketchPad', () => ({ default: MockPad }));

beforeEach(() => {
  vi.clearAllMocks();
  exportValue = null;
  vi.mocked(listHandwritingModels).mockResolvedValue(MODELS);
});

afterEach(() => cleanup());

function setup() {
  render(<HandwritingDemoPage />);
  return {
    strokeBtn: screen.getByTestId('mock-stroke'),
    pad: screen.getByTestId('mock-stroke'),
  };
}

it('加载模型下拉并默认选第一个；初始识别按钮禁用（无笔画或无对照文本）', async () => {
  setup();
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('qwen-test'));
  const btn = screen.getByRole('button', { name: '识别' });
  expect(btn).toBeDisabled();
  // 写入笔画后仍缺对照文本 → 仍禁用
  fireEvent.click(screen.getByTestId('mock-stroke'));
  expect(btn).toBeDisabled();
});

it('完整一轮：填对照 → 识别 → 展示准确率与错字清单', async () => {
  vi.mocked(recognizeHandwriting).mockResolvedValue({ text: '今天田气很好', modelKey: 'qwen-test', elapsedMs: 123 });
  setup();
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('qwen-test'));
  fireEvent.click(screen.getByTestId('mock-stroke'));
  fireEvent.change(screen.getByLabelText('对照文本'), { target: { value: '今天天气很好' } });
  const btn = screen.getByRole('button', { name: '识别' });
  expect(btn).not.toBeDisabled();
  fireEvent.click(btn);
  await waitFor(() => expect(screen.getByText(/字级准确率/)).toBeTruthy());
  expect(recognizeHandwriting).toHaveBeenCalledWith('data:image/png;base64,AAA', 'qwen-test');
  expect(screen.getByText(/田/)).toBeTruthy(); // 错字清单出现错字
  expect(screen.getByText(/累计/)).toBeTruthy(); // 累计区出现
});

it('识别失败 → 显示错误信息，按钮恢复可用', async () => {
  vi.mocked(recognizeHandwriting).mockRejectedValue(new Error('识别模型调用失败：boom'));
  setup();
  await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
  fireEvent.click(screen.getByTestId('mock-stroke'));
  fireEvent.change(screen.getByLabelText('对照文本'), { target: { value: '测试' } });
  fireEvent.click(screen.getByRole('button', { name: '识别' }));
  await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
  expect(screen.getByRole('button', { name: '识别' })).not.toBeDisabled();
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/web && npm test -- HandwritingDemoPage`
Expected: FAIL（页面不存在）

- [ ] **Step 4: 实现页面**

页面状态机（spec §4.4 + 评审确认）：

```
models: 'loading' | 'ready' | 'loadError'
recognize: 'idle' | 'recognizing' | 'done' | 'error'
识别按钮禁用 = strokes === 0 || expected.trim() === '' || recognize === 'recognizing'
```

```tsx
// apps/web/src/pages/dev/HandwritingDemoPage.tsx
import { useEffect, useRef, useState } from 'react';
import {
  listHandwritingModels,
  recognizeHandwriting,
  type HandwritingModel,
  type HandwritingRecognizeResult,
} from '@/services/api';
import { compareHandwriting, type CompareResult } from './handwriting-diff';
import DemoSketchPad, { type DemoSketchPadHandle } from './DemoSketchPad';

/** 手写识别率调研 demo（spec 2026-10-08）。dev-only：不进导航、不留档（内存累计，刷新清空）。 */
export default function HandwritingDemoPage() {
  const padRef = useRef<DemoSketchPadHandle>(null);
  const [models, setModels] = useState<HandwritingModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelKey, setModelKey] = useState('');
  const [strokes, setStrokes] = useState(0);
  const [expected, setExpected] = useState('');
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ result: CompareResult; meta: HandwritingRecognizeResult; image: string } | null>(null);
  const [rounds, setRounds] = useState<{ accuracy: number; expected: string; recognized: string }[]>([]);

  useEffect(() => {
    listHandwritingModels()
      .then((res) => {
        setModels(res.models);
        setModelKey(res.models[0]?.key ?? '');
      })
      .catch((err: unknown) => setModelsError(err instanceof Error ? err.message : '模型列表加载失败'));
  }, []);

  const recognizeDisabled = strokes === 0 || expected.trim() === '' || recognizing;

  const onRecognize = async () => {
    const image = padRef.current?.exportImage();
    if (!image || !modelKey) return;
    setRecognizing(true);
    setError(null);
    try {
      const meta = await recognizeHandwriting(image, modelKey);
      const result = compareHandwriting(expected, meta.text);
      setLast({ result, meta, image });
      setRounds((rs) => [...rs, { accuracy: result.accuracy, expected: result.expected, recognized: result.recognized }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '识别失败');
    } finally {
      setRecognizing(false);
    }
  };

  // 累计口径：所有轮次合并重算（拼接归一化串再比，避免逐轮平均的辛普森悖论）
  const totalExpected = rounds.map((r) => r.expected).join('');
  const totalRecognized = rounds.map((r) => r.recognized).join('');
  const total = rounds.length > 0 ? compareHandwriting(totalExpected, totalRecognized) : null;

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] px-6 py-8 text-[var(--text-primary)]" data-theme="student-day">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <h1 className="text-xl font-black">手写汉字识别率调研</h1>

        {/* 控制条 */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            模型
            {modelsError ? (
              <span className="text-red-600">{modelsError}</span>
            ) : (
              <select
                role="combobox"
                value={modelKey}
                onChange={(e) => setModelKey(e.target.value)}
                className="rounded-[var(--radius-md)] border border-[var(--border-primary)] bg-white px-2 py-1"
              >
                {(models ?? []).map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.key}（{m.modelId}）
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="flex items-center gap-2 text-sm">
            对照文本
            <textarea
              aria-label="对照文本"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              rows={2}
              className="w-80 rounded-[var(--radius-md)] border border-[var(--border-primary)] bg-white px-2 py-1"
              placeholder="先写下你要手写的内容（已知答案）"
            />
          </label>
          <button
            type="button"
            onClick={onRecognize}
            disabled={recognizeDisabled}
            className="rounded-[var(--radius-pill)] bg-[var(--brand-600)] px-6 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {recognizing ? '识别中…' : '识别'}
          </button>
        </div>

        <DemoSketchPad ref={padRef} onStrokesChange={setStrokes} />

        {error && <p className="text-sm text-red-600">识别失败：{error}</p>}

        {/* 最新一轮结果：原图 / 对照 / 识别 三栏 + 错字清单 */}
        {last && (
          <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border-primary)] p-4">
            <h2 className="font-bold">
              本轮字级准确率：{(last.result.accuracy * 100).toFixed(1)}%（{last.result.matched}/{last.result.expected.length}，{last.meta.elapsedMs}ms）
            </h2>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="mb-1 text-xs text-[var(--text-secondary)]">手写原图</p>
                <img src={last.image} alt="手写原图" className="max-w-full rounded border border-[var(--border-secondary)]" />
              </div>
              <div>
                <p className="mb-1 text-xs text-[var(--text-secondary)]">对照（归一化）</p>
                <p className="break-all">{last.result.expected || '（空）'}</p>
              </div>
              <div>
                <p className="mb-1 text-xs text-[var(--text-secondary)]">识别（原始）</p>
                <p className="break-all">{last.meta.text || '（空）'}</p>
              </div>
            </div>
            {last.result.errors.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-[var(--text-secondary)]">错字 / 漏字</p>
                <ul className="flex flex-wrap gap-2">
                  {last.result.errors.map((e, idx) => (
                    <li key={idx} className="rounded bg-[var(--bg-secondary)] px-2 py-0.5 text-sm">
                      {e.expected} → {e.got ?? '（漏）'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {last.result.extra.length > 0 && (
              <p className="text-sm text-[var(--text-secondary)]">多识别：{last.result.extra.join('、')}</p>
            )}
          </section>
        )}

        {/* 累计区（内存，刷新清空） */}
        {total && (
          <section className="rounded-[var(--radius-lg)] border border-[var(--border-primary)] p-4">
            <h2 className="font-bold">
              累计字级准确率：{(total.accuracy * 100).toFixed(1)}%（{rounds.length} 轮，{total.matched}/{total.expected.length} 字）
            </h2>
          </section>
        )}
      </div>
    </div>
  );
}
```

注意实现细节：错误文案用 `text-red-600`（`CourseDetailPage.tsx:841` 等已有先例；本页是 dev-only 页，不属于正式学生/家长页面，可用基础色）。

- [ ] **Step 5: 注册路由**

`apps/web/src/routes/routeTable.tsx`：import 区加

```tsx
import HandwritingDemoPage from '@/pages/dev/HandwritingDemoPage';
```

`routes` 数组中（`/student/locked` 条目之后）加：

```tsx
  // 手写识别率调研 demo（2026-10-08，dev-only：不进导航；后端 JWT 把守，页面本身不做角色闸）
  {
    path: '/dev/handwriting-demo',
    element: <HandwritingDemoPage />,
  },
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/web && npm test -- HandwritingDemoPage`
Expected: PASS（3 个用例）

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/dev apps/web/src/services/api.ts apps/web/src/routes/routeTable.tsx
git commit -m "feat: 手写识别调研页 /dev/handwriting-demo（三栏结果+累计准确率）"
```

---

### Task 5: 全量回归 + 手测清单

**Files:** 无新文件（验证收尾）

- [ ] **Step 1: 全量测试**

```bash
cd apps/web && npm test
cd ../server && npm test
```
Expected: 全 PASS，无新增失败。

- [ ] **Step 2: lint + 类型**

```bash
cd apps/web && npm run lint && npx tsc -b --noEmit
cd ../server && npm run build
```
Expected: 0 error。⚠️ 披露：`apps/server npm run build` 会写 `dist/`——若你本机 `node dist/main.js` 正在跑，重启后端才生效；web 侧 dev server（vite）不受影响。

- [ ] **Step 3: 手测清单（用户在 iPad/浏览器执行）**

1. `cd apps/server && node dist/main.js`；web `npm run dev` 打开 `http://localhost:5173/dev/handwriting-demo`（需先登录任意角色）。
2. 模型下拉应列出 DB 里已启用模型；选多模态的（qwen3.8-max）。
3. 对照文本填一段已知汉字（建议 10–30 字起测），面板手写同样内容 → 识别 → 核对三栏与错字清单。
4. 连续多轮不同内容，观察顶部累计准确率；切换不同模型重复对比。
5. 橡皮/清空行为；无笔画时识别按钮禁用；空对照文本禁用。

- [ ] **Step 4: Commit（如有 lint/类型微调）**

```bash
git add -A && git commit -m "chore: 手写识别 demo 回归收尾"
```

---

## Self-Review 结论

- **Spec 覆盖**：§4.1–4.4 → Task 3/4；§5.1–5.2 → Task 2（校验表逐条、503/400/404/502、apiKey 不泄漏均有测试钉住）；§6 → Task 1；§7 测试 → 各任务内嵌；§2 非目标（不留档、无撤销）未实现即符合。订阅豁免与 DI 坑属仓规衍生，已入 Task 2。
- **占位符扫描**：无 TBD/TODO；两处「以 style.md 实际 token 名为准」是防 token 名漂移的显式指令，非占位。
- **类型一致性**：`DemoSketchPadHandle.exportImage(): string | null`（Task 3 定义 = Task 4 消费）；`compareHandwriting/CompareResult`（Task 1 = Task 4）；`{models:[{key,provider,modelId}]}` 与 `{text,modelKey,elapsedMs}`（Task 2 = Task 4 api.ts）一致。
