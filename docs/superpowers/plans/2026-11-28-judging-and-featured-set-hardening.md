# 判题稳定性与精选题单收敛实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先恢复普通判题和结果页的确定性，再以不可复用 publication 投递修正精选题单的页面、运行时和数据库设计。

**Architecture:** 第一步只给精选列缺失做窄降级，并删除结果页的解析等待/刷新链路；第二步修正未执行的精选迁移和仓储语义，让一次发布对应一个不可复用 publication ID，同时保持单一判题入口和现有自评状态机。

**Tech Stack:** NestJS + TypeScript、mysql2/promise、Vitest、React + Vite + Testing Library、MySQL 8、Markdown/OpenAPI 文档。

## Global Constraints

- 设计真源：`docs/superpowers/specs/2026-11-28-judging-and-featured-set-hardening-design.md`；与本文冲突时以该 spec 为准。
- 第一步可以独立上线，不得要求先执行精选迁移；第二步迁移顺序固定为“改 migration/schema → 手工执行 migration → schema reconcile → 部署代码”。
- `isFeaturedSession` 只降级 `ER_BAD_FIELD_ERROR` 且消息包含 `featured_publication_id`；`ER_NO_SUCH_TABLE` 和其他异常必须冒泡。
- 客观题对错只读 `questions.answer/options`；解析只读 `questions.explanation`；主观题继续 self-assessment，不做程序字符串全等。
- 结果页只在已有解析时显示【查看解析】，不显示“正在生成中…”，不显示解析刷新，不调用 `explanation-wait`。
- `suppressErrorFixPoints` 保留给 redo；精选压分只信服务端 `sessionUid + studentId` 对应 session，客户端 `false` 不能解除精选压分。
- `featured_question_set_publications` 的有效 publication 由 `withdrawn_at IS NULL` 判定；撤回后同 set/grade 再次发布必须新增 ID。
- 同一 set/grade 已有效时重复发布只改标题，不改 `published_at/reach_count/published_by/withdrawn_at`，返回原 publicationId。
- 不删除 `featured_question_set_reads`；`featured_publication_id` 外键从 `ON DELETE SET NULL` 改为 `ON DELETE RESTRICT`。
- 每个任务先写失败测试、确认失败、写最小实现、确认通过、单独提交。
- 当前工作区已有未提交的数据管线改动和 `docs/ai-core-changelog.md` 改动，不属于本计划，严禁覆盖、回退或夹带提交。
- 不用 emoji；不使用小程序；UI 不使用装饰元素。提交信息使用中文 `fix/test/feat/docs` 前缀。
- 后端验证在 `apps/server` 下运行；前端验证在 `apps/web` 下运行；DDL 批次最终必须运行 `python3 tools/db/schema_reconcile.py`。

---

## 文件结构

### 第一步：判题稳定化

- `apps/server/src/database/repositories/special-practice-sessions.repo.ts`：精选列缺失的窄降级。
- `apps/server/src/database/repositories/special-practice-sessions.repo.test.ts`：错误码边界测试。
- `apps/web/src/components/business/AnswerResultList.tsx`：解析可见性、移除题号、通用 `footerExtra`。
- `apps/web/src/components/business/AnswerResultList.test.tsx`：解析/题号/底栏渲染测试。
- `apps/web/src/pages/student/training/TargetedRunPage.tsx`：把推荐按钮移到底栏，移除解析等待依赖。
- `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`：移除解析等待依赖。
- `apps/web/src/components/business/CleanupPhase.tsx`：移除解析等待依赖。
- `apps/web/src/pages/student/training/ExamResultPage.tsx`：移除解析等待依赖。

### 第二步：精选题单收敛

- `tools/db/migrations/2026-11-28_curated_question_sets.sql`：publication 改为不可复用投递，修正索引和外键。
- `tools/db/schema.sql`：同步迁移结构。
- `apps/server/src/database/repositories/featured-question-sets.repo.ts`：移除 `status` 列语义，改写 publication 查询和发布分支。
- `apps/server/src/database/repositories/featured-question-sets.repo.test.ts`：覆盖状态映射和四种发布分支。
- `apps/server/src/modules/featured-sets/featured-delivery.service.ts`：固定重复 open 的 session/read 语义。
- `tools/db/featured_question_set_metrics.sql`：固定完成数去重口径。
- API、数据库、PRD 实现注、约束和 changelog：同步最终口径。

---

## 发布检查点 A

Task 1～5 完成后：

- 不执行任何数据库迁移，普通专项仍能判题。
- 结果页不等待解析，不出现刷新入口。
- 题号与推荐按钮布局符合最终页面要求。
- 先部署或手工验收本阶段，再进入数据库重构。

---

### Task 1: 精选列缺失时安全降级

**Files:**
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.ts:1-170`
- Test: `apps/server/src/database/repositories/special-practice-sessions.repo.test.ts:152-171`

**Interfaces:**
- Consumes: 现有 `isFeaturedSession(sessionUid: string, studentId: number): Promise<boolean>`。
- Produces: 同一签名不变；仅在错误码 `ER_BAD_FIELD_ERROR` 且消息包含 `featured_publication_id` 时返回 `false`。

- [ ] **Step 1: 写失败测试**

在 `special-practice-sessions.repo.test.ts` 的 `isFeaturedSession` 用例后增加：

```ts
it('isFeaturedSession：精选列尚未迁移时返回 false', async () => {
  const pool = mockPool();
  pool.execute.mockRejectedValueOnce(Object.assign(
    new Error("Unknown column 'featured_publication_id' in 'field list'"),
    { code: 'ER_BAD_FIELD_ERROR' },
  ));
  const repo = new SpecialPracticeSessionsRepository(pool as any);

  await expect(repo.isFeaturedSession('u-1', 7)).resolves.toBe(false);
});

it('isFeaturedSession：ER_NO_SUCH_TABLE 继续抛出', async () => {
  const pool = mockPool();
  const err = Object.assign(
    new Error("Table 'ai_k12.special_practice_sessions' doesn't exist"),
    { code: 'ER_NO_SUCH_TABLE' },
  );
  pool.execute.mockRejectedValueOnce(err);
  const repo = new SpecialPracticeSessionsRepository(pool as any);

  await expect(repo.isFeaturedSession('u-1', 7)).rejects.toBe(err);
});

it('isFeaturedSession：其他列缺失错误继续抛出', async () => {
  const pool = mockPool();
  const err = Object.assign(
    new Error("Unknown column 'other_column' in 'field list'"),
    { code: 'ER_BAD_FIELD_ERROR' },
  );
  pool.execute.mockRejectedValueOnce(err);
  const repo = new SpecialPracticeSessionsRepository(pool as any);

  await expect(repo.isFeaturedSession('u-1', 7)).rejects.toBe(err);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:

```bash
cd apps/server && npx vitest run src/database/repositories/special-practice-sessions.repo.test.ts -t "isFeaturedSession"
```

Expected: 第一条新用例 FAIL，提示原 `ER_BAD_FIELD_ERROR` 被抛出；另外两条继续通过。

- [ ] **Step 3: 写最小实现**

在 `special-practice-sessions.repo.ts` 增加 `Logger` 导入与模块级判定函数：

```ts
import { HttpException, Injectable, Inject, Logger } from '@nestjs/common';

function isMissingFeaturedColumnError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return e.code === 'ER_BAD_FIELD_ERROR'
    && typeof e.message === 'string'
    && e.message.includes('featured_publication_id');
}
```

给类增加：

```ts
private readonly logger = new Logger(SpecialPracticeSessionsRepository.name);
private warnedMissingFeaturedColumn = false;
```

把 `isFeaturedSession` 改为：

```ts
async isFeaturedSession(sessionUid: string, studentId: number): Promise<boolean> {
  try {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT featured_publication_id
         FROM special_practice_sessions
        WHERE session_uid = ? AND student_id = ?`,
      [sessionUid, studentId],
    );
    return rows[0]?.featured_publication_id != null;
  } catch (err) {
    if (!isMissingFeaturedColumnError(err)) throw err;
    if (!this.warnedMissingFeaturedColumn) {
      this.warnedMissingFeaturedColumn = true;
      this.logger.warn('精选 schema 未迁移，判题按普通专项会话处理');
    }
    return false;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:

```bash
cd apps/server && npx vitest run src/database/repositories/special-practice-sessions.repo.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/special-practice-sessions.repo.ts \
        apps/server/src/database/repositories/special-practice-sessions.repo.test.ts
git commit -m "fix(training): 精选列缺失时恢复普通判题"
```

---

### Task 2: 解析按钮只按已有解析显示

**Files:**
- Modify: `apps/web/src/components/business/AnswerResultList.tsx:1-415`
- Modify: `apps/web/src/components/business/AnswerResultList.test.tsx:1-260`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx:16-355`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx:14-282`
- Modify: `apps/web/src/components/business/CleanupPhase.tsx:10-284`
- Modify: `apps/web/src/pages/student/training/ExamResultPage.tsx:8-305`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.test.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.test.tsx`
- Modify: `apps/web/src/components/business/CleanupPhase.test.tsx`
- Modify: `apps/web/src/pages/student/training/ExamResultPage.test.tsx`

**Interfaces:**
- Removes props: `questionIdOf?: (n: string) => number | null` 与 `onWaitExplanation?: (questionId: number) => Promise<string | null>`。
- Keeps props: `initialExplanations?: Record<string, string | null>`。
- Produces: `AnswerResultList` 只在 `explanations[q.n]` 非空时显示【查看解析】。

- [ ] **Step 1: 写失败的渲染测试**

在 `AnswerResultList.test.tsx` 增加：

```tsx
describe('AnswerResultList 解析入口', () => {
  it('客观错题无解析：不显示查看解析、生成中或刷新', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: false, method: 'exact', studentAnswer: 'B' } }}
        initialExplanations={{}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '查看解析' })).toBeNull();
    expect(screen.queryByText('正在生成中…')).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新解析' })).toBeNull();
  });

  it('客观错题有解析：显示查看解析', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: false, method: 'exact', studentAnswer: 'B' } }}
        initialExplanations={{ '1': '完整解析' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '查看解析' })).toBeTruthy();
  });

  it('主观题无解析：不显示查看解析', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '证明题' }]}
        answers={{ '1': { isCorrect: true, method: 'self_assess', studentAnswer: '作答' } }}
        initialExplanations={{}}
        referenceAnswers={{ '1': '参考答案' }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '查看解析' })).toBeNull();
  });

  it('主观题有解析：显示查看解析并可展开', async () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '证明题' }]}
        answers={{ '1': { isCorrect: true, method: 'self_assess', studentAnswer: '作答' } }}
        initialExplanations={{ '1': '完整解析' }}
        referenceAnswers={{ '1': '参考答案' }}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '查看解析' }));
    expect(screen.getByText('完整解析')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:

```bash
cd apps/web && npx vitest run src/components/business/AnswerResultList.test.tsx -t "解析入口"
```

Expected: “无解析”用例 FAIL，因为当前会显示“正在生成中…”或主观题固定按钮。

- [ ] **Step 3: 精简组件状态与 props**

从 `AnswerResultList.tsx` 删除：

- `onWaitExplanation`、`questionIdOf` 两个 props；
- `refreshingN`、`countdown` 状态；
- `REFRESH_TIMEOUT_SECONDS`、`formatCountdown`；
- 倒计时 effect 与 `handleRefresh`。

保留 `initialExplanations -> explanations` 的合并 effect。

把解析按钮渲染条件收敛为：

```tsx
const hasExplanation = !!explanation;
const objectiveWrong = !correct && !noAnswer && !unscored;
const showExplanationButton = !failed && hasExplanation && (subjective || objectiveWrong);
```

主观题和客观题共用一个按钮块：

```tsx
{showExplanationButton && (
  <div className="mt-2.5 flex items-center gap-2">
    <button
      onClick={() => setExpandedN(expanded ? null : q.n)}
      className="px-4 py-1.5 rounded-lg border border-[var(--warning)] bg-[var(--brand-100)] text-[var(--warning)] text-xs font-medium hover:bg-[var(--warning)] hover:text-white transition-colors"
    >
      {expanded ? '收起解析' : '查看解析'}
    </button>
  </div>
)}
```

删除原“正在生成中… / 刷新 / 暂无解析”分支。展开区仍按原逻辑显示参考答案和解析。
主观题的“我做对了 / 我做错了”自评按钮必须保持独立，不得因为解析为空而一起消失。

- [ ] **Step 4: 移除四个调用方的等待依赖**

在以下文件删除 `waitTrainingExplanation` import、`questionIdOf` 和 `onWaitExplanation` 传参：

- `TargetedRunPage.tsx`
- `ErrorPracticeRunPage.tsx`
- `CleanupPhase.tsx`
- `ExamResultPage.tsx`

对应测试 mock 中的 `waitTrainingExplanation: vi.fn()` 一并删除。

- [ ] **Step 5: 跑相关测试**

Run:

```bash
cd apps/web && npx vitest run \
  src/components/business/AnswerResultList.test.tsx \
  src/pages/student/training/TargetedRunPage.test.tsx \
  src/pages/student/training/ErrorPracticeRunPage.test.tsx \
  src/components/business/CleanupPhase.test.tsx \
  src/pages/student/training/ExamResultPage.test.tsx \
  src/pages/student/CourseDetailPage.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/business/AnswerResultList.tsx \
        apps/web/src/components/business/AnswerResultList.test.tsx \
        apps/web/src/pages/student/training/TargetedRunPage.tsx \
        apps/web/src/pages/student/training/TargetedRunPage.test.tsx \
        apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx \
        apps/web/src/pages/student/training/ErrorPracticeRunPage.test.tsx \
        apps/web/src/components/business/CleanupPhase.tsx \
        apps/web/src/components/business/CleanupPhase.test.tsx \
        apps/web/src/pages/student/training/ExamResultPage.tsx \
        apps/web/src/pages/student/training/ExamResultPage.test.tsx
git commit -m "fix(training): 结果页只显示题库已有解析"
```

---

### Task 3: 移除结果页题号并增加底部插槽

**Files:**
- Modify: `apps/web/src/components/business/AnswerResultList.tsx:15-415`
- Modify: `apps/web/src/components/business/AnswerResultList.test.tsx:58-165`

**Interfaces:**
- Produces: `footerExtra?: ReactNode`。
- Produces: 底栏根节点 `data-testid="answer-result-footer"`。
- Removes: `data-testid="result-qno-*"` 与题号展示。

- [ ] **Step 1: 改测试为验收新行为**

删除“每道题显示题号”的两个测试，替换为：

```tsx
it('结果列表不显示题号，但保留题干与状态', () => {
  render(
    <AnswerResultList
      questions={[{ n: '2', text: '题二' }]}
      answers={{ '2': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
      onClose={() => {}}
    />,
  );
  expect(screen.queryByTestId('result-qno-2')).toBeNull();
  expect(screen.getByText('题二')).toBeInTheDocument();
});

it('footerExtra 与导出、确认同处底部操作栏', () => {
  render(
    <AnswerResultList
      questions={[{ n: '1', text: '题面' }]}
      answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
      onClose={() => {}}
      onExport={() => {}}
      footerExtra={<button type="button">扩展操作</button>}
    />,
  );
  const footer = screen.getByTestId('answer-result-footer');
  expect(within(footer).getByRole('button', { name: '扩展操作' })).toBeInTheDocument();
  expect(within(footer).getByRole('button', { name: '导出 PDF' })).toBeInTheDocument();
  expect(within(footer).getByRole('button', { name: '确认' })).toBeInTheDocument();
});
```

在文件顶部确认从 Testing Library 导入 `within`。

- [ ] **Step 2: 跑测试确认失败**

Run:

```bash
cd apps/web && npx vitest run src/components/business/AnswerResultList.test.tsx -t "结果列表不显示题号|footerExtra"
```

Expected: FAIL，旧题号仍存在且 `footerExtra` 尚未定义。

- [ ] **Step 3: 实现组件变更**

在 Props 增加：

```tsx
/** 底部操作栏左侧扩展动作；考试结果页不传。 */
footerExtra?: ReactNode;
```

解构参数增加 `footerExtra`。

删除状态图标前的整个题号 `<span>` 元素（含 `data-testid={\`result-qno-${q.n}\`}`），
保留题干、状态图标与内容间距。

把 Footer 改为：

```tsx
<div
  data-testid="answer-result-footer"
  className={`shrink-0 px-5 py-3 border-t border-[var(--bg-subtle)] flex flex-wrap items-center gap-3 ${
    footerExtra ? 'justify-between' : 'justify-center'
  }`}
>
  {footerExtra && <div className="min-w-0">{footerExtra}</div>}
  <div className="ml-auto flex items-center justify-center gap-3">
    {onExport && (
      <button
        onClick={onExport}
        className="px-5 py-2.5 rounded-[10px] border border-[var(--bg-subtle)] text-sm font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-base)] transition-colors"
      >
        导出 PDF
      </button>
    )}
    <button
      onClick={onClose}
      className="px-8 py-2.5 rounded-[10px] bg-[var(--brand-500)] text-white text-sm font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
    >
      确认
    </button>
  </div>
</div>
```

- [ ] **Step 4: 跑组件测试**

Run:

```bash
cd apps/web && npx vitest run src/components/business/AnswerResultList.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/AnswerResultList.tsx \
        apps/web/src/components/business/AnswerResultList.test.tsx
git commit -m "fix(web): 结果页移除题号并增加底部操作插槽"
```

---

### Task 4: 推荐按钮移到底部操作栏

**Files:**
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx:306-355`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.test.tsx:642-661`

**Interfaces:**
- Consumes: `AnswerResultList` 的 `footerExtra?: ReactNode`。
- Produces: `data-testid="recommend-featured-slot"` 位于 `data-testid="answer-result-footer"` 内。

- [ ] **Step 1: 写失败测试**

在推荐按钮的 `it.each` 中增加位置断言：

```tsx
const footer = screen.getByTestId('answer-result-footer');
const recommend = within(footer).getByRole('button', { name: '推荐这套题' });
expect(recommend).toBeInTheDocument();
expect(recommend.closest('[data-testid="recommend-featured-slot"]')).not.toBeNull();
```

从 Testing Library 导入 `within`。

另加一条：

```tsx
it('推荐按钮不占用答题结果标题下方槽位', async () => {
  seed(77);
  completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });

  await answerOnlyQuestion();

  const slot = screen.getByTestId('recommend-featured-slot');
  expect(slot.closest('[data-testid="answer-result-footer"]')).not.toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:

```bash
cd apps/web && npx vitest run src/pages/student/training/TargetedRunPage.test.tsx -t "推荐按钮"
```

Expected: FAIL，推荐槽位当前仍在 `headerExtra`，不在 footer。

- [ ] **Step 3: 移动 JSX**

在 `TargetedRunPage` 的 `AnswerResultList` 中增加：

```tsx
footerExtra={
  <div data-testid="recommend-featured-slot">
    <RecommendFeaturedSetButton
      questionIds={(entries ?? []).map((q) => q.questionId)}
    />
  </div>
}
```

从 `headerExtra` 删除推荐按钮及其外层槽位。`headerExtra` 只保留：

- `needsRetry || unrecoverable` 的积分重试；
- `remediationOfferVisible` 的补偿套题卡。

如果这两个条件都不成立，`headerExtra` 必须传给组件 `undefined`，不能留下空 wrapper。

- [ ] **Step 4: 跑页面测试**

Run:

```bash
cd apps/web && npx vitest run src/pages/student/training/TargetedRunPage.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/training/TargetedRunPage.tsx \
        apps/web/src/pages/student/training/TargetedRunPage.test.tsx
git commit -m "fix(web): 精选题单推荐入口移至结果页底部"
```

---

### Task 5: 发布检查点 A 验证

**Files:**
- No source change.

**Interfaces:**
- Verifies: Task 1～4 的联合行为。

- [ ] **Step 1: 运行后端相关测试与构建**

Run:

```bash
cd apps/server && npx vitest run \
  src/database/repositories/special-practice-sessions.repo.test.ts \
  src/modules/training/training.service.test.ts && \
npx tsc --noEmit
```

Expected: 测试全绿、TypeScript 0 error。

- [ ] **Step 2: 运行前端相关测试与类型检查**

Run:

```bash
cd apps/web && npx vitest run \
  src/components/business/AnswerResultList.test.tsx \
  src/pages/student/training/TargetedRunPage.test.tsx \
  src/pages/student/training/ErrorPracticeRunPage.test.tsx \
  src/components/business/CleanupPhase.test.tsx \
  src/pages/student/training/ExamResultPage.test.tsx \
  src/pages/student/CourseDetailPage.test.tsx && \
npx tsc -b
```

Expected: 测试全绿、TypeScript 0 error。

- [ ] **Step 3: 在未执行精选迁移的库上手工验证普通判题**

以现有开发学生账号进入专项练习，提交一道选择题。Expected:

- 请求 `POST /api/training/judge` 返回 2xx；
- 结果页显示正确/错误，不长期停在“判题中”；
- 无解析的题不出现解析按钮；
- 不出现“正在生成中…”或刷新按钮。

- [ ] **Step 4: 发布检查点 A 记录**

不提交额外代码；仅在最终 changelog 任务记录验证结果。

---

## 发布检查点 B

只有检查点 A 验收通过后才执行 Task 6～11。本阶段会改数据库结构；失败时应停止部署，
保留已上线的第一步修复。

---

### Task 6: 重构未执行的精选数据库迁移

**Files:**
- Modify: `tools/db/migrations/2026-11-28_curated_question_sets.sql:57-139`
- Modify: `tools/db/schema.sql:1658-1723`

**Interfaces:**
- Produces: `featured_question_set_publications` 不再有 `status` 列。
- Produces: 普通可空 `active_publication_key VARCHAR(64)`、`uniq_fqsp_active`、`idx_fqsp_grade_active`。
- Produces: `special_practice_sessions.featured_publication_id` FK 使用 `ON DELETE RESTRICT`。

- [ ] **Step 1: 改 migration 的目标表结构**

把 `featured_question_set_publications` 的 `CREATE TABLE` 改为：

```sql
CREATE TABLE IF NOT EXISTS featured_question_set_publications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  grade_code VARCHAR(10) NOT NULL,
  title VARCHAR(60) NOT NULL,
  reach_count INT NOT NULL,
  published_by BIGINT NOT NULL,
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  withdrawn_by BIGINT DEFAULT NULL,
  withdrawn_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  active_publication_key VARCHAR(64) DEFAULT NULL
    COMMENT '有效投递固定为 set_id:grade_code；撤回时置 NULL',
  UNIQUE KEY uniq_fqsp_active (active_publication_key),
  KEY idx_fqsp_grade_active (grade_code, withdrawn_at, published_at),
  CONSTRAINT fk_fqsp_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsp_publisher FOREIGN KEY (published_by) REFERENCES admins (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fqsp_withdrawer FOREIGN KEY (withdrawn_by) REFERENCES admins (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 在 migration 中兼容已错误执行旧版的环境**

紧跟上述建表后加入幂等结构修正。该段在目标库 0 张精选表时全部是 no-op：

```sql
-- 旧唯一键会阻止“撤回后新增同 set/grade”，必须先删。
SET @has_old_uidx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'featured_question_set_publications'
    AND INDEX_NAME = 'uniq_fqsp_set_grade'
);
SET @ddl := IF(
  @has_old_uidx > 0,
  'ALTER TABLE featured_question_set_publications DROP INDEX uniq_fqsp_set_grade',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- status 索引依赖待删列，必须先删。
SET @has_old_status_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'featured_question_set_publications'
    AND INDEX_NAME = 'idx_fqsp_grade_status'
);
SET @ddl := IF(
  @has_old_status_idx > 0,
  'ALTER TABLE featured_question_set_publications DROP INDEX idx_fqsp_grade_status',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_status := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'featured_question_set_publications'
    AND COLUMN_NAME = 'status'
);
SET @ddl := IF(
  @has_status > 0,
  'ALTER TABLE featured_question_set_publications DROP COLUMN status',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_active_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'featured_question_set_publications'
    AND COLUMN_NAME = 'active_publication_key'
);
SET @ddl := IF(
  @has_active_col = 0,
  'ALTER TABLE featured_question_set_publications ADD COLUMN active_publication_key VARCHAR(64) DEFAULT NULL COMMENT ''有效投递固定为 set_id:grade_code；撤回时置 NULL''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_active_uidx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'featured_question_set_publications'
    AND INDEX_NAME = 'uniq_fqsp_active'
);
SET @ddl := IF(
  @has_active_uidx = 0,
  'ALTER TABLE featured_question_set_publications ADD UNIQUE KEY uniq_fqsp_active (active_publication_key)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_active_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'featured_question_set_publications'
    AND INDEX_NAME = 'idx_fqsp_grade_active'
);
SET @ddl := IF(
  @has_active_idx = 0,
  'ALTER TABLE featured_question_set_publications ADD KEY idx_fqsp_grade_active (grade_code, withdrawn_at, published_at)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

- [ ] **Step 3: 把特殊 session 外键改为 RESTRICT**

保留现有列/索引守卫；把外键段改为先检查 `DELETE_RULE`，不是 `RESTRICT` 时先删后建：

```sql
SET @fk_rule := COALESCE((
  SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'special_practice_sessions'
    AND CONSTRAINT_NAME = 'fk_sps_featured_publication'
), '');

SET @ddl := IF(
  @fk_rule <> '' AND @fk_rule <> 'RESTRICT',
  'ALTER TABLE special_practice_sessions DROP FOREIGN KEY fk_sps_featured_publication',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_rule := COALESCE((
  SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'special_practice_sessions'
    AND CONSTRAINT_NAME = 'fk_sps_featured_publication'
), '');

SET @ddl := IF(
  @fk_rule = '',
  'ALTER TABLE special_practice_sessions ADD CONSTRAINT fk_sps_featured_publication FOREIGN KEY (featured_publication_id) REFERENCES featured_question_set_publications (id) ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

- [ ] **Step 4: 同步 `schema.sql`**

把 `schema.sql` 中 `featured_question_set_publications` 的建表块改成与 Step 1 完全一致；
把 `special_practice_sessions` 外键 `ON DELETE SET NULL` 改为 `ON DELETE RESTRICT`。
`featured_question_set_publications` 不再出现 `status` 列。

- [ ] **Step 5: 应用两遍迁移并核对**

Run:

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && \
set -a; . tools/data-refinery/.env; set +a; \
MYSQL_PWD="$DB_PASS" mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" \
  -u "$DB_USER" "$DB_NAME" < tools/db/migrations/2026-11-28_curated_question_sets.sql && \
MYSQL_PWD="$DB_PASS" mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" \
  -u "$DB_USER" "$DB_NAME" < tools/db/migrations/2026-11-28_curated_question_sets.sql
```

Expected: 两次均 exit 0。

再运行：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && \
set -a; . tools/data-refinery/.env; set +a; \
MYSQL_PWD="$DB_PASS" mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" \
  -u "$DB_USER" "$DB_NAME" --batch --raw -e "
SHOW CREATE TABLE featured_question_set_publications;
SHOW CREATE TABLE special_practice_sessions;
"
```

Expected:

- 没有 `status`；
- 有 `active_publication_key`、`uniq_fqsp_active`、`idx_fqsp_grade_active`；
- 没有 `uniq_fqsp_set_grade`、`idx_fqsp_grade_status`；
- `fk_sps_featured_publication` 的 DELETE_RULE 是 `RESTRICT`。

- [ ] **Step 6: 跑 schema 对账**

Run:

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && python3 tools/db/schema_reconcile.py
```

Expected: 精选表与 `special_practice_sessions` 结构无差异；仅允许仓库既有的顺序差异噪音。

- [ ] **Step 7: Commit**

```bash
git add tools/db/migrations/2026-11-28_curated_question_sets.sql tools/db/schema.sql
git commit -m "fix(db): 精选题单改为不可复用 publication 投递"
```

---

### Task 7: 仓储改用 withdrawn_at 并收紧查询

**Files:**
- Modify: `apps/server/src/database/repositories/featured-question-sets.repo.ts:73-345, 460-646`
- Test: `apps/server/src/database/repositories/featured-question-sets.repo.test.ts`

**Interfaces:**
- `ReviewPublication.status: 'published' | 'withdrawn'` 保持 API 形状不变。
- 数据库判定改为 `withdrawn_at IS NULL`；所有学生可见查询必须带该条件。
- `withdraw(publicationId: number, reviewerId: number): Promise<void>` 只更新当前有效行。

- [ ] **Step 1: 改失败测试**

把旧断言 `status = 'published'` 改为：

```ts
expect(sql).toContain('withdrawn_at IS NULL');
```

增加：

```ts
it('getReviewSet 用 withdrawn_at 映射对外 status', async () => {
  const { repo, execute } = repoWithPool();
  execute
    .mockResolvedValueOnce([[{
      set_id: 7, subject_id: 1, subject_name: '数学', question_count: 1,
      review_status: 'approved', created_at: new Date(), recommendation_count: 0,
    }], []])
    .mockResolvedValueOnce([[], []])
    .mockResolvedValueOnce([[{
      question_id: 3, text: '题一', type: 'choice', answer: 'A', explanation: null,
    }], []])
    .mockResolvedValueOnce([[
      {
        publication_id: 22, grade_code: 'grade_7', title: '七年级',
        reach_count: 20, status: 'published', published_at: new Date(),
      },
      {
        publication_id: 21, grade_code: 'grade_7', title: '七年级旧投递',
        reach_count: 18, status: 'withdrawn', published_at: new Date(),
      },
    ], []]);

  const detail = await repo.getReviewSet(7);
  expect(detail?.publications.map((p) => p.status)).toEqual(['published', 'withdrawn']);
  const sql = sqlOf(execute.mock.calls[3]);
  expect(sql).toContain("WHEN p.withdrawn_at IS NULL THEN 'published'");
  expect(sql).toContain("ELSE 'withdrawn'");
});

it('withdraw 只更新 withdrawn_at IS NULL 的行', async () => {
  const conn = makeConn();
  conn.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);
  const { repo } = repoWithConn(conn);

  await repo.withdraw(22, 8);

  const [sql, params] = conn.execute.mock.calls[0];
  expect(sql).toContain('SET withdrawn_by = ?, withdrawn_at = NOW(3)');
  expect(sql).toContain('withdrawn_at IS NULL');
  expect(params).toEqual([8, 22]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:

```bash
cd apps/server && npx vitest run src/database/repositories/featured-question-sets.repo.test.ts
```

Expected: 旧 `status` SQL 断言或新映射断言 FAIL。

- [ ] **Step 3: 修改读查询**

`getReviewSet` 的 publication 明细 SQL 改为：

```sql
SELECT p.id AS publication_id, p.grade_code, p.title, p.reach_count,
       CASE WHEN p.withdrawn_at IS NULL THEN 'published' ELSE 'withdrawn' END AS status,
       p.published_at
  FROM featured_question_set_publications p
 WHERE p.set_id = ?
 ORDER BY p.published_at DESC, p.id DESC
```

以下查询把 `p.status = 'published'` 或 `p.status = 'published' AND ...`
统一替换为 `p.withdrawn_at IS NULL`：

- `listStudentPublications` 的 count 和 list；
- `unreadSummary` 的 count 和 latest；
- `findOpenPublication`。

- [ ] **Step 4: 修改撤回**

```ts
async withdraw(publicationId: number, reviewerId: number): Promise<void> {
  const conn = await this.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute<ResultSetHeader>(
      `UPDATE featured_question_set_publications
          SET withdrawn_by = ?, withdrawn_at = NOW(3)
        WHERE id = ? AND withdrawn_at IS NULL`,
      [reviewerId, publicationId],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 5: 跑仓储测试**

Run:

```bash
cd apps/server && npx vitest run src/database/repositories/featured-question-sets.repo.test.ts
```

Expected: 全部 PASS，且测试 SQL 中不再出现 `p.status` 或 `status = 'published'`。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/database/repositories/featured-question-sets.repo.ts \
        apps/server/src/database/repositories/featured-question-sets.repo.test.ts
git commit -m "refactor(featured): publication 状态改用 withdrawn_at"
```

---

### Task 8: 发布改为三分支且不删除 reads

**Files:**
- Modify: `apps/server/src/database/repositories/featured-question-sets.repo.ts:360-441`
- Test: `apps/server/src/database/repositories/featured-question-sets.repo.test.ts:217-268`

**Interfaces:**
- `publish(input: { setId; title; gradeCode; reviewerId; reachCount }): Promise<{ publicationId: number }>` 签名不变。
- 已有效同 set/grade：更新原行标题并返回原 ID。
- 无有效同 set/grade：插入新行并返回新 `insertId`。

- [ ] **Step 1: 写四个失败测试**

替换旧的 upsert/删除 reads 测试：

```ts
it('publish：有效同 set/grade 只更新标题，不覆盖发布快照', async () => {
  const conn = makeConn();
  conn.execute
    .mockResolvedValueOnce([[{ id: 5, review_status: 'pending' }], []])
    .mockResolvedValueOnce([[{ id: 22 }], []])
    .mockResolvedValueOnce([{ affectedRows: 1 }, []])
    .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
  const { repo } = repoWithConn(conn);

  await expect(repo.publish({
    setId: 5, title: '新标题', gradeCode: 'grade_8', reviewerId: 8, reachCount: 36,
  })).resolves.toEqual({ publicationId: 22 });

  expect(sqlOf(conn.execute.mock.calls[2])).toBe(
    'UPDATE featured_question_set_publications SET title = ? WHERE id = ? AND withdrawn_at IS NULL',
  );
  expect(paramsOf(conn.execute.mock.calls[2])).toEqual(['新标题', 22]);
  expect(conn.execute.mock.calls.some((c) => sqlOf(c).includes('INSERT INTO featured_question_set_publications'))).toBe(false);
});

it('publish：无有效 publication 时插入新行', async () => {
  const conn = makeConn();
  conn.execute
    .mockResolvedValueOnce([[{ id: 5, review_status: 'approved' }], []])
    .mockResolvedValueOnce([[], []])
    .mockResolvedValueOnce([{ insertId: 31, affectedRows: 1 }, []])
    .mockResolvedValueOnce([{ affectedRows: 0 }, []]);
  const { repo } = repoWithConn(conn);

  await expect(repo.publish({
    setId: 5, title: '重新发布', gradeCode: 'grade_8', reviewerId: 8, reachCount: 20,
  })).resolves.toEqual({ publicationId: 31 });

  expect(sqlOf(conn.execute.mock.calls[2])).toContain('INSERT INTO featured_question_set_publications');
  expect(paramsOf(conn.execute.mock.calls[2])).toEqual([5, 'grade_8', '重新发布', 20, 8]);
});

it('publish：撤回后再次发布不复用旧 ID，也不删 reads', async () => {
  const conn = makeConn();
  conn.execute
    .mockResolvedValueOnce([[{ id: 5, review_status: 'approved' }], []])
    .mockResolvedValueOnce([[], []])
    .mockResolvedValueOnce([{ insertId: 32, affectedRows: 1 }, []])
    .mockResolvedValueOnce([{ affectedRows: 0 }, []]);
  const { repo } = repoWithConn(conn);

  await expect(repo.publish({
    setId: 5, title: '第三轮', gradeCode: 'grade_8', reviewerId: 8, reachCount: 22,
  })).resolves.toEqual({ publicationId: 32 });

  expect(conn.execute.mock.calls.some((c) => sqlOf(c).includes('DELETE FROM featured_question_set_reads'))).toBe(false);
});

it('publish：rejected 题集禁止发布并 rollback', async () => {
  const conn = makeConn();
  conn.execute.mockResolvedValueOnce([[{ id: 5, review_status: 'rejected' }], []]);
  const { repo } = repoWithConn(conn);

  await expect(repo.publish({
    setId: 5, title: 'x', gradeCode: 'grade_8', reviewerId: 8, reachCount: 1,
  })).rejects.toThrow(/rejected/);

  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.execute.mock.calls.some((c) => sqlOf(c).includes('INSERT INTO featured_question_set_publications'))).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:

```bash
cd apps/server && npx vitest run src/database/repositories/featured-question-sets.repo.test.ts -t "publish"
```

Expected: 新分支测试 FAIL，当前实现仍使用 `ON DUPLICATE KEY UPDATE` 和删除 reads。

- [ ] **Step 3: 实现发布分支**

`publish` 事务核心逻辑：

```ts
const [setRows] = await conn.execute<(
  RowDataPacket & { id: number; review_status: ReviewStatus }
)[]>(
  `SELECT id, review_status FROM featured_question_sets WHERE id = ? FOR UPDATE`,
  [input.setId],
);
const set = setRows[0];
if (!set) throw new Error(`featured question set ${input.setId} not found`);
if (set.review_status === 'rejected') {
  throw new Error(`featured question set ${input.setId} is rejected`);
}

const [activeRows] = await conn.execute<(
  RowDataPacket & { id: number }
)[]>(
  `SELECT id
     FROM featured_question_set_publications
    WHERE set_id = ? AND grade_code = ? AND withdrawn_at IS NULL
    FOR UPDATE`,
  [input.setId, input.gradeCode],
);
const active = activeRows[0];

let publicationId: number;
if (active) {
  publicationId = Number(active.id);
  await conn.execute(
    `UPDATE featured_question_set_publications
        SET title = ?
      WHERE id = ? AND withdrawn_at IS NULL`,
    [input.title, publicationId],
  );
} else {
  const [insert] = await conn.execute<ResultSetHeader>(
    `INSERT INTO featured_question_set_publications
       (set_id, grade_code, title, reach_count, published_by, active_publication_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.setId, input.gradeCode, input.title, input.reachCount, input.reviewerId,
      `${input.setId}:${input.gradeCode}`,
    ],
  );
  publicationId = Number(insert.insertId);
  if (!publicationId) {
    throw new Error(`publication insert returned no id for set ${input.setId}`);
  }
}

await conn.execute<ResultSetHeader>(
  `UPDATE featured_question_sets
      SET review_status = 'approved', reviewed_by = ?, reviewed_at = NOW(3)
    WHERE id = ? AND review_status <> 'approved'`,
  [input.reviewerId, input.setId],
);

await conn.commit();
return { publicationId };
```

删除所有旧 upsert 回读 ID 和 `DELETE FROM featured_question_set_reads` 代码。

- [ ] **Step 4: 跑仓储与审核服务测试**

Run:

```bash
cd apps/server && npx vitest run \
  src/database/repositories/featured-question-sets.repo.test.ts \
  src/modules/featured-sets/featured-review.service.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/featured-question-sets.repo.ts \
        apps/server/src/database/repositories/featured-question-sets.repo.test.ts
git commit -m "fix(featured): 发布按不可复用投递分支写入"
```

---

### Task 9: 固定重复 open 与指标去重口径

**Files:**
- Modify: `apps/server/src/modules/featured-sets/featured-delivery.service.ts:28-112`
- Test: `apps/server/src/modules/featured-sets/featured-delivery.service.test.ts:108-188`
- Modify: `tools/db/featured_question_set_metrics.sql:1-29`

**Interfaces:**
- 每次 `open(studentId, publicationId)` 都生成新 `sessionUid` 并创建新专项 session。
- `markRead` 继续幂等。
- 完成数按 `(publication_id, student_id)` 去重，一条完成即可。

- [ ] **Step 1: 写回归测试**

在 `featured-delivery.service.test.ts` 增加：

```ts
it('同一学生重复 open：sessionUid 不同、session/read 各再写一次', async () => {
  const first = await service.open(9, 22);
  const second = await service.open(9, 22);

  expect(second.sessionUid).not.toBe(first.sessionUid);
  expect(specialSessions.upsertSession).toHaveBeenCalledTimes(2);
  expect(repository.markRead).toHaveBeenCalledTimes(2);
  expect(repository.markRead).toHaveBeenNthCalledWith(1, 22, 9, conn);
  expect(repository.markRead).toHaveBeenNthCalledWith(2, 22, 9, conn);
});
```

- [ ] **Step 2: 跑测试**

Run:

```bash
cd apps/server && npx vitest run src/modules/featured-sets/featured-delivery.service.test.ts -t "重复 open"
```

Expected: PASS（这是现有行为的回归钉）；若 FAIL，说明 open 被错误改成复用 session。

- [ ] **Step 3: 固定代码注释**

把 `FeaturedDeliveryService.open` 顶部注释改为：

```ts
/**
 * 每次打开都是一次新的专项作答事实：生成新的 sessionUid/session。
 * publication 已读用 INSERT IGNORE 幂等；完成率在指标层按
 * (publication_id, student_id) 去重，不按 session 数累加。
 */
```

- [ ] **Step 4: 固定指标 SQL**

把完成数子查询改成显式 `COUNT(DISTINCT CONCAT(...))`：

```sql
(SELECT COUNT(DISTINCT CONCAT(featured_publication_id, ':', student_id))
   FROM special_practice_sessions
  WHERE featured_publication_id IS NOT NULL
    AND completed_at IS NOT NULL
    AND started_at >= @window_start) AS completed_count;
```

其他三个指标的既有窗口口径不变。

- [ ] **Step 5: 跑投递服务测试**

Run:

```bash
cd apps/server && npx vitest run src/modules/featured-sets/featured-delivery.service.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/featured-sets/featured-delivery.service.ts \
        apps/server/src/modules/featured-sets/featured-delivery.service.test.ts \
        tools/db/featured_question_set_metrics.sql
git commit -m "test(featured): 钉住重复打开与完成数去重"
```

---

### Task 10: 同步契约、设计文档与硬约束

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-数据库设计文档.md`
- Modify: `docs/K12智学系统-产品需求文档.md`
- Modify: `docs/superpowers/specs/2026-11-28-curated-question-set-design.md`
- Modify: `docs/constraints/专项子系统.md`
- Modify: `docs/ai-core-changelog.md`

**Interfaces:**
- API 路径与状态枚举不变；只改 publication 重发语义、指标口径和实现注。
- 数据库文档描述 `withdrawn_at`、生成唯一键、RESTRICT 外键。

- [ ] **Step 1: 更新 API 设计与 OpenAPI 描述**

在 student/open、research/publish、withdraw 相关说明中写明：

- 有效 publication = `withdrawn_at IS NULL`；
- 同 set/grade 已有效时只更新标题并返回原 ID；
- 撤回后再次发布创建新 ID；
- 旧 reads/session 不迁移、不删除；
- 响应 `status` 仍为 `published|withdrawn`。

`openapi.yaml` 只同步描述，不新增路径、不改 operationId、不改成功状态码。

- [ ] **Step 2: 更新数据库设计文档**

同步：

- 删除 publication `status` 列；
- 增加 `active_publication_key` 和两个索引；
- `featured_publication_id` 外键改 RESTRICT；
- 重发新增 publication；
- 删除已被引用题集会被 RESTRICT 阻断，运营只撤回。

- [ ] **Step 3: 更新旧精选题设计稿与 PRD 实现注**

在 `2026-11-28-curated-question-set-design.md` 明确其 §4.4/§6.2 中“复用 publication、删 reads”的旧口径被新 spec 取代。

PRD §7.16 只补实现注，不改变用户可见产品规则：

- 重发形成新未读投递；
- 重复打开保留多次作答事实；
- 完成指标按学生和 publication 去重。

- [ ] **Step 4: 更新专项约束**

在 `docs/constraints/专项子系统.md` 的精选段补三条硬约束：

```md
- 通用判题不得因精选 schema 缺失而 500；只允许对 `featured_publication_id` 缺失做窄降级，核心表缺失必须冒泡。
- 结果页解析只读 `questions.explanation`；为空时不显示入口，不等待、不触发生成。
- `featured_question_set_publications` 是一次投递身份；撤回后重发必须新增行，禁止复用旧 ID、覆盖发布快照或删除旧 reads。
```

- [ ] **Step 5: 更新 changelog**

在 `docs/ai-core-changelog.md` 新增 2026-11-28 条目，记录：

- 1054 根因与通用判题耦合；
- 解析等待退出结果页；
- 题号移除与推荐按钮底栏；
- publication 不可复用投递；
- 重复 open 与完成率去重；
- 检查点 A/B 验证结果。

注意：该文件当前有用户未提交改动，只追加本条目，不回退其他内容。

- [ ] **Step 6: 检查 API 文档同步**

Run:

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && \
rg -n "featured-sets|publications/:id|withdraw|featured_publication_id" \
  docs/API接口与数据流设计文档.md docs/api/openapi.yaml
```

Expected: 端点集合一致；不存在新增或缺失的 operation。

- [ ] **Step 7: Commit**

```bash
git add docs/API接口与数据流设计文档.md \
        docs/api/openapi.yaml \
        docs/K12智学系统-数据库设计文档.md \
        docs/K12智学系统-产品需求文档.md \
        docs/superpowers/specs/2026-11-28-curated-question-set-design.md \
        docs/constraints/专项子系统.md \
        docs/ai-core-changelog.md
git commit -m "docs(featured): 同步判题与精选投递口径"
```

---

### Task 11: 全量验证与曳光弹

**Files:**
- No source change unless verification exposes a defect.

**Interfaces:**
- Verifies: 普通判题、解析按钮、结果页布局、精选投递、零订正积分、历史与指标。

- [ ] **Step 1: 后端全量验证**

Run:

```bash
cd apps/server && npm test && npm run build
```

Expected: 0 failed，build exit 0。

- [ ] **Step 2: 前端全量验证**

Run:

```bash
cd apps/web && npm test && npm run lint && npm run build
```

Expected: 0 failed；lint 0 error；build exit 0。若存在与本批无关的既有 lint error，记录文件与基线后单独向用户报告，不得伪称通过。

- [ ] **Step 3: 数据库结构与迁移重复执行**

Run:

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && \
set -a; . tools/data-refinery/.env; set +a; \
MYSQL_PWD="$DB_PASS" mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" \
  -u "$DB_USER" "$DB_NAME" < tools/db/migrations/2026-11-28_curated_question_sets.sql && \
python3 tools/db/schema_reconcile.py
```

Expected: 迁移 exit 0；结构差异 0。

- [ ] **Step 4: 走通曳光弹**

用匹配年级的学生、教研员和至少一个未清错题执行：

1. 完成 3 题专项练习；
2. 在结果页底部点击【推荐这套题】；
3. 教研审核页看到该题集和推荐年级分布；
4. 发布到匹配年级；
5. 个人中心出现未读精选题单；
6. 训练首页出现未读 Banner；
7. 打开题单并完成作答；
8. 确认结果页无题号、底部有推荐/PDF/确认；
9. 确认无解析题不显示解析按钮；
10. 答错题进入错题本；
11. 答对未清错题后错题清零，但 `point_ledger` 不新增 `error_fix`；
12. 撤回 publication，再重新发布；
13. 确认新 publication ID 与旧 ID 不同，旧 session 仍指向旧 ID；
14. 同一学生重复打开新 publication 两次，确认两条 session 但完成数只计一次。

- [ ] **Step 5: 检查零订正积分**

在完成曳光弹前记下测试学生 ID 与 publication ID，执行：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && \
set -a; . tools/data-refinery/.env; set +a; \
MYSQL_PWD="$DB_PASS" mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" \
  -u "$DB_USER" "$DB_NAME" --batch --raw -e "
SET @student_id := (
  SELECT student_id
    FROM special_practice_sessions
   WHERE featured_publication_id IS NOT NULL
   ORDER BY started_at DESC, id DESC
   LIMIT 1
);
SET @publication_id := (
  SELECT featured_publication_id
    FROM special_practice_sessions
   WHERE student_id = @student_id
     AND featured_publication_id IS NOT NULL
   ORDER BY started_at DESC, id DESC
   LIMIT 1
);
SELECT COUNT(*) AS featured_sessions
  FROM special_practice_sessions
 WHERE student_id = @student_id
   AND featured_publication_id = @publication_id;
SELECT COUNT(*) AS error_fix_ledger_rows
  FROM point_ledger
 WHERE student_id = @student_id
   AND task_code = 'error_fix'
   AND created_at >= NOW() - INTERVAL 30 MINUTE;
"
```

Expected:

- `featured_sessions > 0`；
- 若该学生此前 30 分钟没有其它普通订正分，则 `error_fix_ledger_rows = 0`；
- 若基线不为 0，先记录基线再对比增量，不能把历史行误判为本轮发分。

- [ ] **Step 6: 最终差异检查**

Run:

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && \
git status --short && git diff --check
```

Expected:

- 只剩用户原有未提交的数据管线与 changelog 改动；
- 本计划产生的文件均已提交；
- 无空白错误。

- [ ] **Step 7: 处理验证失败**

若任一步失败，不创建“最终修正”大杂烩提交。回到对应 Task，先写能复现失败的测试，
再按该 Task 的 TDD 步骤修实现并提交。若全部通过且没有文件变化，不创建空提交。
