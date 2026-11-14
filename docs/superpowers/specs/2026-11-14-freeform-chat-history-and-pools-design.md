# 做题答疑进历史 + 做题题进错题/专项 设计文档

- 日期：2026-11-14
- 状态：已与用户确认口径，待评审
- 关联计划：`docs/superpowers/plans/2026-11-14-freeform-chat-history-and-pools.md`
- 取代的口径：`docs/API接口与数据流设计文档.md` 中「`aux_freeform` 不出现在答疑历史列表」「freeform 题不进任何练习池」两条（仅学生端；家长端回放仍排除）

## 1. 背景与目标

做题入口（`/student/solve`）目前把判题和答疑混在同一场 `aux_freeform` 会话里，但：

1. 会话不进【辅助答疑】列表，刷新后聊天记录无处可找，学生只能重新开始；
2. 判题产生的 freeform 错题被三道隔离挡在所有练习池外，学生无法再练；
3. 只答疑、没提交判题的题完全不落库，等于「孩子真正不会的题」没有被记录。

本次目标（用户裁决 2026-11-14）：

- **只把「真正聊过天」的做题会话**放进【辅助答疑】历史，可回放、可继续追问；纯判题会话不显示。
- 做题题进错题本，并能进**错题练习 / 知识点专项 / 同类型 / 变式**。
- 只答疑、没提交的题也要收：由 AI 结构化生成答案、解析、题型、难度、知识点后入库。
- 判题拿了满分、后来才答疑的题**不进**错题本（保持「满分=已掌握/清零」语义）。
- 这些题参与练习时**发积分、更新知识点掌握度**（用户裁决）。

## 2. 现状与差距（代码事实）

| 事实 | 位置 |
|---|---|
| 每次提交判题前都会 `ensureDialogue()`，因此纯判题也会建 `aux_freeform` 会话 | `apps/web/src/pages/student/SolvePage.tsx:255` |
| 会话列表写死只查 `aux_qna` | `apps/web/src/store/auxiliaryStore.ts:32`、`ConversationList.tsx:16`、`ConversationManagePage.tsx:76` |
| 列表接口 `scene` 只支持单值 | `apps/server/src/modules/conversations/conversations.controller.ts:26`、`ai-dialogues.repo.ts:42` |
| 历史回放不认 Markdown，做题作答会显示 `$x=1$` 源码 | `apps/web/src/hooks/useAuxChat.ts:193-219` |
| 判题已落 `questions`（含 answer/explanation/type/difficulty/full_score）与未满分错题本 | `apps/server/src/modules/freeform/freeform-judge.service.ts:404-465` |
| freeform 题不绑知识点 | `questions.repo.ts:97-103`（`createFreeform`） |
| 错题练习页把 freeform 置为不可勾选 | `apps/web/src/pages/student/training/ErrorPracticePage.tsx:77-79` |
| 训练判题直连也拒绝 freeform | `apps/server/src/modules/practice/judge-core.service.ts:274-279` |
| 抽题谓词要求 `answer <> ''` + 知识点关联 | `questions.repo.ts:170-197`、`238-248` |
| 知识点：数学 79 / 物理 84 / **化学 0**（做题仅这三科；语文 33、道法 76 与做题无关） | `knowledge_points` 表 |
| 家长端对话回放无条件排除 `aux_freeform`（本次不变） | `parent-insights.repo.ts:714`、`chat-logs.service.ts:95` |

## 3. 行为口径

### 3.1 历史列表

- 【辅助答疑】列表 = `aux_qna` 全部 + `aux_freeform` 中**至少有一条聊天消息**的会话。
- 「聊天消息」定义：`ai_messages` 中该会话下存在 `deleted_at IS NULL` 且
  `type IS NULL OR type NOT IN ('transcription','freeform_submit','freeform_judge')` 的消息。
  （题干锚 `transcription`、判题提交 `freeform_submit`、判题报告 `freeform_judge` 都不算聊天。）
- 纯判题会话不显示，但数据保留（判题报告、错题重练仍可用）。
- 侧栏与「会话管理」页同源，最多仍显示最近 7 条（侧栏 `MAX_VISIBLE=7` 不变）。
- 会话标题沿用 `做题 · <题干前 20 字>`，与普通答疑同列按 `id DESC` 排序。

### 3.2 回放与继续追问

- 回放时 `freeform_submit` 用户消息按 **Markdown + LaTeX** 渲染。
- 显示前去掉信封前缀：库里内容形如
  `题目：\n<题干>\n\n我的作答：\n<作答>`，回放只显示 `<作答>`；
  题干由已有的 `transcription` 锚消息展示，避免重复。
- 点开历史会话后可继续发消息：走现有 `POST /api/ai/tutor/stream`，
  服务端按 `scene='aux_freeform'` 使用 `freeform_tutor` 模板，行为与做题页一致。
- 判题报告（`freeform_judge`）在回放里作为助手消息展示（学生能看到当时为什么错）；不隐藏。
- 刷新后不做做题页自动恢复；学生从【辅助答疑】历史进入继续聊。

### 3.3 错题本

| 场景 | 处理 |
|---|---|
| 提交判题、未满分 | 保持现状：错题本 find-or-create（`source='freeform'`） |
| 提交判题、满分 | 保持现状：清零该题未清错题 |
| 只答疑、从未提交 | 首次聊天后异步建题 + 进错题本（`source='freeform'`） |
| 判题满分后又答疑 | **不进错题本**；若已有错题行按满分规则已清，不再重建 |
| 判题未满分后又答疑 | 复用现有未清错题行，不重复 |

错题本身份：同一题干按 `content_hash`（去图片）→ **带学科限定的**前 20 字前缀去重。
`findByContentPrefix` 当前是全局扫描，不同学科开头相同的题会误合并；本次给该查询加
`subject_id` 限定（新调用必须传学科；旧调用保持可选以兼容）。

**判题命中已有 freeform 题时，必须用判题结果更新该题**（答案/解析/题型/难度/`full_score`），
不能只复用：先答疑后提交时，库里可能是标注模型生成的答案，判题结果更可靠。
题库真题（`source != 'freeform'`）仍只复用、绝不改题。

**选项落库剥离答案**：`questions.options` 只存 `{label,text}`，绝不存 `isCorrect`
（与变式题同铁律）。历史数据由 `parseOptions` 读取时统一剥离，防止做题题解禁后泄题。

### 3.4 练习池

> 做题入口只支持**数学 / 物理 / 化学**（`ai-core/freeform.ts` 的 `FREE_FORM_SUBJECTS`）；
> 语文、道法不会出现做题题。

- **错题练习**：`source='freeform'` 不再特殊禁用；`answerable=true` 的条目可勾选。
- **知识点专项**：题挂上 `question_knowledge_points` 后，按现有 `targeted/start` 谓词自然可抽。
  数学、物理可用；**化学知识点表为 0 条，暂不可用**。
- **同类型（补偿套题）**：freeform 题在专项里被答错时，产生的错题行 `source='targeted'`，
  按现有规则进入同类型种子。**仅数学 / 物理**（`SIMILAR_PRACTICE_SUBJECTS` 不含化学）。
- **变式**：freeform 错题在错题练习中**再次做错**时，按现有 `bump-error-levels` 触发；
  需要 primary 知识点 + 非空答案 + `type != true_false`。**现状只支持数学**
  （`variation-generator.service.ts` 写死 `MATH_SUBJECT_ID`），物理/化学暂不生成。
- **积分 / 掌握度**：沿用 `JudgeCoreService.finishJudge` 与错题清零发分链路；
  freeform 题挂 KP 后，掌握度会正常回写。做题页本身的判题仍不发分、不更新掌握度（不变）。

### 3.5 不可练的题

- `answer` 为空的题（纯图片题、或结构化失败）仍进错题本，但 `answerable=false`：
  错题练习页置灰不可勾选，提示「该题暂无标准答案，暂不支持练习」。
- 化学知识点表为空：化学题可进错题本/错题练习，但进不了专项，直到补齐化学知识点数据。

## 4. 架构与数据流

### 4.1 答疑即入库（只答疑路径）

```
POST /api/ai/tutor/stream (dialogueId, scene=aux_freeform)
  → TutoringCapability（freeform_tutor，照常流式回复并落 ai_messages）
  → 流结束后 fire-and-forget：
      FreeformChatIngestService.maybeIngest(dialogueId, studentId)
        1. 会话必须 aux_freeform 且属于该生
        2. ai_dialogues.question_id 非空 → 结束（判题已建题）
        3. 会话里已有 type='freeform_judge' 消息 → 结束（兜底 question_id 回填失败）
        4. 没有任何「真实回复」（assistant 消息只有题干锚 / block）→ 结束（安全阻断不算聊过）
        5. 已有该题错题行（含已清零）→ 结束（满分后答疑不进）
        6. 取首条 type='transcription' 的题干锚；取会话的 subject_id
             - subject_id 为空 → 结束（不猜数学，避免物理题进数学专项）
        7. 去重查题（hash → 带 subject_id 的前 20 字）：
             命中 → 只补 link question_id
             未命中 → FreeformQuestionTagCapability.tag()
                       → 建 questions(source='freeform', answer_verified=0, full_score=10)
                       → 绑 question_knowledge_points
        8. 建 main_error_books(source='freeform') + 回填 dialogue.question_id
  任何失败只 warn，绝不影响答疑响应
```

年级/学段从 `students` 表读取（`school_level`），不要写死 `junior`。

### 4.2 判题补知识点（提交路径）

```
POST /api/freeform/judge/stream
  → 现有 persist()（题 + 错题本）
       - 命中已有 freeform 题（无 questionIdHint 且 source='freeform'）：
         updateFreeform 用判题结果覆盖答案/解析/题型/难度/full_score
       - options 落库前剥掉 isCorrect
  → 落库成功后 fire-and-forget：
      FreeformChatIngestService.tagExistingQuestion(questionId, content, subjectId, studentId)
        - 已有 KP → 跳过
        - tag() → 绑 primary/secondary
        - 失败只 warn（题与错题本不受影响）
```

### 4.3 知识点标注

新增 `FreeformQuestionTagCapability`（不写 `@Injectable()`，零参实例化，避开 DI 坑）：

- 提示词：`apps/server/src/ai-core/prompts/freeform/tag.md`，学科无关，输入为：
  题干、学科名、学段、**该学科知识点候选清单 `[{id,name}]`**。
- 输出 zod：

```ts
{
  type: 'choice'|'multi_choice'|'fill_blank'|'true_false'|'short_answer'|'proof'|'calculation',
  difficulty: 1|2|3,
  answer: string,
  explanation: string,
  approach: string | null,
  knowledgePointIds: number[],   // 只能来自候选清单，服务端二次校验
  confidence: 'high'|'medium'|'low'
}
```

- 模型路由复用 `scene: 'structuring'`（已覆盖所有学科，deepseek-flash 主、qwen3.8-max 备）。
- 服务端校验：过滤候选清单外的 id、去重、最多 3 个；第一个绑 `primary`，其余 `secondary`。
- `confidence='low'` 仍绑（自动化优先），只记日志，方便后续统计。

## 5. 接口变更（端点级）

### 5.1 `GET /api/conversations`

- query 新增/扩展：
  - `scene`：**支持逗号分隔多值**，如 `aux_qna,aux_freeform`。逐项白名单校验
    `aux_qna|aux_training|aux_freeform|mainline_question|mainline_card`；
    空串忽略；任一非法 → `400 / 1001`（与现有参数错误同码）。
  - `hasChat`：`1` 开启；`0` 或缺省关闭；**空串视为缺省**；其它值 → `400 / 1001`。
- `hasChat=1` 时追加条件（**只约束 freeform**，避免影响 `aux_qna` 空会话）。
  注意仓库现有查询 `FROM ai_dialogues` **没有别名**，子查询必须关联 `ai_dialogues.id`：

```sql
AND (
  scene <> 'aux_freeform'
  OR EXISTS (
    SELECT 1 FROM ai_messages m
    WHERE m.dialogue_id = ai_dialogues.id
      AND m.deleted_at IS NULL
      AND (m.type IS NULL OR m.type NOT IN ('transcription','freeform_submit','freeform_judge'))
  )
)
```

- 分页不变：`id < cursor`，`ORDER BY id DESC LIMIT 10`；响应形状不变。
- 兼容性：不传 `hasChat`、传单值 `scene` 时行为与现在完全一致。

### 5.2 `GET /api/training/error-book`

- 响应每条新增 `answerable: boolean`：
  `q.id IS NOT NULL AND q.answer IS NOT NULL AND q.answer <> ''`。
- 其它字段、排序、过滤不变。
- 前端据此决定复选框是否可用（替代现在的 `source !== 'freeform'`）。

### 5.3 `POST /api/training/judge`

- 删除 `q.source === 'freeform'` 的 400/1001 拦截。
- 空答案守卫保持不变：`answer` 为空 → `isCorrect=null`、`method='unanswered'`、不发分、不写错题本。
- 判题、积分、掌握度链路不变。

### 5.4 无新增公开端点

标注、入库、补标均为服务内部调用；不新增 controller 路由。

## 6. 服务端改动清单

| 文件 | 改动 |
|---|---|
| `modules/conversations/conversations.controller.ts` | 解析 `scene` 多值 + `hasChat`，非法 400/1001 |
| `modules/conversations/conversations.service.ts` | 透传 `scenes[]` / `hasChat`，校验 |
| `database/repositories/ai-dialogues.repo.ts` | `findByStudentAndTrack` 支持 `scene IN (...)` + `hasChat` EXISTS 条件 |
| `modules/ai/ai.service.ts` | `tutor()` / `tutorStage()` 结束后调用 `freeformIngest.maybeIngest()`（fire-and-forget） |
| `modules/freeform/freeform-chat-ingest.service.ts`（新） | 答疑补题、判题补 KP、补标入口、in-flight 去重（按 questionId 收敛标注锁） |
| `modules/freeform/freeform-judge.service.ts` | `persist` 命中已有 freeform 题时用判题结果更新；options 剥 `isCorrect`；落库后调用 `tagExistingQuestion` |
| `modules/freeform/freeform.module.ts` | 注册新 service（与 capability），导出给 AiModule |
| `modules/practice/judge-core.service.ts` | 删除 freeform 拦截 |
| `modules/training/variation-generator.service.ts` | 加学科守卫：非数学直接跳过（变式写库固定数学，避免物理题生成数学变式） |
| `database/repositories/questions.repo.ts` | `findByContentPrefix` 增加可选 `subjectId` 限定（新调用必传） |
| `common/utils/parse-options.util.ts` | 读取时剥离 `isCorrect`（兜住历史数据，防泄题） |
| `database/repositories/main-error-books.repo.ts` | 列表查询补 `q.answer <> '' AS answerable` |
| `modules/training/training.service.ts` | DTO 增加 `answerable` 映射 |
| `ai-core/capabilities/freeform-tag.capability.ts`（新） | 标注能力 + zod 校验 + 候选 id 过滤 |
| `ai-core/prompts/freeform/tag.md`（新） | 学科无关标注提示词 |
| `ai-core/types.ts` + `ai-core/infra/prompt-builder.ts` | `CapabilityType` 增加 `freeform_tag`，并在 `resolveTemplatePath` 返回 `freeform/tag.md` |
| `scripts/copy-assets.mjs` | 确认新提示词随构建复制（现有按目录复制，应自动覆盖；计划里加校验任务） |

> 注意：`scripts/copy-assets.mjs` 需要确认 `prompts/freeform/tag.md` 被复制进 `dist`；若按整目录复制则无需改。

## 7. 前端改动清单

| 文件 | 改动 |
|---|---|
| `services/api.ts` | `listConversations` / `listAllConversations` 支持 `scenes: AiConversationScene[]` + `hasChat`；query 用逗号拼接 |
| `store/auxiliaryStore.ts` | `fetchConversations` 改为 `['aux_qna','aux_freeform']` + `hasChat: true` |
| `components/business/ConversationList.tsx` | 同上；空态文案不变（「暂无历史会话」） |
| `pages/student/ConversationManagePage.tsx` | 同上（搜索/改名/删除对做题会话同样生效） |
| `hooks/useAuxChat.ts` | 历史映射：`markdown: m.type === 'freeform_submit'`；`content` 去信封前缀 |
| `pages/student/training/ErrorPracticePage.tsx` | 可选条件改为 `entry.answerable`；不可选时显示「该题暂无标准答案，暂不支持练习」；分母同步。保留现有「重练做题错题」按钮（空答案题唯一的练习入口，且保留做题页编辑器） |
| `components/business/AuxChatPanel.tsx` | 不改；`freeform_submit` 走已有 `markdown` 分支 |

回放去信封的纯函数放在 `useAuxChat.ts`（或 `utils/`）并配单测：

```ts
// 只认库里的固定分隔；无分隔时原样返回（历史坏数据/人工消息不破坏）
function stripFreeformSubmitEnvelope(content: string): string {
  const marker = '\n\n我的作答：\n';
  const i = content.lastIndexOf(marker);
  if (i < 0) return content;
  const body = content.slice(i + marker.length);
  // 只提交草稿时正文为空：给一句占位，避免空白气泡
  return body.trim() ? body : '（本次仅提交了草稿）';
}
```

## 8. 判题、积分与掌握度

- 训练判题（错题练习 / 专项 / 变式）统一走 `JudgeCoreService`：
  - 客观题按标准答案判；
  - 主观题按现有自评路由（`isCorrect=null` + `needsSelfAssessment`）；
  - 清零错题时发 `error_fix` 积分（现有规则）；
  - `finishJudge` fire-and-forget 写 `student_knowledge_mastery`（现有规则）。
- freeform 题现在挂 KP，因此掌握度会正常落到对应知识点。
- 做题页判题仍**不发分、不写练习记录、不更新掌握度**（本次不变）。

## 9. 边界与风险

1. **AI 标准答案的准确性**：freeform 题答案来自判题模型或标注模型，未经人工核验；
   客观题按它精确判有误判风险。与现有变式题（AI 生成答案）同口径，接受风险，
   用 `answer_verified=0` 留痕，后续按真实数据评估误判率。
2. **纯图片题**：标注只吃文本（模型看不到图），这类题建空答案题 + 错题本，
   `answerable=false`，不进任何池。
3. **化学无知识点**：化学只进错题本/错题练习，专项/同类型/变式需先补知识点数据
   （且同类型本身不支持化学，变式目前只支持数学）。
4. **异步丢失**：答疑后立即杀进程可能丢补题；失败只 warn，历史对话不受影响。
   不接受为此引入任务表（过度设计），补标脚本可兜存量。
5. **家长端不变**：家长对话回放仍无条件排除 `aux_freeform`；错题列表按 `training` 档展示不变。
6. **列表排序**：仍按会话 `id DESC`，继续聊不会把会话顶到最前（与现有答疑会话一致）。
7. **跨会话「满分后答疑」边界**：同一场会话内满分后再答疑，因 `dialogue.question_id` 已存在而不会重建错题行；
   但学生换一次做题页（新会话）、再次答疑同一道曾经满分的题时，系统没有保存「曾满分」的历史，
   会按「只答疑」建错题行。这是无判分历史导致的已知边界，本次不引入判分流水表；若实际发生频率高再补。
   同一场会话内不会出现「刚满分、马上又被拉回错题本」。
8. **并发竞态（低概率）**：补题按会话（`d:`）、补标按题（`q:`）各自 in-flight 去重，两路
   并不共用同一把锁；答疑与判题同时进行时理论上可能各跑一次标注。前端做题页同一时刻
   只允许一个流（`isStreaming` 守卫），实际很难触发。`INSERT IGNORE` 防同 (题, 知识点) 重复，
   但不同知识点各绑一次 primary 仍可能发生；错题行「先查后建」也非原子。接受并记录，
   不为此加表/加唯一键。
9. **选项泄题**：`questions.options` 里的 `isCorrect` 必须在写库时剥离，且 `parseOptions` 读取时再剥一次
   （兜住历史数据）；否则解禁后专项/错题接口会把正确答案下发给学生。
10. **去重跨学科**：前 20 字前缀去重必须带 `subject_id`，否则「阅读下面的文字…」这类开头会把不同题合并。

## 10. 存量回填

- 对象：`questions.source='freeform' AND is_active=1 AND answer <> '' AND 无 question_knowledge_points`。
- 方式：一次性脚本 `apps/server/scripts/backfill-freeform-kp.ts`，直接实例化
  `FreeformQuestionTagCapability` + `mysql2` pool（不走 Nest DI），逐题标注并绑 KP；
  失败重试 1 次，单题失败只记日志；结束打印 `scanned/tagged/skipped/failed`。
- 默认执行（不加 `--dry-run`），一条命令跑完；已在题上的 KP 不重复写。
- 未判题的纯答疑老数据没有题干行可补，保持原样（新逻辑只对上线后的答疑生效）。
- 化学/无知识点学科的题会被跳过（候选清单为空）。

## 11. 测试策略

服务端：
- `conversations.service.test.ts`：多 scene 校验、非法 scene 400/1001、`hasChat` 仅约束 freeform。
- `ai-dialogues.repo.test.ts`：SQL 含 EXISTS 三联 type 过滤、scene IN、cursor/limit 不变。
- `freeform-chat-ingest.service.test.ts`：
  - 无 question_id + 有聊天 → 建题 + 错题本 + link；
  - 已有 question_id → 跳过；
  - 已有 `freeform_judge` 消息 → 跳过；
  - 会话无 subject_id → 跳过（不猜数学）；
  - 已有错题行（含已清零）→ 跳过（满分后答疑不进）；
  - tag 失败 → 建空答案题 + 错题本，不挂 KP；
  - 图片题 → 空答案 + 不可练；
  - 前缀去重带 subjectId、options 剥 isCorrect；
  - 并发两次调用只建一条题。
- `questions.prefix.test.ts`：前缀查询带 `subject_id` 条件。
- `freeform-tag.capability.test.ts`：候选外 id 被过滤、最多 3 个、低置信度仍返回。
- `freeform-judge.service.test.ts`：
  - 落库后调用补 KP（不 await），失败不影响 result；
  - 命中已有 freeform 题时用判题结果 `updateFreeform`；题库真题仍只复用；
  - 选择题 options 落库前剥 `isCorrect`。
- `parse-options.util.test.ts`：读取历史 options 时剥 `isCorrect`。
- `judge-core.service.test.ts`：freeform 不再 400；空答案仍 `unanswered`。
- `training.service.test.ts`：`answerable` 映射。
- `main-error-books.repo.test.ts`：`answerable` SQL 表达式。

前端：
- `AuxChatPanel.test.tsx` / `useAuxChat` 相关：freeform_submit 渲染 KaTeX、去信封、transcription 保留。
- `ConversationList.test.tsx`（若存在）/ `ConversationManagePage`：请求带双 scene + hasChat。
- `ErrorPracticePage.test.tsx`：answerable=false 禁用 + 提示；true 可选；分母正确。
- `SolvePage.test.tsx`：判题/答疑原用例全绿。

## 12. 验收清单（人工）

1. 做题页只提交判题、不答疑 → 刷新后【辅助答疑】列表无新会话。
2. 做题页点【答疑】聊两句 → 列表出现「做题 · …」；点开可回放，公式正常，作答不重复显示题干。
3. 在列表里继续追问 → 同一会话追加，不新建会话。
4. 只答疑、不提交 → 错题本出现该题（做题标签）；错题练习可勾选、可判分。
5. 判题满分后再答疑 → 错题本不出现该题。
6. 未满分做题错题 → 错题练习可勾选；数学答错后升级并生成变式。
7. 数学/物理：该题挂上知识点后，在对应知识点专项里可抽到（化学因 0 知识点预期抽不到）。
8. 化学：可进错题练习；同类型/变式不支持（现状），专项需先补知识点。
9. 纯图片题：进错题本但置灰，提示暂无标准答案。
10. 家长端：对话回放仍看不到做题会话；错题列表可见（现状）。
11. 先答疑、后提交判题：判题结果覆盖标注模型生成的答案，`full_score` 变成学生选的满分。
12. 选择题的 options 在错题列表/专项接口里不含 `isCorrect`。

## 13. 不在本次范围

- 家长端展示做题答疑会话。
- 化学知识点数据补齐。
- 图片题的结构化（让模型读图生成答案）。
- 做题页判题发积分/写练习记录/更新掌握度。
- 改变 `freeform_submit` 在库里的存储格式（只在回放时去信封）。
