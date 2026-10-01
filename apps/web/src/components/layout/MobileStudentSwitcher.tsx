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
