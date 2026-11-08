import { CN_SIMILAR_KP_ROOTS } from './subject-config.js';

export interface QuestionKpRef {
  id: number;
  /** 所属顶层知识点 code（二级取父级 C0x，顶层取自身 C0x）；NULL = 无法归类。 */
  rootCode: string | null;
}

/**
 * 语文「同类型练习」的可用知识点。
 *
 * 只有**所有**知识点都落在 C01（积累与运用）/ C02（古诗文）才算可练；
 * 混入 C03（现代文阅读）/ C04（写作）或无法归类的一律不可练——跨模块题多为
 * 阅读题被顺带打了基础标签，放宽会违背「排除阅读理解」的产品口径（2026-11-08）。
 * 通过时返回 id 最小的知识点（种子 KP）。
 */
export function chineseSimilarKpId(refs: QuestionKpRef[]): number | null {
  if (refs.length === 0) return null;
  let minId: number | null = null;
  for (const r of refs) {
    if (!r.rootCode || !CN_SIMILAR_KP_ROOTS.includes(r.rootCode)) return null;
    if (minId === null || r.id < minId) minId = r.id;
  }
  return minId;
}
