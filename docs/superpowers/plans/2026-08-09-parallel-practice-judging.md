# 并行判题改造方案（2026-08-09）

## 目标
学生提交一题后**立即进入下一题**，大模型在后台并行判题；全部答完后弹出"判题中"进度页，逐题显示判题完成状态，全部判完自动弹出结果列表。学生真正等待的只有最后一题的尾巴。

## 背景
当前 AnswerModal 每题 `await onSubmit`（阻塞 15~137s）→ toast → 1.5s → 下一题。难题下 qwen3.7-max 超时 ×3 重试 = 135s 转圈。已将判题模型切为 deepseek-v4-flash（实测 ~19s），本方案在此基础上把"每题都等"改为"并行隐藏"。

## 涉及文件
1. `apps/web/src/components/business/AnswerModal.tsx` — 核心改造（并行提交 + 判题进度页）
2. `apps/web/src/pages/student/CourseDetailPage.tsx` — onSubmit 失败兜底
3. `apps/web/src/store/practiceStore.ts` — AnswerRecord 增 `failed` 字段
4. `apps/web/src/components/business/AnswerResultList.tsx` — 失败条目展示

## 后端
**无需改动**。前端对每题并发 POST `/api/practice/judge`，学生顺序答题天然限流（~1 题/20-60s）。模型已切 deepseek-v4-flash。

## 详细改动

### 1. AnswerModal — 并行提交 + 判题进度页
状态机：`mode: 'answering' | 'judging'`

- **移除**：`submitting` / `advancing` / `advanceTimer`（不再阻塞等待判题结果）。
- **新增**：
  - `progress: Status[]`（长度 = 题目数，`'pending' | 'judging' | 'done' | 'failed'`）
  - `pendingRef = useRef<Map<number, Promise<unknown>>>()`（追踪每题判题 promise）

**handleSubmit（answering 态）**：
1. 取当前 `idx`、`answer`；`setProgress` 标记 `progress[idx]='judging'`。
2. **fire-and-forget**：`onSubmit(q.text, ans).then(→'done').catch(→'failed')`，promise 存入 `pendingRef`。
3. 清空 `answer`、收起提示；
   - 非末题：`setIdx(idx+1)`（立即切题，无等待）。
   - 末题：`setMode('judging')`，`Promise.allSettled([...pendingRef.values()]).then(onFinish)`。

**判题进度页（judging 态渲染，替代题面 UI）**：
- 居中 spinner + 「AI 正在判题，请稍候」+ 「已完成 X / N 题」。
- 题目列表：第 N 题 + 状态图标（✓ 已判完 / ⏳ 判题中 / ⚠ 失败），逐题随 promise 完成 live 更新。
- 全部判完 → 自动 `onFinish()`（父组件弹结果列表）。
- `onClose` 仍可关闭（放弃未完成判题）。

### 2. CourseDetailPage — onSubmit 失败兜底
`onSubmit` 包 try/catch：
- 成功：`record(n, studentAnswer, res)`（同现在）。
- 失败（503 等）：`record(n, studentAnswer, 合成失败条目, { failed: true })` 并 **rethrow**（AnswerModal 据此标 `'failed'`）。

### 3. practiceStore — failed 字段
- `AnswerRecord` 增 `failed?: boolean`。
- `record(n, studentAnswer, result, opts?: { failed?: boolean })` 合并 `failed`。

### 4. AnswerResultList — 失败展示
- `a?.failed` → 显示「AI 判定失败」（灰色图标，非对非错），不计入对/错，单独「未判定 Z」计数。
- 统计行：对 X / 错 Y / 未判定 Z。

## 边界情况
- 判题快、学生慢：末题提交时多数已判完，进度页一闪而过 → 结果列表。
- 判题慢、学生快：进度页等最慢的一题（deepseek ~19s）。
- 单题失败：不阻塞其他题，结果列表标「判定失败」。
- 关闭弹窗：未完成判题放弃（已 record 的仍保留）。

## 不改动
- 后端 / API / 模型路由（已切 deepseek-v4-flash）。
- timeout 保持 45s（deepseek 19s 充裕；如需兜底可后续调 60s）。
- `onSubmit` 签名不变（仍 `Promise<JudgeResult>`），仅用法从 await 改为 fire-and-forget。

## 验证
- 单测/手测：答多题，观察切题即时、进度页逐题 ✓、最后弹列表。
- 故意构造超时（或断网）验证失败条目「判定失败」展示。
