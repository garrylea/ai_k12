/** 材料位置：material_text 在题干上方还是下方（2026-11-23 道法小问）。 */
export function materialSlots(q: {
  material?: string | null;
  materialPosition?: string | null;
}): { above: string | null; below: string | null } {
  const text = q.material?.trim() ? q.material : null;
  return q.materialPosition === 'before'
    ? { above: text, below: null }
    : { above: null, below: text };
}
