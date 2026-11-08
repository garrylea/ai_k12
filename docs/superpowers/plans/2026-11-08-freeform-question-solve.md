# 做题入口（自由做题）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/student/entry` 增加「做题」入口，跑通「文字/图片录入 → MinerU 识题 → 选题（题干+配图多选）→ 作答（左编辑/预览、右草稿）→ 千问判题/答疑 → 题库+错题本落库」。

**Architecture:** 新增 `freeform` 后端模块：`MineruRunner`（CLI 封装）→ `FreeformRecognizeService`（MinerU + 本地/千问切题）→ `FreeformJudgeService`（千问流式判题 + 题库/错题本/会话落库）。前端 `SolvePage` 用三态状态机（录入/选题/作答）+ 两个 tab（作答 / AI 答疑），复用 `DraftWhiteboard`、`LatexEditor`/`LatexPreview`、`AuxChatPanel`/`AuxInputBar`。

**Tech Stack:** NestJS + TypeScript + mysql2 + vitest；React + Vite + TS + Tailwind + vitest/RTL；MinerU `mineru-open-api` CLI；千问 3.8-max 流式 SSE。

## Global Constraints

- UI 不用 emoji、不用吉祥物；图标必须是线性 SVG；不按学段分色；配色只用 `style.md` §2。
- 主题：本页写死 `student-day`，不做夜间切换；外壳 `student-theme-container` + `data-school="junior"`（与现有训练页一致）。
- 苏格拉底原则：答疑按钮与引导优先；本页判题报告按用户确认的「分步得分 + 建议 + 参考解析」输出，不额外做「看答案」门禁。
- 题目入库：`source='freeform'`、`answer_verified=0`、**不写 `question_knowledge_points`**、`grade_band=NULL`。
- 错题本：**只在 `totalScore < maxScore` 时写**；满分清零；不发积分、不写 `practice_results`、不调 `MasteryService`。
- freeform 题不进任何自动练习池（专项/同类型/变式/考试/错题练习）；错题练习页显示但不可勾选。
- 原题照片不写进 `questions.content`；只存 MinerU 提取且学生勾选的配图。
- 不做独立历史；刷新回到录入；答疑会话 `scene='aux_freeform'`，不出现在答疑列表。
- 最多 6 张题图；单张 ≤5MB；配图 ≤6 张；草稿合成图 ≤5MB。
- 给用户的交付命令只能有一条：`bash tools/freeform/setup.sh`。
- 所有 DDL/迁移必须幂等；`updated_at` 用列级 `ON UPDATE CURRENT_TIMESTAMP(3)`，不建触发器。
- 测试与文档同步：改 config/类型/契约时同步改测试与设计文档；组件改动必须补渲染测试。

---

## File Map

**后端新增**
- `apps/server/src/ai-core/capabilities/freeform-split.capability.ts`
- `apps/server/src/ai-core/capabilities/freeform-split.capability.test.ts`
- `apps/server/src/ai-core/capabilities/freeform-judge.capability.ts`
- `apps/server/src/ai-core/capabilities/freeform-judge.capability.test.ts`
- `apps/server/src/ai-core/prompts/freeform/split.md`
- `apps/server/src/ai-core/prompts/freeform/judge.md`
- `apps/server/src/modules/freeform/freeform.module.ts`
- `apps/server/src/modules/freeform/freeform.controller.ts`
- `apps/server/src/modules/freeform/freeform.controller.test.ts`
- `apps/server/src/modules/freeform/freeform-recognize.service.ts`
- `apps/server/src/modules/freeform/freeform-recognize.service.test.ts`
- `apps/server/src/modules/freeform/freeform-judge.service.ts`
- `apps/server/src/modules/freeform/freeform-judge.service.test.ts`
- `apps/server/src/modules/freeform/mineru-runner.ts`
- `apps/server/src/modules/freeform/mineru-runner.test.ts`
- `apps/server/src/modules/freeform/freeform-figures.ts`
- `apps/server/src/modules/freeform/freeform-figures.test.ts`
- `apps/server/src/modules/freeform/dto/freeform.dto.ts`
- `apps/server/src/scripts/migrate-freeform-routes.ts`
- `tools/db/migrations/2026-11-08_freeform_routes.sql`
- `tools/freeform/setup.sh`

**后端修改**
- `apps/server/src/ai-core/types.ts`（Scene、Split/Judge 类型）
- `apps/server/src/ai-core/infra/prompt-builder.ts`（新 capability 路径）
- `apps/server/src/ai-core/model-routes.yaml`（两条路由）
- `apps/server/src/database/repositories/types.ts`（`AiDialogueScene` + `full_score`）
- `apps/server/src/database/repositories/uploaded-files.repo.ts`（`findByUrlAndOwner`）
- `apps/server/src/database/repositories/questions.repo.ts`（`createFreeform` / `updateFreeform`）
- `apps/server/src/database/repositories/main-error-books.repo.ts`（`findErrorBookEntries` 增加 source）
- `apps/server/src/common/utils/content-hash.util.ts`（去图片哈希）
- `apps/server/src/modules/files/files.controller.ts`（source query）
- `apps/server/src/modules/files/files.controller.test.ts`（source 校验）
- `apps/server/src/modules/conversations/conversations.service.ts`（scene 白名单）
- `apps/server/src/modules/conversations/conversations.service.test.ts`
- `apps/server/src/modules/conversations/conversations.controller.ts`（scene 类型）
- `apps/server/src/modules/training/training.service.ts`（error book DTO 带 source）
- `apps/server/src/modules/training/training.service.test.ts`
- `apps/server/src/app.module.ts`（注册 FreeformModule）
- `.env.example`（MinerU 变量）

**前端新增**
- `apps/web/src/pages/student/SolvePage.tsx`
- `apps/web/src/pages/student/SolvePage.test.tsx`
- `apps/web/src/pages/student/solve/types.ts`
- `apps/web/src/pages/student/solve/SolveSourceInput.tsx`
- `apps/web/src/pages/student/solve/SolveSourceInput.test.tsx`
- `apps/web/src/pages/student/solve/SolveCandidatePicker.tsx`
- `apps/web/src/pages/student/solve/SolveCandidatePicker.test.tsx`
- `apps/web/src/pages/student/solve/SolveAnswerView.tsx`
- `apps/web/src/pages/student/solve/SolveAnswerView.test.tsx`
- `apps/web/src/pages/student/solve/useFreeformRecognize.ts`
- `apps/web/src/pages/student/solve/useFreeformJudge.ts`
- `apps/web/src/pages/student/solve/useFreeformTutor.ts`
- `apps/web/src/pages/student/solve/freeform-hooks.test.ts`
- `apps/web/src/components/business/draft-render.ts`
- `apps/web/src/components/business/draft-render.test.ts`

**前端修改**
- `apps/web/src/routes/routeTable.tsx`（`/student/solve`）
- `apps/web/src/pages/auth/EntrySelectPage.tsx` + test（第 4 卡）
- `apps/web/src/services/api.ts`（freeform 接口 + scene 类型 + upload source）
- `apps/web/src/services/api.freeform.test.ts`（新增）
- `apps/web/src/store/chatStore.ts`（`markdown?`）
- `apps/web/src/components/business/AuxChatPanel.tsx` + test（用户消息 Markdown）
- `apps/web/src/components/business/DraftWhiteboard.tsx`（`snapshotRef`）
- `apps/web/src/components/business/DraftWhiteboard.test.tsx`
- `apps/web/src/pages/student/training/ErrorPracticePage.tsx` + test（freeform 不可勾选）
- `apps/web/src/pages/auth/EntrySelectPage.test.tsx`

**文档**
- `docs/K12智学系统-产品需求文档.md`（§7.15）
- `docs/API接口与数据流设计文档.md`（§4.30 / §5.33）
- `docs/api/openapi.yaml`
- `docs/constraints/做题入口.md`
- `CLAUDE.md`（constraints 索引一行）
- `docs/ai-core-changelog.md`（实现后补）

---

### Task 1: AI 核心类型、路由与 PromptBuilder 路径

**Files:**
- Modify: `apps/server/src/ai-core/types.ts`
- Modify: `apps/server/src/ai-core/infra/prompt-builder.ts`
- Modify: `apps/server/src/ai-core/model-routes.yaml`
- Test: `apps/server/src/ai-core/infra/model-router.test.ts`
- Test: `apps/server/src/ai-core/infra/prompt-builder.test.ts`（若不存在则新建）

**Interfaces:**
- Produces:
  - `Scene` 增加 `'freeform_split' | 'freeform_judge'`
  - `CapabilityType` 增加 `'freeform_split' | 'freeform_judge'`
  - `PromptBuilder.build({ capability: 'freeform_split' | 'freeform_judge', ... })` 分别加载 `freeform/split.md`、`freeform/judge.md`
  - `ModelRouter.route({ scene: 'freeform_split', subject })` → primary `local`、fallback `qwen3.8-max`
  - `ModelRouter.route({ scene: 'freeform_judge', subject })` → primary `qwen3.8-max`、无 fallback

- [ ] **Step 1: 写失败测试（路由）**

在 `model-router.test.ts` 里加：

```ts
it('freeform_split 本地优先、千问兜底', () => {
  const r = new ModelRouter().route({ scene: 'freeform_split', subject: 'math' });
  expect(r.primary.modelId).toBe('Qwen3.8-27B');
  expect(r.fallback?.modelId).toBe('qwen3.8-max');
});

it('freeform_judge 固定千问、无 fallback', () => {
  const r = new ModelRouter().route({ scene: 'freeform_judge', subject: 'physics' });
  expect(r.primary.modelId).toBe('qwen3.8-max');
  expect(r.fallback).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/ai-core/infra/model-router.test.ts`
Expected: FAIL（`freeform_split` 落到 default，primary 为 qwen3.8-max）

- [ ] **Step 3: 改类型与路由**

`types.ts`：

```ts
export type Scene =
  | 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation'
  | 'analysis' | 'safety' | 'structuring' | 'hint' | 'title'
  | 'dictation_feedback' | 'interpretation_judge' | 'english_word_judge'
  | 'chinese_meaning_judge' | 'handwriting'
  | 'freeform_split' | 'freeform_judge';
```

`model-routes.yaml` 的 `routes:` 下加：

```yaml
  freeform_split:
    - subject: "*"
      primary: local
      fallback: qwen3.8-max

  freeform_judge:
    - subject: "*"
      primary: qwen3.8-max
```

- [ ] **Step 4: 改 PromptBuilder 路径**

`prompt-builder.ts` 的 `resolveTemplatePath` 加：

```ts
if (capability === 'freeform_split') return 'freeform/split.md';
if (capability === 'freeform_judge') return 'freeform/judge.md';
```

并在 `types.ts` 的 `CapabilityType` 联合类型里加 `'freeform_split' | 'freeform_judge'`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/ai-core/infra/model-router.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ai-core/types.ts apps/server/src/ai-core/infra/prompt-builder.ts apps/server/src/ai-core/model-routes.yaml apps/server/src/ai-core/infra/model-router.test.ts
git commit -m "feat(ai-core): add freeform split/judge scenes and routes"
```

---

### Task 2: `FreeformSplitCapability`（MinerU Markdown → 候选题）

**Files:**
- Create: `apps/server/src/ai-core/prompts/freeform/split.md`
- Create: `apps/server/src/ai-core/capabilities/freeform-split.capability.ts`
- Test: `apps/server/src/ai-core/capabilities/freeform-split.capability.test.ts`

**Interfaces:**
- Consumes: `ModelRouter`、`PromptBuilder`、`ModelClient`、`ResponseParser`
- Produces:
  ```ts
  export interface FreeformSplitRequest {
    markdown: string;
    textHint?: string;
    subjectHint?: 'math' | 'physics' | 'chemistry';
  }
  export interface FreeformSplitCandidate {
    no: string;
    content: string;
    figureRefs: string[];
    suggestedSubject: 'math' | 'physics' | 'chemistry' | null;
    confidence: number;
    selectedHint: boolean;
  }
  export class FreeformSplitCapability {
    split(req: FreeformSplitRequest): Promise<FreeformSplitCandidate[]>;
  }
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { FreeformSplitCapability } from './freeform-split.capability.js';

const router = {
  route: vi.fn().mockReturnValue({
    primary: { modelId: 'Qwen3.8-27B', modelKey: 'local' },
    fallback: { modelId: 'qwen3.8-max', modelKey: 'qwen3.8-max' },
  }),
} as any;

function clientReturning(content: string) {
  return { chat: vi.fn().mockResolvedValue({ content }) } as any;
}

describe('FreeformSplitCapability', () => {
  it('解析候选题 JSON', async () => {
    const content = JSON.stringify({
      questions: [{
        no: '5', content: '已知 ![图](images/a.jpg) 求 x', figureRefs: ['images/a.jpg'],
        suggestedSubject: 'math', confidence: 0.9, selectedHint: true,
      }],
    });
    const cap = new FreeformSplitCapability({ modelRouter: router, modelClient: clientReturning(content) });
    const out = await cap.split({ markdown: '<!-- page 1 -->\n第5题...', textHint: '第5题' });
    expect(out).toHaveLength(1);
    expect(out[0].figureRefs).toEqual(['images/a.jpg']);
    expect(out[0].selectedHint).toBe(true);
  });

  it('本地 JSON 坏 → 回退千问', async () => {
    const client = {
      chat: vi.fn()
        .mockResolvedValueOnce({ content: '不是 json' })
        .mockResolvedValueOnce({ content: JSON.stringify({ questions: [{ content: '题', no: '1' }] }) }),
    } as any;
    const cap = new FreeformSplitCapability({ modelRouter: router, modelClient: client });
    const out = await cap.split({ markdown: '题' });
    expect(out[0].content).toBe('题');
    expect(client.chat).toHaveBeenCalledTimes(2);
  });

  it('两路都失败抛错', async () => {
    const client = { chat: vi.fn().mockResolvedValue({ content: 'not json' }) } as any;
    const cap = new FreeformSplitCapability({ modelRouter: router, modelClient: client });
    await expect(cap.split({ markdown: '题' })).rejects.toThrow(/freeform split failed/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/ai-core/capabilities/freeform-split.capability.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写提示词**

`prompts/freeform/split.md`：

```markdown
---
version: "1.0"
description: "MinerU Markdown 切题：找出完整题目，不改写题干"
---

## System Prompt

你是题目切分器，不是解题器。输入是 MinerU 从多页题目图片转出的 Markdown（页间有 `<!-- page N -->` 标记）。

任务：
1. 找出其中所有完整的题目，按原顺序输出。
2. 一页多题时每题单独一条；跨页题目合并成一条。
3. 保留题干里的 Markdown、LaTeX、图片引用（`![...](images/xxx.jpg)`），不要改写题干。
4. 忽略页眉页脚、注意事项、分值说明、答案解析。
5. 如果学生给了文字提示（如「第 5 题」），把对应题目的 selectedHint 设为 true；其余为 false。
6. 不要解题，不要给答案。

只输出 JSON，不要代码围栏、不要解释：
{
  "questions": [
    {
      "no": "5",
      "content": "题干 Markdown（含图片引用）",
      "figureRefs": ["images/a.jpg"],
      "suggestedSubject": "math" | "physics" | "chemistry" | null,
      "confidence": 0.0,
      "selectedHint": false
    }
  ]
}

## User Message

学生文字提示（可为空）：
{{textHint}}

学科建议：
{{subjectHint}}

MinerU Markdown：
{{markdown}}

请输出 JSON。
```

- [ ] **Step 4: 实现**

```ts
import { z } from 'zod';
import type { Subject } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CandidateSchema = z.object({
  no: z.string().max(20).default(''),
  content: z.string().min(1),
  figureRefs: z.array(z.string()).default([]),
  suggestedSubject: z.enum(['math', 'physics', 'chemistry']).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.8),
  selectedHint: z.boolean().default(false),
});
const ResultSchema = z.object({ questions: z.array(CandidateSchema).min(1) });

export interface FreeformSplitCandidate {
  no: string;
  content: string;
  figureRefs: string[];
  suggestedSubject: 'math' | 'physics' | 'chemistry' | null;
  confidence: number;
  selectedHint: boolean;
}
export interface FreeformSplitRequest {
  markdown: string;
  textHint?: string;
  subjectHint?: 'math' | 'physics' | 'chemistry';
}
export interface FreeformSplitDeps {
  modelClient?: ModelClient;
  modelRouter?: ModelRouter;
}

export class FreeformSplitCapability {
  private router: ModelRouter;
  private promptBuilder: PromptBuilder;
  private client: ModelClient;
  private parser = new ResponseParser();

  constructor(deps?: FreeformSplitDeps) {
    this.router = deps?.modelRouter ?? new ModelRouter(getModelConfigRegistry());
    this.client = deps?.modelClient ?? new ModelClient();
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
  }

  async split(req: FreeformSplitRequest): Promise<FreeformSplitCandidate[]> {
    const subject: Subject = req.subjectHint ?? 'math';
    const prompt = await this.promptBuilder.build({
      capability: 'freeform_split',
      subject,
      context: {
        student: { grade: '', gradeLevel: '' },
        userMessage: req.textHint ?? '切题',
        customVariables: {
          markdown: req.markdown,
          textHint: req.textHint ?? '',
          subjectHint: subject,
        },
      },
    });
    const route = this.router.route({ scene: 'freeform_split', subject });
    const models = [route.primary, route.fallback].filter(Boolean) as any[];
    let lastErr: unknown;
    for (const model of models) {
      try {
        const res = await this.client.chat({
          model,
          messages: prompt.messages,
          responseFormat: 'json_object',
          thinking: false,
          timeout: timeoutConfig.timeout.structuring ?? 45000,
        });
        const parsed = this.parser.parse<{ questions: FreeformSplitCandidate[] }>({
          rawContent: res.content,
          mode: 'json',
          schema: ResultSchema,
        });
        if (parsed.success && parsed.data) return parsed.data.questions.slice(0, 20);
        lastErr = new Error(parsed.errors?.join(', ') ?? 'empty questions');
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`freeform split failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }
}
```

> 注意：若 `PromptBuilder` 的 `customVariables` 类型不允许这些 key，先在其类型里加 `[k: string]: string`（现有模板变量已是宽松 key）。测试注入的 `modelRouter` 返回两个模型，生产由 YAML/DB 路由提供。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/ai-core/capabilities/freeform-split.capability.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ai-core/prompts/freeform/split.md apps/server/src/ai-core/capabilities/freeform-split.capability.ts apps/server/src/ai-core/capabilities/freeform-split.capability.test.ts
git commit -m "feat(ai-core): add freeform split capability"
```

---

### Task 3: `FreeformJudgeCapability`（千问流式判题）

**Files:**
- Create: `apps/server/src/ai-core/prompts/freeform/judge.md`
- Create: `apps/server/src/ai-core/capabilities/freeform-judge.capability.ts`
- Test: `apps/server/src/ai-core/capabilities/freeform-judge.capability.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FreeformJudgeImage { label: string; dataUrl: string }
  export interface FreeformJudgeRequest {
    subject: 'math' | 'physics' | 'chemistry';
    maxScore: number;
    questionContent: string;
    studentAnswer: string;
    images: FreeformJudgeImage[];
  }
  export type FreeformJudgeStreamEvent =
    | { type: 'reasoning'; delta: string }
    | { type: 'content'; delta: string };
  export class FreeformJudgeCapability {
    stream(req: FreeformJudgeRequest, signal?: AbortSignal): AsyncIterable<FreeformJudgeStreamEvent>;
    extractStructured(req: {
      report: string; questionContent: string; studentAnswer: string; maxScore: number;
    }): Promise<unknown | null>;
  }
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { FreeformJudgeCapability } from './freeform-judge.capability.js';

it('把 reasoning/content 原样流式吐出', async () => {
  const client = {
    streamChat: vi.fn().mockImplementation(async function* () {
      yield { reasoningContent: '先看题', content: '' };
      yield { content: '## 判题结果\n得分 7/10' };
    }),
  } as any;
  const router = {
    route: vi.fn().mockReturnValue({ primary: { modelId: 'qwen3.8-max', modelKey: 'qwen3.8-max' } }),
  } as any;
  const cap = new FreeformJudgeCapability({ modelClient: client, modelRouter: router });
  const events: any[] = [];
  for await (const e of cap.stream({
    subject: 'math', maxScore: 10,
    questionContent: '已知 x+1=2', studentAnswer: 'x=1', images: [],
  })) events.push(e);

  expect(events[0]).toEqual({ type: 'reasoning', delta: '先看题' });
  expect(events[1]).toEqual({ type: 'content', delta: '## 判题结果\n得分 7/10' });
  const req = client.streamChat.mock.calls[0][0];
  expect(req.model.modelId).toBe('qwen3.8-max');
  expect(JSON.stringify(req.messages)).toContain('x+1=2');
});

it('extractStructured 只返回 JSON 对象', async () => {
  const client = {
    chat: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        verdict: 'partial', totalScore: 7, maxScore: 10, steps: [], suggestions: [],
        question: { type: 'short_answer', difficulty: 1, options: null, answer: 'x=1', explanation: null, approach: null },
      }),
    }),
  } as any;
  const router = { route: vi.fn().mockReturnValue({ primary: { modelId: 'qwen3.8-max', modelKey: 'qwen3.8-max' } }) } as any;
  const out = await new FreeformJudgeCapability({ modelClient: client, modelRouter: router })
    .extractStructured({ report: '报告', questionContent: '题', studentAnswer: '答', maxScore: 10 });
  expect((out as any).totalScore).toBe(7);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/ai-core/capabilities/freeform-judge.capability.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写提示词**

`prompts/freeform/judge.md`：

```markdown
---
version: "1.0"
description: "做题入口判题：分步得分 + 尾部结构化 JSON"
---

## System Prompt

你是理科阅卷老师。输入包含：
- 题目（Markdown+LaTeX，含配图；图片以 image 部件给出）
- 学生作答（Markdown+LaTeX）
- 可选：学生草稿图、作答区粘贴图

要求：
1. 先独立解题，再按步骤批改。
2. 满分固定为 {{maxScore}} 分，不得改。
3. 总分等于各步骤得分之和；结论 = correct（满分）/ partial（>0 且 <满分）/ incorrect（0 分）。
4. 先输出 Markdown 报告（总分、结论、分步表、改进建议、参考解析），最后输出**唯一一个** ```json 代码块。
5. JSON 里的 question 必须是可入库的结构化题：type/difficulty/options/answer/explanation/approach。
6. 不要输出第二个 json 块；不要在 json 块后写任何文字。

报告格式：
## 判题结果

**得分：x / {{maxScore}}** · **结论：…**

| 步骤 | 得分 | 点评 |
|---|---|---|
| 1. … | 2/2 | … |

### 改进建议
- …

### 参考解析
…

尾部 JSON：
{
  "verdict": "correct|partial|incorrect",
  "totalScore": 0,
  "maxScore": {{maxScore}},
  "steps": [{"stepNumber":1,"description":"…","score":0,"maxScore":0,"isCorrect":false,"comment":"…","errorType":"logic|calculation|format|missing|null"}],
  "suggestions": ["…"],
  "question": {
    "type": "choice|multi_choice|fill_blank|true_false|short_answer|proof|calculation",
    "difficulty": 1,
    "options": null,
    "answer": "标准答案",
    "explanation": "解析",
    "approach": "解题思路"
  }
}

## User Message

满分：{{maxScore}}

题目：
{{question.content}}

学生作答：
{{studentAnswer}}

请判题。
```

- [ ] **Step 4: 实现**

```ts
import type { ChatMessage, Subject } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface FreeformJudgeImage { label: string; dataUrl: string }
export interface FreeformJudgeRequest {
  subject: 'math' | 'physics' | 'chemistry';
  maxScore: number;
  questionContent: string;
  studentAnswer: string;
  images: FreeformJudgeImage[];
}
export type FreeformJudgeStreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string };

export class FreeformJudgeCapability {
  private router: ModelRouter;
  private promptBuilder: PromptBuilder;
  private client: ModelClient;

  constructor(deps?: { modelClient?: ModelClient; modelRouter?: ModelRouter }) {
    this.router = deps?.modelRouter ?? new ModelRouter(getModelConfigRegistry());
    this.client = deps?.modelClient ?? new ModelClient();
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
  }

  async *stream(req: FreeformJudgeRequest, signal?: AbortSignal): AsyncIterable<FreeformJudgeStreamEvent> {
    const subject = req.subject as Subject;
    const prompt = await this.promptBuilder.build({
      capability: 'freeform_judge',
      subject,
      context: {
        student: { grade: '', gradeLevel: '' },
        question: { content: req.questionContent, answer: '', rubric: '', material: null },
        studentAnswer: req.studentAnswer,
        userMessage: '请判题',
        customVariables: { maxScore: String(req.maxScore) },
      },
    });
    const route = this.router.route({ scene: 'freeform_judge', subject });

    // 把图片作为 text+image_url 部件追加到最后一条 user 消息
    const messages: ChatMessage[] = prompt.messages.map((m) => ({ ...m }));
    const last = messages[messages.length - 1];
    if (req.images.length > 0) {
      const parts: any[] = [];
      if (typeof last.content === 'string' && last.content) parts.push({ type: 'text', text: last.content });
      for (const img of req.images) {
        parts.push({ type: 'text', text: `【${img.label}】` });
        parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      }
      last.content = parts as any;
    }

    for await (const chunk of this.client.streamChat({
      model: route.primary,
      messages,
      timeout: timeoutConfig.timeout.judgment ?? 90000,
      signal,
    })) {
      if (chunk.reasoningContent) yield { type: 'reasoning', delta: chunk.reasoningContent };
      if (chunk.content) yield { type: 'content', delta: chunk.content };
    }
  }

  /** 流式报告里的 JSON 块坏了时，二次非流式提取（只返回 JSON 对象或 null）。 */
  async extractStructured(req: {
    report: string; questionContent: string; studentAnswer: string; maxScore: number;
  }): Promise<unknown | null> {
    const route = this.router.route({ scene: 'freeform_judge', subject: 'math' });
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是结构化提取器。把下面的判题报告整理成 JSON，只输出 JSON，不要代码围栏。
字段：verdict(correct|partial|incorrect)、totalScore、maxScore、steps[{stepNumber,description,score,maxScore,isCorrect,comment,errorType}]、suggestions[]、question{type,difficulty,options,answer,explanation,approach}。
满分固定为 ${req.maxScore}。`,
      },
      {
        role: 'user',
        content: `题目：\n${req.questionContent}\n\n学生作答：\n${req.studentAnswer}\n\n判题报告：\n${req.report}`,
      },
    ];
    try {
      const res = await this.client.chat({
        model: route.primary,
        messages,
        responseFormat: 'json_object',
        thinking: false,
        timeout: 45000,
      });
      return JSON.parse(res.content) as unknown;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/ai-core/capabilities/freeform-judge.capability.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ai-core/prompts/freeform/judge.md apps/server/src/ai-core/capabilities/freeform-judge.capability.ts apps/server/src/ai-core/capabilities/freeform-judge.capability.test.ts
git commit -m "feat(ai-core): add freeform judge streaming capability"
```

---

### Task 4: 上传 source 与按 URL 查归属

**Files:**
- Modify: `apps/server/src/database/repositories/uploaded-files.repo.ts`
- Modify: `apps/server/src/modules/files/files.controller.ts`
- Test: `apps/server/src/modules/files/files.controller.test.ts`
- Test: `apps/server/src/database/repositories/uploaded-files.repo.test.ts`（若不存在则新建）

**Interfaces:**
- Produces:
  ```ts
  // UploadedFilesRepository
  findByUrlAndOwner(url: string, uploaderId: number): Promise<UploadedFileRow | null>
  ```
- `POST /api/files/upload?source=freeform` 接受白名单 `auxiliary|freeform`。

- [ ] **Step 1: 写失败测试（controller）**

```ts
it('source=freeform 透传给 service', async () => {
  const service = { upload: vi.fn().mockResolvedValue({ fileId: 1, url: '/uploads/x.jpg' }) } as any;
  const c = new FilesController(service);
  await c.upload({ mimetype: 'image/jpeg', size: 10, originalname: 'a.jpg', buffer: Buffer.from('') } as any, { sub: 1 } as any, 'freeform');
  expect(service.upload).toHaveBeenCalledWith(expect.anything(), 1, 'freeform');
});

it('非法 source 拒绝', async () => {
  const c = new FilesController({ upload: vi.fn() } as any);
  await expect(c.upload({} as any, { sub: 1 } as any, 'evil'))
    .rejects.toMatchObject({ response: { code: 1001 } });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/files/files.controller.test.ts`
Expected: FAIL（`upload` 只接收 2 个参数）

- [ ] **Step 3: 实现 controller source**

```ts
@Post('upload')
@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
async upload(
  @UploadedFile() file: Express.Multer.File,
  @CurrentUser() user: JwtUser,
  @Query('source') source?: string,
) {
  if (!file) throw new BadRequestException({ code: 1001, message: '缺少上传文件' });
  const s = source ?? 'auxiliary';
  if (s !== 'auxiliary' && s !== 'freeform') {
    throw new BadRequestException({ code: 1001, message: 'source 仅支持 auxiliary | freeform' });
  }
  return this.filesService.upload(file, user.sub, s);
}
```

需要从 `@nestjs/common` 导入 `Query`。

- [ ] **Step 4: 实现 repo 方法**

```ts
async findByUrlAndOwner(url: string, uploaderId: number): Promise<UploadedFileRow | null> {
  const [rows] = await this.pool.execute<RowDataPacket[]>(
    `SELECT * FROM uploaded_files WHERE url = ? AND uploader_id = ? LIMIT 1`,
    [url, uploaderId],
  );
  return (rows[0] as UploadedFileRow) ?? null;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/files/files.controller.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/files/files.controller.ts apps/server/src/modules/files/files.controller.test.ts apps/server/src/database/repositories/uploaded-files.repo.ts
git commit -m "feat(files): add freeform upload source and url ownership lookup"
```

---

### Task 5: `MineruRunner`（CLI 封装）

**Files:**
- Create: `apps/server/src/modules/freeform/mineru-runner.ts`
- Test: `apps/server/src/modules/freeform/mineru-runner.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class MineruRunner {
    run(files: string[], outDir: string, signal?: AbortSignal): Promise<void>;
  }
  export class FreeformMineruError extends Error {}
  ```
- 环境变量：`MINERU_BIN`（默认 `mineru-open-api`）、`MINERU_TOKEN`、`MINERU_TIMEOUT_MS`（默认 90000）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { MineruRunner, FreeformMineruError } from './mineru-runner.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

afterEach(() => { spawnMock.mockReset(); vi.useRealTimers(); });

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

it('按顺序传文件、设置 token、不带 shell', async () => {
  const child = fakeChild();
  spawnMock.mockReturnValue(child);
  process.env.MINERU_TOKEN = 'sk-test';
  const p = new MineruRunner().run(['/tmp/page_01.jpg', '/tmp/page_02.jpg'], '/tmp/out');
  child.emit('close', 0);
  await p;
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [bin, args, opts] = spawnMock.mock.calls[0];
  expect(bin).toBe(process.env.MINERU_BIN ?? 'mineru-open-api');
  expect(args).toEqual(expect.arrayContaining(['extract', '/tmp/page_01.jpg', '/tmp/page_02.jpg', '-o', '/tmp/out', '-f', 'md']));
  expect(opts.shell).toBe(false);
  expect(opts.env.MINERU_TOKEN).toBe('sk-test');
});

it('非 0 退出抛 FreeformMineruError，且 stderr 不含 token', async () => {
  const child = fakeChild();
  spawnMock.mockReturnValue(child);
  process.env.MINERU_TOKEN = 'sk-secret';
  const p = new MineruRunner().run(['/tmp/a.jpg'], '/tmp/out');
  child.stderr.emit('data', Buffer.from('401 sk-secret bad token'));
  child.emit('close', 1);
  await expect(p).rejects.toBeInstanceOf(FreeformMineruError);
  await p.catch((e) => expect(e.message).not.toContain('sk-secret'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/freeform/mineru-runner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
import { spawn } from 'node:child_process';

export class FreeformMineruError extends Error {}

export class MineruRunner {
  async run(files: string[], outDir: string, signal?: AbortSignal): Promise<void> {
    const bin = process.env.MINERU_BIN ?? 'mineru-open-api';
    const token = process.env.MINERU_TOKEN;
    if (!token) throw new FreeformMineruError('MINERU_TOKEN 未配置');
    const timeoutMs = Number(process.env.MINERU_TIMEOUT_MS ?? 90000);

    const args = [
      'extract', ...files,
      '-o', outDir,
      '-f', 'md',
      '--timeout', String(Math.max(1, Math.round(timeoutMs / 1000))),
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, {
        shell: false,
        env: { ...process.env, MINERU_TOKEN: token },
      });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new FreeformMineruError('MinerU 超时'));
      }, timeoutMs + 5000);
      const onAbort = () => {
        child.kill('SIGKILL');
        reject(new FreeformMineruError('MinerU 已取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new FreeformMineruError(`MinerU 启动失败：${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (code === 0) return resolve();
        const safe = stderr.split(token).join('***').slice(-500);
        reject(new FreeformMineruError(`MinerU 退出码 ${code}：${safe}`));
      });
    });
  }
}

/** 进程内并发限制：最多 N 个 MinerU 任务同时跑；超出的排队。 */
export class MineruLimiter {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

/** 模块级单例：并发数读 MINERU_CONCURRENCY，默认 2。 */
export const mineruLimiter = new MineruLimiter(Number(process.env.MINERU_CONCURRENCY ?? 2));
```

> 并发信号量用上面的 `mineruLimiter` 在 `FreeformRecognizeService` 里包住 `mineru.run`；runner 只负责单次调用。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/freeform/mineru-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/freeform/mineru-runner.ts apps/server/src/modules/freeform/mineru-runner.test.ts
git commit -m "feat(freeform): add MinerU CLI runner"
```

---

### Task 6: 配图落盘/重写 + `FreeformRecognizeService`

**Files:**
- Create: `apps/server/src/modules/freeform/freeform-figures.ts`
- Test: `apps/server/src/modules/freeform/freeform-figures.test.ts`
- Create: `apps/server/src/modules/freeform/freeform-recognize.service.ts`
- Test: `apps/server/src/modules/freeform/freeform-recognize.service.test.ts`

**Interfaces:**
- Consumes: `MineruRunner`、`FreeformSplitCapability`、`UploadedFilesRepository`
- Produces:
  ```ts
  export interface FreeformRecognizeResult {
    candidates: Array<{
      id: string; no: string; content: string; figureUrls: string[];
      suggestedSubject: 'math'|'physics'|'chemistry'|null; confidence: number;
    }>;
    figures: Array<{ url: string; name: string; page: number }>;
  }
  export class FreeformRecognizeService {
    recognize(input: { text?: string; fileIds: string[] }, studentId: number): Promise<FreeformRecognizeResult>;
  }
  ```

- [ ] **Step 1: 写失败测试（纯文字短路 + 图片流程 mock）**

```ts
// 测试顶部用内存 fs 替身，避免碰真实磁盘：
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
  readdir: vi.fn(async (dir: string) => dir.endsWith('images') ? ['a.jpg'] : ['page_01.md']),
  readFile: vi.fn(async () => '已知 ![a](images/a.jpg)'),
  stat: vi.fn(async () => ({ size: 10 })),
  rm: vi.fn(async () => {}),
}));

it('纯文字短路：不调 MinerU/切题', async () => {
  const mineru = { run: vi.fn() } as any;
  const split = { split: vi.fn() } as any;
  const files = { findByIdAndOwner: vi.fn() } as any;
  const svc = new FreeformRecognizeService(mineru, split, files);
  const r = await svc.recognize({ text: '已知 x+1=2', fileIds: [] }, 1);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].content).toBe('已知 x+1=2');
  expect(mineru.run).not.toHaveBeenCalled();
  expect(split.split).not.toHaveBeenCalled();
});

it('图片：按顺序复制、调 MinerU、重写配图、返回候选', async () => {
  const mineru = { run: vi.fn().mockResolvedValue(undefined) } as any;
  const split = { split: vi.fn().mockResolvedValue([{
    no: '5', content: '已知 ![a](images/a.jpg)', figureRefs: ['images/a.jpg'],
    suggestedSubject: 'math', confidence: 0.9, selectedHint: false,
  }]) } as any;
  const files = {
    findByIdAndOwner: vi.fn().mockResolvedValue({ id: 1, url: '/uploads/a.jpg', mime_type: 'image/jpeg', size_bytes: 10 }),
    create: vi.fn().mockResolvedValue(1),
  } as any;
  const svc = new FreeformRecognizeService(mineru, split, files);
  const r = await svc.recognize({ text: '第5题', fileIds: ['1'] }, 1);
  expect(mineru.run).toHaveBeenCalled();
  expect(r.candidates[0].figureUrls[0]).toMatch(/^\/uploads\/freeform\//);
});
```

> 测试用 `vi.mock('node:fs/promises')` 提供内存 fs；生产用真实 `node:fs/promises`。`UPLOAD_DIR` 在测试里用 `process.env.UPLOAD_DIR='/tmp/u'`（在 `beforeAll` 设置）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform-figures.test.ts src/modules/freeform/freeform-recognize.service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `freeform-figures.ts`**

```ts
import * as path from 'node:path';

const IMG_RE = /!\[([^\]]*)\]\((images\/[^)\s]+)\)/g;

export function rewriteFigureRefs(
  markdown: string,
  publicBase: string,
): { markdown: string; urls: string[] } {
  const urls: string[] = [];
  const out = markdown.replace(IMG_RE, (_m, alt: string, rel: string) => {
    const name = path.posix.basename(rel);
    const url = `${publicBase}/${name}`;
    urls.push(url);
    return `![${alt}](${url})`;
  });
  return { markdown: out, urls: [...new Set(urls)] };
}

export function figureRefs(markdown: string): string[] {
  return [...markdown.matchAll(IMG_RE)].map((m) => m[2]);
}
```

- [ ] **Step 4: 实现 `FreeformRecognizeService`**

```ts
import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { FreeformSplitCapability } from '../../ai-core/capabilities/freeform-split.capability.js';
import { MineruRunner, mineruLimiter } from './mineru-runner.js';
import { rewriteFigureRefs, figureRefs } from './freeform-figures.js';

export interface FreeformRecognizeResult { /* 同接口定义 */ }

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_MARKDOWN = 24000;

@Injectable()
export class FreeformRecognizeService {
  private readonly uploadDir = process.env.UPLOAD_DIR ?? './uploads';
  private readonly tmpDir = os.tmpdir();
  constructor(
    private readonly mineru: MineruRunner,
    private readonly split: FreeformSplitCapability,
    private readonly files: UploadedFilesRepository,
  ) {}

  async recognize(input: { text?: string; fileIds: string[] }, studentId: number): Promise<FreeformRecognizeResult> {
    const text = (input.text ?? '').trim();
    const fileIds = input.fileIds ?? [];
    if (text.length > 20000) throw new BadRequestException({ code: 1001, message: '题目文字过长' });
    if (fileIds.length > MAX_IMAGES) throw new BadRequestException({ code: 1001, message: '最多 6 张题图' });
    if (fileIds.length === 0) {
      if (!text) throw new BadRequestException({ code: 1001, message: '请上传题目图片或输入题目文字' });
      return { candidates: [{ id: 'c1', no: '1', content: text, figureUrls: [], suggestedSubject: null, confidence: 1 }], figures: [] };
    }

    const rows = [];
    for (const id of fileIds) {
      const row = await this.files.findByIdAndOwner(Number(id), studentId);
      if (!row) throw new BadRequestException({ code: 1001, message: '文件不存在或无权访问' });
      if (!ALLOWED.has(row.mime_type)) throw new BadRequestException({ code: 1001, message: '图片格式不支持' });
      if (row.size_bytes > MAX_IMAGE_BYTES) throw new BadRequestException({ code: 1001, message: '图片过大（最大 5MB）' });
      rows.push(row);
    }

    const jobId = randomUUID();
    const work = path.join(this.tmpDir, `freeform-recognize-${jobId}`);
    const out = path.join(work, 'out');
    const publicBase = `/uploads/freeform/${jobId}`;
    const destDir = path.join(this.uploadDir, 'freeform', jobId);
    try {
      await fs.mkdir(out, { recursive: true });
      await fs.mkdir(destDir, { recursive: true });

      const pages: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const ext = rows[i].mime_type === 'image/png' ? '.png' : rows[i].mime_type === 'image/webp' ? '.webp' : '.jpg';
        const src = path.join(this.uploadDir, rows[i].url.replace(/^\/uploads\//, ''));
        const dst = path.join(work, `page_${String(i + 1).padStart(2, '0')}${ext}`);
        await fs.copyFile(src, dst);
        pages.push(dst);
      }

      try {
        await mineruLimiter.run(() => this.mineru.run(pages, out));
      } catch {
        throw new HttpException({ code: 5501, message: '图片解析失败，请重试或手动输入题目' }, 502);
      }

      const entries = (await fs.readdir(out)).filter((f) => f.endsWith('.md')).sort();
      if (entries.length === 0) throw new Error('MinerU 没有输出 Markdown');

      const imgDir = path.join(out, 'images');
      let imgNames: string[] = [];
      try { imgNames = await fs.readdir(imgDir); } catch { /* 可能没有配图 */ }
      for (const name of imgNames) {
        const dst = path.join(destDir, name);
        await fs.copyFile(path.join(imgDir, name), dst);
        const st = await fs.stat(dst).catch(() => ({ size: 0 }));
        await this.files.create({
          uploader_id: studentId,
          uploader_type: 'student',
          url: `${publicBase}/${path.posix.basename(name)}`,
          mime_type: 'image/jpeg',
          size_bytes: st.size,
          source: 'freeform_figure',
        }).catch(() => {});
      }

      const parts: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        const md = await fs.readFile(path.join(out, entries[i]), 'utf-8');
        const rewritten = rewriteFigureRefs(md, publicBase);
        parts.push(`<!-- page ${i + 1} -->\n${rewritten.markdown}`);
      }
      const markdown = parts.join('\n\n');

      const splitInput = markdown.length > MAX_MARKDOWN
        ? markdown.slice(0, MAX_MARKDOWN)
        : markdown;
      let candidates: Awaited<ReturnType<FreeformSplitCapability['split']>>;
      try {
        candidates = await this.split.split({ markdown: splitInput, textHint: text });
      } catch {
        throw new HttpException({ code: 5502, message: '题目切分失败，请重试或手动输入题目' }, 502);
      }
      if (candidates.length === 0) return { candidates: [], figures: [] };

      const allFigures = new Set<string>();
      for (const name of imgNames) allFigures.add(`${publicBase}/${path.posix.basename(name)}`);

      return {
        candidates: candidates.map((c, i) => {
          const refs = c.figureRefs
            .map((r) => `${publicBase}/${path.posix.basename(r)}`)
            .filter((u) => allFigures.has(u));
          return {
            id: `c${i + 1}`,
            no: c.no || String(i + 1),
            content: c.content,
            figureUrls: refs.length ? refs : figureRefs(c.content).map((r) => `${publicBase}/${path.posix.basename(r)}`),
            suggestedSubject: c.suggestedSubject,
            confidence: c.confidence,
          };
        }),
        figures: [...allFigures].map((url) => ({ url, name: path.posix.basename(url), page: 1 })),
      };
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
}
```

> MinerU 并发由 `mineruLimiter` 控制（`MINERU_CONCURRENCY`，默认 2）；测试里 `MineruRunner` 是 mock，不受并发影响。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform-figures.test.ts src/modules/freeform/freeform-recognize.service.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/freeform/freeform-figures.ts apps/server/src/modules/freeform/freeform-figures.test.ts apps/server/src/modules/freeform/freeform-recognize.service.ts apps/server/src/modules/freeform/freeform-recognize.service.test.ts
git commit -m "feat(freeform): add MinerU recognition service"
```

---

### Task 7: 识别端点 + FreeformModule 注册

**Files:**
- Create: `apps/server/src/modules/freeform/dto/freeform.dto.ts`
- Create: `apps/server/src/modules/freeform/freeform.controller.ts`
- Create: `apps/server/src/modules/freeform/freeform.module.ts`
- Modify: `apps/server/src/app.module.ts`
- Test: `apps/server/src/modules/freeform/freeform.controller.test.ts`

**Interfaces:**
- Produces: `POST /api/freeform/recognize`（student）
- 请求/响应见 spec §5.2。

- [ ] **Step 1: 写失败测试**

```ts
it('recognize 透传 text/fileIds + studentId', async () => {
  const svc = { recognize: vi.fn().mockResolvedValue({ candidates: [], figures: [] }) } as any;
  const c = new FreeformController(svc, svc);
  await c.recognize({ text: '第5题', fileIds: ['1', '2'] }, { sub: 9 } as any);
  expect(svc.recognize).toHaveBeenCalledWith({ text: '第5题', fileIds: ['1', '2'] }, 9);
});

it('fileIds 非数组/超 6 张 → 400/1001', async () => {
  const c = new FreeformController({ recognize: vi.fn() } as any, { judgeStream: vi.fn() } as any);
  await expect(c.recognize({ fileIds: 'x' } as any, { sub: 1 } as any))
    .rejects.toMatchObject({ response: { code: 1001 } });
  await expect(c.recognize({ fileIds: ['1','2','3','4','5','6','7'] }, { sub: 1 } as any))
    .rejects.toMatchObject({ response: { code: 1001 } });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform.controller.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 DTO + controller + module**

```ts
// dto/freeform.dto.ts
export interface FreeformRecognizeDto { text?: string; fileIds?: string[] }
export interface FreeformJudgeDto {
  dialogueId?: string; subjectId: number; maxScore: number; questionId?: number;
  questionContent: string; questionImages?: Array<{ type: 'image'; fileId: string }>;
  figureUrls?: string[]; answer: string; draftFileId?: string;
}
```

```ts
// freeform.controller.ts（先只做 recognize；judge/stream 在 Task 10 加）
import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { FreeformRecognizeService } from './freeform-recognize.service.js';
import { FreeformJudgeService } from './freeform-judge.service.js';
import type { FreeformRecognizeDto } from './dto/freeform.dto.js';

@Controller('api/freeform')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class FreeformController {
  constructor(
    private readonly recognizeService: FreeformRecognizeService,
    private readonly judgeService: FreeformJudgeService,
  ) {}

  @Post('recognize')
  async recognize(@Body() dto: FreeformRecognizeDto, @CurrentUser() user: JwtUser) {
    const fileIds = dto?.fileIds ?? [];
    if (!Array.isArray(fileIds)) throw new BadRequestException({ code: 1001, message: 'fileIds 必须是数组' });
    if (fileIds.length > 6) throw new BadRequestException({ code: 1001, message: '最多 6 张题图' });
    return this.recognizeService.recognize({ text: dto?.text, fileIds }, user.sub);
  }
}
```

```ts
// freeform.module.ts
import { Module } from '@nestjs/common';
import { FreeformController } from './freeform.controller.js';
import { FreeformRecognizeService } from './freeform-recognize.service.js';
import { FreeformJudgeService } from './freeform-judge.service.js';
import { MineruRunner } from './mineru-runner.js';
import { FreeformSplitCapability } from '../../ai-core/capabilities/freeform-split.capability.js';
import { FreeformJudgeCapability } from '../../ai-core/capabilities/freeform-judge.capability.js';
import { UploadedFilesRepository, QuestionsRepository, MainErrorBooksRepository, AiDialoguesRepository, AiMessagesRepository } from '../../database/repositories/index.js';
import { ConversationsModule } from '../conversations/conversations.module.js';

@Module({
  imports: [ConversationsModule],
  controllers: [FreeformController],
  providers: [
    MineruRunner,
    FreeformSplitCapability,
    FreeformJudgeCapability,
    FreeformRecognizeService,
    FreeformJudgeService,
    UploadedFilesRepository,
    QuestionsRepository,
    MainErrorBooksRepository,
    AiDialoguesRepository,
    AiMessagesRepository,
  ],
})
export class FreeformModule {}
```

`app.module.ts` imports 加 `FreeformModule`（放在 PracticeHistoryModule 后）。

> `FreeformJudgeService` 在 Task 9 才存在；本 Task 先建一个空实现（`judgeStream` 抛 `NotImplemented`）以便编译，Task 9 再补全。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform.controller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/freeform/dto/freeform.dto.ts apps/server/src/modules/freeform/freeform.controller.ts apps/server/src/modules/freeform/freeform.module.ts apps/server/src/modules/freeform/freeform.controller.test.ts apps/server/src/app.module.ts
git commit -m "feat(freeform): add recognize endpoint and module"
```

---

### Task 8: freeform 内容哈希 + QuestionsRepository 写入方法

**Files:**
- Modify: `apps/server/src/common/utils/content-hash.util.ts`
- Test: `apps/server/src/common/utils/content-hash.util.spec.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.ts`
- Test: `apps/server/src/database/repositories/questions.repo.test.ts`（若不存在则新建）

**Interfaces:**
- Produces:
  ```ts
  export function stripMarkdownImages(content: string): string
  export function computeFreeformContentHash(content: string): string
  // QuestionsRepository
  createFreeform(row: {
    subject_id: number; type: string; difficulty: number; full_score: number;
    content: string; options: string | null; answer: string;
    approach: string | null; explanation: string | null; source: 'freeform';
    content_hash: string;
  }): Promise<number>
  updateFreeform(id: number, row: {
    type: string; difficulty: number; full_score: number; content: string;
    options: string | null; answer: string; approach: string | null;
    explanation: string | null; content_hash: string;
  }): Promise<void>
  ```

- [ ] **Step 1: 写失败测试（哈希）**

```ts
it('去 Markdown 图片后同题干 hash 相同', () => {
  const a = computeFreeformContentHash('已知 ![图](https://x/a.jpg) 求 x');
  const b = computeFreeformContentHash('已知 ![图](https://x/b.jpg) 求 x');
  expect(a).toBe(b);
});
it('纯文字与原 hash 一致', () => {
  expect(computeFreeformContentHash('x+1=2')).toBe(computeContentHash('x+1=2'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/common/utils/content-hash.util.spec.ts`
Expected: FAIL（`computeFreeformContentHash` 不存在）

- [ ] **Step 3: 实现哈希**

```ts
export function stripMarkdownImages(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<!-- page \d+ -->/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
export function computeFreeformContentHash(content: string): string {
  return computeContentHash(stripMarkdownImages(content));
}
```

- [ ] **Step 4: 写失败测试（repo）**

用 mock pool，断言 SQL 含 `full_score` / `answer_verified`：

```ts
it('createFreeform 写入 full_score 且 answer_verified=0', async () => {
  const pool = { execute: vi.fn().mockResolvedValue([{ insertId: 7 }]) } as any;
  const repo = new QuestionsRepository(pool);
  const id = await repo.createFreeform({ /* ... */ } as any);
  expect(id).toBe(7);
  const [sql, params] = pool.execute.mock.calls[0];
  expect(sql).toContain('full_score');
  expect(sql).toContain('answer_verified');
  expect(params).toContain(10);
});
```

- [ ] **Step 5: 实现 repo 方法**

```ts
async createFreeform(row: {
  subject_id: number; type: string; difficulty: number; full_score: number;
  content: string; options: string | null; answer: string;
  approach: string | null; explanation: string | null; source: 'freeform';
  content_hash: string;
}): Promise<number> {
  const [r] = await this.pool.execute<ResultSetHeader>(
    `INSERT INTO questions
      (subject_id, type, difficulty, full_score, content, options, answer, approach, explanation, source, content_hash, answer_verified, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
    [row.subject_id, row.type, row.difficulty, row.full_score, row.content, row.options,
     row.answer, row.approach, row.explanation, row.source, row.content_hash],
  );
  return r.insertId;
}

async updateFreeform(id: number, row: {
  type: string; difficulty: number; full_score: number; content: string;
  options: string | null; answer: string; approach: string | null;
  explanation: string | null; content_hash: string;
}): Promise<void> {
  await this.pool.execute(
    `UPDATE questions SET type=?, difficulty=?, full_score=?, content=?, options=?,
       answer=?, approach=?, explanation=?, content_hash=? WHERE id=? AND source='freeform'`,
    [row.type, row.difficulty, row.full_score, row.content, row.options,
     row.answer, row.approach, row.explanation, row.content_hash, id],
  );
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/common/utils/content-hash.util.spec.ts src/database/repositories/questions.repo.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/common/utils/content-hash.util.ts apps/server/src/common/utils/content-hash.util.spec.ts apps/server/src/database/repositories/questions.repo.ts apps/server/src/database/repositories/questions.repo.test.ts
git commit -m "feat(freeform): add content hash and question write methods"
```

---

### Task 9: `FreeformJudgeService`（判题 + 落库）

**Files:**
- Create: `apps/server/src/modules/freeform/freeform-judge.service.ts`
- Test: `apps/server/src/modules/freeform/freeform-judge.service.test.ts`

**Interfaces:**
- Consumes: `FreeformJudgeCapability`、`QuestionsRepository`、`MainErrorBooksRepository`、`AiDialoguesRepository`、`AiMessagesRepository`、`UploadedFilesRepository`、`ConversationsService`
- Produces:
  ```ts
  export type FreeformJudgeEvent =
    | { type: 'start'; dialogueId: string; questionId: number | null }
    | { type: 'reasoning'; delta: string }
    | { type: 'content'; delta: string; replace?: boolean }
    | { type: 'result'; questionId: number; totalScore: number; maxScore: number; verdict: 'correct'|'partial'|'incorrect'; errorBookId?: number }
    | { type: 'error'; code: number; message: string; retryable: boolean }
    | { type: 'done' };
  export class FreeformJudgeService {
    judgeStream(dto: FreeformJudgeDto, studentId: number, signal?: AbortSignal): AsyncIterable<FreeformJudgeEvent>;
  }
  ```

- [ ] **Step 1: 写失败测试（核心口径）**

```ts
const baseDto = (over: Partial<FreeformJudgeDto> = {}): FreeformJudgeDto => ({
  subjectId: 1, maxScore: 10, questionContent: '已知 x+1=2', answer: 'x=1', ...over,
});
function REPORT_WITH_JSON(total: number, max: number) {
  const json = {
    verdict: total >= max ? 'correct' : total <= 0 ? 'incorrect' : 'partial',
    totalScore: total, maxScore: max, steps: [], suggestions: [],
    question: { type: 'short_answer', difficulty: 1, options: null, answer: 'x=1', explanation: '移项', approach: null },
  };
  return `## 判题结果\n\n**得分：${total} / ${max}**\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}
// mkDeps 只放服务真正注入的 7 个 dep；服务没有 PointsService/MasteryService/PracticeResultsRepository，
// 「不发分/不写练习/不更新掌握度」是结构性的（根本不注入），不需要 spy。
const mkDeps = (over: any = {}) => ({
  capability: { stream: vi.fn(), extractStructured: vi.fn() },
  questions: {
    findById: vi.fn().mockResolvedValue({ id: 1, source: 'freeform' }),
    findByContentHash: vi.fn().mockResolvedValue(null),
    findByContentPrefix: vi.fn().mockResolvedValue([]),
    createFreeform: vi.fn().mockResolvedValue(11),
    updateFreeform: vi.fn().mockResolvedValue(undefined),
  },
  errorBooks: {
    findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(22),
    updateDialogueId: vi.fn().mockResolvedValue(undefined),
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(1),
  },
  dialogues: { updateQuestionId: vi.fn().mockResolvedValue(undefined) },
  messages: { create: vi.fn().mockResolvedValue(1) },
  files: { findByIdAndOwner: vi.fn(), findByUrlAndOwner: vi.fn() },
  conversations: { get: vi.fn(), create: vi.fn().mockResolvedValue({ id: 33, scene: 'aux_freeform' }) },
  ...over,
});

it('不满分：写题 + 写错题本；不发分/不写 practice', async () => {
  const deps = mkDeps({
    capability: { stream: vi.fn().mockImplementation(async function* () {
      yield { type: 'content', delta: REPORT_WITH_JSON(7, 10) };
    }) },
  });
  const svc = new FreeformJudgeService(deps.capability, deps.questions, deps.errorBooks, deps.dialogues, deps.messages, deps.files, deps.conversations);
  const events = [];
  for await (const e of svc.judgeStream(baseDto(), 9)) events.push(e);

  expect(deps.questions.createFreeform).toHaveBeenCalled();
  expect(deps.errorBooks.findUnclearedByStudentQuestionId).toHaveBeenCalled();
  expect(events.at(-1)).toEqual({ type: 'done' });
});

it('满分：清零、不建错题行', async () => {
  const deps = mkDeps({
    capability: { stream: vi.fn().mockImplementation(async function* () {
      yield { type: 'content', delta: REPORT_WITH_JSON(10, 10) };
    }) },
  });
  const svc = new FreeformJudgeService(deps.capability, deps.questions, deps.errorBooks, deps.dialogues, deps.messages, deps.files, deps.conversations);
  for await (const _ of svc.judgeStream({ ...baseDto(), questionId: 5 }, 9)) { /* consume */ }
  expect(deps.errorBooks.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(9, 5);
  expect(deps.errorBooks.create).not.toHaveBeenCalled();
});

it('JSON 坏：二次提取；仍坏 → error 5502', async () => {
  const deps = mkDeps({
    capability: {
      stream: vi.fn().mockImplementation(async function* () { yield { type: 'content', delta: '没有 json' }; }),
      extractStructured: vi.fn().mockResolvedValue(null),
    },
  });
  const svc = new FreeformJudgeService(deps.capability, deps.questions, deps.errorBooks, deps.dialogues, deps.messages, deps.files, deps.conversations);
  const events = [];
  for await (const e of svc.judgeStream(baseDto(), 9)) events.push(e);
  expect(events.some((e) => e.type === 'error' && e.code === 5502)).toBe(true);
});
```

> `REPORT_WITH_JSON(total, max)` 测试工具：返回一段报告 + 尾部 ```json 块。`mkDeps` 里所有 repo 都是 vi.fn；`capability.extractStructured` 在 Task 3 已实现。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform-judge.service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现流式 + 解析 + 落库**

```ts
import { HttpException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { FreeformJudgeCapability } from '../../ai-core/capabilities/freeform-judge.capability.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { AiDialoguesRepository } from '../../database/repositories/ai-dialogues.repo.js';
import { AiMessagesRepository } from '../../database/repositories/ai-messages.repo.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { computeFreeformContentHash } from '../../common/utils/content-hash.util.js';
import { subjectCodeOf } from '../../common/subject-config.js';
import type { FreeformJudgeDto } from './dto/freeform.dto.js';

const JsonSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  totalScore: z.number(),
  maxScore: z.number(),
  steps: z.array(z.object({
    stepNumber: z.number().int(), description: z.string(), score: z.number(),
    maxScore: z.number(), isCorrect: z.boolean(), comment: z.string(),
    errorType: z.enum(['logic', 'calculation', 'format', 'missing']).nullable().optional(),
  })).default([]),
  suggestions: z.array(z.string()).default([]),
  question: z.object({
    type: z.enum(['choice','multi_choice','fill_blank','true_false','short_answer','proof','calculation']),
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    options: z.array(z.object({ label: z.string(), text: z.string(), isCorrect: z.boolean() })).nullable().default(null),
    answer: z.string().min(1),
    explanation: z.string().nullable().default(null),
    approach: z.string().nullable().default(null),
  }),
});

@Injectable()
export class FreeformJudgeService {
  private readonly logger = new Logger(FreeformJudgeService.name);
  constructor(
    private readonly capability: FreeformJudgeCapability,
    private readonly questions: QuestionsRepository,
    private readonly errorBooks: MainErrorBooksRepository,
    private readonly dialogues: AiDialoguesRepository,
    private readonly messages: AiMessagesRepository,
    private readonly files: UploadedFilesRepository,
    private readonly conversations: ConversationsService,
  ) {}

  async *judgeStream(dto: FreeformJudgeDto, studentId: number, signal?: AbortSignal): AsyncIterable<FreeformJudgeEvent> {
    // 1) 校验（controller 也会做一层；service 是最后一道）
    const subjectId = Number(dto.subjectId);
    const maxScore = Number(dto.maxScore);
    if (![1, 4, 5].includes(subjectId)) throw new HttpException({ code: 1001, message: '学科仅支持数学/物理/化学' }, 400);
    if (!Number.isInteger(maxScore) || maxScore < 1 || maxScore > 100) throw new HttpException({ code: 1001, message: '满分必须为 1–100 的整数' }, 400);
    const answer = (dto.answer ?? '').trim();
    if (!answer && !dto.draftFileId) throw new HttpException({ code: 1001, message: '请先写答案或在草稿上作答' }, 400);
    if (!dto.questionContent || dto.questionContent.length > 30000) {
      throw new HttpException({ code: 1001, message: '题干不能为空且不超过 30000 字' }, 400);
    }
    if (dto.questionId != null) {
      const q = await this.questions.findById(dto.questionId);
      if (!q) throw new HttpException({ code: 1001, message: '题目不存在' }, 400);
    }

    // 2) 对话
    let dialogueId: string;
    if (dto.dialogueId) {
      const dlg = await this.conversations.get(Number(dto.dialogueId), studentId);
      if (dlg.scene !== 'aux_freeform') throw new HttpException({ code: 1001, message: '对话场景不匹配' }, 400);
      dialogueId = String(dlg.id);
    } else {
      const dlg = await this.conversations.create(studentId, {
        track: 'auxiliary', scene: 'aux_freeform', subjectId,
        questionText: dto.questionContent.slice(0, 4000),
      });
      dialogueId = String(dlg!.id);
    }

    // 3) 图片 data URL
    const images = await this.resolveImages(dto, studentId);
    const questionId0 = dto.questionId ?? null;
    yield { type: 'start', dialogueId, questionId: questionId0 };

    // 4) 流式模型
    let content = '';
    let reasoning = '';
    for await (const e of this.capability.stream({
      subject: subjectCodeOf(subjectId) as any,
      maxScore,
      questionContent: dto.questionContent,
      studentAnswer: answer,
      images,
    }, signal)) {
      if (e.type === 'reasoning') { reasoning += e.delta; yield e; }
      else { content += e.delta; yield e; }
    }

    // 5) 提取 JSON
    const parsed = await this.extractResult(content, dto, subjectId, maxScore);
    if (!parsed) {
      yield { type: 'error', code: 5502, message: '判题结果解析失败，请重试', retryable: true };
      return;
    }
    const cleaned = content.replace(/```json[\s\S]*?```\s*$/i, '').trim();
    yield { type: 'content', delta: cleaned || content, replace: true };

    // 6) 落库
    try {
      const { questionId, errorBookId } = await this.persist(dto, studentId, subjectId, maxScore, parsed, dialogueId);
      await this.persistMessages(dialogueId, dto, answer, cleaned, reasoning, images).catch((err) => this.logger.warn(`persistMessages failed: ${err}`));
      yield { type: 'result', questionId, totalScore: parsed.totalScore, maxScore, verdict: parsed.verdict, errorBookId };
      yield { type: 'done' };
    } catch (err) {
      this.logger.error(`freeform persist failed: ${err instanceof Error ? err.stack : err}`);
      yield { type: 'error', code: 5000, message: '判题完成但入库失败，请重试', retryable: true };
    }
  }

  private async extractResult(content: string, dto: FreeformJudgeDto, subjectId: number, maxScore: number) {
    const m = content.match(/```json\s*([\s\S]*?)```/gi);
    const raw = m?.[m.length - 1]?.replace(/```json\s*|```/gi, '') ?? '';
    let parsed = raw ? JsonSchema.safeParse(safeJson(raw)) : { success: false as const };
    if (!parsed.success) {
      const second = await this.capability.extractStructured({
        report: content, questionContent: dto.questionContent, studentAnswer: dto.answer, maxScore,
      }).catch(() => null);
      parsed = second ? JsonSchema.safeParse(second) : { success: false as const };
    }
    if (!parsed.success) return null;
    const total = Math.max(0, Math.min(maxScore, parsed.data.totalScore));
    const verdict = total >= maxScore ? 'correct' : total <= 0 ? 'incorrect' : 'partial';
    return { ...parsed.data, totalScore: total, maxScore, verdict };
  }

  private async persist(dto, studentId, subjectId, maxScore, parsed, dialogueId) {
    const hash = computeFreeformContentHash(dto.questionContent || parsed.question.content);
    let questionId = dto.questionId ?? null;
    const existing = questionId ? null : (await this.questions.findByContentHash(hash)) ?? (await this.questions.findByContentPrefix(dto.questionContent))[0] ?? null;
    if (!questionId && existing) questionId = existing.id;
    if (!questionId) {
      questionId = await this.questions.createFreeform({
        subject_id: subjectId,
        type: parsed.question.type,
        difficulty: parsed.question.difficulty,
        full_score: maxScore,
        content: dto.questionContent || parsed.question.content,
        options: parsed.question.options ? JSON.stringify(parsed.question.options) : null,
        answer: parsed.question.answer,
        approach: parsed.question.approach,
        explanation: parsed.question.explanation,
        source: 'freeform',
        content_hash: hash,
      });
    } else if (!existing) {
      await this.questions.updateFreeform(questionId, {
        type: parsed.question.type, difficulty: parsed.question.difficulty, full_score: maxScore,
        content: dto.questionContent || parsed.question.content,
        options: parsed.question.options ? JSON.stringify(parsed.question.options) : null,
        answer: parsed.question.answer, approach: parsed.question.approach,
        explanation: parsed.question.explanation, content_hash: hash,
      }).catch((err) => this.logger.warn(`updateFreeform failed: ${err}`));
    }

    let errorBookId: number | undefined;
    if (parsed.totalScore < maxScore) {
      const row = await this.errorBooks.findUnclearedByStudentQuestionId(studentId, questionId);
      if (row) errorBookId = row.id;
      else {
        errorBookId = await this.errorBooks.create({
          student_id: studentId, subject_id: subjectId, question_id: questionId,
          source: 'freeform', source_ref_id: null, question_n: null,
          lesson_id: null, wrong_answer_text: null,
        });
        await this.errorBooks.updateDialogueId(errorBookId, Number(dialogueId)).catch(() => {});
      }
    } else {
      await this.errorBooks.clearUnclearedByStudentQuestionId(studentId, questionId).catch(() => {});
    }
    await this.dialogues.updateQuestionId(Number(dialogueId), questionId).catch(() => {});
    return { questionId, errorBookId };
  }

  private async resolveImages(dto: FreeformJudgeDto, studentId: number) {
    const uploadDir = process.env.UPLOAD_DIR ?? './uploads';
    const out: Array<{ label: string; url: string; dataUrl: string }> = [];
    const pushFile = async (fileId: string, label: string) => {
      const row = await this.files.findByIdAndOwner(Number(fileId), studentId);
      if (!row) throw new HttpException({ code: 1001, message: '文件不存在或无权访问' }, 400);
      if (!row.mime_type.startsWith('image/')) throw new HttpException({ code: 1001, message: '附件必须是图片' }, 400);
      const buf = await fs.readFile(path.join(uploadDir, row.url.replace(/^\/uploads\//, '')));
      out.push({ label, url: row.url, dataUrl: `data:${row.mime_type};base64,${buf.toString('base64')}` });
    };
    for (const [i, a] of (dto.questionImages ?? []).slice(0, 6).entries()) await pushFile(a.fileId, `原题图${i + 1}`);
    for (const [i, url] of (dto.figureUrls ?? []).slice(0, 6).entries()) {
      const row = await this.files.findByUrlAndOwner(url, studentId);
      if (!row) continue;
      const buf = await fs.readFile(path.join(uploadDir, row.url.replace(/^\/uploads\//, '')));
      out.push({ label: `配图${i + 1}`, url, dataUrl: `data:${row.mime_type};base64,${buf.toString('base64')}` });
    }
    if (dto.draftFileId) await pushFile(dto.draftFileId, '学生草稿');
    const answerImgs = [...(dto.answer ?? '').matchAll(/!\[[^\]]*\]\((\/uploads\/[^)]+)\)/g)].map((m) => m[1]).slice(0, 6);
    for (const [i, url] of answerImgs.entries()) {
      const row = await this.files.findByUrlAndOwner(url, studentId);
      if (!row) continue;
      const buf = await fs.readFile(path.join(uploadDir, row.url.replace(/^\/uploads\//, '')));
      out.push({ label: `作答图${i + 1}`, url, dataUrl: `data:${row.mime_type};base64,${buf.toString('base64')}` });
    }
    return out;
  }

  private async persistMessages(
    dialogueId: string, dto: FreeformJudgeDto, answer: string,
    report: string, reasoning: string, images: Array<{ url: string }>,
  ) {
    const base = {
      dialogue_id: Number(dialogueId),
      reasoning: null as string | null,
      attachments: null as string | null,
      model: null as string | null,
      token_input: null as number | null,
      token_output: null as number | null,
      response_time_ms: null as number | null,
      safety_flag: 0,
    };
    await this.messages.create({
      ...base, role: 'user',
      content: `题目：\n${dto.questionContent}\n\n我的作答：\n${answer}`,
      type: 'freeform_submit',
      attachments: JSON.stringify(images.map((i) => ({ type: 'image', url: i.url }))),
    });
    await this.messages.create({
      ...base, role: 'assistant', content: report, reasoning,
      type: 'freeform_judge', model: 'qwen3.8-max',
    });
  }
}
```

> `resolveImages` 解析：原题图（≤6）→ 勾选配图（≤6，按 URL 查归属）→ 草稿（1）→ 作答 Markdown 内嵌图（≤6）；每个都读文件转 data URL。`persistMessages` 写 user + assistant 两条；失败只 warn（调用点 catch）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform-judge.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/freeform/freeform-judge.service.ts apps/server/src/modules/freeform/freeform-judge.service.test.ts apps/server/src/ai-core/capabilities/freeform-judge.capability.ts
git commit -m "feat(freeform): add judge stream service with question and error-book persistence"
```

---

### Task 10: SSE 判题端点

**Files:**
- Modify: `apps/server/src/modules/freeform/freeform.controller.ts`
- Modify: `apps/server/src/modules/freeform/dto/freeform.dto.ts`（已定义）
- Test: `apps/server/src/modules/freeform/freeform.controller.test.ts`

**Interfaces:**
- Produces: `POST /api/freeform/judge/stream`（SSE；事件见 spec §5.3）。

- [ ] **Step 1: 写失败测试**

```ts
it('judge/stream 设置 SSE 头并写完 done', async () => {
  const svc = {
    judgeStream: vi.fn().mockImplementation(async function* () {
      yield { type: 'start', dialogueId: '1', questionId: null };
      yield { type: 'done' };
    }),
  } as any;
  const c = new FreeformController({} as any, svc);
  const res = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() } as any;
  await c.judgeStream(baseDto(), { sub: 9 } as any, res);
  expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
  expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"type":"start"'));
  expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"type":"done"'));
  expect(res.end).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform.controller.test.ts`
Expected: FAIL（`judgeStream` 不存在）

- [ ] **Step 3: 实现 controller 方法**

```ts
@Post('judge/stream')
async judgeStream(
  @Body() dto: FreeformJudgeDto,
  @CurrentUser() user: JwtUser,
  @Res() res: Response,
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const abort = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) abort.abort(); });
  try {
    for await (const event of this.judgeService.judgeStream(dto, user.sub, abort.signal)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    const payload = err instanceof HttpException ? err.getResponse() as any : { code: 5000, message: 'AI 服务异常', retryable: true };
    res.write(`data: ${JSON.stringify({ type: 'error', code: payload?.code ?? 5000, message: payload?.message ?? 'AI 服务异常', retryable: payload?.retryable === true })}\n\n`);
  } finally {
    finished = true;
    res.end();
  }
}
```

导入 `HttpException`, `Res`, `Response`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform.controller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/freeform/freeform.controller.ts apps/server/src/modules/freeform/freeform.controller.test.ts
git commit -m "feat(freeform): add judge SSE endpoint"
```

---

### Task 11: 答疑会话 `aux_freeform` 场景

**Files:**
- Modify: `apps/server/src/database/repositories/types.ts`
- Modify: `apps/server/src/modules/conversations/conversations.service.ts`
- Modify: `apps/server/src/modules/conversations/conversations.controller.ts`
- Test: `apps/server/src/modules/conversations/conversations.service.test.ts`

**Interfaces:**
- Produces: `AiDialogueScene` 增加 `'aux_freeform'`；`POST /api/conversations` 接受 `scene='aux_freeform'`。

- [ ] **Step 1: 写失败测试**

```ts
it('aux_freeform 可创建', async () => {
  const svc = mk();
  const d = await svc.create(1, { track: 'auxiliary', scene: 'aux_freeform', subjectId: 1 });
  expect(d.scene).toBe('aux_freeform');
});
it('scene 与 track 不匹配仍拒绝', async () => {
  const svc = mk();
  await expect(svc.create(1, { track: 'mainline', scene: 'aux_freeform' })).rejects.toThrow(/不匹配/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/conversations/conversations.service.test.ts`
Expected: FAIL（类型/白名单不含 `aux_freeform`）

- [ ] **Step 3: 实现**

`types.ts`：

```ts
export type AiDialogueScene = 'aux_qna' | 'aux_training' | 'aux_freeform' | 'mainline_question' | 'mainline_card';
```

`conversations.service.ts`：

```ts
auxiliary: ['aux_qna', 'aux_training', 'aux_freeform'],
```

`conversations.controller.ts` 的 `scene as ...` 联合类型补 `'aux_freeform'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/conversations/conversations.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/types.ts apps/server/src/modules/conversations/conversations.service.ts apps/server/src/modules/conversations/conversations.controller.ts apps/server/src/modules/conversations/conversations.service.test.ts
git commit -m "feat(conversations): add aux_freeform scene"
```

---

### Task 12: freeform 题排除出错题练习池（后端）

**Files:**
- Modify: `apps/server/src/database/repositories/main-error-books.repo.ts`
- Modify: `apps/server/src/modules/training/training.service.ts`
- Modify: `apps/server/src/modules/training/dto/error-book-query.dto.ts`
- Test: `apps/server/src/modules/training/training.service.test.ts`

**Interfaces:**
- Produces: `ErrorBookEntryDto` 增加 `source: string | null`；前端据此把 `source='freeform'` 的条目显示但不可勾选。
- `findErrorBookEntries` SELECT `meb.source`。

- [ ] **Step 1: 写失败测试**

```ts
it('getErrorBookEntries 透传 source', async () => {
  const deps = mk({ mainErrorRepo: { findErrorBookEntries: vi.fn().mockResolvedValue([
    { id: 1, question_id: 2, questionText: '题', type: 'short_answer', level: 1, created_at: new Date(), kp_id: null, options: null, source: 'freeform' },
  ]) } });
  const r = await mkSvc(deps).getErrorBookEntries(1, 1, {});
  expect(r[0].source).toBe('freeform');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: FAIL（`source` 不在返回类型）

- [ ] **Step 3: 实现**

`main-error-books.repo.ts` 的 `findErrorBookEntries` SELECT 增加 `meb.source`，返回类型加 `source: string | null`。

`training.service.ts` 的 `ErrorBookEntryDto` 加 `source: string | null`，映射时带上。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/main-error-books.repo.ts apps/server/src/modules/training/training.service.ts apps/server/src/modules/training/dto/error-book-query.dto.ts apps/server/src/modules/training/training.service.test.ts
git commit -m "feat(training): expose error-book source for freeform filtering"
```

---

### Task 13: 前端 API 类型、识别调用与判题 SSE

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Create: `apps/web/src/services/api.freeform.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FreeformCandidate {
    id: string; no: string; content: string; figureUrls: string[];
    suggestedSubject: 'math'|'physics'|'chemistry'|null; confidence: number;
  }
  export interface FreeformFigure { url: string; name: string; page: number }
  export interface FreeformRecognizeResult { candidates: FreeformCandidate[]; figures: FreeformFigure[] }
  export function recognizeFreeform(body: { text?: string; attachments: AttachmentRequest[] }): Promise<FreeformRecognizeResult>
  export type FreeformJudgeEvent = ...
  export function streamFreeformJudge(body: FreeformJudgeBody, signal?: AbortSignal): AsyncIterable<FreeformJudgeEvent>
  ```
- `AiConversationScene` 增加 `'aux_freeform'`。
- `uploadFile(file, signal?, source?: 'auxiliary'|'freeform')`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { recognizeFreeform, streamFreeformJudge } from './api';

afterEach(() => vi.restoreAllMocks());

it('recognizeFreeform 走 /api/freeform/recognize', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, json: async () => ({ code: 0, data: { candidates: [], figures: [] } }),
  } as any);
  await recognizeFreeform({ text: '题', attachments: [] });
  expect(fetchMock).toHaveBeenCalledWith('/api/freeform/recognize', expect.objectContaining({ method: 'POST' }));
});

it('streamFreeformJudge 解析 reasoning/content/result', async () => {
  const body = [
    'data: {"type":"start","dialogueId":"1","questionId":null}\n\n',
    'data: {"type":"reasoning","delta":"想"}\n\n',
    'data: {"type":"result","questionId":7,"totalScore":7,"maxScore":10,"verdict":"partial"}\n\n',
    'data: {"type":"done"}\n\n',
  ].join('');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    body: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
    }),
  } as any);
  const events = [];
  for await (const e of streamFreeformJudge({} as any)) events.push(e);
  expect(events.map((e) => e.type)).toEqual(['start', 'reasoning', 'result', 'done']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/services/api.freeform.test.ts`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**

在 `api.ts` 加类型与函数（SSE 解析沿用 `streamExtraction` 的 buffer 逻辑）：

```ts
export type AiConversationScene = 'aux_qna' | 'aux_training' | 'aux_freeform' | 'mainline_question' | 'mainline_card';

export interface FreeformCandidate {
  id: string; no: string; content: string; figureUrls: string[];
  suggestedSubject: 'math' | 'physics' | 'chemistry' | null; confidence: number;
}
export interface FreeformFigure { url: string; name: string; page: number }
export interface FreeformRecognizeResult { candidates: FreeformCandidate[]; figures: FreeformFigure[] }

export function recognizeFreeform(body: { text?: string; attachments: AttachmentRequest[] }): Promise<FreeformRecognizeResult> {
  return fetchApi<FreeformRecognizeResult>('/freeform/recognize', {
    method: 'POST',
    body: JSON.stringify({ text: body.text, fileIds: body.attachments.map((a) => a.fileId) }),
  });
}

export type FreeformJudgeEvent =
  | { type: 'start'; dialogueId: string; questionId: number | null }
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string; replace?: boolean }
  | { type: 'result'; questionId: number; totalScore: number; maxScore: number; verdict: 'correct'|'partial'|'incorrect'; errorBookId?: number }
  | { type: 'error'; code: number; message: string; retryable: boolean }
  | { type: 'done' };

export interface FreeformJudgeBody {
  dialogueId?: string; subjectId: number; maxScore: number; questionId?: number;
  questionContent: string; questionImages?: AttachmentRequest[];
  figureUrls?: string[]; answer: string; draftFileId?: string;
}

export async function* streamFreeformJudge(body: FreeformJudgeBody, signal?: AbortSignal): AsyncIterable<FreeformJudgeEvent> {
  const token = getAuthToken() ?? '';
  const res = await fetch(`${API_BASE}/freeform/judge/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error('freeform judge stream unavailable');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      try { yield JSON.parse(t.slice(6)); } catch { /* skip */ }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().startsWith('data: ')) {
    try { yield JSON.parse(buffer.trim().slice(6)); } catch { /* skip */ }
  }
}
```

`uploadFile` 增加 `source` 参数并拼 query：

```ts
export async function uploadFile(file: File, signal?: AbortSignal, source?: 'auxiliary' | 'freeform'): Promise<UploadedFileResult> {
  const qs = source ? `?source=${source}` : '';
  // fetch(`${API_BASE}/files/upload${qs}`, ...)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/services/api.freeform.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/services/api.freeform.test.ts
git commit -m "feat(web): add freeform API and judge SSE client"
```

---

### Task 14: 草稿渲染抽离 + `DraftWhiteboard` 快照导出

**Files:**
- Create: `apps/web/src/components/business/draft-render.ts`
- Test: `apps/web/src/components/business/draft-render.test.ts`
- Modify: `apps/web/src/components/business/DraftWhiteboard.tsx`
- Test: `apps/web/src/components/business/DraftWhiteboard.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]): void
  export function renderDraftSnapshot(opts: {
    strokes: Stroke[]; images: DraftImage[]; width: number; height: number;
    maxEdge?: number;
  }): Promise<string | null>
  ```
- `DraftWhiteboard` 新增 prop `snapshotRef?: React.MutableRefObject<(() => Promise<string | null>) | null>`。

- [ ] **Step 1: 写失败测试（纯函数）**

```ts
it('drawStrokes 画单点/多点为路径', () => {
  const ops: string[] = [];
  const ctx = {
    beginPath: vi.fn(() => ops.push('begin')), arc: vi.fn(() => ops.push('arc')),
    moveTo: vi.fn(() => ops.push('move')), quadraticCurveTo: vi.fn(() => ops.push('quad')),
    lineTo: vi.fn(() => ops.push('line')), stroke: vi.fn(() => ops.push('stroke')),
    fill: vi.fn(() => ops.push('fill')), set lineCap(_v: string) {},
    set lineJoin(_v: string) {}, lineWidth: 0, fillStyle: '',
  } as any;
  drawStrokes(ctx, [{ points: [{ x: 1, y: 2, pressure: 1 }], size: 10 }]);
  expect(ops).toEqual(['begin', 'arc', 'fill']);
  ops.length = 0;
  drawStrokes(ctx, [{ points: [{ x: 0, y: 0, pressure: 1 }, { x: 1, y: 1, pressure: 1 }], size: 2 }]);
  expect(ops).toContain('stroke');
});

it('空内容返回 null', async () => {
  expect(await renderDraftSnapshot({ strokes: [], images: [], width: 100, height: 100 })).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/draft-render.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `draft-render.ts`**

把 `DraftWhiteboard` 里的 `strokePath` 原样迁到 `draft-render.ts` 并改名 `drawStroke`，`drawStrokes` 循环调用；`renderDraftSnapshot`：

```ts
export async function renderDraftSnapshot(opts: {
  strokes: Stroke[]; images: DraftImage[]; width: number; height: number;
  maxEdge?: number; quality?: number;
}): Promise<string | null> {
  if (opts.strokes.length === 0 && opts.images.length === 0) return null;
  const maxEdge = opts.maxEdge ?? 1600;
  const scale = Math.min(1, maxEdge / Math.max(opts.width, opts.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(opts.width * scale));
  canvas.height = Math.max(1, Math.round(opts.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  drawStrokes(ctx, opts.strokes);
  for (const img of opts.images) {
    const el = await new Promise<HTMLImageElement | null>((resolve) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => resolve(null);
      i.src = img.src;
    });
    if (el) ctx.drawImage(el, img.x, img.y, img.w, img.h);
  }
  return canvas.toDataURL('image/jpeg', opts.quality ?? 0.85);
}
```

`DraftWhiteboard` 的 `redraw` 改为调用 `drawStrokes`（行为不变）；新增 `snapshotRef` prop：

```ts
useEffect(() => {
  if (!snapshotRef) return;
  snapshotRef.current = async () => {
    const board = boardRef.current;
    if (!board) return null;
    const first = await renderDraftSnapshot({
      strokes: strokesRef.current,
      images: imagesRef.current,
      width: board.clientWidth,
      height: board.clientHeight,
    });
    if (!first) return null;
    // data URL 字符串长度约等于字节数；超过 5MB 降质量重试一次
    if (first.length > 5 * 1024 * 1024) {
      return renderDraftSnapshot({
        strokes: strokesRef.current, images: imagesRef.current,
        width: board.clientWidth, height: board.clientHeight, quality: 0.7,
      });
    }
    return first;
  };
  return () => { if (snapshotRef) snapshotRef.current = null; };
}, [snapshotRef]);
```

> 降质量重试需要让 `renderDraftSnapshot` 接受 `quality` 参数；实现时加 `quality?: number`（默认 0.85），第二次传 0.7。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/draft-render.test.ts src/components/business/DraftWhiteboard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/draft-render.ts apps/web/src/components/business/draft-render.test.ts apps/web/src/components/business/DraftWhiteboard.tsx apps/web/src/components/business/DraftWhiteboard.test.tsx
git commit -m "feat(draft): add draft snapshot export"
```

---

### Task 15: 答疑面板支持 Markdown 用户消息

**Files:**
- Modify: `apps/web/src/store/chatStore.ts`
- Modify: `apps/web/src/components/business/AuxChatPanel.tsx`
- Test: `apps/web/src/components/business/AuxChatPanel.test.tsx`

**Interfaces:**
- Produces: `ChatMessage.markdown?: boolean`；当为 true 时，用户气泡内用白底卡片渲染 Markdown+LaTeX。

- [ ] **Step 1: 写失败测试**

```ts
it('markdown=true 的用户消息按 Markdown 渲染', () => {
  useChatStore.setState({ messages: [
    { role: 'user', content: '答案是 $x=1$', markdown: true },
  ], isStreaming: false });
  const { container } = render(<AuxChatPanel />);
  expect(container.querySelector('.katex')).toBeTruthy();
});
it('默认用户消息仍是纯文本', () => {
  useChatStore.setState({ messages: [{ role: 'user', content: '$x=1$' }], isStreaming: false });
  const { container } = render(<AuxChatPanel />);
  expect(container.querySelector('.katex')).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/AuxChatPanel.test.tsx`
Expected: FAIL（`markdown` 未定义/未渲染）

- [ ] **Step 3: 实现**

`chatStore.ts` 的 `ChatMessage` 加 `markdown?: boolean`。

`AuxChatPanel.tsx` 用户消息渲染：

```tsx
const contentEl = isError ? (...) : m.role === 'assistant' ? (...) : m.markdown ? (
  <div className="rounded-lg bg-white text-[#1D1D1F] p-2">
    <Markdown>{m.content}</Markdown>
  </div>
) : m.content;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/AuxChatPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/store/chatStore.ts apps/web/src/components/business/AuxChatPanel.tsx apps/web/src/components/business/AuxChatPanel.test.tsx
git commit -m "feat(chat): render freeform user answers as markdown"
```

---

### Task 16: `SolveSourceInput`（文字 + 多图录入）

**Files:**
- Create: `apps/web/src/pages/student/solve/types.ts`
- Create: `apps/web/src/pages/student/solve/SolveSourceInput.tsx`
- Test: `apps/web/src/pages/student/solve/SolveSourceInput.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface SourceImage {
    localId: string; fileName: string; previewUrl: string;
    status: 'converting' | 'uploading' | 'ready' | 'error';
    fileId?: string; url?: string; error?: string;
  }
  export function SolveSourceInput(props: {
    busy: boolean;
    error?: string | null;
    onRetry?: () => void;
    onManual?: () => void;
    onRecognize: (input: { text: string; attachments: AttachmentRequest[]; imageUrls: string[] }) => void;
  }): JSX.Element
  ```

- [ ] **Step 1: 写失败测试**

```tsx
vi.mock('@/utils/image-convert', () => ({ ensureJpeg: vi.fn(async (f: File) => new File([f], f.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' })) }));
vi.mock('@/services/api', async (orig) => ({ ...(await orig<any>()), uploadFile: vi.fn(async () => ({ fileId: 1, url: '/uploads/a.jpg' })) }));

it('HEIC 转 JPEG 后上传，最多 6 张', async () => {
  const onRecognize = vi.fn();
  render(<SolveSourceInput busy={false} onRecognize={onRecognize} />);
  const input = screen.getByTestId('source-file-input') as HTMLInputElement;
  const files = Array.from({ length: 7 }, (_, i) => new File(['x'], `p${i}.heic`, { type: 'image/heic' }));
  fireEvent.change(input, { target: { files } });
  await waitFor(() => expect(screen.getAllByTestId('source-thumb')).toHaveLength(6));
  fireEvent.click(screen.getByRole('button', { name: '开始识题' }));
  await waitFor(() => expect(onRecognize).toHaveBeenCalled());
  expect(onRecognize.mock.calls[0][0].attachments).toHaveLength(6);
});

it('文字非空也可提交', () => {
  const onRecognize = vi.fn();
  render(<SolveSourceInput busy={false} onRecognize={onRecognize} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '第5题' } });
  fireEvent.click(screen.getByRole('button', { name: '开始识题' }));
  expect(onRecognize).toHaveBeenCalledWith(expect.objectContaining({ text: '第5题', attachments: [] }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/solve/SolveSourceInput.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```tsx
import { useRef, useState } from 'react';
import { uploadFile, type AttachmentRequest } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';
import { toast } from '@/components/base/Toast';
import type { SourceImage } from './types';

const MAX = 6;
const MAX_BYTES = 5 * 1024 * 1024;

export function SolveSourceInput({ busy, error, onRetry, onManual, onRecognize }: {
  busy: boolean; error?: string | null; onRetry?: () => void; onManual?: () => void;
  onRecognize: (input: { text: string; attachments: AttachmentRequest[]; imageUrls: string[] }) => void;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<SourceImage[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const addFiles = async (files: File[]) => {
    const room = MAX - images.length;
    if (room <= 0) { toast('error', '最多 6 张题图'); return; }
    const picked = files.filter((f) => f.type.startsWith('image/')).slice(0, room);
    if (picked.length < files.filter((f) => f.type.startsWith('image/')).length) toast('error', '最多 6 张题图');
    for (const file of picked) {
      if (file.size > MAX_BYTES) { toast('error', '图片过大（最大 5MB）'); continue; }
      const localId = crypto.randomUUID?.() ?? `img-${Date.now()}-${Math.random()}`;
      const previewUrl = URL.createObjectURL(file);
      setImages((prev) => [...prev, { localId, fileName: file.name, previewUrl, status: 'converting' }]);
      try {
        const jpeg = await ensureJpeg(file);
        setImages((prev) => prev.map((x) => x.localId === localId ? { ...x, status: 'uploading', fileName: jpeg.name } : x));
        const { fileId, url } = await uploadFile(jpeg, undefined, 'freeform');
        setImages((prev) => prev.map((x) => x.localId === localId ? { ...x, status: 'ready', fileId: String(fileId), url } : x));
      } catch {
        setImages((prev) => prev.map((x) => x.localId === localId ? { ...x, status: 'error', error: '上传失败' } : x));
      }
    }
  };

  const remove = (id: string) => setImages((prev) => prev.filter((x) => x.localId !== id));
  const ready = images.every((x) => x.status === 'ready');
  const canSend = !busy && ready && (text.trim().length > 0 || images.length > 0);

  const submit = () => {
    if (!canSend) return;
    onRecognize({
      text: text.trim(),
      attachments: images.map((x) => ({ type: 'image' as const, fileId: x.fileId! })),
      imageUrls: images.map((x) => x.url!).filter(Boolean),
    });
  };

  return (
    <div className="w-full max-w-2xl">
      <div
        className={`rounded-xl bg-[#F9F9FB] border ${dragging ? 'ring-2 ring-[#FF6B00]' : 'border-[#E5E5E5]'} p-3`}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void addFiles(Array.from(e.dataTransfer.files)); }}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, i) => (
              <div key={img.localId} data-testid="source-thumb" className="relative w-16 h-16 rounded-lg overflow-hidden border border-[#E5E5E5]">
                <img src={img.previewUrl} alt="" className="w-full h-full object-cover" />
                <span className="absolute left-0.5 top-0.5 px-1 rounded bg-black/60 text-white text-[10px]">{i + 1}</span>
                <button type="button" onClick={() => remove(img.localId)} aria-label="移除图片"
                  className="absolute right-0.5 top-0.5 w-4 h-4 rounded-full bg-black/60 text-white text-[10px]">×</button>
                {img.status !== 'ready' && (
                  <span className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] text-center">
                    {img.status === 'error' ? '失败' : '处理中'}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <textarea
          rows={3} value={text} onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.items).filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean) as File[];
            if (files.length) { e.preventDefault(); void addFiles(files); }
          }}
          placeholder="输入题目文字，或拖入/粘贴题目图片（HEIC、JPG、PNG）"
          className="w-full bg-transparent outline-none resize-none text-[#1D1D1F] placeholder-[#86868B]"
        />
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => inputRef.current?.click()} aria-label="添加图片"
            className="w-7 h-7 rounded-full border border-[#E5E5E5] text-[#86868B]">+</button>
          <input ref={inputRef} data-testid="source-file-input" type="file" multiple accept="image/png,image/jpeg,image/heic,.heic" className="hidden"
            onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <button type="button" onClick={submit} disabled={!canSend}
            className="px-4 h-9 rounded-lg bg-[#FF6B00] text-white text-sm disabled:opacity-50">
            {busy ? '识别中…' : '开始识题'}
          </button>
        </div>
      </div>
      {error && (
        <div className="mt-3 text-sm text-[#C44A3F]">
          {error}
          <button onClick={onRetry} className="ml-2 underline">重试</button>
          <button onClick={onManual} className="ml-2 underline">手动输入题目</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/solve/SolveSourceInput.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/solve/types.ts apps/web/src/pages/student/solve/SolveSourceInput.tsx apps/web/src/pages/student/solve/SolveSourceInput.test.tsx
git commit -m "feat(solve): add multi-image source input"
```

---

### Task 17: `SolveCandidatePicker`（选题 + 配图多选 + 学科/满分）

**Files:**
- Create: `apps/web/src/pages/student/solve/SolveCandidatePicker.tsx`
- Test: `apps/web/src/pages/student/solve/SolveCandidatePicker.test.tsx`

**Interfaces:**
- Consumes: `FreeformCandidate`, `FreeformFigure`
- Produces:
  ```ts
  export function SolveCandidatePicker(props: {
    candidates: FreeformCandidate[];
    figures: FreeformFigure[];
    onBack: () => void;
    onConfirm: (input: {
      content: string; figureUrls: string[]; subjectId: number; maxScore: number;
    }) => void;
  }): JSX.Element
  ```

- [ ] **Step 1: 写失败测试**

```tsx
const CANDIDATES = [
  { id: 'c1', no: '5', content: '题干一 ![a](/uploads/freeform/a.jpg)', figureUrls: ['/uploads/freeform/a.jpg'], suggestedSubject: 'math', confidence: 0.9 },
  { id: 'c2', no: '6', content: '题干二', figureUrls: [], suggestedSubject: 'physics', confidence: 0.8 },
];
const FIGURES = [{ url: '/uploads/freeform/a.jpg', name: 'a.jpg', page: 1 }, { url: '/uploads/freeform/b.jpg', name: 'b.jpg', page: 1 }];

it('默认选第一题、配图预选；可多选配图', () => {
  const onConfirm = vi.fn();
  render(<SolveCandidatePicker candidates={CANDIDATES} figures={FIGURES} onBack={() => {}} onConfirm={onConfirm} />);
  expect(screen.getByText('第 5 题')).toBeTruthy();
  const checks = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect(checks.filter((c) => c.checked).length).toBe(1);
  fireEvent.click(screen.getByLabelText('b.jpg'));
  fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
  expect(onConfirm.mock.calls[0][0].figureUrls).toEqual(['/uploads/freeform/a.jpg', '/uploads/freeform/b.jpg']);
});

it('切到第二题，学科跟随预选', () => {
  const onConfirm = vi.fn();
  render(<SolveCandidatePicker candidates={CANDIDATES} figures={FIGURES} onBack={() => {}} onConfirm={onConfirm} />);
  fireEvent.click(screen.getByText('第 6 题'));
  fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
  expect(onConfirm.mock.calls[0][0].subjectId).toBe(4);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/solve/SolveCandidatePicker.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

要点：
- `selectedId` 默认 `candidates[0].id`；
- `checked` 默认 `new Set(candidate.figureUrls)`；切题时重置为该题建议；
- `subjectId` 默认按 `suggestedSubject` 映射（math=1/physics=4/chemistry=5）；
- `maxScore` 默认 10，1–100；
- 题干编辑 textarea；恢复按钮；
- `onConfirm` 组装：从 content 删除未勾选的 `![...](url)`，追加勾选但未出现的图。

```tsx
export function SolveCandidatePicker({ candidates, figures, onBack, onConfirm }: Props) {
  const [selectedId, setSelectedId] = useState(candidates[0]?.id ?? '');
  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0];
  const [checked, setChecked] = useState<Set<string>>(new Set(selected?.figureUrls ?? []));
  const [content, setContent] = useState(selected?.content ?? '');
  const [editing, setEditing] = useState(false);
  const [subjectId, setSubjectId] = useState(subjectIdOf(selected?.suggestedSubject));
  const [maxScore, setMaxScore] = useState(10);

  const pick = (c: FreeformCandidate) => {
    setSelectedId(c.id);
    setChecked(new Set(c.figureUrls));
    setContent(c.content);
    setSubjectId(subjectIdOf(c.suggestedSubject));
  };

  const confirm = () => {
    let out = content;
    for (const f of figures) {
      if (checked.has(f.url)) {
        if (!out.includes(f.url)) out += `\n\n![配图](${f.url})`;
      } else {
        out = out.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(f.url)}\\)`, 'g'), '');
      }
    }
    onConfirm({ content: out.trim(), figureUrls: [...checked], subjectId, maxScore });
  };

  return (
    <div className="w-full max-w-4xl">
      <h2 className="text-xl font-bold mb-4">识别到 {candidates.length} 道题</h2>
      <div className="grid gap-3">
        {candidates.map((c) => (
          <label key={c.id} className={`rounded-xl border p-3 cursor-pointer ${c.id === selectedId ? 'border-[#FF6B00] bg-[#FFF7F2]' : 'border-[#E5E5E5]'}`}>
            <input type="radio" checked={c.id === selectedId} onChange={() => pick(c)} className="sr-only" />
            <div className="font-medium mb-1">第 {c.no || '?'} 题</div>
            <div className="text-sm text-[#86868B] line-clamp-3">{stripMdImages(c.content).slice(0, 120)}</div>
          </label>
        ))}
      </div>

      <div className="mt-4">
        <div className="text-sm font-medium mb-2">配图（多选）</div>
        <div className="flex flex-wrap gap-3">
          {figures.map((f) => (
            <label key={f.url} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={checked.has(f.url)} onChange={(e) => {
                setChecked((prev) => { const n = new Set(prev); e.target.checked ? n.add(f.url) : n.delete(f.url); return n; });
              }} aria-label={f.name} />
              <img src={f.url} alt={f.name} className="w-12 h-12 object-cover rounded border border-[#E5E5E5]" />
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div>
          <div className="text-sm font-medium mb-1">学科</div>
          <div className="flex gap-2">
            {[[1, '数学'], [4, '物理'], [5, '化学']].map(([id, label]) => (
              <button key={id} onClick={() => setSubjectId(Number(id))}
                className={`px-3 h-9 rounded-lg text-sm ${subjectId === Number(id) ? 'bg-[#FF6B00] text-white' : 'bg-[#F5F5F7] text-[#1D1D1F]'}`}>{label}</button>
            ))}
          </div>
        </div>
        <label className="text-sm">满分
          <input type="number" min={1} max={100} value={maxScore} onChange={(e) => setMaxScore(Number(e.target.value))}
            className="ml-2 w-20 h-9 rounded-lg border border-[#E5E5E5] px-2" />
        </label>
        <button onClick={() => setEditing((v) => !v)} className="h-9 px-3 rounded-lg border border-[#E5E5E5] text-sm">
          {editing ? '完成编辑' : '编辑题干'}
        </button>
      </div>

      {editing && (
        <div className="mt-3">
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6}
            className="w-full rounded-lg border border-[#E5E5E5] p-3 text-sm font-mono" />
          <button onClick={() => setContent(selected.content)} className="mt-1 text-xs underline text-[#86868B]">恢复识别结果</button>
        </div>
      )}

      <div className="mt-5 flex justify-between">
        <button onClick={onBack} className="h-10 px-4 rounded-lg border border-[#E5E5E5] text-sm">返回重新上传</button>
        <button onClick={confirm} disabled={!content.trim() || maxScore < 1 || maxScore > 100}
          className="h-10 px-5 rounded-lg bg-[#FF6B00] text-white text-sm disabled:opacity-50">开始作答</button>
      </div>
    </div>
  );
}
```

辅助：`subjectIdOf`、`stripMdImages`、`escapeRegExp` 放在同文件底部。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/solve/SolveCandidatePicker.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/solve/SolveCandidatePicker.tsx apps/web/src/pages/student/solve/SolveCandidatePicker.test.tsx
git commit -m "feat(solve): add candidate picker with figure multi-select"
```

---

### Task 18: `SolveAnswerView`（考试第 9 题骨架）

**Files:**
- Create: `apps/web/src/pages/student/solve/SolveAnswerView.tsx`
- Test: `apps/web/src/pages/student/solve/SolveAnswerView.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function SolveAnswerView(props: {
    questionContent: string;
    answer: string;
    onAnswerChange: (v: string) => void;
    includeDraft: boolean;
    onIncludeDraftChange: (v: boolean) => void;
    submitting: boolean;
    onAskHelp: () => void;
    onSubmit: () => void;
  }): JSX.Element
  ```

- [ ] **Step 1: 写失败测试**

```tsx
it('题干图片带 dragToDraft，底部两个按钮', () => {
  const { container } = render(
    <SolveAnswerView questionContent={'题干 ![图](/uploads/a.jpg)'} answer="" onAnswerChange={() => {}}
      includeDraft onIncludeDraftChange={() => {}} submitting={false} onAskHelp={() => {}} onSubmit={() => {}} />,
  );
  expect(screen.getByRole('button', { name: '答疑' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '提交' })).toBeTruthy();
  // markdown 渲染的 img 有 pointerdown（dragToDraft 链路）
  const img = container.querySelector('img[alt="图"]') as HTMLImageElement;
  expect(img).toBeTruthy();
});

it('提交中禁用两个按钮', () => {
  render(<SolveAnswerView questionContent="题" answer="答" onAnswerChange={() => {}}
    includeDraft onIncludeDraftChange={() => {}} submitting onAskHelp={() => {}} onSubmit={() => {}} />);
  expect(screen.getByRole('button', { name: '答疑' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/solve/SolveAnswerView.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

要点：
- 卡片：`rounded-xl border bg-[var(--learn-card-bg)] flex flex-col`；
- 题干：`ReactMarkdown` + `markdownRemarkPluginsWithBreaks` + `markdownRehypePlugins` + `questionComponents`（`MarkdownImg dragToDraft bucketHeight`）；
- 作答区：`flex-[2] min-h-[280px] flex`，左 `w-1/2` `LatexEditor`，右 `w-1/2` `LatexPreview`；
- 底部：`grid grid-cols-3 items-center`，左「附上草稿」，中按钮组 `justify-center gap-3`，右空；
- `onSubmit` 由父层校验；本组件只负责按钮 disabled（submitting）。

```tsx
const questionComponents = {
  img: (props: { src?: string; alt?: string }) => (
    <MarkdownImg {...props} bucketHeight dragToDraft className="block mx-auto my-4 max-w-full object-contain rounded-lg" />
  ),
};

export function SolveAnswerView(props: Props) {
  const scrollSync = useRef<PreviewScrollSync>({ ratio: 0 });
  return (
    <div className="rounded-xl border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] flex flex-col min-h-0">
      <div className="shrink-0 max-h-[33%] overflow-auto px-5 py-4 border-b border-[var(--bg-subtle)]">
        <ReactMarkdown remarkPlugins={markdownRemarkPluginsWithBreaks} rehypePlugins={markdownRehypePlugins} components={questionComponents}>
          {props.questionContent}
        </ReactMarkdown>
      </div>
      <div className="flex-[2] min-h-[280px] flex min-h-0">
        <div className="w-1/2 min-w-0 border-r border-[var(--bg-subtle)] flex flex-col">
          <LatexEditor value={props.answer} onChange={props.onAnswerChange} scrollSync={scrollSync} />
        </div>
        <div className="w-1/2 min-w-0">
          <LatexPreview value={props.answer} scrollSync={scrollSync} />
        </div>
      </div>
      <div className="shrink-0 grid grid-cols-3 items-center gap-3 px-4 py-3 border-t border-[var(--bg-subtle)]">
        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <input type="checkbox" checked={props.includeDraft} onChange={(e) => props.onIncludeDraftChange(e.target.checked)} />
          附上草稿
        </label>
        <div className="flex items-center justify-center gap-3">
          <button type="button" onClick={props.onAskHelp} disabled={props.submitting}
            className="h-10 px-5 rounded-lg border border-[var(--brand-500)] text-[var(--brand-500)] text-sm disabled:opacity-50">答疑</button>
          <button type="button" onClick={props.onSubmit} disabled={props.submitting}
            className="h-10 px-6 rounded-lg bg-[var(--brand-500)] text-white text-sm disabled:opacity-50">
            {props.submitting ? '提交中…' : '提交'}
          </button>
        </div>
        <div />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/solve/SolveAnswerView.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/solve/SolveAnswerView.tsx apps/web/src/pages/student/solve/SolveAnswerView.test.tsx
git commit -m "feat(solve): add exam-style answer view"
```

---

### Task 19: `useFreeform` hooks（识别 / 判题 / 答疑）

**Files:**
- Create: `apps/web/src/pages/student/solve/useFreeformRecognize.ts`
- Create: `apps/web/src/pages/student/solve/useFreeformJudge.ts`
- Create: `apps/web/src/pages/student/solve/useFreeformTutor.ts`
- Test: `apps/web/src/pages/student/solve/freeform-hooks.test.ts`

**Interfaces:**
- Produces:
  - `useFreeformRecognize()` → `{ busy, error, result, run(input), reset() }`
  - `useFreeformJudge()` → `{ submitting, questionId, lastResult, submit(body), stop() }`
  - `useFreeformTutor()` → `{ ensureDialogue(questionText, subjectId): Promise<string>, send(dialogueId, text, attachments, images), stop() }`

- [ ] **Step 1: 写失败测试**

```ts
it('useFreeformRecognize 成功/失败状态', async () => {
  vi.mock('@/services/api', async (orig) => ({
    ...(await orig<any>()),
    recognizeFreeform: vi.fn()
      .mockResolvedValueOnce({ candidates: [{ id: 'c1', no: '1', content: '题', figureUrls: [], suggestedSubject: null, confidence: 1 }], figures: [] })
      .mockRejectedValueOnce(new Error('boom')),
  }));
  const { result } = renderHook(() => useFreeformRecognize());
  await act(() => result.current.run({ text: '题', attachments: [] }));
  expect(result.current.result?.candidates).toHaveLength(1);
  await act(() => result.current.run({ text: '题', attachments: [] }));
  expect(result.current.error).toContain('boom');
});

it('useFreeformJudge 消费 result 并记住 questionId', async () => {
  vi.mock('@/services/api', async (orig) => ({
    ...(await orig<any>()),
    streamFreeformJudge: vi.fn().mockImplementation(async function* () {
      yield { type: 'start', dialogueId: '1', questionId: null };
      yield { type: 'reasoning', delta: '想' };
      yield { type: 'content', delta: '报告' };
      yield { type: 'result', questionId: 7, totalScore: 7, maxScore: 10, verdict: 'partial' };
      yield { type: 'done' };
    }),
  }));
  const { result } = renderHook(() => useFreeformJudge());
  await act(() => result.current.submit({ subjectId: 1, maxScore: 10, questionContent: '题', answer: '答' }));
  expect(result.current.questionId).toBe(7);
  expect(result.current.lastResult?.totalScore).toBe(7);
});
```

> `vi.mock` 必须放文件顶部（vitest hoist）；上面为了紧凑写在 `it` 里只是示意，实现时按顶部 mock 写，测试内只做 `renderHook` + 断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/solve/freeform-hooks.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`useFreeformRecognize`：

```ts
export function useFreeformRecognize() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FreeformRecognizeResult | null>(null);
  const run = useCallback(async (input: { text: string; attachments: AttachmentRequest[] }) => {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await recognizeFreeform(input)); }
    catch (e) { setError(e instanceof Error ? e.message : '识别失败'); }
    finally { setBusy(false); }
  }, []);
  return { busy, error, result, run, reset: () => { setResult(null); setError(null); } };
}
```

`useFreeformJudge`：追加用户/助手消息到 `useChatStore`，消费 SSE，更新 reasoning/content，记录 `questionId`/`lastResult`；`resetLastAssistantToStreaming` 用于重试；错误用 `setLastAssistantError`。

```ts
export function useFreeformJudge() {
  const [submitting, setSubmitting] = useState(false);
  const [questionId, setQuestionId] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<Extract<FreeformJudgeEvent, { type: 'result' }> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const submit = useCallback(async (body: FreeformJudgeBody, display?: { images?: string[]; answerMarkdown?: string }) => {
    const s = useChatStore.getState();
    if (s.isStreaming) return;
    s.appendMessage({ role: 'user', content: display?.answerMarkdown ?? body.answer, images: display?.images, markdown: true });
    s.appendMessage({ role: 'assistant', content: '', streaming: true });
    s.setIsStreaming(true);
    setSubmitting(true);
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      for await (const e of streamFreeformJudge(body, ctrl.signal)) {
        if (e.type === 'reasoning') useChatStore.getState().appendLastAssistant({ reasoning: e.delta });
        else if (e.type === 'content') {
          if (e.replace) useChatStore.getState().updateLastAssistant(e.delta);
          else useChatStore.getState().appendLastAssistant({ content: e.delta });
        } else if (e.type === 'result') {
          setQuestionId(e.questionId); setLastResult(e);
        } else if (e.type === 'error') {
          useChatStore.getState().setLastAssistantError({ code: e.code, message: e.message, retryable: e.retryable });
        }
      }
    } catch {
      useChatStore.getState().setLastAssistantError({ code: 1012, message: '网络连接失败，请重试', retryable: true });
    } finally {
      useChatStore.getState().setIsStreaming(false);
      setSubmitting(false);
      abortRef.current = null;
    }
  }, []);
  const stop = () => abortRef.current?.abort();
  return { submitting, questionId, lastResult, submit, stop };
}
```

`useFreeformTutor`：

```ts
export function useFreeformTutor() {
  const abortRef = useRef<AbortController | null>(null);
  const ensureDialogue = useCallback(async (questionText: string, subjectId: number) => {
    const c = await createConversation({
      track: 'auxiliary', scene: 'aux_freeform', subjectId, questionText,
    });
    return String(c.id);
  }, []);
  const send = useCallback(async (
    dialogueId: string, text: string,
    attachments?: AttachmentRequest[], images?: string[],
  ) => {
    if (!text.trim() && !attachments?.length) return;
    const store = useChatStore.getState();
    if (store.isStreaming) return;
    store.appendMessage({ role: 'user', content: text.trim(), images });
    store.appendMessage({ role: 'assistant', content: '', streaming: true });
    store.setIsStreaming(true);
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const token = getAuthToken() ?? '';
    try {
      const res = await fetch('/api/ai/tutor/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ mode: 'auxiliary', dialogueId, message: text.trim() || '帮我看一下这道题', attachments }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error('stream unavailable');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data: ')) continue;
          let e: any; try { e = JSON.parse(t.slice(6)); } catch { continue; }
          const s = useChatStore.getState();
          if (e.type === 'reasoning' && e.delta) s.appendLastAssistant({ reasoning: e.delta });
          else if (e.type === 'content' && e.delta !== undefined) {
            if (e.replace) s.updateLastAssistant(e.delta); else s.appendLastAssistant({ content: e.delta });
          } else if (e.type === 'error') {
            s.setLastAssistantError({ code: e.code ?? 5000, message: e.message ?? 'AI 服务异常', retryable: e.retryable ?? true });
          }
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        useChatStore.getState().setLastAssistantError({ code: 1012, message: '网络连接失败，请重试', retryable: true });
      }
    } finally {
      useChatStore.getState().setIsStreaming(false);
      abortRef.current = null;
    }
  }, []);
  const stop = () => abortRef.current?.abort();
  return { ensureDialogue, send, stop };
}
```

不更新 `useAuxiliaryStore`（`aux_freeform` 不进答疑列表）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/solve/freeform-hooks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/solve/useFreeformRecognize.ts apps/web/src/pages/student/solve/useFreeformJudge.ts apps/web/src/pages/student/solve/useFreeformTutor.ts apps/web/src/pages/student/solve/freeform-hooks.test.ts
git commit -m "feat(solve): add freeform recognize/judge/tutor hooks"
```

---

### Task 20: `SolvePage` 状态机 + tabs + 入口卡 + 路由

**Files:**
- Create: `apps/web/src/pages/student/SolvePage.tsx`
- Test: `apps/web/src/pages/student/SolvePage.test.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`
- Modify: `apps/web/src/pages/auth/EntrySelectPage.tsx`
- Test: `apps/web/src/pages/auth/EntrySelectPage.test.tsx`

**Interfaces:**
- Produces: 路由 `/student/solve`；入口第 4 卡「做题」。

- [ ] **Step 1: 写失败测试（入口 + 页面骨架）**

```tsx
// EntrySelectPage.test.tsx
it('第 4 卡「做题」跳 /student/solve', () => {
  render(<MemoryRouter initialEntries={['/student/entry']}><Routes>
    <Route path="/student/entry" element={<EntrySelectPage />} />
    <Route path="/student/solve" element={<div>solve-page</div>} />
  </Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '进入做题' }));
  expect(screen.getByText('solve-page')).toBeTruthy();
});

// SolvePage.test.tsx
it('录入 → 选题 → 作答 → 答疑 tab', async () => {
  render(<MemoryRouter><SolvePage /></MemoryRouter>);
  expect(screen.getByText('把题目发给我')).toBeTruthy();
  // mock recognize/answer/help...
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/auth/EntrySelectPage.test.tsx src/pages/student/SolvePage.test.tsx`
Expected: FAIL（页面/路由不存在）

- [ ] **Step 3: 实现入口卡 + 路由**

`EntrySelectPage.tsx`：
- 加 `PencilRulerIcon`；
- 第 4 个 `motion.button`，`aria-label="进入做题"`，`onClick={() => navigate('/student/solve')}`；
- grid 改 `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`。

`routeTable.tsx`：
- import `SolvePage`；
- 加路由（全屏沉浸层，`RequireRole role="student"`）：

```tsx
{
  path: '/student/solve',
  element: <RequireRole role="student"><SolvePage /></RequireRole>,
},
```

`DraftPanel.tsx`（透传快照函数，避免 Task 20 挂两个白板）：

```tsx
interface Props {
  questionId: string;
  draftKeyPrefix: string;
  onClose: () => void;
  snapshotRef?: React.MutableRefObject<(() => Promise<string | null>) | null>;
}
// render 内部：
<DraftWhiteboard
  key={`${draftKeyPrefix}-${questionId}`}
  questionId={`${draftKeyPrefix}-${questionId}`}
  scrollMode="scroll-y"
  snapshotRef={snapshotRef}
/>
```

- [ ] **Step 4: 实现 `SolvePage`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BackButton } from '@/components/base';
import { UserBadge } from '@/components/business';
import { toast } from '@/components/base/Toast';
import { getAuthItem } from '@/services/authStorage';
import { uploadFile, type AttachmentRequest } from '@/services/api';
import { useChatStore } from '@/store/chatStore';
import AuxChatPanel from '@/components/business/AuxChatPanel';
import AuxInputBar from '@/components/business/AuxInputBar';
import { DraftPanel, DraftIconButton } from '@/components/business/DraftPanel';
import { SolveSourceInput } from './solve/SolveSourceInput';
import { SolveCandidatePicker } from './solve/SolveCandidatePicker';
import { SolveAnswerView } from './solve/SolveAnswerView';
import { useFreeformRecognize } from './solve/useFreeformRecognize';
import { useFreeformJudge } from './solve/useFreeformJudge';
import { useFreeformTutor } from './solve/useFreeformTutor';

export default function SolvePage() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<'input'|'select'|'answer'>('input');
  const [tab, setTab] = useState<'answer'|'ai'>('answer');
  const [aiOpen, setAiOpen] = useState(false);
  const [source, setSource] = useState<{ text: string; attachments: AttachmentRequest[]; imageUrls: string[] } | null>(null);
  const [picked, setPicked] = useState<{ content: string; figureUrls: string[]; subjectId: number; maxScore: number } | null>(null);
  const [answer, setAnswer] = useState('');
  const [includeDraft, setIncludeDraft] = useState(true);
  const [draftOpen, setDraftOpen] = useState(true);
  const [dialogueId, setDialogueId] = useState<string | null>(null);
  const draftKey = useMemo(() => `freeform-${crypto.randomUUID?.() ?? Date.now()}`, []);
  const snapshotRef = useRef<(() => Promise<string|null>) | null>(null);
  const recognize = useFreeformRecognize();
  const judge = useFreeformJudge();
  const tutor = useFreeformTutor();
  const isStreaming = useChatStore((s) => s.isStreaming);

  useEffect(() => { useChatStore.getState().reset(); return () => useChatStore.getState().reset(); }, []);
  // 识别成功 → 自动进入选题
  useEffect(() => {
    if (stage === 'input' && recognize.result) setStage('select');
  }, [recognize.result, stage]);

  const ensureDialogue = async () => {
    if (dialogueId) return dialogueId;
    const id = await tutor.ensureDialogue(picked!.content, picked!.subjectId);
    setDialogueId(id);
    return id;
  };

  const askHelp = async () => {
    const id = await ensureDialogue();
    setAiOpen(true); setTab('ai');
    await tutor.send(id, answer.trim()
      ? `我这题不太会，我的尝试是：\n${answer}\n请引导我思考，不要直接给答案。`
      : '这题怎么做？请引导我思考，不要直接给答案。',
      source?.attachments ?? [], []);
  };

  const submit = async () => {
    if (!picked) return;
    if (!answer.trim() && !includeDraft) { toast('error', '请先写答案或在草稿上作答'); return; }
    let draftFileId: string | undefined;
    if (includeDraft) {
      const url = await snapshotRef.current?.();
      if (url) {
        const blob = await (await fetch(url)).blob();
        const up = await uploadFile(new File([blob], 'draft.jpg', { type: 'image/jpeg' }), undefined, 'freeform');
        draftFileId = String(up.fileId);
      } else if (!answer.trim()) { toast('error', '草稿为空，请先作答'); return; }
    }
    const id = await ensureDialogue();
    setAiOpen(true); setTab('ai');
    await judge.submit({
      dialogueId: id, subjectId: picked.subjectId, maxScore: picked.maxScore,
      questionId: judge.questionId ?? undefined, questionContent: picked.content,
      questionImages: source?.attachments ?? [], figureUrls: picked.figureUrls,
      answer, draftFileId,
    }, { images: source?.imageUrls ?? [], answerMarkdown: answer });
  };

  return (
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="relative flex h-screen flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
        <header className="flex items-center justify-between border-b border-[var(--bg-subtle)] pb-3">
          <div className="flex items-center gap-3">
            <BackButton to="/student/entry" label="返回入口" />
            <h1 className="text-lg font-bold">做题</h1>
          </div>
          <UserBadge username={getAuthItem('username') ?? '同学'} />
        </header>

        {stage === 'input' && (
          <main className="flex-1 flex flex-col items-center justify-center px-6">
            <h2 className="text-2xl font-bold mb-2">把题目发给我</h2>
            <p className="text-sm text-[var(--text-secondary)] mb-6">可输入文字，或拖入/粘贴题目图片（HEIC、JPG、PNG）</p>
            <SolveSourceInput busy={recognize.busy} error={recognize.error}
              onRetry={() => source && recognize.run(source)}
              onManual={() => { setPicked({ content: source?.text ?? '', figureUrls: [], subjectId: 1, maxScore: 10 }); setStage('select'); }}
              onRecognize={(input) => { setSource(input); void recognize.run(input); }} />
          </main>
        )}

        {stage === 'select' && recognize.result && (
          <main className="flex-1 overflow-auto py-6 flex justify-center">
            <SolveCandidatePicker candidates={recognize.result.candidates} figures={recognize.result.figures}
              onBack={() => setStage('input')}
              onConfirm={(p) => { setPicked(p); setStage('answer'); }} />
          </main>
        )}

        {stage === 'select' && !recognize.result && picked && (
          <main className="flex-1 overflow-auto py-6 flex justify-center">
            <SolveCandidatePicker candidates={[{ id: 'c1', no: '1', content: picked.content, figureUrls: [], suggestedSubject: null, confidence: 1 }]}
              figures={[]} onBack={() => setStage('input')}
              onConfirm={(p) => { setPicked(p); setStage('answer'); }} />
          </main>
        )}

        {stage === 'answer' && picked && (
          <main className="flex-1 min-h-0 flex flex-col">
            {aiOpen && (
              <div className="shrink-0 flex items-center gap-1 border-b border-[var(--bg-subtle)] mb-2">
                {[['answer', '作答'], ['ai', 'AI 答疑']].map(([k, label]) => (
                  <button key={k} onClick={() => setTab(k as any)}
                    className={`px-3 h-9 text-sm rounded-lg ${tab === k ? 'bg-[var(--brand-100)] text-[var(--brand-500)] font-medium' : 'text-[var(--text-tertiary)]'}`}>{label}</button>
                ))}
              </div>
            )}
            {tab === 'answer' ? (
              <div className="flex-1 min-h-0 flex">
                <div className="flex-1 min-w-0 min-h-0">
                  <SolveAnswerView questionContent={picked.content} answer={answer} onAnswerChange={setAnswer}
                    includeDraft={includeDraft} onIncludeDraftChange={setIncludeDraft}
                    submitting={judge.submitting} onAskHelp={() => void askHelp()} onSubmit={() => void submit()} />
                </div>
                {draftOpen ? (
                  <DraftPanel questionId={draftKey} draftKeyPrefix="freeform"
                    onClose={() => setDraftOpen(false)} snapshotRef={snapshotRef} />
                ) : (
                  <div className="absolute top-16 right-4">
                    <DraftIconButton onClick={() => setDraftOpen(true)} />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <AuxChatPanel />
                <div className="shrink-0 p-3 bg-white border-t border-[#E5E5E5]">
                  <AuxInputBar isStreaming={isStreaming}
                    onSend={(text, atts, imgs) => { if (dialogueId) void tutor.send(dialogueId, text, atts, imgs); }}
                    onStop={tutor.stop} />
                </div>
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
```

> **重要**：上面把 `DraftPanel` 与隐藏的 `DraftWhiteboard` 并列是为了拿到 `snapshotRef`；实际实现应改成 `DraftPanel` 透传 `snapshotRef`（给 `DraftPanel` 加一个可选 prop，传给内部 `DraftWhiteboard`），避免挂两个白板。Task 20 的实现步骤先改 `DraftPanel` 加 `snapshotRef`，再用一个白板。
>
> 另外 `AuxInputBar isStreaming` 不能在 render 中直接读 `useChatStore.getState()`（不会重渲染）；用 `useChatStore((s) => s.isStreaming)`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/auth/EntrySelectPage.test.tsx src/pages/student/SolvePage.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/student/SolvePage.tsx apps/web/src/pages/student/SolvePage.test.tsx apps/web/src/routes/routeTable.tsx apps/web/src/pages/auth/EntrySelectPage.tsx apps/web/src/pages/auth/EntrySelectPage.test.tsx apps/web/src/components/business/DraftPanel.tsx
git commit -m "feat(web): add solve page, route and fourth entry card"
```

---

### Task 21: 错题练习页显示但不可勾选 freeform

**Files:**
- Modify: `apps/web/src/services/api.ts`（`TrainingErrorBookEntry` 加 `source`）
- Modify: `apps/web/src/pages/student/training/ErrorPracticePage.tsx`
- Test: `apps/web/src/pages/student/training/ErrorPracticePage.test.tsx`

**Interfaces:**
- Consumes: `TrainingErrorBookEntry.source`
- Produces: `source==='freeform'` 的条目显示「做题」徽标、复选框禁用、不计入已选/开始练习。

- [ ] **Step 1: 写失败测试**

```tsx
it('freeform 条目显示但不可勾选，不计入已选', () => {
  mockGetTrainingErrorBook.mockResolvedValue([
    { errorBookId: 1, questionId: 1, questionText: '普通题', type: 'choice', level: 1, createdAt: '', source: 'practice' },
    { errorBookId: 2, questionId: 2, questionText: '做题记录', type: 'short_answer', level: 1, createdAt: '', source: 'freeform' },
  ]);
  render(<ErrorPracticePage />);
  const checks = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect(checks[0]).not.toBeDisabled();
  expect(checks[1]).toBeDisabled();
  expect(screen.getByText('做题')).toBeTruthy();
  expect(screen.getByText(/已选 0/)).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/ErrorPracticePage.test.tsx`
Expected: FAIL（无 source 处理）

- [ ] **Step 3: 实现**

- `TrainingErrorBookEntry` 加 `source: string | null`；
- `ErrorPracticePage` 里：
  - `const selectable = (e) => e.source !== 'freeform'`；
  - 复选框 `disabled={!selectable(entry)}`；
  - 标题行加 `{entry.source === 'freeform' && <Tag>做题</Tag>}`；
  - `selectedCount`/`chosen` 过滤 `selectable`；
  - 全为 freeform 时「开始练习」禁用并提示「做题记录的题目暂不支持错题练习」。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/training/ErrorPracticePage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/pages/student/training/ErrorPracticePage.tsx apps/web/src/pages/student/training/ErrorPracticePage.test.tsx
git commit -m "feat(training): show freeform errors without allowing practice selection"
```

---

### Task 22: 路由迁移、环境变量与单命令交付

**Files:**
- Create: `tools/db/migrations/2026-11-08_freeform_routes.sql`
- Create: `apps/server/src/scripts/migrate-freeform-routes.ts`
- Create: `tools/freeform/setup.sh`
- Modify: `.env.example`

**Interfaces:**
- Produces: `bash tools/freeform/setup.sh` 一条命令完成环境检查 + 路由迁移 + 对账。

- [ ] **Step 1: 写迁移 SQL**

```sql
-- 2026-11-08 做题入口：两条模型路由（幂等）
INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
VALUES
  ('freeform_split', '*', 'local', 'qwen3.8-max'),
  ('freeform_judge', '*', 'qwen3.8-max', NULL)
ON DUPLICATE KEY UPDATE
  primary_model_key = VALUES(primary_model_key),
  fallback_model_key = VALUES(fallback_model_key);
```

- [ ] **Step 2: 写 Node 迁移脚本（可被 CI/管理端复用）**

```ts
// apps/server/src/scripts/migrate-freeform-routes.ts
import 'dotenv/config';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection({
  host: process.env.DB_HOST ?? 'localhost',
  user: process.env.DB_USER ?? 'ai_k12',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'ai_k12',
});
await conn.execute(
  `INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
   VALUES ('freeform_split','*','local','qwen3.8-max'), ('freeform_judge','*','qwen3.8-max',NULL)
   ON DUPLICATE KEY UPDATE primary_model_key=VALUES(primary_model_key), fallback_model_key=VALUES(fallback_model_key)`,
);
await conn.end();
console.log('freeform routes migrated');
```

- [ ] **Step 3: 写 setup.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== 1/4 检查 MinerU =="
if ! command -v "${MINERU_BIN:-mineru-open-api}" >/dev/null 2>&1; then
  echo "未找到 ${MINERU_BIN:-mineru-open-api}。请先：pip install mineru && mineru-open-api auth"
  exit 1
fi

echo "== 2/4 检查 MINERU_TOKEN =="
TOKEN="${MINERU_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  # 尝试从 apps/server/.env 读取
  TOKEN="$(grep -E '^MINERU_TOKEN=' apps/server/.env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
fi
if [[ -z "$TOKEN" ]]; then
  echo "MINERU_TOKEN 未配置。到 https://mineru.net/apiManage/token 获取 sk- 开头的 Key，写入 apps/server/.env"
  exit 1
fi

echo "== 3/4 应用路由迁移 =="
DB_HOST="${DB_HOST:-localhost}"
DB_USER="${DB_USER:-ai_k12}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-ai_k12}"
if [[ -n "$DB_PASSWORD" ]]; then
  mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < tools/db/migrations/2026-11-08_freeform_routes.sql
else
  mysql -h "$DB_HOST" -u "$DB_USER" "$DB_NAME" < tools/db/migrations/2026-11-08_freeform_routes.sql
fi

echo "== 4/4 schema 对账 =="
python3 tools/db/schema_reconcile.py

echo
echo "完成。请重启后端：node dist/main.js"
```

- [ ] **Step 4: 加 `.env.example`**

```env
# MinerU（做题入口识题）
MINERU_BIN=mineru-open-api
MINERU_TOKEN=
MINERU_TIMEOUT_MS=90000
MINERU_CONCURRENCY=2
```

- [ ] **Step 5: 冒烟**

Run: `bash tools/freeform/setup.sh`
Expected: 检查通过、迁移 2 行、对账 75+ 表一致；若 token 未配则给出明确提示并退出。

- [ ] **Step 6: Commit**

```bash
git add tools/db/migrations/2026-11-08_freeform_routes.sql apps/server/src/scripts/migrate-freeform-routes.ts tools/freeform/setup.sh .env.example
git commit -m "chore(freeform): add route migration and one-command setup"
```

---

### Task 23: 文档同步（PRD / API / openapi / constraints）

**Files:**
- Modify: `docs/K12智学系统-产品需求文档.md`（新增 §7.15）
- Modify: `docs/API接口与数据流设计文档.md`（§4.30 / §5.33）
- Modify: `docs/api/openapi.yaml`
- Create: `docs/constraints/做题入口.md`
- Modify: `CLAUDE.md`（constraints 索引一行）

- [ ] **Step 1: PRD §7.15**

按 spec §1–§3 写 1 页产品口径：四卡入口、三态流程、MinerU+本地切题+千问判题、题库/错题本口径、不发病/不发分、无历史、隐私（原图不入库）。明确：**§7.10 继续适用于答疑；§7.15 是本入口的差异口径**（不满分才进错题本、不反哺组卷）。

- [ ] **Step 2: API 文档 §4.30 / §5.33**

- §4.30 端点表：`POST /api/freeform/recognize`、`POST /api/freeform/judge/stream`、`POST /api/files/upload?source=freeform`、`POST /api/conversations`（scene `aux_freeform`）。
- §5.33 数据流：录入→上传→MinerU→本地切题→选题→作答→判题 SSE→questions/main_error_books/ai_dialogues/ai_messages；错误码表。
- 所有请求/响应/SSE 事件与 spec §5 一致。

- [ ] **Step 3: openapi.yaml**

- 新增两条端点、schema `FreeformRecognizeRequest/Response`、`FreeformJudgeRequest`、SSE 描述；
- `CreateConversationDto.scene` enum 加 `aux_freeform`；
- `files/upload` 增加 `source` query 参数（enum `auxiliary|freeform`，默认 `auxiliary`）；
- 状态码：识别 200/400/502/500；判题 SSE 200（错误在事件里）。

- [ ] **Step 4: constraints 文档**

`docs/constraints/做题入口.md`：

```markdown
# 做题入口（freeform）— 硬约束

- 识题主路径：MinerU `extract` → 本地 LLM 切题；本地失败才回退千问。MinerU 不可用 → 报错 + 手动输入，不做 VLM 兜底。
- 原题照片**不得**写入 `questions.content`；只存 MinerU 提取且学生勾选的配图。
- freeform 题：`source='freeform'`、`answer_verified=0`、**不写 question_knowledge_points**、`grade_band=NULL`。
- 错题本只在 `totalScore < maxScore` 时写；满分清零；**不发积分、不写 practice_results、不调 MasteryService**。
- 错题练习抽题必须排除 `source='freeform'`；错题本列表可显示但不可勾选。
- 答疑会话 `scene='aux_freeform'`，不得出现在答疑历史列表（`aux_qna` 过滤）。
- 提交后再次提交 = 重判同一题；首次提交后锁学科/满分，题干仍可改。
- 原图/配图/草稿上传走 `source=freeform`；配图落 `/uploads/freeform/<uuid>/`。
- 交付只给一条命令：`bash tools/freeform/setup.sh`。
```

`CLAUDE.md` 的 constraints 索引行加 `做题入口.md`。

- [ ] **Step 5: 检查文档一致性**

Run: `cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n "freeform" docs/API接口与数据流设计文档.md docs/api/openapi.yaml | head`
Expected: 两份文档都有两个端点与 `aux_freeform`。

- [ ] **Step 6: Commit**

```bash
git add docs/K12智学系统-产品需求文档.md docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/constraints/做题入口.md CLAUDE.md
git commit -m "docs(freeform): document solve entry, APIs and constraints"
```

---

### Task 24: 端到端冒烟与收口

**Files:**
- 无新增；修复冒烟发现的问题
- Modify: `docs/ai-core-changelog.md`（补一条实现日志）

- [ ] **Step 1: 起后端（必须 node dist/main.js）**

```bash
cd apps/server && npm run build && node dist/main.js
```

Expected: 启动无 DI 报错；日志出现 `/uploads` 静态服务。

- [ ] **Step 2: 起前端**

```bash
cd apps/web && npm run dev
```

- [ ] **Step 3: 真环境冒烟（按 spec §10.3）**

1. 入口第 4 卡 → 做题页；
2. 拖 2 张含 2 道题的照片 → 候选 2 道 → 选第 2 道 → 配图多选 → 作答页；
3. 题干配图拖进草稿 → 手写 → 写 LaTeX 答案 → 预览；
4. 【答疑】→ 思考流 + 苏格拉底引导；
5. 【提交】→ 思考流 + 分步得分；AI tab 出现并默认激活；
6. 不满分 → 错题本出现；满分重提 → 清零；
7. 追问 → 上下文连续、不改分；
8. 纯文字题 / HEIC / MinerU 断网或 token 错 / 超 6 张 / 空答案；
9. iPad 横屏拖图、粘贴、白板、tab；
10. 查库：`questions` 有 `source='freeform'`、无 KP、content 不含整页照片；`main_error_books` 只有不满分；无 `practice_results`/积分/掌握度写入。
11. 专项/同类型/考试/错题练习抽题池不出现 freeform 题；错题练习页显示但不可勾选。

- [ ] **Step 4: 修问题 + 补 changelog**

`docs/ai-core-changelog.md` 加：

```markdown
## 2026-11-08 做题入口（自由做题）

- 新增 `/student/solve` 与 `freeform` 后端模块：MinerU → 本地切题 → 千问判题 SSE。
- 题库 `source='freeform'`、无 KP、不进任何自动练习池；错题本只在不满分时写。
- 新增 `freeform_split` / `freeform_judge` 路由；交付 `bash tools/freeform/setup.sh`。
- 冒烟结论：…（写实测结果，不写计划）
```

- [ ] **Step 5: 全量测试**

```bash
(cd apps/server && npm test)
(cd apps/web && npm test && npm run build)
```

Expected: 全绿；`tsc`/vite 构建通过。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(freeform): end-to-end smoke fixes and changelog"
```

---

## 自检（写完计划后已核对）

- **Spec 覆盖**：§3 三态与 tab → Task 16–20；§4 数据模型 → Task 8/9/12；§5 接口 → Task 2–13；§6 MinerU → Task 5/6/22；§7 提示词/路由 → Task 1–3/22；§8 前端 → Task 13–21；§9 错误边界 → Task 5/6/9/10/16；§10 测试 → 各 Task 的测试步骤 + Task 24；§11 文档/迁移 → Task 22/23；§12 验收 → Task 24。
- **类型一致性**：`FreeformSplitCandidate`、`FreeformJudgeEvent`、`FreeformRecognizeResult`、`SourceImage`、`FreeformCandidate` 在前后端命名一致；`questionId` 为 `number`，`dialogueId` 为 `string`（与现有 `ai_dialogues` 路由一致）。
- **已知实现注意**：
  1. `FreeformJudgeCapability.extractStructured` 必须在 Task 3 一并实现（Task 9 依赖）。
  2. MinerU 并发用 Task 5 的 `mineruLimiter`，Task 6 已用它包住 `mineru.run`；测试 mock runner，不受并发影响。
  3. `DraftPanel` 的 `snapshotRef` 透传已写在 Task 20 Step 3；Task 20 只挂一个白板。
  4. `AuxInputBar` 的 `isStreaming` 必须用 zustand selector，不能在 render 里 `getState()`（Task 20 已用 `useChatStore((s) => s.isStreaming)`）。
  5. `DraftWhiteboard` 的 `strokePath` 抽到 `draft-render.ts` 后，`redraw` 行为必须保持不变（有回归测试）。

