# 倍长中线专项（2 题微专题）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有数学专项页新增「中考模型」模式，让倍长中线可用 1/2 题开练；复用 `math_targeted` 的判题、积分、练习记录，不改数据库。

**Architecture:** 服务端新增一个白名单 + 两个只读查询（按模型数题/抽题），扩展现有 `POST /training/targeted/start` 的入参；前端在 `TargetedConfigPage` 内加模式切换，模型模式只展示白名单卡片与可用的 1/2 题档。题池只有 2 条同题干记录，按 `q.id ASC` 固定顺序，不随机。

**Tech Stack:** NestJS / mysql2 / Vitest（服务端）；React + Vite + Vitest（前端）；MySQL 8。设计真源：`docs/superpowers/specs/2026-11-15-median-doubling-special-design.md`。

## Global Constraints

- **只做数学**：模型模式 `subjectId=1`；非数学直接 400（模型模式）。
- **只读标签**：不改 `question_model_tags` / `questions` / 掌握度；**无数据库迁移**。
- **复用**：`task_code='math_targeted'`、现有积分档位、`TargetedRunPage`、判题、完成发分；不新增 task code。
- **题池**：`category='geometry_synthesis' AND model='median_doubling' AND confidence>=0.70 AND is_active=1 AND answer<>''`，排除该生 `student_hidden_questions`。
- **顺序**：`ORDER BY q.id ASC`；不吃 `RAND()`。
- **题量**：模型模式只允许 `1` / `2`，且必须是该生 `math_targeted` 已开启档位、且不超过可练题数。
- **记录标题**：handoff `title='倍长中线微专题'`；不加会话表列。
- **API 文档同步**：`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须同时改。
- **不新增依赖**。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/server/src/modules/training/model-specials.ts` | 新建 | 白名单 `MODEL_SPECIALS` + `findModelSpecial` |
| `apps/server/src/database/repositories/questions.repo.ts` | 修改 | `countModelSpecialQuestions` / `findModelSpecialQuestions` |
| `apps/server/src/modules/training/training.service.ts` | 修改 | `listModelSpecials`；`startTargetedPractice` 模型分支 |
| `apps/server/src/modules/training/training.controller.ts` | 修改 | `GET model-specials`；`targeted/start` 模式校验 |
| `apps/server/src/modules/training/training.service.test.ts` | 修改 | 服务/控制器新用例 + KP 回归 |
| `apps/server/src/database/repositories/questions.repo.test.ts` | 修改 | 模型抽题 SQL 谓词 |
| `apps/web/src/services/api.ts` | 修改 | `getModelSpecials`；`startTargetedPractice` 联合类型 |
| `apps/web/src/pages/student/training/TierChip.tsx` | 新建 | 从配置页抽出的题量按钮 |
| `apps/web/src/pages/student/training/ModelSpecialPanel.tsx` | 新建 | 模型卡片/题量/状态 |
| `apps/web/src/pages/student/training/TargetedConfigPage.tsx` | 修改 | 模式切换 + 模型数据/开练 |
| `apps/web/src/pages/student/training/ModelSpecialPanel.test.tsx` | 新建 | 组件状态测试 |
| `apps/web/src/pages/student/training/TargetedConfigPage.test.tsx` | 修改 | 模型模式集成测试 |
| `docs/API接口与数据流设计文档.md` | 修改 | §4.18 新端点 + §5.16 数据流 |
| `docs/api/openapi.yaml` | 修改 | 路径/schema |
| `docs/K12智学系统-产品需求文档.md` | 修改 | §6.3 补一句模型维度 |
| `docs/ai-core-changelog.md` | 修改 | 收尾记录 |

---

## Task 1: 服务端模型清单 + 只读抽题

**Files:**
- Create: `apps/server/src/modules/training/model-specials.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.ts`（`findRandomByKpAndType` 之后）
- Modify: `apps/server/src/modules/training/training.service.ts`（`startTargetedPractice` 之前）
- Modify: `apps/server/src/modules/training/training.controller.ts`（`targeted/start` 之前）
- Test: `apps/server/src/modules/training/training.service.test.ts`
- Test: `apps/server/src/database/repositories/questions.repo.test.ts`

**Interfaces:**
- Produces:
  - `ModelSpecial`：`{ category, categoryName, model, modelName }`
  - `MODEL_SPECIALS`：当前只有倍长中线
  - `findModelSpecial(category, model): ModelSpecial | null`
  - `QuestionsRepository.countModelSpecialQuestions(studentId, subjectId, category, model): Promise<number>`
  - `QuestionsRepository.findModelSpecialQuestions(studentId, subjectId, category, model, count): Promise<QuestionRow[]>`
  - `TrainingService.listModelSpecials(studentId, subjectId): Promise<{ specials: Array<ModelSpecial & { questionCount: number }> }>`
  - `GET /api/training/model-specials?subjectId=1`

- [ ] **Step 1: 写失败测试（服务端）**

在 `training.service.test.ts` 的 `mk` 的 `questionsRepo` 里加：

```ts
    findModelSpecialQuestions: vi.fn().mockResolvedValue([]),
    countModelSpecialQuestions: vi.fn().mockResolvedValue(0),
```

追加测试：

```ts
describe('TrainingService.listModelSpecials', () => {
  it('数学：返回白名单模型 + 该生可练题数', async () => {
    const deps = mk({
      questionsRepo: {
        countModelSpecialQuestions: vi.fn().mockResolvedValue(2),
      } as never,
    });
    const r = await mkSvc(deps).listModelSpecials(7, 1);
    expect(r.specials).toEqual([{
      category: 'geometry_synthesis',
      categoryName: '几何综合',
      model: 'median_doubling',
      modelName: '倍长中线',
      questionCount: 2,
    }]);
    expect(deps.questionsRepo.countModelSpecialQuestions)
      .toHaveBeenCalledWith(7, 1, 'geometry_synthesis', 'median_doubling');
  });

  it('非数学：返回空数组，不查库', async () => {
    const deps = mk();
    const r = await mkSvc(deps).listModelSpecials(7, 4);
    expect(r).toEqual({ specials: [] });
    expect(deps.questionsRepo.countModelSpecialQuestions).not.toHaveBeenCalled();
  });
});
```

在 `questions.repo.test.ts` 追加：

```ts
describe('QuestionsRepository 模型专项抽题', () => {
  it('count：JOIN 标签 / confidence>=0.70 / active / 有答案 / 隐藏排除', async () => {
    const pool = mockPool([{ count: 2 }]);
    const repo = new QuestionsRepository(pool as any);
    const n = await repo.countModelSpecialQuestions(7, 1, 'geometry_synthesis', 'median_doubling');
    expect(n).toBe(2);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN question_model_tags qmt');
    expect(sql).toContain('qmt.confidence >= 0.70');
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('shq.id IS NULL');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain("q.answer <> ''");
    expect(params).toEqual([7, 1, 'geometry_synthesis', 'median_doubling']);
  });

  it('find：ORDER BY q.id ASC + LIMIT ? 走 pool.query', async () => {
    const pool = mockPool([{ id: 7093 }, { id: 7094 }]);
    const repo = new QuestionsRepository(pool as any);
    const rows = await repo.findModelSpecialQuestions(
      7, 1, 'geometry_synthesis', 'median_doubling', 2,
    );
    expect(rows.map((r) => r.id)).toEqual([7093, 7094]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ORDER BY q.id ASC LIMIT ?');
    expect(params).toEqual([7, 1, 'geometry_synthesis', 'median_doubling', 2]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npm test -- src/modules/training/training.service.test.ts src/database/repositories/questions.repo.test.ts
```

Expected：FAIL（`listModelSpecials` 不存在 / repo 方法不存在）。

- [ ] **Step 3: 写白名单**

创建 `apps/server/src/modules/training/model-specials.ts`：

```ts
/** 已审核上线的模型微专题白名单。加模型只改这里。 */
export interface ModelSpecial {
  category: string;
  categoryName: string;
  model: string;
  modelName: string;
}

export const MODEL_SPECIALS: readonly ModelSpecial[] = [
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'median_doubling',
    modelName: '倍长中线',
  },
];

export function findModelSpecial(
  category: unknown,
  model: unknown,
): ModelSpecial | null {
  if (typeof category !== 'string' || typeof model !== 'string') return null;
  return MODEL_SPECIALS.find(
    (s) => s.category === category && s.model === model,
  ) ?? null;
}
```

- [ ] **Step 4: 加仓储方法**

在 `questions.repo.ts` 的 `findRandomByKpAndType` 之后追加：

```ts
  /** 模型微专题：该生可练题数（与抽题谓词同源；confidence 阈值 0.70）。 */
  async countModelSpecialQuestions(
    studentId: number,
    subjectId: number,
    category: string,
    model: string,
  ): Promise<number> {
    const sql = `SELECT COUNT(*) AS count FROM questions q
      JOIN question_model_tags qmt ON qmt.question_id = q.id
      LEFT JOIN student_hidden_questions shq
        ON shq.question_id = q.id AND shq.student_id = ?
      WHERE q.subject_id = ? AND qmt.category = ? AND qmt.model = ?
        AND qmt.confidence >= 0.70
        AND q.is_active = 1 AND q.answer <> '' AND shq.id IS NULL`;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      sql, [studentId, subjectId, category, model],
    );
    return Number((rows[0] as { count: number } | undefined)?.count ?? 0);
  }

  /** 模型微专题抽题：固定 q.id 升序（本期 2 条为 7093→7094）。 */
  async findModelSpecialQuestions(
    studentId: number,
    subjectId: number,
    category: string,
    model: string,
    count: number,
  ): Promise<QuestionRow[]> {
    const sql = `SELECT q.* FROM questions q
      JOIN question_model_tags qmt ON qmt.question_id = q.id
      LEFT JOIN student_hidden_questions shq
        ON shq.question_id = q.id AND shq.student_id = ?
      WHERE q.subject_id = ? AND qmt.category = ? AND qmt.model = ?
        AND qmt.confidence >= 0.70
        AND q.is_active = 1 AND q.answer <> '' AND shq.id IS NULL
      ORDER BY q.id ASC LIMIT ?`;
    // pool.query：LIMIT ? 不能走 execute 的 server-side prepare（仓库既有约定）。
    const [rows] = await this.pool.query<RowDataPacket[]>(
      sql, [studentId, subjectId, category, model, count],
    );
    return rows as QuestionRow[];
  }
```

- [ ] **Step 5: 服务 list 方法**

在 `training.service.ts` 的 `startTargetedPractice` 之前加：

```ts
  /** 模型微专题清单：白名单 + 该生可练题数（非数学返回空）。 */
  async listModelSpecials(
    studentId: number,
    subjectId: number,
  ): Promise<{ specials: Array<ModelSpecial & { questionCount: number }> }> {
    if (subjectId !== SUBJECT_MATH) return { specials: [] };
    const specials = await Promise.all(
      MODEL_SPECIALS.map(async (s) => ({
        ...s,
        questionCount: await this.questionsRepo.countModelSpecialQuestions(
          studentId, subjectId, s.category, s.model,
        ),
      })),
    );
    return { specials };
  }
```

导入：

```ts
import { MODEL_SPECIALS, type ModelSpecial } from './model-specials.js';
```

并把 `subject-config` 导入补 `SUBJECT_MATH`。

- [ ] **Step 6: 控制器 GET**

在 `training.controller.ts` 的 `targeted/start` 之前加：

```ts
  /** 模型微专题清单：白名单模型 + 该生可练题数（非数学返回空）。 */
  @Get('model-specials')
  async listModelSpecials(
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @CurrentUser() user: JwtUser,
  ) {
    return this.trainingService.listModelSpecials(user.sub, subjectId);
  }
```

- [ ] **Step 7: 跑测试确认通过**

```bash
cd apps/server && npm test -- src/modules/training/training.service.test.ts src/database/repositories/questions.repo.test.ts
```

Expected：PASS；KP 既有用例不回归。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/training/model-specials.ts \
        apps/server/src/database/repositories/questions.repo.ts \
        apps/server/src/modules/training/training.service.ts \
        apps/server/src/modules/training/training.controller.ts \
        apps/server/src/modules/training/training.service.test.ts \
        apps/server/src/database/repositories/questions.repo.test.ts
git commit -m "feat(training): 模型微专题清单与抽题查询"
```

---

## Task 2: 扩展专项开练（模式校验 + 模型分支）

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts:176-207`
- Modify: `apps/server/src/modules/training/training.service.ts:806-855`
- Test: `apps/server/src/modules/training/training.service.test.ts`（服务 + 控制器）

**Interfaces:**
- Consumes: Task 1 的 `findModelSpecial`、`findModelSpecialQuestions`
- Produces:
  - `POST /api/training/targeted/start` 支持 `{category, model}`；`kpId` 改为可选
  - `TrainingService.startTargetedPractice` 入参增加 `modelSpecial?: ModelSpecial | null`
  - 模型会话 `ref_type='model'`

- [ ] **Step 1: 写失败测试（服务）**

在 `TrainingService.startTargetedPractice` 的 describe 里追加：

```ts
  it('模型模式：按标签抽题、2 题按 id 顺序、会话 ref_type=model', async () => {
    const deps = mk({
      questionsRepo: {
        findModelSpecialQuestions: vi.fn().mockResolvedValue([
          { ...questionRow, id: 7093 },
          { ...questionRow, id: 7094, type: 'short_answer', content: '第二问' },
        ]),
      } as never,
    });
    const r = await mkSvc(deps).startTargetedPractice({
      studentId: 7, subjectId: 1, kpId: null,
      modelSpecial: {
        category: 'geometry_synthesis', categoryName: '几何综合',
        model: 'median_doubling', modelName: '倍长中线',
      },
      type: null, count: 2,
    });
    expect(deps.questionsRepo.findModelSpecialQuestions)
      .toHaveBeenCalledWith(7, 1, 'geometry_synthesis', 'median_doubling', 2);
    expect(r.questions.map((q) => q.questionId)).toEqual([7093, 7094]);
    expect(deps.trainingSessionsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      task_code: 'math_targeted', tier_key: '2', expected_count: 2,
      ref_type: 'model', ref_id: null,
    }));
  });

  it('模型模式：可练题数不足 count -> 400，不建会话', async () => {
    const deps = mk({
      questionsRepo: {
        findModelSpecialQuestions: vi.fn().mockResolvedValue([{ ...questionRow, id: 7093 }]),
      } as never,
    });
    await expect(mkSvc(deps).startTargetedPractice({
      studentId: 7, subjectId: 1, kpId: null,
      modelSpecial: {
        category: 'geometry_synthesis', categoryName: '几何综合',
        model: 'median_doubling', modelName: '倍长中线',
      },
      type: null, count: 2,
    })).rejects.toMatchObject({ status: 400 });
    expect(deps.trainingSessionsRepo.create).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 写失败测试（控制器）**

在 `TrainingController.startTargetedPractice` 的 describe 里追加（沿用现有 `mkController`）：

```ts
  it('模型模式：kpId=null + category/model + type=null + count=2 透传', async () => {
    const svc: any = { startTargetedPractice: vi.fn().mockResolvedValue({ questions: [], sessionId: null }) };
    const rules: any = { listTierKeys: vi.fn().mockResolvedValue(['1', '2']) };
    const c = new TrainingController(svc, {} as never, {} as never, rules);
    await c.startTargetedPractice({
      subjectId: 1, category: 'geometry_synthesis', model: 'median_doubling',
      type: null, count: 2,
    }, { sub: 7 } as never);
    expect(svc.startTargetedPractice).toHaveBeenCalledWith({
      studentId: 7, subjectId: 1, kpId: null,
      modelSpecial: {
        category: 'geometry_synthesis', categoryName: '几何综合',
        model: 'median_doubling', modelName: '倍长中线',
      },
      type: null, count: 2,
    });
  });

  it.each([
    [{ subjectId: 1, kpId: 3, category: 'geometry_synthesis', model: 'median_doubling', type: null, count: 2 }, '二选一'],
    [{ subjectId: 1, category: 'geometry_synthesis', type: null, count: 2 }, '同时出现'],
    [{ subjectId: 4, category: 'geometry_synthesis', model: 'median_doubling', type: null, count: 2 }, '仅支持数学'],
    [{ subjectId: 1, category: 'x', model: 'y', type: null, count: 2 }, '不支持的模型专项'],
    [{ subjectId: 1, category: 'geometry_synthesis', model: 'median_doubling', type: 'proof', count: 2 }, '不支持题型筛选'],
    [{ subjectId: 1, category: 'geometry_synthesis', model: 'median_doubling', type: null, count: 3 }, '仅支持 1 或 2 题'],
  ])('模型模式非法入参 -> 400（%#）', async (dto, msg) => {
    const svc: any = { startTargetedPractice: vi.fn() };
    const rules: any = { listTierKeys: vi.fn().mockResolvedValue(['1', '2', '3']) };
    const c = new TrainingController(svc, {} as never, {} as never, rules);
    await expect(c.startTargetedPractice(dto as never, { sub: 7 } as never))
      .rejects.toThrow(msg);
    expect(svc.startTargetedPractice).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd apps/server && npm test -- src/modules/training/training.service.test.ts
```

Expected：FAIL（控制器仍要求 kpId、服务没有 modelSpecial）。

- [ ] **Step 4: 改服务**

把 `startTargetedPractice` 的签名与抽题段改成：

```ts
  async startTargetedPractice(input: {
    studentId: number;
    subjectId: number;
    kpId?: number | null;
    /** 模型微专题；与 kpId 二选一，控制器已校验。 */
    modelSpecial?: ModelSpecial | null;
    type: string | null;
    count: number;
  }): Promise<{
    questions: Array<{
      questionId: number; text: string; type: string;
      options: unknown[] | null; materialText: string | null;
    }>;
    sessionId: number | null;
  }> {
    const modelSpecial = input.modelSpecial ?? null;
    const rows = modelSpecial
      ? await this.questionsRepo.findModelSpecialQuestions(
          input.studentId, input.subjectId, modelSpecial.category,
          modelSpecial.model, input.count,
        )
      : await this.questionsRepo.findRandomByKpAndType(
          input.studentId, input.subjectId, input.kpId as number,
          input.type, input.count,
        );
    if (modelSpecial && rows.length < input.count) {
      throw new BadRequestException(`题量超过可练题数（当前 ${rows.length} 题）`);
    }
    const questions = rows.map((q) => ({
      questionId: q.id,
      text: q.content,
      type: q.type,
      options: parseOptions(q.options),
      materialText: q.material_text ?? null,
    }));

    // 建会话失败只丢这一轮积分，不能 500 掉开练（沿用现有降级）。
    let sessionId: number | null = null;
    if (rows.length > 0) {
      try {
        const taskCode = targetedTaskCode(input.subjectId);
        sessionId = await this.trainingSessionsRepo.create({
          student_id: input.studentId,
          task_code: taskCode,
          subject_id: input.subjectId,
          tier_key: String(input.count),
          expected_count: rows.length,
          ref_type: modelSpecial ? 'model' : 'question',
          ref_id: null,
        });
      } catch (err) {
        this.logger.warn(
          `training_sessions.create failed (taskCode=${targetedTaskCode(input.subjectId)}, studentId=${input.studentId}, tierKey=${input.count}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { questions, sessionId };
  }
```

- [ ] **Step 5: 改控制器**

把 `startTargetedPractice` 整体替换为：

```ts
  @Post('targeted/start')
  async startTargetedPractice(
    @Body() dto: {
      subjectId: number;
      kpId?: number;
      category?: string;
      model?: string;
      type: string | null;
      count: number;
    },
    @CurrentUser() user: JwtUser,
  ) {
    const hasKp = Number.isInteger(dto.kpId) && (dto.kpId as number) > 0;
    const hasCategory = typeof dto.category === 'string' && dto.category.trim() !== '';
    const hasModel = typeof dto.model === 'string' && dto.model.trim() !== '';

    if (hasKp && (hasCategory || hasModel)) {
      throw new BadRequestException('kpId 与 category+model 必须二选一');
    }
    if (!hasKp && !hasCategory && !hasModel) {
      throw new BadRequestException('kpId 与 category+model 必须二选一');
    }
    if (!hasKp && hasCategory !== hasModel) {
      throw new BadRequestException('category 与 model 必须同时出现');
    }

    const special = hasKp ? null : findModelSpecial(dto.category, dto.model);
    if (!hasKp) {
      if (dto.subjectId !== SUBJECT_MATH) {
        throw new BadRequestException('模型专项仅支持数学');
      }
      if (!special) throw new BadRequestException('不支持的模型专项');
      if (dto.type !== null && dto.type !== undefined) {
        throw new BadRequestException('模型专项不支持题型筛选');
      }
      if (!Number.isInteger(dto.count) || (dto.count !== 1 && dto.count !== 2)) {
        throw new BadRequestException('模型专项仅支持 1 或 2 题');
      }
    }

    const { count } = dto;
    const taskCode = targetedTaskCode(dto.subjectId);
    const allowed = await this.pointRulesService.listTierKeys(user.sub, taskCode);
    if (!hasKp && allowed.length === 0) {
      throw new BadRequestException('家长未开启数学专项档位');
    }
    if (!allowed.includes(String(count))) {
      throw new BadRequestException(`题量仅允许 ${allowed.join(' | ')}`);
    }
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new BadRequestException('count 仅允许 1-20 的整数');
    }

    const type = dto.type ?? null;
    if (type !== null && !(TrainingController.TARGETED_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(
        'type 仅允许 choice | fill_blank | true_false | short_answer | proof | calculation 或 null',
      );
    }

    return this.trainingService.startTargetedPractice({
      studentId: user.sub,
      subjectId: dto.subjectId,
      kpId: hasKp ? dto.kpId! : null,
      modelSpecial: special,
      type: special ? null : type,
      count,
    });
  }
```

导入：

```ts
import { findModelSpecial } from './model-specials.js';
import { SUBJECT_MATH, targetedTaskCode } from '../../common/subject-config.js';
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd apps/server && npm test -- src/modules/training/training.service.test.ts
```

Expected：PASS；既有 KP 用例不回归。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/training/training.controller.ts \
        apps/server/src/modules/training/training.service.ts \
        apps/server/src/modules/training/training.service.test.ts
git commit -m "feat(training): 专项开练支持倍长中线模型模式"
```

---

## Task 3: 前端 API 类型 + 模型面板 + 页面切换

**Files:**
- Modify: `apps/web/src/services/api.ts`（`Training: targeted practice` 段）
- Create: `apps/web/src/pages/student/training/TierChip.tsx`
- Create: `apps/web/src/pages/student/training/ModelSpecialPanel.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedConfigPage.tsx`
- Create: `apps/web/src/pages/student/training/ModelSpecialPanel.test.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedConfigPage.test.tsx`

**Interfaces:**
- Consumes: Task 1 GET、Task 2 POST
- Produces:
  - `TrainingModelSpecial`、`getModelSpecials(subjectId)`
  - `StartTargetedPayload` 联合类型
  - `ModelSpecialPanel`（props 见 Step 4）
  - 专项页 `mode: 'kp' | 'model'`

- [ ] **Step 1: 前端 API 类型（先改类型，编译驱动）**

在 `api.ts` 的 `TrainingKnowledgePoint` 后加：

```ts
/** 模型微专题（白名单）；questionCount 是该生可练数。 */
export interface TrainingModelSpecial {
  category: string;
  categoryName: string;
  model: string;
  modelName: string;
  questionCount: number;
}

export function getModelSpecials(
  subjectId: number,
): Promise<{ specials: TrainingModelSpecial[] }> {
  const qs = new URLSearchParams({ subjectId: String(subjectId) });
  return fetchApi<{ specials: TrainingModelSpecial[] }>(
    `/training/model-specials?${qs.toString()}`,
  );
}
```

把 `startTargetedPractice` 的 payload 改成联合类型：

```ts
export type StartTargetedPayload =
  | {
      subjectId: number;
      kpId: number;
      category?: never;
      model?: never;
      type: string | null;
      count: number;
    }
  | {
      subjectId: number;
      kpId?: never;
      category: string;
      model: string;
      type: null;
      count: number;
    };

export function startTargetedPractice(payload: StartTargetedPayload): Promise<{
  questions: TargetedPracticeQuestion[];
  sessionId: number | null;
}> {
  return fetchApi('/training/targeted/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```

> 既有 KP 调用点（配置页、薄弱点图谱）传 `kpId`，联合类型自动匹配第一支；不需要改调用。

- [ ] **Step 2: 抽出 TierChip**

创建 `TierChip.tsx`，把 `TargetedConfigPage.tsx` 里的 `TierChip` 函数原样移出：

```tsx
export interface TierChipProps {
  label: string;
  points: number;
  status: string | null;
  active: boolean;
  capped: boolean;
  onClick: () => void;
}

/** 题量档按钮（单选）：主行档位名，副行分值 + 剩余次数。 */
export function TierChip({
  label, points, status, active, capped, onClick,
}: TierChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'flex flex-col items-center justify-center min-h-11 px-4 py-1.5 rounded-full border ' +
        'text-sm font-medium transition-colors ' +
        (active
          ? 'border-[var(--brand-500)] bg-[var(--brand-500)] text-[var(--text-on-brand)]'
          : 'border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] text-[var(--learn-text-secondary)] hover:border-[var(--brand-500)]') +
        (capped && !active ? ' opacity-60' : '')
      }
    >
      <span>{label}</span>
      <span
        className={
          'text-[0.625rem] font-normal ' +
          (active ? 'opacity-90' : 'text-[var(--learn-text-tertiary)]')
        }
      >
        +{points} 分{status ? ` · ${status}` : ''}
      </span>
    </button>
  );
}
```

- 从 `TargetedConfigPage.tsx` 删除本地 `TierChip` 定义，改为 `import { TierChip } from './TierChip';`。
- 删除只被该函数使用的 `ReactNode`/无关 import（如有）。

- [ ] **Step 3: 写 ModelSpecialPanel 失败测试**

创建 `ModelSpecialPanel.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelSpecialPanel, type ModelSpecialPanelProps } from './ModelSpecialPanel';
import type { PointRuleTier, TrainingModelSpecial } from '@/services/api';

afterEach(cleanup);

const SPECIAL: TrainingModelSpecial = {
  category: 'geometry_synthesis',
  categoryName: '几何综合',
  model: 'median_doubling',
  modelName: '倍长中线',
  questionCount: 2,
};

function tier(key: string, label: string, points: number): PointRuleTier {
  return {
    tierKey: key, tierLabel: label, points,
    dailyLimit: null, completedToday: null, remainingToday: null, isActive: true,
  };
}

function props(over: Partial<ModelSpecialPanelProps> = {}): ModelSpecialPanelProps {
  return {
    special: SPECIAL,
    status: 'ok',
    error: null,
    tiers: [tier('1', '1 题', 2), tier('2', '2 题', 5)],
    eligibleTiers: [tier('1', '1 题', 2), tier('2', '2 题', 5)],
    tierKey: '2',
    starting: false,
    startError: null,
    emptyHint: false,
    tiersError: null,
    onRetry: vi.fn(),
    onRetryTiers: vi.fn(),
    onSelectTier: vi.fn(),
    onStart: vi.fn(),
    ...over,
  };
}

describe('ModelSpecialPanel', () => {
  it('渲染倍长中线、题量与 1/2 档，点击开练', () => {
    const p = props();
    render(<ModelSpecialPanel {...p} />);
    expect(screen.getByText('倍长中线')).toBeTruthy();
    expect(screen.getByText('几何综合 · 微专题')).toBeTruthy();
    expect(screen.getByText('可练 2 题')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^2 题/ }));
    expect(p.onSelectTier).toHaveBeenCalledWith('2');
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    expect(p.onStart).toHaveBeenCalled();
  });

  it('没有 1/2 档：显示家长提示并禁用', () => {
    const p = props({ eligibleTiers: [], tierKey: null });
    render(<ModelSpecialPanel {...p} />);
    expect(screen.getByText('家长未开启 1 或 2 题档位，暂不能开练。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();
  });

  it('可练 0 题：显示暂无可练题目', () => {
    render(<ModelSpecialPanel {...props({ special: { ...SPECIAL, questionCount: 0 }, eligibleTiers: [], tierKey: null })} />);
    expect(screen.getByText('暂无可练题目。')).toBeTruthy();
  });
});
```

- [ ] **Step 4: 写 ModelSpecialPanel 实现**

```tsx
import { Button, Card, Skeleton } from '@/components/base';
import type { PointRuleTier, TrainingModelSpecial } from '@/services/api';
import { tierStatus } from './point-tiers';
import { TierChip } from './TierChip';

export interface ModelSpecialPanelProps {
  special: TrainingModelSpecial | null;
  status: 'idle' | 'loading' | 'ok' | 'error';
  error: string | null;
  tiers: PointRuleTier[] | null;
  tiersError: string | null;
  eligibleTiers: PointRuleTier[];
  tierKey: string | null;
  starting: boolean;
  startError: string | null;
  emptyHint: boolean;
  onRetry: () => void;
  onRetryTiers: () => void;
  onSelectTier: (key: string) => void;
  onStart: () => void;
}

export function ModelSpecialPanel({
  special, status, error, tiers, tiersError, eligibleTiers, tierKey,
  starting, startError, emptyHint, onRetry, onRetryTiers, onSelectTier, onStart,
}: ModelSpecialPanelProps) {
  if (status === 'idle' || status === 'loading') {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <Skeleton width="40%" height={18} />
        <Skeleton height={44} />
      </Card>
    );
  }
  if (status === 'error') {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <p className="text-sm text-[var(--learn-text-secondary)]">
          {error ?? '模型专项加载失败'}
        </p>
        <Button variant="secondary" size="sm" onClick={onRetry}>重试</Button>
      </Card>
    );
  }
  if (!special) {
    return (
      <Card className="mt-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <p className="text-sm text-[var(--learn-text-secondary)]">暂无可练题目。</p>
      </Card>
    );
  }

  const noTier = special.questionCount >= 2
    ? '家长未开启 1 或 2 题档位，暂不能开练。'
    : '家长未开启 1 题档位，暂不能开练。';
  const canStart = special.questionCount > 0
    && tierKey != null
    && eligibleTiers.some((t) => t.tierKey === tierKey)
    && !starting;

  return (
    <Card className="mt-6 space-y-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
      <section aria-label="模型专项">
        <h2 className="text-xl font-bold text-[var(--learn-text-primary)]">
          {special.modelName}
        </h2>
        <p className="mt-1 text-sm text-[var(--learn-text-secondary)]">
          {special.categoryName} · 微专题
        </p>
        <p className="mt-2 text-sm text-[var(--learn-text-secondary)]">
          先完整做一道两问的题，再单独巩固第二问。
        </p>
        <p className="mt-2 text-xs text-[var(--learn-text-tertiary)]">
          可练 {special.questionCount} 题
        </p>
      </section>

      {special.questionCount === 0 ? (
        <p className="text-sm text-[var(--learn-text-secondary)]">暂无可练题目。</p>
      ) : tiersError ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-[var(--learn-text-secondary)]">{tiersError}</p>
          <Button variant="secondary" size="sm" onClick={onRetryTiers}>重试</Button>
        </div>
      ) : tiers == null ? (
        <div className="flex flex-wrap gap-2" data-testid="model-tier-skeleton">
          <Skeleton width={72} height={44} rounded />
          <Skeleton width={72} height={44} rounded />
        </div>
      ) : eligibleTiers.length === 0 ? (
        <p className="text-sm text-[var(--learn-text-secondary)]">{noTier}</p>
      ) : (
        <section aria-label="题量选择">
          <span className="text-xs font-medium text-[var(--learn-text-secondary)]">题量</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {eligibleTiers.map((tier) => {
              const { text, capped } = tierStatus(tier);
              return (
                <TierChip
                  key={tier.tierKey}
                  label={tier.tierLabel}
                  points={tier.points}
                  status={text}
                  active={tierKey === tier.tierKey}
                  capped={capped}
                  onClick={() => onSelectTier(tier.tierKey)}
                />
              );
            })}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <Button
          variant="primary"
          size="lg"
          loading={starting}
          disabled={!canStart}
          onClick={onStart}
        >
          开始练习
        </Button>
        {emptyHint && (
          <p className="text-sm text-[var(--learn-text-secondary)]">
            这个模型暂时没有可练的题。
          </p>
        )}
        {startError && <p className="text-sm text-[var(--error)]">{startError}</p>}
      </section>
    </Card>
  );
}
```

- [ ] **Step 5: 页面加模式与模型状态**

在 `TargetedConfigPage.tsx` 顶部 import 补：

```ts
import { getModelSpecials, type TrainingModelSpecial } from '@/services/api';
import { ModelSpecialPanel } from './ModelSpecialPanel';
import { TierChip } from './TierChip';
```

在 KP 状态后加：

```ts
  // 专项模式：知识点（原行为）/ 中考模型
  const [mode, setMode] = useState<'kp' | 'model'>('kp');
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [modelError, setModelError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<TrainingModelSpecial | null>(null);
  const [modelTierKey, setModelTierKey] = useState<string | null>(null);
```

在 `loadKps` 之后加：

```ts
  const loadModelSpecials = useCallback(async () => {
    setModelStatus('loading');
    setModelError(null);
    try {
      const data = await getModelSpecials(subjectId);
      setSelectedModel(data.specials[0] ?? null);
      setModelStatus('ok');
    } catch (err) {
      setModelStatus('error');
      setModelError(err instanceof Error ? err.message : '模型专项加载失败');
      setSelectedModel(null);
    }
  }, [subjectId]);

  useEffect(() => {
    // 学科 query 变化时回到知识点模式并清空模型缓存
    setMode('kp');
    setModelStatus('idle');
    setModelError(null);
    setSelectedModel(null);
    setModelTierKey(null);
  }, [subjectId]);

  const eligibleModelTiers = useMemo(() => {
    if (!selectedModel || tiers == null) return [];
    return tiers.filter((t) => {
      const n = Number(t.tierKey);
      return Number.isInteger(n) && n >= 1 && n <= 2 && n <= selectedModel.questionCount;
    });
  }, [selectedModel, tiers]);

  useEffect(() => {
    if (mode !== 'model') return;
    if (!selectedModel || eligibleModelTiers.length === 0) {
      setModelTierKey(null);
      return;
    }
    const keys = eligibleModelTiers.map((t) => t.tierKey);
    if (modelTierKey == null || !keys.includes(modelTierKey)) {
      setModelTierKey(String(Math.max(...keys.map(Number))));
    }
  }, [mode, selectedModel, eligibleModelTiers, modelTierKey]);

  const selectMode = (next: 'kp' | 'model') => {
    setMode(next);
    setStartError(null);
    setEmptyHint(false);
    if (next === 'model' && modelStatus === 'idle') void loadModelSpecials();
  };

  const canStartModel = selectedModel != null
    && selectedModel.questionCount > 0
    && modelTierKey != null
    && eligibleModelTiers.some((t) => t.tierKey === modelTierKey)
    && !starting;

  const startModelPractice = async () => {
    if (!canStartModel || selectedModel == null || modelTierKey == null) return;
    setStarting(true);
    setStartError(null);
    setEmptyHint(false);
    try {
      const res = await startTargetedPractice({
        subjectId,
        category: selectedModel.category,
        model: selectedModel.model,
        type: null,
        count: Number(modelTierKey),
      });
      if (res.questions.length === 0) {
        setEmptyHint(true);
        return;
      }
      const handoff: TargetedRunHandoff = {
        sessionId: res.sessionId,
        questions: res.questions,
        title: `${selectedModel.modelName}微专题`,
      };
      sessionStorage.setItem('training:targeted', JSON.stringify(handoff));
      navigate(`/student/training/targeted/run${subjectQuery}`);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : '开练失败，请重试');
    } finally {
      setStarting(false);
    }
  };
```

- [ ] **Step 6: 页面 JSX 加切换与条件渲染**

在工具条（`我的不再展示清单`）之后、配置 Card 之前插入：

```tsx
          {subjectId === SUBJECT_MATH && (
            <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="专项类型">
              <KpChip label="知识点" active={mode === 'kp'} onClick={() => selectMode('kp')} />
              <KpChip label="中考模型" active={mode === 'model'} onClick={() => selectMode('model')} />
            </div>
          )}
```

把原「配置区」的 `<Card className="mt-6 space-y-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">` 用 `{mode === 'kp' && (` 包起来，对应的 `</Card>` 后补 `)}`，再在其后加模型面板：

```tsx
          {mode === 'kp' && (
            <Card className="mt-6 space-y-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
              {/* 原有配置内容整段不动 */}
            </Card>
          )}
          {mode === 'model' && (
            <ModelSpecialPanel
              special={selectedModel}
              status={modelStatus}
              error={modelError}
              tiers={tiers}
              tiersError={tiersError}
              eligibleTiers={eligibleModelTiers}
              tierKey={modelTierKey}
              starting={starting}
              startError={startError}
              emptyHint={emptyHint}
              onRetry={() => void loadModelSpecials()}
              onRetryTiers={() => void loadTiers()}
              onSelectTier={setModelTierKey}
              onStart={() => void startModelPractice()}
            />
          )}
```

- 删除页面内本地 `TierChip` 定义（已移出）。
- 不保留 `modelSpecials` 列表 state：本期只有一个模型，`loadModelSpecials` 只 `setSelectedModel(data.specials[0] ?? null)`；以后多模型再引入列表。

- [ ] **Step 7: 页面集成测试**

在 `TargetedConfigPage.test.tsx`：

1. 从 `@/services/api` 的 import 加 `getModelSpecials, type TrainingModelSpecial`。
2. `vi.mock` 返回对象加 `getModelSpecials: vi.fn()`。
3. 加 `const getModelSpecialsMock = vi.mocked(getModelSpecials);`
4. `beforeEach` 重置并默认：

```ts
    getModelSpecialsMock.mockReset();
    getModelSpecialsMock.mockResolvedValue({ specials: [MODEL_SPECIAL] });
```

5. 加 fixture：

```ts
const MODEL_SPECIAL: TrainingModelSpecial = {
  category: 'geometry_synthesis', categoryName: '几何综合',
  model: 'median_doubling', modelName: '倍长中线', questionCount: 2,
};
```

6. 加用例：

```ts
describe('中考模型模式', () => {
  it('数学显示模式切换；切到模型后按 2 题开练并带微专题标题', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getModelSpecialsMock.mockResolvedValue({ specials: [MODEL_SPECIAL] });
    startMock.mockResolvedValue({ questions: [STARTED_QUESTION], sessionId: 77 });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    await waitFor(() => expect(getModelSpecialsMock).toHaveBeenCalledWith(1));
    expect(await screen.findByText('倍长中线')).toBeTruthy();
    expect(screen.getByText('可练 2 题')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    });
    expect(startMock).toHaveBeenCalledWith({
      subjectId: 1,
      category: 'geometry_synthesis',
      model: 'median_doubling',
      type: null,
      count: 2,
    });
    const stored: unknown = JSON.parse(sessionStorage.getItem('training:targeted') ?? 'null');
    expect(stored).toEqual({
      sessionId: 77, questions: [STARTED_QUESTION], title: '倍长中线微专题',
    });
  });

  it('没有 1/2 档：提示家长开启并禁用', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf([
      tier({ tierKey: '3', tierLabel: '3 题', points: 8 }),
      tier({ tierKey: '5', tierLabel: '5 题', points: 12 }),
    ]));
    getModelSpecialsMock.mockResolvedValue({ specials: [MODEL_SPECIAL] });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    expect(await screen.findByText('家长未开启 1 或 2 题档位，暂不能开练。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();
  });

  it('可练 0 题：显示暂无可练题目', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getModelSpecialsMock.mockResolvedValue({
      specials: [{ ...MODEL_SPECIAL, questionCount: 0 }],
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    expect(await screen.findByText('暂无可练题目。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();
  });
});
```

7. 非数学用例补断言：

```ts
    expect(screen.queryByRole('button', { name: '中考模型' })).toBeNull();
```

- [ ] **Step 8: 跑前端测试**

```bash
cd apps/web && npm test -- src/pages/student/training/ModelSpecialPanel.test.tsx src/pages/student/training/TargetedConfigPage.test.tsx
```

Expected：PASS；既有 KP/语文/物理/化学用例不回归。

- [ ] **Step 9: TypeScript 编译**

```bash
cd apps/web && npx tsc -b --pretty false
```

Expected：无错误（检查 `StartTargetedPayload` 联合类型与既有调用点）。

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/services/api.ts \
        apps/web/src/pages/student/training/TierChip.tsx \
        apps/web/src/pages/student/training/ModelSpecialPanel.tsx \
        apps/web/src/pages/student/training/ModelSpecialPanel.test.tsx \
        apps/web/src/pages/student/training/TargetedConfigPage.tsx \
        apps/web/src/pages/student/training/TargetedConfigPage.test.tsx
git commit -m "feat(web): 专项页支持倍长中线微专题"
```

---

## Task 4: API 文档 / openapi / PRD

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.18 Training 表；§5.16 专项练习）
- Modify: `docs/api/openapi.yaml`（路径 + schema）
- Modify: `docs/K12智学系统-产品需求文档.md`（§6.3 第 2 条）

- [ ] **Step 1: API 设计文档加端点**

在 §4.18 Training 表 `GET /api/training/knowledge-points` 行后加一行：

```markdown
| GET | `/api/training/model-specials?subjectId={subjectId}` | 模型微专题清单（student JWT）。`subjectId` 必填 integer；非数学返回 `{specials: []}`。响应 `{specials: [{category, categoryName, model, modelName, questionCount}]}`——`questionCount` 是**该生**可练数（`question_model_tags.confidence>=0.70` + `is_active=1` + `answer<>''` + 排除该生「不再展示」）。当前白名单只有 `geometry_synthesis / median_doubling / 倍长中线`。 | MVP |
```

把 `POST /api/training/targeted/start` 行的请求体说明改为：

```markdown
请求体：`{subjectId, kpId?, category?, model?, type, count}`；`kpId` 与 `category+model` **二选一**（都给/都不给 400，只给一个 400）。模型模式：`subjectId` 必须 1、白名单精确匹配、`type` 必须 null、`count` 只能是 1/2 且是该生 `math_targeted` 已开启档位、且不超过可练题数；题单按 `q.id ASC`（当前 1 题=7093，2 题=7093→7094），会话 `ref_type='model'`。KP 模式行为不变。
```

- [ ] **Step 2: §5.16 加数据流**

在 §5.16 的「选知识点 + 题型 + 题数」段后加：

```markdown
**模型微专题（倍长中线，2026-11-15）**：专项页切到「中考模型」→ `GET /api/training/model-specials?subjectId=1` 取白名单与可练数 → 选 1/2 题档 → `POST /api/training/targeted/start` 传 `{category:'geometry_synthesis', model:'median_doubling', type:null, count}` → 服务端 JOIN `question_model_tags`（confidence>=0.70）+ 排除隐藏/空答案 + `ORDER BY q.id ASC` → 建 `training_sessions`（`task_code='math_targeted'`, `ref_type='model'`）→ 复用 `TargetedRunPage` 判题/发分。练习记录标题由 handoff `title` 落为「倍长中线微专题」。
```

- [ ] **Step 3: openapi 路径**

在 `openapi.yaml` 的 `/training/knowledge-points` 后加：

```yaml
  /training/model-specials:
    get:
      tags: [Training]
      summary: 模型微专题清单（倍长中线首批）
      description: >-
        student JWT。subjectId 必填 integer；非数学返回空数组。
        questionCount 是该生可练数：question_model_tags.confidence>=0.70、
        is_active=1、answer<>''，并排除该生 student_hidden_questions。
      operationId: listModelSpecials
      security: [{ bearerAuth: [] }]
      parameters:
        - in: query
          name: subjectId
          required: true
          schema: { type: integer }
      responses:
        '200':
          description: 模型清单
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        type: object
                        properties:
                          specials:
                            type: array
                            items:
                              $ref: '#/components/schemas/TrainingModelSpecial'
```

- [ ] **Step 4: openapi schema**

在 `TargetedStartRequest` 前加：

```yaml
    TrainingModelSpecial:
      type: object
      required: [category, categoryName, model, modelName, questionCount]
      properties:
        category: { type: string, example: geometry_synthesis }
        categoryName: { type: string, example: 几何综合 }
        model: { type: string, example: median_doubling }
        modelName: { type: string, example: 倍长中线 }
        questionCount: { type: integer, example: 2 }
```

把 `TargetedStartRequest` 改成：

```yaml
    TargetedStartRequest:
      type: object
      required: [subjectId, type, count]
      description: kpId 与 category+model 二选一；模型模式 type 必须 null、count 只能 1/2。
      properties:
        subjectId: { type: integer }
        kpId: { type: integer, description: 知识点 id；与 category+model 二选一 }
        category: { type: string, description: 模型大类 code；必须与 model 同时出现 }
        model: { type: string, description: 模型 code；必须与 category 同时出现 }
        type:
          type: string
          nullable: true
          enum: [choice, fill_blank, true_false, short_answer, proof, calculation]
          description: 题型过滤；模型模式必须 null
        count:
          type: integer
          minimum: 1
          maximum: 20
          description: 模型模式只能 1 或 2，且必须是家长已开启档位
```

在 `TargetedStartResult` 加：

```yaml
        sessionId:
          type: integer
          nullable: true
          description: 训练会话 id；建会话失败为 null（不发分，学习照走）
```

- [ ] **Step 5: PRD 补一句**

在 PRD §6.3 第 2 条「专项练习」后加：

```markdown
   > **模型微专题（2026-11-15）**：专项页支持按中考模型开微专题；首批「倍长中线」只有 2 道同题干记录（完整题 + 第二问巩固），因此只开放 1/2 题档、固定 id 升序，不随机。
```

- [ ] **Step 6: 校验文档**

```bash
grep -n "model-specials" docs/API接口与数据流设计文档.md docs/api/openapi.yaml
grep -n "倍长中线" docs/K12智学系统-产品需求文档.md docs/API接口与数据流设计文档.md
```

Expected：三份文档都能命中；openapi 与 API 文档的路径一致。

- [ ] **Step 7: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/K12智学系统-产品需求文档.md
git commit -m "docs(api): 模型微专题接口与数据流"
```

---

## Task 5: 全量验证 + changelog

**Files:**
- Modify: `docs/ai-core-changelog.md`

- [ ] **Step 1: 服务端全量测试**

```bash
cd apps/server && npm test
```

Expected：全绿；重点看 `training.service.test.ts` / `questions.repo.test.ts`。

- [ ] **Step 2: 前端全量测试 + 构建 + lint**

```bash
cd apps/web && npm test
cd apps/web && npm run build
cd apps/web && npm run lint
```

Expected：全绿、构建通过、lint 无新增错误。

- [ ] **Step 3: 服务端构建**

```bash
cd apps/server && npm run build
```

Expected：通过。

- [ ] **Step 4: 手动冒烟（可选但建议）**

用学生账号在浏览器打开 `/student/training/targeted?subjectId=1`：

1. 切「中考模型」，看到「倍长中线 · 几何综合 · 微专题 · 可练 2 题」。
2. 题量只出现 1/2 档，默认 2 题。
3. 开始练习 → 先出完整两问题，再出第二问；交卷后练习记录标题为「倍长中线微专题」。
4. 家长把 1/2 档全停用后，模型页显示「家长未开启 1 或 2 题档位，暂不能开练。」且按钮禁用。

- [ ] **Step 5: 写 changelog**

在 `docs/ai-core-changelog.md` 顶部（第一个 `## 2026-11-14 做题答疑进历史 + 做题题进错题/专项` 之前）插入：

```markdown
## 2026-11-15 倍长中线微专题（2 题）

**背景**：数学专项只能按教材知识点选题；`question_model_tags` 已能标出倍长中线，但题池只有 2 条有效记录（7093 完整两问、7094 第二问；4524 无答案）。

**改动**：
- 新增 `GET /api/training/model-specials`：白名单模型 + 该生可练数（confidence>=0.70、active、有答案、排除隐藏）。
- `POST /api/training/targeted/start` 支持 `{category, model}`（与 `kpId` 二选一）；模型模式 `type=null`、`count` 仅 1/2、且不超过可练数；题池按 `q.id ASC`，会话 `task_code='math_targeted'`、`ref_type='model'`。
- 专项页新增「知识点 / 中考模型」切换；模型模式只展示倍长中线卡片，题量只显示家长已开启的 1/2 档；没有可用档位时禁用并提示。
- handoff `title='倍长中线微专题'`，练习记录/结果页显示该标题；不新增表列、不新增 task code、不改积分规则。

**验证**：server / web 全量测试、两端 build、web lint；手动冒烟 1/2 题、记录标题、无档位禁用。
```

- [ ] **Step 6: 最终 Commit**

```bash
git add docs/ai-core-changelog.md
git commit -m "docs: 倍长中线微专题变更记录"
```

---

## Self-Review

- **Spec coverage**：
  - §4 题池/顺序/置信度 → Task 1 repo + Task 2 service
  - §5.1 GET → Task 1 controller/service/repo
  - §5.2 POST 扩展/校验/会话 → Task 2
  - §6 前端模式/状态/档位/标题 → Task 3
  - §7 积分/记录标题 → Task 3 handoff + Task 2 会话
  - §8 测试 → Task 1/2/3 + Task 5
  - §9 文档 → Task 4 + Task 5
- **Placeholder scan**：无 TBD/TODO；代码步骤均给出完整片段或明确的替换位置。
- **Type consistency**：`ModelSpecial`、`TrainingModelSpecial`、`StartTargetedPayload`、`ModelSpecialPanelProps` 在各任务中签名一致；`startTargetedPractice` 服务端 `modelSpecial?` 保持旧测试兼容。
- **已知取舍**：本期只保留 `selectedModel`（不保留模型列表 state）；`type` 枚举的 `multi_choice` 历史漂移未在本期处理（模型模式强制 null，不影响）。
