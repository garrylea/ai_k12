import { describe, it, expect, vi } from 'vitest';
import { MeaningService } from './meaning.service.js';

const PASSAGE = {
  id: 12,
  work_title: '酬乐天扬州初逢席上见赠',
  author: '刘禹锡',
  dynasty: '唐',
  body: '巴山楚水凄凉地，二十三年弃置身。沉舟侧畔千帆过，病树前头万木春。',
  key_terms: [
    { term: '沉（chén）舟', gloss: '沉没的船', src: 'textbook', sentenceIndex: 1 },
  ],
  sentences: [
    { text: '巴山楚水凄凉地，二十三年弃置身。', translation: '巴山楚水一片凄凉。' },
    { text: '沉舟侧畔千帆过，病树前头万木春。', translation: '沉船旁边千帆竞发。' },
  ],
  sentence_meanings: [
    { meaning: '写被贬之地的荒凉与岁月的漫长。', emotion: '辛酸、愤懑' },
    { meaning: '比喻新事物必将取代旧事物。', emotion: '豁达乐观、积极进取' },
  ],
  full_translation: '巴山楚水一片凄凉。沉船旁边千帆竞发。',
  grade_band: 'junior', grade: '九年级', semester: '上册', sort_order: 3,
  source_ref: 'DEV-FIXTURE', verified: 1, memorize_required: 1, is_active: 1,
};

const OK_JUDGE = {
  terms: [{ term: '沉（chén）舟', correct: true, comment: null }],
  meaning: { correct: false, comment: '这是比喻，不是写景' },
  emotion: { correct: true, comment: null },
};

function makeService(overrides: {
  passage?: unknown; list?: unknown; random?: unknown; byIds?: unknown;
  judged?: unknown; judgeThrows?: Error;
} = {}) {
  const repo = {
    findById: vi.fn().mockResolvedValue(overrides.passage === undefined ? PASSAGE : overrides.passage),
    findVerifiedForMeaning: vi.fn().mockResolvedValue(overrides.list ?? [PASSAGE]),
    findRandomVerifiedForMeaning: vi.fn().mockResolvedValue(overrides.random ?? [PASSAGE]),
    findVerifiedByIdsForMeaning: vi.fn().mockResolvedValue(overrides.byIds ?? [PASSAGE]),
  };
  const judge = {
    generate: vi.fn().mockImplementation(() => {
      if (overrides.judgeThrows) return Promise.reject(overrides.judgeThrows);
      return Promise.resolve(overrides.judged ?? OK_JUDGE);
    }),
  };
  return { service: new MeaningService(repo as never, judge as never), repo, judge };
}

describe('MeaningService.listMeaningPassages', () => {
  it('只出 passageId/workTitle/semester，含义与情感一律不下发', async () => {
    const { service } = makeService();
    const res = await service.listMeaningPassages();
    expect(res.passages).toEqual([{ passageId: 12, workTitle: '酬乐天扬州初逢席上见赠', semester: '上册' }]);
    const json = JSON.stringify(res);
    expect(json).not.toContain('新事物');
    expect(json).not.toContain('豁达乐观');
    expect(json).not.toContain('刘禹锡');
  });
});

describe('MeaningService.startMeaning', () => {
  it('下发整篇句子 text，answerable 标记有标准含义的句子，且不泄露答案', async () => {
    const { service } = makeService();
    const res = await service.startMeaning({ semester: null, passageIds: null, count: 1 });
    expect(res.passages[0]?.sentences).toEqual([
      { index: 0, text: '巴山楚水凄凉地，二十三年弃置身。', terms: [], answerable: true },
      { index: 1, text: '沉舟侧畔千帆过，病树前头万木春。',
        terms: [{ term: '沉（chén）舟', plain: '沉舟' }], answerable: true },
    ]);
    const json = JSON.stringify(res);
    expect(json).not.toContain('新事物');
    expect(json).not.toContain('豁达乐观');
    expect(json).not.toContain('沉没的船');
    expect(json).not.toContain('刘禹锡');
  });

  it('某句没有标准含义时 answerable=false，但 text 仍下发（诗要完整显示）', async () => {
    const partial = { ...PASSAGE, sentence_meanings: [{ meaning: '写凄凉。', emotion: '辛酸' }, null] };
    const { service } = makeService({ random: [partial] });
    const res = await service.startMeaning({ semester: null, passageIds: null, count: 1 });
    expect(res.passages[0]?.sentences[1]?.answerable).toBe(false);
    expect(res.passages[0]?.sentences[1]?.text).toBe('沉舟侧畔千帆过，病树前头万木春。');
  });
});

describe('MeaningService.judgeMeaning', () => {
  it('LLM 成功时按项回填，method 为 ai', async () => {
    const { service, judge } = makeService();
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '沉了的船' }],
      meaning: '旧事物会被新事物取代', emotion: '乐观',
    });
    expect(judge.generate).toHaveBeenCalledTimes(1);
    expect(res.terms[0]).toMatchObject({ correct: true, method: 'ai', standard: '沉没的船' });
    expect(res.meaning).toMatchObject({ correct: false, method: 'ai', standard: '比喻新事物必将取代旧事物。' });
    expect(res.emotion).toMatchObject({ correct: true, method: 'ai' });
    expect(res.allCorrect).toBe(false);
  });

  it('空答案不进 LLM，直接 unanswered 判错', async () => {
    const { service, judge } = makeService();
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1, terms: [], meaning: '', emotion: '',
    });
    expect(judge.generate).not.toHaveBeenCalled();
    expect(res.meaning).toMatchObject({ correct: false, method: 'unanswered' });
    expect(res.emotion).toMatchObject({ correct: false, method: 'unanswered' });
  });

  it('只填了含义、情感留空 → 情感 unanswered，含义照判', async () => {
    const { service, judge } = makeService();
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1, terms: [], meaning: '旧事物会被取代', emotion: '',
    });
    expect(judge.generate).toHaveBeenCalledTimes(1);
    expect(res.meaning.method).toBe('ai');
    expect(res.emotion).toMatchObject({ correct: false, method: 'unanswered' });
  });

  it('模型整次失败 → 待判项 undetermined、correct 为 null，不抛错', async () => {
    const { service } = makeService({ judgeThrows: new Error('boom') });
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '沉了的船' }],
      meaning: '旧事物会被取代', emotion: '乐观',
    });
    expect(res.terms[0]).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.meaning).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.allCorrect).toBe(false);
  });

  it('模型漏判某项 → 只有漏的那项 undetermined，已判项不清空', async () => {
    const { service } = makeService({
      judged: { terms: [], meaning: { correct: true, comment: null } }, // emotion 漏了
    });
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1, terms: [], meaning: '旧事物会被取代', emotion: '乐观',
    });
    expect(res.meaning).toMatchObject({ correct: true, method: 'ai' });
    expect(res.emotion).toMatchObject({ correct: null, method: 'undetermined' });
  });

  it('method 枚举不含 exact（钉住「不做程序短路」这个决定）', async () => {
    const { service } = makeService();
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1, terms: [],
      meaning: '比喻新事物必将取代旧事物。', // 与标准答案逐字相同
      emotion: '豁达乐观、积极进取',
    });
    expect(res.meaning.method).toBe('ai'); // 不是 'exact'
  });

  it('篇目不存在 → 404；sentenceIndex 越界 → 400；该句无标准含义 → 400', async () => {
    const { service } = makeService({ passage: null });
    await expect(service.judgeMeaning({ passageId: 999, sentenceIndex: 0, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/不存在/);
    const s2 = makeService().service;
    await expect(s2.judgeMeaning({ passageId: 12, sentenceIndex: 9, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/越界/);
    const s3 = makeService({
      passage: { ...PASSAGE, sentence_meanings: [null, null] },
    }).service;
    await expect(s3.judgeMeaning({ passageId: 12, sentenceIndex: 1, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/无标准含义/);
  });
});
