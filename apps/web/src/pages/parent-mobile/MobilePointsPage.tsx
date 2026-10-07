import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConfirmDialog } from '@/components/base';
import { getParentPoints, type MyPoints } from '@/services/api';
import PointRulesPanel from '@/pages/parent/points/PointRulesPanel';
import RewardCatalogPanel, { type LeaveGuard } from '@/pages/parent/points/RewardCatalogPanel';
import RedeemPanel from '@/pages/parent/points/RedeemPanel';
import PointsSettingsPanel from '@/pages/parent/points/PointsSettingsPanel';
import RedemptionHistoryPanel from '@/pages/parent/points/RedemptionHistoryPanel';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * /m/parent/points 移动端积分与兑换页（家长移动端 2B Task 3）。
 *
 * 本页只做**组装**：四个区块的业务逻辑全部来自桌面 `pages/parent/points/` 的
 * 五个面板组件（一行不改、只消费），行为语义照抄桌面 ParentPointsPage：
 *
 * 1. Tab 深链走 `useSearchParams`，未知 / 缺失的 `?tab=` 一律归一成 `rules`
 *    ——与桌面同一批 key、同一套归一语义。
 * 2. 概览卡常驻 Tab 条之上：加载给骨架、失败给内联错误 + 重试、就绪才渲染。
 *    数据带 `studentId` 归属（CLAUDE.md 硬规则）：切换孩子当帧旧数据即不可见，
 *    不靠 effect 清空（那会慢一帧画出上个孩子的分数）。
 * 3. 未保存草稿保护：`RewardCatalogPanel` 经 `onRegisterLeaveGuard` 注册
 *    `LeaveGuard`（五个面板中唯一提供该通道的）。与桌面的差异：移动端的确认弹窗
 *    **由本页渲染**（桌面是面板 `confirmLeave` 弹自己的）。面板 `confirmLeave` 的
 *    语义是「打开面板自己的弹窗」，页面在家长确认后若再调它会二次弹窗——
 *    因此确认后只执行挂起动作（切 Tab / 换孩子），不回调面板；草稿随面板卸载蒸发。
 * 4. 换孩子沿用桌面的「生效 id 慢一拍」模式（`activeStudentId`）：store 换人瞬间
 *    若守卫 dirty，页面停在旧孩子等家长回答（草稿不被 key 重挂载弄丢，弹窗才问得到
 *    真东西）；确认 → 跟随 store + 回默认 Tab + 概览随 studentId 变化自动重拉；
 *    取消 → 把 store 回滚到旧孩子（顶栏与页面从此一致）。守卫宿主消失（面板卸载、
 *    dirty 归 false）时挂起立刻解析、跟随 store，页面不会冻结在旧孩子上。
 * 5. 兑换成功链：`RedeemPanel.onPointsChanged` → 重拉概览 + 历史面板 refreshToken
 *    自增；`PointsSettingsPanel.onSettingsChanged` → settingsVersion 自增透传给
 *    同 Tab 的 `RedeemPanel`（与桌面同款最小耦合通道）。
 */

const TABS = [
  { key: 'rules', label: '积分规则' },
  { key: 'catalog', label: '奖励清单' },
  { key: 'redeem', label: '兑换' },
  { key: 'history', label: '兑换记录' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const DEFAULT_TAB: TabKey = 'rules';

/** 未知 / 缺失的 tab 一律归一成默认档，不报错也不空页。 */
function normalizeTab(raw: string | null): TabKey {
  return TABS.find((tab) => tab.key === raw)?.key ?? DEFAULT_TAB;
}

/**
 * 挂起中的离场确认。`tab` = 切 Tab 被拦（确认后切到 `tab`）；
 * `student` = 换孩子被拦（确认后跟随 store）。目标孩子不记在这里——解除挂起时
 * 现读 store，家长在弹窗期间又换人（2 → 3）不会被拖去过期的目标。
 */
type PendingLeave = { kind: 'tab'; tab: TabKey } | { kind: 'student' } | null;

export default function MobilePointsPage() {
  const storeStudentId = useParentStudentStore((s) => s.studentId);
  const setStoreStudentId = useParentStudentStore((s) => s.setStudentId);

  /**
   * 页面**实际使用**的 studentId（渲染 key、所有请求都按它走）。正常等于 store 值；
   * 唯一会停在旧值的情况：store 换了孩子而当前面板有未保存草稿、家长还没回答确认
   * 弹窗（桌面 ParentPointsPage 同款，见那边长注释）。
   */
  const [studentId, setActiveStudentId] = useState(storeStudentId);
  const [pending, setPending] = useState<PendingLeave>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeTab(searchParams.get('tab'));

  /** 另一个 Tab 的面板（奖励清单）注册进来的离场守卫；null = 当前没有面板注册。 */
  const leaveGuardRef = useRef<LeaveGuard | null>(null);
  /** 守卫的 dirty 快照（ref 不触发渲染，Tab 上的小圆点需要 state）。 */
  const [leaveGuardDirty, setLeaveGuardDirty] = useState(false);

  const [overview, setOverview] = useState<{ studentId: number; points: MyPoints } | null>(null);
  const [failedStudentId, setFailedStudentId] = useState<number | null>(null);
  /** 递增触发重拉（重试按钮与兑换成功链共用）。 */
  const [reload, setReload] = useState(0);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [historyToken, setHistoryToken] = useState(0);

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    setFailedStudentId(null);
    getParentPoints(studentId)
      .then((res) => {
        if (cancelled) return;
        setOverview({ studentId, points: res });
      })
      .catch(() => {
        if (cancelled) return;
        setFailedStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, reload]);

  // 读取时现算归属：studentId 已切走时旧数据 / 旧失败立即不可见（不等 effect 清空）
  const points = overview && overview.studentId === studentId ? overview.points : null;
  const failed = failedStudentId === studentId;

  /**
   * 面板注册 / 注销离场守卫。必须 `useCallback` 固定身份：面板的注册 effect 依赖
   * 这个函数，每次渲染换个新函数会让「注册 → 页面 setState → 再注册」转起来。
   */
  const registerLeaveGuard = useCallback((guard: LeaveGuard | null) => {
    leaveGuardRef.current = guard;
    setLeaveGuardDirty(guard?.dirty ?? false);
  }, []);

  /** 真正写 `?tab=`（守卫已放行或压根没有守卫时才走到这）。 */
  const commitTab = useCallback(
    (key: TabKey) => {
      const next = new URLSearchParams(searchParams);
      next.set('tab', key);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const selectTab = (key: TabKey) => {
    if (key === activeTab) return;
    // 已有确认弹窗挂着（fixed 覆盖层其实也挡住了 Tab）：不再叠加第二个挂起
    if (pending) return;
    if (leaveGuardRef.current?.dirty) {
      setPending({ kind: 'tab', tab: key });
      return;
    }
    commitTab(key);
  };

  /**
   * store 换了孩子：先问守卫，脏就挂起（不换人，面板不被 key 卸载）。
   * 用 `useLayoutEffect`：绘制前解析完，用户看不到「新孩子顶栏 + 旧孩子面板」的那一帧。
   */
  useLayoutEffect(() => {
    if (pending) return;
    if (storeStudentId === studentId) return;
    // store 回落成 null（孩子被删 / id 失效）：没有孩子可换，草稿必然作废，
    // 直接进空态——不问守卫（「确定离开吗」给不出第二个选项），桌面同款例外。
    if (storeStudentId === null) {
      setActiveStudentId(null);
      return;
    }
    if (leaveGuardRef.current?.dirty) {
      setPending({ kind: 'student' });
      return;
    }
    setActiveStudentId(storeStudentId);
    // 回默认 Tab（brief 语义：换孩子 = 全部重来，不带着上个孩子的上下文）
    setSearchParams({ tab: DEFAULT_TAB });
  }, [storeStudentId, studentId, pending, setSearchParams]);

  /**
   * 挂起中的换孩子：守卫宿主可能已消失（面板卸载把 ref 清成 null / dirty 归 false）
   * ——此时草稿随面板没了，再弹确认也问不到人，必须立刻解析、跟随 store，
   * 否则上面的 layout effect 每次都在 `pending` 处 early return，页面永远停在旧孩子。
   * `leaveGuardDirty` 进依赖是探测「守卫快照变了」的机制本体（桌面同款）。
   */
  useLayoutEffect(() => {
    if (pending?.kind !== 'student') return;
    const guard = leaveGuardRef.current;
    if (guard?.dirty) return;
    setPending(null);
    setActiveStudentId(storeStudentId);
  }, [pending, storeStudentId, leaveGuardDirty, setActiveStudentId]);

  const confirmLeave = () => {
    if (pending === null) return;
    const current = pending;
    setPending(null);
    if (current.kind === 'tab') {
      commitTab(current.tab);
      return;
    }
    // 换孩子：跟随 store（目标现读，不用历史值）+ 回默认 Tab；概览随 studentId 变化自动重拉
    setActiveStudentId(storeStudentId);
    setSearchParams({ tab: DEFAULT_TAB });
  };

  const cancelLeave = () => {
    if (pending?.kind === 'student') {
      // 页面没真的换人，store 里不能留着新孩子（否则顶栏与页面从此不一致）
      setStoreStudentId(studentId);
    }
    setPending(null);
  };

  if (studentId === null) {
    return (
      <div data-testid="mobile-page-points">
        <p className="rounded-2xl bg-white p-8 text-center text-[var(--text-secondary)]">
          先在上方选择孩子
        </p>
      </div>
    );
  }

  return (
    <div data-testid="mobile-page-points" className="space-y-3">
      {failed ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">积分信息暂时加载失败</p>
          <button
            data-testid="points-retry"
            onClick={() => setReload((n) => n + 1)}
            className="mt-2 text-[var(--brand-600)]"
          >
            重试
          </button>
        </div>
      ) : points === null ? (
        <div className="h-28 animate-pulse rounded-2xl bg-white" />
      ) : (
        <div data-testid="points-overview" className="rounded-2xl bg-white p-4">
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-[var(--text-secondary)]">可用积分</p>
            <p className="text-2xl font-bold tabular-nums text-[var(--text-primary)]">
              {`${points.balance} 分`}
            </p>
          </div>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            {`累计 ${points.totalEarned} · 今日 +${points.todayEarned}`}
          </p>
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-[var(--text-secondary)]">{points.level.name}</span>
            {points.nextLevel ? (
              <span className="text-[var(--text-tertiary)]">
                {points.pointsToNextLevel === null
                  ? `升级到「${points.nextLevel.name}」`
                  : `距 ${points.nextLevel.name} 还差 ${points.pointsToNextLevel} 分`}
              </span>
            ) : (
              <span className="text-[var(--text-secondary)]">已达最高段位</span>
            )}
          </div>
          {/* 满级时进度条写死 100%（桌面同款兜底，不依赖服务端 progressPercent） */}
          <div className="mt-1 h-1.5 rounded-full bg-[var(--bg-subtle)]">
            <div
              className="h-full rounded-full bg-[var(--brand-500)]"
              style={{ width: `${points.nextLevel ? points.progressPercent : 100}%` }}
            />
          </div>
        </div>
      )}

      <nav className="-mx-1 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="积分页区块">
        {TABS.map((tab) => {
          const selected = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              data-testid={`points-tab-${tab.key}`}
              id={`points-tab-${tab.key}`}
              role="tab"
              aria-selected={selected}
              aria-controls="points-tabpanel"
              onClick={() => selectTab(tab.key)}
              className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm transition-colors ${
                selected
                  ? 'bg-[var(--brand-500)] text-white'
                  : 'bg-white text-[var(--text-secondary)]'
              }`}
            >
              {tab.label}
              {/*
                「未保存」小圆点。aria-hidden 有意：它若进了可访问名，Tab 的名字会
                变成「奖励清单 有未保存的修改」（桌面同款处理）。
              */}
              {tab.key === 'catalog' && leaveGuardDirty && (
                <span
                  data-testid="points-tab-catalog-dirty"
                  aria-hidden="true"
                  title="有未保存的修改"
                  className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand-500)] align-middle"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* key 里的 studentId 是「切孩子丢弃一切」的机制本体：面板整体重挂载，草稿蒸发 */}
      <div key={`${studentId}-${activeTab}`} id="points-tabpanel" role="tabpanel" aria-labelledby={`points-tab-${activeTab}`}>
        {activeTab === 'rules' && <PointRulesPanel studentId={studentId} />}
        {activeTab === 'catalog' && (
          <RewardCatalogPanel studentId={studentId} onRegisterLeaveGuard={registerLeaveGuard} />
        )}
        {activeTab === 'redeem' && (
          <div className="space-y-3">
            <PointsSettingsPanel
              studentId={studentId}
              onSettingsChanged={() => setSettingsVersion((n) => n + 1)}
            />
            <RedeemPanel
              studentId={studentId}
              settingsVersion={settingsVersion}
              onPointsChanged={() => {
                // 兑换动了余额（→概览卡）也产生了一条新记录（→兑换记录面板）
                setReload((n) => n + 1);
                setHistoryToken((n) => n + 1);
              }}
            />
          </div>
        )}
        {activeTab === 'history' && (
          <RedemptionHistoryPanel studentId={studentId} refreshToken={historyToken} />
        )}
      </div>

      {pending !== null && (
        <div data-testid="points-leave-confirm">
          <ConfirmDialog
            open
            title="有未保存的修改"
            message="有未保存的修改，确定离开吗？"
            onConfirm={confirmLeave}
            onCancel={cancelLeave}
          />
        </div>
      )}
    </div>
  );
}
