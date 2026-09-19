import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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
  award?: unknown; awardThrows?: Error; todayKey?: string;
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
  // 发分依赖（甲类逐目标发分，2026-09-17）：整篇最后一个可作答句判完时发一次。
  const points = {
    award: vi.fn().mockImplementation(() => {
      if (overrides.awardThrows) return Promise.reject(overrides.awardThrows);
      return Promise.resolve(overrides.award ?? { pointsAwarded: 4, balance: 4, totalEarned: 4, levelUp: null });
    }),
    todayKey: vi.fn(() => overrides.todayKey ?? '2026-09-17'),
  };
  // 专项日志（Phase 1B）：含义判题会写一行 special_practice_logs。
  const specialLogsRepo = { insert: vi.fn().mockResolvedValue(1) };
  return {
    service: new MeaningService(repo as never, judge as never, points as never, specialLogsRepo as never),
    repo, judge, points, specialLogsRepo,
  };
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

  it('sentence_meanings 与 sentences 长度不一致 → 整篇不下发（宁可少判，不能串句）', async () => {
    // sentences 2 句、sentence_meanings 只有 1 项：错位对齐时 meanings[i] 描述的是另一句
    const mismatched = { ...PASSAGE, sentence_meanings: [{ meaning: '写凄凉。', emotion: '辛酸' }] };
    const { service } = makeService({ random: [mismatched] });
    const res = await service.startMeaning({ semester: null, passageIds: null, count: 1 });
    expect(res.passages).toEqual([]);
    // 对不上就一句都不判，标准含义更不能泄露出去
    expect(JSON.stringify(res)).not.toContain('写凄凉');
  });

  it('指定篇目走 byIds 路径并按 count 截断，不碰随机抽题', async () => {
    const byIds = [
      { ...PASSAGE, id: 1, work_title: '篇一' },
      { ...PASSAGE, id: 2, work_title: '篇二' },
      { ...PASSAGE, id: 3, work_title: '篇三' },
    ];
    const { service, repo } = makeService({ byIds });
    const res = await service.startMeaning({ semester: null, passageIds: [1, 2, 3], count: 2 });
    expect(repo.findVerifiedByIdsForMeaning).toHaveBeenCalledWith([1, 2, 3]);
    expect(repo.findRandomVerifiedForMeaning).not.toHaveBeenCalled();
    expect(res.passages).toHaveLength(2);
    expect(res.passages.map((p) => p.passageId)).toEqual([1, 2]);
  });
});

describe('MeaningService.judgeMeaning', () => {
  it('LLM 成功时按项回填，method 为 ai', async () => {
    const { service, judge } = makeService();
    const res = await service.judgeMeaning({
      studentId: 1, passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '沉了的船' }],
      meaning: '旧事物会被新事物取代', emotion: '乐观',
    });
    expect(judge.generate).toHaveBeenCalledTimes(1);
    expect(judge.generate).toHaveBeenCalledWith({
      workTitle: '酬乐天扬州初逢席上见赠',
      sentence: '沉舟侧畔千帆过，病树前头万木春。',
      standardTranslation: '沉船旁边千帆竞发。',
      standardMeaning: '比喻新事物必将取代旧事物。',
      standardEmotion: '豁达乐观、积极进取',
      studentMeaning: '旧事物会被新事物取代',
      studentEmotion: '乐观',
      terms: [{ term: '沉（chén）舟', gloss: '沉没的船', answer: '沉了的船' }],
    });
    expect(res.terms[0]).toMatchObject({ correct: true, method: 'ai', standard: '沉没的船' });
    expect(res.meaning).toMatchObject({ correct: false, method: 'ai', standard: '比喻新事物必将取代旧事物。' });
    expect(res.emotion).toMatchObject({ correct: true, method: 'ai' });
    expect(res.allCorrect).toBe(false);
  });

  it('空答案不进 LLM，直接 unanswered 判错', async () => {
    const { service, judge } = makeService();
    const res = await service.judgeMeaning({
      studentId: 1, passageId: 12, sentenceIndex: 1, terms: [], meaning: '', emotion: '',
    });
    expect(judge.generate).not.toHaveBeenCalled();
    expect(res.meaning).toMatchObject({ correct: false, method: 'unanswered' });
    expect(res.emotion).toMatchObject({ correct: false, method: 'unanswered' });
  });

  it('只填了含义、情感留空 → 情感 unanswered，含义照判', async () => {
    const { service, judge } = makeService();
    const res = await service.judgeMeaning({
      studentId: 1, passageId: 12, sentenceIndex: 1, terms: [], meaning: '旧事物会被取代', emotion: '',
    });
    expect(judge.generate).toHaveBeenCalledTimes(1);
    expect(res.meaning.method).toBe('ai');
    expect(res.emotion).toMatchObject({ correct: false, method: 'unanswered' });
  });

  it('模型整次失败 → 待判项 undetermined、correct 为 null，不抛错', async () => {
    const { service } = makeService({ judgeThrows: new Error('boom') });
    const res = await service.judgeMeaning({
      studentId: 1, passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '沉了的船' }],
      meaning: '旧事物会被取代', emotion: '乐观',
    });
    expect(res.terms[0]).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.meaning).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.emotion).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.allCorrect).toBe(false);
  });

  it('整次失败 + 情感空答案 → 短路项保持 unanswered，不被失败兜底覆盖', async () => {
    const { service } = makeService({ judgeThrows: new Error('boom') });
    const res = await service.judgeMeaning({
      studentId: 1, passageId: 12, sentenceIndex: 1, terms: [], meaning: '旧事物会被取代', emotion: '',
    });
    expect(res.meaning).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.emotion).toMatchObject({ correct: false, method: 'unanswered' });
  });

  it('模型漏判某项 → 只有漏的那项 undetermined，已判项不清空', async () => {
    const { service } = makeService({
      judged: { terms: [], meaning: { correct: true, comment: null } }, // emotion 漏了
    });
    const res = await service.judgeMeaning({
      studentId: 1, passageId: 12, sentenceIndex: 1, terms: [], meaning: '旧事物会被取代', emotion: '乐观',
    });
    expect(res.meaning).toMatchObject({ correct: true, method: 'ai' });
    expect(res.emotion).toMatchObject({ correct: null, method: 'undetermined' });
  });

  it('method 枚举不含 exact（钉住「不做程序短路」这个决定）', async () => {
    const { service } = makeService();
    const res = await service.judgeMeaning({
      studentId: 1, passageId: 12, sentenceIndex: 1, terms: [],
      meaning: '比喻新事物必将取代旧事物。', // 与标准答案逐字相同
      emotion: '豁达乐观、积极进取',
    });
    expect(res.meaning.method).toBe('ai'); // 不是 'exact'
    expect(res.emotion.method).toBe('ai');
  });

  it('篇目不存在 → 404；sentenceIndex 越界 → 400；该句无标准含义 → 400', async () => {
    const { service } = makeService({ passage: null });
    await expect(service.judgeMeaning({ studentId: 1, passageId: 999, sentenceIndex: 0, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/不存在/);
    const s2 = makeService().service;
    await expect(s2.judgeMeaning({ studentId: 1, passageId: 12, sentenceIndex: 9, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/越界/);
    const s3 = makeService({
      passage: { ...PASSAGE, sentence_meanings: [null, null] },
    }).service;
    await expect(s3.judgeMeaning({ studentId: 1, passageId: 12, sentenceIndex: 1, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/无标准含义/);
  });

  it('sentence_meanings 与 sentences 长度不一致 → 判题 400，不得按错位答案判分', async () => {
    // 2 句 vs 1 含义：取下标 0 时若不做长度守卫，会拿「另一句」的标准答案去判
    const mismatched = { ...PASSAGE, sentence_meanings: [{ meaning: '写凄凉。', emotion: '辛酸' }] };
    const { service, judge } = makeService({ passage: mismatched });
    await expect(service.judgeMeaning({ studentId: 1, passageId: 12, sentenceIndex: 0, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.judgeMeaning({ studentId: 1, passageId: 12, sentenceIndex: 0, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/无标准含义/);
    expect(judge.generate).not.toHaveBeenCalled();
  });
});

describe('MeaningService.judgeMeaning — 甲类发分（cn_meaning，整篇答完发一次）', () => {
  /** 5 句、**最后一句没有标准含义**：整篇答完应以第 3 句（下标，0-based）为准。 */
  const FIVE = {
    ...PASSAGE,
    key_terms: [],
    sentences: [
      { text: '句一。', translation: 't1' },
      { text: '句二。', translation: 't2' },
      { text: '句三。', translation: 't3' },
      { text: '句四。', translation: 't4' },
      { text: '句五（无标准含义）。', translation: 't5' },
    ],
    sentence_meanings: [
      { meaning: 'm1', emotion: 'e1' },
      { meaning: 'm2', emotion: 'e2' },
      { meaning: 'm3', emotion: 'e3' },
      { meaning: 'm4', emotion: 'e4' },
      null,
    ],
  };
  const ANS = { terms: [], meaning: '作答', emotion: '作答' };

  it('非最后一句 → 不发分（且 award 根本不被调用）', async () => {
    const { service, points } = makeService(); // PASSAGE 2 句，都可作答
    const res = await service.judgeMeaning({ studentId: 5, passageId: 12, sentenceIndex: 0, ...ANS });
    expect(points.award).not.toHaveBeenCalled();
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBeUndefined();
  });

  it('最后一个可作答句 → 发一次，幂等键含 todayKey()，响应带 pointsAwarded', async () => {
    const { service, points } = makeService();
    const res = await service.judgeMeaning({ studentId: 5, passageId: 12, sentenceIndex: 1, ...ANS });
    expect(points.todayKey).toHaveBeenCalled();
    expect(points.award).toHaveBeenCalledTimes(1);
    expect(points.award).toHaveBeenCalledWith({
      studentId: 5,
      taskCode: 'cn_meaning',
      tierKey: 'default',
      dedupeKey: 'meaning:5:12:2026-09-17',
      refType: 'passage',
      refId: 12,
    });
    expect(res.pointsAwarded).toBe(4);
    expect(res.awardReason).toBeUndefined();
  });

  it('末句无可作答内容 → 由**前一个可作答句**（下标 3）触发发分', async () => {
    // 本任务最容易写错的一处：sentences.length - 1 (=4) 那句没有标准含义，
    // 若按下标 4 发分，这篇永远拿不到分。
    const { service, points } = makeService({ passage: FIVE });
    const res = await service.judgeMeaning({ studentId: 5, passageId: 12, sentenceIndex: 3, ...ANS });
    expect(points.award).toHaveBeenCalledTimes(1);
    expect(points.award).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'meaning:5:12:2026-09-17', refId: 12 }),
    );
    expect(res.pointsAwarded).toBe(4);
  });

  it('末句不可作答时判它（下标 4）→ 走既有「无标准含义」400 守卫，不发分也不抛积分错', async () => {
    const { service, points } = makeService({ passage: FIVE });
    await expect(
      service.judgeMeaning({ studentId: 5, passageId: 12, sentenceIndex: 4, ...ANS }),
    ).rejects.toThrow(/无标准含义/);
    expect(points.award).not.toHaveBeenCalled();
  });

  it('判错/未判定也发分（完成即给，不看对错）', async () => {
    const { service, points } = makeService({ judged: { terms: [], meaning: null, emotion: null } });
    const res = await service.judgeMeaning({ studentId: 5, passageId: 12, sentenceIndex: 1, ...ANS });
    expect(res.meaning.method).toBe('undetermined');
    expect(points.award).toHaveBeenCalledTimes(1);
    expect(res.pointsAwarded).toBe(4);
  });

  it('award 抛错 → 判题结果照常返回（逐项判定完整），pointsAwarded=0', async () => {
    const { service } = makeService({ awardThrows: new Error('db down') });
    const res = await service.judgeMeaning({ studentId: 5, passageId: 12, sentenceIndex: 1, ...ANS });
    expect(res.meaning).toMatchObject({ correct: false, method: 'ai' });
    expect(res.emotion).toMatchObject({ correct: true, method: 'ai' });
    expect(res.allCorrect).toBe(false);
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBeUndefined();
  });

  it('award 回 daily_limit → pointsAwarded=0 + awardReason 透传', async () => {
    const { service } = makeService({ award: { pointsAwarded: 0, reason: 'daily_limit' } });
    const res = await service.judgeMeaning({ studentId: 5, passageId: 12, sentenceIndex: 1, ...ANS });
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBe('daily_limit');
  });

  it('award 回 duplicate（同日重判同一篇）→ 归 0 且静默，不弹假「+N 分」', async () => {
    const { service } = makeService({ award: { pointsAwarded: 4, reason: 'duplicate' } });
    const res = await service.judgeMeaning({ studentId: 5, passageId: 12, sentenceIndex: 1, ...ANS });
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBeUndefined();
  });
});

describe('MeaningService.judgeMeaning — 专项日志（Phase 1B）', () => {
  it('逐句作答 → 一行记一句；含义判错即整句 incorrect', async () => {
    const { service, specialLogsRepo } = makeService(); // OK_JUDGE：字词/情感判对、含义判错
    await service.judgeMeaning({
      studentId: 5, passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '沉了的船' }],
      meaning: '写景', emotion: '乐观',
    });

    expect(specialLogsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      studentId: 5, module: 'chinese_meaning', refType: 'passage', refId: 12,
      refKey: '酬乐天扬州初逢席上见赠', sentenceIndex: 1,
      verdict: 'incorrect', isCorrect: false, errorCounted: true,
    }));
  });

  it('三项全判对 → correct / isCorrect=true / 不计错', async () => {
    const { service, specialLogsRepo } = makeService({
      judged: {
        terms: [{ term: '沉（chén）舟', correct: true, comment: null }],
        meaning: { correct: true, comment: null },
        emotion: { correct: true, comment: null },
      },
    });
    await service.judgeMeaning({
      studentId: 5, passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '沉了的船' }],
      meaning: '新事物取代旧事物', emotion: '乐观进取',
    });

    expect(specialLogsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'correct', isCorrect: true, errorCounted: false,
    }));
  });

  it('三处都空 → unanswered（isCorrect=null、**不计错**），且不调 LLM', async () => {
    const { service, specialLogsRepo, judge } = makeService();
    await service.judgeMeaning({
      studentId: 5, passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '' }], meaning: '', emotion: '',
    });

    expect(judge.generate).not.toHaveBeenCalled();
    expect(specialLogsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      sentenceIndex: 1, verdict: 'unanswered', isCorrect: null, errorCounted: false,
    }));
  });

  it('日志写入失败不阻断判题', async () => {
    const { service, specialLogsRepo } = makeService();
    specialLogsRepo.insert.mockRejectedValueOnce(new Error('db down'));

    const res = await service.judgeMeaning({
      studentId: 5, passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '沉了的船' }],
      meaning: '写景', emotion: '乐观',
    });
    expect(res).toHaveProperty('allCorrect');
  });
});
