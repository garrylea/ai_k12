# 训练轨新增物理 / 化学 / 道德与法治三学科

日期：2026-10-31
状态：待评审
关联模块：`apps/web/src/pages/student/training/`、`apps/server/src/modules/training/`、`apps/server/src/modules/exams/`、`apps/server/src/modules/knowledge-graph/`、`apps/server/src/modules/points/`

## 1. 背景与目标

用户在入口选择页的【训练】轨里，目前只能选数学、语文、英语三科。本次要把**物理（subject_id=4）、化学（5）、道德与法治（9）**接进训练轨，形态与数学/语文同构：**专项练习 / 真题考试 / 错题练习 / 薄弱点图谱** 四卡。

这三科在 `subjects` 表里本来就有行（`tools/db/schema.sql:113-122`），题库表、错题表、试卷表也都以 `subject_id` 为外键，天然支持任意学科。真正的障碍是**业务代码里的「语文 or 其它=数学」两套硬编码**：`parseSubjectId()` 只认 1/2/3，4/5/9 会被**静默当成数学**（`apps/web/src/constants.ts:39-42`，8 处调用）。

### 目标

1. 训练轨选科页出现六张卡，物理/化学/道法可进入，四卡与数学同构。
2. 学科差异收成**一张配置表**（前后端各一份），新增学科=加一行配置 + 一张卡。
3. 物理/化学/道法的非客观题**一律自评**，不落入写死 `subject:'math'` 的 AI 判题。
4. 物理/化学/道法各有**独立积分任务码**，家长端与流水不串到数学。
5. 不按年级过滤入口；不做主线、不做相似题套题、不补题库数据。

### 非目标（YAGNI）

- **主线轨道**不动：物理/化学/道法没有教材版本、单元、课程卡，`SubjectSelectPage`（主线选科）保持三科。
- **相似题专项练习（补偿套题）**不改：生成器与 `remediation.service.ts:238` 的 `MATH_SUBJECT_ID` 保持只服务数学，新学科训练首页不显示该提示条。
- **不补题库数据**：物理缺答案、化学缺知识点树、道法零题，本次只做代码与入口（见 §7）。
- 不按年级/学段门禁（本机 `students.grade` 口径不统一：`grade_3` / `七年级` / `初三` 混存，精确过滤需先统一年级口径）。
- 不改英语训练（目前只有背单词）。

## 2. 现状证据

### 2.1 数据就绪度（2026-10-31 实测本机库）

| 学科 | 题目 | 知识点 | 有答案 | 试卷（题数/无答案题数） |
|---|---|---|---|---|
| 数学 1 | 457 | 79 | — | 13 |
| 语文 2 | 798 | 33 | — | 33 |
| 物理 4 | 132 | 84 | **26** | 4 套：51（35/34 无答案）、52（33/33）、53（34/34）、54（34/8） |
| 化学 5 | 75 | **0** | 75 | 2 套：2（37/0）、3（38/0） |
| 道法 9 | 0 | 0 | 0 | 0 |

- 抽题池谓词要求 `answer <> ''` 且 `question_knowledge_points` 有行（`questions.repo.ts:120-127`），所以**物理专项实际只有 26 道可抽**；化学 0 个知识点 → 专项页选不出考点。
- 物理答案缺失在 `docs/superpowers/specs/2026-10-30-subject-strategy-refactor-design.md:203` 已有书面记录，属数据任务，不在本次范围。
- 物理知识点树结构正常（12 个根 + 72 个子），与数学同形，专项页的一级/二级级联可用。

### 2.2 代码硬编码清单

| 位置 | 现状 |
|---|---|
| `apps/web/src/constants.ts:11` | `SubjectId` 只含 1/2/3 |
| `apps/web/src/constants.ts:25-29` | `subjectName()` 非语文/英语一律「数学」 |
| `apps/web/src/constants.ts:32-36` | `subjectHomePath()` 非语文回数学四卡页 |
| `apps/web/src/constants.ts:39-42` | `parseSubjectId()` 非 1/2/3 回落数学（8 处调用） |
| `apps/web/src/pages/student/TrainingSubjectPage.tsx:12-16,38-48` | 三张卡本地数组 + 跳转 if/else |
| `apps/web/src/pages/student/training/TrainingHomePage.tsx:7,144` | 标题写「数学 · 训练」、错题数固定 `subjectId=1`、四卡链接不带参 |
| `apps/web/src/pages/student/training/TargetedConfigPage.tsx:161-162,186` | 题型下拉两套（`CN_TYPE_OPTIONS` / `MATH_TYPE_OPTIONS`）、任务码两分支 |
| `apps/web/src/pages/student/training/WeakPointGraphPage.tsx:18,144` | 固定 `MATH_SUBJECT_ID` |
| `apps/server/src/modules/training/training.controller.ts:168` | `subjectId===2 ? 'cn_targeted' : 'math_targeted'` |
| `apps/server/src/modules/training/training.service.ts:689` | 同上（建会话） |
| `apps/server/src/modules/exams/exams.service.ts:37` | `shouldSelfAssess`：只有语文非客观题自评 |
| `apps/server/src/modules/exams/exams.service.ts:414` | `subjectId===2 ? 'cn_paper' : 'math_paper'` |
| `apps/server/src/modules/practice/judge-core.service.ts:137-139` | `isChineseNonObjective()` 只认 `subject_id===2` |
| `apps/server/src/modules/exams/exams.service.ts:332-344` | 交卷未作答按错计 + 写错题本，**不看该题有没有参考答案** |
| `apps/web/src/components/business/answer/QuestionRunner.tsx:241` | 内联自评闸门写死 `type === 'short_answer' \|\| 'proof'` |
| `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts:81-85` | `assertMathSubject()`：非 1 直接 400 + 1001 |
| `apps/server/src/modules/points/default-rules.ts:11-62` | 任务码只有 math/cn 两套 |

## 3. 设计

### 3.1 学科配置表（方案 A）

**前端** 新增 `apps/web/src/subjectConfig.ts`，作为训练轨「学科差异」的唯一真源：

```ts
export interface TrainingSubjectConfig {
  id: number;
  name: string;                        // 卡片与标题文案
  desc: string;                        // 选科卡副标题
  /** 选科页是否可点。false 时渲染既有 disabled 卡 + 角标文案。 */
  enabled: boolean;
  /** 该学科在训练轨的落地页（含 query）。语文/英语为各自专项页。 */
  homePath: string;
  /** 专项配置页的题型下拉；空串 = 全部。 */
  typeOptions: ReadonlyArray<{ value: string; label: string }>;
  /** 专项练习任务码（档位/发分用）；英语无专项练习，缺省。 */
  targetedTaskCode?: string;
  /** 理科：作答区用 LaTeX 输入 + 预览（复用 isMathLikeSubject 的语义）。 */
  isMathLike: boolean;
}
```

初始内容：

| id | name | desc（卡片副标题） | enabled | homePath | typeOptions | targetedTaskCode | isMathLike |
|---|---|---|---|---|---|---|---|
| 1 | 数学 | 考试 / 专项练习 / 错题练习 | true | `/student/training/home?subjectId=1` | 现有 `MATH_TYPE_OPTIONS` | `math_targeted` | true |
| 2 | 语文 | 真题考试 / 专项练习 / 古诗文专项 | true | `/student/training/chinese/special` | `CN_TYPE_OPTIONS` | `cn_targeted` | false |
| 3 | 英语 | 背单词 | true | `/student/training/english/vocabulary` | 不适用 | 无 | false |
| 4 | 物理 | 考试 / 专项练习 / 错题练习 | true | `/student/training/home?subjectId=4` | 全部/选择/填空/简答/计算 | `physics_targeted` | true |
| 5 | 化学 | 考试 / 专项练习 / 错题练习 | true | `/student/training/home?subjectId=5` | 全部/选择/填空/简答 | `chemistry_targeted` | true |
| 9 | 道德与法治 | 内容准备中 | false | `/student/training/home?subjectId=9` | 全部/选择/填空/简答 | `politics_targeted` | false |

- `constants.ts` 的 `parseSubjectId` 白名单扩到 `1|2|3|4|5|9`；**缺省与未知值仍回落数学**（保持现有链接兼容），但不再把 4/5/9 当成数学。`SubjectId` 联合类型同步扩为这六个值。
- `subjectConfig.ts` 另导出 `selfAssessEligible(subjectId, type)`（对应 §3.5 闸门 ③）：数学 `short_answer`/`proof`；非数学学科一切非 `choice`/`true_false`。`QuestionRunner.tsx:241` 改用它，**数学分支与今天逐字等价**，语文填空顺带修好。
- `subjectName` / `subjectHomePath` 改为查表；表外学科仍按原口径回落数学，行为不变。
- `isMathLikeSubject` 改为读配置（4/5 为 true，9 为 false），`QuestionRunner` 的 LaTeX 作答区不动。

**后端** 新增 `apps/server/src/common/subject-config.ts`：

```ts
export const TARGETED_TASK_CODE: Readonly<Record<number, string>>;  // 1/2/4/5/9
export const PAPER_TASK_CODE: Readonly<Record<number, string>>;     // 1/2/4/5/9
/** 非客观题一律自评的学科：语文(2) + 物理(4) + 化学(5) + 道法(9)。 */
export const SELF_ASSESS_SUBJECTS: ReadonlySet<number>;
export function targetedTaskCode(subjectId: number): string;  // 表外回落 math_targeted
export function paperTaskCode(subjectId: number): string;     // 表外回落 math_paper
export function isSelfAssessSubject(subjectId: number): boolean;
/** 闸门 ①：考试侧「跳过判题直接自评」。语文=非客观；新学科=short_answer/proof。 */
export function selfAssessSkipsJudging(subjectId: number, type: string): boolean;
```

`exams.service.ts` 现有导出 `shouldSelfAssess` **保留签名与导出位置**（测试直接 import 它），内部改为委托 `selfAssessSkipsJudging`。

表外回落是**有意保留**：6/7/8（生物/历史/地理）尚无入口，不为其建配置；但入口一旦误开，行为与今天一致（数学口径），不会 500。

### 3.2 选科页与路由

`TrainingSubjectPage` 改为遍历配置表渲染**全部六项**，`enabled` 只决定「可点 / 灰卡」：

- 六张卡，顺序 1/2/3/4/5/9，网格沿用 `md:grid-cols-3` 排成两行三列，卡片尺寸与交互不变。
- 物理/化学 → `navigate('/student/training/home?subjectId=4|5')`。
- 道法 → `enabled: false`，复用页面内既有的 disabled 卡分支（`TrainingSubjectPage.tsx:102-130`，含灰底、`cursor-not-allowed`、角标），角标文案由「敬请期待」改为配置里的 `badge`（「内容准备中」）。开启只需把 `enabled` 改成 `true`。
- 进入四卡页后再返回，`BackButton` 仍回 `/student/training`，不带学科参数（无状态页）。

路由不新增：四卡页与四个子功能页都复用现有路径，只多带 `?subjectId=`。

### 3.3 训练首页参数化

`TrainingHomePage`：

1. 读 `useSearchParams().get('subjectId')`，经 `parseSubjectId` 得到 id；`subjectName(id)` 拼标题 `${name} · 训练`。
2. 错题数请求改 `getTrainingErrorBook({ subjectId: id })`。
3. 四卡跳转带上查询串：
   - 专项 `/student/training/targeted?subjectId=<id>`
   - 考试 `/student/training/exam?subjectId=<id>`
   - 错题 `/student/training/errors?subjectId=<id>`
   - 图谱 `/student/training/weak-points?subjectId=<id>`
4. 「相似题专项练习待完成」提示条与 `getRemediationOverview()` 请求**只在 `id === 1` 时执行**（新学科不发请求、不渲染提示条）。
5. 无 `subjectId` 的旧链接行为不变（默认数学）。

### 3.4 四个入口在新学科下的行为

| 入口 | 行为 | 依赖的既有能力 |
|---|---|---|
| 专项练习 | 知识点树按学科拉取（`GET /api/training/knowledge-points?subjectId=4`）；题型下拉读配置；档位读该学科任务码；开练、判题、完成发分全复用 | `knowledge-points.repo.findBySubject`、`questions.repo.findRandomByKpAndType`、`training_sessions` |
| 真题考试 | 试卷列表按学科过滤（`GET /api/exams/papers?subjectId=4`）；交卷发该学科 `*_paper` 分；非客观题自评 | `exam_papers.subject_id`、`shouldSelfAssess` |
| 错题练习 | `GET /api/training/error-book?subjectId=` 取该学科未清零错题 | `main_error_books.student_id + subject_id` |
| 薄弱点图谱 | `GET /api/knowledge-graph/students/:id/weak-points?subjectId=4`；门禁放宽（§3.6） | 服务层已按 `subjectId` 通用 |

空态由各页既有实现承担（考点 0 题置灰「暂无题目」、试卷列表空、错题空、图谱空）。**不新增大面积「内容准备中」文案**（界面优先于文字提示）。

### 3.5 判题口径

判题链路上有**三道闸门**，语义不同，不能合并成一个判断：

| 闸门 | 位置 | 作用 | 口径 |
|---|---|---|---|
| ① 考试跳过判题 | `exams.service.ts:36` `shouldSelfAssess` | 为 true 时**根本不调 JudgeCore**，直接落 `is_correct=NULL, method='self_assess'` | 语文：非客观题（不变）；物理/化学/道法：**仅 `short_answer` / `proof`** |
| ② 判题兜底自评 | `judge-core.service.ts:137` `isChineseNonObjective` → `isSelfAssessNonObjective` | 归一化比对失败后的兜底 | 语文：非客观题；物理/化学/道法：非客观题（含填空/计算不等时） |
| ③ 前端内联自评 UI | `QuestionRunner.tsx:241` | 决定「同步等判题并弹自评视图」还是「fire-and-forget 直接下一题」 | 抽成 `selfAssessEligible(subjectId, type)`（见 §3.1）：数学 `short_answer`/`proof`（**与今天完全一致**）；非数学学科一切非 `choice`/`true_false` |

**为什么 ① 必须比 ② 窄**：`exams.service.ts:214,318` 是先问 ① 再决定要不要调判题。若 ① 对 `fill_blank`/`calculation` 也返回 true，化学填空就永远走不到「归一化相等判对」——而化学是唯一答案完整、真正能考的内容。① 只放真正主观的 `short_answer`/`proof`，`fill_blank`/`calculation` 一律进 JudgeCore 走 ②。

**为什么 ③ 必须同步改**：不在 ③ 名单里的题型，服务端即使返回 `needsSelfAssessment: true`，前端也会把结果记成 `isCorrect: res.isCorrect ?? false`（`QuestionRunner.tsx:287`），学生看到「错」且没有自评入口。语文 `fill_blank` 今天就是这个状态（语文填空服务端返回自评、前端不弹），本次顺带修好；数学保持 fire-and-forget 不变。

`judgeQuestion`（训练/考试共用入口）的分支顺序：

1. 空答案守卫 → `unanswered`（现有 `judge-core.service.ts:257-262`，物理 106 道空答案题不会被误判错）。
2. `choice` / `true_false` → 精确比对（`compareAnswer`，优先 `options.isCorrect`）。
3. **新增**：`subjectId ∈ {4,5,9}` 且 `type ∈ {fill_blank, calculation}` 且 `compareAnswer` 相等 → `exact` 判对。
4. ② 命中（语文 + 新学科的非客观题）→ `self_assess`，返回 `needsSelfAssessment` + 参考答案/解析。
5. 现有：`fill_blank`/`calculation` 归一化相等 → `exact`（数学路径，行为不变）。
6. 现有：`SUBJECTIVE_TYPES` + `JUDGE_SUBJECTIVE_MODE=self_assess` → `self_assess`。
7. 其余 → AI 判定。

顺序调整只影响 4/5/9：语文仍在第 4 步自评（填空不被第 3 步抢走，第 3 步限定 4/5/9）；数学不进第 3 步，第 5/6/7 步与今天一字不差。**不变量：新学科的任何题型都不会调用 `JudgmentCapability`**（写死 `subject:'math'` 的 AI 判题对新学科不可达）。

`judgeForPractice`（主线课程路径）不改：已核对调用面，主线只跑数学课程，新学科不经过该路径。

**交卷口径（无参考答案的题）**：`finalizeSession` 的「未作答按错计」保持不变（`is_correct=0`），但**只有 `q.answer` 非空时才写错题本**。否则物理 51/52/53 号卷（分别 34/33/34 道无答案题）会在交卷时往错题本灌入大量条目，而错题练习再遇到它们走空答案守卫、既不自评也不清零 —— 学生在 App 里永远清不掉。数学卷题都有答案，行为不变。

> 附带行为（可接受）：化学/物理的 `fill_blank`/`calculation` 若在作答时已因「不等」落成 `self_assess`（`is_correct=NULL`），交卷补判会再走一次 JudgeCore（闸门 ① 不拦它们）。判题幂等、无错题本副作用，仅多一次调用。

### 3.6 薄弱点图谱门禁

`knowledge-graph.controller.ts:81-85` 的 `assertMathSubject` 改为 `assertSupportedSubject`：`subjectId ∈ {1,4,5,9}` 放行，其它仍 400 + 1001（错误文案改为「subjectId 仅支持 1 / 4 / 5 / 9」）。服务层无需改动（`getMastery` / `getWeakPoints` 已全参数化）。

### 3.7 积分

新增任务码（与数学同档同价，独立计数）：

| taskCode | taskName | 档位 | 每日上限 | sortOrder |
|---|---|---|---|---|
| `physics_paper` | 物理卷子一套 | default / 50 分 | 不限 | 26 |
| `chemistry_paper` | 化学卷子一套 | default / 50 分 | 不限 | 27 |
| `politics_paper` | 道法卷子一套 | default / 50 分 | 不限 | 28 |
| `physics_targeted` | 物理专项 | 1→2 / 3→8 / 5→15 / 10→35 | 5 | 100–103 |
| `chemistry_targeted` | 化学专项 | 同上 | 5 | 110–113 |
| `politics_targeted` | 道法专项 | 同上 | 5 | 120–123 |

- `TASK_NAMES` 补 6 条；`DEFAULT_RULES` 补 15 行。
- 规则是**懒初始化**（`PointRulesService.ensureRules` 按 `(task_code, tier_key)` 补缺、不覆盖家长改过的值），存量学生首次读取时自动补齐，**零迁移**。
- `training.controller.ts:168` 与 `training.service.ts:689` 改用 `targetedTaskCode(subjectId)`；`exams.service.ts:414` 改用 `paperTaskCode(subjectId)`。
- 前端 `TargetedConfigPage` 的 `CN_TASK_CODE`/`MATH_TASK_CODE` 两分支改为 `subjectConfig.targetedTaskCode`。
- `default-rules.test.ts` 的条数断言（23 → 38）与快照需同步更新。

### 3.8 埋点

不改白名单：`analytics/sceneMap.ts` 与 `study-sessions.service.ts` 的 module/scene 是功能维度（`training_targeted` / `exam`），`subject_id` 已独立落库。新学科的学习时长、答题事件自动带 `subject_id` 进库，家长端与运营报表无需改代码。

### 3.9 错误处理

| 场景 | 行为 |
|---|---|
| 选科页收到表外 `subjectId`（6/7/8） | `parseSubjectId` 回落数学（现状），不改 |
| 训练首页请求错题数失败 | 保持现有「未清零 -- 题」，不阻塞导航 |
| 学科无知识点（化学/道法） | 专项页显示空考点列表；开练不可点（既有空态） |
| 学科无试卷（道法） | 试卷列表空态 |
| 学科题目全空答案（物理 3 套卷） | 判题返回 `unanswered`（不计对错、不进错题本、不生成解析） |
| 交卷时未作答且该题无参考答案 | 记 `is_correct=0` 计入卷面（与未作答同口径），但**不写错题本**——否则生成 App 内永久清不掉的错题 |
| 积分规则缺失（家长手动下架全部档位） | 既有「档位加载失败/停用」空态 |
| 图谱学科不支持 | 400 + 1001（仅 6/7/8 可达） |

## 4. 文档同步

按 CLAUDE.md 的 API 双文档规则与「改口径要点名旧表述」：

1. `docs/API接口与数据流设计文档.md`
   - §5 弱科图谱端点：`subjectId` 允许值 1 → `1/4/5/9`。
   - §5 考试交卷（约 :1428）：补「无参考答案的题未作答不计入错题本」与「语文外的自评学科（物理/化学/道法）非客观题自评」。
   - 训练轨积分段落：补 6 个新任务码及「新学科非客观题自评」口径。
   - 明确点掉「其余学科沿用数学码」「subjectId 仅支持 1（数学）」两处旧表述。
2. `docs/api/openapi.yaml`：`weak-points` / `mastery` 的 `subjectId` 参数描述同步。
3. `docs/K12智学系统-产品需求文档.md` §7.13 积分表：补 6 行（PRD 是唯一真源，新增任务码必须进去）。
4. `docs/UX-UI设计文档.md`：训练选科页六卡与「内容准备中」角标；专项配置页题型按学科裁剪说明。
5. `docs/constraints/专项子系统.md`：补一段「题库类训练（专项/考试/错题/图谱）按学科参数化，学科差异集中在前后端各一份配置表；新增学科不要在各页加 `if subject ===`」。

## 5. 测试

### 后端（vitest）

| 文件 | 用例 |
|---|---|
| 新增 `subject-config.test.ts` | 三个映射表的 1/2/4/5/9 取值；表外回落（6 → math_*）；`isSelfAssessSubject(4/5/9) === true`、`(1/3) === false` |
| `exams.service.test.ts` | 物理 `short_answer` → `shouldSelfAssess === true`；**化学 `fill_blank` → `shouldSelfAssess === false`（必须进 JudgeCore 判）**；数学 `short_answer` 行为不变；交卷发分任务码 4 → `physics_paper`、5 → `chemistry_paper`、9 → `politics_paper`、1 → `math_paper`；交卷时「无答案题未作答」不入错题本、「有答案题未作答」仍入 |
| `judge-core.service.test.ts` | 化学 `fill_blank` 归一化相等 → `method='exact', isCorrect=true`（不进自评）；不等 → `method='self_assess'`；物理 `calculation` 同上；语文 `fill_blank` 仍 `self_assess`（回归钉子）；空答案 → `unanswered`；**不变量：4/5/9 任意题型都不调用 `JudgmentCapability.judge`** |
| `training.controller.test.ts` | `targeted/start` subjectId=4 校验档位走 `physics_targeted`；建档 `task_code='physics_targeted'`、`subject_id=4` |
| `knowledge-graph.controller.test.ts` | 现有「非 1 → 400」用例改成 6 → 400；1/4/5/9 放行并透传 |
| `default-rules.test.ts` | 条数 23 → 38；新码唯一性/排序断言；快照更新 |

### 前端（vitest + Testing Library）

| 文件 | 用例 |
|---|---|
| `TrainingSubjectPage.test.tsx`（新增） | 渲染六卡；道法卡 `aria-label` 含「内容准备中」且不可点；物理点击跳 `/student/training/home?subjectId=4` |
| `TrainingHomePage.test.tsx` | 带 `?subjectId=4`：标题「物理 · 训练」、错题数请求 `subjectId=4`、四个入口链接均带参、**不请求** `getRemediationOverview`；不带参：标题「数学 · 训练」、提示条逻辑不变 |
| `constants.test.ts`（若无则新增） | `parseSubjectId('4'|'5'|'9')` 原样返回；`'6'`/`null` 回落 1；`subjectName(4/5/9)`；`subjectHomePath(4)` 带参 |
| `TargetedConfigPage.test.tsx` | subjectId=4 时题型下拉为物理五档、档位请求 `physics_targeted`；subjectId=5 时四档、`chemistry_targeted` |
| `WeakPointGraphPage.test.tsx` | 带 `?subjectId=4` 时请求带该学科 |
| `QuestionRunner.test.tsx` | 化学 `fill_blank` / 物理 `calculation` 返回 `needsSelfAssessment` 时进入自评视图（提交后调 `onSelfAssess` 落库）；**数学 `fill_blank` 仍走 fire-and-forget（回归钉子）** |

### 手工冒烟（交付前）

1. 物理：选科 → 四卡页 → 专项（选知识点/题型/档位，开练并作答）→ 考试（54 号卷有答案）→ 错题 → 图谱。
2. 化学：考试 2 套卷之一完整作答并交卷，检查自评、发分到「化学卷子一套」。
3. 道法：卡片不可点、角标正确；直接手输 URL `?subjectId=9` 时四卡均显示空态、不报错。
4. 数学/语文/英语回归：三卡入口、专项任务码、语文填空仍自评。
5. 家长端：完成一次物理专项后，仪表盘出现「物理」、积分页出现「物理专项」分组。

## 6. 风险与回退

| 风险 | 应对 |
|---|---|
| 分支顺序调整误伤语文填空判题 | 保留「语文 `fill_blank` 仍自评」的回归测试；新分支只对 4/5/9 生效 |
| 4/5/9 被误当数学的旧路径残留 | `grep -rn "subjectId) === 2" apps/server/src` 逐个核对（应只剩语文专属判断，改为查表）；`parseSubjectId` 调用点逐处确认透传；加配置表单测 |
| 存量学生没有新任务码规则 | 懒初始化自动补；用例覆盖「首次读取补齐」 |
| 物理内容几乎为空被当成 bug | 交付说明写明数据就绪度与 §7 的后续项 |
| 家长端因新学科出现意外分组 | `goals.service` 只对 chinese/english 特化，物理走通用模板；仪表盘只在有 `progress` 行时出现 |

## 7. 本次不做、但需排期的数据项

1. **物理答案回填**：39 张卷 / 132 题中仅 26 题有答案（`answer_extract_cli` + `answer_importer`），决定物理专项与考试的真实可用性。
2. **化学知识点树**：75 题全无 KP 标注，专项与图谱无内容；需建化学 KP 树并跑 `backfill_question_kps.py`。
3. **道法题库**：0 题；需先有素材与学科策略（数据管线的 `subject_strategies/politics.py` 已存在）。
4. **道法入口开启**：数据入库后把 `subjectConfig` 里 `enabled` 改为 `true`。

## 8. 验收标准

- [ ] 训练选科页六卡；道法不可点且显示「内容准备中」。
- [ ] 物理/化学四卡可用，标题、错题数、四个入口链接均带正确 `subjectId`。
- [ ] 数学入口不显示相似题提示条的回归未被破坏（数学仍显示）。
- [ ] 化学填空等值答案判对（`exact`），不等转自评；语文填空仍自评；数学填空仍走 AI 判定（三条回归钉子都在）。
- [ ] 新学科任意题型都不会触发 AI 判题（`JudgmentCapability` 不被调用）。
- [ ] 物理 51/52/53 号卷交卷后错题本不新增条目；有答案卷的未作答照旧入错题本。
- [ ] 物理/化学/道法专项完成发分到各自任务码；家长端可见独立分组。
- [ ] 图谱对 1/4/5/9 放行，6/7/8 仍 400 + 1001。
- [ ] 全量 `npm test`（server + web）通过；`npm run build` 通过。
- [ ] 五份文档（API / openapi / PRD / UX-UI / constraints）已同步，旧表述已点掉。
