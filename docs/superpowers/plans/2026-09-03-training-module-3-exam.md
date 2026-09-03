# 训练模块计划 3/3：考试全栈 + 收尾实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付考试功能全栈（试卷列表/会话/限时作答/自动交卷/判分结果），完成 PRD 与 style.md 三轨修订、API 双文档同步、组件收敛（AnswerModal/CleanupPhase 消费 QuestionRunner）与终审遗留项清理。

**Architecture:** 后端新增 `apps/server/src/modules/exams/`（NestJS，import PracticeModule 复用 JudgeCoreService；会话/作答走 exam_sessions/exam_answers 两张已建表，服务器权威计时 deadline_at，过期自动收卷）；前端三页：试卷列表（筛选+时长选择）→ 考试进行页（QuestionRunner embedded 无 hint 无反馈 + 恒显大倒计时）→ 结果页（AnswerResultList）；数据侧执行管线回填把已发布试卷归组入 exam_papers/paper_questions（published 目录已有数据，exam_papers 当前 0 行）。

**Tech Stack:** NestJS + TypeScript ESM + Vitest + mysql2、React 18 + Vite + Tailwind、Python 管线回填（无新代码）。

## Global Constraints

- 无 emoji 进 UI/文案；线性 SVG 图标；style.md 单一色系；iPad 横屏 ≥1024px 主断点。
- 考试页容器挂 `student-theme-container` + `data-theme={mode}` + `data-school`（镜像 ErrorPracticePage）。
- **考试不泄露对错**：单题提交响应白名单序列化（剥 is_correct/analysis/error_type）；GET 会话恢复不回传判题结果；前端 showResultFeedback=false。
- 服务器权威计时：deadline_at 由服务端算，remainingSeconds 服务端返回；超 deadline 拒收（409）并触发自动收卷。
- API 双文档同步（docs/API接口与数据流设计文档.md + docs/api/openapi.yaml）。
- 计划 1/2 已落地的契约（勿改签名）：JudgeCoreService.judgeQuestion（JudgeOutput{questionId,isCorrect,method,analysis,errorType,errorBookId}，judge-core.service.ts:56-91）；QuestionRunnerProps（QuestionRunner.tsx:34-55，showResultFeedback 已支持）；normalizeOptions（apps/web/src/pages/student/training/normalizeOptions.ts）；exam_papers/paper_questions/exam_sessions/exam_answers 表（tools/db/schema.sql 已回灌）。
- Conventional Commits（scope：server/web/api/docs/refinery）。
- server 测试：`cd apps/server && npm test`；web：`npm run lint && npm run build`。

---

### Task 1: exams 模块骨架 + 试卷列表/详情端点

**Files:**
- Create: `apps/server/src/modules/exams/exams.module.ts`
- Create: `apps/server/src/modules/exams/exams.controller.ts`
- Create: `apps/server/src/modules/exams/exams.service.ts`
- Create: `apps/server/src/modules/exams/exams.service.test.ts`
- Create: `apps/server/src/modules/exams/dto/paper-query.dto.ts`
- Create: `apps/server/src/database/repositories/exam-papers.repo.ts`
- Modify: `apps/server/src/app.module.ts`（注册 ExamsModule）
- Modify: `apps/server/src/database/repositories/index.ts`

**Interfaces:**
- Consumes: exam_papers/paper_questions 表。
- Produces:

```ts
// GET /api/exams/papers?subjectId&year?&district?&examType?&gradeBand? -> ExamPaperDto[]
export interface ExamPaperDto { id: number; title: string; year: number | null; district: string | null; examType: string | null; gradeBand: string | null; questionCount: number; }
// GET /api/exams/papers/:id -> PaperDetailDto（题目元数据 + 推荐时长；不含 answer/explanation）
export interface PaperDetailDto { id: number; title: string; durationMinutes: number; questions: Array<{ questionId: number; questionNo: number; text: string; type: string; options: Array<{label:string;text:string}> | string[] | null }>; }
// 推荐时长：choice/true_false ×1min + 其余 ×3min，向上取整到 15 的倍数，clamp 30-180
export class ExamPapersRepository {
  async findPapers(filters: { subjectId: number; year?: number; district?: string; examType?: string; gradeBand?: string }): Promise<ExamPaperRow[]>;
  async findById(id: number): Promise<ExamPaperRow | null>;
  async findQuestionsByPaperId(paperId: number): Promise<Array<{ questionId: number; questionNo: number; text: string; type: string; options: string | null }>>;  // JOIN paper_questions ORDER BY question_no
}
```

- [ ] **Step 1: 写失败测试**（exams.service.test.ts，mk/mkSvc 模式仿 training.service.test.ts）

```ts
// 用例组：
// 1. listPapers 透传筛选参数；映射 row -> ExamPaperDto（questionCount 取 repo 计数）
// 2. getPaperDetail：repo 返回 3 题（choice/proof/short_answer）-> 推荐时长 = ceil((1*2 + 3*1)/15)*15 = 15? -> clamp 到 30
//    （断言 durationMinutes === 30；另造一卷 40 道客观题 -> ceil(40/15)*15=45 -> 45）
// 3. getPaperDetail 题单不含 answer/explanation（白名单断言：Object.keys 或 JSON.stringify 不含）
// 4. paper 不存在 -> 404
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）

- [ ] **Step 3: 实现**

repo SQL：

```ts
// findPapers: SELECT id, title, year, district, exam_type, grade_band, question_count FROM exam_papers
//   WHERE subject_id = ? [AND year = ?] [AND district = ?] [AND exam_type = ?] [AND grade_band = ?] ORDER BY year DESC, id DESC
// findQuestionsByPaperId:
//   SELECT q.id AS questionId, pq.question_no AS questionNo, q.content AS text, q.type, q.options
//   FROM paper_questions pq JOIN questions q ON q.id = pq.question_id
//   WHERE pq.paper_id = ? AND q.is_active = 1 ORDER BY pq.question_no
```

service：`computeRecommendedDuration(questions: Array<{type: string}>): number` 纯函数（1min/3min 求和 → Math.ceil(n/15)*15 → clamp(30,180)）；getPaperDetail 组装（options 复用 training.service 的 parseOptions 模式——拷贝为模块内私有或提取共享 util，**推荐提取**到 `apps/server/src/common/utils/parse-options.util.ts`，training.service 同步改 import，单一实现）。controller：两个 GET 端点，student JWT（同 training 模式）；:id 用 ParseIntPipe。module：providers [ExamsService, ExamPapersRepository]，无 imports 需求（Task 2 才 import PracticeModule）。

- [ ] **Step 4: 全量回归 npm test + Commit**

```bash
git commit -m "feat(server): exams 模块骨架 + 试卷列表/详情端点（推荐时长）"
```

---

### Task 2: 考试会话生命周期（创建/恢复/单题提交/交卷/结果）

**Files:**
- Modify: `apps/server/src/modules/exams/exams.controller.ts`（5 端点）
- Modify: `apps/server/src/modules/exams/exams.service.ts`
- Create: `apps/server/src/modules/exams/dto/session-create.dto.ts`
- Create: `apps/server/src/database/repositories/exam-sessions.repo.ts`
- Modify: `apps/server/src/modules/exams/exams.module.ts`（import PracticeModule）
- Modify: `apps/server/src/modules/exams/exams.service.test.ts`（追加）

**Interfaces:**
- Consumes: JudgeCoreService.judgeQuestion（source='exam', sourceRefId=session_id）；exam_sessions/exam_answers 表。
- Produces:

```ts
export class ExamSessionsRepository {
  async create(row: { studentId, paperId, subjectId, durationMinutes, deadlineAt }): Promise<number>;
  async findById(id: number): Promise<ExamSessionRow | null>;
  async findInProgressByStudentPaper(studentId: number, paperId: number): Promise<ExamSessionRow | null>;
  async markSubmitted(id: number): Promise<void>;
  async upsertAnswer(row: { sessionId, questionId, questionOrder, answerText, isCorrect?, method?, analysis?, errorType?, judgedAt? }): Promise<void>;  // INSERT ... ON DUPLICATE KEY UPDATE
  async findAnswersBySession(sessionId: number): Promise<ExamAnswerRow[]>;
}

// POST /api/exams/sessions {paperId, durationMinutes} -> {sessionId, deadlineAt, remainingSeconds, questions: [...PaperDetailDto.questions]}
//   同卷已有 in_progress 会话 -> 直接返回该会话（续考，不重置时长）
// GET /api/exams/sessions/:id -> {sessionId, status, remainingSeconds, questions, answered: Record<questionId, {answerText}>}  // 不回传对错
//   发现 deadline 已过 -> 服务端自动收卷（调 submit 逻辑）-> 返回 status='submitted'
// POST /api/exams/sessions/:id/answers {questionId, answerText} -> {saved: true}  // 白名单响应；判题后台进行落 exam_answers
//   超 deadline -> 409 + 触发自动收卷
// POST /api/exams/sessions/:id/submit -> {correctCount, totalCount, accuracy}
//   未作答题按错计（method='unanswered'）并入错题本；在途判题（is_correct IS NULL 且 answer_text 非空）同步补判（逐题调 JudgeCore，限 judgment 90s per-scene 已由 retry.yaml 保证；失败按错计 method='failed' 仍入错题本）
// GET /api/exams/sessions/:id/results -> {correctCount, totalCount, accuracy, items: Array<{questionId, questionNo, text, type, options, answerText, isCorrect, analysis, explanation}>}
//   JOIN questions 取 explanation
```

- [ ] **Step 1: 写失败测试**（核心场景，mock repo + judgeCore）：

```ts
// 1. createSession：无 in_progress -> 新建（deadline = now + duration）；有 in_progress -> 返回既有（断言 repo.create 未调）
// 2. submitAnswer：正常路径 -> judgeCore.judgeQuestion 以 source='exam'/sourceRefId=sessionId 调用 -> upsertAnswer 落 is_correct/method/analysis -> 响应只有 {saved:true}（白名单断言）
// 3. submitAnswer 超 deadline -> 409 + markSubmitted 被调（自动收卷）+ 未答题入错题本路径
// 4. submit：2 题未答 + 1 题已答对 -> 未答题 judgeCore 不被调（直接 method='unanswered' 判错 + mainErrorRepo.create 路径——注意：JudgeCore 的 judgeQuestion 不处理「未作答」场景，
//    未答题的错题本写入走 exams service 直接调 mainErrorRepo（source='exam'），已在途判题补判走 judgeCore）
// 5. getSession：deadline 未过 -> 返回 answered map 无 is_correct 字段；deadline 已过 -> 自动收卷 + status='submitted'
// 6. getResults：汇总 accuracy + items 含 explanation
```

**注意**：judgeCore.judgeQuestion 的入参是 studentAnswer——未作答题不走 judgeCore（无答案可判），直接写 exam_answers（is_correct=0, method='unanswered'）+ mainErrorRepo.create（question_id, source='exam', source_ref_id=sessionId）。已在途判题（fire-and-forget 提交后学生没等到判完就交卷——本设计中单题提交是 await 判题完成再返回还是 fire-and-forget？**设计决定：单题提交端点同步判题**（exact 即返，AI 最长 judgment 90s）——前端 QuestionRunner 的 onSubmit await 它，学生切题时请求在后台继续（fetch 不 abort），与错题练习体验一致。submit 时的「在途补判」仅兜：提交后 answer 落库但判题 HTTP 尚未返回的窗口（崩溃/断网场景，is_correct IS NULL 且 answer_text 非空）。）

- [ ] **Step 2: 失败 → Step 3: 实现**

service 核心流程：
- `createSession`：findInProgressByStudentPaper 命中返回；否则 deadline_at = new Date(now + duration*60000)，create，返回题单（复用 getPaperDetail 的查询）。
- `submitAnswer`：查 session → 过期则 409 + autoSubmit + 抛；否则 judgeCore.judgeQuestion（source='exam', sourceRefId=sessionId）→ upsertAnswer（is_correct/method/analysis/error_type/judged_at）→ 返回 {saved:true}（**白名单**——判题结果只在 results 出现）。
- `submit`（幂等：status 已 submitted 直接重算返回）：① findAnswersBySession；② 未答题（题单里有但 answers 无）→ upsertAnswer(unanswered) + mainErrorRepo.create；③ 在途题（answer_text 非空 is_correct NULL）→ judgeCore 补判（catch → method='failed' 判错 + 错题本）；④ markSubmitted；⑤ 汇总返回。
- `getSession`：过期 → autoSubmit（复用 submit 内部逻辑）；answered map 只含 answerText。
- `getResults`：仅 submitted 可查（in_progress 409）；items JOIN questions 带 explanation。

- [ ] **Step 4: 全量回归 + Commit**

```bash
git commit -m "feat(server): 考试会话生命周期（创建/续考/单题判题/交卷/自动收卷/结果）"
```

---

### Task 3: 管线试卷归组回填（数据准备，执行型任务）

**Files:** 无新代码（执行既有 db_loader_cli）。

- [ ] **Step 1: 执行增量回填**

```bash
cd tools/data-refinery && python src/db_loader_cli.py --load-cards
```

（参数按 docs/data-refinery-使用手册.md 既有惯例——published 目录指向 output/published；增量模式不动业务数据。）

- [ ] **Step 2: 验证归组结果**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT id, title, year, district, exam_type, question_count FROM exam_papers;"
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT paper_id, COUNT(*), MIN(question_no), MAX(question_no) FROM paper_questions GROUP BY paper_id;"
```

Expected: exam_papers ≈ 已发布数学试卷数（published/数学 下每卷一行，含化学目录则化学卷也归组——subject 按目录首段推导，正确行为）；每卷 question_no 1..n 连续。**含化学卷**：题库 subject 按路径推导（publish 修正过），化学卷归组为 subject_id=chemistry 的 paper——前端只查 subjectId=1（数学）不会显示，无害。

- [ ] **Step 3: 冒烟 GET /api/exams/papers**（server 起来后 curl 或推迟到 Task 5 联调一起做——记录选择）

- [ ] **Step 4: 无代码提交**（纯数据操作；若有发现归组 bug 则回计划 1 的 Task 3 修复路径，单独 fix commit）

---

### Task 4: 前端考试页面（列表 + 时长选择）

**Files:**
- Modify: `apps/web/src/services/api.ts`（exams API 函数）
- Create: `apps/web/src/pages/student/training/ExamListPage.tsx`
- Modify: `apps/web/src/routes/index.tsx`（替换 /student/training/exam 占位）

**Interfaces:**
- Produces（api.ts）:

```ts
export interface ExamPaper { id: number; title: string; year: number | null; district: string | null; examType: string | null; gradeBand: string | null; questionCount: number; }
export function getExamPapers(params: { subjectId: number; year?: number; district?: string; examType?: string; gradeBand?: string }): Promise<ExamPaper[]>;
export interface ExamSessionInfo { sessionId: number; status: 'in_progress' | 'submitted'; remainingSeconds: number; deadlineAt: string; questions: ExamQuestion[]; answered: Record<string, { answerText: string }>; }
export interface ExamQuestion { questionId: number; questionNo: number; text: string; type: string; options: Array<{label:string;text:string}> | string[] | null; }
export function createExamSession(paperId: number, durationMinutes: number): Promise<ExamSessionInfo>;
export function getExamSession(sessionId: number): Promise<ExamSessionInfo>;
export function submitExamAnswer(sessionId: number, questionId: number, answerText: string): Promise<{ saved: boolean }>;
export function submitExamSession(sessionId: number): Promise<{ correctCount: number; totalCount: number; accuracy: number }>;
export interface ExamResultItem { questionId: number; questionNo: number; text: string; type: string; options: ...; answerText: string | null; isCorrect: boolean; analysis: string | null; explanation: string | null; }
export function getExamResults(sessionId: number): Promise<{ correctCount: number; totalCount: number; accuracy: number; items: ExamResultItem[] }>;
```

- [ ] **Step 1: ExamListPage**：沉浸层容器（镜像 ErrorPracticePage）；顶栏 BackButton 回 /student/training + 标题「考试」；筛选（年份下拉=全部/2024/2025…从数据去重、地区、考试类型）；试卷卡片列表（title、题量、年份地区类型 Tag）；点击卡片 → 时长选择弹层（Modal：60/90/120 分钟三档 Chip + 推荐值标注「推荐」——**推荐值需要 paper detail**，简化：点卡片时调 getExamPaperDetail(id) 拿推荐时长再弹层）→ 「开始考试」→ createExamSession → sessionStorage('exam:session', JSON.stringify(sessionInfo)) → navigate /student/training/exam/run/:sessionId。空态提示「暂无试卷」。
- [ ] **Step 2: 路由**：/student/training/exam 替换占位 → ExamListPage；/student/training/exam/run/:sessionId 与 /student/training/exam/result/:sessionId 注册（Task 5 实现）。
- [ ] **Step 3: lint + build + Commit**

```bash
git commit -m "feat(web): 考试试卷列表页（筛选 + 时长选择）"
```

---

### Task 5: 前端考试进行页 + 结果页

**Files:**
- Create: `apps/web/src/pages/student/training/ExamRunPage.tsx`
- Create: `apps/web/src/pages/student/training/ExamResultPage.tsx`
- Modify: `apps/web/src/routes/index.tsx`

**Interfaces:**
- Consumes: QuestionRunner（showResultFeedback=false、headerExtra 倒计时）、Task 4 API。

- [ ] **Step 1: ExamRunPage**

核心逻辑：

```tsx
// 1. mount：优先 sessionStorage('exam:session')（新开的卷）；无则 getExamSession(sessionId)（刷新/续考恢复）。
//    两者都拿到 {questions, answered, remainingSeconds, status}；status='submitted' 直接 navigate 到 result 页。
// 2. 倒计时：本地 setInterval 每秒减 1（基准 remainingSeconds），headerExtra 渲染大号 mm:ss（剩余 <5min 变红 --error）。
//    归零：调 submitExamSession -> navigate result。不依赖本地时钟绝对值（remainingSeconds 为锚 + 本地单调递减）。
// 3. QuestionRunner：
//    questions = session.questions 映射 RunnerQuestion {n: String(questionNo), text, type, options: normalizeOptions(options)}
//    draftKeyPrefix = `exam-${sessionId}`；enableHint 不传（无提示按钮）；showResultFeedback={false}
//    onSubmit: (q, answer) => submitExamAnswer(sessionId, questionId(q.n), answer).then(() => ({isCorrect: true, method: 'exact', analysis: null} as JudgeResult))
//      —— 后端不回传对错，这里返回占位 JudgeResult（组件只记入 resultsRef 供 onFinish 的 records 结构完整；结果页不消费这些占位——真正结果从 getExamResults 拉）
//    已答恢复：answered map 的 answerText 不回填编辑器（QuestionRunner 无 initialAnswers——终审已知缺口），
//      但顶部渲染进度条「已答 N/M」（N=answered keys 数）让学生知道哪些题做过了；重复提交同题后端 upsert 幂等。
// 4. onFinish: 调 submitExamSession -> 清 sessionStorage('exam:session') -> navigate `/student/training/exam/result/${sessionId}`
// 5. 防误退：页面无 BackButton（考试中不可返回；浏览器后退由路由守卫简化——MVP 接受，记录）。
```

- [ ] **Step 2: ExamResultPage**：mount getExamSession 判 status（非 submitted 踢回 run 页）→ getExamResults → 顶部得分卡（正确数/总数/正确率百分比大字）→ AnswerResultList（items 映射 PracticeQuestion{n: String(questionNo), text} + answers 记录：{isCorrect, method, analysis, studentAnswer: answerText ?? '', failed: method==='failed'}——explanation 并入 analysis 展示：analysis ?? explanation）→ onClose 回 /student/training/exam。
- [ ] **Step 3: 路由注册两条（RequireRole student）。**
- [ ] **Step 4: lint + build + 手动走查（联调：Task 3 已回填数据；走一遍 选卷→限时做 2 题→手动交卷→结果页；倒计时归零自动交卷可用短时长卷验证）+ Commit**

```bash
git commit -m "feat(web): 考试进行页（倒计时/续考/自动交卷）+ 结果页"
```

---

### Task 6: API 双文档同步（exams）

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4 新增「Exams — /api/exams」小节：7 端点，阶段=MVP；§6 补考试数据流）
- Modify: `docs/api/openapi.yaml`

- [ ] **Step 1: 以 exams.controller.ts 为唯一真相同步两文档**（7 端点：papers 列表/详情/sessions 创建/恢复/answers 提交/submit/results；白名单响应、409 过期语义、自动收卷行为都写清）。
- [ ] **Step 2: grep 两文档端点清单核对一致 + yaml 语法校验。**
- [ ] **Step 3: Commit**：`docs(api): 考试模块 API 双文档同步`。

---

### Task 7: PRD / style.md 三轨修订 + 组件收敛

**Files:**
- Modify: `docs/K12智学系统-产品需求文档.md`（入口选择页双轨改三轨描述；§7.4 补错题本语义：训练错题写入 main_error_books、source 区分、辅线答对清零联动主线门禁）
- Modify: `apps/web/style.md` §2.6（入口选择页规范改三卡布局）
- Modify: `apps/web/src/components/business/AnswerModal.tsx`（答题核心替换为 QuestionRunner，variant='modal'，保留 hint 缓存/讨论抽屉在父层）
- Modify: `apps/web/src/components/business/CleanupPhase.tsx`（答题核心替换为 QuestionRunner，variant='embedded'，保留 4 态状态机与 bump/庆祝页在父层）

**强制细节**：
1. PRD/style.md 修订最小化：只改双轨→三轨相关段落与 §7.4 补充，不重写文档。
2. 组件收敛是**行为保持重构**：AnswerModal/CleanupPhase 对外 props 不变；内部答题区（题面渲染/LatexEditor/PreviewDraftPanel/提交/切题/fire-and-forget）替换为 QuestionRunner 挂载；hint 讨论 bump 庆祝等外围逻辑留在父组件。回归手段：npm run lint + build + 手动走查主线练习一轮（CourseDetailPage 答题 + 错题清零流程）。
3. **若收敛中发现 QuestionRunner 与两旧组件行为差异不可调和（如 modal 布局细节），允许降级**：保留旧组件不动，报告说明原因，收敛移出本计划（风险控制——主线是已上线核心路径，不为收敛冒回归险）。
4. 顺带清理终审遗留：悬空 BumpErrorLevelsDto 导出（删或接线）；空 hint 文案改「暂无提示」。

- [ ] **Steps: 修订 PRD/style.md → commit（docs(prd): 入口三轨 + §7.4 错题本语义修订）；组件收敛 → lint+build+走查 → commit（refactor(web): AnswerModal/CleanupPhase 收敛到 QuestionRunner）**

---

### Task 8: 全链路手动回归 + 收尾

- [ ] **Step 1: 三套测试全绿**（server npm test / refinery pytest / web build）。
- [ ] **Step 2: 手动走查清单**：
  - 主线：课程详情答题（AnswerModal 收敛后）→ 错题清零（CleanupPhase 收敛后）→ 门禁解锁
  - 错题练习：列表筛选（时间/题型/专项）→ 选题 → 做题（选择题显示选项）→ 答对清零联动主线 → 仍错 bump
  - 专项练习：配置（KP 级联）→ 抽题 → 做题带提示 → 结果
  - 考试：选卷 → 时长 → 做题（倒计时/无对错反馈/选择题点选）→ 手动交卷 → 结果页；刷新续考；倒计时归零自动交卷
  - 主题：日夜模式 × 训练各页
- [ ] **Step 3: 计划 2/3 遗留项清理确认**（Task 7 顺带项是否完成）。
- [ ] **Step 4: 最终 commit + 汇总报告。**

---

## 自检记录（Self-Review）

1. **Spec 覆盖**：spec §7.1 考试（Task 1-2 后端、4-5 前端、3 数据）、§8 文档（Task 6）、§3 PRD/style.md 修订（Task 7）、组件收敛（Task 7，spec §4 收尾承诺）、终审遗留（Task 7 顺带）全覆盖。
2. **占位符**：Task 3 是执行型任务（无代码）；Task 5 的 onSubmit 占位 JudgeResult 有明确理由（后端白名单不回传对错，组件契约需要 JudgeResult 形状）；其余完整。
3. **类型一致性**：ExamPaperDto/ExamQuestion/ExamSessionInfo 与 Task 4 api.ts 逐字段对齐；submitAnswer 白名单 {saved:true} 与前端消费一致；results items 含 explanation 的合并展示策略（analysis ?? explanation）在 Task 5 明确。
4. **终审备忘落实**：初始答案不回填的缺口以「进度条 + upsert 幂等」缓解（Task 5）；答题响应白名单（Task 2）；deadline 服务器权威（Task 2）。
