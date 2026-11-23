import { describe, expect, it } from 'vitest';
import { materialSlots } from './materialPlacement';

describe('materialSlots', () => {
  it('before 放题干上方', () => {
    expect(materialSlots({ material: '材料', materialPosition: 'before' }))
      .toEqual({ above: '材料', below: null });
  });
  it('默认放题干下方', () => {
    expect(materialSlots({ material: '材料' }))
      .toEqual({ above: null, below: '材料' });
  });
  it('空白材料视为无', () => {
    expect(materialSlots({ material: '  ', materialPosition: 'before' }))
      .toEqual({ above: null, below: null });
  });
});
