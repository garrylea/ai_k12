/**
 * 训练页共享的积分反馈决策（与 Task 6 抽出的 `point-tiers.ts` 同层）。
 *
 * 为什么要抽：**四个甲类判题页**（错题重练 / 默写 / 解释 / 含义）、**两个会话页**
 * （数学专项 / 背单词）以及**交卷页**都要把「同一次发分结果」翻译成
 * 「弹轻反馈 / 弹全屏庆祝 / 什么都不做」。这段规则抄多遍必然走样，而抄错一条就会真坏：
 * `pointsAwarded === 0` **不等于**「已达上限」——`PointsToast` 对 `points <= 0` 一律渲染
 * 「今日该任务积分已达上限」，所以幂等命中（无 reason）必须在决策层拦掉，否则弹假文案
 * （计划 §1.1#4）。
 *
 * 交卷页是第 7 个调用方，也是唯一走 `celebrate` 入参的：大任务（交卷）按计划要全屏
 * `variant="task"` 庆祝，分数与积分同屏，而不是轻反馈（计划 §3 Task 7c）。
 *
 * 分工：
 * - `decidePointsFeedback` 纯函数，只做「入参 → 决策」，可直接单测；
 * - `usePointsFeedback` 负责副作用（push 轻反馈、拉段位名、持有庆祝层状态）。
 *
 * 发分失败（`award_failed`）**不是本模块的活**：那种情况要提示「积分稍后到账，可重试」
 * 并允许重试，属于调用方的流程控制，所以入参里不含这个 reason。
 */
import { useCallback, useState } from 'react';
import { getMyPoints, type PointsAwardReason } from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';

/** 一次发分结果里与反馈有关的字段（甲类判题 / 乙类 complete / 交卷 `points` 都能映射到它）。 */
export interface PointsFeedbackInput {
  pointsAwarded: number;
  /**
   * 未发分原因。**不含 `award_failed`**——发分失败要重试提示，由调用方处理。
   * 幂等命中（`duplicate`）也不要传：它本就不在枚举里，缺省即静默。
   */
  awardReason?: PointsAwardReason;
  /** 段位晋升（code 字符串）。**甲类判题响应没有这个字段**，传 undefined 即不触发全屏庆祝。 */
  levelUp?: { from: string; to: string } | null;
  /** 轻反馈标题，如「英语背单词 · 10 词」。 */
  title: string;
  /**
   * 大任务全屏庆祝（交卷页专用）。**只有 `pointsAwarded > 0` 才会生效**——没发分时传了也静默，
   * 不会凭空空弹庆祝层。`variant` 固定为 `task`（`levelup` 由晋升路径独占），所以入参不带它。
   */
  celebrate?: {
    /** 庆祝标题，如「本次测验完成！」 */
    title: string;
    subtitle?: string;
    /** 主按钮文案，缺省「继续」。 */
    primaryLabel?: string;
  };
}

/** 「什么该弹、什么该静默」的决策结果。 */
export type PointsFeedbackDecision =
  | { kind: 'silent' }
  | { kind: 'toast'; points: number }
  | { kind: 'levelup' }
  | { kind: 'task' };

/**
 * 入参 → 决策。**顺序与门槛都不能改**（计划 §3 Task 7a/7c 的判定表）：
 *
 * | 情况 | 行为 |
 * |---|---|
 * | 正分 + 晋升 | 全屏庆祝 `levelup`（**不**再 push 轻反馈，避免两处同时弹，§2.2） |
 * | 正分 + 传了 `celebrate`（交卷大任务） | 全屏庆祝 `task`（同样不 push 轻反馈） |
 * | 正分 | 轻反馈 `+N 分` |
 * | 0 分 + `daily_limit` | 轻反馈 0 分 → `PointsToast` 渲染「今日该任务积分已达上限」 |
 * | 其余（含无 reason 的幂等命中） | 静默 |
 *
 * 晋升优先于 `celebrate`：一次发分同时晋升又交卷时，晋升是更大的消息（计划 §2.2 只弹一个）。
 * `celebrate` 只在正分分支被读取，所以 0 分时它不会凭空拉起庆祝层。
 */
export function decidePointsFeedback(input: PointsFeedbackInput): PointsFeedbackDecision {
  const { pointsAwarded, awardReason, levelUp, celebrate } = input;

  if (pointsAwarded > 0) {
    if (levelUp) return { kind: 'levelup' };
    if (celebrate) return { kind: 'task' };
    return { kind: 'toast', points: pointsAwarded };
  }

  // 只有 daily_limit 这一个 0 分场景有中性文案可展示；其余 0 分一律静默。
  // 少了这个 reason 判断就会在幂等命中时弹「已达上限」的假文案。
  if (pointsAwarded === 0 && awardReason === 'daily_limit') {
    return { kind: 'toast', points: 0 };
  }

  return { kind: 'silent' };
}

/** 全屏庆祝的内部展示态。`name` 取不到段位名时是空串——`CelebrationOverlay` 只在非空时显示名字。 */
interface PointsCelebration {
  variant: 'levelup' | 'task';
  title: string;
  subtitle?: string;
  level?: { code: string; name: string };
  pointsAwarded: number;
  primaryLabel: string;
}

/**
 * 可直接摊到调用页自己的 `<CelebrationOverlay>` 上的 props。
 * 两种 variant 需要的东西都在这里：`levelup` 用 `level` 显示段位图标与名字，
 * `task` 用调用方给的 `title`/`subtitle` + `pointsAwarded` 显示分数与积分；
 * `onPrimary` 就是关闭庆祝层，页面无需自己接。
 */
export interface PointsCelebrationProps {
  open: boolean;
  variant: 'levelup' | 'task';
  title: string;
  subtitle?: string;
  level: { code: string; name: string } | undefined;
  pointsAwarded: number | undefined;
  primaryLabel: string;
  onPrimary: () => void;
}

export interface PointsFeedback {
  /** 拿到一次发分结果就调它；内部按决策表弹反馈或静默。 */
  award: (input: PointsFeedbackInput) => void;
  celebrationProps: PointsCelebrationProps;
  closeCelebration: () => void;
}

export function usePointsFeedback(): PointsFeedback {
  const push = usePointsStore((s) => s.push);
  const [celebration, setCelebration] = useState<PointsCelebration | null>(null);

  const closeCelebration = useCallback(() => setCelebration(null), []);

  const award = useCallback(
    (input: PointsFeedbackInput) => {
      const decision = decidePointsFeedback(input);

      if (decision.kind === 'toast') {
        push({ points: decision.points, title: input.title });
        return;
      }

      // 交卷大任务：全屏 task 庆祝，分数与积分同屏（计划 §3 Task 7c）
      if (decision.kind === 'task') {
        const celebrate = input.celebrate;
        if (!celebrate) return; // 防御：决策只在 celebrate 存在时才返回 task
        setCelebration({
          variant: 'task',
          title: celebrate.title,
          subtitle: celebrate.subtitle,
          pointsAwarded: input.pointsAwarded,
          primaryLabel: celebrate.primaryLabel ?? '继续',
        });
        return;
      }

      const levelUp = input.levelUp;
      if (decision.kind !== 'levelup' || !levelUp) return;

      const to = levelUp.to;
      // 段位名的唯一真源在后端（spec §3.1），前端不维护段位表：先出图标，名字晚一拍补上。
      setCelebration({
        variant: 'levelup',
        title: '晋升新段位！',
        level: { code: to, name: '' },
        pointsAwarded: input.pointsAwarded,
        primaryLabel: '继续',
      });
      getMyPoints()
        .then((me) => {
          setCelebration((current) =>
            // code 比对：旧请求迟到时不覆盖后一次庆祝（同 CourseDetailPage 的做法）
            current?.variant === 'levelup' && current.level?.code === to
              ? {
                  ...current,
                  title: `晋升 ${me.level.name}！`,
                  level: { code: to, name: me.level.name },
                }
              : current,
          );
        })
        .catch(() => {
          // 降级：不显示段位名，只显示大图标（标题保持「晋升新段位！」）
        });
    },
    [push],
  );

  return {
    award,
    celebrationProps: {
      open: celebration !== null,
      variant: celebration?.variant ?? 'levelup',
      title: celebration?.title ?? '',
      subtitle: celebration?.subtitle,
      level: celebration?.level,
      pointsAwarded: celebration?.pointsAwarded,
      primaryLabel: celebration?.primaryLabel ?? '继续',
      onPrimary: closeCelebration,
    },
    closeCelebration,
  };
}
