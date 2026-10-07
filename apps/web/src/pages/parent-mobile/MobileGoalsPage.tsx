import { useCallback, useEffect, useState } from 'react';
import {
  getParentGoalAttainment, putParentGoalTarget,
  type ParentGoalAttainmentItem,
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
