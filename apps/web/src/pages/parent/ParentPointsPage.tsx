import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, LevelIcon, Progress, Skeleton } from '@/components/base';
import { getParentPoints, type MyPoints } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import PointRulesPanel from './points/PointRulesPanel';
import RewardCatalogPanel, { type LeaveGuard } from './points/RewardCatalogPanel';
import RedeemPanel from './points/RedeemPanel';
import PointsSettingsPanel from './points/PointsSettingsPanel';
import RedemptionHistoryPanel from './points/RedemptionHistoryPanel';

/**
 * 家长端「积分与奖励」（计划三 §2.3，路由 `/parent/rewards`，替换 UX P6.7 占位）。
 *
 * 本页只负责五件事，四个 Tab 的内容由 Task 5–8 各自的面板组件填充：
 *
 * 1. **Tab 深链**走 `useSearchParams`，未知 / 缺失的 `?tab=` 一律归一成 `rules`
 *    —— 分享出去的链接带了脏参数也不该白屏或报错。
 * 2. **概览卡常驻**在 Tab 之上：加载给骨架、失败给内联错误条 + 重试、
 *    就绪才渲染段位与分数。**绝不先渲染「劈柴 0 分」再跳成真实值**——
 *    那会让人以为积分归零（spec 明写）。
 * 3. **孩子上下文**：`studentId === null` 时渲染空态（不是骨架、也不崩），
 *    引导去 `/parent/students` 开通账号；否则所有请求都按这个 id 走。
 * 4. **切孩子丢弃一切**：概览立刻退回骨架（不拿上一个孩子的分数顶替），
 *    面板包一层 `key={`${studentId}-${activeTab}`}` —— React 会**重挂载**面板，
 *    面板内的草稿（输入中的分值、翻到的页码）随之蒸发。跨学生提交是事故，
 *    这条靠重挂载而不是靠面板自觉写「清草稿」。
 * 5. **未保存草稿保护（Task 6）**：面板是**按 Tab 条件渲染**的，切 Tab 就卸载、
 *    草稿随之蒸发，所以面板自己拦不住任何一次离场——只有页面能拦。通道是
 *    `leaveGuardRef`（面板 mount 时注册一个 `{dirty, confirmLeave}`、卸载注销）；
 *    `selectTab` 与「store 换孩子」两条路径在真正切换前先问它。**切孩子要多做一步**：
 *    见下面 `activeStudentId` 的注释。
 *
 * 配色一律 `style.md` §2.3 的 CSS 变量（`ParentLayout` 已给 `data-theme="parent"`，
 * 强制日间、无切换）。段位图标统一 `--brand-500`，不做学生端那套明度阶。
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

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-button)] bg-[var(--bg-base)] p-4">
      <div className="text-xs text-[var(--text-secondary)]">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-[var(--text-primary)]">
        {`${value} 分`}
      </div>
    </div>
  );
}

function OverviewCard({ points }: { points: MyPoints }) {
  return (
    <Card data-testid="points-overview" className="p-6">
      <div className="flex items-center gap-4">
        <span data-testid="points-overview-level-icon" className="shrink-0 text-[var(--brand-500)]">
          <LevelIcon code={points.level.code} size={40} />
        </span>
        <div className="min-w-0">
          <div className="text-xl font-bold text-[var(--text-primary)]">{points.level.name}</div>
          <div className="text-xs text-[var(--text-tertiary)]">
            {`累计 ${points.totalEarned} 分`}
          </div>
        </div>
      </div>

      <div className="mt-5">
        {/* 满级时进度条写死 100%，不依赖服务端的 progressPercent（后端也给 100，这里是兜底） */}
        <Progress value={points.nextLevel ? points.progressPercent : 100} />
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs">
          {points.nextLevel ? (
            <>
              <span className="text-[var(--text-secondary)]">
                {points.pointsToNextLevel === null
                  ? '距下一档'
                  : `距下一档还差 ${points.pointsToNextLevel} 分`}
              </span>
              <span className="text-[var(--text-tertiary)]">
                {`升级到「${points.nextLevel.name}」`}
              </span>
            </>
          ) : (
            <span className="text-[var(--text-secondary)]">已达最高段位</span>
          )}
        </div>
      </div>

      {/* ≥1024（iPad 横屏）三列，窄屏单列堆叠——计划 §1.2#4 */}
      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <StatCard label="可用积分" value={points.balance} />
        <StatCard label="累计积分" value={points.totalEarned} />
        <StatCard label="今日获得" value={points.todayEarned} />
      </div>
    </Card>
  );
}

export default function ParentPointsPage() {
  const storeStudentId = useParentStudentStore((s) => s.studentId);
  const setStoreStudentId = useParentStudentStore((s) => s.setStudentId);

  /**
   * 页面**实际使用**的 studentId（渲染 key、所有请求都按它走）。
   *
   * 正常就等于 store 值；只有一种情况会停在旧值：store 换了孩子、而当前面板有
   * 未保存草稿、家长还没回答确认弹窗。**为什么非得这样**：store 是外部状态，
   * 「切孩子」那一瞬本页就会用新 id 重渲染，面板 key 一变就被卸载、草稿当场蒸发，
   * 之后再弹什么都救不回草稿（连「取消」都只能回到一个空表单）。把生效 id 慢一拍
   * 交给 effect 决定，面板就留在原地等着家长选：确认 → 跟着换人，取消 → 把 store
   * 回滚到旧孩子。跨学生提交是事故，**静默丢草稿同样是事故**。
   */
  const [studentId, setActiveStudentId] = useState(storeStudentId);
  /** store 想切到的新孩子（非 null = 确认弹窗还开着，先不换人）。 */
  const [pendingStudentId, setPendingStudentId] = useState<number | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeTab(searchParams.get('tab'));

  /** 另一个 Tab 的面板（如奖励清单）注册进来的离场守卫；null = 当前 Tab 没有面板或面板干净。 */
  const leaveGuardRef = useRef<LeaveGuard | null>(null);
  /** 守卫的 dirty 快照（ref 不触发渲染，Tab 上的小圆点需要 state）。 */
  const [leaveGuardDirty, setLeaveGuardDirty] = useState(false);

  const [overview, setOverview] = useState<{ studentId: number; points: MyPoints } | null>(null);
  const [failedStudentId, setFailedStudentId] = useState<number | null>(null);
  /** 递增触发重拉。用计数器而不是把请求函数塞进依赖，重试不用再造一个 effect。 */
  const [overviewReload, setOverviewReload] = useState(0);

  /**
   * 概览数据**按 studentId 现算**，而不是在 effect 里 `setPoints(null)` 清：
   * effect 在 commit 之后才跑，清空会慢一帧——那一帧页面上是**上一个孩子的分数**
   * （切换孩子时最不能出现的东西，比「0 分」更糟）。这里做的是同一次 render 内的
   * 一致性判断：数据不归当前孩子，就等同于没有数据。
   */
  const points = overview && overview.studentId === studentId ? overview.points : null;
  const overviewFailed = studentId !== null && failedStudentId === studentId;

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentPoints(studentId)
      .then((res) => {
        if (cancelled) return;
        setOverview({ studentId, points: res });
        setFailedStudentId(null);
      })
      .catch(() => {
        if (cancelled) return;
        setOverview(null);
        setFailedStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, overviewReload]);

  /**
   * 面板注册 / 注销离场守卫。**必须 `useCallback` 固定身份**：面板的注册 effect 依赖
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
    const guard = leaveGuardRef.current;
    // 脏弹窗由面板自己渲染（它才知道要提示什么），页面只负责「先问再切」
    if (guard?.dirty) {
      guard.confirmLeave(() => commitTab(key));
      return;
    }
    commitTab(key);
  };

  /**
   * store 换了孩子：先问守卫，脏就挂起（不换人，面板不被卸载）。
   *
   * 用 `useLayoutEffect` 而不是 `useEffect`：后者在**绘制之后**才跑，中间那一帧
   * 页面还按旧 id 渲染（顶栏已是新孩子、分数还是旧的），正是「切换孩子时最不能
   * 出现的东西」。layout effect 在绘制前跑完，这一步对用户不可见。
   */
  useLayoutEffect(() => {
    if (pendingStudentId !== null) return;
    if (storeStudentId === studentId) return;
    // 没有孩子可看不是「跨学生提交」的危险场景，直接跟随（此时草稿只能丢）
    if (storeStudentId === null) {
      setActiveStudentId(null);
      return;
    }
    if (leaveGuardRef.current?.dirty) {
      setPendingStudentId(storeStudentId);
      return;
    }
    setActiveStudentId(storeStudentId);
  }, [storeStudentId, studentId, pendingStudentId]);

  /** 挂起中的切孩子：向守卫要一个答复（确认 → 换人；取消 → 把 store 回滚）。 */
  useLayoutEffect(() => {
    if (pendingStudentId === null) return;
    const nextId = pendingStudentId;
    const guard = leaveGuardRef.current;
    if (!guard?.dirty) {
      setActiveStudentId(nextId);
      setPendingStudentId(null);
      return;
    }
    guard.confirmLeave(
      () => {
        setActiveStudentId(nextId);
        setPendingStudentId(null);
      },
      () => {
        setPendingStudentId(null);
        // 页面没真的换人，store 里不能留着新孩子（否则顶栏与页面从此不一致）
        setStoreStudentId(studentId);
      },
    );
  }, [pendingStudentId, studentId, setStoreStudentId]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-black tracking-tight text-[var(--text-primary)]">
          积分与奖励
        </h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          查看孩子的积分概览，配置获得分值的规则，管理奖励与兑换。
        </p>
      </header>

      {studentId === null ? (
        <Card data-testid="points-empty" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">还没有选择孩子账号</p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            请先为孩子开通学生账号，再回来配置积分与奖励。
          </p>
          <Link
            to="/parent/students"
            className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
          >
            去创建学生账号
          </Link>
        </Card>
      ) : (
        <>
          {overviewFailed ? (
            <Card
              data-testid="points-overview-error"
              className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
            >
              <span className="text-sm text-[var(--text-secondary)]">积分信息暂时加载失败</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOverviewReload((n) => n + 1)}
              >
                重试
              </Button>
            </Card>
          ) : points === null ? (
            <div data-testid="points-overview-skeleton" className="space-y-4">
              <Skeleton width="100%" height={148} rounded />
            </div>
          ) : (
            <OverviewCard points={points} />
          )}

          <div
            role="tablist"
            aria-label="积分与奖励"
            className="flex gap-1 border-b border-[var(--bg-subtle)]"
          >
            {TABS.map((tab) => {
              const selected = tab.key === activeTab;
              return (
                <button
                  key={tab.key}
                  id={`points-tab-${tab.key}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="points-tabpanel"
                  onClick={() => selectTab(tab.key)}
                  className={clsx(
                    '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                    selected
                      ? 'border-[var(--brand-500)] text-[var(--brand-600)]'
                      : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                  )}
                >
                  {tab.label}
                  {/*
                    「未保存」小圆点。`aria-hidden` 是**有意**的：它若进了可访问名，
                    Tab 的名字会从「奖励清单」变成「奖励清单 有未保存的修改」，
                    读屏用户与按名字定位 Tab 的人都得跟着改。提示同一件事的自然后果
                    是「点它会弹确认」，由 title 给鼠标用户兜底。
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
          </div>

          <div
            id="points-tabpanel"
            role="tabpanel"
            aria-labelledby={`points-tab-${activeTab}`}
            // key 里的 studentId 是「切孩子丢弃草稿」的机制本体（见文件头注释）
            key={`${studentId}-${activeTab}`}
            data-testid={`points-panel-${activeTab}`}
            data-student-id={studentId}
          >
            {activeTab === 'rules' && <PointRulesPanel studentId={studentId} />}
            {activeTab === 'catalog' && (
              <RewardCatalogPanel
                studentId={studentId}
                onRegisterLeaveGuard={registerLeaveGuard}
              />
            )}
            {activeTab === 'redeem' && (
              <div className="space-y-6">
                <PointsSettingsPanel studentId={studentId} />
                <RedeemPanel
                  studentId={studentId}
                  onPointsChanged={() => setOverviewReload((n) => n + 1)}
                />
              </div>
            )}
            {activeTab === 'history' && <RedemptionHistoryPanel studentId={studentId} />}
          </div>
        </>
      )}
    </div>
  );
}
