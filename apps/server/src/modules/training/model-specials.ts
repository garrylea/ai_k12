/** 已审核上线的模型微专题白名单。加模型只改这里。 */
export interface ModelSpecial {
  category: string;
  categoryName: string;
  model: string;
  modelName: string;
}

export const MODEL_SPECIALS: readonly ModelSpecial[] = [
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'median_doubling',
    modelName: '倍长中线',
  },
];

export function findModelSpecial(
  category: unknown,
  model: unknown,
): ModelSpecial | null {
  if (typeof category !== 'string' || typeof model !== 'string') return null;
  return MODEL_SPECIALS.find(
    (s) => s.category === category && s.model === model,
  ) ?? null;
}
