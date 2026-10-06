# 家长移动端第二批 A（2A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把家长端 5 个桌面功能搬上移动路由组（消息中心 / 学生管理 / 学习配置 / 学习目标 / 账号设置），全用既有端点，零后端改动。

**Architecture:** 延续 v1 方案 B（spec `2026-10-06-parent-mobile-batch2a-design.md`）：`/m/parent/*` 下加 5 条路由挂 `MobileParentLayout`，页面组件放 `src/pages/parent-mobile/`，复用 `services/api.ts`、`useParentStudentStore`、token 与三条通知条；`ParentViewportGate` 映射表与「更多」页同步扩充。

**Tech Stack:** React 19 + react-router 6（集中路由表 `routes/routeTable.tsx`）+ Zustand + Tailwind + vitest/@testing-library（`globals:false`）。

## Global Constraints（每个任务隐含遵守）

- **零后端改动**；桌面 13 页与其测试一行不动。
- 配色**全 token**（parent 主题）：`--text-secondary` #4B5563 / `--text-tertiary` #9CA3AF / `--bg-subtle` #E5E9F0 / `--error` #DC2626 / `--brand-500` #2563EB / `--bg-base` #F5F7FA。禁止 `text-black/60` 类快捷写法，改完 `grep -rn "black/\|text-red-\|text-green-" <新文件>` 应为 0。
- 测试自写 `afterEach(cleanup())`（`globals:false`）。
- 页面 `data-testid="mobile-page-<name>"` 挂**所有状态共用外层容器**（路由测试消费）。
- 换孩子：列表回第 1 页；派生状态带 `studentId` 归属；**学习配置例外**——按路径参数 id 取数，不读 store（与桌面一致）。
- **验收必经 Playwright WebKit（390×844）**；桌面 Chromium 绿不算测过移动端。
- vitest/build 必须 `cd apps/web` 后跑（根目录跑出 767 文件假失败）。

## 对 spec 的一处实现层澄清

spec §4.3 说学习配置页「不读 parentStudentStore」：实现上路由是 `/m/parent/students/:id/config`，id 从 `useParams` 取。桌面端语义为「配置的是路径指定的孩子」，保持一致。

## File Structure

```
apps/web/src/routes/ParentViewportGate.tsx               # Task 1 修改（映射扩充）
apps/web/src/routes/ParentViewportGate.test.tsx          # Task 1 补用例
apps/web/src/pages/parent-mobile/MobileMorePage.tsx      # Task 1 修改（入口/占位两组）
apps/web/src/pages/parent-mobile/MobileMessagesPage.tsx  # Task 2（+test）
apps/web/src/pages/parent-mobile/MobileStudentsPage.tsx  # Task 3（+test）
apps/web/src/pages/parent-mobile/MobileSubjectConfigPage.tsx # Task 4（+test）
apps/web/src/pages/parent-mobile/MobileGoalsPage.tsx     # Task 5（+test）
apps/web/src/pages/parent-mobile/MobileAccountPage.tsx   # Task 6（+test）
apps/web/src/routes/routeTable.tsx                       # Task 1 修改（5 条路由 + import）
apps/web/src/routes/mobileParentRoutes.test.tsx          # Task 1 补用例
docs/ai-core-changelog.md                                # Task 7
docs/UX-UI设计文档.md                                     # Task 7（§5.10 扩充）
```

---

### Task 1: 路由 + 视口守卫映射 + 「更多」页入口/占位分组

**Files:**
- Modify: `apps/web/src/routes/ParentViewportGate.tsx`、`apps/web/src/routes/ParentViewportGate.test.tsx`
- Modify: `apps/web/src/pages/parent-mobile/MobileMorePage.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`、`apps/web/src/routes/mobileParentRoutes.test.tsx`
- Create: `apps/web/src/pages/parent-mobile/` 下 5 个占位空壳（`MobileMessagesPage/MobileStudentsPage/MobileSubjectConfigPage/MobileGoalsPage/MobileAccountPage.tsx`，内容均为 `export default function MobileXxx() { return <div data-testid="mobile-page-xxx" />; }`，Task 2–6 逐个替换）

**Interfaces:**
- Consumes: 既有 `MobileMorePage.MOBILE_MORE_ITEMS`、`ParentViewportGate.mobileParentPath`。
- Produces: `mobileParentPath` 支持带 id 子路径；`MobileMorePage` 导出 `MOBILE_LIVE_ITEMS`（`Array<{key,label,to}>`）与 `MOBILE_STUB_ITEMS`（`Array<{key,label}>`）。

- [ ] **Step 1: 更新守卫与更多页测试（先失败）**

`ParentViewportGate.test.tsx`：在现有 `describe` 内追加两条用例，并给 router 增加 `/m/parent/students`、`/m/parent/messages`、`/m/parent/goals`、`/m/parent/account`、`/m/parent/students/7/config` 桩路由：

```tsx
it('mobileParentPath：新增 2A 段映射到真实移动页（含带 id 的 config）', () => {
  expect(mobileParentPath('/parent/messages')).toBe('/m/parent/messages');
  expect(mobileParentPath('/parent/students')).toBe('/m/parent/students');
  expect(mobileParentPath('/parent/goals')).toBe('/m/parent/goals');
  expect(mobileParentPath('/parent/account')).toBe('/m/parent/account');
  expect(mobileParentPath('/parent/students/7/config')).toBe('/m/parent/students/7/config');
});

it('窄屏访问 /parent/students/7/config → 直跳移动配置页', () => {
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  renderGate('/parent/students/7/config');
  expect(screen.getByTestId('m-config')).toBeTruthy();
});
```

`mobileParentRoutes.test.tsx` 追加：

```tsx
it('更多页区分真实入口与占位两组', async () => {
  renderAt('/m/parent/more');
  expect(await screen.findByTestId('more-live-students')).toBeTruthy();
  expect(screen.getByTestId('more-live-messages')).toBeTruthy();
  expect(screen.getByTestId('more-stub-subscription')).toBeTruthy();
  expect(screen.getByTestId('more-stub-points')).toBeTruthy();
});
```

Run: `cd apps/web && npx vitest run src/routes/ src/pages/parent-mobile/MobileMorePage.test.tsx 2>/dev/null || npx vitest run src/routes/`
Expected: FAIL（映射不存在、入口不存在）

- [ ] **Step 2: 实现**

`ParentViewportGate.tsx` 全文替换为：

```tsx
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { MOBILE_VIEWPORT_BREAKPOINT } from '@/constants';

const MOBILE_SUPPORTED = new Set(['dashboard', 'alerts', 'errors', 'controls', 'messages', 'students', 'goals', 'account']);
const MORE_STUBS = new Set(['subscription', 'points', 'report', 'chat-logs']);

/** 桌面家长路径 → 移动路径（2A 起支持带 id 的 config 子路径直跳）。 */
export function mobileParentPath(pathname: string): string {
  const rest = pathname.replace(/^\/parent\/?/, '');
  if (/^students\/\d+\/config$/.test(rest)) return `/m/parent/${rest}`;
  const seg = rest.split('/')[0];
  if (MOBILE_SUPPORTED.has(seg)) return `/m/parent/${seg}`;
  if (seg === 'rewards') return '/m/parent/more/points';
  if (MORE_STUBS.has(seg)) return `/m/parent/more/${seg}`;
  return '/m/parent/more/students';
}

export default function ParentViewportGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  if (window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT) {
    return <Navigate to={mobileParentPath(pathname)} replace />;
  }
  return <>{children}</>;
}
```

（原文件里的中文裁决注释移到函数上方保留：窄屏守卫动机 + 不做双向监听的原因，逐字照抄旧文件注释段。）

`MobileMorePage.tsx` 全文替换为：

```tsx
import { Link, useParams } from 'react-router-dom';

/** 2A 起拆两组：live = 已上手机的真实入口；stub = 仍指向电脑端（订阅等用户裁决延后）。 */
export const MOBILE_LIVE_ITEMS = [
  { key: 'students', label: '学生管理', to: '/m/parent/students' },
  { key: 'messages', label: '消息中心', to: '/m/parent/messages' },
  { key: 'goals', label: '学习目标', to: '/m/parent/goals' },
  { key: 'account', label: '账号设置', to: '/m/parent/account' },
] as const;

export const MOBILE_STUB_ITEMS = [
  { key: 'subscription', label: '订阅管理' },
  { key: 'points', label: '积分与兑换' },
  { key: 'report', label: '学习报告' },
  { key: 'chat-logs', label: 'AI 对话记录' },
] as const;

export default function MobileMorePage() {
  const { name } = useParams();
  if (name) {
    const stub = MOBILE_STUB_ITEMS.find((i) => i.key === name);
    return (
      <div data-testid="mobile-page-stub" className="rounded-2xl bg-white p-8 text-center">
        <p className="text-lg font-bold">{stub?.label ?? '该功能'}</p>
        <p className="mt-2 text-[var(--text-secondary)]">该功能请在电脑端使用</p>
      </div>
    );
  }
  return (
    <div data-testid="mobile-page-more" className="space-y-3">
      <div className="divide-y divide-[var(--bg-subtle)] rounded-2xl bg-white">
        {MOBILE_LIVE_ITEMS.map((i) => (
          <Link key={i.key} to={i.to} data-testid={`more-live-${i.key}`} className="block px-5 py-4">
            {i.label}
          </Link>
        ))}
      </div>
      <div className="divide-y divide-[var(--bg-subtle)] rounded-2xl bg-white">
        {MOBILE_STUB_ITEMS.map((i) => (
          <Link key={i.key} to={`/m/parent/more/${i.key}`} data-testid={`more-stub-${i.key}`} className="block px-5 py-4 text-[var(--text-secondary)]">
            {i.label}
            <span className="ml-2 text-xs text-[var(--text-tertiary)]">电脑端</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

`routeTable.tsx`：`/m/parent` children 追加 5 条（页面先 import Task 1 建的占位空壳）：

```tsx
{ path: 'messages', element: <MobileMessagesPage /> },
{ path: 'students', element: <MobileStudentsPage /> },
{ path: 'students/:id/config', element: <MobileSubjectConfigPage /> },
{ path: 'goals', element: <MobileGoalsPage /> },
{ path: 'account', element: <MobileAccountPage /> },
```

- [ ] **Step 3: 跑测试 + 全量 + tsc**

Run: `cd apps/web && npx vitest run src/routes/ src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b`
Expected: PASS；全量绿（含 `routeTable.test.tsx`、既有 `ParentViewportGate` 用例）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端 2A 路由骨架 + 视口守卫映射扩充 + 更多页入口分组（Task 1）"
```

---

### Task 2: 消息中心 MobileMessagesPage

**Files:**
- Modify: `apps/web/src/pages/parent-mobile/MobileMessagesPage.tsx`（替换占位）
- Test: `apps/web/src/pages/parent-mobile/MobileMessagesPage.test.tsx`

**Interfaces:**
- Consumes: `listMyMessages(): Promise<ParentMessageItem[]>`、`getUnreadMessageCount(): Promise<number>`、`markMessageRead(id): Promise<null>`（api.ts:881-884）；`ParentMessageItem = { id, type, title, content, isRead, isBroadcast, createdAt }`。
- Produces: `data-testid="mobile-page-messages"`（外层容器，所有状态可见）。

- [ ] **Step 1: 写失败测试**

```tsx
// MobileMessagesPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileMessagesPage from './MobileMessagesPage';

afterEach(cleanup);

vi.mock('@/services/api', () => ({
  listMyMessages: vi.fn(),
  getUnreadMessageCount: vi.fn(),
  markMessageRead: vi.fn(),
}));
import { getUnreadMessageCount, listMyMessages, markMessageRead } from '@/services/api';

const msgs = [
  { id: 1, type: 'broadcast', title: '假期安排', content: '国庆期间照常开放。', isRead: true, isBroadcast: true, createdAt: '2026-10-01T09:00:00Z' },
  { id: 2, type: 'notice', title: '预警提醒', content: '孩子连续 3 次发起闲聊。', isRead: false, isBroadcast: false, createdAt: '2026-10-02T10:00:00Z' },
];

describe('MobileMessagesPage', () => {
  it('渲染消息列表与未读数', async () => {
    vi.mocked(listMyMessages).mockResolvedValue(msgs as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(1);
    render(<MobileMessagesPage />);
    expect(await screen.findByText('假期安排')).toBeTruthy();
    expect(screen.getByText(/1 条未读/)).toBeTruthy();
    // 收起态不显示正文
    expect(screen.queryByText('孩子连续 3 次发起闲聊。')).toBeNull();
  });

  it('点条目展开全文并标记已读', async () => {
    vi.mocked(listMyMessages).mockResolvedValue(msgs as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(1);
    vi.mocked(markMessageRead).mockResolvedValue(null);
    render(<MobileMessagesPage />);
    await screen.findByText('预警提醒');
    await userEvent.click(screen.getByTestId('msg-item-2'));
    expect(await screen.findByText(/孩子连续 3 次发起闲聊/)).toBeTruthy();
    expect(markMessageRead).toHaveBeenCalledWith(2);
    await waitFor(() => expect(screen.getByTestId('msg-item-2').textContent).toContain('已读'));
  });

  it('markMessageRead 失败静默：条目仍展开、不消失', async () => {
    vi.mocked(listMyMessages).mockResolvedValue(msgs as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(0);
    vi.mocked(markMessageRead).mockRejectedValue(new Error('x'));
    render(<MobileMessagesPage />);
    await screen.findByText('预警提醒');
    await userEvent.click(screen.getByTestId('msg-item-2'));
    expect(await screen.findByText(/孩子连续 3 次发起闲聊/)).toBeTruthy();
    expect(screen.getByTestId('msg-item-2')).toBeTruthy();
  });

  it('空态与错误重试', async () => {
    vi.mocked(listMyMessages).mockResolvedValue([] as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(0);
    const { unmount } = render(<MobileMessagesPage />);
    expect(await screen.findByText(/暂无消息/)).toBeTruthy();
    unmount();
    vi.mocked(listMyMessages).mockRejectedValue(new Error('x'));
    render(<MobileMessagesPage />);
    expect(await screen.findByTestId('messages-retry')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileMessagesPage.test.tsx`
Expected: FAIL（占位空壳）

- [ ] **Step 3: 实现**

```tsx
// MobileMessagesPage.tsx
import { useCallback, useEffect, useState } from 'react';
import {
  getUnreadMessageCount, listMyMessages, markMessageRead, type ParentMessageItem,
} from '@/services/api';

type LoadStatus = 'loading' | 'ready' | 'error';

export default function MobileMessagesPage() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [messages, setMessages] = useState<ParentMessageItem[] | null>(null);
  const [error, setError] = useState(false);
  const [unread, setUnread] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(() => {
    setError(false);
    listMyMessages()
      .then((list) => { setMessages(list); setStatus('ready'); })
      .catch(() => setError(true));
  }, []);

  useEffect(() => { load(); }, [load]);
  // 未读数自轮询（30s，语义与桌面一致；本页自建定时器实例）
  useEffect(() => {
    const tick = () => getUnreadMessageCount().then(setUnread).catch(() => {});
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const expand = (m: ParentMessageItem) => {
    setExpandedId(expandedId === m.id ? null : m.id);
    if (!m.isRead) {
      markMessageRead(m.id)
        .then(() => setMessages((prev) => prev?.map((x) => (x.id === m.id ? { ...x, isRead: true } : x)) ?? prev))
        .catch(() => { /* 已读失败静默：条目保留，下次进页以服务端为准 */ });
    }
  };

  return (
    <div data-testid="mobile-page-messages" className="space-y-3">
      {unread !== null && <p className="rounded-2xl bg-white px-4 py-3 text-sm">{unread} 条未读</p>}
      {error ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="messages-retry" onClick={load} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : messages === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : messages.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-[var(--text-secondary)]">暂无消息</p>
      ) : (
        <ul className="space-y-2">
          {messages.map((m) => (
            <li key={m.id}>
              <button
                data-testid={`msg-item-${m.id}`}
                onClick={() => expand(m)}
                className="w-full rounded-2xl bg-white p-4 text-left"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">{m.title}</span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {m.isBroadcast ? '广播 · ' : ''}{m.isRead ? '已读' : '未读'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {new Date(m.createdAt).toLocaleString('zh-CN')}
                </p>
                {expandedId === m.id && (
                  <p className="mt-2 border-t border-[var(--bg-subtle)] pt-2 text-sm">{m.content}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试 + 全量 + tsc + build**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: PASS；全量绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端消息中心（展开即已读 + 未读轮询）（Task 2）"
```

---

### Task 3: 学生管理 MobileStudentsPage

**Files:**
- Modify: `apps/web/src/pages/parent-mobile/MobileStudentsPage.tsx`（替换占位）
- Test: `apps/web/src/pages/parent-mobile/MobileStudentsPage.test.tsx`

**Interfaces:**
- Consumes: `listMyStudents(): Promise<MyStudentItem[]>`（`MyStudentItem = { id, parentId, username, name, age, grade, schoolLevel, isActive }`）、`createStudent(req: { name, username, password, age: number, grade: string }): Promise<{ id: number }>`、`resetStudentPassword(id, newPassword): Promise<null>`、`setStudentStatus(id, isActive): Promise<null>`。
- Produces: `data-testid="mobile-page-students"`；`GRADES` 年级数组（Task 4 不用，仅本页）。

- [ ] **Step 1: 写失败测试**

```tsx
// MobileStudentsPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileStudentsPage from './MobileStudentsPage';

afterEach(cleanup);

vi.mock('@/services/api', () => ({
  listMyStudents: vi.fn(),
  createStudent: vi.fn(),
  resetStudentPassword: vi.fn(),
  setStudentStatus: vi.fn(),
}));
import { createStudent, listMyStudents, resetStudentPassword, setStudentStatus } from '@/services/api';

const students = [
  { id: 1, parentId: 9, username: 'stu1', name: '小明', age: 10, grade: '四年级', schoolLevel: 'primary', isActive: true },
];

describe('MobileStudentsPage', () => {
  it('渲染学生列表与状态', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    render(<MobileStudentsPage />);
    expect(await screen.findByText('小明')).toBeTruthy();
    expect(screen.getByText(/状态正常/)).toBeTruthy();
    expect(screen.getByTestId('student-create-toggle')).toBeTruthy();
  });

  it('新建学生：必填校验拦截 + 成功后刷新列表', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    vi.mocked(createStudent).mockResolvedValue({ id: 2 });
    render(<MobileStudentsPage />);
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-create-toggle'));
    // 空表单直接提交被拦
    await userEvent.click(screen.getByTestId('student-create-submit'));
    expect(createStudent).not.toHaveBeenCalled();
    // 填齐后提交
    await userEvent.type(screen.getByLabelText('姓名'), '小红');
    await userEvent.type(screen.getByLabelText('用户名'), 'stu2');
    await userEvent.type(screen.getByLabelText('初始密码'), 'pw123456');
    await userEvent.type(screen.getByLabelText('年龄'), '8');
    await userEvent.selectOptions(screen.getByLabelText('年级'), '小学二年级');
    await userEvent.click(screen.getByTestId('student-create-submit'));
    await waitFor(() => expect(createStudent).toHaveBeenCalledWith({ name: '小红', username: 'stu2', password: 'pw123456', age: 8, grade: '小学二年级' }));
    expect(await screen.findByText('小红')).toBeTruthy();
  });

  it('createStudent 失败（用户名冲突 1004）原样展示错误', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    vi.mocked(createStudent).mockRejectedValue(new Error('用户名已存在'));
    render(<MobileStudentsPage />);
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-create-toggle'));
    await userEvent.type(screen.getByLabelText('姓名'), '小红');
    await userEvent.type(screen.getByLabelText('用户名'), 'stu1');
    await userEvent.type(screen.getByLabelText('初始密码'), 'pw123456');
    await userEvent.type(screen.getByLabelText('年龄'), '8');
    await userEvent.selectOptions(screen.getByLabelText('年级'), '小学二年级');
    await userEvent.click(screen.getByTestId('student-create-submit'));
    expect(await screen.findByText(/用户名已存在/)).toBeTruthy();
  });

  it('重置密码：新密码 6-32 位 + 成功提示', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    vi.mocked(resetStudentPassword).mockResolvedValue(null);
    render(<MobileStudentsPage />);
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-reset-toggle-1'));
    const input = screen.getByPlaceholderText('输入新密码（6-32 位）');
    await userEvent.type(input, '123');
    await userEvent.click(screen.getByTestId('student-reset-submit-1'));
    expect(resetStudentPassword).not.toHaveBeenCalled();
    await userEvent.type(input, '456');
    await userEvent.click(screen.getByTestId('student-reset-submit-1'));
    await waitFor(() => expect(resetStudentPassword).toHaveBeenCalledWith(1, '123456'));
    expect(await screen.findByText(/已重置 小明 的密码/)).toBeTruthy();
  });

  it('停用/启用切换', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    vi.mocked(setStudentStatus).mockResolvedValue(null);
    render(<MobileStudentsPage />);
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-status-toggle-1'));
    await waitFor(() => expect(setStudentStatus).toHaveBeenCalledWith(1, false));
    expect(await screen.findByText(/已停用/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileStudentsPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// MobileStudentsPage.tsx
import { useCallback, useEffect, useState } from 'react';
import { createStudent, listMyStudents, resetStudentPassword, setStudentStatus, type MyStudentItem } from '@/services/api';

type LoadStatus = 'loading' | 'ready' | 'error';

const GRADES = [
  '小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级',
  '初一', '初二', '初三', '高一', '高二', '高三',
];
const emptyForm = { name: '', username: '', password: '', age: '', grade: '小学一年级' };

export default function MobileStudentsPage() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [students, setStudents] = useState<MyStudentItem[] | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [resetId, setResetId] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(false);
    listMyStudents()
      .then((list) => { setStudents(list); setStatus('ready'); })
      .catch(() => setError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const submitCreate = () => {
    const age = Number(form.age);
    if (!form.name.trim() || !form.username.trim() || form.password.length < 6 || !Number.isInteger(age) || age <= 0 || !form.grade) {
      setFormError('请填齐全部字段；密码至少 6 位；年龄须为正整数');
      return;
    }
    setFormError(null);
    createStudent({ name: form.name.trim(), username: form.username.trim(), password: form.password, age, grade: form.grade })
      .then(() => {
        setActionMsg(`学生账号 ${form.name.trim()} 已开通`);
        setForm(emptyForm);
        setCreating(false);
        load();
      })
      .catch((e: unknown) => setFormError(e instanceof Error ? e.message : '开通失败'));
  };

  const submitReset = () => {
    if (resetId === null) return;
    if (newPassword.length < 6 || newPassword.length > 32) {
      setActionMsg('新密码需 6-32 位');
      return;
    }
    const target = students?.find((s) => s.id === resetId);
    resetStudentPassword(resetId, newPassword)
      .then(() => { setActionMsg(`已重置 ${target?.name ?? '学生'} 的密码：${newPassword}`); setResetId(null); setNewPassword(''); })
      .catch((e: unknown) => setActionMsg(e instanceof Error ? e.message : '操作失败'));
  };

  const toggleStatus = (s: MyStudentItem) => {
    setStudentStatus(s.id, !s.isActive)
      .then(() => setStudents((prev) => prev?.map((x) => (x.id === s.id ? { ...x, isActive: !x.isActive } : x)) ?? prev))
      .then(() => setActionMsg(s.isActive ? `已停用 ${s.name} 的账号` : `已启用 ${s.name} 的账号`))
      .catch((e: unknown) => setActionMsg(e instanceof Error ? e.message : '操作失败'));
  };

  return (
    <div data-testid="mobile-page-students" className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-tertiary)]">为每个孩子开通独立学习账号</p>
        <button data-testid="student-create-toggle" onClick={() => { setCreating((v) => !v); setFormError(null); }} className="rounded-xl bg-[var(--brand-500)] px-3 py-1.5 text-sm text-white">
          {creating ? '收起' : '新建学生'}
        </button>
      </div>
      {creating && (
        <div className="space-y-2 rounded-2xl bg-white p-4">
          {[['姓名', 'name', 'text'], ['用户名', 'username', 'text'], ['初始密码', 'password', 'password']] .map(([label, key, type]) => (
            <div key={key}>
              <label className="text-xs text-[var(--text-secondary)]">{label}</label>
              <input aria-label={label} type={type} value={form[key as keyof typeof form]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm" />
            </div>
          ))}
          <div>
            <label className="text-xs text-[var(--text-secondary)]">年龄</label>
            <input aria-label="年龄" inputMode="numeric" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-[var(--text-secondary)]">年级</label>
            <select aria-label="年级" value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm">
              {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          {formError && <p className="text-xs text-[var(--error)]">{formError}</p>}
          <button data-testid="student-create-submit" onClick={submitCreate} className="w-full rounded-xl bg-[var(--brand-500)] py-2 text-sm text-white">开通学生账号</button>
        </div>
      )}
      {error ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="students-retry" onClick={load} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : status === 'loading' || students === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : (
        <ul className="space-y-2">
          {students.map((s) => (
            <li key={s.id} className="rounded-2xl bg-white p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold">{s.name}</p>
                  <p className="text-xs text-[var(--text-tertiary)]">{s.grade ?? '年级未设'} · {s.age ?? '—'} 岁</p>
                </div>
                <span className="text-xs text-[var(--text-tertiary)]">{s.isActive ? '状态正常' : '已停用'}</span>
              </div>
              <div className="mt-2 flex gap-2 text-xs">
                <button data-testid={`student-reset-toggle-${s.id}`} onClick={() => { setResetId(resetId === s.id ? null : s.id); setNewPassword(''); }} className="rounded-lg border border-[var(--bg-subtle)] px-3 py-1.5">重置密码</button>
                <button data-testid={`student-status-toggle-${s.id}`} onClick={() => toggleStatus(s)} className="rounded-lg border border-[var(--bg-subtle)] px-3 py-1.5">{s.isActive ? '停用账号' : '启用账号'}</button>
              </div>
              {resetId === s.id && (
                <div className="mt-2 flex gap-2">
                  <input placeholder="输入新密码（6-32 位）" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm" />
                  <button data-testid={`student-reset-submit-${s.id}`} onClick={submitReset} className="rounded-xl bg-[var(--brand-500)] px-3 py-2 text-sm text-white">确认</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {actionMsg && <p className="px-2 text-sm text-[var(--text-secondary)]">{actionMsg}</p>}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试 + 全量 + tsc + build**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: PASS；全量绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端学生管理（新建/重置密码/停用启用）（Task 3）"
```

---

### Task 4: 学习配置 MobileSubjectConfigPage

**Files:**
- Modify: `apps/web/src/pages/parent-mobile/MobileSubjectConfigPage.tsx`（替换占位）
- Test: `apps/web/src/pages/parent-mobile/MobileSubjectConfigPage.test.tsx`

**Interfaces:**
- Consumes: `useParams()` 的 `id`；`getStudentSubjectConfigs(id): Promise<SubjectConfigsResponse>`（`{ studentId, studentName, subjects: SubjectConfigState[], options: SubjectConfigOption[] }`；`SubjectConfigState = { subjectId, subjectName, configured, started, gradeCode, term, textbookVersionId, publisher, edition }`；`SubjectConfigOption = { subjectId, subjectName, grades: [{ code, label, versions: [{ id, name, publisher, edition, gradeBand, terms: string[] }] }] }`）；`updateStudentSubjectConfig(id, subjectId, { gradeCode, term: 'first'|'second', textbookVersionId }): Promise<{ reset: boolean }>`。
- Produces: `data-testid="mobile-page-config"`。

**行为语义（照抄桌面 StudentSubjectConfigPage，勿自行发明）：**
- 每科选择三元组 `{ gradeCode, term, versionId }`；改年级 → 该年级第一套版本 + 首选册别（`terms.includes('first') ? 'first' : terms[0] ?? 'first'`）。
- 有改动的科目才显示保存按钮（dirty = 与 `SubjectConfigState` 三元组不等）。
- 保存前弹确认（`ConfirmDialog`，文案含「切换教材将重置该学科学习进度」）；保存后 `res.reset === true` → toast `已切换 X 教材，该学科学习进度已重置`，否则 `已保存 X 教材配置`；随后 `load()` 重拉。

- [ ] **Step 1: 写失败测试**

```tsx
// MobileSubjectConfigPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import MobileSubjectConfigPage from './MobileSubjectConfigPage';

afterEach(cleanup);

vi.mock('@/services/api', () => ({
  getStudentSubjectConfigs: vi.fn(),
  updateStudentSubjectConfig: vi.fn(),
}));
import { getStudentSubjectConfigs, updateStudentSubjectConfig } from '@/services/api';

const resp = {
  studentId: 7,
  studentName: 'lc1',
  subjects: [
    { subjectId: 2, subjectName: '数学', configured: true, started: true, gradeCode: 'G7', term: 'first', textbookVersionId: 10, publisher: '人教社', edition: '' },
  ],
  options: [
    { subjectId: 2, subjectName: '数学', grades: [
      { code: 'G7', label: '初一', versions: [{ id: 10, name: '人教版', publisher: '人教社', edition: '', gradeBand: 'junior', terms: ['first', 'second'] }] },
      { code: 'G8', label: '初二', versions: [{ id: 11, name: '北师大版', publisher: '北师大社', edition: '', gradeBand: 'junior', terms: ['first', 'second'] }] },
    ] },
  ],
};

function renderAtId(id = '7') {
  render(
    <MemoryRouter initialEntries={[`/m/parent/students/${id}/config`]}>
      <Routes>
        <Route path="/m/parent/students/:id/config" element={<MobileSubjectConfigPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MobileSubjectConfigPage', () => {
  it('渲染各学科当前配置（按路径 id 取数，不读切换器锚点）', async () => {
    vi.mocked(getStudentSubjectConfigs).mockResolvedValue(resp as never);
    renderAtId('7');
    expect(await screen.findByText('数学')).toBeTruthy();
    expect(screen.getByText(/人教版/)).toBeTruthy();
    expect(getStudentSubjectConfigs).toHaveBeenCalledWith(7);
  });

  it('改年级后保存：确认弹窗 + reset 提示 + 重拉', async () => {
    vi.mocked(getStudentSubjectConfigs).mockResolvedValue(resp as never);
    vi.mocked(updateStudentSubjectConfig).mockResolvedValue({ subjectId: 2, textbookVersionId: 11, semesterId: 5, reset: true });
    renderAtId('7');
    await screen.findByText('数学');
    // 改年级 → 初二（联动切版本 11、册别 first）
    await userEvent.selectOptions(screen.getByLabelText('数学-年级'), 'G8');
    await userEvent.click(screen.getByTestId('config-save-2'));
    // 确认弹窗
    await userEvent.click(screen.getByTestId('config-confirm-ok'));
    await waitFor(() =>
      expect(updateStudentSubjectConfig).toHaveBeenCalledWith(7, 2, { gradeCode: 'G8', term: 'first', textbookVersionId: 11 }),
    );
    expect(await screen.findByText(/该学科学习进度已重置/)).toBeTruthy();
    await waitFor(() => expect(getStudentSubjectConfigs).toHaveBeenCalledTimes(2));
  });

  it('无改动不显示保存按钮', async () => {
    vi.mocked(getStudentSubjectConfigs).mockResolvedValue(resp as never);
    renderAtId('7');
    await screen.findByText('数学');
    expect(screen.queryByTestId('config-save-2')).toBeNull();
  });

  it('加载失败显示错误重试', async () => {
    vi.mocked(getStudentSubjectConfigs).mockRejectedValue(new Error('x'));
    renderAtId('7');
    expect(await screen.findByTestId('config-retry')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileSubjectConfigPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// MobileSubjectConfigPage.tsx
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ConfirmDialog, toast } from '@/components/base';
import {
  getStudentSubjectConfigs, updateStudentSubjectConfig,
  type SubjectConfigOption, type SubjectConfigState,
} from '@/services/api';

type LoadStatus = 'loading' | 'ready' | 'error';
type Selection = { gradeCode: string; term: string; versionId: number };

/** 从 options 里解析该科的三元组（照抄桌面 resolveSelection 语义）。 */
function resolveSelection(option: SubjectConfigOption, state: SubjectConfigState): Selection {
  const grade = state.gradeCode
    ? option.grades.find((g) => g.code === state.gradeCode) ?? option.grades[0]
    : option.grades[0];
  const version = state.textbookVersionId != null && grade.versions.some((v) => v.id === state.textbookVersionId)
    ? grade.versions.find((v) => v.id === state.textbookVersionId)!
    : grade.versions[0];
  const term = state.term && version.terms.includes(state.term) ? state.term : version.terms[0] ?? 'first';
  return { gradeCode: grade.code, term, versionId: version.id };
}

export default function MobileSubjectConfigPage() {
  const { id } = useParams();
  const studentId = Number(id);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [data, setData] = useState<Awaited<ReturnType<typeof getStudentSubjectConfigs>> | null>(null);
  const [error, setError] = useState(false);
  const [selections, setSelections] = useState<Record<number, Selection>>({});
  const [confirmSubject, setConfirmSubject] = useState<SubjectConfigState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!Number.isInteger(studentId)) return;
    setError(false);
    setStatus('loading');
    getStudentSubjectConfigs(studentId)
      .then((res) => {
        setData(res);
        setSelections(Object.fromEntries(res.subjects.map((s) => {
          const option = res.options.find((o) => o.subjectId === s.subjectId);
          return [s.subjectId, option ? resolveSelection(option, s) : { gradeCode: s.gradeCode ?? '', term: s.term ?? 'first', versionId: s.textbookVersionId ?? 0 }];
        })));
        setStatus('ready');
      })
      .catch(() => setError(true));
  }, [studentId]);

  useEffect(() => { load(); }, [load]);

  if (!Number.isInteger(studentId)) {
    return <div data-testid="mobile-page-config" className="text-[var(--text-secondary)]">无效的学生</div>;
  }
  if (error) {
    return (
      <div data-testid="mobile-page-config">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="config-retry" onClick={load} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      </div>
    );
  }
  if (status === 'loading' || data === null) {
    return <div data-testid="mobile-page-config"><div className="h-24 animate-pulse rounded-2xl bg-white" /></div>;
  }

  const save = (s: SubjectConfigState) => {
    const sel = selections[s.subjectId];
    if (!sel) return;
    setSaving(true);
    updateStudentSubjectConfig(studentId, s.subjectId, {
      gradeCode: sel.gradeCode,
      term: sel.term as 'first' | 'second',
      textbookVersionId: sel.versionId,
    })
      .then((res) => {
        setConfirmSubject(null);
        toast('success', res.reset ? `已切换 ${s.subjectName} 教材，该学科学习进度已重置` : `已保存 ${s.subjectName} 教材配置`);
        load();
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '保存失败'))
      .finally(() => setSaving(false));
  };

  return (
    <div data-testid="mobile-page-config" className="space-y-3">
      <p className="px-1 text-xs text-[var(--text-tertiary)]">配置对象：{data.studentName ?? `学生 #${studentId}`}。切换教材将重置该学科学习进度（历史记录保留）。</p>
      {data.subjects.map((s) => {
        const option = data.options.find((o) => o.subjectId === s.subjectId);
        const sel = selections[s.subjectId];
        if (!option || !sel) return null;
        const grade = option.grades.find((g) => g.code === sel.gradeCode);
        const dirty = s.gradeCode !== sel.gradeCode || s.term !== sel.term || s.textbookVersionId !== sel.versionId;
        return (
          <div key={s.subjectId} className="rounded-2xl bg-white p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold">{s.subjectName}</p>
              <span className="text-xs text-[var(--text-tertiary)]">{s.configured ? (s.started ? '学习中' : '已配置') : '未配置'}</span>
            </div>
            <div className="mt-2 space-y-2 text-sm">
              <div>
                <label className="text-xs text-[var(--text-secondary)]">年级</label>
                <select aria-label={`${s.subjectName}-年级`} value={sel.gradeCode}
                  onChange={(e) => {
                    const g = option.grades.find((x) => x.code === e.target.value)!;
                    const version = g.versions[0];
                    setSelections((prev) => ({ ...prev, [s.subjectId]: { gradeCode: g.code, term: version.terms.includes('first') ? 'first' : version.terms[0] ?? 'first', versionId: version.id } }));
                  }}
                  className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2">
                  {option.grades.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-[var(--text-secondary)]">版本</label>
                <select aria-label={`${s.subjectName}-版本`} value={sel.versionId}
                  onChange={(e) => setSelections((prev) => ({ ...prev, [s.subjectId]: { ...sel, versionId: Number(e.target.value) } }))}
                  className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2">
                  {(grade?.versions ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.edition ? `（${v.edition}）` : ''}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-[var(--text-secondary)]">册别</label>
                <select aria-label={`${s.subjectName}-册别`} value={sel.term}
                  onChange={(e) => setSelections((prev) => ({ ...prev, [s.subjectId]: { ...sel, term: e.target.value } }))}
                  className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2">
                  {(grade?.versions.find((v) => v.id === sel.versionId)?.terms ?? []).map((t) => (
                    <option key={t} value={t}>{t === 'first' ? '上册' : '下册'}</option>
                  ))}
                </select>
              </div>
            </div>
            {dirty && (
              <button data-testid={`config-save-${s.subjectId}`} onClick={() => setConfirmSubject(s)} disabled={saving}
                className="mt-3 w-full rounded-xl bg-[var(--brand-500)] py-2 text-sm text-white">
                保存{saving ? '中…' : ''}
              </button>
            )}
          </div>
        );
      })}
      {confirmSubject && (
        <ConfirmDialog
          title={`保存 ${confirmSubject.subjectName} 教材配置`}
          message="切换教材将重置该学科学习进度（历史记录保留）。确认保存？"
          onConfirm={() => save(confirmSubject)}
          onCancel={() => setConfirmSubject(null)}
        />
      )}
    </div>
  );
}
```

⚠️ 实施第一步核对 `ConfirmDialog` 的真实 props（`apps/web/src/components/base/ConfirmDialog.tsx`；桌面 `CourseDetailPage.tsx:14` 有用法）。若 props 形状不同（如 `confirmText`），以真源为准适配，测试的 `config-confirm-ok` 改成实际确认按钮的可寻址方式（如 `getByRole('button', { name: '确认' })`）。

- [ ] **Step 4: 跑测试 + 全量 + tsc + build**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: PASS；全量绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端学习配置（学科教材/册别选择 + reset 提示）（Task 4）"
```

---

### Task 5: 学习目标 MobileGoalsPage

**Files:**
- Modify: `apps/web/src/pages/parent-mobile/MobileGoalsPage.tsx`（替换占位）
- Test: `apps/web/src/pages/parent-mobile/MobileGoalsPage.test.tsx`

**Interfaces:**
- Consumes: `useParentStudentStore`；`getParentGoalAttainment(studentId): Promise<ParentGoalAttainment>`；`putParentGoalTarget(studentId, metric: ParentGoalMetric, target: number, subjectId: number): Promise<ParentGoalAttainmentItem>`；`ParentGoalAttainmentItem = { metric, subjectId, subjectName, period: 'daily'|'weekly', title, target, achieved, rate: number|null }`（**渲染 key 必须用 `${subjectId}:${metric}`**）。
- Produces: `data-testid="mobile-page-goals"`。

- [ ] **Step 1: 写失败测试**

```tsx
// MobileGoalsPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileGoalsPage from './MobileGoalsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => { cleanup(); useParentStudentStore.setState({ studentId: 1 }); });

vi.mock('@/services/api', () => ({
  getParentGoalAttainment: vi.fn(),
  putParentGoalTarget: vi.fn(),
}));
import { getParentGoalAttainment, putParentGoalTarget } from '@/services/api';

const items = {
  items: [
    { metric: 'daily_study_minutes' as const, subjectId: 2, subjectName: '数学', period: 'daily' as const, title: '每日学习分钟数', target: 30, achieved: 45, rate: 150 },
    { metric: 'weekly_clear_errors' as const, subjectId: 2, subjectName: '数学', period: 'weekly' as const, title: '每周清错题数', target: 5, achieved: 0, rate: null },
  ],
};

describe('MobileGoalsPage', () => {
  it('渲染达成度：rate>100 不截断，rate=null 显示 暂无数据', async () => {
    vi.mocked(getParentGoalAttainment).mockResolvedValue(items as never);
    render(<MobileGoalsPage />);
    expect(await screen.findByText(/150%/)).toBeTruthy();
    expect(screen.getByText(/暂无数据/)).toBeTruthy();
    // 渲染 key 用 subjectId:metric（两行都在）
    expect(screen.getByText(/每日学习分钟数/)).toBeTruthy();
    expect(screen.getByText(/每周清错题数/)).toBeTruthy();
  });

  it('编辑目标：正整数校验 + 保存就地更新返回项', async () => {
    vi.mocked(getParentGoalAttainment).mockResolvedValue(items as never);
    vi.mocked(putParentGoalTarget).mockResolvedValue({ ...items.items[0], target: 60, rate: 75 });
    render(<MobileGoalsPage />);
    await screen.findByText(/150%/);
    await userEvent.click(screen.getByTestId('goal-edit-2:daily_study_minutes'));
    const input = screen.getByTestId('goal-input-2:daily_study_minutes');
    await userEvent.type(input, '0');
    await userEvent.click(screen.getByTestId('goal-save-2:daily_study_minutes'));
    expect(putParentGoalTarget).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, '60');
    await userEvent.click(screen.getByTestId('goal-save-2:daily_study_minutes'));
    await waitFor(() => expect(putParentGoalTarget).toHaveBeenCalledWith(1, 'daily_study_minutes', 60, 2));
    expect(await screen.findByText(/75%/)).toBeTruthy();
  });

  it('拉取失败显示错误重试', async () => {
    vi.mocked(getParentGoalAttainment).mockRejectedValue(new Error('x'));
    render(<MobileGoalsPage />);
    expect(await screen.findByTestId('goals-retry')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileGoalsPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// MobileGoalsPage.tsx
import { useCallback, useEffect, useState } from 'react';
import {
  getParentGoalAttainment, putParentGoalTarget,
  type ParentGoalAttainmentItem, type ParentGoalMetric,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

type LoadStatus = 'loading' | 'ready' | 'error';

export default function MobileGoalsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [items, setItems] = useState<ParentGoalAttainmentItem[] | null>(null);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback((id: number) => {
    setStatus('loading');
    getParentGoalAttainment(id)
      .then((res) => { setItems(res.items); setOwnerId(id); setStatus('ready'); })
      .catch(() => setStatus('error'));
  }, []);

  useEffect(() => {
    if (studentId !== null) load(studentId);
  }, [studentId, load]);

  if (studentId === null) return <p className="text-[var(--text-secondary)]">先在上方选择孩子</p>;
  if (status === 'error') {
    return (
      <div data-testid="mobile-page-goals">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="goals-retry" onClick={() => load(studentId)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      </div>
    );
  }
  if (status === 'loading' || ownerId !== studentId || items === null) {
    return <div data-testid="mobile-page-goals"><div className="h-24 animate-pulse rounded-2xl bg-white" /></div>;
  }

  const startEdit = (item: ParentGoalAttainmentItem) => {
    setEditing(`${item.subjectId}:${item.metric}`);
    setDraft(String(item.target));
    setEditError(null);
  };

  const save = (item: ParentGoalAttainmentItem) => {
    const target = Number(draft);
    if (!Number.isInteger(target) || target <= 0) {
      setEditError('目标须为正整数');
      return;
    }
    setEditError(null);
    putParentGoalTarget(studentId, item.metric, target, item.subjectId)
      .then((updated) => {
        setItems((prev) => prev?.map((i) => (i.subjectId === updated.subjectId && i.metric === updated.metric ? updated : i)) ?? prev);
        setEditing(null);
      })
      .catch((e: unknown) => setEditError(e instanceof Error ? e.message : '保存失败'));
  };

  return (
    <div data-testid="mobile-page-goals" className="space-y-3">
      <ul className="space-y-2">
        {items.map((i) => {
          const key = `${i.subjectId}:${i.metric}`;
          const editingThis = editing === key;
          return (
            <li key={key} className="rounded-2xl bg-white p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">{i.subjectName} · {i.title}</p>
                <span className="text-xs text-[var(--text-tertiary)]">{i.period === 'daily' ? '每日' : '每周'}</span>
              </div>
              <p className="mt-1 text-sm">
                已完成 {i.achieved} / {i.target} ·
                {i.rate === null ? ' 暂无数据' : ` 达成 ${i.rate}%`}
              </p>
              {editingThis ? (
                <div className="mt-2">
                  <input data-testid={`goal-input-${key}`} aria-label="目标值" inputMode="numeric" value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="w-24 rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm" />
                  <button data-testid={`goal-save-${key}`} onClick={() => save(i)} className="ml-2 rounded-xl bg-[var(--brand-500)] px-3 py-2 text-sm text-white">保存</button>
                  {editError && <p className="mt-1 text-xs text-[var(--error)]">{editError}</p>}
                </div>
              ) : (
                <button data-testid={`goal-edit-${key}`} onClick={() => startEdit(i)} className="mt-2 rounded-lg border border-[var(--bg-subtle)] px-3 py-1.5 text-xs">调整目标</button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试 + 全量 + tsc + build**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: PASS；全量绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端学习目标（达成度展示 + 目标编辑）（Task 5）"
```

---

### Task 6: 账号设置 MobileAccountPage

**Files:**
- Modify: `apps/web/src/pages/parent-mobile/MobileAccountPage.tsx`（替换占位）
- Test: `apps/web/src/pages/parent-mobile/MobileAccountPage.test.tsx`

**Interfaces:**
- Consumes: `getParentAccount(): Promise<ParentAccount>`（`{ id, name: string|null, phone }`）、`changeParentPassword(oldPassword, newPassword): Promise<null>`（失败口径：旧密码错 → 401/1003；新密码过短或与旧密码相同 → 409/1001；**改后不失效旧 token**）。
- Produces: `data-testid="mobile-page-account"`。

- [ ] **Step 1: 写失败测试**

```tsx
// MobileAccountPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileAccountPage from './MobileAccountPage';

afterEach(cleanup);

vi.mock('@/services/api', () => ({
  getParentAccount: vi.fn(),
  changeParentPassword: vi.fn(),
}));
import { changeParentPassword, getParentAccount } from '@/services/api';

const account = { id: 4, name: 'lc', phone: '18601201380' };

describe('MobileAccountPage', () => {
  it('渲染只读账号信息', async () => {
    vi.mocked(getParentAccount).mockResolvedValue(account as never);
    render(<MobileAccountPage />);
    expect(await screen.findByText(/18601201380/)).toBeTruthy();
    expect(screen.getByText(/lc/)).toBeTruthy();
  });

  it('修改密码：两次不一致不发请求；成功 toast 并清空表单', async () => {
    vi.mocked(getParentAccount).mockResolvedValue(account as never);
    vi.mocked(changeParentPassword).mockResolvedValue(null);
    render(<MobileAccountPage />);
    await screen.findByText(/18601201380/);
    await userEvent.type(screen.getByLabelText('旧密码'), 'old123');
    await userEvent.type(screen.getByLabelText('新密码'), 'new123456');
    await userEvent.type(screen.getByLabelText('确认新密码'), 'new654321');
    await userEvent.click(screen.getByTestId('account-password-submit'));
    expect(changeParentPassword).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('确认新密码'));
    await userEvent.type(screen.getByLabelText('确认新密码'), 'new123456');
    await userEvent.click(screen.getByTestId('account-password-submit'));
    await waitFor(() => expect(changeParentPassword).toHaveBeenCalledWith('old123', 'new123456'));
    expect(await screen.findByText(/密码已修改/)).toBeTruthy();
  });

  it('新密码过短行内报错；旧密码错误原样展示', async () => {
    vi.mocked(getParentAccount).mockResolvedValue(account as never);
    render(<MobileAccountPage />);
    await screen.findByText(/18601201380/);
    await userEvent.type(screen.getByLabelText('旧密码'), 'old123');
    await userEvent.type(screen.getByLabelText('新密码'), '123');
    await userEvent.type(screen.getByLabelText('确认新密码'), '123');
    await userEvent.click(screen.getByTestId('account-password-submit'));
    expect(changeParentPassword).not.toHaveBeenCalled();
    expect(await screen.findByText(/至少 6 位/)).toBeTruthy();
    unmountHelper();
    vi.mocked(changeParentPassword).mockRejectedValue(new Error('旧密码不正确'));
    render(<MobileAccountPage />);
    await screen.findByText(/18601201380/);
    await userEvent.type(screen.getByLabelText('旧密码'), 'wrong');
    await userEvent.type(screen.getByLabelText('新密码'), 'new123456');
    await userEvent.type(screen.getByLabelText('确认新密码'), 'new123456');
    await userEvent.click(screen.getByTestId('account-password-submit'));
    expect(await screen.findByText(/旧密码不正确/)).toBeTruthy();
  });
});

function unmountHelper() { /* 上一用例卸载：直接 cleanup() */ cleanup(); }
```

⚠️ `unmountHelper` 这种间接写法不好——实施时直接在用例开头各自 `render`（`afterEach(cleanup)` 已保证隔离），删掉这个 helper，把第二个用例拆成独立 `it`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileAccountPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// MobileAccountPage.tsx
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/base';
import { changeParentPassword, getParentAccount, type ParentAccount } from '@/services/api';

type LoadStatus = 'loading' | 'ready' | 'error';

export default function MobileAccountPage() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [account, setAccount] = useState<ParentAccount | null>(null);
  const [error, setError] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [oldPasswordError, setOldPasswordError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    getParentAccount()
      .then((a) => { setAccount(a); setStatus('ready'); })
      .catch(() => setError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = () => {
    setOldPasswordError(false);
    if (newPassword.length < 6) { setFormError('新密码至少 6 位'); return; }
    if (newPassword !== confirmPassword) { setFormError('两次输入的新密码不一致'); return; }
    setFormError(null);
    changeParentPassword(oldPassword, newPassword)
      .then(() => {
        toast('success', '密码已修改');
        setOldPassword(''); setNewPassword(''); setConfirmPassword('');
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : '修改失败';
        if (msg.includes('旧密码') || msg.includes('密码不正确')) setOldPasswordError(true);
        setFormError(msg);
      });
  };

  return (
    <div data-testid="mobile-page-account" className="space-y-3">
      {error ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="account-retry" onClick={load} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : status === 'loading' || account === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : (
        <>
          <div className="rounded-2xl bg-white p-4 text-sm">
            <p className="flex justify-between"><span className="text-[var(--text-secondary)]">手机号</span><span>{account.phone}</span></p>
            <p className="mt-2 flex justify-between"><span className="text-[var(--text-secondary)]">姓名</span><span>{account.name ?? '未设置'}</span></p>
          </div>
          <div className="space-y-2 rounded-2xl bg-white p-4">
            <p className="text-sm font-bold">修改密码</p>
            {[['旧密码', oldPassword, setOldPassword], ['新密码', newPassword, setNewPassword], ['确认新密码', confirmPassword, setConfirmPassword]].map(([label, value, setter]) => (
              <div key={label as string}>
                <label className="text-xs text-[var(--text-secondary)]">{label as string}</label>
                <input
                  aria-label={label as string}
                  type="password"
                  value={value as string}
                  onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm ${oldPasswordError && label === '旧密码' ? 'border-[var(--error)]' : 'border-[var(--bg-subtle)]'}`}
                />
              </div>
            ))}
            {formError && <p className="text-xs text-[var(--error)]">{formError}</p>}
            <button data-testid="account-password-submit" onClick={submit} className="w-full rounded-xl bg-[var(--brand-500)] py-2 text-sm text-white">保存新密码</button>
            <p className="text-xs text-[var(--text-tertiary)]">退出登录请使用顶栏的退出按钮。</p>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试 + 全量 + tsc + build**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: PASS；全量绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端账号设置（只读信息 + 修改密码）（Task 6）"
```

---

### Task 7: 文档同步与收尾（WebKit 端到端走查）

**Files:**
- Modify: `docs/ai-core-changelog.md`、`docs/UX-UI设计文档.md`（§5.10 扩充）

- [ ] **Step 1: UX 文档 §5.10 扩充**

在「家长移动端」小节（v1 建立于 §5.10）补一段：2A 新增五页（消息中心 / 学生管理 / 学习配置 / 学习目标 / 账号设置）已上手机，「更多」里仍指向电脑端的为订阅管理 / 积分与兑换 / 学习报告 / AI 对话记录；导航形态不变（底部四 Tab + 更多）。

- [ ] **Step 2: changelog 新条目**

`docs/ai-core-changelog.md` 顶部按既有格式补 `## 2026-10-06 · 家长移动端第二批 A`：范围裁决（分两批、订阅移出、学习配置纳入）、5 页端点与交互要点、占位收敛为 4 项、测试与 WebKit 走查结果。

- [ ] **Step 3: 全量验证 + WebKit 走查**

Run: `cd apps/web && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run lint 2>&1 | tail -1 && npm run build 2>&1 | tail -1`
Expected: 全量绿、tsc 0、lint 0 error、build 成功。

WebKit 走查（390×844，家长 JWT 注入法同 v1）：五页逐页过——渲染/交互/配色（全 token）/无空白卡片；「更多」页两组入口正确。

- [ ] **Step 4: Commit**

```bash
git add docs/ai-core-changelog.md docs/UX-UI设计文档.md
git commit -m "docs: 家长移动端 2A 文档同步（Task 7）"
```

---

## Self-Review 结论

1. **Spec 覆盖**：§3 路由/入口=Task 1；§4.1–4.5=Task 2–6；§5 测试=各任务内嵌 + Task 7 走查；§6 文档=Task 7。无缺口。
2. **占位符扫描**：Task 4 的 ConfirmDialog props 与 Task 6 的用例拆分是「核对点」（给出核对文件与适配方向），非 TBD。Task 3 的 GRADES/校验规则逐字给出。
3. **类型一致性**：`mobileParentPath` 新签名与 Task 1 测试一致；`MOBILE_LIVE_ITEMS/MOBILE_STUB_ITEMS` 仅 Task 1 消费；5 个 testid（`mobile-page-messages/students/config/goals/account`）与路由测试口径统一。
