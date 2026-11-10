# 做题错题「重练」出口 — 实施计划

- 日期：2026-11-10
- 对应 spec：`docs/superpowers/specs/2026-11-10-freeform-error-redo-design.md`
- 状态：已实施并验收（2026-11-10）
- 口径确认（2026-11-10）：
  1. **入口**：保留「单题重练」+「重练做题错题（N）」两个入口；
  2. **成绩**：重练只用于清零错题，**不发积分、不写 practice_results、不更新掌握度、不 bump level**；
  3. **配图**：重练请求里不属于当前学生的题干图**跳过不报错**（首次提交仍严格校验）。
- 总原则：**不加后端端点、不加表、不迁移**；复用 `POST /api/freeform/judge/stream` 与 `SolvePage`。

---

## 0. 前置检查

- [ ] 确认 `questions.full_score` 对存量 freeform 题有值（判题写入 `maxScore`）；无值前端按 10。
- [ ] 确认 `main_error_books.dialogue_id` 不参与本方案（v1 每次重练新建 `aux_freeform` 会话）。
- [ ] 确认普通错题练习的 `judgeQuestion` 400/1001 不动。

---

## 1. 后端：错题本返回 `fullScore`

**文件**
- `apps/server/src/database/repositories/main-error-books.repo.ts`
- `apps/server/src/modules/training/dto/error-book-query.dto.ts`
- `apps/server/src/modules/training/training.service.ts`
- `apps/server/src/modules/training/training.service.test.ts`

**改动**
1. `findErrorBookEntries`：
   - SELECT 增加 `q.full_score AS full_score`；
   - 返回行类型增加 `full_score: number | null`。
2. `ErrorBookEntryDto` 增加：
   ```ts
   /** questions.full_score；重练满分，null 时前端按 10。 */
   fullScore: number | null;
   ```
3. `TrainingService.getErrorBookEntries` 映射 `fullScore: row.full_score`。

**测试**
- 普通题：`full_score=10` → DTO `fullScore=10`。
- 孤儿题（`question_id=null`）→ `fullScore=null`，其余字段不变。
- 现有 `source` 断言不回归。

**完成判据**：`GET /api/training/error-book?subjectId=1` 每条带 `fullScore`；旧字段不变。

---

## 2. 后端：重练配图「尽力而为」

**文件**
- `apps/server/src/modules/freeform/freeform-judge.service.ts`
- `apps/server/src/modules/freeform/freeform-judge.service.test.ts`

**改动**
1. `judgeStream` 在 `resolveImages` 调用前计算：
   ```ts
   const relaxedFigures =
     dto.questionId != null && providedQuestion?.source === 'freeform';
   const images = await this.resolveImages(dto, studentId, { relaxedFigures });
   ```
2. `resolveImages` 签名扩展：
   ```ts
   private async resolveImages(
     dto: FreeformJudgeDto,
     studentId: number,
     opts: { relaxedFigures?: boolean } = {},
   )
   ```
3. `figureUrls` 循环：
   - 严格模式（`relaxedFigures !== true`）：保持现状，找不到/非本人 → `badRequest('配图不存在或无权访问')`；
   - 宽松模式：`files.findByUrlAndOwner` 返回 null → `continue`（跳过），其余照常；
   - `questionImages` / `draftFileId` / 作答内嵌图**永远严格**。

**测试**
- 重练（`questionId` + source=freeform）传 2 张图，其中 1 张不属于本人 → 不抛错，只送 1 张。
- 首次提交（无 `questionId`）传同样的图 → 仍 400/1001。
- 重练图全部无权 → 仍成功（0 张图），不报错。

**完成判据**：重练不会因共享题的图片归属直接失败；安全边界（读不到无权文件）不变。

---

## 3. 前端：API 类型 + 重练队列 helper

**文件**
- `apps/web/src/services/api.ts`
- 新增 `apps/web/src/pages/student/training/freeformRedoQueue.ts`
- 新增 `apps/web/src/pages/student/training/freeformRedoQueue.test.ts`

**改动**
1. `TrainingErrorBookEntry` 增加 `fullScore: number | null`。
2. 新增队列模块：
   ```ts
   export const FREEFORM_REDO_KEY = 'training:freeform-redo';
   export interface FreeformRedoItem {
     errorBookId: number; questionId: number; questionText: string;
     type: string | null; fullScore: number | null;
   }
   export interface FreeformRedoQueue {
     subjectId: number; items: FreeformRedoItem[]; index: number;
   }
   export function saveRedoQueue(q: FreeformRedoQueue): void;
   export function readRedoQueue(): FreeformRedoQueue | null; // 结构非法 → clear + null
   export function updateRedoIndex(index: number): void;      // 越界不写
   export function clearRedoQueue(): void;
   export function extractRedoFigures(content: string): string[]; // /uploads/freeform/，去重 ≤6
   ```
   校验：`subjectId` 正整数、`items` 非空、`questionId` 正整数、`questionText` 非空、`index ∈ [0,len-1]`；JSON 解析失败一律清键。

**测试**
- 正常写/读/更新 index/清。
- 非法 JSON、空 items、index 越界、questionId 非正 → 返回 null 且清键。
- `extractRedoFigures`：普通 Markdown 图、非 freeform 路径、重复图、超过 6 张。

**完成判据**：队列读写可独立测试，不依赖页面。

---

## 4. 前端：错题本入口

**文件**
- `apps/web/src/pages/student/training/ErrorPracticePage.tsx`
- `apps/web/src/pages/student/training/ErrorPracticePage.test.tsx`

**改动**
1. 计算 `freeformEntries = entries.filter(e => e.source === 'freeform' && e.questionId != null)`。
2. 单题：freeform 卡片题面下方、原「做题记录的题目暂不支持错题练习」提示右侧加「重练」按钮：
   - `e.stopPropagation()`；
   - 写入单题队列（`index:0`）→ `navigate('/student/solve?redo=1')`。
3. 批量：筛选 Card 的按钮组（「查询」右侧）加次按钮「重练做题错题（N）」：
   - N=0 不渲染；
   - 写入当前筛选结果的 freeform 条目（按列表顺序）→ 同上跳转。
4. 保持：复选框 `disabled`、`isSelectable`、普通错题勾选、开始练习、变式入口、空态/错误态全部不变。

**测试**
- freeform 卡片有「重练」；点击后 `sessionStorage[FREEFORM_REDO_KEY]` 为单题队列，路由到 `/student/solve?...`；
- 批量按钮文案随 freeform 条数变化；点击后队列包含全部 freeform（不含普通错题）；
- 普通错题点击仍只切换勾选，不写队列；
- 孤儿 freeform（`questionId=null`）没有重练按钮、不计入 N。

**完成判据**：页面不改普通错题行为；两个入口都能生成合法队列。

---

## 5. 前端：`useFreeformJudge.reset()`

**文件**
- `apps/web/src/pages/student/solve/useFreeformJudge.ts`
- `apps/web/src/pages/student/solve/freeform-hooks.test.ts`

**改动**
```ts
const reset = useCallback(() => {
  abortRef.current?.abort();
  abortRef.current = null;
  if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  lastBodyRef.current = null;
  timedOutRef.current = false;
  setSubmitting(false);
  setStopped(false);
  setQuestionId(null);
  setLastResult(null);
  useChatStore.getState().reset();
}, []);
```
返回 `{ submitting, stopped, questionId, lastResult, submit, retry, stop, reset }`。

**测试**
- 在跑/已完成的判题后调 `reset()` → `submitting=false`、`stopped=false`、`questionId=null`、`lastResult=null`、消息清空；
- `reset()` 后再次 `submit` 能正常起新流（不复用上一条 body）。

---

## 6. 前端：结果卡「下一题」

**文件**
- `apps/web/src/pages/student/solve/SolveJudgeResult.tsx`
- `apps/web/src/pages/student/solve/SolveJudgeResult.test.tsx`

**改动**
1. Props 增加：
   ```ts
   nextLabel?: string;
   onNext?: () => void;
   ```
2. 有 `result` 时，在头部按钮组末尾渲染 `nextLabel`（品牌主按钮）；`onNext` 点击触发。
3. 等待态不渲染；停止/失败态也渲染（批次可跳过失败题）；不传时行为与现在一致。

**测试**
- 传 `nextLabel='下一题'` → 按钮存在、点击回调一次；
- 不传 → 无该按钮（回归）。

---

## 7. 前端：`SolvePage` 重练模式

**文件**
- `apps/web/src/pages/student/SolvePage.tsx`
- `apps/web/src/pages/student/SolvePage.test.tsx`

### 7.1 启动与状态

在组件顶部（state 初始化前）：
```ts
const [searchParams] = useSearchParams();
const redoMode = searchParams.get('redo') === '1';
const bootRedo = useMemo(() => (redoMode ? readRedoQueue() : null), [redoMode]);
```
- `stage` 初值：`bootRedo ? 'answer' : 'input'`；
- `picked` 初值：`bootRedo ? toPicked(bootRedo.items[bootRedo.index], bootRedo.subjectId) : null`；
- `paramsLocked` 初值：`!!bootRedo`；
- `redo` state：`bootRedo`；
- effect：`redoMode && !bootRedo` → `toast('error','重练题单已失效，请回错题本重新选择')` + `navigate('/student/training/errors?subjectId=1', {replace:true})`。

`toPicked(item, subjectId)`：
```ts
{
  content: item.questionText,
  figureUrls: extractRedoFigures(item.questionText),
  subjectId,
  maxScore: item.fullScore ?? 10,
}
```

### 7.2 页头

- `redoMode`：
  - 左上改为本地按钮「返回错题本」→ `exitRedo()`（清队列 + `navigate('/student/training/errors?subjectId=<subjectId>')`）；
  - 标题「错题重练」；
  - 右侧「第 {index+1}/{items.length} 题」。
- 非 redo：保持现有 `BackButton to="/student/entry"` +「做题」。

### 7.3 提交

- 现有 `judge.submit` 的 `questionId` 改为 `picked.questionId ?? judge.questionId ?? undefined` —— 因此 `PickedQuestion` 增加可选 `questionId?: number`，redo 时填入 `item.questionId`；
- `subjectId` / `maxScore` / `questionContent` / `figureUrls` 沿用 `picked`；
- 重练模式不允许改学科/满分（`paramsLocked=true`）。

### 7.4 下一题

```ts
const hasNext = !!redo && redo.index < redo.items.length - 1;
const nextLabel = redo ? (hasNext ? '下一题' : '返回错题本') : undefined;
const onNext = redo ? (hasNext ? goNext : exitRedo) : undefined;
```
`goNext()`：
1. `nextIndex = redo.index + 1`；
2. `updateRedoIndex(nextIndex)`；`setRedo({...redo, index: nextIndex})`；
3. `judge.reset()`；
4. `dialogueRef.current = null; dialoguePromiseRef.current = null; setDialogueId(null);`
5. `setAnswer(''); setSubmittedAnswer(''); setJudgeReport(''); setEditAfterJudge(false); setIncludeDraft(false); setDraftOpen(false); setTab('answer'); setAiOpen(false); setParamsLocked(true);`
6. `setPicked(toPicked(item, subjectId))`；`setStage('answer')`。

`exitRedo()`：`clearRedoQueue()` + `navigate('/student/training/errors?subjectId=<subjectId>', {replace:true})`。

### 7.5 结果卡

把 `nextLabel` / `onNext` 传给 `SolveJudgeResult`（仅 redo 模式）。

**测试**（新增 `renderPageAt(path)` helper，`MemoryRouter initialEntries`）
- `?redo=1` + 合法队列 → 直接显示作答区，页头「错题重练 · 第 1/2 题」，`recognizeMock` 未调用；
- 提交 body：`questionId`、`questionContent=item.questionText`、`subjectId`、`maxScore=fullScore`、`figureUrls` 来自题干；
- 结果卡显示「下一题」；点击后加载第 2 题：编辑器清空、`judge.reset` 状态清空、页头 2/2；
- 最后一题结果卡显示「返回错题本」；点击清队列并导航；
- 空/非法队列 → toast + 回列表；
- 不带 `?redo=1` → 现有全部用例不变（回归）。

**完成判据**：重练可以连续走完队列；普通做题零回归。

---

## 8. 文档同步 + 全量验证

**文档**
- `docs/K12智学系统-产品需求文档.md` §7.15：补「错题重练」入口、流程、清零口径、不做项；
- `docs/constraints/做题入口.md`：新增重练硬约束（复用做题页、队列键、不发积分/不写练习记录/不更新掌握度、配图宽松仅限重练）；
- `docs/API接口与数据流设计文档.md` §4.13 error-book 响应补 `fullScore`；§5.33 补重练数据流；
- `docs/api/openapi.yaml`：`ErrorBookEntry` 加 `fullScore`；
- `docs/ai-core-changelog.md`：追加实现日志。

**验证命令**
```bash
# 后端
cd apps/server && npx vitest run src/modules/training/training.service.test.ts src/modules/freeform/freeform-judge.service.test.ts
cd apps/server && npm test && npm run build

# 前端
cd apps/web && npx vitest run \
  src/pages/student/training/ErrorPracticePage.test.tsx \
  src/pages/student/training/freeformRedoQueue.test.ts \
  src/pages/student/SolvePage.test.tsx \
  src/pages/student/solve/SolveJudgeResult.test.tsx \
  src/pages/student/solve/freeform-hooks.test.ts
cd apps/web && npx tsc -b --pretty false && npm test && npm run build
```

**手测（必须真页面）**
1. 现有 freeform 错题（如 `main_error_books.id=440`）→ 错题本出现「重练」→ 重练 → 答对 → 回列表该条消失。
2. 批量 3 题 → 连续下一题 → 最后一题回列表。
3. 重练中刷新 → 恢复当前题（答案丢失）；普通做题不受影响。
4. 普通错题练习仍不能勾选 freeform；题池数量不变。
5. 带配图的 freeform 错题重练不因图片归属 400（看服务端日志确认跳过无权图）。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| AI 判题慢 / 成本 | 复用实时思考面板与停止；批量入口显示题数；不自动重试 |
| 重练更新了 `questions.answer` | 与普通做题一致，属现有行为；不新增风险 |
| 配图宽松被滥用 | 只对 `questionId + source=freeform` 生效；查不到归属就不读文件，不泄漏 |
| 队列残留 | 完成/退出清键；非法队列回列表；普通做题不读键 |
| 回滚 | 前端入口与 `?redo=1` 都是新增分支；回滚只需隐藏两个按钮并忽略该 query；后端只多一个字段与宽松开关，默认行为不变 |

---

## 10. 完成定义（DoD）

- [ ] spec 中 10 条验收全部满足；
- [ ] 后端/前端全量测试通过、build 通过；
- [ ] 真页面走通「错题 → 重练 → 答对清零 → 列表消失」；
- [ ] 普通错题练习、普通做题、答疑、判题均无回归；
- [ ] PRD / constraints / API 文档 / openapi / changelog 同步。
