# 训练轨答题页体验修复 实施计划（v2：讲一讲方案，纯前端）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复专项/考试/错题三个答题页的留白、字号、题面挤压答题区问题，新增「提示→讲一讲」渐进式交互（课堂练习与训练轨全端统一）与退出确认逻辑。

**Architecture:** 纯前端改造。「讲一讲」不新增后端接口——训练轨复用既有辅线辅导链路（`createConversation({track:'auxiliary'})` + `/ai/tutor/stream` mode auxiliary），交互核心是 `QuestionRunner` 对 `headerActions` 插槽按「看过提示」gate（AnswerModal 自动获得同一行为）；退出逻辑用 react-router `useBlocker` 拦截路由返回。

**Tech Stack:** React 19 + Tailwind 3 + react-router-dom 6.27（`useBlocker`）。无后端改动、无 API 文档变更。

**Spec:** `docs/superpowers/specs/2026-09-04-training-run-ux-design.md`（v2 已同步：原「解析」方案废弃，改「讲一讲」）

**v1 → v2 变更说明**：v1 计划的 Task 1（ai-core question_solution 模式）、Task 2（POST /training/explanation）、Task 3（API 文档同步）、Task 4（api.ts getTrainingExplanation）全部删除——用户决策用「让 AI 讲一讲」（苏格拉底讨论）替代「解析」（直接看答案），后端零改动。

**通用约定**：
- 前端命令在 `apps/web/` 下执行，git 操作在仓库根 `/Users/lichao/Downloads/claude/imooc/ai_k12` 执行。
- apps/web 无测试框架：验证 = `npm run lint` + `npm run build`。
- 禁止 emoji 进 UI；图标一律线性 SVG；配色走 CSS 变量。
- 提交信息用 Conventional Commits（scope：web）。

---

### Task 1: DiscussDrawer / useDiscussChat 新增 training 模式

**Files:**
- Modify: `apps/web/src/hooks/useDiscussChat.ts`
- Modify: `apps/web/src/components/business/DiscussDrawer.tsx`
- Modify: `apps/web/src/components/business/AnswerModal.tsx:140-151`（讲一讲按钮抽取共用）

- [ ] **Step 1: useDiscussChat 加 training 模式**

`apps/web/src/hooks/useDiscussChat.ts`：

1. import 区把 `startDiscuss, startCardDiscuss, streamTutorEvents, getMessages, deleteMessage, tutor` 中追加 `createConversation`（在 `getMessages,` 之前按字母序插入合适位置，与 `services/api.ts` 的导出对齐）。

2. opts 联合类型（第 22-33 行）追加第三个变体：

```ts
// 训练轨（答题页内抽屉）：不挂卡片/课时上下文，走辅线辅导链路——
// createConversation({track:'auxiliary'}) + /ai/tutor/stream(mode auxiliary)。
// 每条用户消息前缀题面（镜像题目级模式），AI 始终有上下文。
type TrainingOpts = {
  mode: 'training';
  questionText: string;
};
```

并把 `UseDiscussChatOpts`（第 35 行）改为：

```ts
export type UseDiscussChatOpts = QuestionOpts | CardOpts | TrainingOpts;
```

3. `cacheKey`（第 37-39 行）改为：

```ts
function cacheKey(opts: UseDiscussChatOpts): string {
  if (opts.mode === 'question') return opts.questionText;
  if (opts.mode === 'training') return `training-q:${opts.questionText}`;
  return `card:${opts.cardId}`;
}
```

4. `streamMessage`（约 82 行）内 `streamTutorEvents({ mode: 'mainline', dialogueId, message }, ...)` 与降级 `tutor({ mode: 'mainline', dialogueId, message })` 的 mode 改为按 opts 取值——在 `streamMessage` 之前取：

```ts
  // training 模式挂的是 auxiliary 对话，流式请求的 mode 必须与其 track 一致
  const tutorMode = opts.mode === 'training' ? 'auxiliary' : 'mainline';
```

两处 `mode: 'mainline'` 改为 `mode: tutorMode`（`streamTutorEvents({ mode: tutorMode, dialogueId, message }, controller.signal)` 与 `tutor({ mode: tutorMode, dialogueId, message })`），并在 `streamMessage` 的 useCallback 依赖数组 `[appendMessage, appendLastAssistant, updateLastAssistant]` 中追加 `tutorMode`。

5. `send`（约 138-148 行）中题面前缀分支改为同时覆盖 question 与 training：

```ts
    const message = opts.mode === 'card'
      ? content
      : `这道题目是：\n\n${opts.questionText}\n\n我的问题：${content}`;
```

（question 与 training 模式结构相同，TS 收窄后都有 `questionText`；card 走原样。）

6. init effect（约 159 行起）「首开」分支（约 187-210 行）把创建对话的 if/else 扩为三分支：

```ts
        let dialogueId: string;
        if (opts.mode === 'question') {
          const res = await startDiscuss({
            cardId: opts.cardId,
            lessonId: opts.lessonId,
            subjectId: opts.subjectId,
            questionText: opts.questionText,
          });
          dialogueId = res.dialogueId;
        } else if (opts.mode === 'training') {
          // 辅线对话：无 cardId/错题本锚定，session 级缓存续接（刷新后是新对话，记待办）
          const conv = await createConversation({ track: 'auxiliary' });
          dialogueId = String(conv.id);
        } else {
          const res = await startCardDiscuss({
            cardId: opts.cardId,
            lessonId: opts.lessonId,
            subjectId: opts.subjectId,
          });
          dialogueId = res.dialogueId;
        }
```

其余（续接缓存 / 拉历史 / 不自动发种子）不动——training 模式同样由用户主动发第一条（消息自动带题面前缀）。

- [ ] **Step 2: DiscussDrawer 加 training props**

`apps/web/src/components/business/DiscussDrawer.tsx`：

1. props 联合类型（第 11-25 行）追加：

```ts
// 训练轨（答题页内抽屉）：同题目级（右抽屉，放大铺满），但不挂卡片上下文。
type TrainingProps = {
  mode: 'training';
  questionText: string;
  onClose: () => void;
};
```

并把 `type Props = QuestionProps | CardProps;` 改为 `type Props = QuestionProps | CardProps | TrainingProps;`。

2. `useDiscussChat` 调用（约 28-33 行）改为三分支：

```tsx
  const chat = useDiscussChat(
    props.mode === 'question'
      ? { mode: 'question', cardId: props.cardId, questionText: props.questionText, subjectId: props.subjectId, lessonId: props.lessonId }
      : props.mode === 'training'
        ? { mode: 'training', questionText: props.questionText }
        : { mode: 'card', cardId: props.cardId, subjectId: props.subjectId, lessonId: props.lessonId },
  );
```

3. 宽度/标题/placeholder（约 36-39 行）改为：

```tsx
  const widthClass = props.mode === 'card'
    ? expanded ? 'w-[70%]' : 'w-[45%]'
    : expanded ? 'w-full' : 'w-[55%]';
  const title = props.mode === 'card' ? '思辨答疑' : 'AI 讲一讲';
  const placeholder = props.mode === 'card' ? '说说你的疑问或想法…' : '说说你的想法或卡在哪里…';
```

（training 对齐题目级：w-[55%]/放大铺满，标题「AI 讲一讲」。）

- [ ] **Step 3: 抽取共用 DiscussIconButton**

`DiscussDrawer.tsx` 底部追加导出组件（样式取自 AnswerModal 现有讲一讲按钮，info 色）：

```tsx
/** 「让 AI 讲一讲」圆钮（题面右侧操作列）：AnswerModal 与训练轨答题页共用。 */
export function DiscussIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--info)] shadow-sm hover:bg-[var(--bg-subtle)] transition-colors"
      title="让 AI 讲一讲"
      aria-label="让 AI 讲一讲"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
}
```

- [ ] **Step 4: AnswerModal 改用共用按钮**

`apps/web/src/components/business/AnswerModal.tsx`：

1. import 区 DiscussDrawer 导入改为 `import { DiscussDrawer, DiscussIconButton } from './DiscussDrawer';`（确认原 import 形态后等价替换）。
2. `headerActions={(q) => (...)}`（第 140-151 行）整块替换为：

```tsx
      headerActions={(q) => (
        <DiscussIconButton onClick={() => setDiscussQ(q)} />
      )}
```

- [ ] **Step 5: lint + build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 均通过。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/hooks/useDiscussChat.ts apps/web/src/components/business/DiscussDrawer.tsx apps/web/src/components/business/AnswerModal.tsx
git commit -m "feat(web): DiscussDrawer/useDiscussChat 新增 training 模式（辅线辅导链路）"
```

---

### Task 2: QuestionRunner 布局与字号 + run 页留白

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx:136`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx:156`
- Modify: `apps/web/src/pages/student/training/ExamRunPage.tsx:228`

- [ ] **Step 1: 题面字号按 variant 区分**

`QuestionRunner.tsx` 约 238 行，把：

```tsx
              <div className="text-xl text-[var(--text-primary)] [&>*]:font-bold leading-[1.7]">
```

改为：

```tsx
              <div
                className={`${variant === 'embedded' ? 'text-lg' : 'text-xl'} text-[var(--text-primary)] [&>*]:font-bold leading-[1.7]`}
              >
```

（弹窗 variant 维持 text-xl——2026-08-09 commit 444e830 用户确认的参数；全屏 embedded 降 text-lg。）

- [ ] **Step 2: 题面区限高 + 答题区保底**

约 235 行，把：

```tsx
        <div className="shrink-0 p-4 border-b border-[var(--bg-subtle)]">
```

改为：

```tsx
        <div className="shrink-0 max-h-[45vh] overflow-y-auto p-4 border-b border-[var(--bg-subtle)]">
```

约 290 行（作答区），把：

```tsx
        <div className="flex-1 min-h-0 flex">
```

改为：

```tsx
        <div className="flex-1 min-h-[280px] flex">
```

（题干超长时题面区内部滚动，答题区保底 280px 始终可用。）

- [ ] **Step 3: 三个 run 页容器加 padding**

- `TargetedRunPage.tsx:136`：`<div className="h-screen flex flex-col bg-[var(--bg-page)] text-[var(--text-primary)]">` → `<div className="h-screen flex flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">`
- `ErrorPracticeRunPage.tsx:156`：同上改法。
- `ExamRunPage.tsx:228`：`<div className="flex h-screen flex-col bg-[var(--bg-page)] text-[var(--text-primary)]">` → `<div className="flex h-screen flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">`

- [ ] **Step 4: lint + build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 均通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/answer/QuestionRunner.tsx apps/web/src/pages/student/training/TargetedRunPage.tsx apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx apps/web/src/pages/student/training/ExamRunPage.tsx
git commit -m "fix(web): 答题页留白 + 题面区限高保底答题区 + embedded 题面 18px"
```

---

### Task 3: 提示→讲一讲 渐进式（全端统一）

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`（headerActions gate）
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`

- [ ] **Step 1: QuestionRunner gate headerActions**

`QuestionRunner.tsx` 约 244 行，把：

```tsx
            {(requestHint || headerActions) && (
              <div className="flex flex-col gap-2 shrink-0">
                {requestHint && (
```

改为：

```tsx
            {(requestHint || headerActions) && (
              <div className="flex flex-col gap-2 shrink-0">
                {requestHint && (
```

（结构不变；改的是内部 headerActions 的渲染行——见下。）

约 260 行 `{headerActions?.(q)}` 改为：

```tsx
                {/* 渐进式：提示开启时，「讲一讲」等 headerActions 仅在看过提示后出现（hints 有缓存即视为看过）；提示未开启时不 gate（向后兼容） */}
                {headerActions && (!requestHint || hints?.[q.n]) && headerActions(q)}
```

（AnswerModal 传的讲一讲按钮自动获得同一行为——课堂练习与训练轨全端统一；考试两者皆不传，不受影响。）

- [ ] **Step 2: TargetedRunPage 接线讲一讲**

`TargetedRunPage.tsx`：

1. import 区追加：

```ts
import { DiscussDrawer, DiscussIconButton } from '@/components/business/DiscussDrawer';
```

2. state 区（第 29 行 `finalResults` 之后）追加：

```ts
  // 「讲一讲」抽屉：打开时锚定当时题面（DiscussDrawer training 模式只需题面文本）
  const [discussQ, setDiscussQ] = useState<RunnerQuestion | null>(null);
```

3. `<QuestionRunner ... />` props（`onRequestHint` 同级）追加：

```tsx
            headerActions={(q) => (
              <DiscussIconButton onClick={() => setDiscussQ(q)} />
            )}
```

4. `<QuestionRunner ... />` 之后（`phase === 'result'` 三元之外、外层 `</div>` 之前——即 answering 态才显示）追加抽屉。注意外层容器需 relative 定位，把第 136 行容器改为：

```tsx
      <div className="relative h-screen flex flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
```

并在 QuestionRunner 之后追加：

```tsx
          {discussQ && phase === 'answering' && (
            <DiscussDrawer
              mode="training"
              questionText={discussQ.text}
              onClose={() => setDiscussQ(null)}
            />
          )}
```

（若 Task 2 已给容器加了 p-4 sm:p-6，此处只补 `relative`。）

- [ ] **Step 3: ErrorPracticeRunPage 接线（镜像 Step 2）**

与 Step 2 完全同构：import、`discussQ` state、`headerActions` prop、容器加 `relative`、抽屉渲染（`phase === 'answering'` 守卫）。

- [ ] **Step 4: lint + build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 均通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/answer/QuestionRunner.tsx apps/web/src/pages/student/training/TargetedRunPage.tsx apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx
git commit -m "feat(web): 提示->讲一讲渐进式交互（课堂练习与训练轨统一）"
```

---

### Task 4: 退出逻辑（X 确认 + 浏览器返回拦截 + 考试防刷新）

**Files:**
- Create: `apps/web/src/components/business/answer/RunExitGuard.tsx`
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`（onClose 签名）
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ExamRunPage.tsx`

- [ ] **Step 1: 新建 RunExitGuard 组件**

新建 `apps/web/src/components/business/answer/RunExitGuard.tsx`：

```tsx
// apps/web/src/components/business/answer/RunExitGuard.tsx
// 答题页导航守卫：拦截 react-router 路由内返回/跳转（useBlocker），确认后放行。
// 考试页再挂 blockBeforeUnload 拦截刷新/关标签（原生浏览器确认）。
// 注意：组件内部 useBlocker 必须无条件调用，所以「禁用」通过 enabled ref 实现——
// X 确认弹窗先 setEnabled(false) 再 navigate，避免二次拦截。
import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { Modal } from '@/components/base';

interface RunExitGuardProps {
  /** false 时放行导航（父层确认退出后先置 false 再 navigate） */
  enabled: boolean;
  /** 拦截刷新/关闭标签页（考试页用；浏览器原生确认，无法自定义文案） */
  blockBeforeUnload?: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function RunExitGuard({
  enabled,
  blockBeforeUnload = false,
  title,
  message,
  confirmLabel = '确认离开',
  cancelLabel = '继续答题',
}: RunExitGuardProps) {
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const blocker = useBlocker(() => enabledRef.current);

  useEffect(() => {
    if (!blockBeforeUnload) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [blockBeforeUnload]);

  if (blocker.state !== 'blocked') return null;

  return (
    <Modal open onClose={() => blocker.reset()} title={title}>
      <p className="text-sm text-[var(--text-secondary)]">{message}</p>
      <div className="mt-6 flex justify-end gap-3">
        <button
          onClick={() => blocker.reset()}
          className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
        >
          {cancelLabel}
        </button>
        <button
          onClick={() => blocker.proceed()}
          className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)]"
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: QuestionRunner onClose 传出已答数**

`QuestionRunner.tsx`：

1. props 注释与类型（约 58-59 行），把：

```ts
  /** 提供时作答态底部左侧渲染关闭 X（判题等待态的关闭入口由父层 judgingSlot 自理） */
  onClose?: () => void;
```

改为：

```ts
  /** 提供时作答态底部左侧渲染关闭 X，参数 answered = 已提交判题数（父层退出确认文案用；判题等待态的关闭入口由父层 judgingSlot 自理） */
  onClose?: (answered: number) => void;
```

2. X 按钮（约 316 行），把 `onClick={onClose}` 改为：

```tsx
                onClick={() => onClose(Object.keys(resultsRef.current).length)}
```

（AnswerModal 传 `onClose={handleClose}`，handleClose 不收参数——TS 兼容，行为不变。）

- [ ] **Step 3: TargetedRunPage 退出接线**

1. import 区追加：

```ts
import { Modal } from '@/components/base';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
```

2. state 区（Task 3 加的 `discussQ` 之后）追加：

```ts
  // 退出确认（X 按钮）：answered 由 QuestionRunner 传出
  const [exitConfirm, setExitConfirm] = useState<{ open: boolean; answered: number }>({ open: false, answered: 0 });
  // X 确认后放行导航（先置 false 再 navigate，绕开 RunExitGuard 二次拦截）
  const [guardEnabled, setGuardEnabled] = useState(true);
```

3. `<QuestionRunner ... />` 加 `onClose={(answered) => setExitConfirm({ open: true, answered })}`（与 `onFinish` 同级）。

4. JSX：`</QuestionRunner>` 之后（discussQ 抽屉之后、外层 `</div>` 之前）追加：

```tsx
          {/* X 退出确认（带已答进度） */}
          {exitConfirm.open && (
            <Modal open onClose={() => setExitConfirm({ open: false, answered: 0 })} title="退出练习">
              <p className="text-sm text-[var(--text-secondary)]">
                已答 {exitConfirm.answered}/{questions.length} 题，退出后未作答的题目不再保留。确定退出吗？
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={() => setExitConfirm({ open: false, answered: 0 })}
                  className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
                >
                  继续答题
                </button>
                <button
                  onClick={() => {
                    setGuardEnabled(false);
                    navigate('/student/training/targeted', { replace: true });
                  }}
                  className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)]"
                >
                  确认退出
                </button>
              </div>
            </Modal>
          )}
          {/* 浏览器返回/路由跳转拦截（X 确认已 setGuardEnabled(false) 故不二次弹） */}
          <RunExitGuard
            enabled={guardEnabled}
            title="离开练习"
            message="退出后未作答的题目将不再保留，确定要离开吗？"
            confirmLabel="确认离开"
          />
```

- [ ] **Step 4: ErrorPracticeRunPage 退出接线（镜像 Step 3）**

与 Step 3 完全同构，差异仅一处：确认退出 navigate 目标为 `'/student/training/errors'`（replace: true）。其余文案/结构一致。

- [ ] **Step 5: ExamRunPage 退出守卫（无 X，只拦截）**

1. import 区追加：

```ts
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
```

2. state 区追加：

```ts
  // 交卷成功跳结果页前放行导航（先置 false 再 navigate，绕开 RunExitGuard 拦截）
  const [guardEnabled, setGuardEnabled] = useState(true);
```

3. `handleSubmitExam`（约 139-150 行）成功分支，把：

```ts
      await submitExamSession(sid);
      navigate(`/student/training/exam/result/${sid}`, { replace: true });
```

改为：

```ts
      await submitExamSession(sid);
      setGuardEnabled(false);
      navigate(`/student/training/exam/result/${sid}`, { replace: true });
```

4. JSX 末尾（`{submitError && ...}` 块之后、外层 `</div>` 之前）追加：

```tsx
        {/* 考试无页内退出；拦截浏览器返回/刷新（计时不停，可续考） */}
        <RunExitGuard
          enabled={guardEnabled}
          blockBeforeUnload
          title="离开考试"
          message="离开后计时不会暂停，可从考试列表续考返回。确认离开吗？"
          confirmLabel="确认离开"
          cancelLabel="继续考试"
        />
```

（考试页容器同样已在 Task 2 加过 p-4 sm:p-6，无 relative 需求——考试无抽屉。）

- [ ] **Step 6: lint + build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 均通过。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/business/answer/RunExitGuard.tsx apps/web/src/components/business/answer/QuestionRunner.tsx apps/web/src/pages/student/training/TargetedRunPage.tsx apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx apps/web/src/pages/student/training/ExamRunPage.tsx
git commit -m "feat(web): 答题页退出确认 + 浏览器返回拦截 + 考试防刷新"
```

---

### Task 5: 列表/配置页顶部留白 + 全量验证

**Files:**
- Modify: `apps/web/src/pages/student/training/ExamListPage.tsx:214`
- Modify: `apps/web/src/pages/student/training/ErrorPracticePage.tsx:167`
- Modify: `apps/web/src/pages/student/training/TargetedConfigPage.tsx:186`

- [ ] **Step 1: 三个页面容器加 pt**

- `ExamListPage.tsx:214`：`<div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pb-16">` → `<div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pt-6 sm:pt-8 pb-16">`
- `ErrorPracticePage.tsx:167`：`<div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pb-32">` → 同位置加 `pt-6 sm:pt-8 `（保持 pb-32 不变）。
- `TargetedConfigPage.tsx:186`：`<div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pb-16">` → 同 ExamListPage 改法。

（TrainingHomePage 无 PageHeader（居中卡片页），不涉及；StarMapPage 为风格基准页，不动。）

- [ ] **Step 2: 全量验证**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 均通过。

Run: `cd apps/server && npm test`
Expected: 全绿（server 无改动，回归确认）。

- [ ] **Step 3: 浏览器走查（dev server 起着的前提下）**

逐项确认：
- 三个答题页顶部/底部留白舒适；题面 18px。
- 长题面内部滚动、答题区 ≥280px 可用。
- 渐进式（课堂练习 + 专项 + 错题三处）：初始只有「提示」→ 点开提示后浮现「讲一讲」→ 点开抽屉可对话（消息带题面上下文）。
- 考试无提示/讲一讲按钮。
- X 退出弹确认（含已答数）；浏览器返回被拦截弹确认；考试刷新弹原生确认。
- 列表/配置页 PageHeader 顶部有留白。
发现问题回改对应 Task。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/student/training/ExamListPage.tsx apps/web/src/pages/student/training/ErrorPracticePage.tsx apps/web/src/pages/student/training/TargetedConfigPage.tsx
git commit -m "fix(web): 训练轨列表/配置页 PageHeader 顶部留白"
```
