# 训练轨答题页体验修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复专项/考试/错题三个答题页的留白、字号、题面挤压答题区问题，新增「提示→解析」渐进式交互与退出确认逻辑。

**Architecture:** 前端以共享组件 `QuestionRunner` 为改造核心（variant 区分字号、题面限高、新增解析状态机与 onClose 签名），三个 run 页接线；新增共享 `RunExitGuard`（react-router `useBlocker`）做浏览器返回拦截。后端在 training 模块镜像 hint 端点模式新增 `POST /training/explanation`（DB explanation 优先，AI 兜底），为此在 ai-core 新增 `question_solution` 解析模式与提示模板。API 文档双份同步（CLAUDE.md 铁律）。

**Tech Stack:** React 19 + Tailwind 3 + react-router-dom 6.27（`useBlocker`）/ NestJS + Vitest / openapi.yaml + `docs/API接口与数据流设计文档.md`。

**Spec:** `docs/superpowers/specs/2026-09-04-training-run-ux-design.md`

**对 spec 的一处修正（实施时发现的偏差）**：spec 写 AI 兜底用 `ExplanationCapability` 的 `knowledge_retry` 模式，但读模板后确认 `knowledge-retry.md` 是「知识点重讲」模板，**不含题面**（只渲染 `{{knowledgePoint.name}}` + 错误记录），不适合「未作答请求完整解析」。改为新增 `question_solution` 模式 + 新模板 `question-solution.md`。Task 3 会同步修订 spec。

**通用约定**：
- 前端命令在 `apps/web/` 下执行，后端命令在 `apps/server/` 下执行，git 操作在仓库根 `/Users/lichao/Downloads/claude/imooc/ai_k12` 执行。
- apps/web 无测试框架：前端任务验证 = `npm run lint` + `npm run build`。
- 禁止 emoji 进 UI；图标一律线性 SVG；配色走 CSS 变量。
- 提交信息用 Conventional Commits（scope：web/server/ai-core/docs）。

---

### Task 1: ai-core 新增 question_solution 解析模式

**Files:**
- Modify: `apps/server/src/ai-core/types.ts:53`
- Modify: `apps/server/src/ai-core/infra/prompt-builder.ts:75-77`
- Create: `apps/server/src/ai-core/prompts/explanation/question-solution.md`

- [ ] **Step 1: 扩展 ExplanationMode 类型**

`apps/server/src/ai-core/types.ts:53`，把：

```ts
export type ExplanationMode = 'error_analysis' | 'knowledge_retry';
```

改为：

```ts
export type ExplanationMode = 'error_analysis' | 'knowledge_retry' | 'question_solution';
```

- [ ] **Step 2: prompt-builder 接入新模板路径**

`apps/server/src/ai-core/infra/prompt-builder.ts:75-77`，把：

```ts
    if (capability === 'explanation') {
      return mode === 'knowledge_retry' ? `explanation/knowledge-retry.md` : `explanation/error-analysis.md`;
    }
```

改为：

```ts
    if (capability === 'explanation') {
      if (mode === 'knowledge_retry') return `explanation/knowledge-retry.md`;
      if (mode === 'question_solution') return `explanation/question-solution.md`;
      return `explanation/error-analysis.md`;
    }
```

- [ ] **Step 3: 新建模板 question-solution.md**

新建 `apps/server/src/ai-core/prompts/explanation/question-solution.md`，内容（格式对齐同目录 `error-analysis.md`——frontmatter + `## System Prompt` / `## User Message` 分段）：

```markdown
---
version: "1.0"
description: "题目详解 - 学生未作答（或看过提示仍卡住）时直接请求该题的完整解析"
---

## System Prompt

你是一位耐心的辅导老师。学生还没有作答这道题（或在看过提示后仍然卡住），现在直接请求完整解析。

### 输出结构
1. **解题思路**：这道题在考什么？解题入口在哪里？（1-2 句）
2. **分步解析**：逐步展示完整解法，每一步说明依据
3. **知识点链接**：这道题用到了哪些知识点
4. **易错提醒**：做这类题最常见的错误是什么

### 语气
温和鼓励，不要让学生感到沮丧。用"我们"而不是"你"。

---

## User Message
**题目**：{{question.content}}
**标准答案**：{{question.answer}}

请给出这道题的完整解析。
```

- [ ] **Step 4: 类型检查**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 0 错误。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ai-core/types.ts apps/server/src/ai-core/infra/prompt-builder.ts apps/server/src/ai-core/prompts/explanation/question-solution.md
git commit -m "feat(ai-core): 新增 question_solution 解析模式与题目详解模板"
```

---

### Task 2: training 模块 explanation 端点（TDD）

**Files:**
- Test: `apps/server/src/modules/training/training.service.test.ts`
- Modify: `apps/server/src/modules/training/training.service.ts`
- Modify: `apps/server/src/modules/training/training.controller.ts`
- Modify: `apps/server/src/modules/training/training.module.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/src/modules/training/training.service.test.ts`：

1. `mk()`（第 5-21 行）追加一行依赖（在 `hint: { generate: vi.fn() },` 之后）：

```ts
  // 训练「解析」端点依赖。
  explanation: { explain: vi.fn() },
```

2. `mkSvc`（第 22-23 行）改为（追加第 7 个参数 `deps.explanation`）：

```ts
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new TrainingService(deps.mainErrorRepo, deps.judgeCore, deps.questionsRepo, deps.knowledgePointsRepo, deps.questionHintsRepo, deps.hint, deps.explanation);
```

3. 文件末尾追加测试块：

```ts
describe('TrainingService.getExplanation', () => {
  it('DB explanation 非空直返，不调 AI', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', answer: 'A', explanation: '库内解析' }),
        findRandomByKpAndType: vi.fn().mockResolvedValue([]),
      },
    });
    const r = await mkSvc(deps).getExplanation({ questionId: 10 });
    expect(r).toEqual({ explanation: '库内解析' });
    expect(deps.explanation.explain).not.toHaveBeenCalled();
  });

  it('DB explanation 为 null -> AI 生成（question_solution 模式）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', answer: 'A', explanation: null }),
        findRandomByKpAndType: vi.fn().mockResolvedValue([]),
      },
      explanation: { explain: vi.fn().mockResolvedValue({ content: 'AI 解析', mode: 'question_solution', reasoning: null }) },
    });
    const r = await mkSvc(deps).getExplanation({ questionId: 10 });
    expect(r).toEqual({ explanation: 'AI 解析' });
    expect(deps.explanation.explain).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'question_solution',
      question: { content: '题面', answer: 'A' },
    }));
  });

  it('DB explanation 为空白字符串也走 AI', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', answer: 'A', explanation: '   ' }),
        findRandomByKpAndType: vi.fn().mockResolvedValue([]),
      },
      explanation: { explain: vi.fn().mockResolvedValue({ content: 'AI 解析', mode: 'question_solution', reasoning: null }) },
    });
    const r = await mkSvc(deps).getExplanation({ questionId: 10 });
    expect(r).toEqual({ explanation: 'AI 解析' });
  });

  it('AI 失败 -> 503 code 5001', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', answer: 'A', explanation: null }),
        findRandomByKpAndType: vi.fn().mockResolvedValue([]),
      },
      explanation: { explain: vi.fn().mockRejectedValue(new Error('llm down')) },
    });
    await expect(mkSvc(deps).getExplanation({ questionId: 10 })).rejects.toMatchObject({
      status: 503,
      response: { code: 5001 },
    });
  });

  it('题目不存在 -> 404 且不调 AI', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue(null),
        findRandomByKpAndType: vi.fn().mockResolvedValue([]),
      },
    });
    await expect(mkSvc(deps).getExplanation({ questionId: 999 })).rejects.toMatchObject({ status: 404 });
    expect(deps.explanation.explain).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: FAIL——`mkSvc` 传 7 个参数但 TrainingService 构造函数只收 6 个（TS 报错或 `svc.getExplanation is not a function`）。

- [ ] **Step 3: 实现 service**

`apps/server/src/modules/training/training.service.ts`：

1. import 区（第 7 行 `HintCapability` 旁）追加：

```ts
import { ExplanationCapability } from '../../ai-core/capabilities/explanation.capability.js';
```

2. 构造函数追加第 7 个注入（`private readonly hint: HintCapability,` 之后）：

```ts
    private readonly explanation: ExplanationCapability,
```

3. `getHint` 方法之后追加（错误处理三态镜像 getHint）：

```ts
  /**
   * 训练「解析」：DB questions.explanation 优先（题库自带参考解析，省 AI），
   * 为空才调 ExplanationCapability（question_solution 模式）生成完整解析。
   * MVP 不缓存——点解析是看过提示后的低频兜底路径（待办：量大后镜像 question_hints 建缓存表）。
   * 题目不存在 -> 404；AI 失败 -> 503（code 5001）。
   */
  async getExplanation(input: { questionId: number }): Promise<{ explanation: string }> {
    // 0. 拿题（训练题必来自题库，无题 404）
    const q = await this.questionsRepo.findById(input.questionId);
    if (!q) {
      throw new NotFoundException(`题目不存在：${input.questionId}`);
    }

    // 1. DB 解析非空直返
    if (q.explanation && q.explanation.trim().length > 0) {
      return { explanation: q.explanation };
    }

    // 2. AI 生成完整解析
    try {
      const result = await this.explanation.explain({
        mode: 'question_solution',
        studentId: '',
        subject: 'math',
        question: { content: q.content, answer: q.answer },
        wrongAnswer: '',
        knowledgePoint: { id: '', name: '' },
      });
      return { explanation: result.content };
    } catch (err) {
      this.logger.error(`explanation.explain failed: ${err}`);
      throw new HttpException(
        { code: 5001, message: '解析生成失败，请重试' },
        503,
      );
    }
  }
```

（`studentId` 传 `''`：该字段不参与 question-solution 模板渲染，仅为满足 `ExplanationRequest` 类型。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: 全部 PASS（原 getHint 等用例不受影响——`mk()` 里 `explanation.explain` 默认 `vi.fn()` 未配置返回值，但原用例不会走到 explanation 分支）。

- [ ] **Step 5: controller 加端点**

`apps/server/src/modules/training/training.controller.ts`，`@Post('hint')` 方法之后追加：

```ts
  /** 训练「解析」：DB questions.explanation 优先，为空 AI 生成（MVP 不缓存）。 */
  @Post('explanation')
  async explanation(@Body() dto: { questionId: number }, @CurrentUser() _user: JwtUser) {
    return this.trainingService.getExplanation({ questionId: dto.questionId });
  }
```

- [ ] **Step 6: module 注册 provider**

`apps/server/src/modules/training/training.module.ts`：

1. import 追加：

```ts
import { ExplanationCapability } from '../../ai-core/capabilities/explanation.capability.js';
```

2. `providers` 数组追加 `ExplanationCapability`（`HintCapability` 之后）：

```ts
  providers: [TrainingService, MainErrorBooksRepository, QuestionsRepository, QuestionHintsRepository, KnowledgePointsRepository, HintCapability, ExplanationCapability],
```

3. 模块注释（第 8-12 行 docstring）追加一句：

```ts
 * ExplanationCapability 同 HintCapability（构造函数 modelClient 可选，直接实例化）。
```

- [ ] **Step 7: 全量测试 + 类型检查**

Run: `cd apps/server && npx tsc --noEmit && npm test`
Expected: tsc 0 错误；vitest 全绿（72+ 原有用例 + 新增 5 用例）。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/training/
git commit -m "feat(server): 新增 POST /training/explanation（DB 优先 + AI 兜底解析）"
```

---

### Task 3: API 文档双份同步 + spec 修订

**Files:**
- Modify: `docs/api/openapi.yaml`（/training/hint path 块后 + TrainingHintResult schema 后）
- Modify: `docs/API接口与数据流设计文档.md`（§4.18 表格 + §6.15/§6.16 + 修订记录表）
- Modify: `docs/superpowers/specs/2026-09-04-training-run-ux-design.md`（knowledge_retry → question_solution 修正）
- Modify: `docs/ai-core-changelog.md`（追加变更条目）

- [ ] **Step 1: openapi.yaml 新增 path**

`docs/api/openapi.yaml`——在 `/training/hint:` path 块（约 3509-3552 行，以 `503` 响应块结尾、`/training/knowledge-points:` 之前）插入：

```yaml
  /training/explanation:
    post:
      tags: [Training]
      summary: 训练解析（DB 优先 + AI 兜底）
      description: >-
        训练答题中学生看过提示后点「解析」调用（student JWT）。优先返回题库
        questions.explanation（参考答案/解析，不调 AI）；为空才调
        ExplanationCapability（question_solution 模式，新模板 question-solution.md）
        生成完整解析，MVP 不缓存（低频兜底路径）。题目不存在 404；AI 生成失败
        503（code=5001）。
      operationId: getTrainingExplanation
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/TrainingHintRequest'
      responses:
        '200':
          description: 解析内容
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        $ref: '#/components/schemas/TrainingExplanationResult'
        '404':
          description: 题目不存在
        '503':
          description: AI 解析生成失败
          content:
            application/json:
              schema:
                type: object
                properties:
                  code:
                    type: integer
                    example: 5001
                  message:
                    type: string
                    example: 解析生成失败，请重试
```

- [ ] **Step 2: openapi.yaml 新增 schema**

在 `TrainingHintResult:` schema 块（约 5368-5374 行）之后插入：

```yaml
    TrainingExplanationResult:
      type: object
      properties:
        explanation:
          type: string
          description: 完整解析文本（DB questions.explanation 或 AI 生成；区别于 hint 的只启发不给答案）
```

- [ ] **Step 3: API 设计文档 §4.18 表格加行**

`docs/API接口与数据流设计文档.md` §4.18 表格（约 394 行 `/api/training/hint` 行之后）插入一行（表格分隔符用 em dash——本仓库表格惯例）：

```markdown
| POST | `/api/training/explanation` | 训练「解析」（学生看过提示后请求完整解析）。请求体：`{questionId}`；题目不存在 404。优先返回题库 `questions.explanation`（不调 AI）；为空才调 ExplanationCapability（`question_solution` 模式，新模板 `question-solution.md`——预答请求完整解析；原 `knowledge_retry` 是知识点重讲模板不含题面，不适用）生成完整解析，MVP 不缓存。AI 生成失败 503（`code=5001`）。响应：`{explanation}`。 | MVP |
```

- [ ] **Step 4: API 设计文档 §6.15/§6.16 数据流补一行**

约 1048 行（§6.15 错题练习，`答题前点「提示」-> POST /api/training/hint {questionId}` 之后）和约 1077 行（§6.16 专项练习，同文案之后）各插入：

```markdown
  看过提示后点「解析」-> POST /training/explanation {questionId}（DB 优先，AI 兜底）
```

- [ ] **Step 5: API 设计文档修订记录表加一行**

约 1325 行 `| v2.3 | ...` 之后追加（日期用当天）：

```markdown
| v2.4 | 2026-09-04 | 新增 `POST /api/training/explanation`（训练解析：DB `questions.explanation` 优先 + ExplanationCapability `question_solution` 模式 AI 兜底，MVP 不缓存；§4.18/§6.15/§6.16 同步）。openapi.yaml 同步收录。 |
```

- [ ] **Step 6: 修订 spec 的模式偏差**

`docs/superpowers/specs/2026-09-04-training-run-ux-design.md` 第 3 节「为空 → ai-core `ExplanationCapability.explain`（`knowledge_retry` 模式）生成」改为：

```
为空 → ai-core `ExplanationCapability.explain`（`question_solution` 模式，实施时新增——原计划的 `knowledge_retry` 是知识点重讲模板不含题面，不适用于未作答请求完整解析的场景）生成
```

- [ ] **Step 7: ai-core-changelog 追加条目**

`docs/ai-core-changelog.md` 按该文件既有条目格式（日期倒序、含「变更/局限」小节）在顶部追加一条，内容要点：

```markdown
## 2026-09-04 新增 question_solution 解析模式（训练轨「解析」端点 AI 兜底）

- 变更：`ExplanationMode` 增加 `question_solution`；prompt-builder 路由到新模板 `explanation/question-solution.md`（学生未作答/看过提示仍卡住时请求完整解析：解题思路/分步解析/知识点链接/易错提醒）。消费方：TrainingService.getExplanation（DB `questions.explanation` 优先，为空才调 AI，MVP 不缓存）。
- 局限/待办：解析无缓存（低频路径；量大后镜像 question_hints 建缓存表）。
```

- [ ] **Step 8: 端点清单一致性检查**

Run: `grep -c "training/explanation" docs/api/openapi.yaml "docs/API接口与数据流设计文档.md"`
Expected: 两份文档各 ≥ 1 处。

- [ ] **Step 9: Commit**

```bash
git add docs/api/openapi.yaml docs/API接口与数据流设计文档.md docs/superpowers/specs/2026-09-04-training-run-ux-design.md docs/ai-core-changelog.md
git commit -m "docs: 同步 /training/explanation 端点文档 + spec 修正 question_solution 模式"
```

---

### Task 4: 前端 api.ts 新增 getTrainingExplanation

**Files:**
- Modify: `apps/web/src/services/api.ts:822-827`（getTrainingHint 之后）

- [ ] **Step 1: 加 API 函数**

在 `getTrainingHint`（约 822-827 行）之后追加：

```ts
export function getTrainingExplanation(questionId: number): Promise<{ explanation: string }> {
  return fetchApi<{ explanation: string }>('/training/explanation', {
    method: 'POST',
    body: JSON.stringify({ questionId }),
  });
}
```

- [ ] **Step 2: lint**

Run: `cd apps/web && npm run lint`
Expected: 0 错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): services 层新增 getTrainingExplanation"
```

---

### Task 5: QuestionRunner 布局与字号 + run 页留白

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx:136`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx:156`
- Modify: `apps/web/src/pages/student/training/ExamRunPage.tsx:228`

- [ ] **Step 1: 题面字号按 variant 区分**

`QuestionRunner.tsx` 约 238 行，把：

```tsx
              <div className="text-xl text-[var(--text-primary)] [&>*]:font-bold leading-[1.7]">
```

改为：

```tsx
              <div
                className={`${variant === 'embedded' ? 'text-lg' : 'text-xl'} text-[var(--text-primary)] [&>*]:font-bold leading-[1.7]`}
              >
```

（弹窗 variant 维持 text-xl——2026-08-09 commit 444e830 用户确认的参数；全屏 embedded 降 text-lg。）

- [ ] **Step 2: 题面区限高 + 答题区保底**

约 235 行，把：

```tsx
        <div className="shrink-0 p-4 border-b border-[var(--bg-subtle)]">
```

改为：

```tsx
        <div className="shrink-0 max-h-[45vh] overflow-y-auto p-4 border-b border-[var(--bg-subtle)]">
```

约 290 行（作答区），把：

```tsx
        <div className="flex-1 min-h-0 flex">
```

改为：

```tsx
        <div className="flex-1 min-h-[280px] flex">
```

（题干超长时题面区内部滚动，答题区保底 280px 始终可用。）

- [ ] **Step 3: 三个 run 页容器加 padding**

- `TargetedRunPage.tsx:136`：`<div className="h-screen flex flex-col bg-[var(--bg-page)] text-[var(--text-primary)]">` → `<div className="h-screen flex flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">`
- `ErrorPracticeRunPage.tsx:156`：同上改法。
- `ExamRunPage.tsx:228`：`<div className="flex h-screen flex-col bg-[var(--bg-page)] text-[var(--text-primary)]">` → `<div className="flex h-screen flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">`

- [ ] **Step 4: lint + build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 两者均 0 错误。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/answer/QuestionRunner.tsx apps/web/src/pages/student/training/TargetedRunPage.tsx apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx apps/web/src/pages/student/training/ExamRunPage.tsx
git commit -m "fix(web): 答题页留白 + 题面区限高保底答题区 + embedded 题面 18px"
```

---

### Task 6: 提示→解析渐进式交互

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`

- [ ] **Step 1: QuestionRunner 新增 props**

`QuestionRunnerProps`（约 44-47 行 `hints`/`onRequestHint` 旁）追加：

```ts
  /** 解析缓存（key = q.n），父层持有（session 缓存） */
  explanations?: Record<string, string>;
  /** 拉取解析：看过提示后才出现该按钮（渐进式——苏格拉底原则：提示 > 解析）；父层请求后端并回写 explanations */
  onRequestExplanation?: (q: RunnerQuestion) => Promise<string>;
```

函数签名解构（约 77-78 行 `hints, onRequestHint,` 旁）追加：

```ts
  explanations,
  onRequestExplanation,
```

- [ ] **Step 2: 解析展示态 + 切题重置**

`hintState`（约 95-99 行）之后追加：

```ts
  const [expState, setExpState] = useState<{ show: boolean; loading: boolean; error: boolean }>({
    show: false,
    loading: false,
    error: false,
  });
```

切题重置 effect（约 114-117 行）把：

```tsx
  useEffect(() => {
    setHintState({ show: false, loading: false, error: false });
    setAnswer('');
  }, [idx]);
```

改为：

```tsx
  useEffect(() => {
    setHintState({ show: false, loading: false, error: false });
    setExpState({ show: false, loading: false, error: false });
    setAnswer('');
  }, [idx]);
```

- [ ] **Step 3: 解析点击 handler（镜像 handleHintClick）**

`handleHintClick`（约 186-202 行）之后追加：

```tsx
  const handleExplanationClick = async () => {
    if (!onRequestExplanation) return;
    if (expState.show) {
      setExpState((s) => ({ ...s, show: false })); // 已展开 -> 收起
      return;
    }
    setExpState((s) => ({ ...s, show: true }));
    if (explanations?.[q.n] || expState.loading) return; // 已缓存或正在拉取 -> 直显/等待
    setExpState((s) => ({ ...s, loading: true, error: false }));
    try {
      await onRequestExplanation(q);
    } catch {
      setExpState((s) => ({ ...s, error: true }));
    } finally {
      setExpState((s) => ({ ...s, loading: false }));
    }
  };
```

- [ ] **Step 4: 渐进式「解析」按钮（提示按钮下方）**

题面区右侧按钮列（约 244-262 行），在 hint 按钮的 `)}` 之后、`{headerActions?.(q)}` 之前插入：

```tsx
                {onRequestExplanation && hints?.[q.n] && (
                  <button
                    onClick={handleExplanationClick}
                    className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] shadow-sm hover:bg-[var(--bg-base)] transition-colors"
                    title="解析"
                    aria-label="解析"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                )}
```

（条件 `hints?.[q.n]`：看过提示（含缓存回看）才浮现解析按钮——渐进式状态机；样式用 `text-tertiary` 弱于提示按钮的 `warning` 色，体现「提示 > 解析」的苏格拉底层级。）

- [ ] **Step 5: 解析抽屉（提示抽屉下方，同在滚动区内）**

提示抽屉块（约 265-286 行 `{hintState.show && (...)}`）之后追加：

```tsx
          {/* 解析抽屉（看过提示后可见；随题面区滚动，不挤压答题区） */}
          {expState.show && (
            <div className="mt-3 p-3 rounded-lg bg-[var(--bg-subtle)] border-l-[3px] border-[var(--text-tertiary)]">
              {expState.loading ? (
                <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                  <svg className="animate-spin text-[var(--text-tertiary)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span>正在生成解析…</span>
                </div>
              ) : explanations?.[q.n] ? (
                <div className="text-sm text-[var(--text-primary)] leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                    {explanations[q.n]}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                  {expState.error ? '解析生成失败，请稍后再试。' : '暂无解析'}
                </p>
              )}
            </div>
          )}
```

- [ ] **Step 6: TargetedRunPage 接线**

`TargetedRunPage.tsx`：

1. import：`getTrainingHint, judgeTraining`（第 8-10 行）改为 `getTrainingExplanation, getTrainingHint, judgeTraining`。
2. `hints` state（第 28 行）之后追加：

```ts
  const [explanations, setExplanations] = useState<Record<string, string>>({});
```

3. `handleRequestHint`（约 110-122 行）之后追加：

```ts
  const handleRequestExplanation = useCallback(
    async (q: RunnerQuestion) => {
      const entry = entryByN.get(q.n);
      if (!entry) {
        throw new Error('题单条目缺失，无法获取解析');
      }
      // 后端可能 503（AI 不可用）：直接 rethrow，QuestionRunner 内部 catch 置 expState.error
      const res = await getTrainingExplanation(entry.questionId);
      setExplanations((prev) => ({ ...prev, [q.n]: res.explanation }));
      return res.explanation;
    },
    [entryByN],
  );
```

4. `<QuestionRunner>` props（约 149-153 行 `enableHint` 附近）追加：

```tsx
            explanations={explanations}
            onRequestExplanation={handleRequestExplanation}
```

- [ ] **Step 7: ErrorPracticeRunPage 接线（镜像 Step 6，多一层 questionId 空判）**

`ErrorPracticeRunPage.tsx`：

1. import 追加 `getTrainingExplanation`（同 Step 6 第 1 点）。
2. `explanations` state（同 Step 6 第 2 点）。
3. `handleRequestHint` 之后追加：

```ts
  const handleRequestExplanation = useCallback(
    async (q: RunnerQuestion) => {
      const entry = entryByN.get(q.n);
      // 列表页已禁选孤儿题（questionId 为空进不了题单）
      if (!entry || entry.questionId == null) {
        throw new Error('该题未入库，无法获取解析');
      }
      // 后端可能 503（AI 不可用）：直接 rethrow，QuestionRunner 内部 catch 置 expState.error
      const res = await getTrainingExplanation(entry.questionId);
      setExplanations((prev) => ({ ...prev, [q.n]: res.explanation }));
      return res.explanation;
    },
    [entryByN],
  );
```

4. `<QuestionRunner>` props 追加（同 Step 6 第 4 点）。

（ExamRunPage 不接——考试无提示/解析。）

- [ ] **Step 8: lint + build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 均通过。

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/business/answer/QuestionRunner.tsx apps/web/src/pages/student/training/TargetedRunPage.tsx apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx
git commit -m "feat(web): 答题页提示->解析渐进式交互（看过提示浮现解析按钮）"
```

---

### Task 7: 退出逻辑（X 确认 + 浏览器返回拦截 + 考试防刷新）

**Files:**
- Create: `apps/web/src/components/business/answer/RunExitGuard.tsx`
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`（onClose 签名）
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ExamRunPage.tsx`

- [ ] **Step 1: 新建 RunExitGuard 组件**

新建 `apps/web/src/components/business/answer/RunExitGuard.tsx`：

```tsx
// apps/web/src/components/business/answer/RunExitGuard.tsx
// 答题页导航守卫：拦截 react-router 路由内返回/跳转（useBlocker），确认后放行。
// 考试页再挂 blockBeforeUnload 拦截刷新/关标签（原生浏览器确认）。
// 注意：组件内部 useBlocker 必须无条件调用，所以「禁用」通过 enabled ref 实现——
// X 确认弹窗先 setEnabled(false) 再 navigate，避免二次拦截。
import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { Modal } from '@/components/base';

interface RunExitGuardProps {
  /** false 时放行导航（父层确认退出后先置 false 再 navigate） */
  enabled: boolean;
  /** 拦截刷新/关闭标签页（考试页用；浏览器原生确认，无法自定义文案） */
  blockBeforeUnload?: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function RunExitGuard({
  enabled,
  blockBeforeUnload = false,
  title,
  message,
  confirmLabel = '确认离开',
  cancelLabel = '继续答题',
}: RunExitGuardProps) {
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const blocker = useBlocker(() => enabledRef.current);

  useEffect(() => {
    if (!blockBeforeUnload) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [blockBeforeUnload]);

  if (blocker.state !== 'blocked') return null;

  return (
    <Modal open onClose={() => blocker.reset()} title={title}>
      <p className="text-sm text-[var(--text-secondary)]">{message}</p>
      <div className="mt-6 flex justify-end gap-3">
        <button
          onClick={() => blocker.reset()}
          className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
        >
          {cancelLabel}
        </button>
        <button
          onClick={() => blocker.proceed()}
          className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)]"
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: QuestionRunner onClose 传出已答数**

`QuestionRunner.tsx`：

1. props 注释与类型（约 58-59 行），把：

```ts
  /** 提供时作答态底部左侧渲染关闭 X（判题等待态的关闭入口由父层 judgingSlot 自理） */
  onClose?: () => void;
```

改为：

```ts
  /** 提供时作答态底部左侧渲染关闭 X，参数 answered = 已提交判题数（父层退出确认文案用；判题等待态的关闭入口由父层 judgingSlot 自理） */
  onClose?: (answered: number) => void;
```

2. X 按钮（约 316 行），把 `onClick={onClose}` 改为：

```tsx
                onClick={() => onClose(Object.keys(resultsRef.current).length)}
```

（AnswerModal 传 `onClose={handleClose}`，handleClose 不收参数——TS 兼容，行为不变。）

- [ ] **Step 3: TargetedRunPage 退出接线**

1. import 区追加：

```ts
import { Modal } from '@/components/base';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
```

2. state 区（第 29 行 `finalResults` 之后）追加：

```ts
  // 退出确认（X 按钮）：answered 由 QuestionRunner 传出
  const [exitConfirm, setExitConfirm] = useState<{ open: boolean; answered: number }>({ open: false, answered: 0 });
  // X 确认后放行导航（先置 false 再 navigate，绕开 RunExitGuard 二次拦截）
  const [guardEnabled, setGuardEnabled] = useState(true);
```

3. JSX：`<QuestionRunner ... />` 加 `onClose={(answered) => setExitConfirm({ open: true, answered })}`（与 `onFinish` 同级）；`</QuestionRunner>` 之后、外层 `</div>` 之前追加：

```tsx
          {/* X 退出确认（带已答进度） */}
          {exitConfirm.open && (
            <Modal open onClose={() => setExitConfirm({ open: false, answered: 0 })} title="退出练习">
              <p className="text-sm text-[var(--text-secondary)]">
                已答 {exitConfirm.answered}/{questions.length} 题，退出后未作答的题目不再保留。确定退出吗？
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={() => setExitConfirm({ open: false, answered: 0 })}
                  className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
                >
                  继续答题
                </button>
                <button
                  onClick={() => {
                    setGuardEnabled(false);
                    navigate('/student/training/targeted', { replace: true });
                  }}
                  className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)]"
                >
                  确认退出
                </button>
              </div>
            </Modal>
          )}
          {/* 浏览器返回/路由跳转拦截（X 确认已 setGuardEnabled(false) 故不二次弹） */}
          <RunExitGuard
            enabled={guardEnabled}
            title="离开练习"
            message="退出后未作答的题目将不再保留，确定要离开吗？"
            confirmLabel="确认离开"
          />
```

- [ ] **Step 4: ErrorPracticeRunPage 退出接线（镜像 Step 3）**

与 Step 3 完全同构，差异仅两处：
- 确认退出 navigate 目标：`'/student/training/errors'`（replace: true）。
- 其余文案/结构一致。

- [ ] **Step 5: ExamRunPage 退出守卫（无 X，只拦截）**

1. import 区追加：

```ts
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
```

2. state 区追加：

```ts
  // 交卷成功跳结果页前放行导航（先置 false 再 navigate，绕开 RunExitGuard 拦截）
  const [guardEnabled, setGuardEnabled] = useState(true);
```

3. `handleSubmitExam`（约 139-150 行）成功分支，把：

```ts
      await submitExamSession(sid);
      navigate(`/student/training/exam/result/${sid}`, { replace: true });
```

改为：

```ts
      await submitExamSession(sid);
      setGuardEnabled(false);
      navigate(`/student/training/exam/result/${sid}`, { replace: true });
```

4. JSX 末尾（`{submitError && ...}` 块之后、外层 `</div>` 之前）追加：

```tsx
        {/* 考试无页内退出；拦截浏览器返回/刷新（计时不停，可续考） */}
        <RunExitGuard
          enabled={guardEnabled}
          blockBeforeUnload
          title="离开考试"
          message="离开后计时不会暂停，可从考试列表续考返回。确认离开吗？"
          confirmLabel="确认离开"
          cancelLabel="继续考试"
        />
```

- [ ] **Step 6: lint + build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 均通过。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/business/answer/RunExitGuard.tsx apps/web/src/components/business/answer/QuestionRunner.tsx apps/web/src/pages/student/training/TargetedRunPage.tsx apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx apps/web/src/pages/student/training/ExamRunPage.tsx
git commit -m "feat(web): 答题页退出确认 + 浏览器返回拦截 + 考试防刷新"
```

---

### Task 8: 列表/配置页顶部留白 + 全量验证

**Files:**
- Modify: `apps/web/src/pages/student/training/ExamListPage.tsx:214`
- Modify: `apps/web/src/pages/student/training/ErrorPracticePage.tsx:167`
- Modify: `apps/web/src/pages/student/training/TargetedConfigPage.tsx:186`

- [ ] **Step 1: 三个页面容器加 pt**

- `ExamListPage.tsx:214`：`<div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pb-16">` → `<div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pt-6 sm:pt-8 pb-16">`
- `ErrorPracticePage.tsx:167`：`<div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pb-32">` → 同位置加 `pt-6 sm:pt-8 `（保持 pb-32 不变）。
- `TargetedConfigPage.tsx:186`：`<div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pb-16">` → 同 ExamListPage 改法。

（TrainingHomePage 无 PageHeader（居中卡片页），不涉及；StarMapPage 为风格基准页，不动。）

- [ ] **Step 2: 全量验证**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 均通过。

Run: `cd apps/server && npm test`
Expected: 全绿。

- [ ] **Step 3: 浏览器走查（dev server 起着的前提下）**

逐项确认：顶部/底部留白舒适；题面 18px；长题面内部滚动、答题区 ≥280px 可用；提示按钮 → 看过提示后浮现解析按钮 → 点解析出抽屉；X 退出弹确认（含已答数）；浏览器返回被拦截弹确认；考试刷新弹原生确认；列表页 PageHeader 顶部有留白。发现问题回改对应 Task。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/student/training/ExamListPage.tsx apps/web/src/pages/student/training/ErrorPracticePage.tsx apps/web/src/pages/student/training/TargetedConfigPage.tsx
git commit -m "fix(web): 训练轨列表/配置页 PageHeader 顶部留白"
```
