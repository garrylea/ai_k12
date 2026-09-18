/**
 * 训练页共享的积分反馈决策（6 个页面共用一份，与 Task 6 抽出的 `point-tiers.ts` 同层）。
 *
 * 为什么要抽：三个甲类判题页 + 两个会话页 + 交卷页都要把「同一次发分结果」翻译成
 * 「弹轻反馈 / 弹全屏庆祝 / 什么都不做」。这段规则抄六遍必然走样，而抄错一条就会真坏：
 * `pointsAwarded === 0` **不等于**「已达上限」——`PointsToast` 对 `points <= 0` 一律渲染
 * 「今日该任务积分已达上限」，所以幂等命中（无 reason）必须在决策层拦掉，否则弹假文案
 * （计划 §1.1#4）。
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
}

/** 「什么该弹、什么该静默」的决策结果。 */
export type PointsFeedbackDecision =
  | { kind: 'silent' }
  | { kind: 'toast'; points: number }
  | { kind: 'levelup' };

/**
 * 入参 → 决策。**顺序与门槛都不能改**（计划 §3 Task 7a 的判定表）：
 *
 * | 情况 | 行为 |
 * |---|---|
 * | 正分 + 晋升 | 全屏庆祝（**不**再 push 轻反馈，避免两处同时弹，§2.2） |
 * | 正分 | 轻反馈 `+N 分` |
 * | 0 分 + `daily_limit` | 轻反馈 0 分 → `PointsToast` 渲染「今日该任务积分已达上限」 |
 * | 其余（含无 reason 的幂等命中） | 静默 |
 */
export function decidePointsFeedback(input: PointsFeedbackInput): PointsFeedbackDecision {
  const { pointsAwarded, awardReason, levelUp } = input;

  if (pointsAwarded > 0) {
    return levelUp ? { kind: 'levelup' } : { kind: 'toast', points: pointsAwarded };
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
  title: string;
  level: { code: string; name: string };
  pointsAwarded: number;
}

/**
 * 可直接摊到调用页自己的 `<CelebrationOverlay>` 上的 props（页面再补 `primaryLabel` /
 * `onPrimary` / `subtitle` 这些页级参数）。`variant` 恒为 `levelup`——本模块不承载 task 型庆祝。
 */
export interface PointsCelebrationProps {
  open: boolean;
  variant: 'levelup';
  title: string;
  level: { code: string; name: string } | undefined;
  pointsAwarded: number | undefined;
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

  const award = useCallback(
    (input: PointsFeedbackInput) => {
      const decision = decidePointsFeedback(input);

      if (decision.kind === 'toast') {
        push({ points: decision.points, title: input.title });
        return;
      }

      const levelUp = input.levelUp;
      if (decision.kind !== 'levelup' || !levelUp) return;

      const to = levelUp.to;
      // 段位名的唯一真源在后端（spec §3.1），前端不维护段位表：先出图标，名字晚一拍补上。
      setCelebration({
        title: '晋升新段位！',
        level: { code: to, name: '' },
        pointsAwarded: input.pointsAwarded,
      });
      getMyPoints()
        .then((me) => {
          setCelebration((current) =>
            // code 比对：旧请求迟到时不覆盖后一次庆祝（同 CourseDetailPage 的做法）
            current && current.level.code === to
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

  const closeCelebration = useCallback(() => setCelebration(null), []);

  return {
    award,
    celebrationProps: {
      open: celebration !== null,
      variant: 'levelup',
      title: celebration?.title ?? '',
      level: celebration?.level,
      pointsAwarded: celebration?.pointsAwarded,
    },
    closeCelebration,
  };
}
