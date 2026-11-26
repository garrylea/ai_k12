# 主观题自评确定性设计：默认错 + 事务化真实自评结算（2026-11-26）

> 本版取代同文件早先的「提交写假留痕 + 点对撤销」草案，也取代「仅靠 is_correct=0 条件 UPDATE
> 做幂等」的修订稿。核心原则：**默认错不是学生自评；最终对错必须确定；真实自评只追加一次；
> 作答结果、错题本、掌握度、自评留痕必须在同一数据库事务内结算。**

## 1. 需求、范围与硬约束

**用户需求（2026-11-26）**：自评题一定要有确定的对/错，不能停在待评 `NULL`；学生不做任何
自评时，按做错处理。

本设计把该需求限定在**训练轨题库类即时自评**：

| 场景 | source | 是否适用 | 说明 |
|---|---|---|---|
| 专项练习 | `targeted`（非 redo） | 是 | 带 `sessionUid` 时，提交即默认错；真实自评后事务化结算 |
| 错题练习 | `error_practice` | 是 | 同上；本版同时补写作答历史和会话完成时间 |
| 考试结果页自评 | `exam` | 否 | 保持交卷后中性待评，考试成绩只算客观题 |
| 单题重做 | `targeted`（redo） | 否 | 保持“不记录、不计分” |
| 主线课堂练习 | `practice` | 否 | 仍走既有卡中心自评；如未来也要求默认错，另立设计 |

**分流开关**：请求携带有效 `sessionUid` 的 `targeted/error_practice` 走本设计；不带 `sessionUid`
（考试、redo、老客户端）走旧语义。后端仍需同时校验 `source`，不能只凭客户端传入的 uid 决定。

硬约束：

1. 新路径提交后，`special_answer_records.is_correct` 必须是 `0` 或 `1`，不允许 `NULL`。
2. `is_correct=0` 只表达最终对错，不能单独表达“默认错”还是“学生已确认错”；两者必须由内部状态区分。
3. 默认错不写 `question_self_assessments`；只有学生真实点对/点错时才追加一条。
4. 默认错提交、确认对/错、错题本联动、掌握度回写、作答历史回写必须全成或全败，不允许只落一部分。
   （例外：掌握度回退时"某 KP 无记录而更新 0 行"属**无操作**、不算"只落一部分"；判据见 §5。）
5. 重复请求必须幂等；同一题收到互相矛盾的自评结论时，不得静默覆盖，返回冲突错误。
6. 失败必须可重试。不得出现数据库已标记结算成功、但错题本或掌握度尚未完成的状态。

## 2. 状态模型

### 2.1 作答记录新增内部状态

`special_answer_records` 新增：

```sql
self_assess_state VARCHAR(24) DEFAULT NULL
  COMMENT 'default_incorrect|confirmed_correct|confirmed_incorrect；NULL=非本设计路径或旧数据'
```

该列只表达自评结算状态，不替代 `is_correct`：

| `self_assess_state` | `is_correct` | 含义 |
|---|---:|---|
| `default_incorrect` | `0` | 学生提交后未表态；系统最终按错处理 |
| `confirmed_correct` | `1` | 学生对真实表态“我做对了”，已完成覆盖结算 |
| `confirmed_incorrect` | `0` | 学生对真实表态“我做错了”，已是终态 |
| `NULL` | 旧值 | 非本设计路径、考试/redo、老客户端或迁移前数据 |

`self_assess_state` 不对外新增响应字段。客户端仍只读 `isCorrect`、`method`、`needsSelfAssessment`
等既有字段。

### 2.2 状态迁移

| 当前状态 | 请求 | 结果 |
|---|---|---|
| 不存在 | 首次提交 | 建 `default_incorrect` + `is_correct=0` |
| `default_incorrect` | 重复提交同答案 | 幂等返回原结果，不重复记错题本/掌握度 |
| `default_incorrect` | `correct` | `confirmed_correct` + `is_correct=1`，执行覆盖结算 |
| `default_incorrect` | `incorrect` | `confirmed_incorrect`，只追加真实自评留痕 |
| `confirmed_correct` | `correct` | 幂等成功，不重复执行 |
| `confirmed_correct` | `incorrect` | 冲突，返回 409，不改变任何状态 |
| `confirmed_incorrect` | `incorrect` | 幂等成功，不重复追加留痕 |
| `confirmed_incorrect` | `correct` | 冲突，返回 409，不改变任何状态 |
| `NULL` | 带 uid 的自评 | 走迁移兼容路径；补充真实自评留痕与状态，不做默认错回退 |

同一 `sessionUid + questionId` 代表本题的一次作答。若需重新作答，应生成新的 `sessionUid`，不能在
同一作答行上覆盖已确认结论。

## 3. 架构与事务边界

新增应用服务 `SelfAssessmentSettlementService`，只负责本设计的作答结算：

- 输入：`studentId`、`subjectId`、`questionId`、`source`、`sessionUid`、题目元数据、答案或自评结论。
- 输出：最终 `isCorrect`、可选 `errorBookId`、是否幂等命中。
- 依赖：`DATABASE_POOL` 与现有会话、作答、错题本、知识点、掌握度、自评留痕仓储。

事务实现要求：

1. 服务显式 `pool.getConnection()`，在单连接上 `beginTransaction()`。
2. 现有仓储写方法增加可选 `executor?: PoolConnection` 参数；事务内所有 SQL 必须使用同一连接。
3. 结束时只在 `try` 成功分支 `commit()`；任何异常先 `rollback()`，再保留原始错误抛出。
4. `finally` 中释放连接。
5. 事件埋点和解析生成在事务提交后执行；它们失败不得回滚主结算，也不得反向阻断接口成功。
6. `sessionUid` 是客户端提供的全局唯一键。命中已有 uid 时必须校验 `studentId + subjectId + module`
   与当前请求一致；跨学生或跨场景碰撞返回 409，绝不能把答案写进别人的会话。

不采用以下方案：

- **仅用条件 UPDATE 的“CAS 幂等”**：只能证明某一列被改过一次，无法证明跨表副作用已经完成。
- **fire-and-forget 掌握度 + 事后补偿**：初始错与回退之间存在乱序，且失败后没有可靠恢复点。
- **默认错也写一条自评留痕再改状态**：违反“留痕只记录真实学生表态”的数据语义。

## 4. 核心数据流

### 4.1 首次提交主观题

触发条件：

- `judgeQuestion()` 命中主观题 self-assess 路由；
- `source ∈ {targeted, error_practice}`；
- 请求携带 `sessionUid`。

流程：

```text
开始事务
  → 按 sessionUid + studentId 幂等 upsert special_practice_sessions
  → 锁查 special_answer_records(session_id, question_id)
      ├─ 不存在：写入 answer_text + is_correct=0 + method='self_assess'
      │           + self_assess_state='default_incorrect'
      ├─ default_incorrect 且答案相同：幂等返回既有结果
      ├─ default_incorrect 但答案不同：409
      └─ confirmed_*：409，不重开已确认作答
  → 仅“首次插入”分支继续：
      → find-or-create main_error_books（source 使用本次训练来源）
      → 对该题每个 KP 执行 upsertOnJudge(studentId, kpId, false)
  → 提交事务
  → 提交后可选写入其余未作答占位行（best-effort，不属于核心结算事务）
  → 返回 isCorrect=false、needsSelfAssessment=true、errorBookId、参考答案与解析
```

约束：

- `JudgeCore` 只负责判题路由与返回参考答案；本路径不得在 `JudgeCore.finishJudge` 中另行异步写掌握度。
- 错题本、掌握度、作答历史由 `SelfAssessmentSettlementService` 在同一事务中统一写入。
- 事务提交前不返回判题成功响应。因此学生看到自评按钮时，默认错对应的错题本和掌握度已经落定。
- 重复提交必须复用同一题的作答行和未清零错题条目，不得重复 `error+1`。
- “答案相同”按 `answer_text` 原值精确比较；占位行和未作答行不能当作已提交。
- 其余题单占位行是作答历史的展示增强，提交后单独 best-effort 写入；失败不得回滚已成形的本题作答。
- 已有 uid 若属于其他学生、其他学科或错误 module，整笔事务回滚并返回冲突错误。

### 4.2 点「我做对了」

```text
开始事务
  → SELECT special_answer_records ... JOIN special_practice_sessions ... FOR UPDATE
  → 校验 studentId 归属
  → 按 self_assess_state 分流：
      ├─ confirmed_correct：幂等成功，直接提交并返回
      ├─ confirmed_incorrect：409，不改变任何数据
      ├─ NULL：走旧语义补偿，不执行默认错回退
      └─ default_incorrect：
          ① 追加 question_self_assessments(correct)
          ② UPDATE main_error_books：清零该生该题全部未清记录
          ③ 对该题每个 KP：error_count−1、correct_count+1，并同公式重算 score/level
          ④ UPDATE 作答行：
               is_correct=1,
               self_assess_state='confirmed_correct',
               judged_at=NOW(3)
          ⑤ 提交事务
  → 提交成功后发 error_book_cleared 事件（仅 clearedCount>0）
  → 不发 error_fix 积分
```

若任何一步失败：整笔回滚，由前端保留自评页并提示重试；不能把作答行先改成 1 再静默失败。

### 4.3 点「我做错了」

```text
开始事务
  → 锁查作答行并校验归属
  → 按 self_assess_state 分流：
      ├─ confirmed_incorrect：幂等成功，不追加重复留痕
      ├─ confirmed_correct：409，不改变任何数据
      ├─ NULL：走旧语义补偿
      └─ default_incorrect：
          ① 追加 question_self_assessments(incorrect)
          ② self_assess_state='confirmed_incorrect'
          ③ 不改 is_correct、错题本、掌握度（提交事务时已落定）
  → 提交事务
  → 事务成功后 fire-and-forget 触发解析缓存兜底生成
```

### 4.4 什么都不点

作答行保持：

- `is_correct=0`
- `self_assess_state='default_incorrect'`
- 已在错题本
- 掌握度已 `error+1`
- 无真实自评留痕

这已经是一次确定的错，不需要后台补结算，也不会出现 `NULL`。

### 4.5 不带 `sessionUid` 的旧语义

考试、redo、老客户端继续调用既有 `recordSelfAssessment`：

- `correct`：追加留痕、清零错题、按旧规则回写掌握度与发分判决；
- `incorrect`：追加留痕、写入/复用错题、按旧规则回写掌握度；
- 考试仍保持 `is_correct=NULL + method='self_assess'`，不进入本状态机。

迁移前已存在、但没有 `self_assess_state` 的专项作答行，首次收到带 uid 的自评时按旧语义处理，
成功后补写 `confirmed_correct|confirmed_incorrect`；不做批量历史回填。

## 5. 掌握度回退公式

新增 `masteryRepo.revertOneError(studentId, kpId, executor)`。由于 MySQL 的 `SET` 子句从左到右
求值，计数列更新后，score/level 必须直接引用“更新后的列值”，不能再把本次增量写一次：

```sql
UPDATE student_knowledge_mastery
SET correct_count = correct_count + 1,
    error_count   = GREATEST(error_count - 1, 0),
    mastery_score = correct_count
                  / NULLIF(correct_count + error_count, 0),
    level         = FLOOR(5 * (
                      correct_count
                      / NULLIF(correct_count + error_count, 0)
                    )),
    last_seen_at  = NOW(3)
WHERE student_id = ? AND knowledge_point_id = ?
```

**0 行不是失败（关键，勿改成"回滚"）**：`revertOneError` 按该题**当前**绑定的 KP 逐个执行并返回
affectedRows。某个 KP 更新 0 行，表示该生在该 KP 上没有掌握度记录——原因可能是：该题本就没绑该
KP（提交时也没写过）、KP 在「提交→点对」之间被删除/改动、或历史数据缺失。此时**跳过并 warn，
不回滚、不阻断自评**。

理由：
- 掌握度是派生数据，其缺失不该阻断学生对一道题做出终局判断；这与 `MasteryService` 既有的
  "回写失败只 warn、不阻断主链路"口径一致。
- 若把 0 行当致命错误回滚，一旦题目 KP 在练习期间变动，这道题会**永远点不对**（每次回滚），
  是不可接受的死锁。

只有 SQL **执行抛异常**（连接中断、语法错误、锁超时）才 `rollback()` 整笔事务。区分标准是
"抛没抛异常"，不是"影响了几行"。

题目 KP 在「提交→点对」之间被增删造成的少量漏退/多退，作为已知可接受偏差记录（极罕见）；本设计
**不额外存储提交时的 KP 快照**。若该偏差在生产真实出现，再评估给 `special_answer_records` 增加
提交时 KP 快照列。

## 6. 数据与接口契约

### 6.1 数据库

新增幂等迁移：

```text
tools/db/migrations/2026-11-26_special_answer_self_assess_state.sql
```

要求：

- 只在列不存在时新增 `self_assess_state VARCHAR(24) NULL`；
- 同步更新 `tools/db/schema.sql` 的 `special_answer_records` 定义与注释；
- 不新增触发器；
- 不批量回填旧行；
- 收尾运行 `python3 tools/db/schema_reconcile.py`。

### 6.2 判题接口

`POST /api/training/judge` 不新增请求字段，继续使用既有 `sessionUid`。

带 uid 的主观题 self-assess 响应：

```json
{
  "questionId": 5034,
  "isCorrect": false,
  "method": "self_assess",
  "needsSelfAssessment": true,
  "referenceAnswer": "...",
  "explanation": "...",
  "errorBookId": 123,
  "pointsAwarded": 0
}
```

不带 uid 的主观题仍返回 `isCorrect=null`。客观题、AI 判题、无参考答案守卫不变。

### 6.3 自评接口

`POST /api/training/self-assess` 继续使用 `{questionId, subjectId, assessment, source, sessionUid?}`。

- 带 uid 且状态允许：返回既有成功结构；
- 重复提交同一结论：幂等成功；
- 结论冲突：HTTP 409，业务码 `1001`，文案「该题自评结果已确认」；
- 作答行不存在或不属于本人：HTTP 409，业务码 `1002`，文案「作答记录不存在或已失效，请重新提交」；
- 事务失败：HTTP 500，前端保留自评页允许重试。

### 6.4 专项会话完成

新增：

```text
POST /api/training/special-sessions/{sessionUid}/complete
```

- student JWT；
- 按 `sessionUid + studentId` 把 `special_practice_sessions.completed_at` 幂等置为当前时间；
- 不存在或非本人返回 404/1002；
- 正常完成专项练习或错题练习时由前端调用；
- 未完成的提前退出会话仍保持 `completed_at=NULL`，继续显示「进行中」。

### 6.5 内部仓储契约

- `SpecialPracticeSessionsRepository.upsertSession(..., executor?)`
- `SpecialPracticeSessionsRepository.markCompletedByUid(sessionUid, studentId, executor?)`
- `SpecialAnswerRecordsRepository.findForUpdate(...)`
- `SpecialAnswerRecordsRepository.insertOrReadDefaultIncorrect(...)`
- `SpecialAnswerRecordsRepository.transitionSelfAssessState(...)`
- `MainErrorBooksRepository.findOrCreateUncleared(..., executor?)`
- `MainErrorBooksRepository.clearUnclearedByStudentQuestionId(..., executor?)`
- `StudentKnowledgeMasteryRepository.upsertOnJudge(..., executor?)`
- `StudentKnowledgeMasteryRepository.revertOneError(..., executor?)`
- `QuestionSelfAssessmentsRepository.create(..., executor?)`

具体方法命名可在实施时按现有代码风格微调，但必须保持“同一事务同一连接”和“状态迁移显式化”
两个约束。

## 7. 前端改动

| 文件 | 改动 |
|---|---|
| `ErrorPracticeRunPage.tsx` | 生成 `sessionUid`；judge/self-assess 均透传；判题时带 title、questionCount、questionOrder、plannedQuestionIds；正常完成后调用会话完成端点 |
| `TargetedRunPage.tsx` | 非 redo 继续传 `sessionUid`；正常完成后调用会话完成端点；redo 不传 uid |
| `ExamResultPage.tsx` | 不改，继续走旧语义 |
| `QuestionRunner.tsx` | `isCorrect=false + needsSelfAssessment=true` 仍进入自评视图；同步自评题在请求成功前不得清空本地答案/草稿，接口失败时保留当前题和作答、显示可重试错误，不得静默前进；**「上一题」回退到已作答的自评题时，提交前拦截**（见下） |
| `api.ts` | 只新增专项会话完成端点封装；自评/判题请求字段不新增 |

**P1：回退改答案的处置（必做）**。「上一题」会把学生带回已作答的题并回填答案（`answerByNRef`）。
主观题此时已进入 `confirmed_*` 终态，若原样重新提交，judge 会返回 409；而当前 `handleSubmit`
的 catch 是「记 failed 后 `advance()`」——会**静默跳到下一题、零提示**。修正为两道防线：

1. **提交前拦截（首选）**：`handleSubmit` 入口判断——若 `resultsRef.current[question.n]` 已存在
   **且该题是自评题**（`selfAssessEligible`），则不发起请求，停留在当前题并提示
   「本题已作答，如需重做请重新进入练习」。**仅对自评题生效**，客观题回退改答案的既有行为不变。
2. **409 兜底**：若未拦截而 judge 返回 409，`catch` 必须区分 409 与网络/5xx——409 时停留在当前题、
   显示上述提示，**不得 `advance`**；其余错误维持现有重试/前进逻辑。

`api.ts` 的 `fetchApi` 需让调用方拿到 HTTP 状态（至少 409 可判别），供上述兜底判断。

“不点默认错”不等于取消强制自评 UI。学生仍在当前题看到参考答案和「我做对了 / 我做错了」；
只有直接关闭页面、断网离开或未完成自评时，提交态才作为最终错保留下来。

## 8. 错误处理与可观测性

- 核心结算失败：事务回滚，接口返回 5xx，前端可重试；不存在“提交成功但只结算一半”的中间态。
- 重复点对/点错：按状态幂等成功，不重复写留痕、错题本或掌握度。
- 点对与点错冲突：409，不覆盖先到的真实结论。
- **judge 阶段 409（已确认主观题被重复提交）**：前端停留当前题并提示「本题已作答，如需重做请重新
  进入练习」，**禁止静默 advance**（见 §7 P1）。客观题不进入状态机、永不返回此 409，行为不变。
- **掌握度回退 0 行**：不视为失败、不回滚，只 warn（见 §5）；只有 SQL 抛异常才回滚。
- 自评留痕、错题本、掌握度处于同一事务，任一步**抛异常**都整体回滚。
- 事务提交后的埋点和解析生成仍按项目口径 best-effort，失败只 warn。
- 默认错提交不追加 `question_self_assessments`。
- 默认错提交不额外触发 `consecutive_failures`；学生明确点「我做错了」后才视为真实自评错。
- 自评正确时仍可发 `error_book_cleared`，但不发 `error_fix` 积分。

## 9. 测试计划

### 9.1 后端事务与状态机

1. 首次提交：同一事务写入会话、作答行 `0/default_incorrect`、错题本、掌握度 `error+1`；不写自评留痕。
2. 强制让错题本或掌握度写入抛错：事务回滚，作答行、会话、错题本、掌握度均不新增。
3. 重复提交相同答案：幂等返回，不重复 `error+1`、不新增错题本。
4. 同一作答行提交不同答案：409。
5. `default_incorrect + correct`：一次写入 correct 留痕、清错题本、回退掌握度、更新 `1/confirmed_correct`，不发订正分。
6. 重复 `correct`：不重复留痕、清本、掌握度或事件。
7. `default_incorrect + incorrect`：只写 incorrect 留痕并更新 `confirmed_incorrect`，不重复写错题本/掌握度。
8. 重复 `incorrect`：不重复留痕。
9. `confirmed_correct + incorrect` 与 `confirmed_incorrect + correct`：均 409，数据不变。
10. 作答行缺失、uid 不存在、uid 属于别的学生、uid 同学科/module 冲突：按 409/404 处理，不能静默成功或串写。
11. `revertOneError`：**以「提交后（已含本次默认错 error+1）」的计数 5 对 3 错为起点**，回退后应为
    6 对 2 错 = `6/8`（level 3），不是重复增量后的错误值。若从「提交前」5 对 3 起测完整链路，则应为
    5对3 → 提交(5对4) → 点对(6对3)=`6/9`。测试须写清基准时点，勿混用。
11a. **该题无 KP 时点对**：`revertOneError` 一次都不命中（无 KP），自评仍成功、事务提交、不回滚、不报错。
11b. **题目 KP 在提交后被删/改**：点对时对现存的 KP 更新，缺失的 0 行只 warn，自评成功、不回滚
     （防止"该题永远点不对"的死锁）。
12. 迁移前 `self_assess_state=NULL` 的专项作答行：按旧语义完成一次真实自评后补状态。

### 9.2 路由与回归

13. 带 uid 的 targeted/error_practice 主观题：`isCorrect=false`、`needsSelfAssessment=true`。
14. 不带 uid：`isCorrect=null`，行为与变更前一致。
15. exam：仍为 `isCorrect=null`，不写训练作答历史、不默认错。
16. redo：不记录、不计分、不进入状态机。
17. 客观题、AI 判题、无参考答案守卫无回归。

### 9.3 前端

18. `QuestionRunner` 收到 `isCorrect=false + needsSelfAssessment=true` 仍展开自评视图，未表态不放行。
19. `ErrorPracticeRunPage` judge/self-assess 使用同一 `sessionUid`，标题为「错题练习」。
20. 专项/错题练习正常完成后调用会话完成端点；提前退出不调用。
21. 练习记录中错题练习标题正确，完成后不再显示「进行中」。
22. 自评题提交接口 5xx：留在当前题、保留答案并显示重试；用户重试同一答案后走幂等成功。
22a. **回退到已作答自评题再提交**：前端提交前拦截（`resultsRef[question.n]` 已存在 + 自评题）→
     禁用提交并提示，不发请求、不 advance。
22b. **judge 409 兜底**：模拟未拦截直接返回 409 → 当前题停留、显示提示、不 advance；
     客观题回退改答案重新提交 → 正常判题并 advance（既有行为不回归）。

### 9.4 手动验收

23. 专项练习做一道主观题，不点自评直接离开：作答历史为错、题在错题本、掌握度计一次错。
24. 重新进入同一题点「我做对了」：历史变对、错题本清除、掌握度从该次默认错准确回退。
25. 点「我做错了」：不重复计错，留痕恰好一条 incorrect。
26. 快速重复点击、网络重试、并发点对/点错：不产生重复数据或矛盾终态。
27. 错题练习做一道主观题：新增「错题练习」记录，完成后状态为已完成。
28. 做一道主观题并自评后，点「上一题」回到该题：提交被拦截并提示「本题已作答…」，不会静默跳题；
    客观题回退改答案重新提交仍能正常判题（不回归）。
29. 做一道未绑定知识点的自评题并点「我做对了」：正常成功、无报错（验证 P2 的 0 行不阻断）。

## 10. 文档同步

实施时必须同步：

- `docs/K12智学系统-产品需求文档.md`：明确训练轨即时自评“不表态默认错”；
- `docs/constraints/ai-core.md`：更新 `self_assess` 默认错与真实自评状态机口径；
- `docs/API接口与数据流设计文档.md` §4.18、§5.19：更新 judge/self-assess 语义、409 冲突和会话完成端点；
- `docs/api/openapi.yaml`：同步端点、响应分支、409 错误和 `sessionUid` 行为；
- `docs/K12智学系统-数据库设计文档.md` 与 `tools/db/schema.sql`：补 `special_answer_records.self_assess_state`；
- `docs/ai-core-changelog.md`：新增 2026-11-26 最终态条目，取代 A+B 的 NULL 回写描述；
- 如架构文档或 UX 文档仍写“待评后回填 NULL”，同步修订。

## 11. 非目标

- 不把考试主观题改成默认错。
- 不把主线课堂练习纳入本状态机。
- 不修改 redo 的“不记录、不计分”语义。
- 不修改客观题、AI 判题与无参考答案守卫。
- 不把掌握度重构成逐题明细表。
- 不为迁移前数据批量制造默认错或回填 `self_assess_state`。
- 不支持同一作答行内把已确认的对/错再次翻转；需要重做时创建新会话。
