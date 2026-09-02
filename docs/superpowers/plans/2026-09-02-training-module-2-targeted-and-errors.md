# 训练模块计划 2/3：错题练习 + 专项练习全栈实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付用户可见的两个训练功能：错题练习（筛选/重做/答对清零联动主线门禁）与专项练习（知识点+题型+题量抽题，带提示），以及支撑专项的 KP 树 LLM 生成与全量题目标注回填。

**Architecture:** 后端新增 `apps/server/src/modules/training/`（NestJS 模块，import PracticeModule 复用已导出的 JudgeCoreService；错题筛选/随机抽题走新 repo 方法；提示走 question_hints 表缓存 + HintCapability）；前端在 `/student/training` 下新增 errors/targeted 两组路由页面，答题核心复用 QuestionRunner（计划 1 已落地，含竞态防护）；KP 树由 LLM 一次性生成种子 SQL，`backfill_question_kps.py` 幂等回填全量题目。

**Tech Stack:** NestJS + TypeScript ESM + Vitest + mysql2、React 18 + Vite + Tailwind + Zustand、Python 3 + pymysql + pytest、本地 llama.cpp Qwen（`LLM_BASE_URL`/`LLM_AUTH_TOKEN`）。

## Global Constraints

- 无 emoji 进 UI/文案；线性 SVG 图标；style.md 单一色系；iPad 横屏 ≥1024px 主断点。
- 答题沉浸页容器挂 `student-theme-container` + `data-theme={mode}`（themeStore）+ `data-school`（镜像 CourseDetailPage.tsx:555 写法）——训练子页属沉浸层，日夜主题生效（终审备忘）。
- TS 严格模式、2 空格缩进；Python PEP 8；Conventional Commits（scope：`server`/`web`/`data-refinery`/`db_loader`）。
- LLM 配置用 `.env` 的 `LLM_BASE_URL`/`LLM_AUTH_TOKEN`，**勿用 ANTHROPIC_***。
- 若测试断言与设计文档冲突，测试错——改测试。
- server 测试：`cd apps/server && npm test`；refinery：`cd tools/data-refinery && pytest`；web：`cd apps/web && npm run lint && npm run build`。
- 抽题 SQL 必须过滤 `answer=''` 的 choice 题（库内 41 道空答案客观题会恒判错——终审 Important 备忘）。
- API 双文档同步：`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须同时更新（Task 10）。
- 计划 1 已落地的契约（勿改签名，本计划按此消费）：
  - `JudgeCoreService.judgeQuestion(input: {studentId, subjectId, questionId, studentAnswer, source, sourceRefId?}): Promise<JudgeOutput>`（judge-core.service.ts:65-91）
  - `PracticeModule` exports `[PracticeService, JudgeCoreService]`（practice.module.ts:38）
  - `QuestionRunnerProps`（QuestionRunner.tsx:34-55）：questions/subjectId/draftKeyPrefix/variant/answerMode?/enableHint?/hints?/onRequestHint?/showResultFeedback?/onSubmit/onFinish/headerExtra?/title?
  - `RunnerQuestion {n, text, type?, options?}`、`RunnerAnswerRecord`（answer/types.ts）
  - `question_hints` 表已建（question_id PK, hint, FK CASCADE）
  - `MainErrorBooksRepository` 已有 `findByStudent(studentId, subjectId?, includeCleared?)`

---

### Task 1: 后端 training 模块骨架 + 错题筛选端点

**Files:**
- Create: `apps/server/src/modules/training/training.module.ts`
- Create: `apps/server/src/modules/training/training.controller.ts`
- Create: `apps/server/src/modules/training/training.service.ts`
- Create: `apps/server/src/modules/training/dto/error-book-query.dto.ts`
- Create: `apps/server/src/modules/training/training.service.test.ts`
- Modify: `apps/server/src/app.module.ts`（注册 TrainingModule）
- Modify: `apps/server/src/database/repositories/main-error-books.repo.ts`（新增筛选查询）

**Interfaces:**
- Consumes: `MainErrorBooksRepository.findByStudent`（现有，无时间/题型过滤）；`questions` 表（type/content）；`question_knowledge_points`（LEFT JOIN 渐进可用）。
- Produces:

```ts
// GET /api/training/error-book?subjectId&from?&to?&type?&kpId?（student JWT）
// 响应（ResponseInterceptor 包装 data 字段）
export interface ErrorBookEntryDto {
  errorBookId: number;
  questionId: number | null;
  questionText: string;      // COALESCE(q.content, meb.wrong_answer_text)
  type: string | null;       // questions.type（孤儿题 null）
  level: number;
  createdAt: string;         // ISO
  kpIds: number[];           // LEFT JOIN qkp，未标注为 []
}
// 实现：main-error-books.repo.ts 新增
async findErrorBookEntries(studentId: number, subjectId: number, filters: {
  from?: string; to?: string; type?: string; kpId?: number;
}): Promise<Array<{...}>>  // 动态 WHERE，默认 is_cleared=0
```

- [ ] **Step 1: 写失败测试**（training.service.test.ts，mock 模式仿 practice.service.test.ts 的 mk()）

```ts
import { describe, it, expect, vi } from 'vitest';
import { TrainingService } from './training.service';

const mk = (overrides: any = {}) => ({
  mainErrorRepo: {
    findErrorBookEntries: vi.fn().mockResolvedValue([]),
    bumpLevels: vi.fn().mockResolvedValue(undefined),
  },
  judgeCore: { judgeQuestion: vi.fn() },
  questionsRepo: { findById: vi.fn(), findRandomByKpAndType: vi.fn() },
  ...overrides,
});
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new TrainingService(deps.mainErrorRepo, deps.judgeCore, deps.questionsRepo);

describe('TrainingService.getErrorBookEntries', () => {
  it('透传筛选参数给 repo', async () => {
    const deps = mk();
    const svc = mkSvc(deps);
    await svc.getErrorBookEntries(1, 1, { from: '2026-09-01', type: 'choice' });
    expect(deps.mainErrorRepo.findErrorBookEntries).toHaveBeenCalledWith(1, 1, { from: '2026-09-01', type: 'choice' });
  });
  it('映射行 -> DTO（kpIds 聚合）', async () => {
    const deps = mk({
      mainErrorRepo: {
        findErrorBookEntries: vi.fn().mockResolvedValue([
          { id: 1, question_id: 10, questionText: '题面', type: 'choice', level: 2, created_at: new Date('2026-09-01'), kp_id: 3 },
          { id: 1, question_id: 10, questionText: '题面', type: 'choice', level: 2, created_at: new Date('2026-09-01'), kp_id: 5 },
        ]),
        bumpLevels: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.getErrorBookEntries(1, 1, {});
    expect(r).toHaveLength(1);
    expect(r[0].kpIds).toEqual([3, 5]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`main-error-books.repo.ts` 新增（动态 WHERE，参数化防注入；kpId 过滤用 EXISTS 子查询保证不因 JOIN 产生重复行）：

```ts
  /** 错题练习筛选：时间范围（created_at）/题型（JOIN questions）/专项（EXISTS qkp）。
   *  返回未清零记录，每行带 kp_id（同题多 KP 会出多行，service 层聚合）。 */
  async findErrorBookEntries(studentId: number, subjectId: number, filters: {
    from?: string; to?: string; type?: string; kpId?: number;
  }): Promise<Array<{ id: number; question_id: number | null; questionText: string | null; type: string | null; level: number; created_at: Date; kp_id: number | null }>> {
    const conditions = ['meb.student_id = ?', 'meb.subject_id = ?', 'meb.is_cleared = 0'];
    const params: any[] = [studentId, subjectId];
    if (filters.from) { conditions.push('meb.created_at >= ?'); params.push(filters.from); }
    if (filters.to) { conditions.push('meb.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(filters.to); }
    if (filters.type) { conditions.push('q.type = ?'); params.push(filters.type); }
    if (filters.kpId) { conditions.push('EXISTS (SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = meb.question_id AND qkp.knowledge_point_id = ?)'); params.push(filters.kpId); }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT meb.id, meb.question_id, COALESCE(q.content, meb.wrong_answer_text) AS questionText,
              q.type, meb.level, meb.created_at, qkp.knowledge_point_id AS kp_id
       FROM main_error_books meb
       LEFT JOIN questions q ON meb.question_id = q.id
       LEFT JOIN question_knowledge_points qkp ON qkp.question_id = meb.question_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY meb.created_at DESC`,
      params,
    );
    return rows as any[];
  }
```

`training.service.ts`：`getErrorBookEntries(studentId, subjectId, filters)`——调 repo，按 errorBookId 聚合 kpIds，映射 DTO（created_at.toISOString()）。`training.controller.ts`：`@Controller('api/training')` + `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('student')`，GET error-book 端点（Query 参数 from/to/type 为 string，kpId/subjectId ParseIntPipe）。`training.module.ts`：imports `[PracticeModule]`（复用 JudgeCoreService），providers `[TrainingService, MainErrorBooksRepository, QuestionsRepository]`，controllers `[TrainingController]`。`app.module.ts` imports 加 TrainingModule。DTO 用 plain interface（项目惯例）。

- [ ] **Step 4: 全量回归**

Run: `cd apps/server && npm test`
Expected: 全绿（既有 265 + 新增）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/training/ apps/server/src/app.module.ts apps/server/src/database/repositories/main-error-books.repo.ts
git commit -m "feat(server): training 模块骨架 + 错题练习筛选端点"
```

---

### Task 2: 错题练习判题端点 + 仍错 bump

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts`（POST judge）
- Modify: `apps/server/src/modules/training/training.service.ts`
- Create: `apps/server/src/modules/training/dto/judge-training.dto.ts`
- Modify: `apps/server/src/modules/training/training.service.test.ts`（追加）

**Interfaces:**
- Consumes: `JudgeCoreService.judgeQuestion`（计划 1）；`MainErrorBooksRepository.bumpLevels`（现有）。
- Produces:

```ts
// POST /api/training/judge {questionId, subjectId, studentAnswer, source: 'targeted'|'error_practice'}
// 响应 = JudgeOutput（questionId/isCorrect/method/analysis/errorType/errorBookId）
// POST /api/training/bump-error-levels {errorBookIds: number[]} -> void（复用既有 repo.bumpLevels）
```

- [ ] **Step 1: 写失败测试（追加）**

```ts
describe('TrainingService.judgeTraining', () => {
  it('error_practice 来源透传 JudgeCore', async () => {
    const deps = mk({ judgeCore: { judgeQuestion: vi.fn().mockResolvedValue({ questionId: 10, isCorrect: true, method: 'exact', analysis: null, errorType: null, errorBookId: undefined }) } });
    const svc = mkSvc(deps);
    await svc.judgeTraining({ studentId: 1, questionId: 10, subjectId: 1, studentAnswer: 'A', source: 'error_practice' });
    expect(deps.judgeCore.judgeQuestion).toHaveBeenCalledWith({ studentId: 1, questionId: 10, subjectId: 1, studentAnswer: 'A', source: 'error_practice', sourceRefId: null });
  });
});
```

- [ ] **Step 2: 跑测试确认失败 → Step 3: 实现**

`training.service.ts`：

```ts
  /** 训练判题：JudgeCore 题中心变体的薄封装（source 由端点语义决定，不透传客户端任意值）。 */
  async judgeTraining(input: { studentId: number; questionId: number; subjectId: number; studentAnswer: string; source: 'targeted' | 'error_practice' }) {
    return this.judgeCore.judgeQuestion({ ...input, sourceRefId: null });
  }
```

controller 的 judge 端点 body 校验 source 只接受 'targeted' | 'error_practice'（白名单，非法 400）；bump-error-levels 端点镜像 practice.controller.ts:106-112 的写法。

- [ ] **Step 4: 回归 + Commit**

```bash
git commit -m "feat(server): training 判题端点（JudgeCore 封装）+ 仍错 bump"
```

---

### Task 3: 提示端点（question_hints 缓存）

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts`（POST hint）
- Modify: `apps/server/src/modules/training/training.service.ts`
- Create: `apps/server/src/database/repositories/question-hints.repo.ts`
- Modify: `apps/server/src/modules/training/training.module.ts`（providers 加 QuestionHintsRepository + HintCapability）
- Modify: `apps/server/src/modules/training/training.service.test.ts`（追加）
- Modify: `apps/server/src/database/repositories/index.ts`（导出）

**Interfaces:**
- Consumes: `HintCapability.generate({questionContent, subject})`（hint.capability.ts:35，返回 `{content}`）；`question_hints` 表。
- Produces:

```ts
// POST /api/training/hint {questionId} -> {hint: string, cached: boolean}
// 镜像 PracticeService.getHint 的缓存语义：命中直返；未命中 AI 生成 + 写回（失败不阻断返回）
export class QuestionHintsRepository {
  async findByQuestionId(questionId: number): Promise<{ hint: string } | null>;
  async upsert(questionId: number, hint: string): Promise<void>;  // INSERT ... ON DUPLICATE KEY UPDATE
}
```

- [ ] **Step 1: 失败测试（追加，hint 语义三态：缓存命中 / 生成+写回 / AI 失败 503）**

```ts
describe('TrainingService.getHint', () => {
  it('缓存命中直返，不调 AI', async () => {
    const deps = mk({
      questionHintsRepo: { findByQuestionId: vi.fn().mockResolvedValue({ hint: '旧提示' }), upsert: vi.fn() },
      hint: { generate: vi.fn() },
      questionsRepo: { findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', type: 'choice' }) },
    });
    const r = await mkSvc2(deps).getHint({ questionId: 10 });
    expect(r).toEqual({ hint: '旧提示', cached: true });
    expect(deps.hint.generate).not.toHaveBeenCalled();
  });
  // 另两个用例：未命中 -> generate + upsert + cached:false；generate 抛错 -> HttpException 503
});
```

（mkSvc2 = 含 questionHintsRepo/hint 的构造；service 构造函数在 Task 1 基础上追加 2 个依赖，既有测试 mk() 同步补占位——机械调整。）

- [ ] **Step 2: 失败 → Step 3: 实现（镜像 practice.service.ts:475-510 的 getHint 三段式：查缓存→生成→写回）**

repo SQL：

```ts
  async findByQuestionId(questionId: number) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT hint FROM question_hints WHERE question_id = ?`, [questionId]);
    return (rows[0] as { hint: string }) ?? null;
  }
  async upsert(questionId: number, hint: string) {
    await this.pool.execute(
      `INSERT INTO question_hints (question_id, hint) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE hint = VALUES(hint), updated_at = CURRENT_TIMESTAMP(3)`,
      [questionId, hint]);
  }
```

service：getHint 先 questionsRepo.findById 拿题面（404 若无）→ 查缓存 → 未命中 `this.hint.generate({ questionContent: q.content, subject: 'math' })` → upsert best-effort → 返回。module providers 加 QuestionHintsRepository + HintCapability（可直接实例化，镜像 practice.module 模式）。

- [ ] **Step 4: 回归 + Commit**

```bash
git commit -m "feat(server): training 提示端点（question_hints 题级缓存）"
```

---

### Task 4: 前端 API 层 + 错题练习页面（列表 + 筛选）

**Files:**
- Modify: `apps/web/src/services/api.ts`（追加 training API 函数）
- Create: `apps/web/src/pages/student/training/ErrorPracticePage.tsx`（列表+筛选）
- Modify: `apps/web/src/routes/index.tsx`（注册 /student/training/errors）

**Interfaces:**
- Consumes: Task 1-3 端点。
- Produces（api.ts，供 Task 5/8 消费）:

```ts
export interface TrainingErrorBookEntry { errorBookId: number; questionId: number | null; questionText: string; type: string | null; level: number; createdAt: string; kpIds: number[]; }
export function getTrainingErrorBook(params: { subjectId: number; from?: string; to?: string; type?: string; kpId?: number }): Promise<TrainingErrorBookEntry[]>;
export function judgeTraining(payload: { questionId: number; subjectId: number; studentAnswer: string; source: 'targeted' | 'error_practice' }): Promise<JudgeResult>;
export function bumpTrainingErrorLevels(errorBookIds: number[]): Promise<void>;
export function getTrainingHint(questionId: number): Promise<HintResult>;
```

- [ ] **Step 1: api.ts 追加**（fetchApi 模式照抄 judgePractice 附近写法；from/to 为 YYYY-MM-DD 字符串，URL 拼接 encodeURIComponent）

- [ ] **Step 2: ErrorPracticePage**

页面结构（容器镜像 CourseDetailPage.tsx:555 的沉浸层写法：`student-theme-container` + `data-theme={mode}` + `data-school`；themeStore 的 mode/autoToggleNightMode 在 useEffect 挂一次）：

- 顶栏：BackButton 回 `/student/training` + 标题「错题练习」。
- 筛选区（Card）：时间范围（两个 `<input type="date">` 从/到）、题型下拉（全部/选择/填空/判断/解答/证明）、专项下拉（先渲染「全部」，KP 数据 Task 7 接入后填充）、「查询」按钮。
- 列表：每条错题一行（题型 Tag、level 圆点、题面 Markdown 截断两行、created_at 日期），多选 checkbox，底部「开始练习（N 题）」按钮（N=选中数，至少 1 题可点）→ navigate 到 run 页（题单放 sessionStorage：` sessionStorage.setItem('training:errors', JSON.stringify(entries))`，run 页读后即删）。
- 空态：无可练错题时居中提示「当前筛选下没有待练错题」+线性 SVG 图标。
- 数据加载：mount 时 getTrainingErrorBook({subjectId: 1})（数学硬编码 MATH_SUBJECT_ID=1，与现有页一致）。

- [ ] **Step 3: 路由注册**：`/student/training/errors`（RequireRole student，独立全屏路由，与 /student/training 同层）。

- [ ] **Step 4: lint + build + Commit**

```bash
git commit -m "feat(web): 错题练习列表页（时间/题型筛选 + 选题）"
```

---

### Task 5: 前端错题练习答题页（QuestionRunner 消费 + 清零联动）

**Files:**
- Create: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`
- Modify: `apps/web/src/routes/index.tsx`（注册 /student/training/errors/run）

**Interfaces:**
- Consumes: QuestionRunner（计划 1）、Task 4 API、AnswerResultList（components/business/）。
- Produces: 完整错题练习闭环。

- [ ] **Step 1: 实现 run 页**

核心逻辑（镜像 CleanupPhase 的收尾语义但走 training 端点）：

```tsx
// 状态机：answering（QuestionRunner） -> result（AnswerResultList）
// 1. mount：读 sessionStorage('training:errors') -> entries；空则 navigate 回列表页
// 2. questions 映射：RunnerQuestion {n: String(entry.errorBookId), text: entry.questionText, type: entry.type ?? undefined}
//    （n 用 errorBookId 保证唯一；draftKeyPrefix = 'errp'）
// 3. onSubmit: (q, answer) => judgeTraining({questionId, subjectId: 1, studentAnswer: answer, source: 'error_practice'})
//    注意 entry.questionId 可能为 null（孤儿题）——列表页筛选时只允许选 questionId 非空的题进入练习
//    （孤儿题无法走题中心判题，列表项禁选 + 提示「该题未入库，暂不支持线上重做」）
// 4. hints 状态 + onRequestHint: getTrainingHint(questionId) 返回 res.hint，父层 setHints
// 5. onFinish(results)：
//    a. 仍错的 errorBookIds = entries.filter(e => { const r = results[String(e.errorBookId)]; return r && !r.isCorrect && !r.failed; })
//    b. bumpTrainingErrorLevels(ids)（best-effort catch）
//    c. setPhase('result')，渲染 AnswerResultList（questions/answers 直接喂，onClose 回列表页并刷新）
```

容器同 Task 4 沉浸层写法。AnswerResultList 是全屏 modal 样式（fixed inset-0），直接在 result 态渲染即可（CleanupPhase 的 hasErrors 态同款用法）。

- [ ] **Step 2: 路由注册**：`/student/training/errors/run`。

- [ ] **Step 3: lint + build + Commit**

```bash
git commit -m "feat(web): 错题练习答题页（判题/提示/答对清零/仍错 bump）"
```

---

### Task 6: KP 树 LLM 生成脚本 + 种子 SQL

**Files:**
- Create: `tools/data-refinery/src/generate_kp_tree.py`
- Create: `tools/data-refinery/src/prompts/kp_tree.txt`
- Create: `tools/db/migrations/2026-09-XX_add_math_knowledge_points.sql`（生成产物，日期用执行日）
- Test: `tools/data-refinery/tests/test_generate_kp_tree.py`

**Interfaces:**
- Consumes: `create_llm_client`（llm.py:299，cfg 同 backfill_practice_questions.py 的构造方式）；`_parse_json_object`（extract.py）。
- Produces:

```python
# generate_kp_tree.py
def build_kp_seed_sql(tree: list[dict], subject_id: int = 1) -> str:
    """LLM 输出的 [{name, children: [{name}]}] 两级树 -> INSERT IGNORE SQL 字符串。
    code 列生成规则：一级用拼音首字母不可靠——直接用自增序号 "M{n:02d}" / "M{n:02d}{m:02d}"。
    幂等：INSERT IGNORE + code 唯一（knowledge_points 无唯一约束，改为 NOT EXISTS 防重插，
    或 SELECT 检查——实现按 schema.sql 实际约束定，报告说明选择）。"""

# main(): 调 LLM（prompt 要求输出 JSON 两级树，一级 8 大领域 + 二级展开），
# 校验（一级 6-12 个、二级每类 5-20 个、名称非空去重），生成 SQL 写入
# tools/db/migrations/YYYY-MM-DD_add_math_knowledge_points.sql，grade_band='junior'。
```

- [ ] **Step 1: 失败测试**（build_kp_seed_sql 纯函数：两级树→SQL 文本断言；非法输入（空名/重复名/超界数量）抛 ValueError；LLM 不参与——mock）

- [ ] **Step 2: 失败 → Step 3: 实现**

prompt（kp_tree.txt）核心要求：按义务教育数学课程标准（2022 版）梳理初中数学知识点两级树；一级为领域（数与式/方程与不等式/函数/三角形/四边形/圆/图形变换/统计与概率等），二级为可考查知识点；只输出 JSON：`[{"name": "...", "children": [{"name": "..."}]}]`；不得输出其他文本。

- [ ] **Step 4: 跑测试通过 + 执行生成**（`cd tools/data-refinery && python src/generate_kp_tree.py`，人工过目产出的 SQL 后执行入库）+ Commit

```bash
git commit -m "feat(data-refinery): KP 树 LLM 生成脚本 + 初中数学种子 SQL"
```

---

### Task 7: 题目 KP 标注回填脚本

**Files:**
- Create: `tools/data-refinery/src/backfill_question_kps.py`
- Create: `tools/data-refinery/src/prompts/question_kps.txt`
- Test: `tools/data-refinery/tests/test_backfill_question_kps.py`

**Interfaces:**
- Consumes: `create_llm_client`；`knowledge_points` 表（Task 6 种子）；`questions` 表。
- Produces: `question_knowledge_points` 填充（role='primary'，每题 1-3 个 kp）。

- [ ] **Step 1: 失败测试**（核心纯函数 + mock LLM，镜像 test_card_labeler.py 的手法）：

```python
# 被测核心：parse_kp_response(raw: str, whitelist: dict[int, str]) -> list[int]
# - 合法 kp_id（在白名单内）保留，去重，超过 3 个截前 3
# - 非法 id / 非法 JSON -> 空列表（调用方按失败处理，可重试）
# 主流程幂等：SELECT 未标注题（LEFT JOIN qkp IS NULL）只处理无记录题
```

- [ ] **Step 2: 失败 → Step 3: 实现**

脚本主流程（镜像 backfill_practice_questions.py 结构）：连接 DB（cfg 同款 pymysql.connect）→ 加载 KP 白名单（`SELECT id, name FROM knowledge_points WHERE subject_id=1`）→ 分批（每批 10 题）调 LLM（prompt 附白名单清单 + 每题 id/题面截断 500 字，要求输出 `{"items": [{"qid": 123, "kps": [1, 17]}]}`）→ 白名单校验 → `INSERT IGNORE INTO question_knowledge_points (question_id, knowledge_point_id, role) VALUES ...` → 打印统计（标注/跳过/失败清单，失败可重跑）。

- [ ] **Step 4: 测试通过 + 执行回填**（全量 ~447 题，本地 Qwen 批量）+ 验证：

```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT COUNT(*) FROM question_knowledge_points;"
```

抽样人工校对 10 题（spec §6.2 质量验收）后 Commit。

```bash
git commit -m "feat(data-refinery): 题目 KP 标注回填脚本 + 全量标注"
```

---

### Task 8: 专项练习后端（KP 树 + 随机抽题）

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts`（GET knowledge-points、POST targeted/start）
- Modify: `apps/server/src/modules/training/training.service.ts`
- Create: `apps/server/src/database/repositories/knowledge-points.repo.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.ts`（findRandomByKpAndType）
- Modify: `apps/server/src/modules/training/training.module.ts` + `repositories/index.ts`
- Modify: `apps/server/src/modules/training/training.service.test.ts`（追加）

**Interfaces:**
- Produces:

```ts
// GET /api/training/knowledge-points?subjectId=1 -> Array<{id, name, parentId, gradeBand}>
// POST /api/training/targeted/start {subjectId, kpId, type, count} ->
//   { questions: Array<{questionId, text, type, options}> }  （不含 answer/explanation）
// questions.repo.ts 新增：
async findRandomByKpAndType(subjectId: number, kpId: number, type: string | null, count: number): Promise<QuestionRow[]>
// SQL: SELECT q.* FROM questions q JOIN question_knowledge_points qkp ON qkp.question_id = q.id
//      WHERE q.subject_id=? AND qkp.knowledge_point_id=? AND q.is_active=1
//        [AND q.type=?] AND NOT (q.type IN ('choice','true_false') AND q.answer='')
//      ORDER BY RAND() LIMIT ?
```

- [ ] **Step 1: 失败测试**：service 层透传参数 + 空结果处理（抽不到题返回空数组，controller 层 404「该组合下暂无题目」）；repo 的 SQL 断言（mock pool execute 断言 SQL 文本含 JOIN/answer='' 过滤/RAND()）。
- [ ] **Step 2: 失败 → Step 3: 实现**（knowledge-points.repo.ts：`findBySubject(subjectId)` 返回平铺列表，树形组装放前端；抽题题单映射剥离 answer/explanation 字段——白名单序列化，防答案泄露）。
- [ ] **Step 4: 回归 + Commit**

```bash
git commit -m "feat(server): 专项练习端点（KP 树 + 随机抽题）"
```

---

### Task 9: 前端专项练习页面（配置 + 答题）

**Files:**
- Modify: `apps/web/src/services/api.ts`（KP 树 + 抽题 API）
- Create: `apps/web/src/pages/student/training/TargetedConfigPage.tsx`
- Create: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/routes/index.tsx`（注册 /student/training/targeted(/run)）
- Modify: `apps/web/src/pages/student/TrainingSubjectPage.tsx`（数学卡改导航 /student/training/targeted——专项为训练默认落地页，考试入口占位仍在）

**Interfaces:**
- Consumes: Task 8 端点、QuestionRunner、AnswerResultList、Task 4 judgeTraining（source='targeted'）/getTrainingHint。

- [ ] **Step 1: api.ts 追加**（getKnowledgePoints、startTargetedPractice）

- [ ] **Step 2: TargetedConfigPage**：沉浸层容器；KP 两级级联选择（一级 Chip 组 + 二级列表，单选二级）；题型下拉（全部/选择/填空/判断/解答/证明，映射 questions.type 枚举）；题量档（3/5/8/10，Chip 单选）；「开始练习」→ startTargetedPractice → 题单 sessionStorage('training:targeted') → run 页；空题库提示「该专项暂无足够题目」。

- [ ] **Step 3: TargetedRunPage**：镜像 Task 5 run 页（draftKeyPrefix='tp'；source='targeted'；onFinish 后 AnswerResultList，仍错题**不入** bump——专项练习答错已由 JudgeCore 自动入错题本，收尾无需 bump；onClose 回配置页）。题单 RunnerQuestion：n=String(questionId)。

- [ ] **Step 4: TrainingSubjectPage 数学卡导航改 '/student/training/targeted'**（占位的 exam 路由保留——学生从专项页顶部 Tab 或后续考试任务进入考试；本任务在配置页顶栏加「考试」文字链接到 /student/training/exam 占位页，保持可达）。

- [ ] **Step 5: lint + build + 手动走查**（登录 → 训练 → 数学 → 专项配置 → 抽题 → 做题 → 提示按钮 → 结果页）+ Commit

```bash
git commit -m "feat(web): 专项练习配置页 + 答题页"
```

---

### Task 10: API 双文档同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4 新增「Training — /api/training」小节：error-book/judge/hint/knowledge-points/targeted/bump-error-levels 六端点，阶段=MVP；§6 补错题练习与专项练习数据流）
- Modify: `docs/api/openapi.yaml`（同步收录全部端点，JWT bearer + student role）

- [ ] **Step 1: 两文档同步更新**（端点路径/方法/参数/响应结构逐一对照实现）。
- [ ] **Step 2: 一致性核对**：

```bash
grep -o "'/api/training[^']*'" docs/API接口与数据流设计文档.md | sort -u
grep -o "/api/training[^']*" docs/api/openapi.yaml | sort -u
```

两清单一致。Commit：`docs(api): 训练模块（错题/专项）API 双文档同步`。

---

## 自检记录（Self-Review）

1. **Spec 覆盖**：spec §7.3 错题练习（Task 1-5）、§6.2 KP 种子+标注（Task 6-7）、§7.2 专项练习（Task 8-9）、§8 文档（Task 10）全覆盖。spec §7.1 考试属计划 3/3。
2. **占位符**：Task 6 的幂等策略给了两个选项并要求实现时按实际约束定+报告说明——这是适配指令；其余任务代码/断言完整。
3. **类型一致性**：judgeTraining 入参透传 JudgeCoreQuestionInput（source 白名单收紧）；ErrorBookEntryDto 与前端 TrainingErrorBookEntry 字段一一对应；RunnerQuestion.n 的键约定（errorBookId vs questionId）在 Task 5/9 分别显式写明。
4. **终审备忘落实**：answer='' 过滤（Task 8 SQL）；hint 缓存（Task 3）；沉浸层主题容器（Task 4/9）；JudgeCore 经 PracticeModule import 复用（Task 1 module imports）。

## 后续（计划 3/3，不在本文件）

考试全栈：exams 模块（papers 列表/会话生命周期/单题提交/交卷/结果）+ 前端考试页（倒计时/续考/自动交卷）+ PRD/style.md 三轨修订 + AnswerModal/CleanupPhase 收敛 + 管线回填执行。
