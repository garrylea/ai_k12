# 错题清零功能实现计划（v2）

## 背景

课堂练习（practice cards）可能有 3-4 页，每页结束后展示对错表（AnswerResultList），结果存入 `practice_results`，错题入 `main_error_books`。上一节课所有练习做完后进入下一节课。下一节课开头检测上一节课是否有未清零错题，有则进入「错题清零」阶段。

### 清零流程

```
进入新课 → 检测上节课有错题 → 进入清零阶段
  │
  ├─ 逐题展示（第 1/N 题）
  │    ├─ 显示题面
  │    ├─ LaTeX 编辑 + 预览（无提示、无 AI 聊一聊）
  │    └─ 提交 → 自动跳下一题
  │
  ├─ 最后一道题提交后 → "AI 正在判题"
  │
  └─ 判题完成 →
       ├─ 全对 ✓ → 庆祝页 → 5 秒倒计时或手动「开始学习」
       └─ 有错 ✗ → AnswerResultList（可看题解）→ 手动「开始学习」
            └─ 错题 level +1（标记未掌握）
```

### 与 AnswerModal 判题逻辑一致
- 提交后立即切到下一题（fire-and-forget），不等待判题结果
- 最后一题提交后进入等待态，等全部判题完成
- 完成后统一展示对错表（复用 AnswerResultList）

---

## 变更清单

### 1. 后端：错题详情查询 API

**新端点**：`GET /api/practice/previous-error-details?lessonId=<id>`

返回上一课所有未清零课堂练习错题的详情。

```ts
// 返回结构
{
  lessonId: number;
  errors: {
    errorBookId: number;      // main_error_books.id，用于后续 +level
    cardId: number;           // 查询时复用 judge 接口
    questionN: string;        // 卡内题号
    questionText: string;     // 题面
    questionId: number | null;// 题库 ID
  }[];
}
```

**数据源**：以 `main_error_books`（`source='practice'` + `is_cleared=0` + `lesson_id=上节课`）为准，JOIN `questions` 补全题面。`question_id` 为空时从 `practice_results` 兜底。

**文件变更**：

| 文件 | 变更 |
|------|------|
| `apps/server/src/database/repositories/main-error-books.repo.ts` | 新增 `findUnclearedByLessonWithDetails()` 方法（返回 id + question 信息） |
| `apps/server/src/modules/practice/practice.service.ts` | 新增 `getPreviousErrorDetails()` 方法 |
| `apps/server/src/modules/practice/practice.controller.ts` | 新增 `GET /previous-error-details` 端点 |

---

### 2. 后端：错题严重程度 +1 API

**新端点**：`POST /api/practice/bump-error-levels`

清零后仍有错误的题，增加 `main_error_books.level`。

```ts
// 请求体
{
  errorBookIds: number[];  // 清零后仍错的 main_error_books.id 列表
}
```

**逻辑**：对每个 `id` 执行 `UPDATE main_error_books SET level = level + 1 WHERE id = ?`。

**注意**：对于 `question_id` 为 null 的边角情况，按 `(student_id, card_id, question_text)` 匹配更新。

**文件变更**：

| 文件 | 变更 |
|------|------|
| `apps/server/src/database/repositories/main-error-books.repo.ts` | 新增 `bumpLevels()` 方法 |
| `apps/server/src/modules/practice/practice.service.ts` | 新增 `bumpErrorLevels()` 方法 |
| `apps/server/src/modules/practice/practice.controller.ts` | 新增 `POST /bump-error-levels` 端点 |

---

### 3. 前端：新增 API 接口函数

**文件**：`apps/web/src/services/api.ts`

```ts
// 类型定义
interface PreviousErrorDetail {
  errorBookId: number;
  cardId: number;
  questionN: string;
  questionText: string;
  questionId: number | null;
}
interface PreviousErrorDetailsResult {
  lessonId: number;
  errors: PreviousErrorDetail[];
}

// 函数
getPreviousErrorDetails(lessonId): Promise<PreviousErrorDetailsResult>
bumpErrorLevels(errorBookIds: number[]): Promise<void>
```

---

### 4. 前端：新组件 `CleanupPhase`

**文件**：`apps/web/src/components/business/CleanupPhase.tsx`

**Props**：
```ts
interface Props {
  errors: PreviousErrorDetail[];  // 待清零错题列表
  lessonId: number;
  subjectId: number;
  onComplete: (allCleared: boolean) => void;  // 完成后回调
}
```

**状态机**：
```
answering → 逐题展示，提交即跳到下一题
    ↓ (最后一道题提交后)
judging  → "判题中，请稍候…" 旋转动画（无逐题进度，不等完不展示）
    ↓ (全部判题完成)
判断结果：
  ├─ 全对 → allClear  → 庆祝页（撒花 + 5s 倒计时 + 手动「开始学习」）→ onComplete(true)
  └─ 有错 → hasErrors → AnswerResultList + 「开始学习」→ onComplete(false)
```

**界面结构（嵌入主内容区）**：

**answering 态**：
```
┌─────────────────────────────────────────┐
│  错题巩固 — 第 2/5 题                    │
├─────────────────────────────────────────┤
│  [题面 - ReactMarkdown]                  │
│                                         │
│           ┌──────────┬──────────┐       │
│           │ 答题编辑上│ 预览区   │       │
│           │ (Latex   │ (Latex   │       │
│           │  Editor) │  Preview)│       │
│           └──────────┴──────────┘       │
│                                         │
│                   [上一题]  [提交]       │
│                                         │
│  [跳过清零，开始学习（底栏小字链接）]     │
└─────────────────────────────────────────┘
```

**judging 态**（简单的等待动画，不展示逐题进度）：
```
┌─────────────────────────────────────────┐
│                                         │
│              ⟳ 判题中，请稍候…           │
│                                         │
│        (旋转 loading 图标)               │
│                                         │
└─────────────────────────────────────────┘
```

**allClear 态**：复用 CourseDetailPage 中的庆祝覆盖层（撒花动效 + 5s 倒计时 + 「开始学习」按钮）。

**hasErrors 态**：
- 复用 `<AnswerResultList questions={errors} answers={practiceStore.answers} />`
- 底部显示「开始学习」按钮
- 此时全部题已判完，AnswerResultList 展示完整的对错表

**核心逻辑**：
1. 初始化：`errors` 转为 `PracticeQuestion[]` 存入 practiceStore
2. 维护 `currentIndex` 和内部 `progress: JudgeStatus[]`（不展示进度列表，仅用于等待控制）
3. 提交：调用 `judgePractice({ cardId, lessonId, subjectId, questionN, questionText, studentAnswer })`，fire-and-forget，提交后自动跳到下一题
4. 提交后：`record(n, studentAnswer, result)` 存入 store
5. 最后一题提交后：
   - 进入 judging 态：仅展示旋转 loading + "判题中，请稍候…"
   - `Promise.allSettled` 等待全部判题完成（不展示逐题进度）
6. 全部判题完成后：
   - 统计 `stillWrong` 的 `errorBookIds`
   - 调用 `bumpErrorLevels(stillWrongIds)`
   - 全对 → 庆祝页；有错 → AnswerResultList
7. 「跳过清零」→ 直接调用 `onComplete(false)`

**复用组件**：
- `LatexEditor` + `LatexPreview` — 答题编辑/预览
- `AnswerResultList` — 清零结果对错表
- `ReactMarkdown` — 题面渲染
- `judgePractice` API — 判题
- `usePracticeStore` — 答案 store

---

### 5. 前端：CourseDetailPage 集成

**文件**：`apps/web/src/pages/student/CourseDetailPage.tsx`

**新增状态**：
```ts
const [cleanupErrors, setCleanupErrors] = useState<PreviousErrorDetail[]>([]);
const [cleanupDone, setCleanupDone] = useState(false);
```

**fetchData 改造**（L224-228 附近）：
```ts
const [result, previousErrors, errorDetails] = await Promise.all([
  fetchLessonCards(lessonId),
  getPreviousLessonErrors(lessonId).catch(() => ({ lessonId: null, count: 0 })),
  getPreviousErrorDetails(lessonId).catch(() => ({ lessonId: null, errors: [] })),
]);
setCleanupErrors(errorDetails.errors);
```

**主内容区条件渲染**（在现有 `<AnimatePresence>` 之前）：
```tsx
if (previousErrorCount > 0 && cleanupErrors.length > 0 && !cleanupDone) {
  return <CleanupPhase ... />;
}
// 否则走现有卡片渲染逻辑
```

**CleanupPhase 回调整合**：
```ts
onComplete = (allCleared: boolean) => {
  setCleanupDone(true);
  if (allCleared) setPreviousErrorCount(0); // 侧边栏切换状态
};
```

---

### 6. 判题复用说明

清零提交直接复用 `POST /api/practice/judge`，其判题路由为：
1. 按 `content_hash` 查 `questions` 题库
2. `choice`/`true_false` 类型 → exact 比对数据库答案
3. `fill_blank` 类型 → 归一化后 exact 比对
4. 未命中 → AI 判定（`JudgmentCapability`）

**无需新增清零专属判题端点**。现有 judge 行为对齐清零需求如下：

| 判题结果 | 现有 judge 行为 | 清零场景 |
|----------|----------------|----------|
| 答对 | `clearUnclearedByStudentQuestion()` 清零错题本 | ✓ 需要 |
| 答错 | `main_error_books` find-or-create | ✓ 保留 |
| 结果 | upsert 到 `practice_results` | ✓ 记录 |

---

## 执行顺序

1. 后端：`mainErrorBooksRepo` 新增 `findUnclearedByLessonWithDetails()` + `bumpLevels()`
2. 后端：`practiceService` + `Controller` 新增两个端点
3. 前端：`api.ts` 新增接口函数 + 类型定义
4. 前端：创建 `CleanupPhase.tsx` 组件
5. 前端：修改 `CourseDetailPage.tsx` 并行加载错题详情 + 条件渲染
6. 验证：清零完整链路 → 全对庆祝 / 有错对错表

---

## 不涉及变更
- `main_error_books` / `practice_results` 表结构
- AnswerModal、DiscussDrawer、DiscussChat
- 侧边栏 UI（已支持错题清零状态）
- 单元级别的错题温习（后续功能，level 字段为未来铺垫）
