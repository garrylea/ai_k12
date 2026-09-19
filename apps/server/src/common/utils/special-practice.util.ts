import type { SpecialPracticeVerdict } from '../../database/repositories/special-practice-logs.repo.js';

/**
 * 专项日志的两个**纯函数**（埋点 Phase 1B）。
 *
 * 放在 `common/utils` 而不是各 service 里：待判项的形状（`{correct, method}`）是三个专项共用的，
 * 塌缩规则若各写一份，两个专项很快会给出不一致的 verdict——而家长端的正确率就是按它算的。
 */

/** `correct` / `incorrect` 才是明确对错；`off_target` / `unanswered` / `undetermined` 都不是。 */
export function isCorrectOf(verdict: SpecialPracticeVerdict): boolean | null {
  if (verdict === 'correct') return true;
  if (verdict === 'incorrect') return false;
  return null;
}

/** 待判项的形状——解释/含义专项的 slot（字词项、翻译项、含义项、情感项）都长这样。 */
export interface UnitItem {
  correct: boolean | null;
  method: string;
}

/**
 * 把一句话的若干待判项塌缩成**句级 verdict**。
 *
 * 优先级（顺序即语义，勿调换）：确定错 → 没能判定 → 没作答 → 全对。
 * **不能只看 `correct`**：`unanswered` 的项也是 `correct: false`，必须结合 `method`。
 */
export function collapseUnitVerdict(items: ReadonlyArray<UnitItem>): SpecialPracticeVerdict {
  if (items.length === 0) return 'undetermined';
  // ① 有「不是没作答、但被判错」的项 → 整句算错
  if (items.some((i) => i.correct === false && i.method !== 'unanswered')) return 'incorrect';
  // ② 有没能判定的项 → 整句记为待查（比「没作答」优先：那是要追查的系统问题）
  if (items.some((i) => i.method === 'undetermined')) return 'undetermined';
  // ③ 有没作答的项 → 整句记为没作答
  if (items.some((i) => i.method === 'unanswered')) return 'unanswered';
  // ④ 剩下只能是全对（防御：若出现 correct === null 而 method 不是上面两者，也归为待查）
  return items.every((i) => i.correct === true) ? 'correct' : 'undetermined';
}
