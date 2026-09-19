import { describe, it, expect, vi } from 'vitest';
import { SpecialsService } from './specials.service.js';

const mkRepo = () => ({
  aggregateByModule: vi.fn().mockResolvedValue([]),
  countByDayByModule: vi.fn().mockResolvedValue([]),
  countDistinctCorrectWords: vi.fn().mockResolvedValue(0),
});
const mkSvc = (repo = mkRepo()) => new SpecialsService(repo as any);

describe('SpecialsService', () => {
  it('四个模块一定都在：没数据的模块给 units=0 / correct=0 / rate=null / byDay=[]', async () => {
    const out = await mkSvc().getSpecials(11);

    expect(Object.keys(out)).toEqual(['dictation', 'interpretation', 'meaning', 'vocabulary']);
    expect(out.dictation).toEqual({ units: 0, correct: 0, rate: null, byDay: [] });
    // rate 必须是 null 而不是 0（spec §10 第 2 条）
    expect(out.vocabulary).toEqual({ units: 0, correct: 0, rate: null, byDay: [], newWords: 0 });
  });

  it('rate 用 toRate(answered, correct)；answered 排除没有明确对错的行', async () => {
    const repo = mkRepo();
    repo.aggregateByModule.mockResolvedValue([
      // 5 个单位，只有 4 个有明确对错，其中 3 个对 → 3/4 = 75%
      { module: 'chinese_dictation', units: 5, answered: 4, correct: 3 },
    ]);

    const out = await mkSvc(repo).getSpecials(11);

    expect(out.dictation).toMatchObject({ units: 5, correct: 3, rate: 75 });
  });

  it('byDay 按模块切分并映射成 {date, count}', async () => {
    const repo = mkRepo();
    repo.countByDayByModule.mockResolvedValue([
      { module: 'chinese_meaning', day: '2026-09-15', count: 3 },
      { module: 'en_vocabulary', day: '2026-09-16', count: 2 },
    ]);

    const out = await mkSvc(repo).getSpecials(11);

    expect(out.meaning.byDay).toEqual([{ date: '2026-09-15', count: 3 }]);
    expect(out.vocabulary.byDay).toEqual([{ date: '2026-09-16', count: 2 }]);
  });

  it('vocabulary 多一个 newWords，且只由 countDistinctCorrectWords 提供', async () => {
    const repo = mkRepo();
    repo.countDistinctCorrectWords.mockResolvedValue(12);

    const out = await mkSvc(repo).getSpecials(11);

    expect(out.vocabulary.newWords).toBe(12);
    // 其余三个模块没有这个字段
    expect(out.dictation).not.toHaveProperty('newWords');
  });

  it('窗口由 resolveRange 算好传参，仓储收到的是 Date 半开区间', async () => {
    const repo = mkRepo();

    await mkSvc(repo).getSpecials(11, '2026-09-13', '2026-09-19');

    const [, from, toExclusive] = repo.aggregateByModule.mock.calls[0];
    expect(from).toBeInstanceOf(Date);
    expect(toExclusive).toBeInstanceOf(Date);
    // 两端闭区间 → 排他上界是 09-20 的 00:00
    expect((toExclusive as Date).getTime() - (from as Date).getTime()).toBe(7 * 24 * 3_600_000);
  });
});
