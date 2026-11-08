# 语文「同类型练习」开放 — 设计 spec

**日期**：2026-11-08
**主题**：练习记录详情页对语文「基础运用 / 古诗文」类题开放「同类型练习」；阅读理解与写作不开放
**状态**：已实施（2026-11-08）
**关联**：PRD §6.4；API 文档 §4.29；前置 spec `2026-11-06-practice-history-quick-practice-design.md`

---

## 1. 背景

2026-11-08 用户交完语文卷（`exam_sessions` 78，「2026 海淀·要在学校 初三 期中」，27 题）后，练习记录详情只有「重做」，没有「同类型练习」。

根因：`canSimilar` 只放行数学(1)/物理(4)，语文(2)在 `practice-history.service.ts` 直接判 `false`；即使绕过前端调接口，`history-practice.service.ts` 也会以「该学科暂不支持同类型练习」拒绝。

用户裁决：**语文也开**，但只开「积累与运用 + 古诗文」，**排除现代文阅读与作文**（最主要场景是文言文）。

## 2. 目标

1. 语文套卷中归属「积累与运用(C01) / 古诗文(C02)」的题，详情页显示「同类型练习」。
2. 抽题只走题库；**不新增语文 AI 变式能力**。
3. 练习照常落 `special_practice_sessions` / `special_answer_records`，按语文专项档位 `cn_targeted` 发分。

## 3. 边界（本期不做）

- 现代文阅读(C03)、写作(C04) 的题：不显示按钮，接口直连 400。
- 语文三个古诗文专项（默写/翻译/含义）：作答单位是篇目/句子、没有 `question_id`，仍不支持重做与同类型。
- 语文 AI 补题（不新增变式 prompt / 模型路由）。
- 2 题档（语文沿用 1/3/5/10，本期不补 2 题档）。
- 判题口径不变：语文非客观题仍由学生对照参考答案自评。
- 无表结构变更、无数据迁移。

## 4. 数据现状（2026-11-08 实测）

- 语文在架题 613 道，**100% 挂知识点**；有标准答案 348 道。
- 严格口径（所有知识点都在 C01/C02 **且**有标准答案）可用池 **111 道**：`choice` 45 / `fill_blank` 50 / `short_answer` 16。
- 同时挂「阅读/写作」与「基础/古诗文」知识点的题 **158 道**，按严格口径排除。
- 知识点树（`2026-10-28_add_chinese_knowledge_points.sql`，code 固定）：

| 顶层 | code | id | 二级 |
|---|---|---|---|
| 积累与运用 | C01 | 80 | C0101–C0110（字词/成语/标点/病句/书法/对联/修辞/衔接/常识/名著） |
| 古诗文 | C02 | 81 | C0201–C0205（默写/古诗鉴赏/文言实词/断句翻译/古文内容理解） |
| 现代文阅读 | C03 | 82 | C0301–C0309 |
| 写作 | C04 | 83 | C0401–C0405 |

- 可用池最多的是：古诗文默写·填空 41、词语与成语·选择 18、文言实词与虚词·选择 11、古诗鉴赏·填空 11、古文内容理解·选择 9 / 填空 6、字词·选择 8、文言断句与翻译·选择 7。
- 语文专项档位（`point_rules` 现有数据）：`1 题 = 2 分`、`3 题 = 8 分`、`5 题 = 15 分`、`10 题 = 35 分`，**没有 2 题档**。

## 5. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 开放范围按**知识点所属顶层模块**判定，不按题型 | 阅读题也大量是选择/简答，按题型挡不住；用户明确排除阅读理解 |
| 2 | 一道题的**所有**知识点都在 C01/C02 才算可练 | 跨模块题多为阅读题被顺带打了基础标签；放宽会违背用户口径 |
| 3 | 种子知识点 = C01/C02 中 id 最小的 | 与现有「primary 中最小 id」口径一致；语文全部关联都是 primary |
| 4 | 不写语文 AI 变式，题库有多少出多少 | 语文阅读/文言变式质量风险高；用户选择「只出题库现有的」 |
| 5 | 档位沿用 `cn_targeted` 的 1/3/5 | 不改积分、不迁移；实际题数不足时按现有规则降档 |
| 6 | 判定放在后端，前端只读 `canSimilar` | 与数理一致；直连接口也挡得住 |

## 6. 判定口径（核心）

对一道语文题：

1. 取该题挂的**全部**知识点，每个知识点算出所属顶层模块 code：
   `rootCode = 父级.code ?? 自身.code`（二级取父级 C0x，顶层取自身 C0x）。
2. `allowed = 存在至少一个 rootCode ∈ {C01, C02}` **且** `不存在任何一个 rootCode ∉ {C01, C02}`（`code` 为 NULL 视为不通过）。
3. `canSimilar = canRedo && allowed`。**不要求种子题有标准答案**（与数理一致；抽到的新题都要求有答案）。
4. 种子知识点 `kpId` = allowed 知识点中 **id 最小**的一个。

数学/物理的判定与种子取法**完全不变**（`findKpIdsByQuestionIds` 的「primary 优先、再取最小 id」）。

## 7. 后端设计

### 7.1 常量真源

`apps/server/src/common/subject-config.ts` 新增：

```ts
/** 支持「同类型练习」的学科：数学、物理、语文（语文仅 C01/C02 知识点）。 */
export const SIMILAR_PRACTICE_SUBJECTS: ReadonlySet<number> =
  new Set([SUBJECT_MATH, SUBJECT_CHINESE, SUBJECT_PHYSICS]);

/** 语文同类型练习开放的顶层知识点 code（积累与运用 / 古诗文）。 */
export const CN_SIMILAR_KP_ROOTS: readonly string[] = ['C01', 'C02'];
```

前端 `apps/web/src/subjectConfig.ts` 同步导出 `SIMILAR_PRACTICE_SUBJECTS`（同一份学科名单，前端只用来决定「要不要去取档位」，业务判定仍看后端 `canSimilar`）。

### 7.2 `questions.repo.ts`

**新增** `findKpRefsByQuestionIds(questionIds)` → `Map<questionId, Array<{ id: number; rootCode: string | null }>>`

```sql
SELECT qkp.question_id, kp.id, COALESCE(pk.code, kp.code) AS root_code
FROM question_knowledge_points qkp
JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
LEFT JOIN knowledge_points pk ON pk.id = kp.parent_kp_id
WHERE qkp.question_id IN (...)
ORDER BY qkp.question_id, kp.id
```

- 空入参返回空 Map；一次批量查询，详情页每题复用。
- 与现有 `findKpIdsByQuestionIds` 并存，后者继续服务数学/物理（保持 primary 优先语义）。

**扩展** `findRandomByKpTypeDifficulty(..., opts?: { requireAllKpRootCodes?: string[] })`

- 不传 `opts` → SQL 与现在**完全一致**（`remediation-generator.service.ts` 等既有调用方零影响）。
- 传了 → 追加两段（参数全部走 `pool.query` 占位符）：

```sql
AND EXISTS (
  SELECT 1 FROM question_knowledge_points qkp2
  JOIN knowledge_points kp2 ON kp2.id = qkp2.knowledge_point_id
  LEFT JOIN knowledge_points pk2 ON pk2.id = kp2.parent_kp_id
  WHERE qkp2.question_id = q.id
    AND COALESCE(pk2.code, kp2.code) IN (?, ?)
)
AND NOT EXISTS (
  SELECT 1 FROM question_knowledge_points qkp3
  JOIN knowledge_points kp3 ON kp3.id = qkp3.knowledge_point_id
  LEFT JOIN knowledge_points pk3 ON pk3.id = kp3.parent_kp_id
  WHERE qkp3.question_id = q.id
    AND (COALESCE(pk3.code, kp3.code) IS NULL
         OR COALESCE(pk3.code, kp3.code) NOT IN (?, ?))
)
```

### 7.3 `practice-history.service.ts`（详情）

`getDetail` 的两个分支（exam / special）：

- 学科 ∈ {1,4}：维持 `kpMap.has(questionId)` 判 `canSimilar`。
- 学科 = 2：对整个会话的 `questionId` 调一次 `findKpRefsByQuestionIds`，按 §6 判 `allowed`；`canSimilar = canRedo && allowed`。
- 其余学科仍为 `false`。

### 7.4 `history-practice.service.ts`（`startSimilar`）

按顺序改动：

1. 学科白名单：`subjectId ∈ SIMILAR_PRACTICE_SUBJECTS`（1/2/4），否则 400「该学科暂不支持同类型练习」。
2. `count` 仍先校验 `∈ {1,2,3,5}`，再按学生该学科档位白名单校验（语文实际只放行 1/3/5）。
3. 语文(2) 的种子处理：
   - `findKpRefsByQuestionIds([seed.id])` → 按 §6 判 `allowed`；不通过 → 400「该题不在同类型练习范围（仅基础运用与古诗文）」。
   - `kpId` = allowed 中 id 最小的知识点；`kp` 不存在 → 400。
4. 抽题两次（同难度、难度阶梯 ±1）都带 `{ requireAllKpRootCodes: ['C01','C02'] }`（仅语文），保证候选题也不混阅读/写作。
5. 语文**跳过 AI 补题整段**（不实例化变式请求）；抽不满就用题库已有题。
6. 其余逻辑不变：`actual === 0` → `{ questions: [], sessionId: null, title: '同类练习：<kp> · 0 题' }`；`tier = {1,2,3,5} ∩ 学生档位 ∩ ≤ actual` 的最大值；建会话失败只 warn；标题「同类练习：<知识点名> · N 题」。

### 7.5 落记录的 `module`（顺带修一个缺陷）

`judgeTraining` 目前把非物理/化学的学科一律写成 `module='math_targeted'`，语文同类练习会落成「数学专项」身份。改动：

- `SpecialSessionModule` 联合类型加 `'cn_targeted'`。
- `judgeTraining` 的 module 映射只新增一条：`subjectId === 2 → 'cn_targeted'`；物理/化学/其它（含道法回落 `math_targeted`）**保持现状**，不顺手改道法。
- 现网无 `subject_id=2` 且 `module='math_targeted'` 的行（已核查），无需回填。练习记录列表只显示「专项」标签，本次改动不影响其它页面。

## 8. 前端设计

`apps/web/src/pages/student/PracticeHistoryDetailPage.tsx`：

1. 学科闸门从「数学/物理」改为 `SIMILAR_PRACTICE_SUBJECTS.has(subjectId)`。
2. 档位任务码不再写死三元表达式，改用 `getTrainingSubject(subjectId)?.targetedTaskCode`（数学 `math_targeted`、物理 `physics_targeted`、语文 `cn_targeted`）。
3. 档位仍是 `[1,2,3,5] ∩ 该任务码的启用档位`；语文自动得到 `[1,3,5]`（无 2 题档）。
4. 面板、loading、toast、跳转参数、`returnTo` 白名单全部不变。
5. 按钮显示仍只认后端 `canSimilar`，前端不按知识点自行推断。

## 9. 异常与边界

| 场景 | 行为 |
|---|---|
| 语文阅读/写作题（含跨模块题） | 不显示按钮；直连 `similar` → 400 |
| 种子题无知识点 / 已下架 / 学科不符 | 400（沿用现有文案） |
| 候选题混入 C03/C04 | SQL 排除，不会出现在本轮 |
| 抽到 0 题 | 2xx + `questions: []`、`sessionId: null`；前端 toast「暂时没有同类题」 |
| 实际题数 < 请求 | 照常进入答题页，按实际题数降档；2 道 → 1 题档（2 分） |
| 5 题档池不够 | 常见降到 1–3 题，属预期 |
| 语文专项（篇目/句子） | 无 `question_id`，不显示任何单题按钮 |

## 10. 测试计划

### 10.1 后端

- `questions.repo`：
  - `findKpRefsByQuestionIds` 返回每题全部知识点与 `rootCode`（顶层取自身 code、二级取父级 code）。
  - `findRandomByKpTypeDifficulty` 传 `requireAllKpRootCodes` 时排除混入 C03/C04 的题；不传时 SQL 行为不变（回归现有调用方）。
- `practice-history.service`：
  - 语文题只挂 C01/C02 → `canSimilar=true`；
  - 语文题混一个 C03、或只挂 C03 → `canSimilar=false`；
  - 数学/物理用例保持原断言。
- `history-practice.service`：
  - 语文种子合法 → 只出题库题、**不触发** `variation.generate`；
  - 语文种子是阅读题 → 400；
  - 抽满 3 → `tier_key='3'`；只抽到 2 → `tier_key='1'`；0 题 → 不建会话；
  - count=2（语文无此档）→ 400。
- `training.service`：语文判题落 `module='cn_targeted'`。

### 10.2 前端

- 语文详情（`canSimilar=true`）→ 显示按钮，档位面板只出现 1/3/5；
- `getMyPointRules` 取 `cn_targeted`（不是 `math_targeted`）；
- 点击后跳 `/student/training/targeted/run?subjectId=2&returnTo=...`；
- 数学/物理既有用例不变（仍取各自任务码、仍可出 2 题档）。

### 10.3 人工冒烟

1. 打开语文卷 session 78 详情：文言实词/断句/内容理解/默写/字词类题有按钮，现代文阅读与作文题没有。
2. 点「3 题」→ 答题 → 完成 → 回详情 → 练习记录多一条「同类练习：文言实词与虚词 · 3 题」。
3. 若某知识点只够 2 题 → 做 2 题、按 1 题档发 2 分。
4. 数学/物理详情的按钮、档位、发分与改动前一致。

## 11. 文档同步

- PRD §6.4：同类型练习覆盖范围由「本期开放数学、物理」改为「数学、物理、语文（语文仅积累与运用/古诗文，阅读与作文不开放，且不 AI 补题）」。
- `docs/API接口与数据流设计文档.md` §4.29：更新 `canSimilar` 口径与 `similar` 端点 400 条件、`task_code` 说明。
- `docs/api/openapi.yaml`：同步上述描述（字段结构不变）。
- `docs/ai-core-changelog.md`：记录本次开放与 `module='cn_targeted'` 修复。
- 本 spec。

## 12. 风险与已知限制

1. **池子薄**：111 道可用题分散在 20+ 个「知识点 × 题型」组合里，5 题档经常只能出 1–3 题。这是用户明确接受的取舍（不 AI 补题）。
2. **自评放水**：语文非客观题由学生自评，同类型练习因此可被「点对」拿分；与现有语文专项口径一致，不新增风险面。
3. **题面材料长**：文言文题自带材料，抽到另一篇短文时题面较长、需滚动阅读，属正常形态。
4. **对知识点 code 体系的依赖**：开放范围由「顶层 code = C01/C02」推断；若未来新增顶层分类或重构 code，需同步 `CN_SIMILAR_KP_ROOTS` 与用例。
5. **无 2 题档**：只抽到 2 题时按 1 题档发 2 分，激励偏弱；如后续要补，走 2026-11-06 的 2 题档迁移模式。
6. **语文难度标尺 1–5，抽题按 1–3 收敛**：现有 `toDifficulty` 把种子难度夹到 1–3，d4/d5 的语文种子首轮会按 d3 抽、难度阶梯也被压成 [3]；实测受影响候选 ≤3 道，本期不修（避免为一句话改动数学/物理共用路径）。
