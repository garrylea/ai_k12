import { useEffect, useState } from 'react';
import {
  getParentGoalAttainment, putParentGoalTarget,
  type ParentGoalAttainmentItem,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * /m/parent/goals 移动端学习目标页（Task 5）。
 *
 * - 达成度列表：`rate > 100` 不截断（超额），`rate === null` 显示「暂无数据」。
 * - 渲染 key 一律 `${subjectId}:${metric}`（api.ts 硬注释：同一 metric 会在多个学科各有一行）。
 * - 编辑走 `putParentGoalTarget`，用返回行**就地替换**（不重发 GET）。
 *
 * `data-testid="mobile-page-goals"` 挂在**所有状态共用的外层容器**上（Task 2 路由测试消费，
 * MobileAlertsPage/MobileControlsPage 先例），包括「未选择孩子」分支。
 *
 * 加载带 cancelled 守卫（MobileControlsPage 同款）：快速切孩子时旧孩子的响应晚 resolve/reject
 * 都不许写回 —— 否则旧数据 + ownerId 归属掩码会让页面永久停在骨架屏（无在途请求、无出口），
 * 晚 reject 还会把新孩子打成 error。派生状态同时带 `ownerId` 归属（CLAUDE.md 硬规则）：
 * 切孩子首帧（effect 清空之前）旧数据必须立即不可见。
 */
type LoadStatus = 'loading' | 'ready' | 'error';

export default function MobileGoalsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [items, setItems] = useState<ParentGoalAttainmentItem[] | null>(null);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  /** 重试不需要别的钩子，一个自增计数器驱动 effect 重跑（MobileControlsPage 同款）。 */
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (studentId === null) return;
    // 编辑态是「针对当前这个孩子」的本地状态，换孩子必须清空 —— 否则新孩子若有
    // 同 `${subjectId}:${metric}` 的行，会带着上个孩子的草稿进编辑态，保存即写错目标。
    setEditing(null);
    setEditError(null);
    setDraft('');
    let cancelled = false;
    setStatus('loading');
    getParentGoalAttainment(studentId)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setOwnerId(studentId);
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, reload]);

  if (studentId === null) {
    return (
      <div data-testid="mobile-page-goals">
        <p className="rounded-2xl bg-white p-8 text-center text-[var(--text-secondary)]">先在上方选择孩子</p>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div data-testid="mobile-page-goals">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="goals-retry" onClick={() => setReload((n) => n + 1)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      </div>
    );
  }
  if (status === 'loading' || ownerId !== studentId || items === null) {
    return <div data-testid="mobile-page-goals"><div className="h-24 animate-pulse rounded-2xl bg-white" /></div>;
  }

  const startEdit = (item: ParentGoalAttainmentItem) => {
    setEditing(`${item.subjectId}:${item.metric}`);
    // 草稿空起步（placeholder 显示当前值）：预填会把「输入 0」变成「300」这种合法值，
    // 无法表达「清空重填」意图；与测试用例「预填态输入 0 必须被拒」一致。
    setDraft('');
    setEditError(null);
  };

  const save = (item: ParentGoalAttainmentItem) => {
    const target = Number(draft);
    if (!Number.isInteger(target) || target <= 0) {
      setEditError('目标须为正整数');
      return;
    }
    setEditError(null);
    // 记下发起时的孩子；响应晚于切孩到达时（旧孩子的保存结果）必须整个丢弃，
    // 否则会把旧孩子的 updated 行替换进新孩子同 key 的行里。
    const initiatorId = studentId;
    putParentGoalTarget(initiatorId, item.metric, target, item.subjectId)
      .then((updated) => {
        if (useParentStudentStore.getState().studentId !== initiatorId) return;
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
                    placeholder={`当前 ${i.target}`}
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
