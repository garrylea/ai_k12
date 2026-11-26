# 主观题自评逻辑变更：提交即算错，点「我做对了」再纠正（2026-11-26）

## 1. 背景与动机

现状（判题体系重构 2026-09-09 起）：主观题（解答/证明，及自评学科的填空/简答）提交后，
`judgeQuestion` 路由 1c 只返回 `needsSelfAssessment=true` + 参考答案，**什么都不写库**——
错对完全由学生随后点的「我做对了 / 我做错了」决定（`recordSelfAssessment`）。

由此引出两个问题：

1. **不点就走人 = 没有任何记录**：学生提交答案后若直接关页/跳过，`is_correct` 停在 NULL、
   不入错题本、掌握度不记——相当于这次作答"消失"了。
2. 2026-11-26 的 A+B 修复暴露出这种"NULL 待评"状态在多个下游（作答历史、抽题判定）
   都要专门兜底，口径复杂。

**用户裁决（2026-11-26）**：把默认语义反过来——**提交即算错，只有学生明确点「我做对了」
才改成对**。具体口径经逐项确认：

| 决策点 | 裁决 |
|---|---|
| 「默认错」从哪一步开始 | **提交即算错**：一提交就按错记（is_correct=0、进错题本） |
| 提交时记的错点对后是否抹掉 | **抹掉重算**：点「我做对了」后把那次错的留痕与掌握度计数一起撤销，只留下一次对 |
| 错的副作用 | **先记错、点对再纠正**：提交时自评留痕 incorrect + 掌握度 error+1；点对后原地改为 correct + 掌握度(error-1, correct+1) |
| 适用范围 | **仅训练轨练习**：`source='targeted' \| 'error_practice'`；考试结果页自评 `source='exam'` 保持原样 |
| 在哪落地 | **后端判题时真写库**（不是前端显示层） |

## 2. 适用范围（严格边界）

**适用**：`JudgeCoreService.judgeQuestion` 路由 1c（主观题 self_assess 分支）且
`input.source ∈ {'targeted','error_practice'}`。调用来源：训练专项作答页（TargetedRunPage）、
错题练习页（ErrorPracticeRunPage），以及任何经 `judgeQuestion` 且 source 为这两值的入口。

**不适用（行为完全不变）**：
- **考试**：`exams.service` 主观题走 `source='exam'`，且单题提交在 `exams.service:220-225`
  直接写 `is_correct=NULL / method='self_assess'` 的 `exam_answers` 行，交卷后才在结果页自评。
  本变更**不碰**这条链路，`recordSelfAssessment` 的 `source='exam'` 分支保持中性待评。
- 课堂练习（`judgeForPractice` 路由 1c）：卡中心变体，仍由 `POST /practice/self-assess` 补写
  `practice_results`，本变更不涉及。
- 客观题（choice/multi_choice/true_false）、AI 判题模式、空答案守卫（路由 0）：不变。

## 3. 数据流（唯一真源）

### 3.1 提交答案：`judgeQuestion` 路由 1c

```
学生提交主观题答案
  → JudgeCoreService.judgeQuestion()
  → 判定为路由 1c（主观题 + self_assess 模式）且 source∈{targeted,error_practice}
  → ① 写错题本：writeErrorBookOrReuse({studentId, subjectId, questionId, source})
       拿到 errorBookId
  → ② 写自评留痕：selfAssessRepo.create({assessment:'incorrect', source})
       拿到 selfAssessId（本次"默认错"的撤销凭据）
  → ③ 掌握度：finishJudge 出口按 isCorrect=false 记一次 error+1（现有统一出口，无需额外代码）
  → ④ 作答历史：training.service.judgeTraining 旁路写 special_answer_records.is_correct=0
  → 返回 JudgeOutput：
       { isCorrect:false, method:'self_assess', needsSelfAssessment:true,
         errorBookId, selfAssessId, referenceAnswer, explanation, pointsAwarded:0 }
  → 前端照常展开自评视图（对照自己答案 vs 参考答案）
```

要点：
- `needsSelfAssessment=true` **保持不变**——前端必须继续强制学生对照答案做一次明确表态，
  否则学生看不到"为什么错"。默认错是**数据层兜底**，不是取消自评 UI。
- `isCorrect` 从 `null` 改为 `false`。`trackAnswer` 埋点的 verdict 会从 `undetermined` 变为
  `incorrect`——这是期望的（本次提交确实记了一次错）。
- 掌握度走 `finishJudge` 统一出口：它读 `out.isCorrect`，`false` 即写 error+1，与客观题答错同公式。
  路由 1c 不再因 `isCorrect=null` 被 MasteryService 的"规则②跳过"。

### 3.2 点「我做对了」：`selfAssess('correct')`

```
selfAssess({assessment:'correct', selfAssessId?, sessionUid?, ...})
  → ① 留痕纠正：若带 selfAssessId → selfAssessRepo.updateAssessment(id, 'correct')（原地改，
       不新增行）；无 id（老客户端）→ 兼容补写一条 correct
  → ② 掌握度纠正：若带 selfAssessId → masteryService.revertErrorToCorrect({studentId, questionId})
       （对该题每个 KP：error_count-1 且 correct_count+1，重算 score/level）
       无 id → 只记一次 correct（兼容路径，不撤销历史那次错）
  → ③ 错题本清零：mainErrorRepo.clearUnclearedByStudentQuestionId（现有逻辑）
       ★ 带 selfAssessId（默认错被抹掉）时**不发 error_fix 订正积分**——那次错是兜底虚构的，
         "抹掉重算"语义下应当从未存在过，发分等于凭空奖励；按 `suppressErrorFixPoints=true` 处理。
       仅无 selfAssessId 的兼容路径（确有历史未清错题）走现有 awardErrorFixOnClear 发分判决。
  → ④ 作答历史 is_correct=1：specialAnswersRepo.markSelfAssessCorrectness（2026-11-26 B 已有）
  → 返回 { errorBookId: undefined }
```

`revertErrorToCorrect` 语义（新增能力）：
- 按题反查该题绑定的 KP（`questionsRepo.findKnowledgePointIdsByQuestion`），逐个 KP 做
  `error_count = GREATEST(error_count-1, 0)`、`correct_count = correct_count+1`，用与
  `upsertOnJudge` **同一套公式**重算 `mastery_score` / `level`（不能写两份公式）。
- 用 `GREATEST(...,0)` 防止计数被扣成负数（历史脏数据或重复撤销时兜底）。
- fire-and-forget（与现有掌握度回写同口径），失败只 warn，不阻断自评。
- 只撤销**一次** error：因为提交时对本题只记了一次 error。

### 3.3 点「我做错了」：`selfAssess('incorrect')`

**幂等 no-op**：提交时已按错写好全部数据（留痕 incorrect、掌握度 error+1、错题本、is_correct=0）。
学生再点「我做错了」只是确认，服务端**不再重复写**任何一项，直接返回成功放行。

- `recordSelfAssessment` 的 incorrect 分支对"训练轨且带 selfAssessId"的请求走 no-op：
  不调 `selfAssessRepo.create`、不调 `writeErrorBookOrReuse`、不重记掌握度。
- `explanationCache.ensureExplanation` 仍可触发（解析兜底，无害）。
- 不带 selfAssessId 的老客户端：维持原逻辑（补一条 incorrect 留痕 + 入本 + 掌握度 error+1），
  避免老版本卡住。

## 4. 契约变更

### 4.1 `JudgeOutput`（后端 → 前端）
新增可选字段：
```ts
/** 提交即算错时写下的自评留痕 id；点对时回传以撤销那次错（2026-11-26）。
 *  仅训练轨主观题 needSelfAssessment=true 时返回；考试/兼容路径缺省。 */
selfAssessId?: number;
```

### 4.2 `RunnerJudgeOutcome`（前端 answer/types.ts）
同步新增 `selfAssessId?: number | null`。

### 4.3 `onSelfAssess` 回调签名（QuestionRunner.tsx）
```ts
onSelfAssess?: (
  q: RunnerQuestion,
  assessment: 'correct' | 'incorrect',
  ctx: RunnerSelfAssessContext & { selfAssessId?: number | null },
) => Promise<void>;
```
`RunnerSelfAssessContext` 增加 `selfAssessId?: number | null`。

### 4.4 `SelfAssessTrainingDto`（POST /api/training/self-assess）
```ts
/** 提交时留痕 id（2026-11-26）：训练轨点对时据此撤销那次默认错、点错时据此幂等 no-op。
 *  考试结果页自评不传。非正整数按不传处理。 */
selfAssessId?: number;
```

### 4.5 `recordSelfAssessment` 入参
新增 `selfAssessId?: number | null`，由 `selfAssess` service 透传。

## 5. 前端改动

### 5.1 `QuestionRunner`
- `selfAssess` state 增 `selfAssessId: number | null`。
- `handleSubmit` 的 `res.needsSelfAssessment` 分支：`setSelfAssess({..., selfAssessId: res.selfAssessId ?? null})`。
- `handleSelfAssess`：`onSelfAssess(question, assessment, {questionId, studentAnswer, selfAssessId})`。

### 5.2 三个调用页
- **TargetedRunPage**（`source='targeted'`）：`onSelfAssess` 透传 `ctx.selfAssessId` 给
  `selfAssessTraining`；继续透传 `sessionUid`（B）。重做 `mode='redo'` 仍不传 uid（不记录）。
- **ErrorPracticeRunPage**（`source='error_practice'`）：透传 `ctx.selfAssessId`；本页不传 sessionUid。
- **ExamResultPage**（`source='exam'`）：**不传** selfAssessId（考试走中性待评，保持原样）。

### 5.3 `api.ts` `selfAssessTraining` payload 增 `selfAssessId?: number`。

## 6. 后端新增/修改清单

| 文件 | 改动 |
|---|---|
| `judge-core.service.ts` | JudgeOutput 加 `selfAssessId`；路由 1c（judgeQuestion，source 白名单内）改为写错题本 + 留痕 incorrect + isCorrect=false + 回传 id；recordSelfAssessment 支持 selfAssessId（correct 撤销重算 / incorrect 幂等 no-op） |
| `question-self-assessments.repo.ts` | 新增 `updateAssessment(id, assessment): Promise<void>`（原地改 assessment） |
| `mastery.service.ts` | 新增 `revertErrorToCorrect({studentId, questionId})`，复用 recordFromJudge 的 KP 查询与失败容错 |
| `student-knowledge-mastery.repo.ts` | 新增 `revertOneError(studentId, kpId)`：`correct_count+1, error_count=GREATEST(error_count-1,0)`，同公式重算 score/level |
| `self-assess.dto.ts` | 加 `selfAssessId?: number` |
| `training.controller.ts` | selfAssess 端点校验并透传 selfAssessId（非正整数按不传） |
| `training.service.ts` | selfAssess 入参加 selfAssessId 并透传 judgeCore |
| `api.ts` / `QuestionRunner.tsx` / `types.ts` / 两个训练页 | 前端契约透传（见 §5） |

## 7. 边界、错误与兼容

- **并发/重复点对**：自评端点可能被重试两次。留痕 `updateAssessment` 幂等（同一 id 改成同一值）；
  掌握度撤销**不幂等**——需靠 selfAssessId 防重：撤销前先读该留痕当前 assessment，
  已是 correct 则跳过撤销（避免 error 被扣两次）。本条为必测项。
- **老客户端不传 selfAssessId**：提交时因老客户端走的是旧 judge 逻辑（isCorrect=null、不写库），
  点对走"补记一条 correct"、点错走"补记一条 incorrect"的兼容路径，行为与变更前一致，不卡住。
- **撤销失败**：掌握度/留痕撤销失败只 warn，不阻断自评主链路（与现有旁路写入同口径）。
- **错题本清零发分**：带 selfAssessId（默认错抹掉）不发订正积分；无 selfAssessId 的兼容路径
  走现有 `awardErrorFixOnClear`。`suppressErrorFixPoints`（重做）与 `source='exam'` 排除条件不变。
- **异步写入顺序（竞态）**：提交时掌握度 error+1 由 `finishJudge` 以 `void` 异步写；点对撤销
  `revertErrorToCorrect` 也是异步 fire-and-forget。两者对同一 KP 的写入理论上可能乱序，导致
  error 扣减发生在 error 累加之前。缓解：`revertOneError` 用 `GREATEST(error_count-1,0)` 兜底，
  避免负数；且用户读完参考答案再点「做对了」存在自然时延，实际乱序概率极低。本期不引入队列/锁
  （避免上架构复杂度），作为已知可接受风险记录；若后续出现掌握度异常再评估。
- **隐藏题 / 停用题**：提交即入本沿用 `writeErrorBookOrReuse`，与客观题答错同口径。

## 8. 测试计划（回归钉子）

后端（vitest）：
1. `judgeQuestion` 路由 1c + `source='targeted'`：`isCorrect=false`、错题本写入、留痕 incorrect、
   返回 selfAssessId；`source='exam'` 仍 `isCorrect=null`、不写库。
2. `recordSelfAssessment('correct', selfAssessId=X)`：留痕 X 改 correct、掌握度 revertErrorToCorrect
   调用一次、错题本清零、**不发 error_fix 积分**、作答历史 is_correct=1；
   无 id 兼容路径仍按现有规则发分。
3. `recordSelfAssessment('incorrect', selfAssessId=X)`：幂等 no-op——留痕 repo.create 未调用、
   掌握度未重记。
4. 重复点对（留痕已是 correct）：掌握度撤销不重复执行（防 error 扣两次）。
5. 无 selfAssessId 兼容路径：correct 补一条留痕、incorrect 补一条留痕，行为同旧版。
6. `revertOneError` SQL：correct+1 / error=GREATEST(error-1,0) / 同公式重算 score/level。
7. 撤销失败只 warn，不影响自评返回。

前端：
8. `QuestionRunner`：needsSelfAssessment 返回带 selfAssessId → 存进 state → handleSelfAssess 透传。
9. `TargetedRunPage` / `ErrorPracticeRunPage` 透传 selfAssessId；ExamResultPage 不传。

端到端验收（用户手动）：
10. 专项练习做一道证明题 → 不点自评直接看：该题已进错题本、作答历史显示"错"。
11. 重进该题做同一道 → 点「我做对了」→ 错题本清除、作答历史显示"对"、掌握度未被冤枉扣分。
12. 点「我做错了」→ 不重复记错（掌握度 error 只 +1）。

## 9. 文档同步

- `docs/API接口与数据流设计文档.md` §5.19 主观题自评：补"提交即算错"时序。
- `docs/api/openapi.yaml`：`JudgeOutput` schema 加 selfAssessId；
  `TrainingSelfAssessRequest` 加 selfAssessId；`/training/judge` 响应说明。
- `docs/ai-core-changelog.md`：新增 2026-11-26 条目。
- 架构文档（若有自评时序描述）同步。

## 10. 非目标

- 不改考试主观题自评链路（保持中性待评）。
- 不改课堂练习（practice）自评。
- 不改客观题/AI 判题/空答案守卫。
- 不重构掌握度为明细表（撤销用 GREATEST 兜底即可，不做架构级改造）。
- 不回填历史存量（本次只改新提交的行为）。
