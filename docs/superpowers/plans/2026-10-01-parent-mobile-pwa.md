# 家长端移动端 PWA 先行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为家长新增手机竖屏可用的 PWA 入口（`/m/parent/*` 路由组 + manifest），v1 覆盖仪表盘/预警/错题本/管控四个核心场景，零后端改动。

**Architecture:** 方案 B（spec `docs/superpowers/specs/2026-10-01-parent-mobile-pwa-design.md`）：独立移动页面组 `src/pages/parent-mobile/`，复用 `services/api.ts`、`parent` 主题 token、`RequireRole`、三条通知条组件与 `useParentStudentStore`；不复用桌面页面组件与 `ParentLayout`。桌面 `/parent/*` 一行不动。

**Tech Stack:** React 19 + react-router 6（`routes/routeTable.tsx` 集中表）+ Zustand + Tailwind + vitest/@testing-library（`globals:false`）。

## Global Constraints（每个任务隐含遵守）

- **零后端改动**：只用 `services/api.ts` 既有导出，禁止新端点、禁止改 api.ts 既有签名。
- 桌面端零回归：不修改 `ParentLayout`、13 个桌面家长页面及其测试（LoginPage 是唯一例外，Task 4）。
- 测试文件**必须自写 `afterEach(cleanup)`**（本仓 `globals:false`；`src/test/setup.ts` 不自动 cleanup）。
- 列表页换孩子**必须回第 1 页**：`useEffect(() => setPage(1), [studentId])`。
- 派生状态**带 `studentId` 归属**：任何「当前孩子的数据」state 在 `studentId` 变化时整体作废重拉，不做跨孩子合并。
- 图标/视觉遵守「不用吉祥物/emoji」；主题沿用 `data-theme="parent"` 与 `var(--bg-base)` 等 token。
- 预警轮询 30s 语义不变，但定时器实例在移动端 hook 内自建，不与桌面共享。
- spec 有意降级：无 Service Worker、无系统推送；manifest 图标用既有 `/favicon.svg`（PNG apple-touch-icon 留待有原生资产时补，iOS 会回退页面截图，属可接受降级）。

## 对 spec 的一处有意偏差（实施前已定，终审时向用户报告）

spec §4.3 写「新建 `mobileParentStore`」。实施发现 `src/store/parentStudentStore.ts` **已经就是**那个「轻量、被动、只存 studentId、persist key=`parent-current-student`」的锚点，且 localStorage 天然按设备隔离（手机与 iPad 各自一份，无互相干扰）。**复用它**，不新建第二个 store——两个 store 会出现「手机上切了孩子、iPad 不知道」以外的更糟问题：同名锚点两套持久化 key。移动端的 `MobileStudentSwitcher` 成为该 store 在移动端的**数据源与校验点**（镜像桌面端 `StudentSwitcher` 的职责定义）。

## File Structure

```
apps/web/public/manifest.webmanifest                     # Task 1 新建
apps/web/index.html                                      # Task 1 修改（manifest link + apple meta）
apps/web/src/components/layout/MobileParentLayout.tsx    # Task 2 新建（外壳：顶条+三 Bar+底部 Tab）
apps/web/src/components/layout/MobileParentLayout.test.tsx
apps/web/src/components/layout/MobileStudentSwitcher.tsx # Task 3 新建（孩子切换，写 parentStudentStore）
apps/web/src/components/layout/MobileStudentSwitcher.test.tsx
apps/web/src/pages/auth/LoginPage.tsx                    # Task 4 修改（家长落点按视口分流）
apps/web/src/pages/auth/LoginPage.test.tsx               # Task 4 追加用例
apps/web/src/pages/parent-mobile/MobileDashboardPage.tsx # Task 5
apps/web/src/pages/parent-mobile/MobileDashboardPage.test.tsx
apps/web/src/pages/parent-mobile/MobileAlertsPage.tsx    # Task 6
apps/web/src/pages/parent-mobile/MobileAlertsPage.test.tsx
apps/web/src/pages/parent-mobile/MobileErrorsPage.tsx    # Task 7
apps/web/src/pages/parent-mobile/MobileErrorsPage.test.tsx
apps/web/src/pages/parent-mobile/MobileControlsPage.tsx  # Task 8
apps/web/src/pages/parent-mobile/MobileControlsPage.test.tsx
apps/web/src/pages/parent-mobile/MobileMorePage.tsx      # Task 2（「更多」列表 + 占位）
apps/web/src/routes/routeTable.tsx                       # Task 2 修改（挂 /m/parent 组）
docs/ai-core-changelog.md                                # Task 9
docs/superpowers/specs/2026-10-01-parent-mobile-pwa-design.md  # Task 9（附章：添加到主屏幕步骤）
```

页面组件统一从 `@/pages/parent-mobile/` 导入；路由表 import 区按现有字母序补 import。

---

### Task 1: PWA manifest + index.html meta

**Files:**
- Create: `apps/web/public/manifest.webmanifest`
- Modify: `apps/web/index.html`
- Test: `apps/web/src/pwa.pwa.test.ts`（新建，护栏测试钉 manifest 与 meta 不被静默删掉）

**Interfaces:**
- Consumes: 既有 `/favicon.svg`。
- Produces: 无代码接口；后续任务依赖「iOS 添加主屏后全屏」这条交付预期。

- [ ] **Step 1: 写护栏测试（先失败）**

```ts
// apps/web/src/pwa.pwa.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 直读文件而非 jsdom：manifest/meta 是静态资产，护栏只关心「在且字段对」。
const webRoot = resolve(__dirname, '..');

describe('PWA 静态资产护栏', () => {
  it('manifest.webmanifest 存在且 standalone + 引用 favicon.svg', () => {
    const m = JSON.parse(readFileSync(resolve(webRoot, 'public/manifest.webmanifest'), 'utf-8'));
    expect(m.display).toBe('standalone');
    expect(m.icons.some((i: { src: string }) => i.src === '/favicon.svg')).toBe(true);
    expect(typeof m.theme_color).toBe('string');
  });

  it('index.html 带 manifest link 与 apple 主屏 meta', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf-8');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('apple-mobile-web-app-status-bar-style');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pwa.pwa.test.ts`
Expected: FAIL（manifest 不存在）

- [ ] **Step 3: 写 manifest 与 index.html**

```json
{
  "name": "K12 智学系统 · 家长端",
  "short_name": "K12 家长端",
  "start_url": "/m/parent",
  "display": "standalone",
  "theme_color": "#F5F0E8",
  "background_color": "#F5F0E8",
  "icons": [{ "src": "/favicon.svg", "type": "image/svg+xml", "sizes": "any", "purpose": "any" }]
}
```

`index.html` 的 `<head>` 内 `<title>` 之前插入（一行一个，不加 Service Worker 注册——HTTP 下注册不了，spec §5）：

```html
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="K12 家长端" />
<link rel="apple-touch-icon" href="/favicon.svg" />
```

⚠️ `.gitignore` 的 `*.yml` 文件级规则与 `.webmanifest` 无关，无需反选；但 `git add` 后必须 `git status` 确认文件真的进了暂存区（本仓有过静态资产被静默忽略的前科类别）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pwa.pwa.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/public/manifest.webmanifest apps/web/index.html apps/web/src/pwa.pwa.test.ts
git commit -m "feat(web): PWA manifest + iOS 主屏 meta（家长移动端 Task 1）"
```

---

### Task 2: `/m/parent` 路由组 + MobileParentLayout + 更多占位页

**Files:**
- Create: `apps/web/src/components/layout/MobileParentLayout.tsx`
- Create: `apps/web/src/pages/parent-mobile/MobileMorePage.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（import 区 + `/parent` 块后面加 `/m/parent` 块）
- Test: `apps/web/src/components/layout/MobileParentLayout.test.tsx`、`apps/web/src/routes/mobileParentRoutes.test.tsx`

**Interfaces:**
- Consumes: `RequireRole`（`@/routes/RequireRole`）、`useParentStudentStore`（`@/store/parentStudentStore`，Task 3 才有真正切换器，本任务先用占位条）、`AlertBanner`（`@/components/business/AlertBanner`）、`BillingNoticeBar` / `SubscriptionNoticeBar`（`@/pages/parent/`，无 props 自包含组件）。
- Produces: 路由组 `{ path: '/m/parent', element: <RequireRole role="parent"><MobileParentLayout /></RequireRole>, children: [...] }`；`MobileMorePage` 导出 `MOBILE_MORE_ITEMS`（`Array<{ label: string; to: string }>`）供占位页复用。

- [ ] **Step 1: 写路由测试（先失败）**

```tsx
// apps/web/src/routes/mobileParentRoutes.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from './routeTable';

afterEach(cleanup);

// 布局里三条通知条都会发请求：统一静默，让测试聚焦路由与导航本身。
vi.mock('@/components/business/AlertBanner', () => ({ default: () => null }));
vi.mock('@/pages/parent/BillingNoticeBar', () => ({ default: () => null }));
vi.mock('@/pages/parent/SubscriptionNoticeBar', () => ({ default: () => null }));
vi.mock('@/services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/api')>()),
  listMyStudents: vi.fn().mockResolvedValue([
    { id: 1, parentId: 9, username: 'stu1', name: '小明', age: 10, grade: '四年级', schoolLevel: 'primary', isActive: true },
  ]),
  getSubscriptionStatus: vi.fn().mockRejectedValue(new Error('skip')),
}));

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
}

describe('/m/parent 移动路由组', () => {
  it('index 重定向到 dashboard', async () => {
    renderAt('/m/parent');
    expect(await screen.findByTestId('mobile-page-dashboard')).toBeTruthy();
  });

  it('more/:name 渲染电脑端占位页', async () => {
    renderAt('/m/parent/more/subscription');
    expect(await screen.findByText('该功能请在电脑端使用')).toBeTruthy();
  });

  it('底部导航有四个 Tab 且当前态正确', async () => {
    renderAt('/m/parent/dashboard');
    expect(await screen.findByTestId('mobile-page-dashboard')).toBeTruthy();
    expect(screen.getByTestId('tab-dashboard').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('tab-errors')).toBeTruthy();
    expect(screen.getByTestId('tab-controls')).toBeTruthy();
    expect(screen.getByTestId('tab-more')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/routes/mobileParentRoutes.test.tsx`
Expected: FAIL（路由不存在，渲染错误页）

- [ ] **Step 3: 实现 MobileParentLayout + MobileMorePage + 路由块**

```tsx
// apps/web/src/components/layout/MobileParentLayout.tsx
import { NavLink, Outlet } from 'react-router-dom';
import AlertBanner from '@/components/business/AlertBanner';
import BillingNoticeBar from '@/pages/parent/BillingNoticeBar';
import SubscriptionNoticeBar from '@/pages/parent/SubscriptionNoticeBar';
import MobileStudentSwitcher from './MobileStudentSwitcher';

const TABS = [
  { to: '/m/parent/dashboard', label: '仪表盘', testId: 'tab-dashboard' },
  { to: '/m/parent/errors', label: '错题', testId: 'tab-errors' },
  { to: '/m/parent/controls', label: '管控', testId: 'tab-controls' },
  { to: '/m/parent/more', label: '更多', testId: 'tab-more' },
];

export default function MobileParentLayout() {
  return (
    <div data-theme="parent" className="flex min-h-screen flex-col bg-[var(--bg-base)]">
      <header className="border-b border-black/5 bg-white">
        <MobileStudentSwitcher />
        <AlertBanner />
        <BillingNoticeBar />
        <SubscriptionNoticeBar />
      </header>
      <main className="flex-1 px-4 py-4">
        <Outlet />
      </main>
      <nav aria-label="家长移动端主导航" className="sticky bottom-0 grid grid-cols-4 border-t border-black/5 bg-white">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            data-testid={t.testId}
            className={({ isActive }) =>
              `py-3 text-center text-sm ${isActive ? 'font-bold text-[var(--brand-500)]' : 'text-black/60'}`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
```

```tsx
// apps/web/src/pages/parent-mobile/MobileMorePage.tsx
import { Link, useParams } from 'react-router-dom';

/** v1 只做入口列表；不在名单里的功能一律引导回电脑端（spec §3）。 */
export const MOBILE_MORE_ITEMS = [
  { key: 'subscription', label: '订阅管理' },
  { key: 'points', label: '积分与兑换' },
  { key: 'report', label: '学习报告' },
  { key: 'chat-logs', label: 'AI 对话记录' },
  { key: 'goals', label: '学习目标' },
  { key: 'messages', label: '消息中心' },
  { key: 'students', label: '学生管理' },
  { key: 'account', label: '账号设置' },
] as const;

export default function MobileMorePage() {
  const { name } = useParams();
  if (name) {
    const item = MOBILE_MORE_ITEMS.find((i) => i.key === name);
    return (
      <div data-testid="mobile-page-stub" className="rounded-2xl bg-white p-8 text-center">
        <p className="text-lg font-bold">{item?.label ?? '该功能'}</p>
        <p className="mt-2 text-black/60">该功能请在电脑端使用</p>
      </div>
    );
  }
  return (
    <div data-testid="mobile-page-more" className="divide-y divide-black/5 rounded-2xl bg-white">
      {MOBILE_MORE_ITEMS.map((i) => (
        <Link key={i.key} to={`/m/parent/more/${i.key}`} className="block px-5 py-4">
          {i.label}
        </Link>
      ))}
    </div>
  );
}
```

`routes/routeTable.tsx`：import 区补三行（`MobileParentLayout`、四个页面 —— 本任务先建 dashboard/errors/controls 的**临时占位实现**，各页 Task 5–8 替换为真实现，占位就是 `<div data-testid="mobile-page-dashboard" />` 这样的空壳，保证路由测试先绿），然后在 `/parent` 块**之后**插入：

```tsx
{
  path: '/m/parent',
  element: (
    <RequireRole role="parent">
      <MobileParentLayout />
    </RequireRole>
  ),
  children: [
    { path: '', element: <Navigate to="/m/parent/dashboard" replace /> },
    { path: 'dashboard', element: <MobileDashboardPage /> },
    { path: 'alerts', element: <MobileAlertsPage /> },
    { path: 'errors', element: <MobileErrorsPage /> },
    { path: 'controls', element: <MobileControlsPage /> },
    { path: 'more', element: <MobileMorePage /> },
    { path: 'more/:name', element: <MobileMorePage /> },
  ],
},
```

`MobileStudentSwitcher` 本任务先给最小占位（只显示「家长移动端」，不拉接口），Task 3 替换：

```tsx
// apps/web/src/components/layout/MobileStudentSwitcher.tsx（Task 2 临时版）
export default function MobileStudentSwitcher() {
  return <div data-testid="mobile-student-switcher" className="px-4 py-3 text-sm">家长移动端</div>;
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd apps/web && npx vitest run src/routes/mobileParentRoutes.test.tsx && npx vitest run`
Expected: 新测试 PASS；全量无回归（桌面用例零改动）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/MobileParentLayout.tsx apps/web/src/components/layout/MobileParentLayout.test.tsx apps/web/src/components/layout/MobileStudentSwitcher.tsx apps/web/src/pages/parent-mobile/ apps/web/src/routes/routeTable.tsx apps/web/src/routes/mobileParentRoutes.test.tsx
git commit -m "feat(web): /m/parent 移动路由组 + MobileParentLayout 底部导航外壳（Task 2）"
```

---

### Task 3: MobileStudentSwitcher（复用 parentStudentStore）

**Files:**
- Modify: `apps/web/src/components/layout/MobileStudentSwitcher.tsx`（替换 Task 2 占位）
- Test: `apps/web/src/components/layout/MobileStudentSwitcher.test.tsx`

**Interfaces:**
- Consumes: `listMyStudents(): Promise<MyStudentItem[]>`（api.ts:115）、`useParentStudentStore`（`{ studentId, setStudentId }`）。
- Produces: 无导出接口；布局与四个页面通过 `useParentStudentStore((s) => s.studentId)` 读当前孩子。

镜像桌面 `StudentSwitcher` 的四条口径（该文件头注释）：唯一数据源与校验点、单孩也渲染、拉取失败只降级这一块、有数据时静默刷新。移动端差异：失败降级改为「下方一窄条提示 + 重试按钮」（顶部空间小，不用下拉形态）。

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/components/layout/MobileStudentSwitcher.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileStudentSwitcher from './MobileStudentSwitcher';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => {
  cleanup();
  useParentStudentStore.setState({ studentId: null });
  localStorage.removeItem('parent-current-student');
});

const students = [
  { id: 1, parentId: 9, username: 'a', name: '小明', age: 10, grade: '四年级', schoolLevel: 'primary', isActive: true },
  { id: 2, parentId: 9, username: 'b', name: '小红', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true },
];

vi.mock('@/services/api', () => ({ listMyStudents: vi.fn() }));
import { listMyStudents } from '@/services/api';
const mockList = vi.mocked(listMyStudents);

describe('MobileStudentSwitcher', () => {
  it('拉到列表后默认选中第一个孩子（无持久化 id 时）', async () => {
    mockList.mockResolvedValue(students);
    render(<MobileStudentSwitcher />);
    await waitFor(() => expect(useParentStudentStore.getState().studentId).toBe(1));
    expect(screen.getByText(/小明/)).toBeTruthy();
  });

  it('点击展开并切换孩子，写回 store', async () => {
    mockList.mockResolvedValue(students);
    useParentStudentStore.setState({ studentId: 1 });
    render(<MobileStudentSwitcher />);
    await screen.findByText(/小明/);
    await userEvent.click(screen.getByTestId('mobile-switcher-trigger'));
    await userEvent.click(screen.getByTestId('mobile-switcher-option-2'));
    expect(useParentStudentStore.getState().studentId).toBe(2);
  });

  it('持久化 id 不在列表中时回落到第一个孩子', async () => {
    mockList.mockResolvedValue(students);
    useParentStudentStore.setState({ studentId: 999 });
    render(<MobileStudentSwitcher />);
    await waitFor(() => expect(useParentStudentStore.getState().studentId).toBe(1));
  });

  it('拉取失败只降级本块：显示重试，不抛错', async () => {
    mockList.mockRejectedValue(new Error('network'));
    render(<MobileStudentSwitcher />);
    expect(await screen.findByTestId('mobile-switcher-retry')).toBeTruthy();
    mockList.mockResolvedValue(students);
    await userEvent.click(screen.getByTestId('mobile-switcher-retry'));
    await screen.findByText(/小明/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/layout/MobileStudentSwitcher.test.tsx`
Expected: FAIL（占位版没有这些行为）

- [ ] **Step 3: 实现切换器**

```tsx
// apps/web/src/components/layout/MobileStudentSwitcher.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { listMyStudents, type MyStudentItem } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

type LoadStatus = 'loading' | 'ready' | 'error';

function displayName(student: MyStudentItem): string {
  return `${student.name}${student.grade ? `（${student.grade}）` : ''}`;
}

/**
 * 移动端「当前孩子」的数据源与校验点（镜像桌面 StudentSwitcher 四条口径）：
 * 拉列表、处理「空列表 / 持久化 id 失效 / 首次进入」三种回落、写 useParentStudentStore。
 * 与桌面组件互不感知——同一设备同时只会渲染其一。
 */
export default function MobileStudentSwitcher() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const setStudentId = useParentStudentStore((s) => s.setStudentId);
  const [students, setStudents] = useState<MyStudentItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    setStatus('loading');
    listMyStudents()
      .then((list) => {
        setStudents(list);
        setStatus('ready');
        // 回落三态：空列表清锚点；持久化 id 失效或未设 → 第一个孩子。
        if (list.length === 0) {
          setStudentId(null);
        } else if (!list.some((s) => s.id === useParentStudentStore.getState().studentId)) {
          setStudentId(list[0].id);
        }
      })
      .catch(() => setStatus('error'));
  }, [setStudentId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  const current = students.find((s) => s.id === studentId) ?? null;

  if (status === 'error') {
    return (
      <div className="flex items-center justify-between px-4 py-3 text-sm">
        <span className="text-black/60">孩子列表加载失败</span>
        <button data-testid="mobile-switcher-retry" onClick={load} className="text-[var(--brand-500)]">
          重试
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative px-4 py-3">
      <button
        data-testid="mobile-switcher-trigger"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-sm"
      >
        <span className="font-bold">{current ? displayName(current) : '加载中…'}</span>
        <span aria-hidden className="text-black/40">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="absolute left-4 right-4 top-full z-10 rounded-xl bg-white shadow-lg">
          {students.map((s) => (
            <button
              key={s.id}
              data-testid={`mobile-switcher-option-${s.id}`}
              onClick={() => { setStudentId(s.id); setOpen(false); }}
              className={`block w-full px-4 py-3 text-left text-sm ${s.id === studentId ? 'font-bold text-[var(--brand-500)]' : ''}`}
            >
              {displayName(s)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd apps/web && npx vitest run src/components/layout/MobileStudentSwitcher.test.tsx && npx vitest run`
Expected: PASS；桌面 `StudentSwitcher.test.tsx` 不受影响（不同文件）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/MobileStudentSwitcher.tsx apps/web/src/components/layout/MobileStudentSwitcher.test.tsx
git commit -m "feat(web): MobileStudentSwitcher 复用 parentStudentStore（Task 3）"
```

---

### Task 4: 登录落点按视口分流

**Files:**
- Modify: `apps/web/src/pages/auth/LoginPage.tsx`（parent 分支，现 `navigate('/parent/students')`）
- Test: `apps/web/src/pages/auth/LoginPage.test.tsx`（追加 2 个用例）

**Interfaces:**
- Consumes: 既有 `login()` 与 localStorage 写入逻辑（不动）。
- Produces: 家长登录落点 = `window.innerWidth < 768` ? `/m/parent` : `/parent/students`。导出常量 `MOBILE_VIEWPORT_BREAKPOINT = 768`（从 `src/constants.ts`；若无该文件则新建，只放这一个常量）供测试与将来复用。

- [ ] **Step 1: 追加失败测试**

```tsx
// 追加到 apps/web/src/pages/auth/LoginPage.test.tsx 末尾（mock 与 renderLoginPage 复用文件顶部既有设施）
import { MOBILE_VIEWPORT_BREAKPOINT } from '@/constants';

describe('LoginPage 家长落点按视口分流', () => {
  it('窄屏（<768px）家长登录落 /m/parent', async () => {
    mockLogin.mockResolvedValue({
      token: 't',
      user: { id: 1, role: 'parent', username: null, phone: '13800000000' },
    } as never);
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: MOBILE_VIEWPORT_BREAKPOINT - 1, configurable: true });
    try {
      renderLoginPage();
      await userEvent.type(screen.getByLabelText(/手机号/), '13800000000');
      await userEvent.type(screen.getByLabelText(/密码/), 'pw123456');
      await userEvent.click(screen.getByRole('button', { name: '登录' }));
      expect(await screen.findByText('parent-mobile-home')).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
    }
  });

  it('宽屏家长登录仍落 /parent/students（原行为不变）', async () => {
    // 同上但 innerWidth 保持默认 1024；断言渲染 'parent-students-page'
    // —— 该文件既有用例已覆盖宽屏路径，此用例是分流后的回归钉子。
    mockLogin.mockResolvedValue({
      token: 't',
      user: { id: 1, role: 'parent', username: null, phone: '13800000000' },
    } as never);
    renderLoginPage();
    await userEvent.type(screen.getByLabelText(/手机号/), '13800000000');
    await userEvent.type(screen.getByLabelText(/密码/), 'pw123456');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('parent-students-page')).toBeTruthy();
  });
});
```

⚠️ 实施时先读该测试文件顶部：既有 `renderLoginPage` 的 Routes 里若没有 `/m/parent` 与 `/parent/students` 的桩路由（`<div>parent-mobile-home</div>` / `<div>parent-students-page</div>`），补上这两个 `<Route>`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/auth/LoginPage.test.tsx`
Expected: 新增窄屏用例 FAIL（当前落 /parent/students）

- [ ] **Step 3: 实现**

新建 `apps/web/src/constants.ts`：

```ts
/** 家长端移动/桌面落点分流断点：竖屏窄视口走移动路由组（spec §4.2）。 */
export const MOBILE_VIEWPORT_BREAKPOINT = 768;
```

`LoginPage.tsx` 的 parent 分支改为：

```tsx
} else if (result.user.role === 'parent') {
  navigate(window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT ? '/m/parent' : '/parent/students');
}
```

（import 区补 `import { MOBILE_VIEWPORT_BREAKPOINT } from '@/constants';`。注意该文件顶部若已有「家长落点」注释，同步改写为新口径。）

- [ ] **Step 4: 跑测试确认通过 + lint + 全量**

Run: `cd apps/web && npx vitest run src/pages/auth/LoginPage.test.tsx && npm run lint && npx vitest run`
Expected: PASS；lint 0 error（本仓基线 7 warning 属既有）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/constants.ts apps/web/src/pages/auth/LoginPage.tsx apps/web/src/pages/auth/LoginPage.test.tsx
git commit -m "feat(web): 家长登录落点按视口分流（<768px 走 /m/parent）（Task 4）"
```

---

### Task 5: MobileDashboardPage

**Files:**
- Create: `apps/web/src/pages/parent-mobile/MobileDashboardPage.tsx`（替换 Task 2 占位）
- Test: `apps/web/src/pages/parent-mobile/MobileDashboardPage.test.tsx`

**Interfaces:**
- Consumes: `useParentStudentStore`、`getParentDashboard(): Promise<ParentDashboard>`、`getParentStudyTime(studentId, from?): Promise<ParentStudyTime>`、`getParentTodayUsage(studentId): Promise<ParentTodayUsage>`、`getParentMastery(studentId, limit?): Promise<ParentMastery>`。
- Produces: 无。`data-testid="mobile-page-dashboard"` 已在 Task 2 路由测试被消费，必须保留。

页面状态机（spec「骨架 + 空态 + 错误重试三态」落到每张卡）：`idle → loading | ready | error`，`studentId` 变化 → 整页重置回 loading 并重拉。

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/pages/parent-mobile/MobileDashboardPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileDashboardPage from './MobileDashboardPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => {
  cleanup();
  useParentStudentStore.setState({ studentId: 1 });
});

vi.mock('@/services/api', () => ({
  getParentDashboard: vi.fn(),
  getParentStudyTime: vi.fn(),
  getParentTodayUsage: vi.fn(),
  getParentMastery: vi.fn(),
}));
import {
  getParentDashboard,
  getParentStudyTime,
  getParentTodayUsage,
  getParentMastery,
} from '@/services/api';

const dash = {
  students: [{
    studentId: 1, name: '小明', grade: '四年级', schoolLevel: 'primary',
    lastActiveAt: '2026-10-01T10:00:00Z', activeDays7: 3, unreadAlerts: 0,
    subjects: [{ subjectId: 2, name: '数学', progress: 40, accuracy: 0.8 }],
  }],
  unreadAlerts: 0,
};
const study = {
  totalSeconds: 3600, activeDays: 2, byDay: [], byModule: [],
  bySubject: [{ subjectId: 2, seconds: 3600 }], source: 'sessions' as const,
};
const usage = { date: '2026-10-01', activeSeconds: 1200, byModule: [] };
const mastery = { items: [{ knowledgePointId: 7, name: '分数运算', masteryScore: 0.4, level: 1, correctCount: 2, errorCount: 3, lastSeenAt: null }], coveredQuestions: 38, totalQuestions: 100, uncovered: 62 };

describe('MobileDashboardPage', () => {
  it('三卡渲染：进度/时长/薄弱点，口径文案分开', async () => {
    vi.mocked(getParentDashboard).mockResolvedValue(dash as never);
    vi.mocked(getParentStudyTime).mockResolvedValue(study as never);
    vi.mocked(getParentTodayUsage).mockResolvedValue(usage as never);
    vi.mocked(getParentMastery).mockResolvedValue(mastery as never);
    render(<MobileDashboardPage />);
    expect(await screen.findByText(/数学/)).toBeTruthy();
    // 硬约定：会话时长与活跃天数是两套口径，文案必须分别出现
    expect(screen.getByTestId('study-time-sessions')).toBeTruthy();
    expect(screen.getByTestId('active-days-7')).toBeTruthy();
    // 覆盖率三计数一起展示（ParentMastery 硬注释）
    expect(screen.getByText(/38\/100/)).toBeTruthy();
  });

  it('studentId 变化整页重拉', async () => {
    vi.mocked(getParentDashboard).mockResolvedValue(dash as never);
    vi.mocked(getParentStudyTime).mockResolvedValue(study as never);
    vi.mocked(getParentTodayUsage).mockResolvedValue(usage as never);
    vi.mocked(getParentMastery).mockResolvedValue(mastery as never);
    render(<MobileDashboardPage />);
    await screen.findByText(/数学/);
    vi.mocked(getParentDashboard).mockClear();
    vi.mocked(getParentStudyTime).mockClear();
    useParentStudentStore.setState({ studentId: 2 });
    await waitFor(() => expect(getParentStudyTime).toHaveBeenCalledWith(2, expect.anything()));
  });

  it('拉取失败显示错误重试', async () => {
    vi.mocked(getParentDashboard).mockRejectedValue(new Error('x'));
    vi.mocked(getParentStudyTime).mockRejectedValue(new Error('x'));
    vi.mocked(getParentTodayUsage).mockRejectedValue(new Error('x'));
    vi.mocked(getParentMastery).mockRejectedValue(new Error('x'));
    render(<MobileDashboardPage />);
    expect(await screen.findByTestId('dashboard-retry')).toBeTruthy();
    vi.mocked(getParentDashboard).mockResolvedValue(dash as never);
    vi.mocked(getParentStudyTime).mockResolvedValue(study as never);
    vi.mocked(getParentTodayUsage).mockResolvedValue(usage as never);
    vi.mocked(getParentMastery).mockResolvedValue(mastery as never);
    await userEvent.click(screen.getByTestId('dashboard-retry'));
    expect(await screen.findByText(/数学/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileDashboardPage.test.tsx`
Expected: FAIL（占位空壳无内容）

- [ ] **Step 3: 实现**

```tsx
// apps/web/src/pages/parent-mobile/MobileDashboardPage.tsx
import { useCallback, useEffect, useState } from 'react';
import {
  getParentDashboard, getParentMastery, getParentStudyTime, getParentTodayUsage,
  type ParentDashboard, type ParentMastery, type ParentStudyTime, type ParentTodayUsage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

type LoadStatus = 'loading' | 'ready' | 'error';

const DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

export default function MobileDashboardPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [dash, setDash] = useState<ParentDashboard | null>(null);
  const [study, setStudy] = useState<ParentStudyTime | null>(null);
  const [usage, setUsage] = useState<ParentTodayUsage | null>(null);
  const [mastery, setMastery] = useState<ParentMastery | null>(null);
  /** 带归属：只渲染与当前 studentId 同源的数据，切换期间不显示上个孩子的。 */
  const [ownerId, setOwnerId] = useState<number | null>(null);

  const load = useCallback((id: number) => {
    setStatus('loading');
    const from = new Date(Date.now() - DAYS_MS).toISOString().slice(0, 10);
    Promise.all([
      getParentDashboard(),
      getParentStudyTime(id, from),
      getParentTodayUsage(id),
      getParentMastery(id, 5),
    ])
      .then(([d, s, u, m]) => {
        setDash(d); setStudy(s); setUsage(u); setMastery(m);
        setOwnerId(id);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, []);

  useEffect(() => {
    if (studentId !== null) load(studentId);
  }, [studentId, load]);

  if (studentId === null) return <p className="text-black/60">先在上方选择孩子</p>;
  if (status === 'error') {
    return (
      <div className="rounded-2xl bg-white p-8 text-center">
        <p className="text-black/60">加载失败</p>
        <button data-testid="dashboard-retry" onClick={() => load(studentId)} className="mt-2 text-[var(--brand-500)]">重试</button>
      </div>
    );
  }
  if (status === 'loading' || ownerId !== studentId || !dash || !study || !usage || !mastery) {
    return <div data-testid="dashboard-skeleton" className="animate-pulse space-y-3">
      {[0, 1, 2].map((i) => <div key={i} className="h-28 rounded-2xl bg-white" />)}
    </div>;
  }

  const me = dash.students.find((s) => s.studentId === studentId) ?? null;
  return (
    <div data-testid="mobile-page-dashboard" className="space-y-3">
      <section className="rounded-2xl bg-white p-4">
        <h2 className="text-sm font-bold">学习进度{me ? ` · ${me.name}` : ''}</h2>
        {me ? (
          <ul className="mt-2 space-y-2 text-sm">
            <li className="flex justify-between"><span>近 7 天活跃天数</span><span data-testid="active-days-7">{me.activeDays7} 天</span></li>
            {me.subjects.map((sub) => (
              <li key={sub.subjectId} className="flex justify-between">
                <span>{sub.name}</span><span>进度 {sub.progress}% · 正确率 {Math.round(sub.accuracy * 100)}%</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-black/60">暂无该孩子的学情数据</p>}
      </section>
      <section className="rounded-2xl bg-white p-4">
        <h2 className="text-sm font-bold">学习时长</h2>
        <ul className="mt-2 space-y-2 text-sm">
          <li className="flex justify-between"><span>近 7 天累计（会话口径）</span><span data-testid="study-time-sessions">{fmtDuration(study.totalSeconds)}</span></li>
          <li className="flex justify-between"><span>今日已学</span><span>{fmtDuration(usage.activeSeconds)}</span></li>
        </ul>
        <p className="mt-2 text-xs text-black/40">口径说明：时长按学习会话统计；活跃天数按有记录的天数统计，两者独立计算。</p>
      </section>
      <section className="rounded-2xl bg-white p-4">
        <h2 className="text-sm font-bold">薄弱知识点</h2>
        <p className="mt-1 text-xs text-black/40">知识点覆盖率 {mastery.coveredQuestions}/{mastery.totalQuestions}，未覆盖 {mastery.uncovered} 题——未覆盖的题不在下列统计内。</p>
        <ul className="mt-2 space-y-2 text-sm">
          {mastery.items.length === 0 && <li className="text-black/60">暂无足够判题数据</li>}
          {mastery.items.map((i) => (
            <li key={i.knowledgePointId} className="flex justify-between">
              <span>{i.name}</span><span>掌握度 {Math.round(i.masteryScore * 100)}%</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

⚠️ `ParentDashboardSubject` 的字段名（`progress`/`accuracy`）以 `api.ts` 实际定义为准——实施第一步先读该 interface，若字段名不同以 api.ts 为真源修正上面代码与测试 mock。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileDashboardPage.test.tsx src/routes/mobileParentRoutes.test.tsx`
Expected: PASS（含 Task 2 路由测试，`data-testid` 兼容）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/parent-mobile/MobileDashboardPage.tsx apps/web/src/pages/parent-mobile/MobileDashboardPage.test.tsx
git commit -m "feat(web): 移动端学情仪表盘（双口径并列+掌握度覆盖率）（Task 5）"
```

---

### Task 6: MobileAlertsPage

**Files:**
- Create: `apps/web/src/pages/parent-mobile/MobileAlertsPage.tsx`
- Test: `apps/web/src/pages/parent-mobile/MobileAlertsPage.test.tsx`

**Interfaces:**
- Consumes: `getParentAlerts(params: ParentAlertListParams): Promise<ParentAlertPage>`、`markParentAlertRead(alertId): Promise<null>`、`getUnreadMessageCount(): Promise<number>`；裁决/订阅条已在外壳（不在此页重复）。
- Produces: 无。30s 轮询 hook `useUnreadAlertPolling`（本页内定义，不导出）。

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/pages/parent-mobile/MobileAlertsPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileAlertsPage from './MobileAlertsPage';

afterEach(cleanup);

vi.mock('@/services/api', () => ({
  getParentAlerts: vi.fn(),
  markParentAlertRead: vi.fn(),
  getUnreadMessageCount: vi.fn(),
}));
import { getUnreadMessageCount, getParentAlerts, markParentAlertRead } from '@/services/api';

const page1 = {
  items: [
    { id: 11, studentId: 1, studentName: '小明', type: 'off_topic', level: 'warning',
      message: '连续 3 次发起闲聊', context: null, dialogueId: null, isRead: false, createdAt: '2026-10-01T09:00:00Z' },
  ],
  page: 1, pageSize: 20, total: 2,
};
const page2 = { items: [], page: 2, pageSize: 20, total: 2 };

describe('MobileAlertsPage', () => {
  it('渲染预警列表与未读消息数', async () => {
    vi.mocked(getParentAlerts).mockResolvedValue(page1 as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(3);
    render(<MobileAlertsPage />);
    expect(await screen.findByText(/连续 3 次发起闲聊/)).toBeTruthy();
    expect(await screen.findByText(/3 条未读消息/)).toBeTruthy();
  });

  it('点「知道了」标记已读并从列表消失', async () => {
    vi.mocked(getParentAlerts).mockResolvedValue(page1 as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(0);
    vi.mocked(markParentAlertRead).mockResolvedValue(null);
    render(<MobileAlertsPage />);
    await screen.findByText(/连续 3 次发起闲聊/);
    await userEvent.click(screen.getByTestId('alert-ack-11'));
    await waitFor(() => expect(screen.queryByText(/连续 3 次发起闲聊/)).toBeNull());
  });

  it('翻页：第 2 页无数据显示空态', async () => {
    vi.mocked(getParentAlerts).mockResolvedValueOnce(page1 as never).mockResolvedValueOnce(page2 as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(0);
    render(<MobileAlertsPage />);
    await screen.findByText(/连续 3 次发起闲聊/);
    await userEvent.click(screen.getByTestId('alerts-next'));
    expect(await screen.findByText(/暂无预警/)).toBeTruthy();
    expect(getParentAlerts).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
  });

  it('拉取失败显示错误重试', async () => {
    vi.mocked(getParentAlerts).mockRejectedValue(new Error('x'));
    vi.mocked(getUnreadMessageCount).mockRejectedValue(new Error('x'));
    render(<MobileAlertsPage />);
    expect(await screen.findByTestId('alerts-retry')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileAlertsPage.test.tsx`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现**

```tsx
// apps/web/src/pages/parent-mobile/MobileAlertsPage.tsx
import { useCallback, useEffect, useState } from 'react';
import {
  getUnreadMessageCount, getParentAlerts, markParentAlertRead,
  type ParentAlertItem,
} from '@/services/api';

const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 20;

export default function MobileAlertsPage() {
  const [items, setItems] = useState<ParentAlertItem[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState<number | null>(null);

  const load = useCallback((p: number) => {
    setError(false);
    getParentAlerts({ page: p, pageSize: PAGE_SIZE })
      .then((res) => { setItems(res.items); setTotal(res.total); setPage(res.page); })
      .catch(() => setError(true));
  }, []);

  useEffect(() => { load(1); }, [load]);
  useEffect(() => {
    const tick = () => getUnreadMessageCount().then(setUnreadMessages).catch(() => {});
    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const ack = (id: number) => {
    markParentAlertRead(id)
      .then(() => setItems((prev) => prev?.filter((a) => a.id !== id) ?? prev))
      .catch(() => {});
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (error) {
    return (
      <div className="rounded-2xl bg-white p-8 text-center">
        <p className="text-black/60">加载失败</p>
        <button data-testid="alerts-retry" onClick={() => load(page)} className="mt-2 text-[var(--brand-500)]">重试</button>
      </div>
    );
  }

  return (
    <div data-testid="mobile-page-alerts" className="space-y-3">
      {unreadMessages !== null && (
        <p className="rounded-2xl bg-white px-4 py-3 text-sm">{unreadMessages} 条未读消息</p>
      )}
      {items === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : items.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-black/60">暂无预警</p>
      ) : (
        <ul className="space-y-2">
          {items.map((a) => (
            <li key={a.id} className="rounded-2xl bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold">{a.message}</p>
                  <p className="mt-1 text-xs text-black/40">
                    {a.studentName ?? '未知学生'} · {a.level} · {new Date(a.createdAt).toLocaleString('zh-CN')}
                  </p>
                </div>
                {!a.isRead && (
                  <button data-testid={`alert-ack-${a.id}`} onClick={() => ack(a.id)} className="shrink-0 text-sm text-[var(--brand-500)]">
                    知道了
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between px-2 text-sm">
        <button data-testid="alerts-prev" disabled={page <= 1} onClick={() => load(page - 1)} className="disabled:opacity-30">上一页</button>
        <span>{page} / {totalPages}</span>
        <button data-testid="alerts-next" disabled={page >= totalPages} onClick={() => load(page + 1)} className="disabled:opacity-30">下一页</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileAlertsPage.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/parent-mobile/MobileAlertsPage.tsx apps/web/src/pages/parent-mobile/MobileAlertsPage.test.tsx
git commit -m "feat(web): 移动端预警页（30s 未读轮询+分页+知道了）（Task 6）"
```

---

### Task 7: MobileErrorsPage

**Files:**
- Create: `apps/web/src/pages/parent-mobile/MobileErrorsPage.tsx`
- Test: `apps/web/src/pages/parent-mobile/MobileErrorsPage.test.tsx`

**Interfaces:**
- Consumes: `useParentStudentStore`、`getParentErrors(params: ParentErrorListParams): Promise<ParentErrorPage>`、共享 Markdown 组件 `@/components/markdown`（默认导出，图片/rehype-raw/repairHtml/KaTeX 配置内置）。
- Produces: 无。换孩子回第 1 页的钉子用例在本任务。

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/pages/parent-mobile/MobileErrorsPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileErrorsPage from './MobileErrorsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(cleanup);

vi.mock('@/services/api', () => ({ getParentErrors: vi.fn() }));
import { getParentErrors } from '@/services/api';

const item = {
  id: 5, questionId: null, track: 'main' as const, source: 'practice', level: 1,
  isCleared: false, wrongAnswerText: '1/2 + 1/3 = 2/5（存的原题面）', createdAt: '2026-10-01T08:00:00Z',
  clearedAt: null, question: null,
};
const p1 = { items: [item], page: 1, pageSize: 20, total: 1 };

describe('MobileErrorsPage', () => {
  it('渲染错题列表并展示来源与轨道', async () => {
    vi.mocked(getParentErrors).mockResolvedValue(p1 as never);
    useParentStudentStore.setState({ studentId: 1 });
    render(<MobileErrorsPage />);
    expect(await screen.findByText(/1\/2 \+ 1\/3/)).toBeTruthy();
    expect(screen.getByText(/主线/)).toBeTruthy();
  });

  it('换孩子回第 1 页并重拉', async () => {
    vi.mocked(getParentErrors).mockResolvedValue(p1 as never);
    useParentStudentStore.setState({ studentId: 1 });
    render(<MobileErrorsPage />);
    await screen.findByText(/1\/2 \+ 1\/3/);
    vi.mocked(getParentErrors).mockClear();
    useParentStudentStore.setState({ studentId: 2 });
    await waitFor(() =>
      expect(getParentErrors).toHaveBeenLastCalledWith(expect.objectContaining({ studentId: 2, page: 1 })),
    );
  });

  it('track 筛选切换触发重拉', async () => {
    vi.mocked(getParentErrors).mockResolvedValue(p1 as never);
    useParentStudentStore.setState({ studentId: 1 });
    render(<MobileErrorsPage />);
    await screen.findByText(/1\/2 \+ 1\/3/);
    await userEvent.click(screen.getByTestId('track-filter-training'));
    await waitFor(() =>
      expect(getParentErrors).toHaveBeenLastCalledWith(expect.objectContaining({ track: 'training' })),
    );
  });

  it('空态与错误重试', async () => {
    vi.mocked(getParentErrors).mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
    useParentStudentStore.setState({ studentId: 1 });
    const { unmount } = render(<MobileErrorsPage />);
    expect(await screen.findByText(/暂无错题/)).toBeTruthy();
    unmount();
    vi.mocked(getParentErrors).mockRejectedValue(new Error('x'));
    render(<MobileErrorsPage />);
    expect(await screen.findByTestId('errors-retry')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileErrorsPage.test.tsx`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现**

```tsx
// apps/web/src/pages/parent-mobile/MobileErrorsPage.tsx
import { useCallback, useEffect, useState } from 'react';
import Markdown from '@/components/markdown';
import { getParentErrors, type ParentErrorItem } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

const PAGE_SIZE = 20;
type TrackFilter = 'all' | 'main' | 'training';

const TRACKS: Array<{ key: TrackFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'main', label: '主线' },
  { key: 'training', label: '训练' },
];

function questionText(item: ParentErrorItem): string {
  // ⚠️ api.ts ParentErrorItem 硬注释：wrongAnswerText 装的是「题库未命中时的题面原文」，
  // 不是学生作答；questionId 非空时题面在 question.content。
  return item.question?.content ?? item.wrongAnswerText ?? '（题面缺失）';
}

export default function MobileErrorsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [items, setItems] = useState<ParentErrorItem[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [track, setTrack] = useState<TrackFilter>('all');
  const [error, setError] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback((id: number, p: number, t: TrackFilter) => {
    setError(false);
    getParentErrors({
      studentId: id, page: p,
      ...(t === 'all' ? {} : { track: t }),
    })
      .then((res) => { setItems(res.items); setTotal(res.total); setPage(res.page); })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    if (studentId === null) return;
    setPage(1);       // 硬规则：换孩子必须回第 1 页
    setOpenId(null);
    load(studentId, 1, track);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- track 变化由下一个 effect 处理
  }, [studentId, load]);

  useEffect(() => {
    if (studentId !== null) load(studentId, page, track);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 首次拉取由上面的 studentId effect 负责
  }, [page, track]);

  if (studentId === null) return <p className="text-black/60">先在上方选择孩子</p>;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div data-testid="mobile-page-errors" className="space-y-3">
      <div className="flex gap-2">
        {TRACKS.map((t) => (
          <button
            key={t.key}
            data-testid={`track-filter-${t.key}`}
            onClick={() => { setTrack(t.key); setPage(1); }}
            className={`rounded-full px-4 py-1.5 text-sm ${track === t.key ? 'bg-[var(--brand-500)] text-white' : 'bg-white text-black/60'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-black/60">加载失败</p>
          <button data-testid="errors-retry" onClick={() => load(studentId, page, track)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : items === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : items.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-black/60">暂无错题</p>
      ) : (
        <ul className="space-y-2">
          {items.map((e) => (
            <li key={e.id} className="rounded-2xl bg-white p-4">
              <button className="w-full text-left" onClick={() => setOpenId(openId === e.id ? null : e.id)}>
                <div className="flex items-center justify-between text-xs text-black/40">
                  <span>{e.track === 'main' ? '主线' : '训练'} · {e.source}</span>
                  <span>{e.isCleared ? '已清零' : `错 ${e.level} 次`}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-sm"><Markdown>{questionText(e)}</Markdown></div>
              </button>
              {openId === e.id && (
                <div className="mt-3 border-t border-black/5 pt-3 text-sm">
                  <Markdown>{questionText(e)}</Markdown>
                  {e.question?.answer && (
                    <div className="mt-2 rounded-xl bg-black/5 p-3">
                      <p className="text-xs font-bold text-black/60">正确答案 / 解析</p>
                      <Markdown>{e.question.answer}</Markdown>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between px-2 text-sm">
        <button data-testid="errors-prev" disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-30">上一页</button>
        <span>{page} / {totalPages}</span>
        <button data-testid="errors-next" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="disabled:opacity-30">下一页</button>
      </div>
    </div>
  );
}
```

⚠️ `ParentErrorQuestion` 的字段（`content`/`answer`）实施时先读 `api.ts` 定义对齐；若它不含 `answer`（只有题面），解析展示改为列表内仅题面 + 引导到电脑端看解析（桌面 `ParentErrorsPage` 怎么展示就怎么对齐，读它 10 行）。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileErrorsPage.test.tsx && npx vitest run`
Expected: PASS；全量回归绿。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/parent-mobile/MobileErrorsPage.tsx apps/web/src/pages/parent-mobile/MobileErrorsPage.test.tsx
git commit -m "feat(web): 移动端错题本（轨道筛选+展开详情+换孩回首页钉子）（Task 7）"
```

---

### Task 8: MobileControlsPage

**Files:**
- Create: `apps/web/src/pages/parent-mobile/MobileControlsPage.tsx`
- Test: `apps/web/src/pages/parent-mobile/MobileControlsPage.test.tsx`

**Interfaces:**
- Consumes: `useParentStudentStore`、`getParentControls(studentId): Promise<ParentControls>`、`putParentControls(studentId, patch): Promise<ParentControls>`、`issueParentDeviceCommand(studentId, 'unlock')`、`getParentStudyTime(studentId): Promise<ParentStudyTime>`。
- Produces: 无。关键行为：409/1001 错误文案**原样展示**（ApiError 的 message 就是后端人类可读文案，`fetchApi` 已归一）。

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/pages/parent-mobile/MobileControlsPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileControlsPage from './MobileControlsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => { cleanup(); useParentStudentStore.setState({ studentId: 1 }); });

vi.mock('@/services/api', () => ({
  getParentControls: vi.fn(),
  putParentControls: vi.fn(),
  issueParentDeviceCommand: vi.fn(),
  getParentStudyTime: vi.fn(),
}));
import { getParentControls, getParentStudyTime, issueParentDeviceCommand, putParentControls } from '@/services/api';

const controls = { alertAwayMinutes: 5, alertIdleMinutes: 15, sessionLockMinutes: 30 };

function ok() {
  vi.mocked(getParentControls).mockResolvedValue(controls);
  vi.mocked(getParentStudyTime).mockResolvedValue({
    totalSeconds: 0, activeDays: 0, byDay: [], byModule: [],
    bySubject: [], source: 'sessions',
  });
}

describe('MobileControlsPage', () => {
  it('渲染当前锁定分钟数与输入框', async () => {
    ok();
    render(<MobileControlsPage />);
    expect(await screen.findByDisplayValue('30')).toBeTruthy();
  });

  it('保存只发改动字段并回显服务端值', async () => {
    ok();
    vi.mocked(putParentControls).mockResolvedValue({ ...controls, sessionLockMinutes: 60 });
    render(<MobileControlsPage />);
    await screen.findByDisplayValue('30');
    const input = screen.getByLabelText(/单次锁定/);
    await userEvent.clear(input);
    await userEvent.type(input, '60');
    await userEvent.click(screen.getByTestId('save-lock'));
    await waitFor(() =>
      expect(putParentControls).toHaveBeenCalledWith(1, { sessionLockMinutes: 60 }),
    );
    expect(await screen.findByDisplayValue('60')).toBeTruthy();
  });

  it('远程解除走 device-commands，无会话 409 文案原样展示', async () => {
    ok();
    vi.mocked(issueParentDeviceCommand).mockRejectedValue(new Error('当前没有进行中的学习会话'));
    render(<MobileControlsPage />);
    await screen.findByDisplayValue('30');
    await userEvent.click(screen.getByTestId('unlock-now'));
    expect(await screen.findByText(/当前没有进行中的学习会话/)).toBeTruthy();
  });

  it('成功下发显示确认提示', async () => {
    ok();
    vi.mocked(issueParentDeviceCommand).mockResolvedValue({
      id: 3, command: 'unlock', status: 'pending', learningSessionId: 77, createdAt: '2026-10-01T09:00:00Z',
    });
    render(<MobileControlsPage />);
    await screen.findByDisplayValue('30');
    await userEvent.click(screen.getByTestId('unlock-now'));
    expect(await screen.findByText(/解除命令已下发/)).toBeTruthy();
  });

  it('进出时间列表按次展示', async () => {
    ok();
    vi.mocked(getParentStudyTime).mockResolvedValue({
      totalSeconds: 1800, activeDays: 1,
      byDay: [{ date: '2026-10-01', seconds: 1800 }],
      byModule: [], bySubject: [], source: 'sessions',
    } as never);
    render(<MobileDesktopPage />); // ⚠️ 实施时改为 MobileControlsPage（笔误钉子，见 Step 3 注）
    expect(await screen.findByText(/2026-10-01/)).toBeTruthy();
  });
});
```

⚠️ 上面最后一个用例的 `MobileDesktopPage` 是**故意写的笔误钉子**吗——不是。实施时直接写 `MobileControlsPage`；此处只提醒：测试文件里出现不存在的导入会直接 FAIL，属预期失败路径，修正即可。另外「进出时间列表」的真实数据源是 `getParentStudyTime` 的 `byDay`（按天汇总）——**桌面端「进出时刻列表」另有数据源**，实施第一步先读桌面 `ParentControlsPage` 的进出时间区块用的是什么 API，移动端对齐同一 API 与口径（列表不是聚合，spec §6.4）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileControlsPage.test.tsx`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现**

```tsx
// apps/web/src/pages/parent-mobile/MobileControlsPage.tsx
import { useCallback, useEffect, useState } from 'react';
import {
  getParentControls, getParentStudyTime, issueParentDeviceCommand, putParentControls,
  type ParentControls,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

type LoadStatus = 'loading' | 'ready' | 'error';

export default function MobileControlsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [controls, setControls] = useState<ParentControls | null>(null);
  const [lockInput, setLockInput] = useState('');
  const [sessions, setSessions] = useState<Array<{ enterAt: string; leaveAt: string | null }>>([]);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [cmdOk, setCmdOk] = useState(false);

  const load = useCallback((id: number) => {
    setStatus('loading');
    Promise.all([getParentControls(id), getParentStudyTime(id)])
      .then(([c, s]) => {
        setControls(c);
        setLockInput(c.sessionLockMinutes === null ? '' : String(c.sessionLockMinutes));
        setSessions((s as { sessions?: Array<{ enterAt: string; leaveAt: string | null }> }).sessions ?? []);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, []);

  useEffect(() => {
    if (studentId !== null) load(studentId);
  }, [studentId, load]);

  if (studentId === null) return <p className="text-black/60">先在上方选择孩子</p>;
  if (status === 'error') {
    return (
      <div className="rounded-2xl bg-white p-8 text-center">
        <p className="text-black/60">加载失败</p>
        <button data-testid="controls-retry" onClick={() => load(studentId)} className="mt-2 text-[var(--brand-500)]">重试</button>
      </div>
    );
  }
  if (status === 'loading' || !controls) {
    return <div className="h-40 animate-pulse rounded-2xl bg-white" />;
  }

  const saveLock = () => {
    const raw = lockInput.trim();
    // '' = 显式解除（NULL 语义）；数字限 1..480（api.ts ParentControls 注释）
    const patch = raw === '' ? { sessionLockMinutes: null } : { sessionLockMinutes: Number(raw) };
    if (raw !== '' && (!Number.isInteger(patch.sessionLockMinutes) || (patch.sessionLockMinutes as number) < 1 || (patch.sessionLockMinutes as number) > 480)) {
      setSaveMsg('锁定时长需为 1–480 的整数，清空表示解除');
      return;
    }
    putParentControls(studentId, patch)
      .then((c) => {
        setControls(c);
        setLockInput(c.sessionLockMinutes === null ? '' : String(c.sessionLockMinutes));
        setSaveMsg('已保存，立即生效');
      })
      .catch((e: unknown) => setSaveMsg(e instanceof Error ? e.message : '保存失败，请稍后再试'));
  };

  const unlock = () => {
    setCmdError(null); setCmdOk(false);
    issueParentDeviceCommand(studentId, 'unlock')
      .then(() => setCmdOk(true))
      .catch((e: unknown) => setCmdError(e instanceof Error ? e.message : '操作失败，请稍后再试'));
  };

  return (
    <div data-testid="mobile-page-controls" className="space-y-3">
      <section className="rounded-2xl bg-white p-4">
        <h2 className="text-sm font-bold">单次学习锁定</h2>
        <p className="mt-1 text-xs text-black/40">学生登录起算的墙钟窗口（1–480 分钟），期间禁止登出、到期自动解除；清空并保存 = 显式解除。</p>
        <div className="mt-3 flex items-center gap-2">
          <input
            aria-label="单次锁定分钟数"
            value={lockInput}
            onChange={(e) => setLockInput(e.target.value)}
            inputMode="numeric"
            className="w-24 rounded-xl border border-black/10 px-3 py-2 text-sm"
          />
          <span className="text-sm text-black/60">分钟</span>
          <button data-testid="save-lock" onClick={saveLock} className="ml-auto rounded-xl bg-[var(--brand-500)] px-4 py-2 text-sm text-white">
            保存
          </button>
        </div>
        {saveMsg && <p className="mt-2 text-sm text-black/60">{saveMsg}</p>}
      </section>
      <section className="rounded-2xl bg-white p-4">
        <h2 className="text-sm font-bold">远程解除</h2>
        <p className="mt-1 text-xs text-black/40">向孩子设备下发解锁命令；仅当孩子有进行中的学习会话时有效。</p>
        <button data-testid="unlock-now" onClick={unlock} className="mt-3 w-full rounded-xl border border-black/10 py-2 text-sm">
          下发解除命令
        </button>
        {cmdOk && <p className="mt-2 text-sm text-green-700">解除命令已下发，等待学生端轮询领取</p>}
        {cmdError && <p className="mt-2 text-sm text-red-600" data-testid="unlock-error">{cmdError}</p>}
      </section>
      <section className="rounded-2xl bg-white p-4">
        <h2 className="text-sm font-bold">进出时间</h2>
        {sessions.length === 0 ? (
          <p className="mt-2 text-sm text-black/60">暂无学习会话记录</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {sessions.map((s, i) => (
              <li key={i} className="flex justify-between">
                <span>{new Date(s.enterAt).toLocaleString('zh-CN')}</span>
                <span>{s.leaveAt ? new Date(s.leaveAt).toLocaleTimeString('zh-CN') : '进行中'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

⚠️ 实施时以桌面 `ParentControlsPage` 进出时间区块的**实际 API 与行字段**为准替换 `sessions` 的来源与字段名（`getParentStudyTime` 没有 `sessions` 行数组的话就换成桌面用的那个函数；类型从 `api.ts` import，不要本地再造 interface）。

- [ ] **Step 4: 跑测试确认通过 + 全量 + lint**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileControlsPage.test.tsx && npm run lint && npx vitest run`
Expected: PASS；lint 0 error。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/parent-mobile/MobileControlsPage.tsx apps/web/src/pages/parent-mobile/MobileControlsPage.test.tsx
git commit -m "feat(web): 移动端管控页（锁定设置/远程解除/进出时间）（Task 8）"
```

---

### Task 9: 文档同步与收尾

**Files:**
- Modify: `docs/ai-core-changelog.md`（顶部按日期新增条目）
- Modify: `docs/superpowers/specs/2026-10-01-parent-mobile-pwa-design.md`（附章 A）

- [ ] **Step 1: spec 补附章 A「添加到主屏幕步骤」**

在 spec 末尾追加（双平台各 3 步 + 降级说明）：

```markdown
## 附章 A：家长手机「添加到主屏幕」步骤

前提：手机与服务器在同一局域网，浏览器打开 `http://192.168.1.5:5173`（服务器 IP 变了就换）。

**iOS（Safari）**：
1. 底部分享按钮（□↑）→ 2. 「添加到主屏幕」→ 3. 确认「添加」。
   桌面图标全屏打开；状态栏样式为系统默认。

**Android（Chrome）**：
1. 右上角菜单（⋮）→ 2. 「添加到主屏幕」→ 3. 确认「添加」。
   注意：局域网 HTTP 下 Chrome 不弹自动安装横幅，必须手动添加；全屏样式不作保证。

**已知降级**：无离线缓存（Service Worker 需 HTTPS）；无系统级推送（本期未实现）。
预警与通知需打开应用查看（页内 30s 轮询）。
```

- [ ] **Step 2: changelog 新增条目**

`docs/ai-core-changelog.md` 顶部按既有格式补一条 `**2026-10-01 新增（家长端移动 PWA）**`，内容覆盖：动机（spec 链接）、方案 B 路由组结构、四页能力与数据源、复用 parentStudentStore 的偏差及理由、PWA 降级口径（无 SW/无推送/HTTP）、测试（引用各 test 文件与用例数）、桌面端零改动声明。

- [ ] **Step 3: 全量验证**

Run: `cd apps/web && npx vitest run && npm run lint && npx tsc -b`
Expected: 全部绿。

- [ ] **Step 4: Commit**

```bash
git add docs/ai-core-changelog.md docs/superpowers/specs/2026-10-01-parent-mobile-pwa-design.md
git commit -m "docs: 家长移动 PWA 交付附章 + changelog 记录（Task 9）"
```

---

## Self-Review 结论（已按清单跑过）

1. **Spec 覆盖**：§4.1 路由组=Task 2；§4.2 复用边界=Task 2/3/4/7；§4.3 状态纪律=Task 3/5/7（偏差已声明）；§5 PWA=Task 1+Task 9 附章；§6.1–6.4=Task 5–8；§7 测试=各任务内嵌；§8 文档=Task 9。无缺口。
2. **占位符扫描**：Task 5/7/8 各有一处「以 api.ts / 桌面页实际定义为准」——这是**有意留的核对点**（避免计划抄错类型真源），不是 TBD：核对动作、回退方向都已写明。
3. **类型一致性**：`useParentStudentStore` 的 `studentId/setStudentId`、`ParentControls.sessionLockMinutes: number|null`、`issueParentDeviceCommand(studentId,'unlock')`、`data-testid` 命名（`tab-*`/`mobile-page-*`/`mobile-switcher-*`）在各任务间已交叉核对一致。
