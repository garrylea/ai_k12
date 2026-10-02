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

/** `accuracy.rate` 已是 0–100 百分比；null = 本期没有可判对错的作答，显示「暂无数据」而非 0%（与桌面端 ParentDashboardPage 同口径）。 */
function formatRate(rate: number | null): string {
  return rate === null ? '暂无数据' : `${rate}%`;
}

/**
 * /m/parent 学情仪表盘（三卡：进度 / 时长 / 薄弱点）。
 *
 * `data-testid="mobile-page-dashboard"` 被 Task 2 路由测试消费，且路由测试渲染时
 * store 的 `studentId` 可能为 null —— 所以 testid 挂在**所有状态共用的外层容器**上，
 * 不是只在 ready 分支。
 */
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
        // 竞态守卫（与 MobileErrorsPage seqRef / MobileControlsPage cancelled 同类）：
        // 快速切孩子时旧孩子的响应可能晚到，若写回会令 ownerId 归属守卫判永久不等、
        // 页面卡骨架且无自救。发起时的 id 与 store 当前 studentId 不一致就整包丢弃。
        if (useParentStudentStore.getState().studentId !== id) return;
        setDash(d); setStudy(s); setUsage(u); setMastery(m);
        setOwnerId(id);
        setStatus('ready');
      })
      .catch(() => {
        // 失败同样受守卫：旧请求晚到的 reject 不许盖掉新孩子的加载中/已就绪态。
        if (useParentStudentStore.getState().studentId !== id) return;
        setStatus('error');
      });
  }, []);

  useEffect(() => {
    if (studentId !== null) load(studentId);
  }, [studentId, load]);

  if (studentId === null) {
    return (
      <div data-testid="mobile-page-dashboard">
        <p className="text-[var(--text-secondary)]">先在上方选择孩子</p>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div data-testid="mobile-page-dashboard">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="dashboard-retry" onClick={() => load(studentId)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      </div>
    );
  }
  if (status === 'loading' || ownerId !== studentId || !dash || !study || !usage || !mastery) {
    return (
      <div data-testid="mobile-page-dashboard">
        <div data-testid="dashboard-skeleton" className="animate-pulse space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-28 rounded-2xl bg-white" />)}
        </div>
      </div>
    );
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
                <span>{sub.subjectName}</span>
                <span>进度 {sub.progress.percent}% · 正确率 {formatRate(sub.accuracy.rate)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-[var(--text-secondary)]">暂无该孩子的学情数据</p>}
      </section>
      <section className="rounded-2xl bg-white p-4">
        <h2 className="text-sm font-bold">学习时长</h2>
        <ul className="mt-2 space-y-2 text-sm">
          <li className="flex justify-between"><span>近 7 天累计（会话口径）</span><span data-testid="study-time-sessions">{fmtDuration(study.totalSeconds)}</span></li>
          <li className="flex justify-between"><span>今日已学</span><span>{fmtDuration(usage.activeSeconds)}</span></li>
        </ul>
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">口径说明：时长按学习会话统计；活跃天数按有记录的天数统计，两者独立计算。</p>
      </section>
      <section className="rounded-2xl bg-white p-4">
        <h2 className="text-sm font-bold">薄弱知识点</h2>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">知识点覆盖率 {mastery.coveredQuestions}/{mastery.totalQuestions}，未覆盖 {mastery.uncovered} 题——未覆盖的题不在下列统计内。</p>
        <ul className="mt-2 space-y-2 text-sm">
          {mastery.items.length === 0 && <li className="text-[var(--text-secondary)]">暂无足够判题数据</li>}
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
