import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import {
  openStudentLearningSession,
  pollStudentDeviceCommands,
  type StudentLearningSession,
} from '@/services/api';
import {
  LEARNING_SESSION_POLL_MS,
  isLocked as computeLocked,
  readPersistedSession,
  remainingMs,
  writePersistedSession,
} from './learningLock';
import { isDesktopShell, setDesktopStudentMode } from './desktopBridge';
import { LockedPill } from './LockedPill';

interface LockState {
  id: number;
  lockExpiresAt: string | null;
  unlockedAt: string | null;
}

/** 从本地快照取初值：**重启后第一帧就应该是锁着的**，不能等接口回来才锁。 */
function initialLockState(): LockState | null {
  const rawUserId = typeof localStorage === 'undefined' ? null : localStorage.getItem('userId');
  const studentId = rawUserId === null ? null : Number(rawUserId);
  const persisted = readPersistedSession(studentId);
  return persisted
    ? { id: persisted.id, lockExpiresAt: persisted.lockExpiresAt, unlockedAt: persisted.unlockedAt }
    : null;
}

/**
 * PC App 学习锁定的全局壳（spec §6.2）。
 *
 * **挂载点是 pathless wrapper**（见 `routes/index.tsx`），与 `AnalyticsShell` 同法：
 * 学习页是 full-screen、不在任何 Layout 下，只有路由根层能覆盖全部路由。
 *
 * **角色闸门放在路由 effect 里、而不是挂载 effect 里**——与 `AnalyticsShell` 同一个理由，
 * 别改回去：登录/登出都是**客户端导航**（写 localStorage 后直接 `navigate`，页面不刷新），
 * 只在挂载时读一次 `userRole`，「从登录页进来」的学生在本会话里永远拿不到锁定态。
 *
 * 职责四件事：① 学生 + 壳 → 取或建会话；② 把锁定态推给主进程；
 * ③ 每 10 秒轮询（兼心跳）并处理 `unlock`；④ 到点自动解除。
 * 剩余时间 pill 的渲染也在这里——只有它有 `locked` 与倒计时。
 */
export default function LearningSessionShell() {
  const location = useLocation();
  const [lock, setLock] = useState<LockState | null>(initialLockState);
  /**
   * 「角色 + 会话是否已判定」。
   *
   * **为什么需要它**：把学生模式推给主进程只允许有**一个出口**（下面的 effect ②）。若在判定
   * 完成前就推当前值，挂载瞬间会对主进程发一次 `setStudentMode(false)`（那时还不知道角色），
   * 紧接着判定完又发 `setStudentMode(true)` —— 窗口会先退出 kiosk 再进回去，既是多余 IPC，
   * 也可能让 kiosk 闪一下普通窗口。判定完成前**不猜**，等有结论再推一次。
   */
  const [resolved, setResolved] = useState(false);
  /** 当前登录者是不是学生（判定完成后才为 true）。**kiosk 只由它决定**，与锁定窗口无关。 */
  const [isStudent, setIsStudent] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  /**
   * 把服务端返回的会话落进本地快照 —— **只在「当前登录者仍是同一个学生」时写**。
   *
   * ⚠️ 这个写盘**不能放在 `cancelled` 判断之后**（2026-09-24 修）：登录后会有一串客户端跳转，
   * 本 effect 依赖 `location.pathname` 会被反复重建并清理；若因 `cancelled` 丢掉写盘，
   * 本地就一直「没有会话」→ `LogoutButton` 的禁退判定读不到锁 → **锁着还能登出**
   * （用户实测报回，证据：Electron 的 localStorage 里从没出现过带锁会话的记录）。
   * 服务端返回的是**幂等真值**，重复写同一行无害。
   */
  const persistFor = (expectedStudentId: number, session: StudentLearningSession): void => {
    if (localStorage.getItem('userRole') !== 'student') return;
    if (Number(localStorage.getItem('userId')) !== expectedStudentId) return;
    writePersistedSession({
      studentId: expectedStudentId,
      id: session.id,
      lockExpiresAt: session.lockExpiresAt,
      unlockedAt: session.unlockedAt,
    });
  };

  // ① 角色闸门 + 建立会话。**只做判定，不直接推学生模式**（推的动作留给 effect ②）。
  useEffect(() => {
    if (!isDesktopShell()) return;
    if (localStorage.getItem('userRole') !== 'student') {
      // 家长/管理员登入（或学生已登出）：壳必须回到普通窗口，否则家长也用不了这台机器。
      setIsStudent(false);
      setResolved(true);
      return;
    }
    setIsStudent(true);
    const expectedStudentId = Number(localStorage.getItem('userId'));
    if (readPersistedSession(expectedStudentId) !== null) {
      setResolved(true); // 已有本地会话 → 交给轮询对账，不重复建
      return;
    }

    let cancelled = false;
    openStudentLearningSession()
      .then((session) => {
        persistFor(expectedStudentId, session); // 先落盘（不受 cancelled 影响）
        if (cancelled) return;
        setLock({
          id: session.id,
          lockExpiresAt: session.lockExpiresAt,
          unlockedAt: session.unlockedAt,
        });
        setResolved(true);
      })
      .catch(() => {
        // 建会话失败**不阻断学习**：退化为「未锁」，但**仍然是学生模式**（该全屏还是要全屏）。
        // 管控失效好过学生进不去 / 好过学生能随便切应用。
        if (!cancelled) setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const locked = lock !== null && computeLocked(lock, nowMs);

  /**
   * ② 学生模式 → Electron 主进程（**唯一出口**）。`resolved` 之前不推，避免先退出再进 kiosk。
   *
   * ⚠️ **推的是 `resolved && isStudent`，不是 `locked`**：kiosk 由**角色**决定（spec §3 裁决 2、
   * §6.2 的 `UNLOCKED` 也是 kiosk 全屏）；家长设的时长只影响「能不能登出」与 pill。
   * 两者合并过一次 → 家长没设时长时学生完全不被全屏、可随便切应用（2026-09-24 修）。
   */
  useEffect(() => {
    if (!isDesktopShell() || !resolved) return;
    setDesktopStudentMode(isStudent);
  }, [isStudent, resolved]);

  // ③ 轮询（兼心跳）。依赖**会话 id**（而非整个 lock）：换会话才换轮询，
  // 否则每次轮询 setLock 都会重建 interval。取出 `lockId` 是为了让依赖数组显式且无 warning。
  const lockId = lock?.id ?? null;
  useEffect(() => {
    if (!isDesktopShell() || lockId === null) return;
    const poll = () => {
      pollStudentDeviceCommands()
        .then((res) => {
          // 服务端是锁定态的**唯一真源**：家长在别处解除时，这里带回的 unlockedAt 非空。
          if (res.lock) {
            // **服务端也是「哪个会话在进行中」的唯一真源**：本地 id 与服务端不一致时**采纳服务端**，
            // 不能丢弃（2026-09-24 修）。丢弃过一次的后果：本地卡在旧 id 上，服务端那条带锁的
            // 会话永远追不上 → 锁形同不存在（用户实测：锁着还能登出）。
            const studentId = Number(localStorage.getItem('userId'));
            const next: LockState = {
              id: res.lock.sessionId,
              lockExpiresAt: res.lock.lockExpiresAt,
              unlockedAt: res.lock.unlockedAt,
            };
            if (Number.isFinite(studentId)) {
              writePersistedSession({ studentId, ...next });
            }
            setLock(next);
          }
        })
        .catch(() => {
          // 轮询失败**绝不清锁**：拔网线不解锁（spec §8 局限 3）。本地截止时间继续生效。
        });
    };
    poll();
    const timer = window.setInterval(poll, LEARNING_SESSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [lockId]);

  // ④ 锁定时每秒对表（驱动 pill 与到点解除）；不锁就不起定时器。
  useEffect(() => {
    if (!locked) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [locked]);

  return (
    <>
      {locked && lock?.lockExpiresAt && (
        <LockedPill remainingMs={remainingMs(lock.lockExpiresAt, nowMs)} />
      )}
      <Outlet />
    </>
  );
}
