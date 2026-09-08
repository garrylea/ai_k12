# 判题解析缓存化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 判题响应只判对错；判错后解析由强模型后台生成、入库复用；末题后批量拉解析（等 in-flight），失败可刷新重试（120s 倒计时）并通知管理员。

**Architecture:** 判题核心 `JudgeCoreService` 判错时 fire-and-forget 调新增 `ExplanationCacheService`（进程内并发 ≤2 队列 + in-flight 去重），解析写回 `questions.explanation`（TEXT 已存在）；新增 `solution` 模式 prompt（qwen3.7-max 强模型）；前端结果页末题后批量拉解析（后端等 in-flight），null 提供刷新端点（失败通知 admin_notifications）。辅线错题本已取消（PRD §7.4 修订），训练错题继续入 `main_error_books`，本计划不含错题本归属变更（见 spec §10 待办）。

**Tech Stack:** NestJS（apps/server）、React 19 + Vite（apps/web）、MySQL、Vitest、ai-core（ExplanationCapability / JudgmentCapability / PromptBuilder / model-routes）。

**Spec:** `docs/superpowers/specs/2026-09-08-question-explanation-cache-design.md`

---

## 文件结构

**Backend (apps/server/src):**
- Create `ai-core/prompts/explanation/solution.md` — 标准题解 prompt
- Modify `ai-core/types.ts` — `ExplanationMode` 加 `'solution'`；`ExplanationRequest` 加 `mode: 'solution'`；`JudgmentResult.analysis` 可空
- Modify `ai-core/infra/prompt-builder.ts` — explanation 模板分支加 solution
- Modify `ai-core/capabilities/judgment.capability.ts` — schema 去 analysis 必填
- Modify `ai-core/capabilities/explanation.capability.ts` — 无需改（mode 透传）
- Modify `ai-core/prompts/judgment/math-calculation.md` + `math-proof.md` — 只输出 isCorrect/errorType
- Modify `ai-core/retry.yaml` — explanation 超时 60s→120s
- Create `modules/practice/explanation-cache.service.ts` — 队列 + 批量/单题等待
- Modify `modules/practice/judge-core.service.ts` — 删 analysis、判错触发 ensureExplanation
- Modify `modules/practice/practice.service.ts` — judge 落库 analysis→null
- Modify `modules/training/training.service.ts` — explanations 批量 + explanation-wait（含通知）
- Modify `modules/training/training.controller.ts` — 两个新端点
- Modify `modules/training/training.module.ts` — 加 ExplanationCacheService 等 providers
- Modify `modules/exams/exams.service.ts` — submitAnswer analysis→null
- Create `database/repositories/admin-notifications.repo.ts`
- Modify `database/repositories/questions.repo.ts` — `updateExplanation`
- Modify `database/repositories/types.ts` — 若需 QuestionRow 调整（不改，用 Pick）
- Modify `modules/admin/admin.module.ts` + `admin.controller.ts` + Create `admin-notifications.service.ts` — 通知三端点
- Modify `tools/db/schema.sql` — admin_notifications 表
- Modify `modules/practice/practice.module.ts` — 提供 ExplanationCacheService + ExplanationCapability

**Frontend (apps/web/src):**
- Modify `services/api.ts` — 类型删 analysis、新端点函数
- Modify `components/business/answer/types.ts` — 删 analysis
- Modify `components/business/AnswerResultList.tsx` — 解析从 props 拉、刷新+倒计时
- Modify `pages/student/training/TargetedRunPage.tsx`、`ErrorPracticeRunPage.tsx`、`ExamResultPage.tsx` — 编排拉解析
- Modify `components/business/CleanupPhase.tsx` — 适配 AnswerResultList 新 props
- Modify `pages/admin/AdminDashboardPage.tsx` — 通知区（未读徽章+列表+已读）
- Modify `pages/student/training/ExamRunPage.tsx` — JudgeResult 类型适配（占位 analysis 删除）

**Docs:**
- Modify `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` — 端点变更
- Modify `docs/ai-core-changelog.md` — 记录

---

## Task 1: solution 模式 prompt + explanation 模板路由 + 超时

**Files:**
- Create: `apps/server/src/ai-core/prompts/explanation/solution.md`
- Modify: `apps/server/src/ai-core/types.ts:53`（ExplanationMode）、`:487-495`（ExplanationRequest）
- Modify: `apps/server/src/ai-core/infra/prompt-builder.ts:77`
- Modify: `apps/server/src/ai-core/retry.yaml:12`

- [ ] **Step 1: 写 solution.md**

```markdown
---
version: "1.0"
description: "标准题解生成 - 与具体学生作答无关，可入库复用的纯题解"
---

## System Prompt

你是一位严谨的中学数学老师。请为这道题生成一份**标准题解**，供学生自学参考。

### 输出要求
1. 分步讲解完整解题过程，从审题到最终答案逐步展开。
2. 数学公式用 `$...$` 包裹的 LaTeX（行内），如 `$\frac{2}{3}$`、`$\sqrt{2}$`、`$x^2-4=0$`；不要写裸 LaTeX。
3. 若参考答案已给出过程，以其为准组织讲解（参考答案可能比重新推导更规范）；无参考答案时给出你的完整解法。
4. 几何题可输出内嵌 `<svg>` 线性示意图（viewBox 0 0 400 300，stroke 用 #333，标注字母用 SVG `<text>`）。
5. 面向初中生，语言清晰、分点编号。
6. 只输出题解正文（Markdown），不要 JSON，不要代码块标记。

---

## User Message

**题目**：
{{#question}}
{{question.content}}
{{/question}}

**参考答案**：
{{#question}}
{{question.answer}}
{{/question}}

请生成标准题解。
```

- [ ] **Step 2: 扩展 ExplanationMode 与 ExplanationRequest**

`apps/server/src/ai-core/types.ts:53`：

```typescript
export type ExplanationMode = 'error_analysis' | 'knowledge_retry' | 'solution';
```

`apps/server/src/ai-core/types.ts:487-495`（`ExplanationRequest` 加 `'solution'`；`wrongAnswer`/`knowledgePoint` 对 solution 模式传空串/空对象即可，生成器不依赖）：

```typescript
export interface ExplanationRequest {
  mode: 'error_analysis' | 'knowledge_retry' | 'solution';
  studentId: string;
  subject: Subject;
  question: { content: string; answer?: string };
  wrongAnswer: string;
  errorHistory?: { question: string; wrongAnswer: string; attempts: number }[];
  knowledgePoint: { id: string; name: string };
}
```

- [ ] **Step 3: prompt-builder 加 solution 分支**

`apps/server/src/ai-core/infra/prompt-builder.ts:77`：

```typescript
    if (capability === 'explanation') {
      if (mode === 'knowledge_retry') return `explanation/knowledge-retry.md`;
      if (mode === 'solution') return `explanation/solution.md`;
      return `explanation/error-analysis.md`;
    }
```

- [ ] **Step 4: explanation 超时 60s→120s**

`apps/server/src/ai-core/retry.yaml:12`：

```yaml
  explanation: 120000
```

- [ ] **Step 5: 验证 tsc + 现有测试**

Run: `cd apps/server && npm run build`
Expected: 编译通过。

Run: `npm test`
Expected: 全绿（现有 72 测试，本任务只加模式分支，无行为变化）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ai-core
git commit -m "feat(ai-core): 新增 explanation solution 模式 prompt（标准题解）+ 模板路由 + 超时 120s"
```

---

## Task 2: 判题 prompt 与解析器去 analysis（只判对错）

**Files:**
- Modify: `apps/server/src/ai-core/prompts/judgment/math-calculation.md`
- Modify: `apps/server/src/ai-core/prompts/judgment/math-proof.md`
- Modify: `apps/server/src/ai-core/capabilities/judgment.capability.ts:14-18,64-74`
- Modify: `apps/server/src/ai-core/types.ts`（JudgmentResult）

- [ ] **Step 1: 简化 judgment/math-calculation.md**

读文件后用增量 Edit 修改：删除「并在 analysis 中说明错因与正确解法」、删除「输出格式」里 `"analysis": "..."` 字段与描述。最终 System Prompt 的「判断规则」第 3 条改为：

```markdown
3. 任何一步错误（逻辑错、计算错、格式导致歧义、漏步关键步骤）-> isCorrect=false，并在 errorType 中标注错误类型。
```

输出格式改为：

```markdown
### 输出格式
严格输出 JSON，不加额外文字：
{
  "isCorrect": false,
  "errorType": "calculation"
}

errorType 枚举：logic（逻辑错）/ calculation（计算错）/ format（格式歧义）/ missing（漏步）。答对时 errorType 为 null。
```

- [ ] **Step 2: 简化 judgment/math-proof.md**

同样修改：第 3 条改为标注 errorType；输出格式只保留 `{ "isCorrect": false, "errorType": "logic" }`；删除 analysis 相关说明与字段。

- [ ] **Step 3: judgment.capability schema 去 analysis 必填**

`apps/server/src/ai-core/capabilities/judgment.capability.ts:14-18`：

```typescript
const JudgmentResultSchema = z.object({
  isCorrect: z.boolean(),
  analysis: z.string().nullable().optional(),
  errorType: z.enum(['logic', 'calculation', 'format', 'missing']).nullable().optional(),
});
```

- [ ] **Step 4: types.ts JudgmentResult 可空**

`apps/server/src/ai-core/types.ts` 中 `JudgmentResult`（约 :16）analysis 改为可空：

```typescript
export interface JudgmentResult {
  isCorrect: boolean;
  analysis?: string | null;
  errorType?: 'logic' | 'calculation' | 'format' | 'missing' | null;
}
```

- [ ] **Step 5: 验证测试绿**

Run: `cd apps/server && npm test`
Expected: 全绿。若 `__tests__/safety-classification.ts` 或 judgment 相关测试断言 analysis 非空，更新断言为允许 null（测试错则改测试——CLAUDE.md 铁律）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ai-core
git commit -m "feat(ai-core): 判题 prompt 只输出 isCorrect/errorType，去 analysis 生成（省输出 token）"
```

---

## Task 3: QuestionsRepository.updateExplanation

**Files:**
- Modify: `apps/server/src/database/repositories/questions.repo.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/src/database/repositories/questions.repo.test.ts` 追加：

```typescript
describe('updateExplanation', () => {
  it('写入解析后可读回', async () => {
    const repo = new QuestionsRepository(mockPool);
    // mockPool.execute 按 SQL 区分：UPDATE 返回 ok，SELECT 返回含 explanation 的行
    await repo.updateExplanation(1, '标准题解');
    const [rows] = await mockPool.execute('SELECT explanation FROM questions WHERE id = 1');
    expect(rows[0].explanation).toBe('标准题解');
  });
});
```

（mockPool 沿用文件顶部既有 mock 模式；若现有测试无 mockPool 导出，按该文件既有的 mock 方式构造。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/database/repositories/questions.repo.test.ts -t updateExplanation`
Expected: FAIL —— `updateExplanation is not a function`。

- [ ] **Step 3: 实现**

`apps/server/src/database/repositories/questions.repo.ts` 加方法：

```typescript
  /** 判错解析缓存：LLM 生成/长答案直写后回写 questions.explanation。 */
  async updateExplanation(id: number, explanation: string): Promise<void> {
    await this.pool.execute(
      'UPDATE questions SET explanation = ? WHERE id = ?',
      [explanation, id],
    );
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/database/repositories/questions.repo.test.ts -t updateExplanation`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/questions.repo.ts
git commit -m "feat(server): QuestionsRepository.updateExplanation（解析缓存回写）"
```

---

## Task 4: ExplanationCacheService（队列 + in-flight 去重 + 等待）

**Files:**
- Create: `apps/server/src/modules/practice/explanation-cache.service.ts`
- Test: `apps/server/src/modules/practice/explanation-cache.service.test.ts`

- [ ] **Step 1: 写失败测试（覆盖全部行为）**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExplanationCacheService } from './explanation-cache.service.js';

function makeQuestion(over = {} as Partial<{ id: number; answer: string; explanation: string }>) {
  return { id: 1, answer: 'B', explanation: '', ...over } as any;
}

function makeDeps() {
  const questionsRepo = {
    findById: vi.fn(),
    updateExplanation: vi.fn().mockResolvedValue(undefined),
  };
  const explanation = { explain: vi.fn() };
  return { questionsRepo, explanation };
}

describe('ExplanationCacheService', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('已有解析 -> 什么都不做', async () => {
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ explanation: '已有' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.explanation.explain).not.toHaveBeenCalled();
    expect(deps.questionsRepo.updateExplanation).not.toHaveBeenCalled();
  });

  it('长答案（≥100 字符）直接直写，不调 LLM', async () => {
    const longAnswer = 'x'.repeat(100);
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ answer: longAnswer }));
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.explanation.explain).not.toHaveBeenCalled();
    expect(deps.questionsRepo.updateExplanation).toHaveBeenCalledWith(1, longAnswer);
  });

  it('短答案 -> 调 LLM 生成并入库', async () => {
    deps.explanation.explain.mockResolvedValue({ content: '标准题解', mode: 'solution' });
    deps.questionsRepo.findById.mockResolvedValue(makeQuestion());
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ answer: 'B' }));
    const result = await svc.waitExplanation(1, 5000);
    expect(result).toBe('标准题解');
    expect(deps.explanation.explain).toHaveBeenCalledTimes(1);
    expect(deps.questionsRepo.updateExplanation).toHaveBeenCalledWith(1, '标准题解');
  });

  it('生成失败 -> 不入库，返回 null', async () => {
    deps.explanation.explain.mockRejectedValue(new Error('LLM 挂了'));
    deps.questionsRepo.findById.mockResolvedValue(makeQuestion());
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ answer: 'B' }));
    const result = await svc.waitExplanation(1, 5000);
    expect(result).toBeNull();
    expect(deps.questionsRepo.updateExplanation).not.toHaveBeenCalled();
  });

  it('同题并发去重：两次 ensure 只生成一次', async () => {
    let resolve!: (v: any) => void;
    deps.explanation.explain.mockImplementation(() => new Promise((r) => { resolve = r; }));
    deps.questionsRepo.findById.mockResolvedValue(makeQuestion());
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ answer: 'B' }));
    svc.ensureExplanation(makeQuestion({ answer: 'B' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.explanation.explain).toHaveBeenCalledTimes(1);
    resolve({ content: '题解', mode: 'solution' });
    await svc.waitExplanation(1, 5000);
  });

  it('waitForExplanations：DB 已有直返，in-flight 等待，无在途且无解析返回 null', async () => {
    deps.questionsRepo.findById
      .mockResolvedValueOnce(makeQuestion({ explanation: '已有' }))
      .mockResolvedValueOnce(makeQuestion());
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    const out = await svc.waitForExplanations([1, 2], 100);
    expect(out[1]).toBe('已有');
    expect(out[2]).toBeNull();
    expect(deps.explanation.explain).not.toHaveBeenCalled(); // 批量不触发新生成
  });

  it('waitExplanation：无在途且无解析 -> 重新触发生成', async () => {
    deps.explanation.explain.mockResolvedValue({ content: '补的题解', mode: 'solution' });
    deps.questionsRepo.findById
      .mockResolvedValueOnce(makeQuestion()) // waitExplanation 首查
      .mockResolvedValueOnce(makeQuestion()) // generate 内查
      .mockResolvedValueOnce(makeQuestion({ explanation: '补的题解' })); // generate 成功后再查? 见实现——实际 generate 返回即写库
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    const result = await svc.waitExplanation(1, 5000);
    expect(result).toBe('补的题解');
    expect(deps.explanation.explain).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/modules/practice/explanation-cache.service.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

```typescript
// apps/server/src/modules/practice/explanation-cache.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { ExplanationCapability } from '../../ai-core/capabilities/explanation.capability.js';
import type { QuestionRow } from '../../database/repositories/types.js';

/** 解析缓存生成并发上限：防判错风暴打爆强模型。 */
const QUEUE_CONCURRENCY = 2;
/** answer 达到该长度视为「过程性题解」，直接直写不入库 LLM（PRD/试卷参考答案常为完整过程）。 */
const ANSWER_AS_SOLUTION_MIN_LEN = 100;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
      .catch(() => { clearTimeout(t); resolve(fallback); });
  });
}

/**
 * 判题解析缓存：判错后后台生成解析入库（一次性生成、全生命周期复用）。
 * 进程内队列（并发 ≤2）+ in-flight 去重；explanation 空才生成 -> 失败自然下次重试。
 * 局限：进程内，重启丢在途；多实例会重复生成（当前单实例，见 spec §4.1）。
 */
@Injectable()
export class ExplanationCacheService {
  private readonly logger = new Logger(ExplanationCacheService.name);
  private readonly queue: number[] = [];
  private running = 0;
  /** questionId -> 在途生成 promise（waitForExplanations/waitExplanation 等的就是它） */
  private readonly inFlight = new Map<number, Promise<string | null>>();

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly explanation: ExplanationCapability,
  ) {}

  /** 判错分支调用：fire-and-forget。q 只用 id/answer/explanation 三个字段。 */
  ensureExplanation(q: Pick<QuestionRow, 'id' | 'answer' | 'explanation'>): void {
    if (q.explanation?.trim()) return;
    if (q.answer && q.answer.length >= ANSWER_AS_SOLUTION_MIN_LEN) {
      void this.questionsRepo.updateExplanation(q.id, q.answer).catch((err) => {
        this.logger.error(`explanation persist failed (questionId=${q.id}): ${err}`);
      });
      return;
    }
    this.enqueue(q.id);
  }

  /** 批量等待（结果页首次拉取）：DB 有直返；in-flight 等（总超时 60s）；无在途且无解析 -> null（不触发新生成）。 */
  async waitForExplanations(ids: number[], timeoutMs = 60_000): Promise<Record<number, string | null>> {
    const out: Record<number, string | null> = {};
    const pending: number[] = [];
    for (const id of ids) {
      const q = await this.questionsRepo.findById(id);
      const text = q?.explanation?.trim();
      if (text) out[id] = text;
      else if (this.inFlight.has(id)) pending.push(id);
      else out[id] = null;
    }
    if (pending.length > 0) {
      const deadline = Date.now() + timeoutMs;
      const settled = await Promise.all(pending.map(async (id) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        return withTimeout(this.inFlight.get(id)!, remaining, null);
      }));
      pending.forEach((id, i) => { if (settled[i]) out[id] = settled[i]; });
    }
    return out;
  }

  /** 单题刷新等待（explanation-wait）：DB 有直返；in-flight 等；无在途且无解析 -> 重新触发生成再等（120s）。 */
  async waitExplanation(id: number, timeoutMs = 120_000): Promise<string | null> {
    const q = await this.questionsRepo.findById(id);
    if (q?.explanation?.trim()) return q.explanation;
    if (!this.inFlight.has(id)) this.enqueue(id);
    const p = this.inFlight.get(id);
    if (!p) return null;
    return withTimeout(p, timeoutMs, null);
  }

  private enqueue(id: number): void {
    if (this.inFlight.has(id)) return;
    this.queue.push(id);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.running < QUEUE_CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift()!;
      if (this.inFlight.has(id)) continue;
      this.running++;
      const p = this.generate(id);
      this.inFlight.set(id, p);
      void p.finally(() => {
        this.inFlight.delete(id);
        this.running--;
        void this.drain();
      });
    }
  }

  private async generate(id: number): Promise<string | null> {
    try {
      const q = await this.questionsRepo.findById(id);
      if (!q) return null;
      if (q.explanation?.trim()) return q.explanation;
      if (q.answer && q.answer.length >= ANSWER_AS_SOLUTION_MIN_LEN) {
        await this.questionsRepo.updateExplanation(id, q.answer);
        return q.answer;
      }
      const result = await this.explanation.explain({
        mode: 'solution',
        studentId: '',
        subject: 'math',
        question: { content: q.content, answer: q.answer ?? undefined },
        wrongAnswer: '',
        knowledgePoint: { id: '', name: '' },
      });
      const text = result.content?.trim();
      if (!text) return null;
      await this.questionsRepo.updateExplanation(id, text);
      return text;
    } catch (err) {
      this.logger.error(`explanation generate failed (questionId=${id}): ${err}`);
      return null;
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/modules/practice/explanation-cache.service.test.ts`
Expected: PASS（6 例）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/practice/explanation-cache.service.ts apps/server/src/modules/practice/explanation-cache.service.test.ts
git commit -m "feat(server): ExplanationCacheService——判错后台异步生成解析入库复用（队列+去重+等待）"
```

---

## Task 5: judge-core 删 analysis + 判错触发 ensureExplanation

**Files:**
- Modify: `apps/server/src/modules/practice/judge-core.service.ts`
- Modify: `apps/server/src/modules/practice/practice.module.ts`
- Test: `apps/server/src/modules/practice/practice.service.test.ts`（现有 judge 测试）

- [ ] **Step 1: 更新 practice.module 提供新依赖**

`apps/server/src/modules/practice/practice.module.ts`：imports 加 `ExplanationCapability`（`../../ai-core/capabilities/explanation.capability.js`），providers 加 `ExplanationCacheService`、`ExplanationCapability`。

- [ ] **Step 2: 更新现有测试（practice.service.test.ts）**

现有 judge 测试构造 mock 依赖数组（约 :14 附近），加第 12 参 `explanationCache` mock：`{ ensureExplanation: vi.fn() }`。并在断言处把 `analysis` 相关断言删除或改为 `undefined`。

- [ ] **Step 3: 实现 judge-core 变更**

`apps/server/src/modules/practice/judge-core.service.ts`：

1. 构造函数注入 `private readonly explanationCache: ExplanationCacheService`。
2. `JudgeOutput` 接口删 `analysis` 字段（:61）。
3. `judgeQuestion`：
   - exact 路由删 `analysis = isCorrect ? null : \`正确答案：${q.answer}\`;`（:106）
   - fill_blank 相等删 `analysis = null;`（:111）
   - AI 路由删 `analysis = result.analysis;`（:126）
   - 判错分支（入错题本处）追加 `this.explanationCache.ensureExplanation(q);`（q 必非空）
4. `judgeForPractice`：
   - 三路由删 analysis 赋值（:183、:187、:205）
   - 判错分支：q 非空 → `ensureExplanation(q)`；q 为 null 且结构化 `findOrCreate` 成功（questionId 非空）→ `ensureExplanation({ id: created.id, answer: structured.answer, explanation: structured.explanation })`；questionId 为 null → 不触发
   - 返回对象删 `analysis` 字段（:169、:300）

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && npx vitest run src/modules/practice/practice.service.test.ts`
Expected: PASS。若仍断言 analysis，按 CLAUDE.md 铁律改测试断言。

- [ ] **Step 5: 全量测试 + build**

Run: `npm test && npm run build`
Expected: 全绿、tsc 通过。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/practice
git commit -m "feat(server): judge-core 判题响应去 analysis、判错触发解析缓存生成"
```

---

## Task 6: practice/training/exams 响应层同步删 analysis

**Files:**
- Modify: `apps/server/src/modules/practice/practice.service.ts`（judge upsert analysis→null）
- Modify: `apps/server/src/modules/exams/exams.service.ts:195-205`（submitAnswer upsert analysis→null）
- Modify: `apps/server/src/modules/training/training.service.ts`（judgeTraining 透传不变，无需改；确认返回类型）

- [ ] **Step 1: practice.service.ts judge 落库**

`apps/server/src/modules/practice/practice.service.ts` 约 :108：`analysis: result.analysis,` → `analysis: null,`（判题响应已无 analysis；列保留存历史）。

- [ ] **Step 2: exams.service.ts submitAnswer 落库**

`apps/server/src/modules/exams/exams.service.ts` 约 :202：`analysis: out.analysis,` → `analysis: null,`。`getResults` 的 `analysis: row.analysis` 保留（历史数据兜底展示）。

- [ ] **Step 3: 验证**

Run: `cd apps/server && npm test && npm run build`
Expected: 全绿、tsc 通过。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/modules/practice/practice.service.ts apps/server/src/modules/exams/exams.service.ts
git commit -m "feat(server): 判题响应去 analysis 后落库侧同步（practice_results/exam_answers analysis 写 null）"
```

---

## Task 7: training 批量解析 + explanation-wait 端点（含管理员通知）

**Files:**
- Create: `apps/server/src/database/repositories/admin-notifications.repo.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（导出）
- Modify: `apps/server/src/modules/training/training.service.ts`
- Modify: `apps/server/src/modules/training/training.controller.ts`
- Modify: `apps/server/src/modules/training/training.module.ts`

- [ ] **Step 1: 建 admin_notifications 表**

`tools/db/schema.sql` 在 `admin_messages` 表之后追加：

```sql
-- 系统 -> 管理员通知（判题解析生成失败等；复刻 parent_messages 模式，question_id 定位题目）
CREATE TABLE IF NOT EXISTS admin_notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(20) NOT NULL,
  question_id BIGINT DEFAULT NULL,
  title VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_an_question_read (question_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

若本机已装库，手动执行一次 `mysql -uai_k12 -pai_k12 ai_k12 < <(sed -n '/admin_notifications/,/ENGINE/p' tools/db/schema.sql)`。

- [ ] **Step 2: 写 repo 失败测试**

`apps/server/src/database/repositories/admin-notifications.repo.test.ts`（mock pool 沿用项目惯例）：

```typescript
import { describe, it, expect, vi } from 'vitest';
import { AdminNotificationsRepository } from './admin-notifications.repo.js';

describe('AdminNotificationsRepository', () => {
  it('hasUnreadByQuestion：无未读时 false', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ c: 0 }]]) };
    const repo = new AdminNotificationsRepository(pool as any);
    expect(await repo.hasUnreadByQuestion(5)).toBe(false);
    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('is_read = 0'), [5]);
  });
});
```

- [ ] **Step 3: 实现 repo**

```typescript
// apps/server/src/database/repositories/admin-notifications.repo.ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface AdminNotificationRow {
  id: number;
  type: string;
  questionId: number | null;
  title: string;
  content: string;
  isRead: boolean;
  createdAt: Date;
}

@Injectable()
export class AdminNotificationsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async create(data: { type: string; questionId: number | null; title: string; content: string }): Promise<number> {
    const [r] = await this.pool.execute<ResultSetHeader>(
      'INSERT INTO admin_notifications (type, question_id, title, content) VALUES (?, ?, ?, ?)',
      [data.type, data.questionId, data.title, data.content]);
    return r.insertId;
  }

  /** 同题未读失败通知去重（防刷屏）：explanation-wait 超时前先查。 */
  async hasUnreadByQuestion(questionId: number): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM admin_notifications WHERE question_id = ? AND is_read = 0',
      [questionId]);
    return Number(rows[0].c) > 0;
  }

  async list(): Promise<AdminNotificationRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, type, question_id AS questionId, title, content, is_read AS isRead, created_at AS createdAt
       FROM admin_notifications ORDER BY created_at DESC LIMIT 200`);
    return rows.map((r: any) => ({ ...r, isRead: r.isRead === 1 }));
  }

  async unreadCount(): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM admin_notifications WHERE is_read = 0');
    return Number(rows[0].c);
  }

  async markRead(id: number): Promise<boolean> {
    const [r] = await this.pool.execute<ResultSetHeader>(
      'UPDATE admin_notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [id]);
    return r.affectedRows > 0;
  }
}
```

- [ ] **Step 4: repositories/index.ts 导出**

追加 `export { AdminNotificationsRepository } from './admin-notifications.repo.js';` 及类型。

- [ ] **Step 5: training.service 加两个方法与通知写入**

`apps/server/src/modules/training/training.service.ts`：

1. import `AdminNotificationsRepository`；构造函数注入。
2. 加方法：

```typescript
  /** 批量拉解析：等 in-flight 生成完成（60s），不触发新生成。 */
  async getExplanations(studentId: number, ids: number[]): Promise<{ explanations: Record<number, string | null> }> {
    // 校验归属：仅返回该生错题/训练题涉及的有效 id 的解析，防 IDOR 无意义（解析是题库公开资源），仍按 id 过滤非正整数
    const clean = ids.filter((x) => Number.isInteger(x) && x > 0);
    const explanations = await this.explanationCache.waitForExplanations(clean);
    return { explanations };
  }

  /** 单题刷新等待：DB 无解析且无在途 -> 重新触发生成；120s 超时；失败写管理员通知（同题未读去重）。 */
  async waitForExplanation(studentId: number, questionId: number): Promise<{ explanation: string | null }> {
    const explanation = await this.explanationCache.waitExplanation(questionId, 120_000);
    if (explanation == null) {
      try {
        const hasUnread = await this.notificationsRepo.hasUnreadByQuestion(questionId);
        if (!hasUnread) {
          await this.notificationsRepo.create({
            type: 'explanation_failed',
            questionId,
            title: '题解生成失败',
            content: `题目 #${questionId} 判错后解析生成持续失败（LLM 超时/不可用），请人工补题解。`,
          });
        }
      } catch (err) {
        this.logger.error(`admin notification write failed (questionId=${questionId}): ${err}`);
      }
    }
    return { explanation };
  }
```

3. 构造函数注入 `private readonly explanationCache: ExplanationCacheService`（import 自 `../practice/explanation-cache.service.js`）。

- [ ] **Step 6: training.controller 加两端点**

```typescript
  /** 批量拉解析（末题后结果页）：ids 逗号分隔；后端等 in-flight（60s 兜底）。 */
  @Get('questions/explanations')
  async getExplanations(@Query('ids') idsStr: string, @CurrentUser() user: JwtUser) {
    const ids = (idsStr ?? '').split(',').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
    return this.trainingService.getExplanations(user.sub, ids);
  }

  /** 单题刷新等待（120s 倒计时）：超时返回 null + 写管理员通知。 */
  @Get('questions/:questionId/explanation-wait')
  async waitForExplanation(@Param('questionId', ParseIntPipe) questionId: number, @CurrentUser() user: JwtUser) {
    return this.trainingService.waitForExplanation(user.sub, questionId);
  }
```

- [ ] **Step 7: training.module 提供新依赖**

**重要**（T5 代码审查修正）：`ExplanationCacheService` 是有状态单例（in-flight 队列），必须由 `PracticeModule` **导出**、TrainingModule 经已 import 的 `PracticeModule` 注入同一实例——**不能**在 training.module 重复 provide（会产生第二个空队列实例，看不到判题侧 in-flight 生成）。故：
- `PracticeModule` 在 T5 已 `exports` 加 `ExplanationCacheService`
- training.module providers 只加 `AdminNotificationsRepository`（`../../database/repositories/admin-notifications.repo.js`），不再加 ExplanationCacheService/ExplanationCapability（随 PracticeModule 注入）

- [ ] **Step 8: 验证**

Run: `cd apps/server && npm test && npm run build`
Expected: 全绿、tsc 通过。

- [ ] **Step 9: Commit**

```bash
git add apps/server tools/db/schema.sql
git commit -m "feat(server): training explanations 批量端点 + explanation-wait 刷新端点（超时写 admin_notifications）"
```

---

## Task 8: admin 通知三端点（admin 模块）

**Files:**
- Create: `apps/server/src/modules/admin/admin-notifications.service.ts`
- Modify: `apps/server/src/modules/admin/admin.module.ts`
- Modify: `apps/server/src/modules/admin/admin.controller.ts`

- [ ] **Step 1: service（复刻 AdminMessagesService 形态）**

```typescript
// apps/server/src/modules/admin/admin-notifications.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminNotificationsRepository } from '../../database/repositories/admin-notifications.repo.js';

@Injectable()
export class AdminNotificationsService {
  constructor(private readonly notificationsRepo: AdminNotificationsRepository) {}

  async list() { return this.notificationsRepo.list(); }
  async unreadCount() { return this.notificationsRepo.unreadCount(); }
  async markRead(id: number) {
    const ok = await this.notificationsRepo.markRead(id);
    if (!ok) throw new NotFoundException({ code: 1002, message: '通知不存在' });
  }
}
```

- [ ] **Step 2: admin.module providers + exports**

providers 加 `AdminNotificationsRepository`、`AdminNotificationsService`；exports 加 `AdminNotificationsService`。

- [ ] **Step 3: admin.controller 三端点**

```typescript
  @Get('notifications') notifications() { return this.notificationsService.list(); }

  @Get('notifications/unread-count') unreadNotifications() { return this.notificationsService.unreadCount(); }

  @Post('notifications/:id/read') async markNotificationRead(@Param('id', ParseIntPipe) id: number) {
    await this.notificationsService.markRead(id);
    return null;
  }
```

构造函数注入 `AdminNotificationsService`。

- [ ] **Step 4: 验证**

Run: `cd apps/server && npm test && npm run build`
Expected: 全绿、tsc 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/admin
git commit -m "feat(server): admin 通知三端点（列表/未读数/已读）"
```

---

## Task 9: 前端 api.ts 类型与新端点函数

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Modify: `apps/web/src/components/business/answer/types.ts`

- [ ] **Step 1: JudgeResult 删 analysis**

`apps/web/src/services/api.ts:588-595` 的 `JudgeResult` 删 `analysis: string | null;`。

- [ ] **Step 2: answer/types.ts 删 analysis**

`apps/web/src/components/business/answer/types.ts`：`RunnerAnswerRecord.analysis` 与 `RunnerJudgeOutcome.analysis` 删除。

- [ ] **Step 3: 加批量/单题拉解析函数**

`apps/web/src/services/api.ts`（training 相关区域）：

```typescript
/** 批量拉解析（结果页末题后）：后端等 in-flight 生成（60s 兜底），未生成完为 null。 */
export function getTrainingExplanations(ids: number[]): Promise<{ explanations: Record<number, string | null> }> {
  return fetchApi(`/training/questions/explanations?ids=${ids.join(',')}`);
}

/** 单题刷新等待（120s 倒计时）：超时返回 null 并触发管理员通知。 */
export function waitTrainingExplanation(questionId: number): Promise<{ explanation: string | null }> {
  return fetchApi(`/training/questions/${questionId}/explanation-wait`);
}
```

- [ ] **Step 4: 加 admin 通知 API**

```typescript
export interface AdminNotificationItem {
  id: number; type: string; questionId: number | null; title: string; content: string; isRead: boolean; createdAt: string;
}
export function listAdminNotifications(): Promise<AdminNotificationItem[]> { return fetchApi('/admin/notifications'); }
export function adminNotificationsUnreadCount(): Promise<number> { return fetchApi('/admin/notifications/unread-count'); }
export function markAdminNotificationRead(id: number): Promise<null> { return fetchApi(`/admin/notifications/${id}/read`, { method: 'POST' }); }
```

- [ ] **Step 5: 修 ExamRunPage 占位 JudgeResult**

`apps/web/src/pages/student/training/ExamRunPage.tsx:187` 的占位对象删 `analysis: null`。

- [ ] **Step 6: 验证**

Run: `cd apps/web && npm run lint && npx tsc -b`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/components/business/answer/types.ts apps/web/src/pages/student/training/ExamRunPage.tsx
git commit -m "feat(web): api 类型去 analysis、新增批量/单题拉解析与 admin 通知 API"
```

---

## Task 10: AnswerResultList 改造（解析从 props 拉 + 刷新倒计时）

**Files:**
- Modify: `apps/web/src/components/business/AnswerResultList.tsx`

- [ ] **Step 1: 新 Props 设计**

`AnswerResultList` 增加（父层负责末题后批量拉解析，结果经 prop 传入；组件只负责展示 + 单题刷新）：

```tsx
interface Props {
  questions: PracticeQuestion[];
  answers: Record<string, AnswerRecord>;   // analysis 字段删除
  onClose: () => void;
  headerExtra?: ReactNode;
  /** 批量拉取的解析结果（父层在末题后调 getTrainingExplanations 获得），key = q.n；缺省 {} */
  initialExplanations?: Record<string, string | null>;
  /** q.n -> 题库 questionId（孤儿题返回 null） */
  questionIdOf: (n: string) => number | null;
  /** 单题刷新等待（父层注入 waitTrainingExplanation），返回解析或 null */
  onWaitExplanation: (questionId: number) => Promise<string | null>;
}
```

组件内部状态：
- `explanations: Record<string, string | null>`（key = q.n，初值 initialExplanations）
- `refreshingN: string | null` + `countdown: number | null`（120s 倒计时）

- [ ] **Step 2: 实现**

核心逻辑（展开解析时首次触发的批量拉在父层做、把结果经 `initialExplanations` prop 传入；组件内只处理「解析为 null 的题显示正在生成中+刷新」）：

```tsx
const [expandedN, setExpandedN] = useState<string | null>(null);
const [explanations, setExplanations] = useState<Record<string, string | null>>(initialExplanations ?? {});
const [refreshingN, setRefreshingN] = useState<string | null>(null);
const [countdown, setCountdown] = useState<number | null>(null);

const handleRefresh = async (q: PracticeQuestion) => {
  const qid = questionIdOf(q.n);
  if (qid == null || refreshingN) return;
  setRefreshingN(q.n);
  setCountdown(120);
  try {
    const text = await onWaitExplanation(qid);
    setExplanations((prev) => ({ ...prev, [q.n]: text }));
  } finally {
    setRefreshingN(null);
    setCountdown(null);
  }
};

useEffect(() => {
  if (countdown == null) return;
  const t = setInterval(() => setCountdown((c) => (c == null || c <= 1 ? null : c - 1)), 1000);
  return () => clearInterval(t);
}, [countdown]);
```

渲染（错题且非 failed）：
- `explanations[q.n]` 有值 → 「查看解析」按钮（展开显示题解，errorType 标签保留）
- `explanations[q.n] == null` → 显示「正在生成中…」+ 刷新按钮（refreshingN 时显示 `mm:ss` 倒计时 + disabled）

删除原 `a.analysis` 的所有引用。

- [ ] **Step 3: 验证**

Run: `cd apps/web && npm run lint && npx tsc -b`
Expected: 通过（此时父层尚未传新 props，会报 TS 错误——先让父层 Task 11 一起完成再 build）。

- [ ] **Step 4: Commit（与 Task 11 一起，见 Task 11 Step 6）**

---

## Task 11: 三个结果页编排 + CleanupPhase 适配

**Files:**
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ExamResultPage.tsx`
- Modify: `apps/web/src/components/business/CleanupPhase.tsx`

- [ ] **Step 1: TargetedRunPage**

`handleFinish` 中：`Promise.allSettled` 已由 QuestionRunner 完成 → 收集错题 questionId（`results` 中 `isCorrect=false` 且非 failed 的条目，经 `entryByN` 取 questionId）→ 批量拉解析后进入结果页：

```tsx
const handleFinish = useCallback(async (results: Record<string, RunnerAnswerRecord>) => {
  setFinalResults(results);
  const wrongIds = (questions ?? [])
    .map((q) => ({ n: q.n, qid: entryByN.get(q.n)?.questionId }))
    .filter((x) => {
      const r = results[x.n];
      return x.qid != null && r && !r.isCorrect && !r.failed;
    })
    .map((x) => x.qid as number);
  let expls: Record<number, string | null> = {};
  if (wrongIds.length > 0) {
    try { expls = (await getTrainingExplanations(wrongIds)).explanations; } catch { /* 失败则全为 null */ }
  }
  // 转成 AnswerResultList 的 key（q.n）
  const byN: Record<string, string | null> = {};
  for (const q of questions ?? []) {
    const qid = entryByN.get(q.n)?.questionId;
    if (qid != null && expls[qid] != null) byN[q.n] = expls[qid] as string;
  }
  setExplanations(byN);
  setPhase('result');
}, [entryByN, questions]);
```

AnswerResultList 传 `initialExplanations={explanations}`、`questionIdOf={(n) => entryByN.get(n)?.questionId ?? null}`、`onWaitExplanation={waitTrainingExplanation}`。保留现有「不再展示」/草稿等逻辑不变。

- [ ] **Step 2: ErrorPracticeRunPage**

同样在 `handleFinish` 收集错题（`entries` 的 errorBookId→questionId），拉批量解析，传 `initialExplanations`。注意 `bumpErrorLevels` 逻辑保留。

- [ ] **Step 3: ExamResultPage**

mount 后（`getExamResults` 返回）对「isCorrect=0 且 analysis/explanation 皆空」的条目收集 questionId → `getTrainingExplanations` 补齐；AnswerResultList 的 `initialExplanations` key = String(questionNo)。answers 映射中 `analysis: it.analysis ?? it.explanation` 改为 `analysis: null`（解析统一走 explanations prop；历史 analysis 可经 initialExplanations 合成：对 explanation 为空的项，把 it.analysis 作为初始值）。

- [ ] **Step 4: CleanupPhase 适配**

CleanupPhase（错题巩固）的错题有 question_id（或孤儿 null）：`questionIdOf` 返回该题 question_id（`finalResults` 键为 questionN，用 phase 父层传入的 entries 映射）；`initialExplanations` 由父层在进入结果页前对非空 question_id 批量拉取；`onWaitExplanation={waitTrainingExplanation}`。questionId 为 null 的孤儿题 → 显示「暂无解析，试试让 AI 讲一讲」（`questionIdOf` 返回 null 时组件不渲染刷新按钮）。

- [ ] **Step 5: 全量验证**

Run: `cd apps/web && npm run lint && npm run build`
Expected: tsc + vite 构建通过。

- [ ] **Step 6: Commit（含 Task 10）**

```bash
git add apps/web/src/components/business/AnswerResultList.tsx apps/web/src/components/business/CleanupPhase.tsx apps/web/src/pages/student/training
git commit -m "feat(web): 结果页末题后批量拉解析 + 生成中刷新倒计时（120s）"
```

---

## Task 12: Admin Dashboard 通知区

**Files:**
- Modify: `apps/web/src/pages/admin/AdminDashboardPage.tsx`

- [ ] **Step 1: 实现通知区**

在 Dashboard 现有内容下方（或右侧）加「解析失败通知」区块：
- mount 拉 `adminNotificationsUnreadCount()` + `listAdminNotifications()`
- 未读数 > 0 显示徽章
- 列表项：标题 + content（含题目 id）+ 未读高亮 + 「标为已读」按钮（调 `markAdminNotificationRead`，成功后本地置 isRead 并刷新未读数）

遵循 admin 端样式惯例（现有 Dashboard 的白卡片 + border-gray-200）。

- [ ] **Step 2: 验证**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/admin/AdminDashboardPage.tsx
git commit -m "feat(web): Admin Dashboard 解析失败通知区（未读徽章+列表+标已读）"
```

---

## Task 13: 文档同步（API/openapi/changelog）

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/ai-core-changelog.md`

- [ ] **Step 1: API 设计文档**

§4 Training 端点清单：`/training/judge`、`/practice/judge`、exam answers 响应**删除 analysis 字段说明**；新增 `GET /api/training/questions/explanations`、`GET /api/training/questions/{questionId}/explanation-wait`；§4 Admin 加 `/admin/notifications` 三端点。同步版本日志。

- [ ] **Step 2: openapi.yaml**

同步 `/training/judge`、`/practice/judge`、exam answers 响应 schema 去 analysis；加 explanations / explanation-wait / admin notifications 三端点 + schema。

- [ ] **Step 3: 核对一致性**

Run: 对比两份文档端点路径列表（CLAUDE.md 同步规则），grep `analysis` 确认判题响应 schema 已移除。

- [ ] **Step 4: ai-core-changelog**

新增条目：判题只判对错、解析缓存化（ExplanationCacheService + solution prompt + explanation-wait + admin_notifications）、局限（进程内队列/多实例重复生成）。

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs(api): 判题响应去 analysis、新增解析批量/刷新与 admin 通知端点"
```

---

## 自审记录

- **Spec 覆盖**：判题瘦身（T2/T5/T6）、后台异步生成（T4）、长答案直写（T4）、末题批量拉解析等 in-flight（T7/T11）、刷新 120s 倒计时 + 失败通知管理员（T7/T8/T12）、solution prompt/SVG（T1）、thinking 维持现状（不涉及）、admin 通知复刻 parent_messages（T8）、人工补题解入口（spec §10 明确不做）、门禁语义与辅线入本（spec §10 待办，本计划不实施）。
- **类型一致性**：`ExplanationCacheService.ensureExplanation` 统一收 `Pick<QuestionRow,'id'|'answer'|'explanation'>`；`waitForExplanations`/`waitExplanation` 签名在 T4 定义、T7 消费一致；`AnswerResultList` 新 props 在 T10 定义、T11 消费一致。
- **实现修正记录**（随任务执行更新）：
  - T5：PracticeService 构造 mock 纠正——explanationCache 注入 JudgeCoreService 第 5 参而非 PracticeService（判错委托 judgeCore）；ExplanationCacheService 必须由 PracticeModule 导出供 TrainingModule 注入同一实例（防第二空队列）。
  - T7：`getExplanations`/`waitForExplanation` 采用无 studentId 签名（解析为题级公开数据，防 IDOR 无意义，与 hint 端点一致）。
  - T7：`explanation-wait` 存在成本滥用面（任意学生可枚举 id 触发强模型生成）——已加题目存在性检查缓解；平台级限流缺口与 hint 端点同源，记入 changelog 已知局限。
