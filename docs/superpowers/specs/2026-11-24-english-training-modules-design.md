# 英语训练轨四模块（真题考试 / 专项练习 / 错题练习 / 薄弱点图谱）设计

日期：2026-11-24
状态：设计已与用户确认，待写实施计划

## 1. 背景与目标

用户要求：参考语文已有实现，为英语补上【真题考试】模块；把原有「背单词」归入【专项练习】模块；再补【错题练习】和【薄弱点图谱】两模块（用户原话「都参考语文实现」，但实测语文并没有薄弱点图谱，已与用户确认改为**照数学/物理的通用实现**）。

目标：英语学生在训练轨能走通「真题考试 → 专项练习（含背单词）→ 错题练习 → 薄弱点图谱」四条路径，数据与判题复用现有题库体系，不另起一套。

## 2. 探索得到的事实（设计的依据）

### 2.1 四个模块本质是学科参数化通用能力
- 真题考试：`/student/training/exam`、`/exam/run/:sessionId`、`/exam/result/:sessionId` 三条路由 + `/api/exams/*` 七个端点 + `exam_papers`/`paper_questions`/`exam_sessions`/`exam_answers` 四张表，全部带 `subject_id`，无语文专用分叉。
- 错题练习：`/student/training/errors`、`/errors/run` + `/api/training/error-book` 等，靠 URL `?subjectId=` 一路传到 `main_error_books.subject_id`。答对 `is_cleared=1` 逻辑删除。
- 专项练习：`/student/training/targeted`、`/targeted/run`，按 `subject_id` 抽题。
- 薄弱点图谱：`/student/training/weak-points`，后端 `knowledge-graph.controller.ts` 用 `SUPPORTED_SUBJECTS={1,4,5,9}` 门禁，英语(3)被拒。

### 2.2 英语现状
- 入口卡 `homePath='/student/training/english/vocabulary'`（`apps/web/src/subjectConfig.ts:104-108`），直接跳背单词配置页，**绕过四卡页**，所以英语学生看不到真题/专项/错题/薄弱点。
- 背单词是独立子系统：`english_words` / `student_word_progress` / 独立判题 / 错词池 `wrong_count`，故意不挂 `questions`、不进错题本（spec `2026-09-16-english-vocabulary-special-design.md`）。用户已确认「归入专项练习」=**入口归并，保留独立词库**，不动表和判题。
- 判题：`exams.service.ts:37-40` 的 `shouldSelfAssess()` 在默认 `self_assess` 模式下，对所有 `short_answer`/`proof` 返回 true，与学科无关。所以英语现状就是「客观题 exact 判分、非客观题自评」，**符合用户要求，不需要改判题配置**。
- `paperTaskCode(3)` 无映射 → 回落 `math_paper`；`targetedTaskCode(3)` 无映射 → 回落 `math_targeted`；`training.service.ts` 作答 module 映射英语也落 `math_targeted`。这三处必须补。

### 2.3 数据现状（2026-11-24 实测）
| 套卷 id | 标题 | 题数 | 有答案 |
|---|---|---|---|
| 974 | 2026 西城 初三 期末 | 35 | 0 |
| 975 | 2026 西城·三帆中学 初三 期末 | 35 | 35 |
| 1008 | 2026 东城 初三 模拟一 | 38 | 35 |

- 题型分布：choice 61 + short_answer 9（共 70）。英文材料 `material_url` 挂在题上，`materialPositionFor(3)=null`（材料放题干下方），与语文一致。
- 知识点：`knowledge_points WHERE subject_id=3` = **0 行**；70 道题挂 qkp = **0 行**。
- 用户裁决：**974 不隐藏**，无答案题由 JudgeCore 的空答案守卫跳过判分（`judge-core.service.ts:304-307` 返回 `noStandardAnswer:true`），接受这份卷体验不完整。

## 3. 范围

### 做
1. 英语入口接到四卡页；「背单词」作为专项练习内的入口。
2. 真题考试：补 `en_paper` 发分任务码；标题文案；其余复用。
3. 专项练习：补 `en_targeted` 任务码/档位/题型；修 module 映射。
4. 错题练习：零代码复用，仅文案。
5. 薄弱点图谱：开放英语门禁 + 英语知识点种子 + 70 题自动打标。
6. 测试与端到端冒烟。

### 不做
- 不动背单词的表、判题、错词池、页面。
- 不新建表、不新增 API 端点（知识点种子是一次性 SQL，不是新表）。
- 不给英语开放「试卷题号」「中考模型」两种数学专属模式。
- 不改判题口径（客观 exact / 非客观自评维持现状）。
- 不引入小程序相关代码。

## 4. 详细设计

### 4.1 入口与导航

**`apps/web/src/subjectConfig.ts`**
- `TRAINING_SUBJECTS` 中英语项（`:104-108`）：
  - `desc`: `'背单词'` → `'专项练习 / 真题考试 / 错题练习'`
  - `homePath`: `'/student/training/english/vocabulary'` → `'/student/training/home?subjectId=3'`
  - `typeOptions`: `[]` → `EN_TYPE_OPTIONS`（新增常量：`ALL` / `choice` 选择 / `short_answer` 简答，与库里实际题型一致）
  - 新增 `targetedTaskCode: 'en_targeted'`
- 注释 `:53` 的「英语无专项练习」同步改掉。
- `selfAssessEligible()` 无需改：英语非客观题已返回 true。

**`apps/web/src/pages/student/training/targeted/TargetedConfigPage.tsx`**
- 在模式切换区之前加一条**英语专属**（`subjectId === SUBJECT_ENGLISH`）入口条：
  - 文案「背单词」+ 按钮「进入」→ `navigate('/student/training/english/vocabulary')`
  - 这是一个纯入口，`VocabularyConfigPage` / `VocabularyRunPage` 一行不改。
- 英语不显示「中考模型 / 试卷题号」两个模式按钮（现有 `subjectId === SUBJECT_MATH` 判断已经做到）。

**`apps/web/src/pages/student/training/ExamListPage.tsx:211`**
- 标题三元：`subjectId === SUBJECT_CHINESE ? '语文 · 真题' : '考试'` → 增加英语分支 `'英语 · 真题'`，其余保持 `'考试'`。

**`apps/web/src/pages/student/training/errors/ErrorPracticePage.tsx:252`**
- 语文特判标题旁边补英语文案（「英语 · 错题练习」）。

### 4.2 真题考试

无新端点、无新页面、无新表。后端 `exams.service.ts` / `exams.controller.ts` 不改。

**发分配置**
- `apps/server/src/common/subject-config.ts:23-29`：`PAPER_TASK_CODE` 加 `[SUBJECT_ENGLISH]: 'en_paper'`。
- `apps/server/src/modules/points/default-rules.ts`：
  - `TASK_NAMES` 加 `en_paper: '英语卷子一套'`、目标值与 `en_targeted: '英语专项'`
  - `DEFAULT_RULES` 加：
    - `{ taskCode:'en_paper', tierKey:'default', tierLabel:'一套', points:50, dailyLimit:null, sortOrder:29 }`
    - `en_targeted` 四档 1/3/5/10 → 2/8/15/35 分，`dailyLimit:5`（沿用语文 `cn_targeted` 口径，见 `:68-71`），sortOrder 124-127
  - 注意默认规则只对**新学生**生效（`INSERT IGNORE`），存量学生不回溯——这是既有约定，本期不改。
- 文档同步：`docs/API接口与数据流设计文档.md` 的任务码表（约 `:1958`）补两个任务码；若有对应 openapi 任务码枚举一并核对（CLAUDE.md 的 API 文档同步规则）。

**判题（维持现状，仅记录）**
- `choice` → JudgeCore `compareAnswer` exact 比对。
- `short_answer` → `shouldSelfAssess()` 为 true → 结果页自评，学生对照 `questions.answer` 判断。
- 974 的 35 道无答案题 → `judge-core.service.ts:304-307` 空答案守卫，`is_correct=null, method='unanswered', noStandardAnswer=true`，不计分不入错题本。列表仍展示该卷。

### 4.3 专项练习（含「单词归入」）

**任务码与 module 映射**
- `apps/server/src/common/subject-config.ts:15-21`：`TARGETED_TASK_CODE` 加 `[SUBJECT_ENGLISH]: 'en_targeted'`。
- `apps/server/src/modules/training/training.service.ts:217-221` 的 subject→module 映射补 `3 → 'en_targeted'`（现在英语落 `math_targeted`）。
- `apps/server/src/database/repositories/special-practice-sessions.repo.ts:5-8` 的 `SpecialSessionModule` 联合类型加 `'en_targeted'`。
- 前端 `subjectConfig.ts` 的 `targetedTaskCode` 见 4.1。
- `usePointTiers` 读家长档位规则，英语档位由 `en_targeted` 提供（见 4.2）。

**抽题模式**
- 知识点模式：现有 `questions.repo.ts:214-240` 已带 `q.subject_id=?`，英语可直接用（前提：KP 打标完成，见 4.5）。
- 试卷题号（`training.controller.ts:239-248`）、模型专项（`:253-261`）仍仅数学，英语不开放。

### 4.4 错题练习

零代码改动即可用：考试/专项判错经 `JudgeCoreService` 写入 `main_error_books(subject_id=3)`；错题页按 `?subjectId=3` 拉取；答对 `clearUnclearedByStudentQuestionId` 逻辑删除。唯一改动是 4.1 提到的页面标题文案。

> 英语背单词的「错词池」在 `student_word_progress`，**不进** `main_error_books`，这是用户确认的入口归并边界，本期不打通。

### 4.5 薄弱点图谱

**门禁**
- `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts:28-29`：
  `SUPPORTED_SUBJECTS = new Set([1,4,5,9])` → 加入 `SUBJECT_ENGLISH(3)`。
- `:87-90` 错误文案「subjectId 仅支持 1/4/5/9」同步更新为含 3。
- 前端 `WeakPointGraphPage.tsx:65-67` 用 `getTrainingSubject(3)?.targetedTaskCode`，4.1 配了 `en_targeted` 后自动正确，不再回落 `MATH_TASK_CODE`。

**知识点种子（新增迁移）**
- 新建 `tools/db/migrations/2026-11-24_english_knowledge_points.sql`，幂等（`INSERT IGNORE` 或先查后插）。
- 按 `knowledge_points` 现有列（`id, subject_id, parent_kp_id, name, code, grade_band, difficulty, description`，见 `schema.sql:180-195`）造一棵英语树，二级 code 用 `E01`…前缀以便识别：
  - `E01` 语法（时态语态 / 从句 / 非谓语 / 情态动词 / 比较级 / 介词连词）
  - `E02` 词汇（词义辨析 / 固定搭配 / 词形变化 / 熟词僻义）
  - `E03` 完形填空（上下文推断 / 逻辑衔接 / 词义复现）
  - `E04` 阅读理解（细节理解 / 推理判断 / 主旨标题 / 词义猜测）
  - `E05` 阅读表达与写作（信息提取 / 观点表达 / 文段表达）
- `code` 用 `E01`… 前缀不写死 `id` 让 DB 自增。**幂等写法照既有迁移**（`2026-10-28_add_chinese_knowledge_points.sql`）：`knowledge_points` 表**没有** `(subject_id, code)` 唯一约束，所以必须逐行 `INSERT ... WHERE NOT EXISTS`，不能用 `INSERT IGNORE`。

**自动打标**
- 跑 `python3 tools/data-refinery/src/backfill_question_kps.py --subject english`（已支持 `--subject`，见 `:217-239, :252, :287-318`；英文 prompt `prompts/question_kps/english.txt` 已存在）。
- 前置条件：`knowledge_points WHERE subject_id=3` 非空——由上面的种子迁移满足。
- 工具只为「无 qkp 记录的本学科题」打标，天然幂等；70 道题跑完后再查 `with_kp` 应 > 0。
- 打标是 LLM 调用，结果不可完全复现（见记忆 `project_refinery_llm_nondeterminism`）；抽查若干条确认没有把题目归到明显错误的类目。

**掌握度链路**
- `student_knowledge_mastery` 写入口 `MasteryService.recordFromJudge` 在 `judge-core.service.ts:272-276, :796-802`，按题的全部 KP 通用写入，英语无需改。
- 图谱阈值 `WEAK_LEVEL_MAX=2` 在前端 `weak-point-heat.ts:77` 与后端 `knowledge-graph.dto.ts:28` 各有一份，本次不改阈值，但改动时须同步。

## 5. 数据改动汇总

| 改动 | 类型 | 幂等/风险 |
|---|---|---|
| 英语知识点种子 | 新迁移 SQL | 逐行 `NOT EXISTS` 防重（表无唯一约束），参照语文 KP 种子迁移；种子数据不进 `schema.sql`（本就由独立迁移维护） |
| 70 道英语题 KP 打标 | 跑现成脚本写 `question_knowledge_points` | 脚本天然幂等；LLM 结果需抽检 |
| 974 无答案 | **不改数据**，用户裁决保留 | JudgeCore 空答案守卫跳过判分 |

## 6. 接口与配置改动清单（端点级）

**无新增/变更 API 端点**。只改以下配置真源：
1. `apps/web/src/subjectConfig.ts` — 英语项 4 字段 + 新常量 `EN_TYPE_OPTIONS`
2. `apps/web/src/pages/student/training/targeted/TargetedConfigPage.tsx` — 英语「背单词」入口
3. `apps/web/src/pages/student/training/ExamListPage.tsx:211` — 标题
4. `apps/web/src/pages/student/training/errors/ErrorPracticePage.tsx:252` — 标题
5. `apps/server/src/common/subject-config.ts` — `PAPER_TASK_CODE`/`TARGETED_TASK_CODE` 加英语
6. `apps/server/src/modules/points/default-rules.ts` — `TASK_NAMES` + `DEFAULT_RULES` 加 `en_paper`/`en_targeted`
7. `apps/server/src/modules/training/training.service.ts:217-221` — module 映射
8. `apps/server/src/database/repositories/special-practice-sessions.repo.ts:5-8` — 联合类型
9. `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts:28-29,87-90` — 门禁 + 文案
10. `tools/db/migrations/2026-11-24_english_knowledge_points.sql` — 新迁移
11. `docs/API接口与数据流设计文档.md`（任务码表）— 文档同步

## 7. 测试与验收

### 自动化测试
- 后端：
  - `subject-config.test.ts` 的穷举断言（现有 `:18` 测试 `TARGETED_TASK_CODE` 等穷举）同步加英语期望值。
  - `default-rules` 相关测试（若有任务码穷举）同步。
  - `training.service` / `knowledge-graph.controller` 的英语用例：验证 module=`en_targeted`、图谱门禁放开。
- 前端：
  - `subjectConfig` 单测（若有）：英语 `homePath`/`targetedTaskCode`。
  - `TargetedConfigPage` 渲染测试：英语显示「背单词」入口，点击导航正确。
  - `ExamListPage` / `ErrorPracticePage` 渲染测试：英语标题文案。
- 数据迁移：迁移脚本重复跑两次，行数不变（幂等）。

### 端到端冒烟（人工，按 CLAUDE.md 一条命令收口）
- **交付给用户的收尾流程必须收敛成一条命令**（预览/确认/写入/复查由脚本内部串起来，不得让用户记两条以上）。
- 起服务用 `node dist/main.js`（不要 `npx tsx`，DI 是坏的）。
- 学生账号路径：训练选科 → 英语 → 四卡页 → 真题考试（选 975 或 1008，交卷看分）→ 错题练习（确认有题）→ 薄弱点图谱（确认有节点）→ 专项练习 → 点「背单词」进词库页。
- 验证 974 仍可开考，无答案题不报错、不误判为错。

## 8. 风险与已知缺口

1. **LLM 打标质量**：`backfill_question_kps.py` 是 LLM 调用，结果不可复现；需抽检，必要时人工修正少量挂错 KP 的题。
2. **974 无答案**：35 题做而不判，学生无反馈——用户已明确接受。
3. **1008 缺 3 题答案**：同理跳过判分，不影响整卷。
4. **默认规则只对新增学生生效**：存量学生家长端需手动补 `en_paper`/`en_targeted` 规则才能拿分；本期不改 seed 逻辑。
5. **build 覆盖共享 dist**：跑 `npm run build` 后用户 dev server 可能加载当前分支，按记忆 `feedback_build_overwrites_shared_dist` 主动披露。
6. **改 API 文档同步**：本次无端点变更，仅任务码表，仍需检查 `openapi.yaml` 是否有对应枚举。
