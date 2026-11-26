# 主观题自评确定性设计：提交即落「错」，点对覆盖结算（2026-11-26）

> 本版取代同文件早先的「提交写假留痕 + 点对撤销」草案。核心变化：**不写任何"默认错"的假自评留痕**，
> 留痕表只在学生真实表态时追加；幂等与精确撤销靠「作答历史行」做锚点。

## 1. 需求与目标

**用户需求（2026-11-26）**：自评题**一定要有对/错**，绝不能停在"待评（NULL）"；学生**不做任何自评时默认按做错处理**。

由此推导的硬约束：
- 主观题一经提交，其判定结果必须是确定的 `0`（错）或 `1`（对），不允许 NULL 落库/落表。
- 下游（作答历史、抽题"做过"判定、错题本、掌握度）不再需要为"待评"单独兜底。
- 学生明确点「我做对了」→ 改判为对；点「我做错了」→ 维持错；不点 → 维持错。

**不变的部分**：考试主观题（`source='exam'`）仍是交卷后中性待评（考试成绩只算客观题）；单题重做（redo）仍"不记录不计分"。

## 2. 适用范围

| 场景 | source | 是否适用 | 说明 |
|---|---|---|---|
| 专项练习 | `targeted`（非 redo） | ✅ | 提交即落错、点对覆盖 |
| 错题练习 | `error_practice` | ✅ | 同上；**本版新增写入作答历史**（原不写，见 §4.2） |
| 考试结果页自评 | `exam` | ❌ | 保持中性待评，交卷后才自评 |
| 单题重做 | `targeted`（redo） | ❌ | redo 本意"不记录不计分"，不适用 |

**分流开关 = 是否携带 `sessionUid`**：带 `sessionUid` 的 `targeted/error_practice` 走新语义；不带 `sessionUid`（exam、redo、老客户端）走旧语义。这一条同时覆盖了"exam/redo 不适用"，无需额外的 source×mode 矩阵。前端在 redo 模式与考试结果页本就不传 `sessionUid`。

## 3. 核心设计：一次落错，覆盖结算

### 3.1 提交答案（`judgeQuestion` 路由 1c，带 sessionUid）

```
学生提交主观题答案
  → judgeQuestion()：路由 1c（主观题 self_assess）且 source∈{targeted,error_practice}
  → ① 写错题本：writeErrorBookOrReuse({studentId, subjectId, questionId, source})
  → ② 掌握度：finishJudge 出口按 isCorrect=false 记 error+1（现有统一出口）
  → ③ 作答历史：judgeTraining 旁路写 special_answer_records.is_correct=0（带 sessionUid 时）
  → ④ 不写自评留痕（关键：默认错不是"学生自评"，不进留痕表）
  → 返回 JudgeOutput：{ isCorrect:false, method:'self_assess', needsSelfAssessment:true,
                        errorBookId, referenceAnswer, explanation, pointsAwarded:0 }
  → 前端照常展开自评视图（强制对照答案表态）
```

要点：
- `isCorrect` 由 `null` 改为 `false`；`needsSelfAssessment=true` 不变（前端仍强制表态，学生才看得到为什么错）。
- 掌握度沿用 `finishJudge`（`isCorrect=false` 即写 error+1），与客观题答错同公式，零额外代码。
- **不写留痕**：留痕表 `question_self_assessments` 的定位是"学生真实自评序列"（见 repo 头注释），
  "提交即默认错"是系统兜底，不该伪造一条 `incorrect`。

### 3.2 点「我做对了」（`selfAssess('correct')`，带 sessionUid）

以「作答历史行」为锚点做原子覆盖结算：

```
① UPDATE special_answer_records sar JOIN special_practice_sessions sps
     SET sar.is_correct = 1, sar.judged_at = NOW(3)
   WHERE sps.session_uid=? AND sps.student_id=? AND sar.question_id=? AND sar.is_correct = 0
   → 返回 affectedRows
② affectedRows = 0：已结算过（重复点对/重试）→ 幂等，直接返回成功，什么都不再做
③ affectedRows = 1（首次从默认错翻对）：
   a. 掌握度：revertErrorToCorrect({studentId, questionId}) —— 对该题每个 KP：
      error_count = GREATEST(error_count-1, 0)、correct_count = correct_count+1，同公式重算 score/level
   b. 错题本清零：clearUnclearedByStudentQuestionId（现有逻辑）
   c. 自评留痕：selfAssessRepo.create({assessment:'correct', source}) —— 追加一条（纯 append）
   d. **不发 error_fix 订正积分**：这次错是兜底虚构的，抹掉后应从未存在，不发分
   e. 作答历史 is_correct 已在 ① 置 1（不再重复写）
```

**为什么用条件 UPDATE 而不是先读后写**：`WHERE is_correct = 0` + 受影响行数判定，把"是否首次结算"
做成数据库原子判断，天然幂等、并发安全，不引入事务/锁；且精确只撤销**本次提交**的默认错，
不会误伤历史真错（历史错落在别的 session 行）。

### 3.3 点「我做错了」（`selfAssess('incorrect')`，带 sessionUid）

提交时已是错态（is_correct=0、已入错题本、掌握度已 error+1），点错只是**确认**：
- 只追加一条 `question_self_assessments(incorrect)` 留痕（纯 append，记录学生真实表态）。
- **不**再调 `writeErrorBookOrReuse`、**不**再记掌握度、**不**再改 is_correct（镜像提交态即正确）。
- 重复点错的重复留痕：前端点完即放行下一题、按钮 `disabled`，实际只可能点一次；服务端不做去重
  （重复留痕只影响"自评次数"统计，不影响对错/错题本/掌握度，可接受）。

### 3.4 什么都不点

停在 3.1 的提交态 = 错：`is_correct=0`、已在错题本、掌握度已 error+1、无留痕。
这就是"自评题一定有对错"的保证——字段自始至终没有 NULL。

### 3.5 旧语义（不带 sessionUid：exam / redo / 老客户端）

`recordSelfAssessment` 保持现状：`correct` 清错题本（并走现有发分判决）、`incorrect` 写错题本；
掌握度按 `correct|incorrect` 记一次；留痕追加一条。考试 `source='exam'` 与 redo 的 existing 行为完全不变。

## 4. 数据与契约

### 4.1 数据写入时机总表

| 事件 | 作答历史 `is_correct` | 错题本 | 掌握度 | 自评留痕 |
|---|---|---|---|---|
| 提交（带 uid） | 0 | 入本 | error+1 | 不写 |
| 点对（带 uid，首次） | 0→1 | 清零 | error−1、correct+1 | +correct |
| 点对（带 uid，重试） | 1（不变） | 已清 | 不动（affected=0） | 不写 |
| 点错（带 uid） | 0（不变） | 已入 | 已 error（不动） | +incorrect |
| 不点 | 0 | 已入 | 已 error | 无 |
| 不带 uid（exam/redo） | 旧逻辑 | 旧逻辑 | 旧逻辑 | 旧逻辑 |

### 4.2 `error_practice` 补写作答历史

现状：`ErrorPracticeRunPage` 的 judge/selfAssess 均不传 `sessionUid`，作答不落 `special_answer_records`，
因此没有"本次提交"的锚点。本版纳入后：
- 前端 `ErrorPracticeRunPage` 生成 `sessionUid`（`newSessionUid()`），judge 传
  `sessionUid + title='错题练习' + questionCount + questionOrder + plannedQuestionIds`，self-assess 传 `sessionUid`。
- 后端无需特判：`judgeTraining`/`selfAssess` 已按 `sessionUid` 存在与否分流。
- **副作用**：错题练习会出现在学生端"练习记录"里（`special_practice_sessions` 新增一行，
  `module = targetedSessionModule(subjectId)`）。这是可接受的（错题练习本就是一次练习），
  需在验收时确认展示文案为「错题练习」而非「专项练习」。

### 4.3 后端契约（相比上一版大幅简化）

- `JudgeOutput` **不需要** `selfAssessId`。
- `SelfAssessTrainingDto` **不需要** `selfAssessId`；继续用既有 `sessionUid`（2026-11-26 B 引入）。
- `special-answer-records.repo.markSelfAssessCorrectness` 改造为**条件更新并返回受影响行数**：
  ```ts
  /** 默认错 -> 对的一次性覆盖：只在 is_correct=0 时置 1，返回 affectedRows 做幂等判定。 */
  async markCorrectFromDefault(input: { sessionUid, studentId, questionId }): Promise<number>
  ```
  原 B 版本（无条件 upsert 为 1）废弃，避免重复结算。

### 4.4 新增仓储/服务能力

- `mastery.service.revertErrorToCorrect({studentId, questionId})`：按题查 KP，逐 KP 调
  `masteryRepo.revertOneError`；fire-and-forget、失败只 warn（复用 `recordFromJudge` 的 KP 查询与容错）。
- `student-knowledge-mastery.repo.revertOneError(studentId, kpId)`：
  ```sql
  UPDATE student_knowledge_mastery
  SET correct_count = correct_count + 1,
      error_count   = GREATEST(error_count - 1, 0),
      mastery_score = (correct_count + 1) / NULLIF(correct_count + 1 + GREATEST(error_count - 1, 0), 0),
      level         = FLOOR(5 * ((correct_count + 1) / NULLIF(correct_count + 1 + GREATEST(error_count - 1, 0), 0))),
      last_seen_at  = NOW(3)
  WHERE student_id = ? AND knowledge_point_id = ?
  ```
  公式与 `upsertOnJudge` 必须一致（引用更新后的列值，防自引用错值——见该文件头注释）。
- **不再需要** `question-self-assessments.repo.updateAssessment`（不写假留痕，自然不需要改留痕）。

## 5. 后端改动清单

| 文件 | 改动 |
|---|---|
| `judge-core.service.ts` | 路由 1c（带 sessionUid 的 targeted/error_practice）：`isCorrect=false`、`writeErrorBookOrReuse`、不写留痕、`needsSelfAssessment=true`；`recordSelfAssessment` 按"是否带 sessionUid"分流：带 uid 的 correct→条件覆盖结算，带 uid 的 incorrect→只追加留痕；不带 uid→旧逻辑 |
| `special-answer-records.repo.ts` | `markSelfAssessCorrectness` 改为条件更新 `markCorrectFromDefault` 返回 affectedRows |
| `mastery.service.ts` | 新增 `revertErrorToCorrect` |
| `student-knowledge-mastery.repo.ts` | 新增 `revertOneError` |
| `training.service.ts` | `selfAssess`/`judgeTraining` 沿用 `sessionUid`；`selfAssess` 依据 affectedRows 决定是否 revert/清本/发分 |
| `question-self-assessments.repo.ts` | **不改**（仍只有 create / findLatest） |

## 6. 前端改动清单

| 文件 | 改动 |
|---|---|
| `ErrorPracticeRunPage.tsx` | 生成 `sessionUid`；judge 与 self-assess 均透传 `sessionUid`（+ title/questionCount/questionOrder/plannedQuestionIds）；无 redo 概念，全部走新语义 |
| `TargetedRunPage.tsx` | 已是带 uid（非 redo）传 sessionUid；**无需改**（本方案不引入 selfAssessId） |
| `ExamResultPage.tsx` | **不改**（不传 uid，走旧语义） |
| `QuestionRunner.tsx` / `types.ts` / `api.ts` | **无需改**（不新增字段） |

## 7. 边界、幂等与竞态

- **重复点对**：条件 UPDATE `WHERE is_correct=0`，第二次 affected=0 → 跳过掌握度/清本/留痕/发分，完全幂等。
- **点对与点错交替**：点对后 is_correct=1；再点错（带 uid）只追加 incorrect 留痕，不改 is_correct/掌握度/错题本
  （避免"对→错"再次翻转的复杂度；实际 UI 不会允许已自评题再点）。记录为已知简化。
- **异步写入顺序**：提交时掌握度 error+1 由 `finishJudge` `void` 异步写；点对 revert 亦异步。
  理论乱序由 `revertOneError` 的 `GREATEST(error-1,0)` 兜底（不为负）；且"读答案→点按钮"有自然时延，
  实际乱序概率极低。本期不上队列/锁，作为已知可接受风险。
- **撤销失败**：掌握度 revert / 清本失败只 warn，不阻断自评；但 is_correct=1 已在 ① 落库，
  最坏情况是"作答历史对、掌握度没回扣"——偏差可观测、可人工修，不会卡学生。
- **作答行缺失的降级**：锚点是作答历史行。正常路径下 judge 带 uid 必先写该行（is_correct=0），
  点对 affected 必为 1。极端情况（judge 时旁路写答案行失败，被 try/catch 吞掉）会导致点对 affected=0，
  此时按幂等分支处理——不回扣掌握度、不清本、不写留痕（点对不完整）。属"异常叠加异常"的低概率场景，
  可观测，接受；不为此引入跨表事务。
- **redo**：不带 uid，走旧语义，不受影响。
- **exam**：`source='exam'`、不带 uid，走旧语义（交卷后结果页自评，中性待评）。
- **error_practice 无 sessionUid 的老客户端**：不带 uid → 旧语义；新客户端走新语义。

## 8. 测试计划（回归钉子）

后端（vitest）：
1. `judgeQuestion` 路由 1c + `source='targeted'` + 带 sessionUid：`isCorrect=false`、调 `writeErrorBookOrReuse`、
   **不调** `selfAssessRepo.create`、`needsSelfAssessment=true`。
2. `source='exam'`：`isCorrect=null`、不写错题本、不写留痕（不变）。
3. `selfAssess('correct', 带 uid)`：先条件 UPDATE 作答历史；affected=1 → `revertErrorToCorrect` 一次 +
   清错题本 + `selfAssessRepo.create('correct')` + **不发订正分**。
4. `selfAssess('correct', 带 uid)` 且 affected=0（重复）：`revertErrorToCorrect`/create/发分均**不调用**，返回成功。
5. `selfAssess('incorrect', 带 uid)`：只 `selfAssessRepo.create('incorrect')`；不写错题本、不记掌握度、不改 is_correct。
6. 无 sessionUid（exam/redo/老客户端）：correct/incorrect 行为与变更前逐字一致。
7. `revertOneError` SQL：correct+1、error=GREATEST(error−1,0)、字段引用更新后值、同公式。
8. revert 失败只 warn，自评仍返回成功。
9. `markCorrectFromDefault` 返回 affectedRows（0/1）。

前端：
10. `ErrorPracticeRunPage`：judge 与 self-assess 均带 sessionUid（title='错题练习'）。
11. `TargetedRunPage` 现有 uid 透传不回归。

手动验收：
12. 专项练习做一道证明题 → 不点自评直接离开：作答历史显示"错"、题在错题本。
13. 重进该题点「我做对了」→ 作答历史变"对"、错题本清除、掌握度未冤枉扣分（error 回退、correct+1）。
14. 点「我做错了」→ 掌握度 error 只 +1（不重复）、留痕一条 incorrect。
15. 错题练习做一道主观题 → 练习记录里出现「错题练习」、其自评同样"不点即错"。

## 9. 文档同步

- `docs/API接口与数据流设计文档.md` §5.19：补"提交即落错 + 点对覆盖结算 + 不写假留痕"时序。
- `docs/api/openapi.yaml`：`/training/self-assess` 与 `/training/judge` 说明 `sessionUid` 的新语义与
  "带 uid 时提交即记错"；本方案不新增请求字段。
- `docs/ai-core-changelog.md`：新增 2026-11-26 条目（取代早先 A+B 的"自评回写 NULL"描述，二选一保留最终态）。
- 若架构文档有自评时序图，同步。

## 10. 非目标

- 不改考试主观题自评（保持中性待评）。
- 不改 redo（保持不记录）。
- 不改客观题 / AI 判题 / 空答案守卫。
- 不把掌握度重构成明细表（revert 用 GREATEST 兜底即可）。
- 不回填历史存量 NULL（只改新提交行为；存量由 A（抽题判定纳入自评表）与 B 已保证不再误判）。
- 不处理"已自评后再改判"的复杂翻转（UI 不允许，见 §7）。
