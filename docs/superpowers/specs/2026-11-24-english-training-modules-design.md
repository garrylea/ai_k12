# 英语训练轨四模块（真题考试 / 专项练习 / 错题练习 / 薄弱点图谱）设计

日期：2026-11-24
状态：设计已与用户确认并完成评审修订，待写实施计划

## 1. 背景与目标

用户要求：参考语文已有实现，为英语补上【真题考试】模块；把原有「背单词」归入【专项练习】模块；再补【错题练习】和【薄弱点图谱】两模块（用户原话「都参考语文实现」，但实测语文并没有薄弱点图谱，已与用户确认改为**照数学/物理的通用实现**）。

目标：英语学生在训练轨能走通「真题考试 / 专项练习（含背单词）/ 错题练习 / 薄弱点图谱」四条并列路径，数据与判题复用现有题库体系，不另起一套。

## 2. 探索得到的事实（设计的依据）

### 2.1 四个模块本质是学科参数化通用能力
- 真题考试：`/student/training/exam`、`/exam/run/:sessionId`、`/exam/result/:sessionId` 三条路由 + `/api/exams/*` 七个端点 + `exam_papers`/`paper_questions`/`exam_sessions`/`exam_answers` 四张表，全部带 `subject_id`，无语文专用分叉。
- 错题练习：`/student/training/errors`、`/errors/run` + `/api/training/error-book` 等，靠 URL `?subjectId=` 一路传到 `main_error_books.subject_id`。答对 `is_cleared=1` 逻辑删除。
- 专项练习：`/student/training/targeted`、`/targeted/run`，按 `subject_id` 抽题。
- 薄弱点图谱：`/student/training/weak-points`，后端 `knowledge-graph.controller.ts` 用 `SUPPORTED_SUBJECTS={1,4,5,9}` 门禁，英语(3)被拒。

### 2.2 英语现状
- 入口卡 `homePath='/student/training/english/vocabulary'`（`apps/web/src/subjectConfig.ts:104-108`），直接跳背单词配置页，**绕过四卡页**，所以英语学生看不到真题/专项/错题/薄弱点。
- 背单词是独立子系统：`english_words` / `student_word_progress` / 独立判题 / 错词池 `wrong_count`，故意不挂 `questions`、不进错题本（spec `2026-09-16-english-vocabulary-special-design.md`）。用户已确认「归入专项练习」=**入口归并，保留独立词库**，不动表和判题。
- 判题：`exams.service.ts:37-40` 的 `shouldSelfAssess()` 当前只因为默认 `JUDGE_SUBJECTIVE_MODE=self_assess` 才让英语 `short_answer` 进入自评。这个口径不能依赖部署环境；本期要把英语 `short_answer`/`proof` 写成显式自评类型，`JUDGE_SUBJECTIVE_MODE=ai` 时仍自评。
- `paperTaskCode(3)` 无映射 → 回落 `math_paper`；`targetedTaskCode(3)` 无映射 → 回落 `math_targeted`；`training.service.ts` 作答 module 映射英语也落 `math_targeted`。这三处必须补。

### 2.3 数据现状（2026-11-24 实测）
| 套卷 id | 标题 | 题数 | 有答案 |
|---|---|---|---|
| 974 | 2026 西城 初三 期末 | 35 | 0 |
| 975 | 2026 西城·三帆中学 初三 期末 | 35 | 35 |
| 1008 | 2026 东城 初三 模拟一 | 38 | 35 |

- 全库题数：英语共 108 题，其中 `is_active=1` 105 题；同时满足在架且有标准答案、可进入专项/形成掌握度的是 **70 题**。题型全库为 choice 91 / short_answer 17；在架且有答案的 70 题为 choice 60 / short_answer 10。
- 英文材料 `material_url` 挂在题上，`materialPositionFor(3)=null`（材料放题干下方），与语文一致。当前 70 道在架有答案题中有 46 道带材料，其中 16 道题干为空、必须依赖材料才能判断知识点。
- 知识点：`knowledge_points WHERE subject_id=3` = **0 行**；英语题挂 qkp = **0 行**。
- 用户裁决一：**974 不隐藏**；没有参考答案的题**不判、无反馈**，这是明确接受的体验。实现上必须把这类题显示为“无参考答案 · 不计分”，不得落成答错，也不得要求学生对空白答案自评。
- 用户裁决二：当前英语试卷较少，知识点图谱不准确、节点稀疏、暂无薄弱点推荐均可接受；后续试卷增加后会自然改善。本期不以短期图谱准确率或推荐命中率作为验收门槛。

## 3. 范围

### 做
1. 英语入口接到四卡页；「背单词」作为专项练习内的入口。
2. 真题考试：补 `en_paper` 发分任务码；把无参考答案题统一成 `no_standard_answer` 状态，从客观/主观统计中剔除；结果页显示“不计分”。
3. 专项练习：补 `en_targeted` 任务码/档位/题型；用学科配置修 module 映射；英语不显示数学专属的相似题补偿入口。
4. 错题练习：数据链路复用，补齐学科 query 传播和标题配置。
5. 薄弱点图谱：开放英语门禁 + 英语知识点种子 + 当前 70 道在架有答案题自动打标；修所有从图谱进入练习/错题/考试的学科上下文。
6. 把页面学科差异配置化，补测试、单一交付命令与端到端冒烟。
7. 同步 PRD、UX、API 文档与 openapi。

### 不做
- 不动背单词的表、判题和错词池；仅调整从专项练习进入时的返回路径。
- 不新建业务表、不新增 API 端点；开放知识图谱学科和考试结果新状态属于既有 API 的契约变更，必须同步文档。
- 不给英语开放「试卷题号」「中考模型」两种数学专属模式。
- 不改变已有判题分层；仅将英语非客观自评从 env 默认行为固化为显式学科规则。
- 不引入小程序相关代码。

## 4. 详细设计

### 4.1 入口与导航

**`apps/web/src/subjectConfig.ts`**
- 给 `TrainingSubjectConfig` 增加可选配置字段，页面只读配置、不新增 `if subjectId === X`：
  - `targetedExtras?: readonly { key: string; label: string; cta: string; to: string }[]`
  - `examListTitle?: string`
  - `errorPracticeTitle?: string`
  - `supportsRemediation?: boolean`（缺省 false）
- `TRAINING_SUBJECTS` 中英语项（`:104-108`）：
  - `desc`: `'背单词'` → `'真题考试 / 专项练习 / 错题练习 / 薄弱点图谱'`
  - `homePath`: `'/student/training/english/vocabulary'` → `'/student/training/home?subjectId=3'`
  - `typeOptions`: `[]` → `EN_TYPE_OPTIONS`（新增常量：`ALL` / `choice` 选择 / `short_answer` 简答，与库里实际题型一致）
  - `targetedTaskCode: 'en_targeted'`
  - `targetedExtras: [{ key: 'vocabulary', label: '背单词', cta: '进入', to: '/student/training/english/vocabulary?from=targeted' }]`
  - `examListTitle: '英语 · 真题'`
  - `errorPracticeTitle: '英语 · 错题练习'`
- 数学项显式配置 `supportsRemediation: true`；其余学科缺省 false。
- 语文项配置 `examListTitle: '语文 · 真题'`、`errorPracticeTitle: '语文 · 错题'`，把现有语文特判迁入配置；其余学科保留原 fallback 文案。
- 注释 `:53` 的「英语无专项练习」同步改掉。
- `selfAssessEligible()` 无需改：英语非客观题已返回 true。

**`apps/web/src/pages/student/training/targeted/TargetedConfigPage.tsx`**
- 在模式切换区之前通用遍历 `subject.targetedExtras`：非空时每条渲染“文案 + CTA”，点击导航到 `to`。英语因此出现「背单词 + 进入」，页面不写英语分支。
- 英语不显示「中考模型 / 试卷题号」两个模式按钮（现有 `subjectId === SUBJECT_MATH` 判断已经做到）。

**背单词返回链路**
- `VocabularyConfigPage` 读取 `?from=targeted`，只认这个固定枚举值；命中时 PageHeader 返回 `/student/training/targeted?subjectId=3`，否则保持 `/student/training`。不接收任意 URL，避免开放重定向。
- 点击「开始」进入 `/student/training/english/vocabulary/run?from=targeted`；`VocabularyRunPage` 返回配置页时保留该参数。词库、判题、错词池均不改。

**考试 / 错题标题**
- `ExamListPage` 标题改为 `getTrainingSubject(subjectId)?.examListTitle ?? '考试'`。
- `ErrorPracticePage` 标题改为 `getTrainingSubject(subjectId)?.errorPracticeTitle ?? '错题练习'`。

### 4.2 真题考试

无新端点、无新页面、无新表；但 `exams.service.ts` 的收卷/结果状态与结果 DTO 必须修改，因此不存在“后端零改动”。

**发分配置**
- `apps/server/src/common/subject-config.ts:23-29`：`PAPER_TASK_CODE` 加 `[SUBJECT_ENGLISH]: 'en_paper'`。
- `apps/server/src/modules/points/default-rules.ts`：
  - `TASK_NAMES` 加 `en_paper: '英语卷子一套'`、目标值与 `en_targeted: '英语专项'`
  - `DEFAULT_RULES` 加：
    - `{ taskCode:'en_paper', tierKey:'default', tierLabel:'一套', points:50, dailyLimit:null, sortOrder:29 }`
    - `en_targeted` 四档 1/3/5/10 → 2/8/15/35 分，`dailyLimit:5`（沿用语文 `cn_targeted` 口径，见 `:68-71`），sortOrder 124-127
  - 默认规则采用既有懒初始化：`PointRulesService.ensureRules()` / `PointsService.award()` 会为存量学生补齐缺失的 `(taskCode, tierKey)`，同时不覆盖家长已改过的值。无需家长手工补规则。
- 文档同步：API 文档 §5 的任务码清单、PRD §7.13 积分表及相关流程说明补两个任务码。

**判题与无答案状态**
- `choice` → JudgeCore `compareAnswer` exact 比对。
- `short_answer` → 英语显式进入自评（见 4.2.1），学生对照 `questions.answer` 判断。
- 收卷循环必须把“无参考答案”放在 `shouldSelfAssess` 之前判断。`COALESCE(TRIM(questions.answer),'')=''` 时统一落 `is_correct=NULL, score=NULL, method='no_standard_answer'`，不写错题本、不触发解析、不要求自评。不能沿用“未作答按错计”分支，也不能因为题型是简答就先落 `self_assess`。
- JudgeCore 的空答案守卫仍保留，作为单题提交/补判的兜底；但不能把它当作考试收卷的唯一保护。

**4.2.1 英语自评门禁**
- 后端 `subject-config.ts` 增加英语显式自评类型 `short_answer/proof`，同时用于考试闸门①和 JudgeCore 闸门②。不得只依赖 `JUDGE_SUBJECTIVE_MODE=self_assess`。
- 不把英语加入“所有非客观题都自评”的宽泛集合，避免未来出现英语 `fill_blank` 时绕过归一化比对。
- 测试必须在 `JUDGE_SUBJECTIVE_MODE=ai` 下仍验证英语 `short_answer` 得到 `needsSelfAssessment=true`。

**4.2.2 结果契约**
- `ExamResultItem` 增加 `method: string`、`hasStandardAnswer: boolean`；`ExamSummaryDto` 增加 `unscoredCount: number`。
- `needsSelfAssessment = hasStandardAnswer && method === 'self_assess'`，不再用 `isCorrect === NULL` 直接推断。
- `summarize` 的客观题分母排除 `method='no_standard_answer'`；该状态不计对、不计错、不计主观、不计掌握度。
- `ExamResultPage` 给 `AnswerResultList` 的 `AnswerRecord` 增加显式 `unscored`（由 `method='no_standard_answer'` 映射），共享结果组件不得靠“不是主观、不是未作答”的排除法推断。
- `AnswerResultList` 按三种终态渲染：已判分 / 待自评 / 无参考答案不计分。`unscored` 不显示自评按钮、不计入“还有 N 题未自评”，也不进入该组件自己的主观题/错误题计数。
- 交卷完成仍按 PRD 的“完成即给分”发 `en_paper`，无答案状态不影响任务完成积分。
- 974 的 35 题全部显示“无参考答案 · 不计分”，不提供反馈；1008 的 3 道缺答案题同样处理。这符合用户裁决。

### 4.3 专项练习（含「单词归入」）

**任务码与 module 映射**
- `apps/server/src/common/subject-config.ts:15-21`：`TARGETED_TASK_CODE` 加 `[SUBJECT_ENGLISH]: 'en_targeted'`。
- 在 `subject-config.ts` 增加 `targetedSessionModule(subjectId)` 映射，覆盖 1/2/3/4/5/9；`training.service.ts` 只调用该函数，删除内联 subject 判断。这样英语落 `en_targeted`，并顺带修正道法当前也会落 `math_targeted` 的既有缺口。
- `apps/server/src/database/repositories/special-practice-sessions.repo.ts:5-8` 的 `SpecialSessionModule` 联合类型补 `'en_targeted'` 与现有缺失的 `'politics_targeted'`。
- 前端 `subjectConfig.ts` 的 `targetedTaskCode` 见 4.1。
- `usePointTiers` 读家长档位规则，英语档位由 `en_targeted` 提供（见 4.2）。

**抽题模式**
- 知识点模式：现有 `questions.repo.ts:214-240` 已带 `q.subject_id=?`，英语可直接用（前提：KP 打标完成，见 4.5）。
- 试卷题号（`training.controller.ts:239-248`）、模型专项（`:253-261`）仍仅数学，英语不开放。
- `TargetedRunPage` 不再用 `subjectId !== SUBJECT_CHINESE` 判断补偿套题；改为读取 `getTrainingSubject(subjectId)?.supportsRemediation === true`。英语、语文、物理、化学、道法均不显示相似题补偿入口，只有数学显示。后端仍保留“只认 math_targeted”的防御校验。

### 4.4 错题练习

考试/专项判错经 `JudgeCoreService` 写入 `main_error_books(subject_id=3)`；错题页按 `?subjectId=3` 拉取；答对 `clearUnclearedByStudentQuestionId` 逻辑删除。业务链路不另写，但必须保证所有入口都携带学科 query：薄弱点图谱详情跳错题使用 `/student/training/errors?subjectId=3&kpId=<id>`，不允许省略 `subjectId`。

> 英语背单词的「错词池」在 `student_word_progress`，**不进** `main_error_books`，这是用户确认的入口归并边界，本期不打通。

### 4.5 薄弱点图谱

**门禁**
- `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts:28-29`：
  `SUPPORTED_SUBJECTS = new Set([1,4,5,9])` → 加入 `SUBJECT_ENGLISH(3)`。
- `:87-90` 错误文案同步改为「subjectId 仅支持 1 / 3 / 4 / 5 / 9」。
- 前端 `WeakPointGraphPage.tsx:65-67` 用 `getTrainingSubject(3)?.targetedTaskCode`，4.1 配了 `en_targeted` 后自动正确，不再回落 `MATH_TASK_CODE`。

**图谱动作的学科上下文**
- `WeakPointGraphPage` 生成统一 `subjectQuery`：数学保持原 URL 不带参，其它学科一律带 `?subjectId=<id>`。
- 以下动作全部必须携带 `subjectQuery`，不能使用裸 `/student/training/*`：
  - “开始补这个” → `/student/training/targeted/run${subjectQuery}`。
  - 详情栏“看这个知识点的错题” → `/student/training/errors?subjectId=3&kpId=<id>`；必须同时保留 `subjectId` 与 `kpId`。
  - 无候选态“去专项练习” → `/student/training/targeted${subjectQuery}`。
  - 无候选态“去考试” → `/student/training/exam${subjectQuery}`。
- 前端缺省学科会回落数学（`parseSubjectId`），因此上述任一处漏 query 都会把英语作答、错题和掌握度写到数学链路；必须有动作级渲染测试，而不是只测页面标题。
- 英语不提供相似题补偿入口；图谱页的推荐动作仍是“开始补这个 / 看错题”，不增加数学专属分支。

**知识点种子（新增迁移）**
- 新建 `tools/db/migrations/2026-11-24_english_knowledge_points.sql`。
- 当前英语题均为初中，一级、二级节点统一 `grade_band='junior'`。一级 code 为 E01–E07，二级 code 为 E0101 等四级数字；不写死 `id`，让 DB 自增。
- 树结构必须与 `src/prompts/question_kps/english.txt` 的类目名称一致：
  - `E01` 语法：`E0101` 时态 / `E0102` 语态 / `E0103` 从句 / `E0104` 非谓语动词 / `E0105` 情态动词 / `E0106` 比较级与最高级 / `E0107` 介词与连词
  - `E02` 词汇：`E0201` 词义辨析 / `E0202` 固定搭配 / `E0203` 词形变化 / `E0204` 构词法 / `E0205` 熟词僻义
  - `E03` 完形填空：`E0301` 上下文推断 / `E0302` 逻辑衔接 / `E0303` 词义复现
  - `E04` 阅读理解：`E0401` 细节理解 / `E0402` 推理判断 / `E0403` 主旨大意 / `E0404` 标题归纳 / `E0405` 词义猜测
  - `E05` 写作与表达：`E0501` 信息提取 / `E0502` 观点表达 / `E0503` 文段表达 / `E0504` 书面表达
  - `E06` 听力：`E0601` 对话理解 / `E0602` 独白理解
  - `E07` 情景交际：`E0701` 情景问答 / `E0702` 交际用语
- **幂等写法**照既有迁移（`2026-10-28_add_chinese_knowledge_points.sql`）：`knowledge_points` 表没有 `(subject_id, code)` 唯一约束，必须逐行 `INSERT ... WHERE NOT EXISTS`，不能用 `INSERT IGNORE`。父节点插入后再按 `(subject_id, grade_band, parent code, child code)` 查父 id 插子节点。

**自动打标**
- 现成 `backfill_question_kps.py` 只读取 `content/options`，看不到英语阅读/完形材料；不能按原样直接跑全库。
- 扩展该脚本（默认行为保持其它学科不变）：
  - 新增 `--include-material`：查询 `material_text`、`material_url`，并使用现有 MaterialDoc 素材读取能力解析 URL 正文；题干为空但材料存在的题必须带材料送给模型。
  - 新增 `--answerable-only`：SQL 增加 `q.is_active=1 AND COALESCE(TRIM(q.answer),'')<>''`。英语本次只标注当前 70 道可练题，不标注 974、未上架题或将来补答案前的题。
  - user message 同时带 `type`，并继续带 options；材料 URL 读取失败时该题记失败、不得退化成只看选项猜测。
- 英语执行命令：`python3 tools/data-refinery/src/backfill_question_kps.py --subject english --include-material --answerable-only`。
- 前置条件：`knowledge_points WHERE subject_id=3` 非空——由上面的种子迁移满足。
- 工具只为「无 qkp 记录的本学科在架有答案题」打标，天然幂等；本次应覆盖当前 70 题，失败题重跑补齐。后续新卷入库时，沿用同一 KP 树和英语提示词自动打标；答案后续补录后会从不合格池进入下一轮。
- 打标是 LLM 调用，历史结果不可完全复现；本期接受图谱短期不准确，但仍需输出失败题清单并人工抽查明显错标。随着试卷增多，树结构和标注会逐步稳定。

**掌握度链路**
- `student_knowledge_mastery` 写入口 `MasteryService.recordFromJudge` 在 `judge-core.service.ts:272-276, :796-802`，按题的全部 KP 通用写入，英语无需改。
- 图谱阈值 `WEAK_LEVEL_MAX=2` 在前端 `weak-point-heat.ts:77` 与后端 `knowledge-graph.dto.ts:28` 各有一份，本次不改阈值，但改动时须同步。
- 图谱短期可能出现大量 `insufficient`、`none` 或 `recommendation=null`，这是已接受的冷启动状态；验收只要求链路正确、节点可见、动作带对学科，不要求本次立即产生高可信推荐。

## 5. 数据改动汇总

| 改动 | 类型 | 幂等/风险 |
|---|---|---|
| 英语知识点种子 | 新迁移 SQL | 逐行 `NOT EXISTS` 防重（表无唯一约束），参照语文 KP 种子迁移；种子数据不进 `schema.sql`（本就由独立迁移维护） |
| 70 道在架有答案英语题 KP 打标 | 扩展回填脚本后写 `question_knowledge_points` | 只处理 `is_active=1 AND answer<>''`；材料必须参与；脚本天然幂等，失败题可重跑 |
| 974 / 1008 缺答案题 | 不改题库数据；收卷与结果状态改为 `no_standard_answer` | 不判、无反馈、不入错题、不计客观/主观统计；用户已明确接受 |

## 6. 接口与配置改动清单（端点级）

**无新增 API 路径**；但考试结果 schema 与薄弱点图谱支持学科属于既有 API 的契约变更，必须同步 `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml`。

1. `apps/web/src/subjectConfig.ts` — 英语入口/题型/任务码/图谱标题/背单词扩展入口/补偿套题能力；新增通用配置字段
2. `apps/web/src/pages/student/training/targeted/TargetedConfigPage.tsx` — 遍历 `targetedExtras`
3. `apps/web/src/pages/student/training/ExamListPage.tsx` — 读取 `examListTitle`
4. `apps/web/src/pages/student/training/errors/ErrorPracticePage.tsx` — 读取 `errorPracticeTitle`
5. `apps/web/src/pages/student/training/WeakPointGraphPage.tsx` — 所有动作传 `subjectId`；图谱门禁对应的学科配置打通
6. `apps/web/src/pages/student/training/TargetedRunPage.tsx` — 读 `supportsRemediation`
7. `apps/web/src/pages/student/training/english/VocabularyConfigPage.tsx` / `VocabularyRunPage.tsx` — 仅增加 `from=targeted` 返回路径，不改词库/判题
8. `apps/web/src/pages/student/training/ExamResultPage.tsx` + `apps/web/src/services/api.ts` + `apps/web/src/components/business/AnswerResultList.tsx` — `unscored` 映射、前端契约镜像、计数与终态展示
9. `apps/server/src/common/subject-config.ts` — `PAPER_TASK_CODE` / `TARGETED_TASK_CODE` 加英语；英语显式自评类型；`targetedSessionModule()`
10. `apps/server/src/modules/exams/exams.service.ts` + DTO — 无答案收卷状态、结果 `method/hasStandardAnswer/unscoredCount`
11. `apps/server/src/modules/practice/judge-core.service.ts` — 英语显式自评口径
12. `apps/server/src/modules/points/default-rules.ts` — `TASK_NAMES` + `DEFAULT_RULES` 加 `en_paper`/`en_targeted`
13. `apps/server/src/modules/training/training.service.ts` — 改用 `targetedSessionModule()`
14. `apps/server/src/database/repositories/special-practice-sessions.repo.ts` — 联合类型补 `en_targeted` / `politics_targeted`
15. `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts` — 门禁 + 文案
16. `tools/data-refinery/src/backfill_question_kps.py` — `--include-material` / `--answerable-only`
17. `tools/data-refinery/src/prompts/question_kps/english.txt` — 选点措辞与英语 KP 树精确对齐
18. `tools/db/migrations/2026-11-24_english_knowledge_points.sql` — 新迁移
19. PRD §6.3 / §7.13、UX §5.8 / §5.13、API 文档 §4.5 / §5、openapi — 接口与实现状态同步
20. 新增唯一交付入口 `tools/english-training/setup.sh` — 串起迁移、回填、测试与复查，见 §7.

## 7. 测试与验收

### 自动化测试
- 后端：
  - `subject-config.test.ts`：英语 task code、显式自评类型、`targetedSessionModule(3)='en_targeted'`；`JUDGE_SUBJECTIVE_MODE=ai` 时英语 `short_answer` 仍跳过 AI 判题。
  - `default-rules` 相关测试：任务数、排序、黄金值、六个学科的任务码穷举同步。
  - `training.service` / `knowledge-graph.controller` 的英语用例：验证 module=`en_targeted`、图谱门禁放开、错误文案含 3。
  - `exams.service`：974 无答案题“作答/未作答”两种路径都落 `no_standard_answer`；1008 的缺答案题同样；`unscoredCount` 正确，客观题分母不含未判题，不写错题本。
  - 自评门禁：英语 `short_answer` 在 env=`ai` 时仍为 `self_assess`；`choice` 仍走 exact；未来英语 `fill_blank` 不被误纳入宽泛自评集合。
  - 数据回填：脚本带材料时能看到 URL 正文；`--answerable-only` 只取 70 题；材料读取失败题进入 failed 清单；默认参数下其它学科行为不变。
- 前端：
  - `subjectConfig` 单测：英语 `homePath` / `targetedTaskCode` / `targetedExtras` / `examListTitle` / `errorPracticeTitle` / `supportsRemediation=false`。
  - `TargetedConfigPage` 渲染测试：英语显示「背单词」入口，点击导航带 `from=targeted`；返回专项练习路径正确。
  - `ExamListPage` / `ErrorPracticePage` 渲染测试：英语标题和学科 query。
  - `ExamResultPage` / `AnswerResultList` 组件测试：`no_standard_answer` 显示“无参考答案 · 不计分”，不显示自评按钮，不计入主观/错误/未自评数量。
  - `WeakPointGraphPage` 英语动作测试：开始补这个、看错题、去专项、去考试四条路径都必须保留 `subjectId=3`。
  - `TargetedRunPage` 英语测试：即使判错也不渲染相似题补偿入口。
- 数据迁移：迁移脚本重复跑两次，行数不变；`grade_band='junior'`、父子关系正确、code 唯一。

### 端到端验收
- 交付给用户只提供一条命令：`bash tools/english-training/setup.sh`。脚本内部负责：预检 → 用户确认 → 应用 KP 迁移 → 跑材料感知回填 → 测试 → 构建 → 复查 DB 计数 → 启动/提示用 `node dist/main.js` 验收；不得要求用户先记 dry-run、apply、scan 等多条命令。
- 学生账号路径：训练选科 → 英语 → 四卡页 → 真题考试（975/1008，交卷看分）→ 错题练习（确认英语题）→ 薄弱点图谱（确认节点可显示；允许无高可信推荐）→ 开始补这个（作答页仍是英语）→ 专项练习 → 背单词并返回专项配置。
- 验证 974：可开考；所有无答案题显示“无参考答案 · 不计分”；不自评、不计错、不写错题本、不出相似题入口。
- 验证 1008：有答案题正常判分；缺答案题与 974 同口径。
- 验证新卷路径：后续英语卷导入后能生成 qkp；答案后补时，下一次 `--answerable-only` 回填会把新增可练题纳入。

## 8. 风险与已知缺口

1. **LLM 打标质量**：结果不可完全复现；本期接受图谱短期不准确，但仍要求材料参与、失败清单可见、明显错标可修正。随着试卷增加逐步改善。
2. **974 / 1008 无答案**：按用户裁决“不判、无反馈”；唯一硬要求是不得误标为错题或主观待自评。
3. **图谱冷启动**：短期节点稀疏、`confidence` 多为 `insufficient/none`、暂无推荐是预期状态；不以准确率作为本期上线门槛。
4. **新增 API 契约**：无新路径，但考试结果新增 `method/hasStandardAnswer/unscoredCount`，知识图谱 `subjectId` enum 扩到 3；PRD/UX/API/openapi 必须同批更新。
5. **build 覆盖共享 dist**：跑 `npm run build` 后用户 dev server 可能加载当前分支，按记忆 `feedback_build_overwrites_shared_dist` 主动披露。
