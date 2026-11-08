# 语文「同类型练习」开放 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**执行状态**：7 个任务已实现并验证（2026-11-08，commits a2f2b910..8709aad8）；下方勾选未逐项回填，以 git 历史为准。

**Goal:** 让语文套卷里「积累与运用 / 古诗文」类题在练习记录详情页支持「同类型练习」，只从题库抽题、按 `cn_targeted` 1/3/5 档发分。

**Architecture:** 判定与抽题都放后端：知识点归属按顶层 code（C01/C02 开放，C03/C04 关闭）判定；详情接口下发 `canSimilar`，抽题 SQL 用同一条口径过滤候选题；语文不调用 AI 变式。前端只按 `canSimilar` 显示按钮，档位任务码按学科配置取 `cn_targeted`。

**Tech Stack:** NestJS + mysql2（pool.query）、React 18 + Vitest、MySQL 8。

## Global Constraints

- **不要切换分支、不要 `git add -A`**：当前分支 `feat/freeform-solve` 有他人未提交的「做题入口」改动。每个 commit 只 `git add` 本任务「Files」列出的文件。
- 无表结构变更、无数据迁移；不改积分规则。
- 语文**不新增** AI 变式 prompt / 模型路由。
- 数学(1)/物理(4) 的判定、抽题、AI 补题、档位行为必须逐字不变。
- 文案不用 emoji；UI 改动沿用现有 token 与现有按钮。
- 文档改动必须与代码同批提交（`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 同步）。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `apps/server/src/common/subject-config.ts` | 新增「支持同类型练习的学科」与「语文开放的知识点顶层 code」两个常量 |
| `apps/server/src/common/chinese-similar.util.ts`（新建） | 纯函数：给定一道题的知识点，判断语文可否同类型并返回种子 KP |
| `apps/server/src/database/repositories/questions.repo.ts` | 批量取知识点归属；随机抽题支持「所有知识点必须在指定顶层模块」 |
| `apps/server/src/modules/practice-history/practice-history.service.ts` | 详情接口 `canSimilar` 分学科判定 |
| `apps/server/src/modules/training/history-practice.service.ts` | 同类型抽题：白名单加语文、种子校验、跳过 AI |
| `apps/server/src/database/repositories/special-practice-sessions.repo.ts` | `SpecialSessionModule` 增加 `cn_targeted` |
| `apps/server/src/modules/training/training.service.ts` | 判题落记录时语文映射 `module='cn_targeted'` |
| `apps/web/src/subjectConfig.ts` | 前端同口径的学科名单常量 |
| `apps/web/src/pages/student/PracticeHistoryDetailPage.tsx` | 放行语文 + 按学科取任务码 |
| `docs/*` | PRD / API / openapi / changelog 同步 |

---

### Task 1: 判定原语与题库查询

**Files:**
- Modify: `apps/server/src/common/subject-config.ts`
- Create: `apps/server/src/common/chinese-similar.util.ts`
- Create: `apps/server/src/common/chinese-similar.util.test.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.ts:202-233`（抽题方法签名与 SQL）、文件末尾（新增方法）
- Test: `apps/server/src/database/repositories/questions.repo.test.ts`

**Interfaces:**
- Produces:
  - `SIMILAR_PRACTICE_SUBJECTS: ReadonlySet<number>`
  - `CN_SIMILAR_KP_ROOTS: readonly string[]`（`['C01','C02']`）
  - `chineseSimilarKpId(refs: Array<{ id: number; rootCode: string | null }>): number | null`
  - `QuestionsRepository.findKpRefsByQuestionIds(ids: number[]): Promise<Map<number, Array<{ id: number; rootCode: string | null }>>>`
  - `QuestionsRepository.findRandomByKpTypeDifficulty(..., opts?: { requireAllKpRootCodes?: string[] })`

- [ ] **Step 1: 写失败测试（纯函数 + 两个 repo 行为）**

新建 `apps/server/src/common/chinese-similar.util.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { chineseSimilarKpId } from './chinese-similar.util.js';

describe('chineseSimilarKpId', () => {
  it('全部知识点都在 C01/C02 -> 返回最小 id', () => {
    expect(chineseSimilarKpId([
      { id: 104, rootCode: 'C02' },
      { id: 88, rootCode: 'C01' },
    ])).toBe(88);
  });

  it('混入阅读(C03) 或写作(C04) -> null（整题不可练）', () => {
    expect(chineseSimilarKpId([
      { id: 88, rootCode: 'C01' },
      { id: 109, rootCode: 'C03' },
    ])).toBeNull();
    expect(chineseSimilarKpId([{ id: 124, rootCode: 'C04' }])).toBeNull();
  });

  it('无知识点 / rootCode 缺失 -> null', () => {
    expect(chineseSimilarKpId([])).toBeNull();
    expect(chineseSimilarKpId([{ id: 104, rootCode: null }])).toBeNull();
  });
});
```

在 `apps/server/src/database/repositories/questions.repo.test.ts` 的 `findRandomByKpTypeDifficulty` describe 内追加：

```ts
  it('requireAllKpRootCodes：追加 EXISTS + NOT EXISTS，参数顺序在排除 id 之前', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpTypeDifficulty(7, 2, 104, 'choice', [2], 3, [100], {
      requireAllKpRootCodes: ['C01', 'C02'],
    });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('COALESCE(pk2.code, kp2.code) IN (?,?)');
    expect(sql).toContain('COALESCE(pk3.code, kp3.code) NOT IN (?,?)');
    expect(params).toEqual([7, 2, 104, 'choice', 2, 'C01', 'C02', 'C01', 'C02', 100, 3]);
  });
```

在同一测试文件末尾追加：

```ts
describe('QuestionsRepository.findKpRefsByQuestionIds', () => {
  it('按题聚合知识点并带顶层 code', async () => {
    const pool = mockPool([
      { question_id: 100, id: 88, root_code: 'C01' },
      { question_id: 100, id: 109, root_code: 'C03' },
      { question_id: 200, id: 104, root_code: 'C02' },
    ]);
    const repo = new QuestionsRepository(pool as any);
    const map = await repo.findKpRefsByQuestionIds([100, 200]);
    expect(map.get(100)).toEqual([
      { id: 88, rootCode: 'C01' },
      { id: 109, rootCode: 'C03' },
    ]);
    expect(map.get(200)).toEqual([{ id: 104, rootCode: 'C02' }]);
  });

  it('空入参不发 SQL', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    expect(await repo.findKpRefsByQuestionIds([])).toEqual(new Map());
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('SQL 用父级 code 兜底自身 code', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findKpRefsByQuestionIds([1]);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('COALESCE(pk.code, kp.code) AS root_code');
    expect(sql).toContain('LEFT JOIN knowledge_points pk ON pk.id = kp.parent_kp_id');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/common/chinese-similar.util.test.ts src/database/repositories/questions.repo.test.ts`

Expected: 失败（`chinese-similar.util.js` 不存在 / `findKpRefsByQuestionIds is not a function`），已有 4 个抽题用例仍通过。

- [ ] **Step 3: 加常量与纯函数**

`apps/server/src/common/subject-config.ts` 末尾追加：

```ts
/** 支持「同类型练习」的学科：数学、物理、语文（语文仅基础运用/古诗文类知识点）。 */
export const SIMILAR_PRACTICE_SUBJECTS: ReadonlySet<number> = new Set([
  SUBJECT_MATH, SUBJECT_CHINESE, SUBJECT_PHYSICS,
]);

/** 语文同类型练习开放的顶层知识点 code：积累与运用 / 古诗文。 */
export const CN_SIMILAR_KP_ROOTS: readonly string[] = ['C01', 'C02'];
```

新建 `apps/server/src/common/chinese-similar.util.ts`：

```ts
import { CN_SIMILAR_KP_ROOTS } from './subject-config.js';

export interface QuestionKpRef {
  id: number;
  /** 所属顶层知识点 code（二级取父级 C0x，顶层取自身 C0x）；NULL = 无法归类。 */
  rootCode: string | null;
}

/**
 * 语文「同类型练习」的可用知识点。
 *
 * 只有**所有**知识点都落在 C01（积累与运用）/ C02（古诗文）才算可练；
 * 混入 C03（现代文阅读）/ C04（写作）或无法归类的一律不可练——跨模块题多为
 * 阅读题被顺带打了基础标签，放宽会违背「排除阅读理解」的产品口径（2026-11-08）。
 * 通过时返回 id 最小的知识点（种子 KP）。
 */
export function chineseSimilarKpId(refs: QuestionKpRef[]): number | null {
  if (refs.length === 0) return null;
  let minId: number | null = null;
  for (const r of refs) {
    if (!r.rootCode || !CN_SIMILAR_KP_ROOTS.includes(r.rootCode)) return null;
    if (minId === null || r.id < minId) minId = r.id;
  }
  return minId;
}
```

- [ ] **Step 4: 改题库 repo**

修改 `findRandomByKpTypeDifficulty` 的签名（第 8 个参数）：

```ts
  async findRandomByKpTypeDifficulty(
    studentId: number,
    subjectId: number,
    kpId: number,
    type: string,
    difficulties: number[],
    count: number,
    excludeQuestionIds: number[],
    opts?: { requireAllKpRootCodes?: string[] },
  ): Promise<QuestionRow[]> {
```

在 `exclusion` 之后、`sql` 之前插入 `rootFilter` 构造，SQL 里放在 `shq.id IS NULL` 与 `exclusion` 之间：

```ts
    // 语文「同类型」：候选题的所有知识点都必须落在指定顶层 code（C01/C02）下，
    // 否则抽到的可能是同考点的现代文阅读题（2026-11-08）。
    const roots = opts?.requireAllKpRootCodes ?? [];
    const rootPlaceholders = roots.map(() => '?').join(',');
    const rootFilter = roots.length > 0
      ? ` AND EXISTS (
            SELECT 1 FROM question_knowledge_points qkp2
            JOIN knowledge_points kp2 ON kp2.id = qkp2.knowledge_point_id
            LEFT JOIN knowledge_points pk2 ON pk2.id = kp2.parent_kp_id
            WHERE qkp2.question_id = q.id
              AND COALESCE(pk2.code, kp2.code) IN (${rootPlaceholders})
          )
          AND NOT EXISTS (
            SELECT 1 FROM question_knowledge_points qkp3
            JOIN knowledge_points kp3 ON kp3.id = qkp3.knowledge_point_id
            LEFT JOIN knowledge_points pk3 ON pk3.id = kp3.parent_kp_id
            WHERE qkp3.question_id = q.id
              AND (COALESCE(pk3.code, kp3.code) IS NULL
                   OR COALESCE(pk3.code, kp3.code) NOT IN (${rootPlaceholders}))
          )`
      : '';
```

SQL 行改为：

```ts
        AND shq.id IS NULL${rootFilter}${exclusion}
```

参数行改为：

```ts
      studentId, subjectId, kpId, type, ...difficulties,
      ...roots, ...roots, ...excludeQuestionIds, count,
```

文件末尾（`findKpIdsByQuestionIds` 之后）新增：

```ts
  /**
   * question_id -> 该题挂的全部知识点（id + 所属顶层 code）。
   * 语文「同类型练习」按顶层 code 判定可练范围（C01/C02 开放）；
   * 详情页与抽题共用同一口径。
   */
  async findKpRefsByQuestionIds(
    questionIds: number[],
  ): Promise<Map<number, Array<{ id: number; rootCode: string | null }>>> {
    if (questionIds.length === 0) return new Map();
    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.query<
      (RowDataPacket & { question_id: number; id: number; root_code: string | null })[]
    >(
      `SELECT qkp.question_id, kp.id, COALESCE(pk.code, kp.code) AS root_code
       FROM question_knowledge_points qkp
       JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
       LEFT JOIN knowledge_points pk ON pk.id = kp.parent_kp_id
       WHERE qkp.question_id IN (${placeholders})
       ORDER BY qkp.question_id, kp.id`,
      questionIds,
    );
    const map = new Map<number, Array<{ id: number; rootCode: string | null }>>();
    for (const r of rows) {
      const qid = Number(r.question_id);
      const list = map.get(qid) ?? [];
      list.push({ id: Number(r.id), rootCode: r.root_code ?? null });
      map.set(qid, list);
    }
    return map;
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/common/chinese-similar.util.test.ts src/database/repositories/questions.repo.test.ts`

Expected: 全绿；原有「正常难度数组」用例参数仍为 `[7, 1, 3, 'choice', 1, 3, 100, 201, 5]`（不传 opts 时 SQL 不变）。

- [ ] **Step 6: Commit**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add apps/server/src/common/subject-config.ts \
        apps/server/src/common/chinese-similar.util.ts \
        apps/server/src/common/chinese-similar.util.test.ts \
        apps/server/src/database/repositories/questions.repo.ts \
        apps/server/src/database/repositories/questions.repo.test.ts
git commit -m "feat(similar): add Chinese knowledge-point module predicate and pool filter"
```

---

### Task 2: 练习记录详情按学科下发 `canSimilar`

**Files:**
- Modify: `apps/server/src/modules/practice-history/practice-history.service.ts:103-148`（exam 分支）、`:150-207`（special 分支）
- Test: `apps/server/src/modules/practice-history/practice-history.service.test.ts`

**Interfaces:**
- Consumes: `chineseSimilarKpId`、`findKpRefsByQuestionIds`（Task 1）
- Produces: `PracticeHistoryQuestion.canSimilar` 对语文按 C01/C02 判定；数学/物理不变

- [ ] **Step 1: 写失败测试**

在 `make()` 的 `questionsRepo` mock 里加一行（供两个分支使用）：

```ts
    findKpRefsByQuestionIds: vi.fn().mockResolvedValue(new Map()),
```

在 `describe('PracticeHistoryService.getDetail ...')` 内追加三个用例：

```ts
  it('语文：所有知识点都在 C01/C02 → canSimilar=true', async () => {
    h.examSessionsRepo.findByIdOwned.mockResolvedValue(mkExamSession({ subject_id: 2 }));
    h.examSessionsRepo.findAnswersWithQuestions.mockResolvedValue([{
      question_id: 6950, question_order: 1, answer_text: 'A', is_correct: 1, score: 1,
      analysis: null, method: 'exact', judged_at: null, text: '文言实词题', type: 'choice',
      options: null, explanation: null, answer: 'A', material_text: null, is_active: 1,
    }]);
    h.questionsRepo.findKpRefsByQuestionIds.mockResolvedValue(new Map([
      [6950, [{ id: 88, rootCode: 'C01' }, { id: 104, rootCode: 'C02' }]],
    ]));

    const r = await h.service.getDetail({ studentId: 7, source: 'exam', sessionId: 1 });
    expect(r?.questions[0].canRedo).toBe(true);
    expect(r?.questions[0].canSimilar).toBe(true);
  });

  it('语文：混入现代文阅读知识点（C03）→ canSimilar=false', async () => {
    h.examSessionsRepo.findByIdOwned.mockResolvedValue(mkExamSession({ subject_id: 2 }));
    h.examSessionsRepo.findAnswersWithQuestions.mockResolvedValue([{
      question_id: 5230, question_order: 1, answer_text: 'A', is_correct: 0, score: 0,
      analysis: null, method: 'exact', judged_at: null, text: '阅读题', type: 'short_answer',
      options: null, explanation: null, answer: '参考答案', material_text: '阅读材料', is_active: 1,
    }]);
    h.questionsRepo.findKpRefsByQuestionIds.mockResolvedValue(new Map([
      [5230, [{ id: 88, rootCode: 'C01' }, { id: 109, rootCode: 'C03' }]],
    ]));

    const r = await h.service.getDetail({ studentId: 7, source: 'exam', sessionId: 1 });
    expect(r?.questions[0].canRedo).toBe(true);
    expect(r?.questions[0].canSimilar).toBe(false);
  });

  it('语文专项：题在架 + 全 C01/C02 → canSimilar=true', async () => {
    h.specialSessionsRepo.findByIdOwned.mockResolvedValue(mkSpecialSession({ subject_id: 2 }));
    h.specialAnswersRepo.listBySession.mockResolvedValue([{
      id: 1, session_id: 5, question_id: 6942, ref_type: 'question', ref_id: null,
      sentence_index: null, question_order: 1, answer_text: 'A',
      is_correct: 1, score: '1.00', method: 'exact', analysis: null, judged_at: null,
      question_content: '古诗默写', question_answer: 'A', question_analysis: null,
      question_is_active: 1,
    }]);
    h.questionsRepo.findKpRefsByQuestionIds.mockResolvedValue(new Map([
      [6942, [{ id: 102, rootCode: 'C02' }]],
    ]));

    const r = await h.service.getDetail({ studentId: 7, source: 'special', sessionId: 5 });
    expect(r?.questions[0].canSimilar).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/practice-history/practice-history.service.test.ts`

Expected: 新增三个用例失败（语文题 `canSimilar` 仍为 false）。

- [ ] **Step 3: 改 `getDetail`**

文件顶部 import：

```ts
import { SUBJECT_CHINESE, SUBJECT_MATH, SUBJECT_PHYSICS } from '../../common/subject-config.js';
import { chineseSimilarKpId } from '../../common/chinese-similar.util.js';
```

考试分支：把原来的 `kpMap` 查询与 `hasKp` 计算替换为：

```ts
      const questionIds = answers
        .map((a) => a.question_id)
        .filter((id): id is number => id != null);
      // 语文按「知识点顶层模块」判定（阅读/写作不开放）；数学/物理仍按「有知识点」。
      const isChinese = session.subject_id === SUBJECT_CHINESE;
      const kpMap = isChinese
        ? new Map<number, number>()
        : await this.questionsRepo.findKpIdsByQuestionIds(questionIds);
      const kpRefs = isChinese
        ? await this.questionsRepo.findKpRefsByQuestionIds(questionIds)
        : null;
```

映射里：

```ts
          const qid = a.question_id;
          const canRedo = qid != null && a.is_active === 1;
          const canSimilar = canRedo && (
            isChinese
              ? chineseSimilarKpId(kpRefs?.get(qid as number) ?? []) != null
              : (session.subject_id === SUBJECT_MATH || session.subject_id === SUBJECT_PHYSICS)
                && kpMap.has(qid as number)
          );
```

专项分支：同样把 `kpMap` 替换为（`answers` 变量名保持现有）：

```ts
    const questionIds = answers
      .map((a) => a.question_id)
      .filter((id): id is number => id != null);
    const isChinese = session.subject_id === SUBJECT_CHINESE;
    const kpMap = isChinese
      ? new Map<number, number>()
      : await this.questionsRepo.findKpIdsByQuestionIds(questionIds);
    const kpRefs = isChinese
      ? await this.questionsRepo.findKpRefsByQuestionIds(questionIds)
      : null;
```

映射里：

```ts
      const qid = a.question_id;
      const canRedo = qid != null && a.question_is_active === 1;
      const canSimilar = canRedo && (
        isChinese
          ? chineseSimilarKpId(kpRefs?.get(qid as number) ?? []) != null
          : (session.subject_id === SUBJECT_MATH || session.subject_id === SUBJECT_PHYSICS)
            && kpMap.has(qid as number)
      );
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/practice-history/practice-history.service.test.ts`

Expected: 全绿（含数学/物理/化学原有断言）。

- [ ] **Step 5: Commit**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add apps/server/src/modules/practice-history/practice-history.service.ts \
        apps/server/src/modules/practice-history/practice-history.service.test.ts
git commit -m "feat(similar): enable Chinese similar-practice flag for basic/classical questions"
```

---

### Task 3: 同类型抽题支持语文

**Files:**
- Modify: `apps/server/src/modules/training/history-practice.service.ts:75-227`
- Test: `apps/server/src/modules/training/history-practice.service.test.ts`

**Interfaces:**
- Consumes: `SIMILAR_PRACTICE_SUBJECTS`、`CN_SIMILAR_KP_ROOTS`、`chineseSimilarKpId`、`findKpRefsByQuestionIds`、`requireAllKpRootCodes`
- Produces: `startSimilar` 接受 `subjectId=2`；语文不调用 `variation.generate`

- [ ] **Step 1: 写失败测试**

在 `make()` 的 `questionsRepo` mock 里加：

```ts
    findKpRefsByQuestionIds: vi.fn().mockResolvedValue(new Map()),
```

在 `describe('HistoryPracticeService.startSimilar')` 内追加：

```ts
  it('语文：合法种子只抽题库，不触发 AI；3 题 -> tier_key=3', async () => {
    const { svc, questionsRepo, kpRepo, variation, trainingSessionsRepo, pointRules } = make();
    questionsRepo.findById.mockResolvedValue(mkQ({ subject_id: 2, type: 'choice' }));
    questionsRepo.findKpRefsByQuestionIds.mockResolvedValue(new Map([
      [100, [{ id: 104, rootCode: 'C02' }]],
    ]));
    kpRepo.findById.mockResolvedValue({ id: 104, name: '文言实词与虚词' });
    pointRules.listTierKeys.mockResolvedValue(['1', '3', '5', '10']);
    questionsRepo.findRandomByKpTypeDifficulty.mockResolvedValueOnce([
      { id: 201, content: '题1', type: 'choice', options: null, material_text: null },
      { id: 202, content: '题2', type: 'choice', options: null, material_text: null },
      { id: 203, content: '题3', type: 'choice', options: null, material_text: null },
    ]);

    const r = await svc.startSimilar({ studentId: 7, subjectId: 2, questionId: 100, count: 3 });

    expect(r.questions).toHaveLength(3);
    expect(variation.generate).not.toHaveBeenCalled();
    expect(questionsRepo.findRandomByKpTypeDifficulty).toHaveBeenCalledWith(
      7, 2, 104, 'choice', [2], 3, [100],
      { requireAllKpRootCodes: ['C01', 'C02'] },
    );
    expect(trainingSessionsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      task_code: 'cn_targeted', subject_id: 2, tier_key: '3', expected_count: 3,
    }));
  });

  it('语文：种子混入阅读知识点 -> 400，不抽题', async () => {
    const { svc, questionsRepo } = make();
    questionsRepo.findById.mockResolvedValue(mkQ({ subject_id: 2 }));
    questionsRepo.findKpRefsByQuestionIds.mockResolvedValue(new Map([
      [100, [{ id: 88, rootCode: 'C01' }, { id: 109, rootCode: 'C03' }]],
    ]));

    await expect(
      svc.startSimilar({ studentId: 7, subjectId: 2, questionId: 100, count: 3 }),
    ).rejects.toThrow('该题不在同类型练习范围');
    expect(questionsRepo.findRandomByKpTypeDifficulty).not.toHaveBeenCalled();
  });

  it('语文：只抽到 2 题 -> 按 1 题档发分', async () => {
    const { svc, questionsRepo, kpRepo, trainingSessionsRepo, pointRules } = make();
    questionsRepo.findById.mockResolvedValue(mkQ({ subject_id: 2 }));
    questionsRepo.findKpRefsByQuestionIds.mockResolvedValue(new Map([
      [100, [{ id: 102, rootCode: 'C02' }]],
    ]));
    kpRepo.findById.mockResolvedValue({ id: 102, name: '古诗文默写' });
    pointRules.listTierKeys.mockResolvedValue(['1', '3', '5', '10']);
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 201, content: '题1', type: 'choice', options: null, material_text: null }])
      .mockResolvedValueOnce([{ id: 202, content: '题2', type: 'choice', options: null, material_text: null }]);

    const r = await svc.startSimilar({ studentId: 7, subjectId: 2, questionId: 100, count: 5 });

    expect(r.questions).toHaveLength(2);
    expect(trainingSessionsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      tier_key: '1', expected_count: 2,
    }));
  });

  it('语文：count=2 不在该生档位 -> 400', async () => {
    const { svc, questionsRepo, kpRepo, pointRules } = make();
    questionsRepo.findById.mockResolvedValue(mkQ({ subject_id: 2 }));
    questionsRepo.findKpRefsByQuestionIds.mockResolvedValue(new Map([
      [100, [{ id: 102, rootCode: 'C02' }]],
    ]));
    kpRepo.findById.mockResolvedValue({ id: 102, name: '古诗文默写' });
    pointRules.listTierKeys.mockResolvedValue(['1', '3', '5', '10']);

    await expect(
      svc.startSimilar({ studentId: 7, subjectId: 2, questionId: 100, count: 2 }),
    ).rejects.toThrow('题量仅允许');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/history-practice.service.test.ts`

Expected: 语文用例失败（「该学科暂不支持同类型练习」）。

- [ ] **Step 3: 改 `startSimilar`**

import 增加：

```ts
import {
  CN_SIMILAR_KP_ROOTS, SIMILAR_PRACTICE_SUBJECTS, SUBJECT_CHINESE,
} from '../../common/subject-config.js';
import { chineseSimilarKpId } from '../../common/chinese-similar.util.js';
```

学科白名单：

```ts
    if (!SIMILAR_PRACTICE_SUBJECTS.has(input.subjectId)) {
      throw new BadRequestException('该学科暂不支持同类型练习');
    }
```

种子 KP 取法（替换原来的 `kpId` 两行）：

```ts
    let kpId: number;
    if (input.subjectId === SUBJECT_CHINESE) {
      const refs = (await this.questionsRepo.findKpRefsByQuestionIds([seed.id])).get(seed.id) ?? [];
      const allowedKpId = chineseSimilarKpId(refs);
      if (allowedKpId == null) {
        throw new BadRequestException('该题不在同类型练习范围（仅基础运用与古诗文）');
      }
      kpId = allowedKpId;
    } else {
      const found = (await this.questionsRepo.findKpIdsByQuestionIds([seed.id])).get(seed.id);
      if (found == null) throw new BadRequestException('题目没有知识点');
      kpId = found;
    }
```

抽题参数：在两次 `findRandomByKpTypeDifficulty` 之前定义：

```ts
    const poolOpts = input.subjectId === SUBJECT_CHINESE
      ? { requireAllKpRootCodes: [...CN_SIMILAR_KP_ROOTS] }
      : undefined;
```

两次调用末尾各加一个参数 `poolOpts`：

```ts
      [toDifficulty(seed.difficulty)], input.count, [seed.id], poolOpts,
```

```ts
        [seed.id, ...picked.map((q) => q.id)], poolOpts,
```

AI 补题整段加学科条件：

```ts
    if (input.subjectId !== SUBJECT_CHINESE && selected.length < input.count) {
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/history-practice.service.test.ts`

Expected: 全绿（数学/物理 AI 补题用例仍通过）。

- [ ] **Step 5: Commit**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add apps/server/src/modules/training/history-practice.service.ts \
        apps/server/src/modules/training/history-practice.service.test.ts
git commit -m "feat(similar): support Chinese bank-only similar practice"
```

---

### Task 4: 语文同类练习落记录的 `module` 归位

**Files:**
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.ts:5-7`
- Modify: `apps/server/src/modules/training/training.service.ts:205-208`
- Test: `apps/server/src/modules/training/training.service.test.ts`

**Interfaces:**
- Produces: `SpecialSessionModule` 含 `'cn_targeted'`；语文判题落 `module='cn_targeted'`

- [ ] **Step 1: 写失败测试**

在 `describe('TrainingService.judgeTraining — special_answer_records 旁路写入')` 内追加：

```ts
  it('语文 subjectId=2 映射 module=cn_targeted', async () => {
    const deps = mk({
      judgeCore: { judgeQuestion: vi.fn().mockResolvedValue(judgeResult) },
    });
    await mkSvc(deps).judgeTraining({
      studentId: 7, questionId: 100, subjectId: 2, studentAnswer: 'A', source: 'targeted',
      sessionUid: 'abc-cn', questionOrder: 1,
    });
    expect(deps.specialSessionsRepo.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      module: 'cn_targeted', subjectId: 2,
    }));
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts -t "cn_targeted"`

Expected: 失败（实际收到 `math_targeted`）。

- [ ] **Step 3: 改类型与映射**

`special-practice-sessions.repo.ts`：

```ts
/** 8 个 module 值（语文专项 + 三专项 + 英语 + 数/理/化专项）。 */
export type SpecialSessionModule =
  | 'chinese_dictation' | 'chinese_interpretation' | 'chinese_meaning'
  | 'en_vocabulary' | 'cn_targeted'
  | 'math_targeted' | 'physics_targeted' | 'chemistry_targeted';
```

`training.service.ts` import 增加 `SUBJECT_CHINESE`，映射改为：

```ts
      const module: SpecialSessionModule =
        input.subjectId === SUBJECT_CHINESE ? 'cn_targeted'
        : input.subjectId === 4 ? 'physics_targeted'
        : input.subjectId === 5 ? 'chemistry_targeted'
        : 'math_targeted';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`

Expected: 全绿（物理/数学用例不变）。

- [ ] **Step 5: Commit**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add apps/server/src/database/repositories/special-practice-sessions.repo.ts \
        apps/server/src/modules/training/training.service.ts \
        apps/server/src/modules/training/training.service.test.ts
git commit -m "fix(training): record Chinese targeted sessions as cn_targeted"
```

---

### Task 5: 前端放行语文并按学科取档位

**Files:**
- Modify: `apps/web/src/subjectConfig.ts`（末尾追加常量）
- Modify: `apps/web/src/pages/student/PracticeHistoryDetailPage.tsx:24-28`（import）、`:333-361`（档位 effect）
- Test: `apps/web/src/pages/student/PracticeHistoryDetailPage.test.tsx`

**Interfaces:**
- Consumes: `canSimilar`（Task 2）、`cn_targeted` 档位
- Produces: 语文详情显示按钮、面板只有 1/3/5

- [ ] **Step 1: 写失败测试**

在测试文件的 `MATH_RULES` 后加：

```ts
/** 语文专项只有 1/3/5 档（无 2 题档）。 */
const CN_RULES = {
  tasks: [{
    taskCode: 'cn_targeted',
    taskName: '语文专项',
    tiers: [
      { tierKey: '1', tierLabel: '1 题', points: 2, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '3', tierLabel: '3 题', points: 8, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '5', tierLabel: '5 题', points: 15, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
    ],
  }],
};
```

在 `describe('PracticeHistoryDetailPage')` 内追加：

```ts
  it('语文详情：显示同类型按钮，面板只有 1/3/5，按 cn_targeted 取档', async () => {
    getDetailMock.mockResolvedValue({
      session: { ...EXAM_SESSION, subjectId: 2, title: '语文期中卷' },
      questions: [{ ...UNANSWERED_QUESTION }],
    });
    getPointRulesMock.mockResolvedValue(CN_RULES);
    const user = userEvent.setup();
    renderAt('exam', '1');

    await user.click(await screen.findByRole('button', { name: '同类型练习' }));
    expect(screen.getByRole('button', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '5' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2' })).toBeNull();
  });

  it('语文详情：点题量请求同类型 + 跳转带 subjectId=2', async () => {
    getDetailMock.mockResolvedValue({
      session: { ...EXAM_SESSION, subjectId: 2, title: '语文期中卷' },
      questions: [{ ...UNANSWERED_QUESTION }],
    });
    getPointRulesMock.mockResolvedValue(CN_RULES);
    const questions = [{ questionId: 7001, text: '文言题', type: 'choice', options: ['A', 'B'], materialText: null }];
    startSimilarMock.mockResolvedValue({ questions, sessionId: 88, title: '同类练习：文言实词与虚词 · 3 题' });
    const user = userEvent.setup();
    renderAt('exam', '1');

    await user.click(await screen.findByRole('button', { name: '同类型练习' }));
    await user.click(screen.getByRole('button', { name: '3' }));

    await waitFor(() => expect(startSimilarMock).toHaveBeenCalledWith('exam', 1, 100, 3));
    const stub = await screen.findByTestId('run-stub');
    expect(stub).toHaveTextContent('subjectId=2');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/PracticeHistoryDetailPage.test.tsx`

Expected: 两个新用例失败（语文没有「同类型练习」按钮）。

- [ ] **Step 3: 改前端**

`apps/web/src/subjectConfig.ts` 末尾追加：

```ts
/** 支持「同类型练习」的学科（与后端 common/subject-config.ts 同口径）。 */
export const SIMILAR_PRACTICE_SUBJECTS: ReadonlySet<number> = new Set([
  SUBJECT_MATH, SUBJECT_CHINESE, SUBJECT_PHYSICS,
]);
```

`PracticeHistoryDetailPage.tsx` import 改为：

```ts
import {
  getTrainingSubject,
  SIMILAR_PRACTICE_SUBJECTS,
  TRAINING_SUBJECTS,
} from '@/subjectConfig';
```

（删掉不再使用的 `SUBJECT_MATH` / `SUBJECT_PHYSICS`，否则 `noUnusedLocals` 会报错。）

档位 effect 改为：

```ts
    // 同类型只开数学/物理/语文（语文仅基础运用与古诗文）；后端 canSimilar 已兜底，这里再挡一层
    if (!SIMILAR_PRACTICE_SUBJECTS.has(subjectId)) {
      setSimilarCounts([]);
      return;
    }
    const taskCode = getTrainingSubject(subjectId)?.targetedTaskCode;
    if (!taskCode) {
      setSimilarCounts([]);
      return;
    }
    if (!data.questions.some((q) => q.canSimilar)) {
      setSimilarCounts([]);
      return;
    }
    let cancelled = false;
    getMyPointRules()
      .then((rules) => {
        const tiers = rules.tasks.find((t) => t.taskCode === taskCode)?.tiers ?? [];
        const allowed = new Set(tiers.filter((t) => t.isActive).map((t) => t.tierKey));
        if (!cancelled) {
          setSimilarCounts(SIMILAR_COUNT_WHITELIST.filter((n) => allowed.has(String(n))));
        }
      })
      .catch(() => {
        if (!cancelled) setSimilarCounts([]);
      });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/PracticeHistoryDetailPage.test.tsx`

Expected: 全绿（数学 1/2/3/5 用例不变）。

- [ ] **Step 5: 类型检查**

Run: `cd apps/web && npx tsc -b`

Expected: 0 错误（`noEmit: true`，不会写 dist）。

- [ ] **Step 6: Commit**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add apps/web/src/subjectConfig.ts \
        apps/web/src/pages/student/PracticeHistoryDetailPage.tsx \
        apps/web/src/pages/student/PracticeHistoryDetailPage.test.tsx
git commit -m "feat(web): show similar practice for Chinese basic/classical questions"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `docs/K12智学系统-产品需求文档.md:132`
- Modify: `docs/API接口与数据流设计文档.md:768`、`:770`
- Modify: `docs/api/openapi.yaml:8157-8159`
- Modify: `docs/ai-core-changelog.md`（顶部 `---` 后插入新条目）

**Interfaces:** 无代码接口变化；只同步口径。

- [ ] **Step 1: 改 PRD §6.4**

把第 132 行：

```md
   - 本期开放数学、物理；化学待题库知识点回填后开放。物理题库较薄，不足部分主要由 AI 补。
```

改为：

```md
   - 本期开放数学、物理、语文。语文只开「积累与运用」「古诗文」两类知识点（现代文阅读与写作不开放，跨模块题按严格口径排除），**只从题库抽题、不 AI 补题**；数学/物理仍是题库优先、不足 AI 补。
   - 化学待题库知识点回填后开放。物理题库较薄，不足部分主要由 AI 补。
```

- [ ] **Step 2: 改 API 文档 §4.29**

第 768 行把 `canSimilar` 描述改为：

```md
6. **详情两个动作开关（2026-11-06；2026-11-08 扩语文）**：`canRedo` = 有 `questionId` 且该题在架（语文/英语专项无题 id → false）；`canSimilar` = `canRedo` 且（学科是数学/物理且该题有知识点，**或**学科是语文且该题**全部**知识点都属于「积累与运用(C01)/古诗文(C02)」——混入现代文阅读(C03)/写作(C04) 或无法归类一律 false）。**不要求原题有标准答案**。前端只按这两个布尔显示按钮，**不自行推断**；「同类型练习」还要求 `[1,2,3,5] ∩ 家长可用档位` 非空。
```

第 770 行把学科与任务码描述改为：

```md
8. **同类型练习（#4）**：先按「同学科 + 同知识点 + 同题型 + 同难度」抽题，不足再用难度阶梯 ±1 补齐；数学/物理仍不足由 AI 补（20s 硬上限、失败即降级只留题库题），**语文不 AI 补、题库有多少出多少**，且候选题必须同样满足「全部知识点在 C01/C02」。`count` 必须同时满足 `∈{1,2,3,5}` **且**在家长给该学生开的档位内（否则 400）；学科开放数学(1)/物理(4)/语文(2)，语文种子题不在 C01/C02 → 400。实际抽到题数 `actual > 0` **且**存在可用档位时建一条 `training_sessions`（`task_code` = `math_targeted`/`physics_targeted`/`cn_targeted`；`tier_key` 取最大可用档、`expected_count=actual`），答题页收尾 `complete` 按**实际题数**发档位分；建会话失败或不存在可用档位时 `sessionId:null`（照常出题）。0 题时 `questions:[]`、同样不建会话。
```

- [ ] **Step 3: 改 openapi**

`canSimilar.description` 改为：

```yaml
        canSimilar:
          type: boolean
          description: canRedo + 可练学科 + 知识点符合口径 -> 可同类型练习（数学/物理：有知识点；语文：全部知识点属积累与运用C01/古诗文C02；不要求原题有标准答案，2026-11-06 / 2026-11-08）
```

- [ ] **Step 4: 改 changelog**

在 `docs/ai-core-changelog.md` 的 `---` 之后、`## 2026-11-08 做题入口（自由做题 / freeform）` 之前插入：

```md
## 2026-11-08 语文「同类型练习」开放（基础运用 / 古诗文）

**入口**：练习记录详情页的「同类型练习」按钮。语文此前只显示「重做」，因为 `canSimilar` 只放行数学/物理。

**口径（刻意设计，勿改）**：
- 语文按**知识点顶层 code** 判定：`C01 积累与运用` / `C02 古诗文` 开放；`C03 现代文阅读` / `C04 写作` 关闭；一道题只要混入 C03/C04（或知识点无法归类）就整题不可练。
- 候选题同样必须「全部知识点在 C01/C02」，避免同考点的阅读题混进练习。
- **语文不 AI 补题**：题库有多少出多少，按实际题数取不超过它的最大档位（`cn_targeted` 1/3/5）。
- 判题沿用语文现状：客观题 exact、非客观题学生自评。
- 顺带修复：语文同类练习落 `special_practice_sessions` 时 `module` 由 `math_targeted` 改为 `cn_targeted`（此前映射把非物理/化学一律当数学）。

**spec / plan**：`docs/superpowers/specs/2026-11-08-chinese-similar-practice-design.md`、`docs/superpowers/plans/2026-11-08-chinese-similar-practice.md`。
```

- [ ] **Step 5: 检查文档没有遗留「只开数学物理」的表述**

Run: `cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -rn "只开数学\|只开数学/物理\|开放数学、物理" docs/K12智学系统-产品需求文档.md docs/API接口与数据流设计文档.md docs/constraints docs/api 2>/dev/null | head`

Expected: 无输出（本计划与历史 spec 里的原文不算）。

- [ ] **Step 6: Commit**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add "docs/K12智学系统-产品需求文档.md" \
        "docs/API接口与数据流设计文档.md" \
        docs/api/openapi.yaml \
        docs/ai-core-changelog.md \
        docs/superpowers/specs/2026-11-08-chinese-similar-practice-design.md
git commit -m "docs(similar): document Chinese similar-practice scope"
```

---

### Task 7: 全量验证与人工冒烟

**Files:** 无（只验证）

- [ ] **Step 1: 后端全量测试**

Run: `cd apps/server && npm test`

Expected: 全绿（本次改动前基线 2561+ 用例）。

- [ ] **Step 2: 后端类型检查**

Run: `cd apps/server && npx tsc --noEmit`

Expected: 0 错误。

- [ ] **Step 3: 前端全量测试与 lint**

Run: `cd apps/web && npm test && npm run lint`

Expected: 全绿、0 lint 错误。

- [ ] **Step 4: 人工冒烟（需要本地服务）**

> ⚠️ 不要跑 `npm run build`：会覆盖用户 `:3001` 正在服务的 `dist`。如需重启后端，先向用户确认 PID/端口。

1. 用语文学生账号打开「个人中心 → 练习记录 → 语文卷（2026 海淀·要在学校 初三 期中）」。
2. 检查：文言实词/断句/古文内容理解/古诗默写/字词类题显示「同类型练习」；现代文阅读题、作文题只有「重做」或什么都没有。
3. 点「3 题」→ 答题页 → 提交（客观题自动判、简答题自评）→ 回详情。
4. 回练习记录列表：多一条「同类练习：文言实词与虚词 · 3 题」，且详情里每题也带「同类型练习」。
5. 抽查数学/物理记录：按钮、档位（含 2 题档）、发分与改动前一致。

- [ ] **Step 5: 冒烟中发现的问题单独提交**

若第 4 步发现问题需要改代码，只提交实际改动文件，提交信息写明现象与修法，例如：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add apps/server/src/modules/training/history-practice.service.ts
git commit -m "fix(similar): 语文同类型抽题未排除全部阅读题"
```

没有问题就不提交。
