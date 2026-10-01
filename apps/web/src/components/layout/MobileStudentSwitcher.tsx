import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
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
  /**
   * 最近一次请求的取消函数（镜像桌面 cancelLoadRef）。放在 ref 里而不是只靠
   * effect 闭包，是为了让**重试按钮**也能走同一套取消守卫：按钮回调拿到的是
   * `load`，而真正需要被取消的是「当前在飞的那一次」，只有 ref 知道它是谁。
   */
  const cancelLoadRef = useRef<(() => void) | null>(null);

  /**
   * 拉列表。「首次」与「静默」不分成两份逻辑，靠**当前状态**区分（镜像桌面 load）：
   *
   * - 只有还没拿到过列表（首次进入的 `loading`、或上次拉失败的 `error`）才置回
   *   `loading`，此时才出「加载中…」；
   * - 已经是 `ready`（手上有列表）→ `setStatus` 收到同一个值会 bail out，
   *   **不闪加载态**，页面继续显示当前列表，拿到新结果后再整体替换。
   *
   * 失败时同理：`ready` 已经表示「有可用列表」，静默刷新失败不能把它打成错误态、
   * 更不清空列表；保持旧列表，下一次导航（pathname 变化）会自然再试一次。
   *
   * 用函数式 `setStatus` 而不是读闭包里的 `status`，免去把 `status` 塞进 `load`
   * 依赖（塞了会让 `load` 每次状态变化都换引用，进而反复触发拉取 effect）。
   */
  const load = useCallback(() => {
    cancelLoadRef.current?.(); // 旧请求作废，避免慢响应盖掉新响应（重试双击并发同此）
    let cancelled = false;
    cancelLoadRef.current = () => {
      cancelled = true;
    };
    setStatus((prev) => (prev === 'ready' ? prev : 'loading'));
    listMyStudents()
      .then((list) => {
        if (cancelled) return;
        setStudents(list);
        setStatus('ready');
      })
      .catch(() => {
        // 手上有旧列表就保留（status 维持 ready），只有「首次/重试」失败才进错误态。
        if (!cancelled) setStatus((prev) => (prev === 'ready' ? prev : 'error'));
      });
  }, []);

  /**
   * `pathname` 变化触发重拉（镜像桌面）：没有孩子 → 去「更多」里新建 → 返回时
   * 顶栏仍要能显示新孩子，只靠 mount 拉一次做不到。并发由上面的取消守卫兜住。
   */
  const { pathname } = useLocation();
  useEffect(() => {
    load();
    return () => cancelLoadRef.current?.();
  }, [load, pathname]);

  /**
   * 「校验 + 回落」全在此一处（镜像桌面）：等列表到位后再判断，三种情况走同一段：
   * - 列表为空 → 清掉锚点；`studentId !== null` 守卫避免无意义的 persist 写盘；
   * - 当前 id 不在列表里（换账号 / 孩子被删 / 上个家长残留）→ 回落第一个；
   * - `studentId === null`（首次进入）→ 默认选第一个。
   */
  useEffect(() => {
    if (status !== 'ready') return;
    if (students.length === 0) {
      if (studentId !== null) setStudentId(null);
      return;
    }
    if (studentId === null || !students.some((s) => s.id === studentId)) {
      setStudentId(students[0].id);
    }
  }, [status, students, studentId, setStudentId]);

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
