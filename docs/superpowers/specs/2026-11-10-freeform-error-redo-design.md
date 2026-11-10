# 做题错题「重练」出口 — 设计 spec

- 日期：2026-11-10
- 状态：已实现并验收（2026-11-10）
- 关联：`docs/superpowers/specs/2026-11-08-freeform-question-solve-design.md`（做题入口）、`docs/constraints/做题入口.md`
- 一句话：做题（freeform）产生的错题不再「只能看不能练」——从错题本可发起重练，复用【做题】页的作答与 AI 判题，答对清零；不进普通错题练习池，不发积分、不写 `practice_results`、不更新掌握度。

---

## 1. 背景

### 1.1 现状

- 做题入口判题成功后写 `questions`（`source='freeform'`、`answer_verified=0`、无知识点）与 `main_error_books`（`source='freeform'`）。
- 错题本（`GET /api/training/error-book`）能显示这些条目，但：
  - 前端复选框禁用（`isSelectable(entry) === entry.source !== 'freeform'`）；
  - 后端 `JudgeCoreService.judgeQuestion` 对 `q.source='freeform'` 直接 `400 / 1001`。
- 理由（2026-11-08 裁决）：做题题的标准答案是 AI 写的、未核验；普通错题练习拿 `questions.answer` 判题，还会发订正分、写 `practice_results`、更新 `student_knowledge_mastery`，放进去一旦答案错会污染这些数据。

### 1.2 问题

上述隔离是**正确的风险控制**，但把所有 freeform 错题永久锁死在「只看」状态，等于入库后没有练习出口，用户无法接受。

### 1.3 目标

1. 给 freeform 错题一条**明确的练习出口**：重做同一题、AI 判题、答对清零。
2. 不改变普通错题练习的题池与判题口径（freeform 仍不进）。
3. 不产生积分、练习记录、掌握度等「正式学习数据」，避免未核验答案污染统计。
4. 复用现有【做题】页，不重复造作答/判题 UI。

### 1.4 非目标（v1）

- 不把 freeform 并入普通错题练习（`judgeQuestion` 的 400/1001 保留）。
- 不做 freeform 题的变式/相似题（无知识点）。
- 不做「二次核验 → `answer_verified=1` → 进正式题库」的升级流水线（Phase 2）。
- 不做重练历史页 / 家长端重练。
- 不新增数据表、不新增后端端点。

---

## 2. 方案选择

| 方案 | 做法 | 结论 |
|---|---|---|
| A. 直接放开普通错题练习 | 允许勾选 freeform，判题仍用库里的 `answer` | **否决**：未核验答案会判错，且写分/掌握度/练习记录 |
| B. 新做一套 freeform 重练 runner | 新页面 + `QuestionRunner` + SSE 判题 | 成本高：`QuestionRunner` 只认同步 `isCorrect`，要重做实时思考/报告 UI |
| C. 错题本入口 → 复用【做题】页 | 队列 + `?redo=1`，作答/判题/结果全复用 | **采用**：改动最小、体验与做题一致、无统计副作用 |
| D. 先人工核验再入正式池 | 审核后 `answer_verified=1` | 作为 Phase 2；v1 无出口，不解决当前问题 |

**决策：方案 C。**

---

## 3. 用户流程

### 3.1 状态机

```
[训练 · 错题本]
  ├─ 单题「重练」──────────┐
  └─ 「重练做题错题（N）」──┤
                            ▼
        [做题 · 重练模式]（跳过录入/选题，直接作答）
                            │ 提交
                            ▼
        [判题中：已等待 Ns + 思考过程 + 报告增量 + 停止]
                            │ result
                            ▼
        [结果卡：正确/部分/错误 + 我的答案 + 正确答案 + 报告]
             ├─ 满分 → 后端清零 → 「下一题」/「返回错题本」
             ├─ 不满分 → 保留错题 → 「再答一次」/「答疑」/「下一题」
             └─ 失败/停止 → 「重试」/「返回作答」/「下一题」（跳过这题）
```

### 3.2 线框（错题本）

```
┌───────────────────────────────────────────────────────────┐
│ 错题练习                                    [重练做题错题 3] │
│ 时间 [ ] 到 [ ]  题型 [全部]  专项 [全部]      [查询]        │
├───────────────────────────────────────────────────────────┤
│ ☐  [填空] [做题] L1                          2026-11-10    │
│    对于点 P 和 ⊙C……                                       │
│    做题记录的题目暂不支持错题练习              [重练]        │
├───────────────────────────────────────────────────────────┤
│ ☐  [解答] [考试] L2                          2026-11-09    │
│    ……                                                      │
└───────────────────────────────────────────────────────────┘
```

### 3.3 线框（做题 · 重练模式）

```
┌───────────────────────────────────────────────────────────┐
│ [返回错题本]  错题重练 · 第 2/5 题              [账号]      │
├───────────────────────────────────────────────────────────┤
│ 题干（只读）                                                │
│ ┌────────────────────────┬──────────────────────────────┐ │
│ │ 左编辑                  │ 右预览                        │ │
│ └────────────────────────┴──────────────────────────────┘ │
│              [附上草稿]   [答疑]  [提交]                    │
└───────────────────────────────────────────────────────────┘
```

---

## 4. 前端设计

### 4.1 错题本入口（`ErrorPracticePage`）

**单题重练**

- freeform 卡片（`entry.source === 'freeform'` 且 `questionId != null`）在题面下方、原「做题记录的题目暂不支持错题练习」提示右侧加按钮「重练」。
- 点击：`e.stopPropagation()`（卡片本身不可点），写入单题队列并跳转。
- 孤儿题（`questionId == null`）不显示重练。

**批量重练**

- 列表上方工具条右侧加次按钮「重练做题错题（N）」，N = 当前筛选结果中 `source==='freeform' && questionId!=null` 的条数；N=0 时不显示。
- 点击：把当前筛选结果里的全部 freeform 条目按列表顺序写入队列。

**保持不变**

- freeform 条目的复选框继续 `disabled`；
- 「开始练习」只统计/提交 `isSelectable` 的条目；
- 普通错题的勾选、变式入口、空态、错误态不变。

### 4.2 队列存储

`sessionStorage` 键：`training:freeform-redo`。

```ts
interface FreeformRedoItem {
  errorBookId: number;
  questionId: number;
  questionText: string;
  type: string | null;
  /** questions.full_score；null/缺省时前端按 10 */
  fullScore: number | null;
}

interface FreeformRedoQueue {
  subjectId: number;
  items: FreeformRedoItem[];
  /** 当前下标，0-based；刷新后从这里恢复 */
  index: number;
}
```

- 写入后跳 `/student/solve?redo=1`。
- **读后不删**（刷新要能恢复当前题）；完成/退出时删除。
- 队列为空/解析失败/`questionId` 非法 → 清键 + `toast('error','重练题单已失效，请回错题本重新选择')` + `navigate('/student/training/errors?subjectId=<id>', { replace: true })`。

### 4.3 做题页重练模式（`SolvePage`）

**启动**

- 仅当 `searchParams.get('redo') === '1'` 时进入重练模式；否则行为与现在完全一致。
- 读队列 → 取 `items[index]`：
  - `picked = { content: item.questionText, figureUrls: extractRedoFigures(item.questionText), subjectId: queue.subjectId, maxScore: item.fullScore ?? 10 }`；
  - `stage = 'answer'`，`aiOpen = false`，`tab = 'answer'`；
  - 不调用识别、不建会话（会话在首次提交/答疑时按需创建）。

**页头**

- 标题从「做题」改为「错题重练」，右侧显示「第 i/N 题」；
- 左上按钮从「返回入口」改为「返回错题本」：`navigate('/student/training/errors?subjectId=<subjectId>')` 并清队列；
- `pageAction`（草稿图标）逻辑不变。

**提交 / 答疑**

- 提交：复用现有 `judge.submit`，body 带 `questionId: item.questionId`（后端据此更新同题、清零同题错题），`maxScore` 用 `item.fullScore ?? 10`，`questionContent` 用 `item.questionText`，`figureUrls` 用提取结果。
- 答疑：复用现有 `askHelp`；已判题时仍发「这题我还是没太懂…」。
- 判题结果卡、实时思考面板、停止/重试、再答一次：全部复用。

**下一题**

- 结果卡新增可选按钮：
  - 还有下一题 → 「下一题」；
  - 已到最后一题 → 「返回错题本」。
- 点击「下一题」：
  1. `queue.index += 1`，写回 sessionStorage；
  2. 关闭草稿、清空 `answer`/`submittedAnswer`/`judgeReport`；
  3. `useFreeformJudge.reset()`（见 §4.4）；
  4. 重置 `dialogueRef` / `dialoguePromiseRef` / `dialogueId`；
  5. `setPicked(next item)`，`setStage('answer')`，`setEditAfterJudge(false)`，`setParamsLocked(false)`。
- 点击「返回错题本」/「返回错题本」页头：清队列，导航回列表（列表重新拉取，已清零的条目消失）。

**刷新与退出**

- 刷新：sessionStorage 中 `index` 仍在 → 恢复到当前题（答案会丢，重练未提交的输入不保存）。
- 浏览器后退：回到错题本；队列仍在，但只有带 `?redo=1` 进入才会读取；下次普通做题不受影响。
- 队列完成/主动退出：删除键，避免下次误入。

### 4.4 `useFreeformJudge` 新增 `reset()`

```ts
reset(): void
```

- abort 当前流（如有）；
- `setSubmitting(false)`、`setStopped(false)`、`setQuestionId(null)`、`setLastResult(null)`；
- `lastBodyRef.current = null`；
- 清空当前会话的 `useChatStore` 消息（`useChatStore.getState().reset()`）。
- 不清 `isStreaming` 以外的 store 状态（`reset()` 已含）。

### 4.5 结果卡扩展（`SolveJudgeResult`）

新增两个可选 props：

```ts
nextLabel?: string;   // 「下一题」/「返回错题本」
onNext?: () => void;
```

- 有 `result` 时，在头部按钮组渲染 `nextLabel`（主按钮样式），点击 `onNext`；
- 停止态/失败态也渲染 `nextLabel`（批次里某题判题失败/被停止时可以跳到下一题，不至于卡死）；
- 等待态（判题中）不渲染；
- 不传时与现在完全一致（普通做题）。

### 4.6 配图提取

```ts
const REDO_FIGURE_RE = /!\[[^\]]*\]\((\/uploads\/freeform\/[^)\s]+)\)/g;
function extractRedoFigures(content: string): string[] {
  return [...content.matchAll(REDO_FIGURE_RE)].map((m) => m[1]).slice(0, 6);
}
```

- 只提取 `/uploads/freeform/...`（与后端 `FREEFORM_FIGURE_PREFIX` 一致）；
- 去重？同一图在题干多次出现时最多 6 张，重复由后端 resolve 时按数组逐张转 data URL，前端用 `new Set` 去重；
- 提取不到 → 空数组，只送题干文本。

---

## 5. 后端设计

### 5.1 `GET /api/training/error-book` 增加 `fullScore`

**响应条目**（`ErrorBookEntryDto`）新增：

```ts
/** questions.full_score；孤儿题/未入库为 null。重练时作为满分（前端缺省 10）。 */
fullScore: number | null;
```

**SQL**（`MainErrorBooksRepository.findErrorBookEntries`）：

```sql
SELECT meb.id, meb.question_id,
       COALESCE(q.content, meb.wrong_answer_text) AS questionText,
       q.type, q.full_score AS full_score,
       meb.level, meb.created_at, q.options AS options,
       qkp.knowledge_point_id AS kp_id, meb.source
FROM main_error_books meb
LEFT JOIN questions q ON meb.question_id = q.id
LEFT JOIN question_knowledge_points qkp ON qkp.question_id = meb.question_id
WHERE ...
```

- 返回行类型补 `full_score: number | null`；
- `TrainingService.getErrorBookEntries` 映射 `fullScore: row.full_score`；
- 该字段对普通错题也返回（前端不用即可），不改变现有筛选/排序/聚合。
- 无迁移：`questions.full_score` 早已存在（freeform 判题写入 `maxScore`）。

### 5.2 重练判题：复用 `POST /api/freeform/judge/stream`

**请求体**（不新增字段）：

```jsonc
{
  "subjectId": 1,
  "maxScore": 10,
  "questionId": 7091,            // 关键：重判同一题
  "questionContent": "……",       // 错题本里的题干
  "answer": "学生的重练作答",
  "figureUrls": ["/uploads/freeform/..."]  // 可为空
}
```

- 不传 `dialogueId`：由服务端新建 `aux_freeform` 会话（现有行为）；每次重练一场，互不干扰。
- 归属校验沿用现有逻辑：`questionId` 必须存在；`source='freeform'` 时要求「本会话已锚定」或「本人错题本里有该题」，否则 `error 1001`。
- 落库沿用现有 `persist`：
  - `questionId` 已给且 `source='freeform'` → 更新同一条（`updateFreeform`），不会新建题；
  - `totalScore < maxScore` → 保留/复用未清错题行；
  - `totalScore === maxScore` → `clearUnclearedByStudentQuestionId` 清零。
- **不新增**：不发积分、不写 `practice_results`、不更新 `student_knowledge_mastery`、不 bump `level`（None of these are in `FreeformJudgeService`；这是复用它的另一条理由）。
- SSE 事件与结果卡完全复用：`start / reasoning / content / result / error / done`，`result` 带 `correctAnswer`。

### 5.3 配图「尽力而为」（仅重练请求）

**问题**：题干里的配图路径可能属于题目的首个提交者；题目被去重共享后，当前学生重练时这些图不在其名下。现有 `resolveImages` 对 `figureUrls` 校验归属，不通过直接 `400/1001`，会让重练直接失败。

**改法**（`FreeformJudgeService`）：

- `judgeStream` 里已有 `providedQuestion`，计算宽松标记并作为新参数传给 `resolveImages`：

```ts
// judgeStream 内（resolveImages 调用点之前）
const relaxedFigures =
  dto.questionId != null && providedQuestion?.source === 'freeform';
const images = await this.resolveImages(dto, studentId, { relaxedFigures });

// resolveImages 签名扩展
private async resolveImages(
  dto: FreeformJudgeDto,
  studentId: number,
  opts: { relaxedFigures?: boolean } = {},
): Promise<ResolvedImage[]>
```

- 对 `figureUrls`：
  - 严格模式（首次提交）：保持现状——不存在/非本人 → `400/1001`；
  - 宽松模式（重练）：`files.findByUrlAndOwner` 查不到 → **跳过该图**，继续处理其余图；
  - `questionImages`（原题照片）始终严格，不受影响；
  - `draftFileId` / 作答 Markdown 内嵌图始终严格。
- 说明：宽松模式只影响「题干配图是否随判题送给模型」，不会让请求方读取到无权文件（查不到就不读），安全边界不变。

### 5.4 前端错误处理

| 场景 | 表现 |
|---|---|
| 队列失效（刷新后 sessionStorage 被清/手工打开 `?redo=1`） | toast + 回错题本 |
| `questionId` 不存在/失权（1001） | 结果卡失败态：「该题已不可重练，请回错题本刷新」+「返回错题本」；重试仍会失败，不额外拦 |
| 判题 5502 / 5000 / 1009 | 结果卡失败态 +「重试」/「返回作答」 |
| 网络中断 | 失败态 +「重试」 |
| 用户停止 | 「已停止判题」+「继续判题」/「返回作答」 |
| 图片全部失权 | 判题仍继续（宽松模式跳过图），报告按文本生成 |

---

## 6. 边界与不变式

1. **普通做题不受影响**：不带 `?redo=1` 时 `SolvePage` 行为与现在一致。
2. **普通错题练习不受影响**：freeform 仍 `disabled` + `judgeQuestion` 仍 `400/1001`。
3. **重练不产生正式学习数据**：无积分、无 `practice_results`、无掌握度、无 level 变化。
4. **同一题不会重复入库**：重练带 `questionId`，`persist` 更新同一条。
5. **答对清零**：`totalScore === maxScore` 才清；部分正确/错误保留。
6. **学科/满分**：来自错题本条目与 `questions.full_score`，重练页不允许改（`paramsLocked` 初始为 true）。
7. **会话**：每次重练新建一场 `aux_freeform`，不出现在答疑历史/家长对话回放（现有过滤）。
8. **题干只读**：重练页不提供编辑题干入口（与作答页一致）。

---

## 7. 测试计划

### 7.1 后端

| 文件 | 用例 |
|---|---|
| `training.service.test.ts` | `getErrorBookEntries` 映射 `fullScore`（有值 / null） |
| `main-error-books.repo.test.ts`（若存在） | SELECT 含 `q.full_score AS full_score`；无该测试则补 service 层断言 |
| `freeform-judge.service.test.ts` | ① 重练请求（`questionId` + source=freeform）里 `figureUrls` 有一张不属于本人 → 跳过、不报错，其余图仍送模型；② 首次提交（无 `questionId`）同样的图 → 仍 `400/1001`；③ 重练满分 → `clearUnclearedByStudentQuestionId`；④ 重练不满分 → 复用/保留错题行、不新建；⑤ 重练不调积分/掌握度/练习记录（结构性断言，与现有 7 依赖一致） |
| `freeform-judge.service.test.ts` | 重练带他人 `questionId` → `1001`（沿用现有归属校验） |

### 7.2 前端

| 文件 | 用例 |
|---|---|
| `ErrorPracticePage.test.tsx` | ① freeform 卡片有「重练」，点击写入单题队列并跳 `?redo=1`；② 「重练做题错题（N）」按当前筛选的 freeform 条数渲染、点击写全量队列；③ 普通错题勾选/开始练习不受影响；④ 孤儿题不显示重练 |
| `SolvePage.test.tsx` | ① `?redo=1` + 合法队列 → 直接作答，页头「错题重练 · 第 1/2 题」，不调识别；② 提交 body 带 `questionId`/`fullScore`/`questionContent`/`subjectId`/`figureUrls`；③ 结果卡显示「下一题」，点击后加载第 2 题并重置编辑器/会话/判题状态；④ 最后一题显示「返回错题本」，点击清队列并导航；⑤ 非法/空队列 → toast + 回列表；⑥ 不带 `?redo=1` 时行为不变（回归） |
| `SolveJudgeResult.test.tsx` | 有 `nextLabel/onNext` 时渲染并回调；不传时无该按钮 |
| `freeform-hooks.test.ts` | `useFreeformJudge.reset()` 清空 `questionId`/`lastResult`/`stopped`/消息，并 abort 在跑的流 |
| `useFreeformTutor`（如有 reset） | 不需要：重练换题时由页面重置 `dialogueRef`，不新增 hook API |

### 7.3 手测清单

1. 做题错一题（不满分）→ 错题本出现「做题」条目 → 点「重练」→ 直接作答 → 提交 → 判题中实时思考 → 结果卡 → 满分 → 回错题本，条目消失。
2. 批量 3 题 → 「重练做题错题（3）」→ 连续三题 → 最后一题「返回错题本」。
3. 重练中刷新 → 回到当前题（答案丢失）；退出后再次普通做题不受影响。
4. 普通错题练习仍不能勾选 freeform，题池数量不变。
5. 带配图的做题错题重练 → 题干图正常显示、判题不因图片归属 400（必要时看后端日志确认跳过了无权图）。

---

## 8. 文档同步（实现时）

- `docs/K12智学系统-产品需求文档.md` §7.15：补「错题重练出口」的流程、入口、清零口径、不做项。
- `docs/superpowers/specs/2026-11-08-freeform-question-solve-design.md`：§「池隔离」补一句「重练出口见 2026-11-10 spec」，不改 400/1001 的既有口径。
- `docs/constraints/做题入口.md`：新增「重练复用做题页 + 队列键 + 不写正式数据 + 配图宽松仅限重练」硬约束。
- `docs/API接口与数据流设计文档.md` §4.13 / §4.30：`error-book` 响应补 `fullScore`；§5.33 补重练数据流（复用 freeform judge，不新建端点）。
- `docs/api/openapi.yaml`：`ErrorBookEntry` schema 加 `fullScore`。
- `docs/ai-core-changelog.md`：追加本次实现日志。

---

## 9. 风险与后续

| 风险 | 说明 | 缓解 |
|---|---|---|
| 慢 / 成本 | 每题一次 AI 判题（30–90s），批量 N 题 = N 次调用 | 已有实时思考面板与停止；批量入口显示题数；不自动重试 |
| 未核验答案 | 重练仍以 AI 判题为唯一依据 | 只影响该生自己的错题清零，不进正式池、不写掌握度/积分 |
| 配图跨学生归属 | 共享题的图可能不在当前学生名下 | v1 宽松跳过无权图；Phase 2 把 freeform 配图复制成题目自有资产 |
| 题干图片显示 | 前端 `<img>` 能否加载取决于 `/uploads` 的访问策略 | 现有做题题干已能显示同一路径；若后续收紧权限，随 Phase 2 一起处理 |
| 会话增长 | 每次重练新建一场 `aux_freeform` | 现有列表/家长回放已排除；Phase 2 可复用原 `dialogue_id` 或加 `skipDialogue` |

**Phase 2（不在本 spec 范围）**

1. freeform 配图落为题目资产（`uploads/questions/<id>/`），彻底解决跨学生归属。
2. 二次核验 / 人工核验 → `answer_verified=1` + 知识点标定 → 可进普通错题练习、变式、专项池。
3. 重练历史与掌握度（需先有可信答案）。

---

## 10. 验收清单

- [ ] 错题本 freeform 条目可单题「重练」，也有「重练做题错题（N）」批量入口。
- [ ] 重练直接进作答区，题干只读，学科/满分锁定，草稿/答疑可用。
- [ ] 提交带 `questionId`，更新同题；满分清零、不满分保留。
- [ ] 重练不发积分、不写 `practice_results`、不更新掌握度、不 bump level。
- [ ] 普通错题练习仍无法勾选 freeform，题池不变。
- [ ] 队列刷新可恢复、完成/退出清理；非法队列回列表并提示。
- [ ] 带配图重练不因图片归属失败（无权图跳过）。
- [ ] 两端测试与 build 通过；PRD / constraints / API 文档 / openapi / changelog 同步。
