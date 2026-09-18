import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { listMyStudents, type MyStudentItem } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * 家长端顶栏的「当前查看的孩子」下拉（计划三 §2.2）。
 *
 * 它是 `parentStudentStore` 里那个 `studentId` 锚点的**唯一数据源与校验点**：
 * 自己拉 `GET /parent/students`，并在这里一次性处理「列表为空 / 持久化 id 失效 /
 * 首次进入」三种回落。`ParentLayout` **不再**拉第二次——两处各拉一次就会有两份
 * 可能互相打架的列表，回落逻辑也会分裂。
 *
 * 三条有意为之的口径：
 * 1. **只有 1 个孩子也照常渲染下拉**（菜单里就一项）。少渲染一个按钮省不了事，
 *    反而会让「多孩切换」（UX P6.8）上线时布局跳一下。
 * 2. **本期不显示段位图标。** 段位得按孩子各拉一次 `points` 概览——N 个孩子就是
 *    N 次请求，为顶栏一个小图标不值。别当成漏了，这是 §2.2 明确的取舍；
 *    要加的话先想办法一次批量拿全（后端没有这种端点）。
 * 3. 拉取失败**只降级这一小块**：给一句说明 + 「重试」，不弹 toast、不把顶栏搞崩。
 *    孩子列表拉不到不该阻断家长用其它页面。
 */

interface StudentSwitcherProps {
  className?: string;
}

type LoadStatus = 'loading' | 'ready' | 'error';

function displayName(student: MyStudentItem): string {
  // 年级是可空的展示字段，有才拼上，不编「（null）」
  return `${student.name}${student.grade ? `（${student.grade}）` : ''}`;
}

function initialOf(name: string): string {
  return name.trim().charAt(0) || '学';
}

export function StudentSwitcher({ className }: StudentSwitcherProps) {
  const studentId = useParentStudentStore((s) => s.studentId);
  const setStudentId = useParentStudentStore((s) => s.setStudentId);

  const [students, setStudents] = useState<MyStudentItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /**
   * 最近一次请求的取消函数。放在 ref 里而不是只靠 effect 闭包，是为了让**重试
   * 按钮**也能走同一套取消守卫：按钮回调拿到的是 `load`，而真正需要被取消的是
   * 「当前在飞的那一次」，只有 ref 知道它是谁。卸载时 effect 清理取消它即可。
   */
  const cancelLoadRef = useRef<(() => void) | null>(null);

  const load = useCallback(() => {
    cancelLoadRef.current?.(); // 旧请求作废，避免慢响应盖掉新响应
    let cancelled = false;
    cancelLoadRef.current = () => {
      cancelled = true;
    };
    setStatus('loading');
    listMyStudents()
      .then((list) => {
        if (cancelled) return;
        setStudents(list);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
  }, []);

  /**
   * 本组件挂在 `ParentLayout` 的顶栏上，**不随子路由重挂载**——只依赖 `load`
   * 的话整个家长会话就只拉一次。具体坏流程：还没有孩子 → 去 `/parent/students`
   * 新建 → 跳到 `/parent/students/:id/config`，顶栏仍停在「还没有孩子账号」，
   * 直到整页刷新。把 `pathname` 纳入依赖，每次导航重拉；并发由上面的取消守卫兜住。
   */
  const { pathname } = useLocation();
  useEffect(() => {
    load();
    return () => cancelLoadRef.current?.();
  }, [load, pathname]);

  /**
   * 「校验 + 回落」全在此一处。等列表到位后再判断，所以三种情况都走同一段：
   * - 列表为空 → 清掉锚点（`studentId` 留着一个已不存在的 id 是最坏的状态）；
   * - 当前 id 不在列表里（换账号 / 孩子被删 / 上个家长残留）→ 回落第一个；
   * - `studentId === null`（首次进家长端）→ 默认选第一个。
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

  // 点外部 / Esc 关闭。rootRef 同时罩住触发按钮和菜单，所以点按钮不会被
  // 「点外部关闭」抢先关掉再被 onClick 打开（那样会永远关不上）。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  /**
   * `role="menu"` 的键盘语义：打开时焦点进入菜单（优先落在当前选中的孩子），
   * 上下键在项间循环移动。只靠 Tab 也能走通（每一项本身就是 `<button>`），
   * 但菜单模式的可预期操作是方向键——两边都成立。
   */
  const getMenuItemNodes = useCallback(
    () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
      ),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const nodes = getMenuItemNodes();
    const currentId = useParentStudentStore.getState().studentId;
    const index = nodes.findIndex((n) => n.dataset.studentId === String(currentId));
    (nodes[index >= 0 ? index : 0] ?? nodes[0])?.focus();
  }, [open, getMenuItemNodes]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const nodes = getMenuItemNodes();
    if (nodes.length === 0) return;
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const activeIndex = nodes.findIndex((n) => n === document.activeElement);
    // 还没聚焦到任何一项时：向下从第一项开始，向上从最后一项开始
    const base = activeIndex >= 0 ? activeIndex : delta === 1 ? -1 : 0;
    nodes[(base + delta + nodes.length) % nodes.length].focus();
  };

  let body: ReactNode;

  if (status === 'loading') {
    body = (
      <div
        data-testid="student-switcher-loading"
        className="flex items-center gap-2 rounded-lg bg-[var(--brand-100)] px-3 py-1.5"
      >
        <span className="h-7 w-7 rounded-full bg-[var(--bg-subtle)]" />
        <span className="text-sm text-[var(--text-tertiary)]">加载中…</span>
      </div>
    );
  } else if (status === 'error') {
    body = (
      <div className="flex items-center gap-3">
        <span className="text-sm text-[var(--text-secondary)]">孩子信息加载失败</span>
        <button
          type="button"
          onClick={() => load()}
          className="rounded-md border border-[var(--bg-subtle)] px-2.5 py-1 text-sm font-medium text-[var(--brand-600)] transition-colors hover:bg-[var(--bg-subtle)]"
        >
          重试
        </button>
      </div>
    );
  } else if (students.length === 0) {
    body = (
      <div className="flex items-center gap-3">
        <span className="text-sm text-[var(--text-secondary)]">还没有孩子账号</span>
        <Link
          to="/parent/students"
          className="text-sm font-medium text-[var(--brand-600)] hover:underline"
        >
          去创建学生账号
        </Link>
      </div>
    );
  } else {
    const selected = students.find((s) => s.id === studentId) ?? students[0];
    body = (
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          data-testid="student-switcher-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`当前查看的孩子：${displayName(selected)}，点击切换`}
          onClick={() => setOpen((prev) => !prev)}
          className="flex items-center gap-2 rounded-lg bg-[var(--brand-100)] px-3 py-1.5 text-left transition-colors hover:bg-[var(--bg-subtle)]"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--brand-500)] text-xs font-bold text-[var(--text-on-brand)]">
            {initialOf(selected.name)}
          </span>
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {displayName(selected)}
          </span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {open && (
          <div
            ref={menuRef}
            role="menu"
            aria-label="切换孩子"
            onKeyDown={onMenuKeyDown}
            className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-[var(--bg-subtle)] bg-[var(--bg-card)] py-1 shadow-[var(--shadow-elevated)]"
          >
            {students.map((s) => {
              const isSelected = s.id === selected.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  data-testid={`student-option-${s.id}`}
                  data-student-id={s.id}
                  onClick={() => {
                    setStudentId(s.id);
                    setOpen(false);
                  }}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-base)]',
                    isSelected && 'bg-[var(--brand-100)]',
                  )}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--brand-500)] text-xs font-bold text-[var(--text-on-brand)]">
                    {initialOf(s.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                    {displayName(s)}
                  </span>
                  {isSelected && (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-[var(--brand-600)]"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={clsx('flex items-center gap-4', className)}>
      {/* 「当前查看：」只配下拉：空态/错误态没有「当前」可言，别读出
          「当前查看：还没有孩子账号」这种句子。 */}
      {status === 'ready' && students.length > 0 && (
        <span className="text-sm text-[var(--text-secondary)]">当前查看：</span>
      )}
      {body}
    </div>
  );
}
