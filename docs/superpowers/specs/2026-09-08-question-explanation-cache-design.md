# 判题解析缓存化设计（ExplanationCacheService）

- 日期：2026-09-08
- 状态：已与用户逐节确认
- 范围：判题响应瘦身 + 判错后 LLM 解析异步生成入库复用，覆盖专项 / 错题 / 考试 / 课堂练习四条判题链路

## 1. 背景与问题

当前判题（`JudgeCoreService`，被 practice / training / exams 三模块共用）：

- 主观题（fill_blank 不等 / short_answer / proof）由 LLM 判对错（judgment 场景，`deepseek-v4-flash` 快模型），**同一次调用顺带返回针对学生本次错误的 `analysis`**——不落库，同一道题被多个学生答错就重复生成。
- 客观题（choice / true_false）判错时 `analysis` 只有「正确答案：X」。
- 数据现状：496 题仅 40 题有 `questions.explanation`（其中 19 题长解析）——缓存化收益大。

与「尽量少调 LLM」的目标冲突：解析生成本应是**一次性入库、全生命周期复用**的缓存资源。

## 2. 设计决策（用户已确认）

1. **判题响应只判对错**：`JudgeOutput` 删除 `analysis` 字段；主观题判题 prompt 简化为只输出 `{isCorrect, errorType}`（省输出 token，长 analysis 是输出大头）。客观题判错的「正确答案：X」一并去掉——学生答错即时只看到错，正确答案与解法在解析里展开才有（贴合苏格拉底原则）。`errorType` 保留（判题 LLM 顺带产出，零成本，错题统计在用）。
2. **判错后台异步生成解析**：判题响应立即返回，解析生成在后台异步进行（不阻塞判题、不阻塞学生答题）。**末题后批量拉取时后端等待 in-flight 生成完成**（总超时 60s 兜底，避免 HTTP 挂死）——学生一次看全所有解析，无刷新交互；超时仍未完成的极少数题显示「解析生成中」。
3. **长答案直接当题解**：`answer` 长度 ≥100 字符（过程性题解，试卷参考答案常如此）时直接 `UPDATE questions.explanation = answer`，不调 LLM。
4. **载体选方案 A**：判题核心内嵌轻量缓存服务（进程内队列），不建任务表、不加 Redis。
5. **思考模式维持现状**：`KimiClient` 无条件下发 `enable_thinking: true`（`kimi-client.ts:25` 非流式 / `:94` 流式，Qwen/DeepSeek 共用）。判题 19s 实测可用，本设计不动它；若后续判题慢成为瓶颈，再单独立项做 per-scene thinking 开关（需验证 DeepSeek 是否支持关闭）。

## 3. 架构与数据流

```
判题（exact 比对 / 快模型 LLM，只判对错）
  ├─ 答对 → 清零该题未清错题（现有逻辑，不变）
  └─ 答错 → 入主线错题本（现有逻辑，不变）
            + ExplanationCacheService.ensureExplanation(q)   ← 新增，fire-and-forget
                ├─ q.explanation 非空 → 跳过（什么都不做）
                ├─ q.answer 长度 ≥100 → UPDATE questions.explanation = answer（不调 LLM）
                └─ 否则 → 进程内队列（并发 ≤2，同题 in-flight 去重）
                          → ExplanationCapability（solution 模式，qwen3.7-max 强模型）
                          → 生成 → UPDATE questions.explanation 入库
判题响应立即返回：{ questionId, isCorrect, method, errorType, errorBookId }（不等解析生成）
```

- 生成耗时 30-120s，判错时学生通常还在答后面的题——末题等判题 + 批量拉取时多数已就绪，剩余 in-flight 的由批量端点等待完成（§5.1）。
- 完整时序（用户确认）：学生每答一题异步发后端（fire-and-forget）→ 后端判对错（DB 有答案则比对、无则 LLM）→ 对错返回前端记录；答错同时后台生成解析入库。末题提交后前端同步等待所有在途判题完成 → 收集全部错题 questionId 批量拉解析 → 展示最终结果页。
- `answer` 为空的题也允许生成（prompt 参考答案为空则 LLM 自行解题；有解错风险，靠「讲一讲」苏格拉底讨论兜底）。

## 4. 组件设计

### 4.1 ExplanationCacheService（新）

- 位置：`apps/server/src/modules/practice/explanation-cache.service.ts`（Nest injectable，被 `JudgeCoreService` 注入）。
- 接口：
  - `ensureExplanation(q: QuestionRow): void`——同步返回，内部 fire-and-forget（判错分支调用）。
  - `waitForExplanations(ids: number[], timeoutMs = 60_000): Promise<Record<number, string | null>>`——批量端点调用：对每个 id，DB 已有 → 返回；in-flight → await 该生成 promise（整体受 timeoutMs 上界约束）；既无 DB 也无 in-flight（从未触发或曾失败）→ null。
- 队列：进程内，并发上限 2（常量），同题 in-flight 去重（Set，promise 复用——waitForExplanations 等的就是这些 promise）。
- 失败处理：LLM 失败 / 超时 / 解析失败 → 记日志、出队、**不入库**——幂等（explanation 空才会再生成），下次判错自然重试。`updateExplanation` 落库失败同记日志。
- 已知局限（记入文档）：进程内队列，服务重启丢在途任务（下次判错重试）；多实例部署会重复生成（当前单实例）。将来多实例升级为 DB 任务表 + worker 时，判题 / 生成 / prompt 层不用动，只换触发载体。

### 4.2 solution 模式 prompt（新文件）

- 路径：`apps/server/src/ai-core/prompts/explanation/solution.md`。
- 输入：题面 `question.content`、参考答案 `question.answer`（可空）。
- 输出：**标准题解** markdown——面向学生分步讲解、行内公式 `$...$` LaTeX、几何题可输出内嵌 `<svg>` 线性图（前端 markdown 管线已含 `rehype-raw`，`apps/web/src/components/markdown.tsx:66`，可直接渲染）。
- 与现有 `error-analysis`（带学生错答的个性化错因）/ `knowledge-retry`（知识点重讲）的区别：不含任何学生信息，纯题解，跨学生复用——这是能入库缓存的前提。
- 配套变更：`ExplanationRequest.mode` 联合类型加 `'solution'`；`PromptBuilder.resolveTemplatePath`（`prompt-builder.ts:77`）加 solution 分支；`retry.yaml` 的 explanation 超时 60s → **120s**（强模型长思考 + SVG 产出）。

### 4.3 JudgeCoreService 变更

- 判错分支（`judgeQuestion` 与 `judgeForPractice` 两处，入错题本处）追加 `this.explanationCache.ensureExplanation(q)`。
- `judgeForPractice` 的课堂练习未入库路径：结构化 `findOrCreate` 成功后同样触发（用返回的题库行）；结构化失败的孤儿题（questionId=null）无库行，不触发。
- `JudgeOutput` / `JudgeInput` 相关类型删 `analysis`；judgment prompt 输出简化为 `{isCorrect, errorType}`。
- `questions` / `exam_answers` 相关 DTO、service、controller 同步删 `analysis`（exam_answers 列保留存历史数据，新写入为 null）。

### 4.4 QuestionsRepository

新增 `updateExplanation(id: number, explanation: string): Promise<void>`。schema 无变更（`questions.explanation` 已是 TEXT，`tools/db/schema.sql:220`）。

### 4.5 触发点覆盖

判题响应瘦身 + ensureExplanation 触发均收敛在 judge-core，四条链路自动全覆盖：

| 链路 | 判题入口 | 解析触发 |
|---|---|---|
| 专项 | `POST /training/judge`（source=targeted） | judgeQuestion 判错分支 |
| 错题重做 | `POST /training/judge`（source=error_practice） | 同上 |
| 考试 | `POST /exams/sessions/:id/answers`（submitAnswer → judgeQuestion） | 同上 |
| 课堂练习 | `POST /practice/judge`（judgeForPractice） | 两处判错分支（含结构化入库后） |

## 5. 前端与接口

### 5.1 新增批量查解析端点

`GET /api/training/questions/explanations?ids=1,2,3` → `{ explanations: { [questionId]: string | null } }`。

端点挂在 training 模块（题目元数据服务在该模块），但服务所有展示解析的结果页——专项 / 错题重做 / 考试结果页以及课堂练习的错题巩固（AnswerResultList 共享组件）都经它按 questionId 批量拉取。

行为：对每个 id 调 `ExplanationCacheService.waitForExplanations`——已有直返，in-flight 的等待生成完成（总超时 60s 兜底，超时该题返回 null），前端一次拿全，无刷新交互。

### 5.2 前端变更

- `JudgeResult` / `RunnerJudgeOutcome` / `PracticeResult` / `RunnerAnswerRecord` 等类型删 `analysis`（apps/web `services/api.ts`、`components/business/answer/types.ts`）。
- **前端结果页编排**（专项 / 错题重做，AnswerResultList）：末题提交 → `Promise.allSettled` 等所有在途判题完成（QuestionRunner 现有行为）→ 父层收集全部错题（`isCorrect=false` 且非 failed）的 questionId → 一次性调 5.1 批量端点（后端等待 in-flight 生成）→ 拿全后渲染结果页：每题对错 + 错题解析。超时兜底返回 null 的题显示「解析生成中」；无 questionId 的孤儿题显示「暂无解析，试试让 AI 讲一讲」。不做手动刷新、不做自动轮询。
- **考试结果页**（ExamResultPage）：解析展示改为 `explanation ?? analysis`（DB 题解优先，存量考试的历史 analysis 兜底）。考试判题发生在每题提交时（同步），解析在判错时即触发生成，交卷 → finalize 补判 → 进结果页时多数已就绪；mount 时对「错题且 explanation/analysis 皆空」的题调 5.1 批量端点等待 in-flight 补齐（`getExamResults` 契约不动，等待在前端编排）。
- 错题巩固（CleanupPhase）走 AnswerResultList，同上述编排逻辑。

## 6. 错误处理汇总

| 场景 | 行为 |
|---|---|
| LLM 生成失败 / 超时 / 解析失败 | 记日志、出队、不入库；下次判错重试 |
| `waitForExplanations` 总超时（60s） | 该题返回 null，前端显示「解析生成中」 |
| `updateExplanation` 落库失败 | 记日志，不影响任何响应 |
| 判题本身失败（503） | 现有行为不变（前端记 failed，不进错题收集） |
| 长答案直写 | 纯 DB UPDATE，不可失败（按 MySQL 异常兜底记日志） |

## 7. 测试

- vitest（apps/server）：ExplanationCacheService 单测（mock `ExplanationCapability` + `QuestionsRepository`）——已有解析跳过 / 长答案直写 / 短答案生成入库 / 失败不入库 / 同题并发去重 / `waitForExplanations` 等待 in-flight 与总超时返回 null。
- judge-core 现有测试更新：判错触发 ensureExplanation（mock 断言）；判题响应无 analysis；judgment prompt 只判对错。
- apps/web 无测试框架，按 CLAUDE.md 手动验证 + `npm run lint`。

## 8. 文档同步

- `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml`（互为对照，两份同步）：`/training/judge`、`/practice/judge`、exam answers 响应去 analysis；新增 explanations 批量端点。
- `docs/ai-core-changelog.md` 记录本次变更（含已知局限）。

## 9. 明确不做（YAGNI）

- 不做自动轮询「解析生成中」状态。
- 不做 per-scene thinking 开关（判题思考现状维持，见 §2.5）。
- 不建任务表 / 不引 Redis / 不做多实例协调。
- 不回填历史错题的解析（只在今后判错时按需生成）。
