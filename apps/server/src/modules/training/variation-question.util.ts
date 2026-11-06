import { compareAnswer } from '../practice/judge-core.service.js';
import type { Difficulty, VariationQuestion } from '../../ai-core/types.js';

/** DB 的 difficulty 是 SMALLINT（number），ai-core 的 Difficulty 是 1|2|3 字面量联合；
 *  套题难度来自原错题行，题库口径恒为 1–3，此处按边界收敛（不做静默放大）。
 *  从 remediation-generator 迁出共享（错题变式生成器同口径，2026-10-11）。 */
export function toDifficulty(value: number): Difficulty {
  if (value <= 1) return 1;
  if (value >= 3) return 3;
  return 2;
}

/** choice / multi_choice 题入库答案归一：前端提交的是选项 label（ChoiceOptionList 提交 opt.label），
 *  而 judge-core.compareAnswer 只按 **label** 命中选项（`opts.find(o => normalizeAnswer(o.label) === a)`），
 *  且入库时 options 已剥掉 isCorrect、判题必然退化为「label === answer」比对 ——
 *  故 answer 必须以正确选项的 label 入库。否则 AI 若把 answer 写成选项文本（如 "2"），
 *  学生提交 label（如 "B"）会**恒判错**。
 *  调用前必须已过 variationRejectionReason 的「choice 恰有 1 个 isCorrect / multi_choice 至少 1 个」校验。
 *
 *  ⚠️ 已知限制：`true_false` **未**做同类归一（本函数只处理 choice / multi_choice，
 *  variationRejectionReason 的校验也仅对这两类生效）。前端 true_false 走默认选项 `对`/`错`
 *  （见 apps/web/src/components/business/answer/QuestionRunner.tsx 的 `q.type === 'true_false'`
 *  分支），若 AI 把 answer 写成「正确」/「T」之类，学生提交 `对`/`错` 同样会恒判错。
 *  当前**不可达**：套题/变式的题型只能来自原错题题型，而数学/物理题库均无 true_false 题。
 *  若将来题库引入判断题，**必须**同样把 answer 归一到 `对`/`错` 并强制 `options=null`。 */
export function toStoredAnswer(v: VariationQuestion, type: string): string {
  // 多选：答案必须是「正确项 label 排序拼接」（BD），与 judge-core 的多选集合比对同口径；
  // 顺序无关，故入库前统一排序，避免 DB 里出现 DB / BD 两种写法。
  if (type === 'multi_choice') {
    const correct = (v.options ?? []).filter((o) => o.isCorrect === true).map((o) => o.label);
    return correct.length > 0 ? [...correct].sort().join('') : v.answer;
  }
  if (type !== 'choice') return v.answer;
  const correct = (v.options ?? []).find((o) => o.isCorrect === true);
  return correct?.label ?? v.answer;
}

/** AI 生成题轻校验（remediation spec §5.3 / 变式生成同口径）：返回拒绝原因，null = 通过。 */
export function variationRejectionReason(v: VariationQuestion, type: string): string | null {
  if (!v.content.trim()) return '题干为空';
  if (!v.answer.trim()) return '无可解答案';
  if (type === 'multi_choice') {
    if (!Array.isArray(v.options) || v.options.length < 2) {
      return `multi_choice 选项不足 2 个（实际 ${v.options?.length ?? 0}）`;
    }
    // 至少 1 个正确项：零个正确项时「正确答案」不存在，判题无从比对
    const correct = v.options.filter((o) => o.isCorrect === true);
    if (correct.length < 1) return 'multi_choice 至少需要 1 个正确选项';
    // 答案与正确项集合一致（顺序无关，judge-core 多选同口径）
    const labels = correct.map((o) => o.label).sort().join('');
    if (!compareAnswer(v.answer, labels, JSON.stringify(v.options), 'multi_choice')) {
      return `multi_choice 答案与正确选项不一致（answer=${v.answer}，正确项 ${labels}）`;
    }
    return null;
  }
  if (type === 'choice') {
    if (!Array.isArray(v.options) || v.options.length < 2) {
      return `choice 选项不足 2 个（实际 ${v.options?.length ?? 0}）`;
    }
    // 有且仅有一个正确选项：多个/零个都会让判题（choice 走程序比对）行为不确定
    const correct = v.options.filter((o) => o.isCorrect === true);
    if (correct.length !== 1) {
      return `choice 正确选项应恰有 1 个（实际 ${correct.length}）`;
    }
    // 答案与正确选项一致：与 judge-core.compareAnswer 同口径（归一化后比对）——
    // 命中正确选项的 label，或命中其 text（题库 choice 题答案常直接写选项文本）。
    const optsJson = JSON.stringify(v.options);
    if (
      !compareAnswer(v.answer, correct[0].label, optsJson) &&
      !compareAnswer(v.answer, correct[0].text, optsJson)
    ) {
      return `choice 答案与正确选项不一致（answer=${v.answer}，正确项 ${correct[0].label}）`;
    }
  }
  return null;
}
