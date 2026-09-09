# 判题体系重构：分层判题 + 答案离线补全 + 主观题学生自评

- 日期：2026-09-09
- 状态：设计已与用户逐节确认
- 关联文档：`docs/superpowers/specs/2026-09-08-question-explanation-cache-design.md`（解析缓存，本设计将其降级为兜底）、`docs/K12智学系统-数据库设计文档.md`、`docs/API接口与数据流设计文档.md`

## 1. 背景与问题

现行判题体系建立在「AI 判题可信」的假设上：short_answer/proof 逐题调 JudgmentCapability 判对错，判错后由 ExplanationCacheService 后台生成解析补全题库。实测发现国产模型判题准确率低（国外模型国内访问不便），该假设不成立，导致：

1. 主观题对错判定不可信，错题本收录与「错题清零」门禁建立在不可靠判定上；
2. 依赖判题触发的在线解析补全，源头答案不可信，补了也没用。

题库现状（2026-09-09 实测，共 547 题）：

| 题型 | 题数 | 空答案 | 无解析 |
|---|---|---|---|
| short_answer | 166 | 66 | 143 |
| choice | 164 | 50 | 150 |
| fill_blank | 123 | 50 | 117 |
| proof | 44 | 22 | 41 |
| true_false | 0 | — | — |

34% 的题（188 道）`answer` 为空——judgment prompt 的「标准答案（参考）」为空，模型被迫自己解题再判，这是判题准确率低的重要原因之一；82% 的题无解析。

另两个关键事实：

- `JudgeCoreService` 已是三路由分层判题（choice/true_false 程序比对；fill_blank 归一化比对 + AI 兜底；short_answer/proof 走 AI），本设计在其上改造而非重写；
- judgment prompt 已将 `questions.answer` 作为标准答案传给模型（`apps/server/src/ai-core/prompts/judgment/math-calculation.md`），即 AI 判题本来就是「对照标准答案判」，不是「自己解题再判」。

## 2. 目标与非目标

**目标**

1. 答案/解析通过「人工 + AI」离线补全，建立补全数据格式与导入工具；
2. 分层判题：客观题程序判、结果题（fill_blank/calculation）AI 只判等价、主观题（short_answer/proof）现阶段学生自评对错；
3. 保留现有 AI 判题主观题的逻辑，配置开关可切回（待国产模型能力提升后）；
4. 新增 calculation 题型，从 short_answer 中拆出结果型计算题。

**非目标**

- 不做 admin Web 题目管理界面（后续待办）；
- 不删除/重写 JudgmentCapability、ExplanationCacheService；
- 不做 AI 抽取学生「解题思路」与参考思路比对的判题方式（已评估：等价性判断不可靠、两步 LLM 误差复合、与现有 judgment 同类任务，不降低难度）；
- true_false 当前无题，机制保留即可。

## 3. 总体架构

| 题型 | 来源 | 判题方式 | 改动 |
|---|---|---|---|
| choice | 现有 | 程序比对（学生选项 vs `questions.answer`） | 不动 |
| true_false | 现有类型（暂无题） | 程序比对 | 不动 |
| fill_blank | 现有 | 归一化比对；不等 → 学生回答 + 标准答案交 AI 判等价 | 不动（现状即此逻辑） |
| calculation | **新增类型**，从 short_answer 拆出 | 同 fill_blank：归一化比对 + AI 等价判断 | 新增 |
| short_answer（拆剩的解答/问答题） | 现有 | 开关 `JUDGE_SUBJECTIVE_MODE` 控制 | 改造重点 |
| proof | 现有 | 同 short_answer | 改造重点 |

```
JUDGE_SUBJECTIVE_MODE = self_assess（默认，本设计实现）| ai（现有逻辑，原样保留备用）
```

开关只作用于主观题（short_answer/proof）分支。数据模型做成两模式超集：

- `exam_answers.is_correct` 本就允许 NULL：self_assess 模式主观题存 NULL，ai 模式存 AI 判定，同表两种模式数据互不破坏；
- 自评数据存独立表，ai 模式下为空；
- 错题清零门禁统一为「判对 或 自评对 即清零」，两种模式共用；
- 结果页渲染规则单一：`isCorrect` 有值显示对错，无值显示参考答案 + 解析 + 自评 UI。

为什么 fill_blank/calculation 的 AI 判断不挂开关：那是「拿着标准答案判等价」（0.5 vs 1/2、x=3 vs 3），不是自己解题，有参考答案时可靠得多；且大部分情况归一化比对在程序层完成，AI 只兜底边缘等价形式。真正吃模型能力的是证明/解答的过程核验，所以开关只管这两类。

## 4. 答案补全：文档格式与导入工具

### 4.1 用户侧答案文档格式

每份试卷一个 Markdown 文件，按题号写答案和解析，不涉及库内 ID/题型等细节：

```markdown
# 试卷：2018年某省中考数学试卷
<!-- 试卷标识：能唯一定位到这份卷子即可（试卷名/文件名/来源任选） -->

## 1
答案：B
解析：由二次函数顶点式 $y=(x-2)^2+3$ 可知顶点为 $(2,3)$……

## 2
答案：$x=3$ 或 $x=-1$
解析：因式分解 $(x-3)(x+1)=0$……

## 17
答案：（解答题时写参考解答全文或关键步骤 + 最终结果）
解析：本题考查……解题思路是……（解析同时包含答题思路与完整过程，不拆字段）
题型：calculation   <!-- 可选：仅当该题需要从 short_answer 改标为 calculation 时写 -->
```

规则：

1. 每题必写「答案」；「解析」尽量写，没有留空；
2. 「题型」可选——默认不改库内题型，仅解答/计算归属需调整的题标注 `题型：calculation` 或 `题型：short_answer`；
3. 数学公式用 `$...$` LaTeX，与现有渲染一致。

### 4.2 导入工具（data-refinery 新增 CLI：`answer_importer`）

四步流程，匹配歧义由工具报告，用户只在确认环节出现：

1. **定位试卷**：按试卷标识匹配 `exam_papers`（source_key）或该卷题目集合；对不上时列出候选试卷供选择；
2. **匹配题目**：题号 → 该卷题目集合（大题拆小问按 `group_id`/题面相似度匹配）；匹配不上或疑似错位的输出报告，不写入；
3. **dry-run 预览**：列出将更新的题目清单（旧答案 → 新答案 diff、题型改写标记），用户确认后才执行；首批先拿几题验证再放量（遵循「LLM/人工数据入库先小批验证」约定）；
4. **回写**：更新 `questions.answer` / `explanation` / `type`；导入批次打「人工核验」标记（`source` 加后缀或新增标记字段），与管线提取的原始数据区分。

### 4.3 匹配职责

用户只提供「哪张卷、每题答案是什么」；试卷定位、题目匹配、歧义报告由工具完成（必要时在 Claude Code 会话中人工确认）。

## 5. calculation 题型落地

- **DB**：`type` 为 VARCHAR 无约束，不改 schema；存量 166 道 short_answer 的拆分由导入工具按文档标注回写；
- **服务端**：`training.controller.ts` 的 `TARGETED_TYPES` 加 `calculation`；
- **前端**：专项训练类型选择 UI 加「计算」分类；题型标签组件加 calculation 显示名「计算」；
- **data-refinery**：`question_labeler.py` 的 `_VALID_TYPES` 加 `calculation`；标注 prompt 同步加判定规则（答案为简短最终结果的计算题 → calculation；过程/论述 → short_answer）；
- **判题 prompt**：`judgment/math-calculation.md` 微调措辞，明确「学生答案与标准答案等价即对，解法不必相同」。

## 6. 运行时判题改造

### 6.1 路由（`judge-core.service.ts` 题中心版与卡中心版同步改）

```
choice / true_false       → 程序比对（不动）
fill_blank / calculation  → 归一化比对 → 不等走 AI 等价判断（calculation 并入 fill_blank 分支）
short_answer / proof      → 读 JUDGE_SUBJECTIVE_MODE：
    self_assess（默认）→ 不调 AI，返回 isCorrect=null、needsSelfAssessment=true
    ai                  → 现有 JudgmentCapability 逻辑原样走
```

### 6.2 契约扩展

- `JudgeResult` 增加 `needsSelfAssessment?: boolean`（前端据此渲染自评 UI）；
- `method` 枚举新增 `self_assess`（现有 exact | ai | unanswered | failed）。

### 6.3 空答案守卫

补全完成前 188 道空答案题仍在题库：

- 抽题（专项训练/考试组卷/错题练习）SQL 过滤 `answer=''`；
- 课堂练习卡中心遇到空答案的 choice/true_false/fill_blank/calculation：判题返回「该题暂无标准答案，不计入对错」，不报错、不污染错题本。

## 7. 主观题学生自评

### 7.1 触发时机

- **专项训练 / 错题练习 / 课堂练习**：提交后当场自评——判题返回 `needsSelfAssessment=true`，页面展开「参考答案 + 解析」，按钮「我做对了」「我做错了」；按钮上方引导文案：「对照参考答案，你刚才的作答是对的（过程/结论与参考一致）还是错的（思路或结果有误）？」；
- **考试**：作答阶段不展示任何东西，交卷后结果页逐题展开「参考答案 + 解析 + 自评」。

「做对了没有」是事实判断（参考答案在眼前），比「掌握了没有」的自称式评估撒谎空间小、判据具体，故按钮用对错措辞而非掌握措辞。

### 7.2 数据流

```
学生点「我做对了 / 我做错了」
  → POST /api/training/self-assess { questionId, assessment: 'correct' | 'incorrect', source }
  → 写 question_self_assessments（新表）
  → 'incorrect' → main_error_books find-or-create（与现在答错入本同一条路）
  → 'correct'   → 清零该题未清错题（与现在答对清零同一条路）
```

- **新表 `question_self_assessments`**：`id, student_id, question_id, assessment ('correct'|'incorrect'), source ('targeted'|'error_practice'|'exam'|'practice'), created_at`；每次自评留痕（训练模块现状不落逐题作答，错题本只存 question_id 不足以回溯），并为学情分析/「学生自评 vs AI 判定一致率」留数据；
- **错题本与清零门禁零改动**：主观题错题与客观题错题在 `main_error_books` 形态一致，门禁继续数未清错题，主观题的清零来自重做后自评「correct」。

### 7.3 强制自评（不自评不能跳过）

- 专项训练/错题练习/课堂练习：「下一题」按钮在未自评时置灰，点击 toast「请先对照参考答案，自评这道题做得对不对」；
- 考试结果页：顶部常驻「还有 N 题未自评」，未自评题有醒目标记，自评完消失；状态已落库，重进结果页继续提示。

### 7.4 ai 模式兼容

切回 AI 判题后 `needsSelfAssessment` 不再返回，结果页回归对错展示；自评接口与表保留不动（历史数据不破坏），只是不再触发。

## 8. 考试模式

- 作答阶段：主观题提交只落在途行（`is_correct=NULL`），不判题不展示答案；self_assess 模式下交卷补判循环（`exams.service.ts`）跳过主观题；
- 结果页：客观题显示对错 + 得分；主观题显示参考答案 + 解析 + 自评按钮；成绩统计只算客观题，展示「客观题得分 X / Y，主观题 N 题」。

## 9. ExplanationCacheService 去留

保留，降级为兜底。补全后绝大多数题已有解析，它只在「新入库且未补到解析」的题上触发；不删代码、不改行为。`answer>=100 字符直写 explanation` 分支对已有 explanation 的题本来就跳过，与人工核验数据天然不冲突。

## 10. 测试策略

- **判题路由**：`JudgeCoreService` 单测覆盖四档路由 × 两模式（self_assess 下主观题返回 null + 标记；ai 下走 mock JudgmentCapability）；
- **导入工具**：data-refinery pytest——试卷定位、题号匹配（含大题拆小问、匹配不上报错不写入）、dry-run diff、题型改写、幂等重跑；fixture 造小试卷，不依赖真库；
- **自评流**：training 模块单测——`incorrect` 入错题本、`correct` 清零、强制门（未自评不可下一步）；
- **端到端**：导入工具先拿一份试卷几题 dry-run 给用户确认再放量；前端以 lc1 账号过专项训练/考试/错题练习三个结果页。

## 11. 实施顺序

1. `question_self_assessments` 表 + schema/DB 设计文档同步；
2. `answer_importer` CLI（格式解析、定位、匹配、dry-run、回写）；
3. `JudgeCoreService` 路由改造 + `JUDGE_SUBJECTIVE_MODE` 配置 + 契约扩展；
4. calculation 类型落地（TARGETED_TYPES、前端 UI、labeler、prompt 措辞）；
5. 自评 API + 三场景前端改造（训练/课堂/考试）；
6. 空答案抽题守卫；
7. 文档同步（见 §12）。

## 12. 文档同步清单

按仓库「文档同步」铁律，实现时须同步更新：

- `tools/db/schema.sql` + `docs/K12智学系统-数据库设计文档.md`：新表 `question_self_assessments`、type 取值加 calculation、method 枚举加 self_assess；
- `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml`：新增 `POST /api/training/self-assess`（两端点文档保持一致）；
- `docs/ai-core-changelog.md`：判题体系重构条目；
- `CLAUDE.md`：判题相关约定段落更新（judgment 场景职责变化、自评开关）。

## 13. 后续待办（本设计不做）

- admin Web 题目管理/答案审校界面（存量补完后给增量题用）；
- 学生自评 vs AI 判定一致率分析（模型能力评估数据来源）；
- 主观题自评数据进学情分析/家长报告。
