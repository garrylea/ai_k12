import { useCallback, useEffect, useState } from 'react';
import {
  getParentControls,
  getParentLearningSessions,
  issueParentDeviceCommand,
  putParentControls,
  type ParentControls,
  type ParentSessionItem,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * /m/parent/controls 移动端管控页（Task 8）。
 *
 * 三块：单次学习锁定（设置/显式解除）/ 远程解除 / 进出时间（按次列表）。
 *
 * 数据源口径（与桌面对齐）：
 * - 锁定设置走 `getParentControls` / `putParentControls`（部分 patch，只发改动字段；
 *   空串 = 显式解除，发 `sessionLockMinutes: null`）。
 * - 远程解除走 `issueParentDeviceCommand(studentId, 'unlock')`；没有进行中会话时
 *   服务端返回 409/1001，`ApiError.message` 是后端人类可读文案，**原样展示**，不静默。
 * - 进出时间是**列表、不是聚合**：`getParentLearningSessions(studentId, 7, 10)`
 *   （桌面 ParentDashboardPage `LearningTimelineCard` 同款 API 与参数），行字段
 *   `startedAt` / `endedAt`（`null` = 进行中）。`getParentStudyTime` 是按天聚合，不是这个。
 *
 * `data-testid="mobile-page-controls"` 被 Task 2 路由测试消费，参考 MobileAlertsPage
 * 先例：testid 挂在**所有状态共用的外层容器**上，不只在数据就绪分支。
 *
 * 派生状态带 `studentId` 归属（CLAUDE.md 硬规则）：切孩子不重挂载本页，读取时用
 * `state.studentId === studentId` 现算归属，避免 effect 清空慢一帧画出上个孩子的数据。
 */

/** 时刻格式化：与桌面 LearningTimelineCard 同口径，只给「几月几日 几点几分」。 */
function formatClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MobileControlsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [state, setState] = useState<{
    studentId: number;
    controls: ParentControls;
    sessions: ParentSessionItem[];
  } | null>(null);
  const [failedStudentId, setFailedStudentId] = useState<number | null>(null);
  const [lockInput, setLockInput] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [cmdOk, setCmdOk] = useState(false);

  const load = useCallback((id: number) => {
    setState(null);
    setFailedStudentId(null);
    Promise.all([getParentControls(id), getParentLearningSessions(id, 7, 10)])
      .then(([c, s]) => {
        setState({ studentId: id, controls: c, sessions: s.items });
        setLockInput(c.sessionLockMinutes === null ? '' : String(c.sessionLockMinutes));
      })
      .catch(() => setFailedStudentId(id));
  }, []);

  useEffect(() => {
    if (studentId !== null) load(studentId);
  }, [studentId, load]);

  // 读取时现算归属：studentId 已切走时旧数据立即不可见（不等 effect 清空）
  const view = state && state.studentId === studentId ? state : null;
  const failed = failedStudentId === studentId;

  if (studentId === null) {
    return (
      <div data-testid="mobile-page-controls">
        <p className="rounded-2xl bg-white p-8 text-center text-black/60">先在上方选择孩子</p>
      </div>
    );
  }
  if (failed) {
    return (
      <div data-testid="mobile-page-controls">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-black/60">加载失败</p>
          <button data-testid="controls-retry" onClick={() => load(studentId)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      </div>
    );
  }
  if (view === null) {
    return (
      <div data-testid="mobile-page-controls">
        <div className="h-40 animate-pulse rounded-2xl bg-white" />
      </div>
    );
  }

  const saveLock = () => {
    const raw = lockInput.trim();
    // '' = 显式解除（NULL 语义，必须显式发出；漏发等于「不动」）；数字限 1..480 整数
    const patch: Partial<ParentControls> =
      raw === '' ? { sessionLockMinutes: null } : { sessionLockMinutes: Number(raw) };
    if (raw !== '' && (!Number.isInteger(patch.sessionLockMinutes) || (patch.sessionLockMinutes as number) < 1 || (patch.sessionLockMinutes as number) > 480)) {
      setSaveMsg('锁定时长需为 1–480 的整数，清空表示解除');
      return;
    }
    setSaveMsg(null);
    putParentControls(studentId, patch)
      .then((c) => {
        setState({ studentId, controls: c, sessions: view.sessions });
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
        <p className="mt-1 text-xs text-black/40">孩子每次进入和退出学习端的时刻（近 7 天）。只记 PC App 上的学习。</p>
        {view.sessions.length === 0 ? (
          <p className="mt-2 text-sm text-black/60">暂无学习会话记录</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {view.sessions.map((s) => (
              <li key={s.id} data-testid={`session-${s.id}`} className="flex items-center justify-between gap-2">
                <span>{formatClock(s.startedAt)}</span>
                <span className="text-black/60">{s.endedAt === null ? '进行中' : `→ ${formatClock(s.endedAt)}`}</span>
                <span className={s.endedAt === null ? 'text-[var(--brand-600)]' : 'text-black/40'}>
                  {s.endedAt === null ? (s.online ? '在线' : '已断开') : '已退出'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
