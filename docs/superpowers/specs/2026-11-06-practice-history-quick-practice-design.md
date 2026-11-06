# 练习记录：单题重做与同类型练习 — 设计 spec

**日期**：2026-11-06
**主题**：练习记录详情页对单题发起「重做」与「同类型练习」；数理化专项保存题单，让未作答的题可见
**状态**：设计已与用户确认，待写实施计划
**关联**：PRD §6.4（2026-11-06 新增）、§7.13（2 题档）；API 文档 §4.29

---

## 1. 背景与目标

### 1.1 用户需求

1. **单题重做**：做套卷或专项时因不熟练只做完一部分，后面的大题没时间做；在练习记录里查看这次记录时，希望点某道题就能重做。
2. **同类型练习**：在练习记录里点某道题，按这道题的知识点生成 1/2/3/5 道同类型题；题库优先，不足时 AI 生成。先做数学、物理，化学等数据补齐后再开。

用户进一步明确：

- **重做只做当前这一道题**，不是整套卷重做，也不需要「全部重做」入口（要整套重做可以去真题考试选卷）。
- **重做不生成练习记录、不发任何积分**；**同类型练习相当于一次专项训练，要落记录、要发分**。

### 1.2 一期目标

1. 练习记录详情页每题右上角提供「重做」「同类型练习」；不支持的题隐藏按钮。
2. 重做：单题、不限时、无记录、无积分；判题仍更新错题本（错入本 / 对清零），但不发订正分。
3. 同类型：按 KP + 同题型 + 难度±1 出 1/2/3/5 题；题库优先、AI 补缺；落一条专项记录，按实际题数发档位分。
4. 数理化专项从本期起保存整轮题单，未作答的题在练习记录里可见、可重做。
5. 顺手修复专项答题页把 `questionId` 当题号传给后端的既有 bug。

### 1.3 边界（本期不做）

- 整套卷重做 / 全部重做入口。
- 语文/英语专项的重做（作答单位是篇目/句子/单词，没有题目 id）。
- 化学的「同类型练习」（题库 75 道题全无知识点，等回填后再开）；化学的重做可以做。
- 家长端查看这些新记录。
- 重做的草稿断点续做（单题重新答，不恢复草稿）。

---

## 2. 关键设计决策（已与用户确认）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 重做范围 = 全部套卷（不限学科）+ 数理化专项中的每一道单题 | 套卷每题都有题目 id；数理化专项的题也在题库里 |
| 2 | 重做不落练习记录、不发任何分 | 用户明确：重做是「仅做这一道题」的临时尝试 |
| 3 | 重做判错仍进错题本、判对仍清零，但关闭订正分 | 不记录 ≠ 不判题；重做对了要能解掉原来的错题，否则门禁卡着 |
| 4 | 同类型练习落一条专项记录并发分 | 相当于一次专项训练 |
| 5 | 同类型题量 1/2/3/5；新增 2 题档 = 5 分 | 用户指定题量；2 题档给数学/物理专项补规则 |
| 6 | 同类型本期开数学 + 物理；化学等知识点回填 | 化学 0 道题有知识点，无法生成；物理题库薄，靠 AI 补 |
| 7 | 数理化专项保存整轮题单，未作答的题用占位行呈现 | 复用现有作答表，改动最小；统计语义正好是计划题数/答对数 |
| 8 | 复用现有 TargetedRunPage，不新写答题页 | 答题、判题、结果、草稿、讨论都已具备 |
| 9 | 前端走 `mode=redo`（判题 source 仍为 targeted，仅关闭订正分），不建任何会话 | 无记录、无发分，避免污染专项历史 |
| 10 | 多知识点题取 primary 最小 id；无 primary 取 secondary 最小 id | 实测权重全是 1.0，权重区分不了 |

---

## 3. 数据现状（2026-11-06 实测）

| 学科 | 总题数 | 在架 | 有答案 | 有知识点 | 可用（在架+答案+知识点） |
|---|---|---|---|---|---|
| 数学（1） | 563 | 475 | 373 | 552 | **342** |
| 物理（4） | 161 | 160 | 60 | 154 | **58** |
| 化学（5） | 75 | 75 | 75 | **0** | **0** |

- 物理题型：choice 71（有答案 27）、short_answer 57（21）、multi_choice 23（8）、calculation 10（4）。
- 化学全部 75 道题没有知识点关联 → 既没有种子，也没法按 KP 抽题；本期只支持化学的「重做」。
- AI 变式能力目前只有数学 prompt（`prompts/variation/generate.md`）与 math 路由；物理要新增 prompt 与路由。

---

## 4. 交互设计（用户已认可草图）

### 4.1 练习记录详情页

- 每题标题行：左侧「第 N 题 + 状态徽章」，右上角两个轻量按钮：
  - **重做**：文字主色（黑），线性 SVG 刷新图标。
  - **同类型练习**：品牌橘色，线性 SVG 复制/同类图标。
- 点「同类型练习」→ 按钮下方弹出小面板（右对齐、白卡、细边框、阴影）：
  - 标题「练几题」；
  - 1 / 2 / 3 / 5 四个分段按钮，取学生当前可用档位（`getMyPointRules` 与 1/2/3/5 的交集）；
  - 点数字直接开始，不再二次确认；请求中按钮转圈、其他动作禁用。
- 点「重做」→ 按钮转圈 → 进入答题页。
- 不满足条件的题不显示按钮（不是显示后报错）。
- 状态徽章新增「未作答」：`method === 'unanswered'` 或 `answerText == null` 时显示（警示色）；优先于答对/答错/未判定。

### 4.2 答题页与返回

- 复用 `/student/training/targeted/run`（全屏训练页）。
- 交接体（sessionStorage）扩展为：
  ```ts
  {
    sessionId: number | null;
    questions: TargetedPracticeQuestion[];
    title: string;
    mode: 'similar' | 'redo';
  }
  ```
- URL 带 `?subjectId=N&returnTo=<encodeURIComponent(原详情路径)>`。
- 完成/返回：回 `returnTo`（原练习详情页）；`returnTo` 只允许 `/student/practice-history/...`，否则回落训练首页。
- 结果页：
  - `mode=similar`：现有发分/庆祝/补偿套题逻辑不变，返回按钮回原详情。
  - `mode=redo`：不显示发分块、不显示补偿套题卡；标题「重做：<原记录标题> · 第 N 题」；返回按钮回原详情。

---

## 5. 数据模型

### 5.1 不新增表

- 考试侧：`exam_answers` 已有未作答行（`method='unanswered'`），不改。
- 专项侧：复用 `special_answer_records`，为「计划了但没答」的题插入**占位行**：
  - `question_id` = 题目 id；
  - `question_order` = 该题在**原始题单**中的 1-based 位次；题单中有 id 被跳过时**不压缩**，故可能不连续（非 1..N 连续）；
  - `answer_text` = NULL，`is_correct` = NULL，`method` = NULL，`score` = NULL；
  - 唯一键 `uniq_sar_session_q (session_id, question_id)` 保证幂等。

### 5.2 题单保存时机

- 数理化专项的答题页在每次判题请求里带 `plannedQuestionIds: number[]`（按题单顺序，含已答与未答）。
- 后端在惰性创建专项会话后，调用 `ensurePlannedQuestions(sessionId, entries)`：
  - 校验每个 id 存在、`is_active=1`、学科与会话一致；不合法跳过并 warn（不阻断判题）；
  - `INSERT IGNORE` 占位行，`question_order` 取**未过滤题单**的数组下标 +1：中途有题失效被跳过时，
    后一题仍保留**原始 1-based 位次**、不压缩（`upsertAnswer` 的 ON DUPLICATE KEY UPDATE 不重写 `question_order`），
    因此库里的 `question_order` **可能不连续**（例如 1,2,4,5）。
- 老客户端不传该字段 → 不插占位行，行为与现在一致。
- 一轮专项如果一道题都没答，不会创建会话（现状），因此也不会形成记录。

### 5.3 既有 bug 修复：题号

- 现在 `TargetedRunPage` 发送 `questionOrder: Number(q.n)`，而 `q.n = String(questionId)` → 详情显示「第 6690 题」。
- 改为按题单顺序建立的 `orderByQuestionId` 映射，发送真实序号 1..N。
- 线上 `special_answer_records` 目前无数据，修复不影响历史。

### 5.4 积分规则迁移

- `DEFAULT_RULES` 新增：
  - `math_targeted` / `physics_targeted` 的 `tierKey='2'`、`tierLabel='2 题'`、`points=5`、`dailyLimit=5`；
  - 档位排序保证 1 < 2 < 3 < 5 < 10（数学基线 30/31/32/33/34，物理 100/101/102/103/104）。
- 迁移 `tools/db/migrations/2026-11-06_add_targeted_2_tier.sql`（幂等）：
  1. 对每个已有 `math_targeted` / `physics_targeted` 规则的学生，`INSERT IGNORE` 一条 2 题档（5 分、日限 5）；
  2. 用 `CASE tier_key` 把两个任务码的 `sort_order` 重排到固定值（重复执行结果一致）。
- 家长端积分配置页自动出现 2 题档，无需额外 UI。

---

## 6. 后端设计

### 6.1 详情接口扩展

`GET /api/student/practice-history/:source/:sessionId`：

- 每题增加：
  - `canRedo: boolean`：`questionId != null` 且题目存在且 `is_active=1`；
  - `canSimilar: boolean`：`canRedo` 且学科 ∈ {1,4} 且该题知识点存在且标准答案非空。
- 题量选项不写进详情接口：前端**详情加载后**按学科调用现有 `GET /api/points/me/rules`，取 `[1,2,3,5] ∩ 可用档位`（与 PRD §7.13「档位即可选项」一致）；交集为空则隐藏同类型按钮。
- 实现：
  - exam 分支：`findAnswersWithQuestions` 增加 `is_active`、`answer` 的返回；批量查 `question_knowledge_points` 判断知识点存在。
  - special 分支：`listBySession` 已 join `questions`，补 `is_active` 与答案非空判断；同样批量查知识点。
  - 占位行在详情里 `answerText=null, method=null`，前端据此显示「未作答」。

### 6.2 `POST .../questions/:questionId/redo`

- 请求：无 body。
- 归属校验：会话属于当前学生；题目属于该会话（exam 查 `exam_answers`，special 查 `special_answer_records`）；否则 404（与详情一致，不泄漏存在性）。
- 校验：题目 `is_active=1`；否则 400。
- 返回：
  ```json
  {
    "questions": [{ "questionId": 6690, "text": "...", "type": "choice", "options": [{"label":"A","text":"..."}], "materialText": null }],
    "title": "重做：2026 昌平·昌平一中 初三（上）期中 · 第 1 题"
  }
  ```
- 不创建任何会话、不写任何记录、不发分。
- 字段白名单：不含 `answer` / `explanation`。

### 6.3 `POST .../questions/:questionId/similar`

- 请求：`{ "count": 1 | 2 | 3 | 5 }`。
- 校验：
  - 归属同上；
  - 学科 ∈ {1,4}；否则 400；
  - `count` ∈ {1,2,3,5} 且在该生 `listTierKeys` 白名单内；否则 400；
  - 题目有知识点、标准答案非空；否则 400。
- 抽题算法：
  1. 取 `kpId`：primary 中 id 最小；无 primary 取 secondary 中 id 最小。
  2. `type = seed.type`，`difficulty = seed.difficulty`（1..3）。
  3. 题库第一轮：同 subject/kp/type/难度，排除 seed、已选、`student_hidden_questions`、`is_active=0`、`answer=''`，随机取 `count`。
  4. 不足：难度放宽到 `[d-1, d, d+1]`（边界收敛 1..3），排除已选，再取缺口。
  5. 仍不足：AI 生成缺口（见 6.7），最多 20 秒；失败/超时用题库已有题。
  6. 返回 `min(count, 实际得到)`；实际 0 → `{ questions: [], sessionId: null, title }`（200，不报错）。
- 发分：
  - `tierCount = max(可用档位 ∩ {1,2,3,5} ∩ ≤ 实际题数 的值)`；实际 0 或没有可用档位时不建会话（`sessionId=null`，只练习不计分）；
  - 建 `training_sessions`：`task_code=targetedTaskCode(subjectId)`、`tier_key=String(tierCount)`、`expected_count=actual`、`ref_type='question'`、`ref_id=null`；
  - 返回 `sessionId`；前端收尾调 `POST /api/training/sessions/:id/complete` 发分（与现有专项一致）。
- 返回：
  ```json
  {
    "questions": [{ "questionId": 7001, "text": "...", "type": "choice", "options": [...], "materialText": null }],
    "sessionId": 123,
    "title": "同类练习：反比例函数的图象与性质 · 3 题"
  }
  ```
- 生成的题持久化：
  - `questionsRepo.findOrCreate`（`content_hash` 去重）；
  - `subject_id` = 种子学科（1/4），`type` = 种子题型，`difficulty` = 种子难度；
  - `source='history_practice'`；
  - 新建的题 `bindKnowledgePoint(id, kpId, 'primary')`；撞 hash 复用已有题不重复挂 KP。

### 6.4 判题

- 同类型：`POST /api/training/judge`，`source='targeted'`，带 `sessionId`（training session）、`sessionUid`、`title`、`questionCount`、`questionOrder`、`plannedQuestionIds`；现有判题/错题本/专项记录逻辑不变。
- 重做：
  - `source='targeted'`，**不带** `sessionId`、`sessionUid`、`plannedQuestionIds`；
  - 请求新增 `suppressErrorFixPoints: true`（仅重做模式由前端发送）；
  - `judgeTraining` 把该字段透传到 `judgeCore`；
  - `judgeCore` 在答对清错题时：仍执行 `clearUnclearedByStudentQuestionId` 与 `trackCleared`，但跳过 `awardErrorFixOnClear`（`pointsAwarded=0`，响应不弹分）；`recordSelfAssessment` 同口径（主观题自评对也不发订正分）；
  - 答错仍 `writeErrorBookOrReuse`，source 仍为 `targeted`，错题本/门禁行为与普通专项一致。
- 该字段不构成安全边界：学生把它设 true 只会少拿自己的订正分；设 false 也只会在「清掉一条未清错题」时拿一次 3 分，无法重复刷。

### 6.5 前端发分与记录

- 同类型：答题页生成 `sessionUid`（现有机制），首次判题时惰性建 `special_practice_sessions`（module=math_targeted / physics_targeted，title=同类练习…）；收尾 complete 发档位分；记录出现在练习记录。
- 重做：不生成 `sessionUid`、无 sessionId；判题不写 `special_answer_records`；不调 complete；不产生记录。

### 6.6 AI 物理扩展

- `VariationRequest` 增加可选 `subject?: 'math' | 'physics'`（默认 `math`，现有调用方不变）。
- `VariationCapability.generate`：`route({ scene:'variation', subject })`、`promptBuilder.build({ capability:'variation', subject, ... })`。
- `PromptBuilder` 的 variation 分支按学科取模板：数学 `variation/generate.md`，物理新增 `variation/physics.md`。
- `model-routes.yaml` 增加 `variation: subject: physics`（与数学同主/备模型）；**模型路由真源在数据库/管理端配置，部署时须确认 DB 里也有 physics 的 variation 路由，YAML 仅兜底**。
- 物理 prompt 要求：
  - 与数学同输出 JSON schema（content/options/answer/explanation/difficulty/variationType）；
  - 物理情境、单位、有效数字；`choice` 恰有 1 个正确项；`multi_choice` 至少 1 个正确项，`answer` 用正确项 label 集合（如 `BD`）；
  - 不返回与种子题同文的题。
- 校验/归一：
  - `variationRejectionReason` 扩展 `multi_choice`：选项 ≥2、至少 1 个 `isCorrect`、`answer` 与正确 label 集合一致（顺序无关）；
  - `toStoredAnswer` 扩展 `multi_choice`：正确项 label 排序后拼接；`choice` 维持现有归一。
- 超时：该路径调用 `generate` 时传 `timeoutMs=20000`，并关闭重试；超时后不再等待、不入库，直接用题库已有题。

### 6.7 异常与边界

- 会话/题目不属于当前学生：404。
- `source` 非 exam/special：400；`count` 非法：400；学科不支持：400；无 KP / 无答案：400。
- 题库 0 且 AI 失败：200 + 空数组；前端 toast「暂时没有同类题」，不跳转。
- 实际题数 < 请求：照常进入答题页，标题用实际题数，档位按实际题数取。
- 判题/写入记录失败：沿用现有「旁路写入失败只 warn、不阻断判题」。
- 计划题单里有非法 id：跳过并 warn，不影响判题。

---

## 7. 前端设计

### 7.1 练习记录详情页

文件：`apps/web/src/pages/student/PracticeHistoryDetailPage.tsx`

- `QuestionCard` 头部改为 `justify-between`：
  - 左：`第 N 题` + 徽章（含新增「未作答」）；
  - 右：`Button variant="ghost" size="sm"` 两颗；重做用 `text-[var(--text-primary)]`，同类型用 `text-[var(--brand-500)]`；图标 14px 线性 SVG。
- 点击处理：
  - 重做：置 loading → `redoPractice(source, sessionId, questionId)` → 写交接体（`mode:'redo'`、`sessionId:null`）→ `navigate('/student/training/targeted/run?subjectId=N&returnTo=...')`。
  - 同类型：弹出小面板，只展示已算好的档位数字；点数字 → 置 loading → `startSimilarPractice(...)` → 写交接体（`mode:'similar'`、`sessionId`）→ 同路由。
  - **档位取值时机（实现口径）**：详情加载完就按学科取一次 `getMyPointRules`（`useEffect` 依赖详情的 `data`，仅数学/物理且存在 `canSimilar` 的题时才请求），取 `[1,2,3,5] ∩ 可用档位` 存进 state；交集为空则**整页不显示**同类型按钮。看起来是「面板打开时取值」，实际必须提前——按钮显不显示取决于交集是否为空，打开面板才取会让按钮先闪一下或永不出来。
  - 错误：toast；空结果：toast「暂时没有同类题」。
- 「未作答」判定：`q.method === 'unanswered' || q.answerText == null`。
- 用 `useEffect` 在 `source/sessionId` 变化时清空面板/loading，防止切记录串状态。

### 7.2 答题页

文件：`apps/web/src/pages/student/training/TargetedRunPage.tsx`

- 交接体解析扩展 `title`、`mode`（`parseRunHandoff`）。
- `mode='redo'`：
  - `sessionUid` 不生成（或生成但判定为 redo 时不发送）；
  - 判题 `source='targeted'` + `suppressErrorFixPoints: true`；主观题自评也带同一字段；
  - 不带 `sessionId`、`sessionUid`、`plannedQuestionIds`；
  - 不调用 `useSessionPointsCompletion` 的 complete；
  - 结果页隐藏发分块与补偿套题卡。
- `mode='similar'` 与普通专项：判题时都带 `plannedQuestionIds`（题单顺序），否则未作答的题仍不可见。
- 两者都：`returnTo` 优先作为完成/退出目标；`returnTo` 白名单校验。
- 题号：`orderByQuestionId` 取下标 +1，替代 `Number(q.n)`。

### 7.3 API 层

`apps/web/src/services/api.ts`：
- `redoPractice(source, sessionId, questionId)`；
- `startSimilarPractice(source, sessionId, questionId, count)`；
- `judgeTraining` 入参增加 `suppressErrorFixPoints?: boolean`、`plannedQuestionIds?: number[]`；
- 详情类型增加 `canRedo`、`canSimilar`。

---

## 8. 测试计划

### 8.1 后端

- 详情：exam/special 的 `canRedo`/`canSimilar`；无 KP/无答案/下架题/语文专项 → false；前端档位交集（1/2/3/5 ∩ 可用档位）另测。
- 重做端点：归属 404、跨学生 404、下架题 400、返回白名单无答案；**不建任何会话**（断言 training_sessions/special_practice_sessions/special_answer_records 无新行）。
- 重做判题：答错写错题本；答对清零；`suppressErrorFixPoints=true` 时 `pointsAwarded=0`，但清零事件仍记；自评对同口径。
- 同类型：count 白名单；题库抽题难度阶梯/排除；AI 失败降级；0 题 → 无 session；实际 3 题请求 5 → tier_key='3'；落库去重/source/subject_id/KP 绑定。
- 物理 AI：subject 参数选 physics prompt/route；落库 subject_id=4；multi_choice 答案归一与校验。
- 占位行：首次判题插入；幂等；`countBySession` 分母包含未作答；详情包含未作答行。
- 题号：答题页发送 1..N（前端测试为主）。
- 2 题档：默认规则含 2；迁移幂等；`listTierKeys` 返回 1/2/3/5/10。

### 8.2 前端

- 详情：按钮显示/隐藏、未作答徽章、1/2/3/5 面板、loading、空结果 toast、跳转参数与 `returnTo`。
- 答题页：redo 模式不发 sessionUid/sessionId、带 `suppressErrorFixPoints`；similar 模式带 `plannedQuestionIds`/`sessionUid`；结果页返回目标。
- 渲染测试：`PracticeHistoryDetailPage` 多用例文件必须自己 `afterEach(cleanup)`（`globals:false`）。

### 8.3 端到端冒烟

1. 数学套卷最后一题未作答 → 详情显示「未作答」→ 重做 → 答对 → 回详情；**练习记录不多一条**，错题本已清零。
2. 数学详情点「同类型练习」3 题 → 答题 → 发 8 分 → 练习记录多一条「同类练习：… · 3 题」。
3. 数理化专项 5 题只答 2 题 → 历史显示 `共 5 题 · 对 2/5`，3 题未作答 → 重做其中一题（无新记录）。
4. 物理题（有 KP+答案）同类型 → 题库优先；不足时 AI 生成物理题。
5. 语文/英语专项详情 → 不显示两个按钮；语文套卷 → 只显示重做。

---

## 9. 文档同步

- PRD：§6.4 已补；§7.13 的 `math_targeted`/`physics_targeted` 档位表已补 2 题档与「五档」说明。
- API 文档 §4.29：新增两个端点、详情字段（`canRedo`/`canSimilar`）；训练判题端点补 `suppressErrorFixPoints` / `plannedQuestionIds`（所在 §4.x 同步）。
- `docs/api/openapi.yaml`：与 API 文档同步。
- `docs/ai-core-changelog.md`：记录本次实现与物理 prompt/2 题档迁移。

---

## 10. 上线与数据

- 迁移：`2026-11-06_add_targeted_2_tier.sql`（幂等，手工 apply；纯数据，无表结构变更）。
- 无表结构变更（占位行复用现有列）。
- 老专项记录不会补题单；只有本期之后开练的专项才有未作答行。
- 化学：等 75 道题的知识点回填后，把 `SIMILAR_SUBJECTS` 加上 5 即可开放；本期 `canSimilar=false`。
- 物理 AI 需要 DB/管理端存在 variation + physics 路由；否则会走默认模型，质量与超时需实测。

---

## 11. 风险与已知限制

1. **物理 AI 生成质量**：题库只有 58 道可用种子，主要靠 AI；生成题未人工校验（`answer_verified=0`），存在题干缺条件/答案错误风险。沿用现有变式校验，仍需上线前抽样。
2. **化学数据缺口**：0 个知识点，本期同类型完全不可用；PRD 已写明等回填。
3. **重做判错会入错题本**：对一道原本答对的题重做错，会新增一条未清零错题、参与门禁；这是「判题仍走既有规则」的预期结果。
4. **原记录不改写**：重做对了，原记录仍显示「未作答」；但错题本已清。用户已确认接受。
5. **20 秒超时**：AI 未在 20 秒内完成则少给题；物理题库薄时更容易触发。
6. **档位 2 的存量迁移**：只给已有 `math_targeted`/`physics_targeted` 规则的学生补；从未有规则的学生由 `ensureRules` 默认种子覆盖。
