import { describe, expect, it } from 'vitest';
import { chineseSimilarKpId } from './chinese-similar.util.js';

describe('chineseSimilarKpId', () => {
  it('全部知识点都在 C01/C02 -> 返回最小 id', () => {
    expect(chineseSimilarKpId([
      { id: 104, rootCode: 'C02' },
      { id: 88, rootCode: 'C01' },
    ])).toBe(88);
  });

  it('混入阅读(C03) 或写作(C04) -> null（整题不可练）', () => {
    expect(chineseSimilarKpId([
      { id: 88, rootCode: 'C01' },
      { id: 109, rootCode: 'C03' },
    ])).toBeNull();
    expect(chineseSimilarKpId([{ id: 124, rootCode: 'C04' }])).toBeNull();
  });

  it('无知识点 / rootCode 缺失 -> null', () => {
    expect(chineseSimilarKpId([])).toBeNull();
    expect(chineseSimilarKpId([{ id: 104, rootCode: null }])).toBeNull();
  });
});
