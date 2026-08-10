# 课堂练习对错持久化 - 设计稿

- 日期：2026-08-10
- 状态：已确认，待写实现计划
- 关联代码：`apps/web/src/pages/student/CourseDetailPage.tsx`、`apps/web/src/store/practiceStore.ts`、`apps/web/src/components/business/AnswerModal.tsx`、`apps/web/src/components/business/AnswerResultList.tsx`、`apps/server/src/modules/practice/*`、`tools/db/schema.sql`

## 1. 背景与问题

学生用 `AnswerModal` 答完一张练习卡的所有题后，`AnswerResultList` 显示对错。在结果表单打开期间，`CourseDetailPage` 该练习卡每道题后会显示 ✓/✗（读自 `practiceStore.answers`）。但点「完成」关闭结果表单时，`onRetry` 回调触发 `practiceStore.reset()`，把整个内存 store 清空，✓/✗ 随之消失。

根因：`practiceStore` 是纯内存 Zustand，无任何持久化；判题结果（含 `analysis` 题解）只在当次会话存在。

## 2. 需求（已与用户确认）

1. **DB 持久化，按学生、跨设备**：结果存 MySQL，按学生账号绑定，换设备登录仍可见。与已有错题本（DB）、跨课门禁一致。
2. **单题重做覆盖该题**：已答过的题显示 ✓/✗；点某题重开弹窗重答，该题结果被新结果覆盖，其他题不变。reset = 清整张卡从头来。
3. **复用判题已有的 `analysis` 作题解**：判题时 AI 已返回 `analysis`（错因 + 正确思路）与 `errorType`，直接持久化。零额外 AI 调用、零新题解端点。
4. **两级 reset**：每张练习卡一个 reset（清当前卡）+ 课程级全局 reset（清本课所有练习卡）。
5. **reset 与错题本解耦**：reset 只清练习对错记录，`main_error_books` 不动（reset 是「从头来」，未展示掌握，不该清错题）。
6. **重答正确清错题（接线 `markCleared`）**：重答正确 = 展示掌握 = 该题错题记录清零。`judge()` 答错改为 find-or-create（避免重复答错堆积多条错题），答对时清掉该题未清错题记录。影响跨课「错题清零门禁」计数（重答正确即解锁）。与需求 5 的 reset 解耦互补、不矛盾。

## 3. 方案选型

采用**方案 A：新建 `practice_results` 表，一行 = 一次「学生 × 卡 × 题」判题结果**。

排除的备选：
- **方案 B（扩展 `main_error_books` 存全部作答）**：被需求 5 否决。错题本是「错题 + 清零门禁」语义，塞进答对记录会混淆职责并干扰跨课门禁计数。
- **方案 C（学生进度记录上存 JSON blob）**：单题重做需 read-modify-write 整块（并发覆盖风险），且不可查询（放弃未来「易错题分析」）。一行一题的 upsert 更契合单题重做。

## 4. 数据模型

新建 `practice_results` 表（`tools/db/schema.sql` + 新 migration `tools/db/migrations/2026-08-10_add_practice_results.sql`）。遵循现有 schema 约定（`BIGINT`、`DATETIME(3)`、InnoDB/utf8mb4）。

```sql
CREATE TABLE IF NOT EXISTS practice_results (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  card_id BIGINT NOT NULL,
  lesson_id BIGINT NOT NULL,
  question_id BIGINT DEFAULT NULL,        -- 题库命中时填；未命中 null
  question_n VARCHAR(20) NOT NULL,         -- 卡内复合题号（如 "0-1"），upsert 去重键
  question_text TEXT NOT NULL,             -- 题面（question_id 为空时兜底身份 + 展示）
  student_answer TEXT NOT NULL,
  is_correct TINYINT(1) NOT NULL,
  method VARCHAR(10) NOT NULL,             -- 'exact' | 'ai'
  analysis TEXT DEFAULT NULL,              -- 题解（仅错题，复用判题 analysis）
  error_type VARCHAR(20) DEFAULT NULL,     -- logic|calculation|format|missing|null
  judged_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_pr_student_card_qn (student_id, card_id, question_n),
  KEY idx_pr_student_card (student_id, card_id),
  KEY idx_pr_student_lesson (student_id, lesson_id),
  CONSTRAINT fk_pr_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_card_id   FOREIGN KEY (card_id)   REFERENCES cards (id)    ON DELETE CASCADE,
  CONSTRAINT fk_pr_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

关键决策：

- **UNIQUE 键 `(student_id, card_id, question_n)`**：单题重做即 upsert 该行（需求 2）。用 `question_n`（前端已有，如 `0-1`，由 groups 结构或兜底正则生成）而非 `question_id`，因为 `question_id` 可空（题库未命中的兜底题）。`question_n` 在卡内唯一：结构化为 `gi-n`（组号-组内题号），兜底为 `0-n` 递增。
- **只持久化成功判题的结果**（对/错）。判题失败（503）不落库——那不是真实结果，学生重试即可；前端会话内仍保留临时 `failed` 标记给当次结果列表用，刷新后自然消失。故表无 `failed` 列。
- **与错题本解耦**：错题本仍由 `judge()` 对错题写入（source='practice'，驱动跨课门禁）；`practice_results` 独立存全量作答（含答对 + analysis），驱动 ✓/✗ 显示与题解。两者并存、职责分离（需求 5）。
- **`analysis` 仅错题有**（对题为 null），与判题返回一致。

`PracticeResultRow` 加到 `apps/server/src/database/repositories/types.ts`：

```ts
export interface PracticeResultRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number;
  card_id: number;
  lesson_id: number;
  question_id: number | null;
  question_n: string;
  question_text: string;
  student_answer: string;
  is_correct: number;
  method: 'exact' | 'ai';
  analysis: string | null;
  error_type: 'logic' | 'calculation' | 'format' | 'missing' | null;
  judged_at: Date;
  created_at: Date;
  updated_at: Date;
}
```

## 5. 后端

### 5.1 新 repo `PracticeResultsRepository`

`apps/server/src/database/repositories/practice-results.repo.ts`，镜像 `main-error-books.repo.ts` 风格（`@Injectable()` + `@Inject('DATABASE_POOL')` mysql2 Pool + 参数化 SQL）。方法：

- `upsert(row): Promise<void>` — `INSERT ... ON DUPLICATE KEY UPDATE`（按 `student_id+card_id+question_n`）。**best-effort**：失败仅记日志、不抛（同 `cardsRepo.upsertHint` 模式），持久化失败不阻断判题返回。
- `findByStudentCard(studentId, cardId): Promise<PracticeResultRow[]>` — 按 `(student_id, card_id)` 取该卡全部持久化结果。
- `deleteByStudentCard(studentId, cardId): Promise<void>` — 单卡 reset。
- `deleteByStudentLesson(studentId, lessonId): Promise<void>` — 本课所有卡 reset（全局 reset）。

repo 导出加入 `repositories/index.ts` barrel；`PracticeModule.providers` 注册 `PracticeResultsRepository`。

### 5.2 `PracticeService.judge()` 改动

- `JudgeInput` 加 `questionN: string`。
- 判题算出结果后（对/错都）调 `practiceResultsRepo.upsert({ student_id, subject_id, card_id, lesson_id, question_id, question_n, question_text, student_answer, is_correct, method, analysis, error_type })`，best-effort（try/catch 记日志，不抛）。
- **错题本逻辑改为对称**（接线此前未接线的 `markCleared`）：
  - **答错（`!isCorrect`）**：由直接 `create` 改为 **find-or-create**--复用 `findUnclearedByStudentQuestion(studentId, questionId, cardId, questionText)`，命中则复用既有记录（避免重复答错堆积多条），未命中才 `create`（source='practice'）。与 `startDiscuss` 的 find-or-create 一致。
  - **答对（`isCorrect`）**：调新方法 `mainErrorRepo.clearUnclearedByStudentQuestion(studentId, questionId, cardId, questionText)`，把该题所有未清错题记录 `markCleared`（兼容历史重复记录一次性清掉）。best-effort（失败仅日志，不阻断判题）。
- **`MainErrorBooksRepository` 新增** `clearUnclearedByStudentQuestion(studentId, questionId, cardId, questionText): Promise<void>` -- `UPDATE ... SET is_cleared=1, cleared_at=NOW(3) WHERE student_id=? AND is_cleared=0 AND (<同 findUnclearedByStudentQuestion 的 OR 匹配条件>)`，镜像 find 方法条件但批量清除。
- `JudgeOutput` 形状不变。

### 5.3 新 service 方法

- `getResults(studentId, cardId): Promise<PracticeResultDto[]>` - 返回干净 DTO（`isCorrect: boolean`，与 `JudgeOutput` 一致；service 把 `is_correct` TINYINT 映射为 boolean）。字段：`questionN, questionText, studentAnswer, isCorrect, method, analysis, errorType`。`PracticeResultDto` 定义在 `practice.service.ts`。
- `resetCard(studentId, cardId): Promise<void>` → `deleteByStudentCard`
- `resetLesson(studentId, lessonId): Promise<void>` → `deleteByStudentLesson`

### 5.4 新端点（`PracticeController`，复用 `JwtAuthGuard` + `@CurrentUser()`）

- `GET /api/practice/results?cardId=X` → `getResults(user.sub, cardId)`，返回 `PracticeResultDto[]`。
- `DELETE /api/practice/results?cardId=X` → `resetCard(user.sub, cardId)`，单卡 reset。
- `DELETE /api/practice/results?lessonId=X` → `resetLesson(user.sub, lessonId)`，全局 reset。

`@Query` + `ParseIntPipe` 校验 `cardId`/`lessonId`。

### 5.5 DTO

`JudgePracticeDto` 加 `questionN: string`（必填）。其余 DTO 不变。

## 6. 前端

### 6.1 `apps/web/src/services/api.ts`

- `judgePractice` payload 加 `questionN: string`。
- 新增 `PracticeResult` 类型（对齐 `PracticeResultDto`：`questionN / questionText / studentAnswer / isCorrect(boolean) / method / analysis / errorType`）。
- 新增：
  - `getPracticeResults(cardId: number): Promise<PracticeResult[]>`
  - `resetPracticeCard(cardId: number): Promise<void>` — `DELETE /api/practice/results?cardId=`
  - `resetPracticeLesson(lessonId: number): Promise<void>` — `DELETE /api/practice/results?lessonId=`

### 6.2 `apps/web/src/store/practiceStore.ts`

- 新增 `loadResults(cardId: number, questions: { n: string; text: string }[], results: PracticeResult[]): void` — 用持久化结果填充 `cardId`/`questions`/`answers`（`PracticeResult` 字段名与 `AnswerRecord` 一致，直接按 `questionN` 组装为 `AnswerRecord`）。替代 `setSession` 的「清空」语义用于首次进卡。
- `record()` 不变（判题时更新内存；服务端同步落库）。
- `reset()` 仍清内存；服务端清理由新 API 负责。

### 6.3 `CourseDetailPage.tsx`

- 新 effect：当前卡是 practice 卡且 `sessionCardId !== card.id` 时，`getPracticeResults(card.id)` → `loadResults(card.id, questions, results)`。进卡即见 ✓/✗（跨设备/刷新）。questions 复用 `practiceMeta`/`fallbackPractice` 已算好的数组。
- `handleOpenModal`：不再 `setSession` 清空（改为依赖 load effect 已填充 store）；仅 `setModalStart` + `setModalOpen(true)`。
  - **竞态兜底**：若用户在 `getPracticeResults` 返回前就开弹窗（`sessionCardId !== card.id` 仍成立），`handleOpenModal` 需保证 store 至少有 `cardId`+`questions`（不清空 `answers`，此时为空）再打开。AnswerModal 的 `questions` 来自 props（`practiceMeta`/`fallbackPractice`），不依赖 store，故弹窗本身不受影响；判题 `record` 仍正常写入。最差情况：旧 ✓/✗ 略晚出现，不影响答题。
- `onSubmit`：传 `n`（已有 `q.n`）给 `judgePractice({ ..., questionN: n })`，`record(n, ...)` 不变。
- reset 工具条：练习卡题块列表上方一条低调工具条，含两个按钮--
  - 「重置本卡」（单卡）：确认弹窗 -> `resetPracticeCard(card.id)` + `reset()` 清内存。
  - 「清空本课练习」（全局）：确认弹窗 -> `resetPracticeLesson(lessonId)` + `reset()`。
  - 仅当该卡已有持久化结果（`answers` 非空）时显示「重置本卡」；「清空本课练习」始终显示（练习卡阶段）。

### 6.4 `AnswerModal.tsx`

- `onSubmit` 签名改为 `(questionText: string, studentAnswer: string, n: string) => ...`（已有 `q.n`，直接传）。
- 打开已有结果的题 = 全新作答（不预填答案），交卷覆盖该题（需求 2）。

### 6.5 `AnswerResultList.tsx`（修 bug 核心）

- 「完成」按钮改为**只关闭**（`onClose` → `setResultOpen(false)`），**不再调 `reset()`**。结果已在 DB + 内存 store，✓/✗ 自然留在卡上。
- 移除 `onRetry` 的 reset 语义；props 由 `onRetry` 改为 `onClose`。

## 7. 边界与错误处理

- **判题失败（503）**：不落库；内存临时 `failed` 供当次结果列表；刷新后该题无标记，可重答。
- **题库未命中（question_id null）**：存 `question_text` + `question_n`，✓/✗ 照常显示。
- **卡内容重爬致 `question_n` 错位**：UNIQUE 键按位覆盖，MVP 可接受（不引入题面 hash 校验，YAGNI）。
- **并发**：单题 upsert 原子（`ON DUPLICATE KEY UPDATE`），无 read-modify-write。
- **reset 途中有在途判题**：其 upsert 会重建一行；可再 reset，不阻断。
- **全局 reset**：只删 `practice_results`，不碰 `main_error_books`（需求 5）。
- **重答正确清错题**：`judge()` 答对时清该题未清错题记录（需求 6）；该题无错题记录（首次就答对）则无副作用。跨课门禁计数随之减少。
- **错题 find-or-create**：`judge()` 答错改为 find-or-create，重复答错不再堆积多条错题记录；历史已堆积的重复记录由重答正确时的批量 `clearUnclearedByStudentQuestion` 清掉。
- **upsert 失败**：best-effort 记日志，判题结果仍正常返回；下次判题会重试 upsert。

## 8. 测试与验证

### 后端（`apps/server`，`npm test`）

- repo 测试 `practice-results.repo.test.ts`：upsert（新增 + 覆盖）、`findByStudentCard`、`deleteByStudentCard`、`deleteByStudentLesson`，镜像 `main-error-books.repo.test.ts`。
- repo 测试 `main-error-books.repo.test.ts` 扩展：`clearUnclearedByStudentQuestion` 清除该题全部未清记录（含重复记录）、不误清他人/他题。
- service 测试 `practice.service.test.ts` 扩展：judge 对/错都 upsert `practice_results`、judge 失败不 upsert、judge 答错 find-or-create 错题（命中复用不重复 create）、judge 答对 `clearUnclearedByStudentQuestion` 该题错题记录、`getResults`、`resetCard`、`resetLesson`（mock `practiceResultsRepo` 与 `mainErrorRepo`）。

### 前端（无测试框架）

- `npm run build`（tsc + vite）绿。
- 浏览器端到端实测：
  1. 答完一张卡 → 关闭结果表单 → ✓/✗ 仍显示在卡上（修 bug 验证）。
  2. 刷新页面 / 重新进卡 → ✓/✗ 仍在（持久化验证）。
  3. 点错题重做 → 该题 ✓/✗ 更新，其他题不变（单题覆盖）。
  4. 单卡 reset → 该卡 ✓/✗ 全清；其他卡不变。
  5. 全局 reset → 本课所有练习卡 ✓/✗ 全清。
  6. 错题本不受 reset 影响（解耦验证）。
  7. 答错 -> 重答正确 -> 该题错题本记录被清（is_cleared=1），跨课门禁计数减少（重答正确清错题验证）。

### 文档同步（项目铁律：代码/主文档变更同步所有引用文档）

- `tools/db/schema.sql` 加 `practice_results` 表 + 新 migration `tools/db/migrations/2026-08-10_add_practice_results.sql`（`apps/server/src/migrations/` 是否镜像一份，按其既有惯例在实现时确认）。
- DB 设计文档加 `practice_results` 表说明。
- `docs/api/openapi.yaml` 加 `GET/DELETE /api/practice/results` + schema；`docs/API接口与数据流设计文档.md` §4 加端点行、§6 加数据流、版本日志。
- `CLAUDE.md` 追加实现段（镜像现有「2026-08-09 新增…」格式），含 judge 答错 find-or-create、答对 markCleared 的错题本行为变更。
- API 设计文档 §6 judge 数据流：补「答错 find-or-create 错题本、答对清错题、对/错都落 `practice_results`」语义。

## 9. 不在本次范围（Out of Scope）

- 判题失败结果持久化（明确不落库）。
- 题面 hash 校验 `question_n` 错位（YAGNI）。
- 家长端查看练习结果（未来）。
- 「易错题」跨学生聚合分析（未来，标准化表已为其留好可查询性）。
- `ExplanationCapability` 独立题解端点（需求 3 明确复用判题 analysis，不新增）。
