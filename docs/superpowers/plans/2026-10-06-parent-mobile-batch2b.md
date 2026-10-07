# 家长移动端第二批 B（2B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把积分与兑换 / 学习报告 / AI 对话记录三个桌面家长功能搬上移动路由组，全用既有端点与既有面板/图表组件，零后端改动。

**Architecture:** 延续 v1/2A 方案 B（spec `2026-10-06-parent-mobile-batch2b-design.md`）。关键复用决策：**积分页不复写业务逻辑**——桌面已把积分功能拆成五个自包含面板组件（`pages/parent/points/*Panel.tsx`，各带测试），移动页只做概览卡 + Tab 条 + 面板组装 + 草稿守卫接线；报告页直接复用自研 `ChartLine`/`ChartBar`（SVG 自适应宽度）。

**Tech Stack:** React 19 + react-router 6 + Zustand + recharts（经 ChartLine/ChartBar 薄封装）+ Tailwind + vitest/@testing-library（`globals:false`）。

## Global Constraints

- **零后端改动**；桌面 13 页、`pages/parent/points/` 五个面板组件与其测试**一行不动**（本批只消费）。
- 配色全 token（`--text-secondary` #4B5563 / `--text-tertiary` #9CA3AF / `--bg-subtle` #E5E9F0 / `--error` #DC2626 / `--brand-500` #2563EB / `--bg-base` #F5F7FA）；禁止 `text-black/60` 类快捷写法，改完 grep 自检为 0。
- 测试自写 `afterEach(cleanup())`（`globals:false`）。
- 页面 `data-testid="mobile-page-<name>"` 挂所有状态共用外层容器。
- 换孩子：分页列表回第 1 页；派生状态带 `studentId` 归属；**异步 load 必须 cancelled 守卫**（MobileControlsPage / MobileGoalsPage 两次事故）；换孩清编辑态/草稿。
- 有未保存草稿时切 Tab / 换孩子**拦截确认**（积分页）。
- 消息/图片渲染走共享配置；**`/uploads/` 绝对路径不要过 `resolveAsset`**（api.ts 硬注释）。
- **验收必经 Playwright WebKit（390×844）**；vitest/build 必须 `cd apps/web`（根目录假失败）。

## File Structure

```
apps/web/src/routes/ParentViewportGate.tsx               # Task 1 修改（映射 +3）
apps/web/src/routes/ParentViewportGate.test.tsx          # Task 1 补用例
apps/web/src/pages/parent-mobile/MobileMorePage.tsx      # Task 1 修改（3 项 stub→live）
apps/web/src/pages/parent-mobile/MobilePointsPage.tsx    # Task 3（+test）
apps/web/src/pages/parent-mobile/MobileReportPage.tsx    # Task 2（+test）
apps/web/src/pages/parent-mobile/MobileChatLogsPage.tsx  # Task 4（+test）
apps/web/src/routes/routeTable.tsx                       # Task 1 修改（3 条路由）
apps/web/src/routes/mobileParentRoutes.test.tsx          # Task 1 补用例
docs/ai-core-changelog.md                                # Task 5
docs/UX-UI设计文档.md                                     # Task 5（§5.10）
```

---

### Task 1: 路由 + 视口守卫映射 + 「更多」stub→live

**Files:**
- Modify: `apps/web/src/routes/ParentViewportGate.tsx`、`ParentViewportGate.test.tsx`
- Modify: `apps/web/src/pages/parent-mobile/MobileMorePage.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`、`apps/web/src/routes/mobileParentRoutes.test.tsx`
- Create: 3 个占位空壳 `MobilePointsPage/MobileReportPage/MobileChatLogsPage.tsx`（`export default function MobileXxx() { return <div data-testid="mobile-page-xxx" />; }`，Task 2–4 替换）

**Interfaces:**
- Consumes: 2A 的 `MOBILE_LIVE_ITEMS` / `MOBILE_STUB_ITEMS` 结构。
- Produces: `mobileParentPath` 支持 `points/report/chat-logs`；`rewards` 仍映射 `/m/parent/points`。

- [ ] **Step 1: 更新测试（先失败）**

`ParentViewportGate.test.tsx` 追加（router 桩路由加 `m-points/m-report/m-chatlogs`）：

```tsx
it('mobileParentPath：2B 段映射（rewards 沿用指向积分页）', () => {
  expect(mobileParentPath('/parent/points')).toBe('/m/parent/points');
  expect(mobileParentPath('/parent/report')).toBe('/m/parent/report');
  expect(mobileParentPath('/parent/chat-logs')).toBe('/m/parent/chat-logs');
  expect(mobileParentPath('/parent/rewards')).toBe('/m/parent/points');
});
```

`mobileParentRoutes.test.tsx` 的「更多页两组」用例改为：stub 组只剩 `more-stub-subscription`；live 组增加 `more-live-points/report/chat-logs`；并追加 3 条直测用例（经真实 routeTable 访问 `/m/parent/points|report|chat-logs` 断言各自 testid，api mock 补静默 stub）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/routes/`
Expected: FAIL

- [ ] **Step 3: 实现**

`ParentViewportGate.tsx`：`MOBILE_SUPPORTED` 追加 `'points', 'report', 'chat-logs'`；`MORE_STUBS` 收敛为 `new Set(['subscription'])`（`rewards → /m/parent/points` 的特判保留在 seg 判断之后）。

`MobileMorePage.tsx`：`MOBILE_LIVE_ITEMS` 追加三项 `{ key: 'points', label: '积分与兑换', to: '/m/parent/points' }`、`{ key: 'report', label: '学习报告', to: '/m/parent/report' }`、`{ key: 'chat-logs', label: 'AI 对话记录', to: '/m/parent/chat-logs' }`；`MOBILE_STUB_ITEMS` 收敛为仅 `{ key: 'subscription', label: '订阅管理' }`。

`routeTable.tsx`：`/m/parent` children 追加 `points/report/chat-logs` 三条（占位空壳 import）。

- [ ] **Step 4: 跑测试 + 全量 + tsc + build**

Run: `cd apps/web && npx vitest run src/routes/ src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: PASS；全量绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端 2B 路由骨架 + 守卫映射 + 更多页占位收敛（Task 1）"
```

---

### Task 2: 学习报告 MobileReportPage

**Files:**
- Modify: `apps/web/src/pages/parent-mobile/MobileReportPage.tsx`（替换占位）
- Test: `apps/web/src/pages/parent-mobile/MobileReportPage.test.tsx`

**Interfaces:**
- Consumes: `useParentStudentStore`；`getParentReport(studentId, period: 'weekly'|'monthly'): Promise<ParentLearningReport>`（`{ stats, trend: ParentTrendPoint[{date,answered,correct,rate}], subjects, weakPoints, weakPointsUncoveredCount, exams }`）；`getParentStudyTime(studentId, from?)`。
- Produces: `data-testid="mobile-page-report"`。

- [ ] **Step 1: 写失败测试**

```tsx
// MobileReportPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileReportPage from './MobileReportPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => { cleanup(); useParentStudentStore.setState({ studentId: 1 }); });

vi.mock('@/services/api', () => ({
  getParentReport: vi.fn(),
  getParentStudyTime: vi.fn(),
}));
import { getParentReport, getParentStudyTime } from '@/services/api';

const report = {
  studentId: 1, period: 'weekly', windowStart: '2026-09-28', windowEnd: '2026-10-04',
  stats: { activeDays: 5, answered: 40, correct: 32, rate: 80, selfAssessCount: 2, errorsAdded: 3, errorsCleared: 5, examCount: 1 },
  trend: [
    { date: '2026-09-28', answered: 5, correct: 4, rate: 80 },
    { date: '2026-09-29', answered: 3, correct: 3, rate: 100 },
    { date: '2026-09-30', answered: 6, correct: 0, rate: null }, // 只有主观自评的当天
  ],
  subjects: [{ subjectId: 2, subjectName: '数学', answered: 14, rate: 78.6 }],
  weakPoints: [{ knowledgePointName: '分数运算', errorCount: 3 }],
  weakPointsUncoveredCount: 2,
  exams: [],
};

describe('MobileReportPage', () => {
  it('渲染统计卡/趋势图/学科答题量/薄弱点口径', async () => {
    vi.mocked(getParentReport).mockResolvedValue(report as never);
    vi.mocked(getParentStudyTime).mockResolvedValue({ totalSeconds: 3600, activeDays: 2, byDay: [], byModule: [], bySubject: [], source: 'sessions' });
    render(<MobileReportPage />);
    expect(await screen.findByText(/40/)).toBeTruthy();
    // 图表渲染（recharts 经薄封装出现 SVG）
    expect(document.querySelector('svg')).not.toBeNull();
    // 薄弱点覆盖率口径必须显式提示（弱映射不到知识点的条数）
    expect(screen.getByText(/2/)).toBeTruthy();
    // 双口径并列文案
    expect(screen.getByTestId('report-study-time')).toBeTruthy();
    expect(screen.getByTestId('report-active-days')).toBeTruthy();
  });

  it('weekly/monthly 切换整页重拉', async () => {
    vi.mocked(getParentReport).mockResolvedValue(report as never);
    vi.mocked(getParentStudyTime).mockResolvedValue({ totalSeconds: 0, activeDays: 0, byDay: [], byModule: [], bySubject: [], source: 'sessions' });
    render(<MobileReportPage />);
    await screen.findByText(/40/);
    await userEvent.click(screen.getByTestId('report-period-monthly'));
    await waitFor(() => expect(getParentReport).toHaveBeenLastCalledWith(1, 'monthly'));
  });

  it('拉取失败显示错误重试', async () => {
    vi.mocked(getParentReport).mockRejectedValue(new Error('x'));
    render(<MobileReportPage />);
    expect(await screen.findByTestId('report-retry')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileReportPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// MobileReportPage.tsx
import { useEffect, useState } from 'react';
import ChartBar from '@/components/business/parent/ChartBar';
import ChartLine from '@/components/business/parent/ChartLine';
import { getParentReport, getParentStudyTime, type ParentLearningReport, type ParentReportPeriod, type ParentStudyTime } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

type LoadStatus = 'loading' | 'ready' | 'error';
type Period = ParentReportPeriod;

function shortDay(date: string): string {
  return date.slice(5).replace('-', '/');
}

export default function MobileReportPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [period, setPeriod] = useState<Period>('weekly');
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [report, setReport] = useState<ParentLearningReport | null>(null);
  const [study, setStudy] = useState<ParentStudyTime | null>(null);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false; // 换孩/切周期竞态守卫（MobileControlsPage 模式）
    setStatus('loading');
    const h = Math.floor(Date.now() / 1000);
    void h; // from 参数本页不传（近 7 天缺省）
    Promise.all([getParentReport(studentId, period), getParentStudyTime(studentId)])
      .then(([r, s]) => {
        if (cancelled) return;
        setReport(r); setStudy(s); setOwnerId(studentId); setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [studentId, period, reload]);

  if (studentId === null) {
    return <div data-testid="mobile-page-report"><p className="text-[var(--text-secondary)]">先在上方选择孩子</p></div>;
  }
  if (status === 'error') {
    return (
      <div data-testid="mobile-page-report">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="report-retry" onClick={() => setReload((n) => n + 1)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      </div>
    );
  }
  if (status === 'loading' || ownerId !== studentId || report === null) {
    return <div data-testid="mobile-page-report"><div className="h-24 animate-pulse rounded-2xl bg-white" /></div>;
  }

  const fmt = (sec: number) => { const hh = Math.floor(sec / 3600); const mm = Math.round((sec % 3600) / 60); return hh > 0 ? `${hh} 小时 ${mm} 分` : `${mm} 分钟`; };

  return (
    <div data-testid="mobile-page-report" className="space-y-3">
      <div className="flex gap-2">
        {(['weekly', 'monthly'] as const).map((p) => (
          <button key={p} data-testid={`report-period-${p}`} onClick={() => setPeriod(p)}
            className={`rounded-full px-4 py-1.5 text-sm ${period === p ? 'bg-[var(--brand-500)] text-white' : 'bg-white text-[var(--text-secondary)]'}`}>
            {p === 'weekly' ? '本周' : '本月'}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-2xl bg-white p-4"><p className="text-xs text-[var(--text-tertiary)]">答题数</p><p className="text-lg font-bold">{report.stats.answered}</p></div>
        <div className="rounded-2xl bg-white p-4"><p className="text-xs text-[var(--text-tertiary)]">正确率</p><p className="text-lg font-bold">{report.stats.rate === null ? '暂无数据' : `${report.stats.rate}%`}</p></div>
      </div>
      <div className="rounded-2xl bg-white p-4">
        <h2 className="mb-3 text-base font-bold">正确率趋势</h2>
        <ChartLine
          points={report.trend.filter((t) => t.rate !== null).map((t) => ({ label: shortDay(t.date), value: t.rate as number }))}
          emptyText="本期还没有答题记录"
        />
      </div>
      <div className="rounded-2xl bg-white p-4">
        <h2 className="mb-3 text-base font-bold">各学科答题量</h2>
        <ChartBar
          points={report.subjects.map((s) => ({ label: `${s.subjectName} ${s.rate === null ? '—' : `${s.rate}%`}`, value: s.answered }))}
          emptyText="本期还没有答题记录"
        />
      </div>
      <div className="rounded-2xl bg-white p-4 text-sm">
        <h2 className="mb-2 text-base font-bold">学习时长</h2>
        {study && (
          <p>
            <span data-testid="report-study-time">会话口径 {fmt(study.totalSeconds)}</span>
            {' · '}
            <span data-testid="report-active-days">有学习 {study.activeDays} 天</span>
          </p>
        )}
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">口径说明：时长按学习会话统计；天数按有记录的天数统计，两者独立计算。</p>
      </div>
      <div className="rounded-2xl bg-white p-4 text-sm">
        <h2 className="mb-2 text-base font-bold">薄弱知识点</h2>
        {report.weakPoints.length === 0 ? (
          <p className="text-[var(--text-secondary)]">暂无薄弱点记录</p>
        ) : (
          <ul className="space-y-1">
            {report.weakPoints.map((w) => (
              <li key={w.knowledgePointName} className="flex justify-between"><span>{w.knowledgePointName}</span><span>错 {w.errorCount} 次</span></li>
            ))}
          </ul>
        )}
        {report.weakPointsUncoveredCount > 0 && (
          <p className="mt-2 text-xs text-[var(--text-tertiary)]">另有 {report.weakPointsUncoveredCount} 条未清零错题未映射到知识点，不在上列。</p>
        )}
      </div>
    </div>
  );
}
```

⚠️ 实施第一步核对 `ParentLearningReport.stats` 与 `weakPoints` 行的**实际字段名**（`knowledgePointName/errorCount` 是按桌面页用法推断）——以 api.ts 真源为准同步修正代码与测试 mock（桌面 `ParentReportPage.tsx` 怎么取就怎么取）。

- [ ] **Step 4: 跑测试 + 全量 + tsc + build**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: PASS；全量绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端学习报告（周期切换 + ChartLine/ChartBar 复用）（Task 2）"
```

---

### Task 3: 积分与兑换 MobilePointsPage（复用五面板）

**Files:**
- Modify: `apps/web/src/pages/parent-mobile/MobilePointsPage.tsx`（替换占位）
- Test: `apps/web/src/pages/parent-mobile/MobilePointsPage.test.tsx`

**Interfaces:**
- Consumes（桌面面板，**只消费不修改**，全部在 `pages/parent/points/`）：
  - `getParentPoints(studentId): Promise<MyPoints>`（`{ balance, totalEarned, todayEarned, level, nextLevel: PointLevel|null, pointsToNextLevel: number|null, progressPercent }`）
  - `<PointRulesPanel studentId={n} />`（自带校验/保存，无外部依赖）
  - `<PointsSettingsPanel studentId={n} onSettingsChanged={(next: PointsSettings) => void} />`
  - `<RedeemPanel studentId={n} onPointsChanged?={() => void} settingsVersion?={number} />`
  - `<RewardCatalogPanel studentId={n} onRegisterLeaveGuard?={(guard: LeaveGuard|null) => void} />`（`LeaveGuard = { dirty: boolean; requestLeave(onConfirmed, onCancelled?) }`）
  - `<RedemptionHistoryPanel studentId={n} refreshToken?={number} />`
- Produces: `data-testid="mobile-page-points"`；Tab 条 testid `points-tab-rules/catalog/redeem/history`。

**行为语义（照抄桌面 ParentPointsPage）：**
- 桌面 TABS 键序：`rules → catalog → redeem → history`（缺省 rules；未知 `?tab=` 归一 rules）——移动端沿用同一批 key，深链语义一致。
- `?tab=` 走 `useSearchParams`；`RewardCatalogPanel` 的 `onRegisterLeaveGuard` 注册进页（卸载/换面板注销）。
- 切 Tab：若当前面板守卫 `dirty === true` → 弹确认（`ConfirmDialog`），确认才切。
- 换孩子：`leaveGuardDirty` 同样先确认；确认后清守卫 + 回默认 Tab + 重拉概览。
- 兑换成功链：`RedeemPanel.onPointsChanged` → 重拉 `getParentPoints` + `setRefreshToken(n+1)`（历史面板重拉）+ `setSettingsVersion(n+1)`。

- [ ] **Step 1: 写失败测试**

```tsx
// MobilePointsPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobilePointsPage from './MobilePointsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => { cleanup(); useParentStudentStore.setState({ studentId: 1 }); });

const points = {
  balance: 500, totalEarned: 1200, todayEarned: 10,
  level: { code: 'qingtong', name: '青铜' }, nextLevel: { code: 'baiyin', name: '白银' },
  pointsToNextLevel: 800, progressPercent: 58,
};
const rulesPayload = { tasks: [] }; // 结构以 MyPointRules 真源为准，面板自行消费

vi.mock('@/services/api', () => ({ getParentPoints: vi.fn() }));
// 面板组件 mock：本任务只测页面组装（Tab 切换/概览卡/守卫接线），面板内部逻辑有各自的测试
vi.mock('@/pages/parent/points/PointRulesPanel', () => ({ default: () => <div data-testid="panel-rules" /> }));
vi.mock('@/pages/parent/points/RewardCatalogPanel', () => ({
  default: ({ onRegisterLeaveGuard }: { onRegisterLeaveGuard?: (g: { dirty: boolean; requestLeave: (ok: () => void) => void } | null) => void }) => {
    onRegisterLeaveGuard?.({ dirty: true, requestLeave: (ok) => ok() });
    return <div data-testid="panel-catalog" />;
  },
}));
vi.mock('@/pages/parent/points/RedeemPanel', () => ({ default: () => <div data-testid="panel-redeem" /> }));
vi.mock('@/pages/parent/points/PointsSettingsPanel', () => ({ default: () => <div data-testid="panel-settings" /> }));
vi.mock('@/pages/parent/points/RedemptionHistoryPanel', () => ({ default: () => <div data-testid="panel-history" /> }));
import { getParentPoints } from '@/services/api';

describe('MobilePointsPage', () => {
  it('概览卡常驻 + 默认 Tab=规则 + 四个 Tab 条', async () => {
    vi.mocked(getParentPoints).mockResolvedValue(points as never);
    render(<MobilePointsPage />);
    expect(await screen.findByText(/500/)).toBeTruthy();
    expect(screen.getByText(/青铜/)).toBeTruthy();
    expect(screen.getByTestId('panel-rules')).toBeTruthy();
    for (const k of ['rules', 'catalog', 'redeem', 'history']) {
      expect(screen.getByTestId(`points-tab-${k}`)).toBeTruthy();
    }
  });

  it('切 Tab：有未保存草稿时拦截确认，确认后才切', async () => {
    vi.mocked(getParentPoints).mockResolvedValue(points as never);
    render(<MobilePointsPage />);
    await screen.findByTestId('panel-rules');
    // 先进奖励册（注册 dirty 守卫），再试图离开
    await userEvent.click(screen.getByTestId('points-tab-catalog'));
    expect(await screen.findByTestId('panel-catalog')).toBeTruthy();
    await userEvent.click(screen.getByTestId('points-tab-history'));
    // 拦截弹窗出现，history 未切换
    expect(await screen.findByTestId('points-leave-confirm')).toBeTruthy();
    expect(screen.queryByTestId('panel-history')).toBeNull();
    await userEvent.click(screen.getByTestId('points-leave-ok'));
    expect(await screen.findByTestId('panel-history')).toBeTruthy();
  });

  it('换孩子：dirty 时同样拦截', async () => {
    vi.mocked(getParentPoints).mockResolvedValue(points as never);
    render(<MobilePointsPage />);
    await screen.findByTestId('panel-rules');
    await userEvent.click(screen.getByTestId('points-tab-catalog'));
    expect(await screen.findByTestId('panel-catalog')).toBeTruthy();
    useParentStudentStore.setState({ studentId: 2 });
    expect(await screen.findByTestId('points-leave-confirm')).toBeTruthy();
  });

  it('getParentPoints 失败显示错误重试', async () => {
    vi.mocked(getParentPoints).mockRejectedValue(new Error('x'));
    render(<MobilePointsPage />);
    expect(await screen.findByTestId('points-retry')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobilePointsPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// MobilePointsPage.tsx
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConfirmDialog } from '@/components/base';
import { getParentPoints, type MyPoints } from '@/services/api';
import PointRulesPanel from '@/pages/parent/points/PointRulesPanel';
import RewardCatalogPanel, { type LeaveGuard } from '@/pages/parent/points/RewardCatalogPanel';
import RedeemPanel from '@/pages/parent/points/RedeemPanel';
import PointsSettingsPanel from '@/pages/parent/points/PointsSettingsPanel';
import RedemptionHistoryPanel from '@/pages/parent/points/RedemptionHistoryPanel';
import { useParentStudentStore } from '@/store/parentStudentStore';

const TABS = [
  { key: 'rules', label: '积分规则' },
  { key: 'catalog', label: '奖励清单' },
  { key: 'redeem', label: '兑换' },
  { key: 'history', label: '兑换记录' },
] as const;
type TabKey = (typeof TABS)[number]['key'];
const DEFAULT_TAB: TabKey = 'rules';

function normalizeTab(raw: string | null): TabKey {
  return (TABS.find((t) => t.key === raw)?.key ?? DEFAULT_TAB) as TabKey;
}

type LoadStatus = 'loading' | 'ready' | 'error';

export default function MobilePointsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeTab(searchParams.get('tab'));
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [points, setPoints] = useState<MyPoints | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [historyToken, setHistoryToken] = useState(0);
  const [leaveGuard, setLeaveGuard] = useState<LeaveGuard | null>(null);
  const [leaveGuardDirty, setLeaveGuardDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<TabKey | null>(null);
  const [pendingStudent, setPendingStudent] = useState<number | null>(null);

  const loadPoints = useCallback(() => {
    if (studentId === null) return;
    setError(false);
    getParentPoints(studentId)
      .then((p) => { setPoints(p); setStatus('ready'); })
      .catch(() => setError(true));
  }, [studentId]);

  useEffect(() => { loadPoints(); }, [loadPoints, reload]);

  const registerLeaveGuard = useCallback((guard: LeaveGuard | null) => {
    setLeaveGuard(guard);
    setLeaveGuardDirty(guard?.dirty ?? false);
  }, []);

  /** 离场守卫：dirty 时返回 true 表示需要拦截（pendingX 挂起，确认后执行）。 */
  const guardLeave = (then: () => void): boolean => {
    if (leaveGuard?.dirty) {
      setPendingTab(null);
      setPendingStudent(studentId);
      setPendingAction(then);
      return true;
    }
    return false;
  };
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const selectTab = (key: TabKey) => {
    if (key === activeTab) return;
    if (guardLeave(() => setSearchParams({ tab: key }, { replace: false }))) { setPendingTab(key); return; }
    setSearchParams({ tab: key }, { replace: false });
  };

  // 换孩子：dirty 先拦截（挂起 studentId），确认后清守卫 + 归一默认 Tab
  const lastStudentRef = useRef<number | null>(null);
  useEffect(() => {
    if (studentId === null) return;
    if (lastStudentRef.current !== null && lastStudentRef.current !== studentId) {
      if (leaveGuard?.dirty) {
        setPendingStudent(studentId);
        return; // 不更新 lastStudentRef，确认后真正切换
      }
      setSearchParams({ tab: DEFAULT_TAB }, { replace: false });
      setLeaveGuard(null); setLeaveGuardDirty(false);
      setPoints(null); setStatus('loading'); loadPoints();
    }
    lastStudentRef.current = studentId;
  }, [studentId, leaveGuard, loadPoints]);

  const confirmLeave = () => {
    leaveGuard?.requestLeave(() => { /* 面板确认回调（面板自己清草稿态） */ });
    setLeaveGuard(null); setLeaveGuardDirty(false);
    if (pendingTab !== null) setSearchParams({ tab: pendingTab }, { replace: false });
    if (pendingStudent !== null) {
      setSearchParams({ tab: DEFAULT_TAB }, { replace: false });
      setLeaveGuard(null); setLeaveGuardDirty(false);
      setPoints(null); setStatus('loading'); loadPoints();
    }
    setPendingTab(null); setPendingStudent(null); setPendingAction(null);
  };
  const cancelLeave = () => { setPendingTab(null); setPendingStudent(null); setPendingAction(null); };

  if (studentId === null) {
    return <div data-testid="mobile-page-points"><p className="text-[var(--text-secondary)]">先在上方选择孩子</p></div>;
  }

  return (
    <div data-testid="mobile-page-points" className="space-y-3">
      {error ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="points-retry" onClick={() => setReload((n) => n + 1)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : status === 'loading' || points === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : (
        <div className="rounded-2xl bg-white p-4">
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-[var(--text-secondary)]">可用余额</p>
            <p className="text-2xl font-bold">{points.balance}</p>
          </div>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            累计 {points.totalEarned} · 今日 +{points.todayEarned}
          </p>
          <div className="mt-2 flex items-center justify-between text-xs text-[var(--text-tertiary)]">
            <span>{points.level.name}</span>
            {points.nextLevel && <span>距 {points.nextLevel.name} 还差 {points.pointsToNextLevel}</span>}
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-[var(--bg-subtle)]">
            <div className="h-full rounded-full bg-[var(--brand-500)]" style={{ width: `${points.progressPercent}%` }} />
          </div>
        </div>
      )}
      <nav className="-mx-1 flex gap-1 overflow-x-auto px-1" aria-label="积分页区块">
        {TABS.map((t) => (
          <button key={t.key} data-testid={`points-tab-${t.key}`} onClick={() => selectTab(t.key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm ${activeTab === t.key ? 'bg-[var(--brand-500)] text-white' : 'bg-white text-[var(--text-secondary)]'}`}>
            {t.label}{t.key === 'catalog' && leaveGuardDirty ? ' •' : ''}
          </button>
        ))}
      </nav>
      {/* 概览卡数据变化时同步透传：兑换成功 → 重拉概览 + 历史刷新 + 设置版本号递增 */}
      <div key={`${studentId}-${activeTab}`}>
        {activeTab === 'rules' && <PointRulesPanel studentId={studentId} />}
        {activeTab === 'catalog' && <RewardCatalogPanel studentId={studentId} onRegisterLeaveGuard={registerLeaveGuard} />}
        {activeTab === 'redeem' && (
          <div className="space-y-3">
            <PointsSettingsPanel studentId={studentId} onSettingsChanged={() => setSettingsVersion((n) => n + 1)} />
            <RedeemPanel studentId={studentId} settingsVersion={settingsVersion} onPointsChanged={() => { setReload((n) => n + 1); setHistoryToken((n) => n + 1); }} />
          </div>
        )}
        {activeTab === 'history' && <RedemptionHistoryPanel studentId={studentId} refreshToken={historyToken} />}
      </div>
      {(pendingTab !== null || pendingStudent !== null) && (
        <ConfirmDialog
          open
          title="有未保存的修改"
          message="有未保存的修改，确定离开吗？"
          onConfirm={confirmLeave}
          onCancel={cancelLeave}
        />
      )}
    </div>
  );
}
```

⚠️ 实施注意：① 上面 `guardLeave/pendingAction` 的挂起结构比较绕——实施时允许重构成更直白的单一 `pendingRef`（记录挂起动作 + 弹窗文案），**行为语义以四条测试为准**（拦截面板切换、拦截换孩、确认后执行、取消不切）。② `MyPoints.level`/`nextLevel` 的字段名（`code/name`）以 api.ts 真源为准核对。③ 桌面 `ParentPointsPage.tsx` 的 `commitTab`/换孩拦截细节（:224 起）是行为真源，实施前先读。

- [ ] **Step 4: 跑测试 + 全量 + tsc + build**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: PASS；全量绿（桌面面板测试原样通过）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端积分与兑换（概览卡 + 四 Tab 组装桌面面板 + 草稿守卫）（Task 3）"
```

---

### Task 4: AI 对话记录 MobileChatLogsPage

**Files:**
- Modify: `apps/web/src/pages/parent-mobile/MobileChatLogsPage.tsx`（替换占位）
- Test: `apps/web/src/pages/parent-mobile/MobileChatLogsPage.test.tsx`

**Interfaces:**
- Consumes: `useParentStudentStore`；`getParentChatLogs({ studentId, track?, q?, page }): Promise<ParentChatLogPage>`（`items: ParentChatLogItem[{ id, track, scene, title, messageCount, blockCount, createdAt, updatedAt }]`）；`getParentChatLogDetail(studentId, dialogueId): Promise<ParentChatLogDetail>`（`messages: ParentChatLogMessage[{ id, role: 'user'|'assistant'|'system', content, safetyFlag, images: string[], ... }]`）。
- Produces: `data-testid="mobile-page-chatlogs"`。

**行为语义（沿用桌面 ParentChatLogsPage）：**
- 筛选：track（全部/主线/辅线）+ 标题搜索 `q`（桌面还有 scene/from/to，移动端 v1 隐藏——已声明简化）。
- 回放：点会话 → 整页回放；回放 1002 失败 → 内联失败条（桌面 detailFailure 语义：仅当失败会话仍是当前选中态时显示）。
- 消息渲染：Markdown 共享配置；`role` 分侧；`safetyFlag === 1` 打红色「偏离学习」标记；
  `images[]` 是 `/uploads/` 绝对路径，**直接 `<img src>`，不要 `resolveAsset`**。
- 分页换孩回第 1 页；列表与回放数据带 studentId 归属守卫。

- [ ] **Step 1: 写失败测试**

```tsx
// MobileChatLogsPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileChatLogsPage from './MobileChatLogsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => { cleanup(); useParentStudentStore.setState({ studentId: 1 }); });

vi.mock('@/services/api', () => ({
  getParentChatLogs: vi.fn(),
  getParentChatLogDetail: vi.fn(),
}));
import { getParentChatLogDetail, getParentChatLogs } from '@/services/api';

const logItem = { id: 11, track: 'mainline', scene: 'mainline', title: '一元二次方程讨论', subjectId: 2, createdAt: '2026-10-05T10:00:00Z', updatedAt: '2026-10-05T10:30:00Z', messageCount: 4, blockCount: 1 };
const page1 = { items: [logItem], page: 1, pageSize: 20, total: 1 };
const detail = { ...logItem, messages: [
  { id: 1, role: 'user', content: '老师，什么是判别式？', reasoning: null, type: null, model: null, safetyFlag: 0, createdAt: '2026-10-05T10:00:00Z', images: [] },
  { id: 2, role: 'assistant', content: '判别式是 $b^2-4ac$。', reasoning: null, type: null, model: 'qwen', safetyFlag: 1, createdAt: '2026-10-05T10:01:00Z', images: [] },
] };

describe('MobileChatLogsPage', () => {
  it('渲染会话列表：标题/条数/偏离标记/track 筛选', async () => {
    vi.mocked(getParentChatLogs).mockResolvedValue(page1 as never);
    render(<MobileChatLogsPage />);
    expect(await screen.findByText(/一元二次方程讨论/)).toBeTruthy();
    expect(screen.getByText(/4 条/)).toBeTruthy();
    expect(screen.getByText(/偏离学习/)).toBeTruthy();
    await userEvent.click(screen.getByTestId('chatlogs-track-mainline'));
    await waitFor(() => expect(getParentChatLogs).toHaveBeenLastCalledWith(expect.objectContaining({ track: 'mainline', page: 1 })));
  });

  it('点会话进整页回放：Markdown/公式渲染 + 偏离标记 + 返回列表', async () => {
    vi.mocked(getParentChatLogs).mockResolvedValue(page1 as never);
    vi.mocked(getParentChatLogDetail).mockResolvedValue(detail as never);
    render(<MobileChatLogsPage />);
    await screen.findByText(/一元二次方程讨论/);
    await userEvent.click(screen.getByTestId('chatlog-open-11'));
    expect(await screen.findByTestId('chatlogs-detail')).toBeTruthy();
    expect(document.querySelector('.katex')).not.toBeNull();
    expect(screen.getAllByText(/偏离学习/).length).toBeGreaterThan(0);
    expect(getParentChatLogDetail).toHaveBeenCalledWith(1, 11);
    await userEvent.click(screen.getByTestId('chatlogs-back'));
    expect(await screen.findByText(/一元二次方程讨论/)).toBeTruthy();
  });

  it('回放 1002 失败：内联失败条，不弹全页错误', async () => {
    vi.mocked(getParentChatLogs).mockResolvedValue(page1 as never);
    vi.mocked(getParentChatLogDetail).mockRejectedValue(new Error('该会话不属于该学生'));
    render(<MobileChatLogsPage />);
    await screen.findByText(/一元二次方程讨论/);
    await userEvent.click(screen.getByTestId('chatlog-open-11'));
    expect(await screen.findByTestId('chatlogs-detail-error')).toBeTruthy();
    // 列表仍在（返回可重试）
    expect(screen.getByTestId('chatlogs-back')).toBeTruthy();
  });

  it('换孩子回第 1 页并重拉', async () => {
    vi.mocked(getParentChatLogs).mockResolvedValue(page1 as never);
    render(<MobileChatLogsPage />);
    await screen.findByText(/一元二次方程讨论/);
    vi.mocked(getParentChatLogs).mockClear();
    useParentStudentStore.setState({ studentId: 2 });
    await waitFor(() => expect(getParentChatLogs).toHaveBeenLastCalledWith(expect.objectContaining({ studentId: 2, page: 1 })));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/MobileChatLogsPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// MobileChatLogsPage.tsx —— 列表态与回放态共用一个组件（activeDialogueId state 切换）
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, markdownRehypePlugins, markdownRemarkPlugins, preprocessMarkdown } from '@/components/markdown';
import {
  getParentChatLogDetail, getParentChatLogs,
  type ParentChatLogDetail, type ParentChatLogItem, type ParentChatLogMessage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

const PAGE_SIZE = 20;
type LoadStatus = 'loading' | 'ready' | 'error';

function MsgBubble({ m }: { m: ParentChatLogMessage }) {
  return (
    <div className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
      <div className={`max-w-[85%] rounded-2xl p-3 text-sm ${m.role === 'user' ? 'bg-white' : 'bg-[var(--bg-subtle)]'}`}>
        {m.safetyFlag === 1 && <p className="mb-1 text-xs text-[var(--error)]">⚠ 偏离学习</p>}
        {/* /uploads/ 绝对路径直接渲染；注意 images 不过 resolveAsset（api.ts 硬注释） */}
        {m.images.map((src) => <img key={src} src={src} alt="" className="my-1 max-w-full rounded-lg" />)}
        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
          {preprocessMarkdown(m.content)}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export default function MobileChatLogsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [track, setTrack] = useState<'all' | 'mainline' | 'auxiliary'>('all');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ParentChatLogItem[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [listError, setListError] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ParentChatLogDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const loadList = useCallback((id: number, p: number, t: 'all' | 'mainline' | 'auxiliary', query: string) => {
    setListError(false);
    getParentChatLogs({
      studentId: id, page: p,
      ...(t === 'all' ? {} : { track: t }),
      ...(query.trim() ? { q: query.trim() } : {}),
    })
      .then((res) => { setItems(res.items); setTotal(res.total); setPage(res.page); })
      .catch(() => setListError(true));
  }, []);

  useEffect(() => {
    if (studentId === null) return;
    loadList(studentId, 1, track, q);
  }, [studentId, loadList]); // track/q 变化由下方 handler 显式重拉并回第 1 页

  const openDetail = (item: ParentChatLogItem) => {
    if (studentId === null) return;
    const seq = ++seqRef.current;
    setActiveId(item.id);
    setDetail(null); setDetailError(null);
    getParentChatLogDetail(studentId, item.id)
      .then((d) => { if (seq === seqRef.current) setDetail(d); })
      .catch((e: unknown) => { if (seq === seqRef.current) setDetailError(e instanceof Error ? e.message : '回放加载失败'); });
  };

  // 换孩子：关回放 + 回第 1 页（回放/列表数据的 seq 守卫已防旧响应覆盖）
  const lastStudentRef = useRef<number | null>(null);
  useEffect(() => {
    if (lastStudentRef.current !== null && lastStudentRef.current !== studentId) {
      setActiveId(null); setDetail(null); setDetailError(null);
    }
    lastStudentRef.current = studentId;
  }, [studentId]);

  if (studentId === null) {
    return <div data-testid="mobile-page-chatlogs"><p className="text-[var(--text-secondary)]">先在上方选择孩子</p></div>;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ===== 回放态 =====
  if (activeId !== null) {
    const item = items?.find((x) => x.id === activeId) ?? null;
    return (
      <div data-testid="mobile-page-chatlogs" className="space-y-3">
        <button data-testid="chatlogs-back" onClick={() => { setActiveId(null); setDetail(null); setDetailError(null); }}
          className="text-sm text-[var(--brand-500)]">← 返回列表</button>
        {item && (
          <div className="rounded-2xl bg-white p-4">
            <p className="text-sm font-bold">{item.title ?? '未命名会话'}</p>
            <p className="text-xs text-[var(--text-tertiary)]">{item.track === 'mainline' ? '主线' : '辅线'} · {new Date(item.createdAt).toLocaleString('zh-CN')}</p>
          </div>
        )}
        {detailError ? (
          <div data-testid="chatlogs-detail-error" className="rounded-2xl bg-white p-6 text-center text-sm text-[var(--error)]">{detailError}</div>
        ) : detail === null ? (
          <div className="h-24 animate-pulse rounded-2xl bg-white" />
        ) : (
          <div data-testid="chatlogs-detail" className="space-y-2">
            {detail.messages.filter((m) => m.role !== 'system').map((m) => <MsgBubble key={m.id} m={m} />)}
          </div>
        )}
      </div>
    );
  }

  // ===== 列表态 =====
  return (
    <div data-testid="mobile-page-chatlogs" className="space-y-3">
      <div className="flex gap-2">
        {([['all', '全部'], ['mainline', '主线'], ['auxiliary', '辅线']] as const).map(([k, label]) => (
          <button key={k} data-testid={`chatlogs-track-${k}`}
            onClick={() => { setTrack(k); if (studentId !== null) loadList(studentId, 1, k, q); }}
            className={`rounded-full px-4 py-1.5 text-sm ${track === k ? 'bg-[var(--brand-500)] text-white' : 'bg-white text-[var(--text-secondary)]'}`}>
            {label}
          </button>
        ))}
      </div>
      <input placeholder="搜索会话标题" value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && studentId !== null) loadList(studentId, 1, track, q); }}
        className="w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm" />
      {listError ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="chatlogs-retry" onClick={() => loadList(studentId, page, track, q)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : items === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : items.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-[var(--text-secondary)]">暂无对话记录</p>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li key={c.id} className="rounded-2xl bg-white p-4">
              <button data-testid={`chatlog-open-${c.id}`} onClick={() => openDetail(c)} className="w-full text-left">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold">{c.title ?? '未命名会话'}</p>
                  {c.blockCount > 0 && <span className="text-xs text-[var(--error)]">偏离学习 ×{c.blockCount}</span>}
                </div>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {c.track === 'mainline' ? '主线' : '辅线'} · {c.messageCount} 条 · {new Date(c.updatedAt).toLocaleString('zh-CN')}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between px-2 text-sm">
        <button data-testid="chatlogs-prev" disabled={page <= 1} onClick={() => studentId !== null && loadList(studentId, page - 1, track, q)} className="disabled:opacity-30">上一页</button>
        <span>{page} / {totalPages}</span>
        <button data-testid="chatlogs-next" disabled={page >= totalPages} onClick={() => studentId !== null && loadList(studentId, page + 1, track, q)} className="disabled:opacity-30">下一页</button>
      </div>
    </div>
  );
}
```

⚠️ 实施第一步：**先读桌面 `ParentChatLogsPage.tsx`**（476 行）核对——回放气泡的角色分侧方向、偏离标记文案、`detailFailure` 的展示条件（它是「仅当失败会话 = 当前选中态」的守卫）、以及 `q` 搜索是否防抖（桌面若防抖则照抄节流参数）。语义冲突处以桌面为真源。

- [ ] **Step 4: 跑测试 + 全量 + tsc + build**

Run: `cd apps/web && npx vitest run src/pages/parent-mobile/ && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: PASS；全量绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): 移动端 AI 对话记录（列表 + 整页回放 + 偏离标记）（Task 4）"
```

---

### Task 5: 文档同步与收尾（WebKit 端到端走查）

**Files:**
- Modify: `docs/ai-core-changelog.md`、`docs/UX-UI设计文档.md`（§5.10）

- [ ] **Step 1: UX 文档 §5.10 扩充**

「更多」页此时 **stub 清零**（订阅待用户立项时回归）：补一段 2B 三页（积分与兑换四区块 Tab / 学习报告周期切换 / AI 对话记录整页回放）。

- [ ] **Step 2: changelog 新条目**

`## 2026-10-06 · 家长移动端第二批 B`：三页端点与交互要点；**面板复用决策**（积分页不复写业务逻辑，直接组装桌面五个 `points/*Panel` 组件，草稿守卫接线）；`/uploads/` 图片不过 resolveAsset 的硬注释；WebKit 走查结果。

- [ ] **Step 3: 全量验证 + WebKit 走查**

Run: `cd apps/web && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run lint 2>&1 | tail -1 && npm run build 2>&1 | tail -1`
Expected: 全量绿、tsc 0、lint 0 error、build 成功。

WebKit 走查（390×844）：三页逐页过——积分页四 Tab 切换与概览卡、报告页图表与周期切换、对话列表与回放；「更多」页无 stub。

- [ ] **Step 4: Commit**

```bash
git add docs/ai-core-changelog.md docs/UX-UI设计文档.md
git commit -m "docs: 家长移动端 2B 文档同步（Task 5）"
```

---

## Self-Review 结论

1. **Spec 覆盖**：§1 路由/入口=Task 1；§3 积分=Task 3；§5 报告=Task 2；§6 对话=Task 4；§7 测试=各任务内嵌 + Task 5 走查；§8 文档=Task 5。无缺口。
2. **占位符扫描**：Task 2 的字段名核对点、Task 3 的「允许重构挂起结构」与「level 字段名核对」、Task 4 的「先读桌面页」均为**有核对方向的行为锚点**，非 TBD。
3. **类型一致性**：testid（`mobile-page-points/report/chatlogs`、`points-tab-*`、`chatlog-open-*`、`report-period-*`）在各任务间交叉核对一致；`LeaveGuard` 形状与桌面真源一致。
