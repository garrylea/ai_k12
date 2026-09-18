/**
 * 乙类会话页（数学专项 / 背单词）的「完成发分」流程。
 *
 * 为什么抽出来：这两页的发分路径**完全同构**——拿配置页交接来的 `sessionId` 调
 * `completeTrainingSession`，再把结果交给 `usePointsFeedback` 决策；而失败/降级的分支
 * 抄错一条就会真坏：
 * - `sessionId === null`（计划一 Task 12 的会话 INSERT 降级）→ **连请求都不能发**；
 * - `balance === null`（`award_failed`，奖励未入账）→ 不能污染本地积分快照，要给
 *   「积分稍后到账」+ 重试，服务端会话留在 `in_progress`，重试会补发且只补一次；
 * - `reason === 'already_completed'`（幂等命中）→ 必须归一化成「无 reason」静默，
 *   否则 `PointsToast` 会对 0 分渲染「今日该任务积分已达上限」的假文案（计划 §1.1#4）；
 * - `award_failed` **不在** `usePointsFeedback` 的入参类型里，所以由本模块自己拦；
 * - 抛错（网络/5xx）→ 「稍后到账 + 重试」；抛错但是**客户端 4xx**（401 token 失效 /
 *   404 会话被删 / 400 参数错）→ 重试永远不会成功，改为「未到账、看明细」的诚实提示、
 *   **不给重试按钮**（否则就是在骗学生点一个必然失败的东西）。
 *
 * 调用方的完整时机不同（数学专项在末题收尾、背单词在 `finished` 变 true），但都只需
 * 调一次 `complete()`：内部用 ref 防重入，重试只能走 `retry()`。
 *
 * 提示条组件在同层 `SessionPointsRetryNotice.tsx`（本文件只导出 hook，保持 `.ts`，
 * 避免 react-refresh/only-export-components 警告）。
 */
import { useCallback, useRef, useState } from 'react';
import {
  ApiError,
  completeTrainingSession,
  type CompleteTrainingSessionResult,
} from '@/services/api';
import { usePointsFeedback, type PointsCelebrationProps } from './points-feedback';

export interface SessionPointsCompletion {
  /** 本次学习收尾时调一次。幂等：重复触发不会发出第二次请求。 */
  complete: () => void;
  /** 发分失败后的重试（服务端会补发）。重试中 `retrying === true`。 */
  retry: () => void;
  /** true = 显示「积分稍后到账 + 重试」。 */
  needsRetry: boolean;
  /** true = 显示「本次积分未能到账、不必重试」的诚实提示（客户端 4xx）。与 `needsRetry` 互斥。 */
  unrecoverable: boolean;
  /** true = 重试请求在途（按钮应 loading、不可重复点）。 */
  retrying: boolean;
  /** 直接摊到本页的 `<CelebrationOverlay>` 上。 */
  celebrationProps: PointsCelebrationProps;
}

/**
 * 客户端 4xx（token 失效 401 / 会话不存在 404 / 参数错 400）重试也不会变好——
 * 必须与「网络抖动 / 5xx」区分，否则提示条永远在撒谎，学生点重试永远失败。
 * 429（限流）会自愈，归可重试。
 */
function isClientError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 429
  );
}

export function useSessionPointsCompletion(
  sessionId: number | null,
  title: string,
): SessionPointsCompletion {
  const { award, celebrationProps } = usePointsFeedback();
  const [needsRetry, setNeedsRetry] = useState(false);
  const [unrecoverable, setUnrecoverable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // 标题随题数在挂载后才确定，用 ref 取调用那一刻的最新值，避免 `complete` 闭包过期
  const titleRef = useRef(title);
  titleRef.current = title;

  // 首调只许发一次：用户重复触发（双击 / 结果页重渲染）不得打第二个请求
  const startedRef = useRef(false);
  // 重试期间同样防重入
  const inFlightRef = useRef(false);

  const run = useCallback(
    async (isRetry: boolean) => {
      if (sessionId == null) return; // 降级：不发分、不反馈、不报错
      if (isRetry) setRetrying(true);
      try {
        const res = await completeTrainingSession(sessionId);
        if (res.balance === null) {
          // award_failed：奖励未入账。不回写本地积分，给用户一个可再点的出口
          setUnrecoverable(false);
          setNeedsRetry(true);
          return;
        }
        setNeedsRetry(false);
        setUnrecoverable(false);
        award({
          pointsAwarded: res.pointsAwarded,
          awardReason: normalizeAwardReason(res.reason),
          levelUp: res.levelUp,
          title: titleRef.current,
        });
      } catch (err) {
        if (isClientError(err)) {
          // 401/404/400：重试没有意义，给诚实说明而不是永远失败的重试按钮
          setNeedsRetry(false);
          setUnrecoverable(true);
          return;
        }
        // 网络/服务异常按「稍后到账」处理：不弹负反馈，允许重试
        setUnrecoverable(false);
        setNeedsRetry(true);
      } finally {
        if (isRetry) setRetrying(false);
      }
    },
    [sessionId, award],
  );

  const complete = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run(false);
  }, [run]);

  const retry = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    void run(true).finally(() => {
      inFlightRef.current = false;
    });
  }, [run]);

  return { complete, retry, needsRetry, unrecoverable, retrying, celebrationProps };
}

/**
 * `complete` 的 reason → `usePointsFeedback` 的 `awardReason`。
 * `already_completed`（幂等命中）与 `award_failed` 都归一化成 undefined：
 * 前者要静默，后者归重试路径处理（正常不会走到这里）。
 * 返回类型只列 complete 端点真正会产出的三个原因（`genre_unset` 是语文端点特有的，已收窄掉）。
 */
function normalizeAwardReason(
  reason: CompleteTrainingSessionResult['reason'],
): 'daily_limit' | 'no_rule' | 'tier_inactive' | undefined {
  if (reason == null || reason === 'already_completed' || reason === 'award_failed') return undefined;
  return reason;
}
