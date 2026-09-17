import { describe, it, expect, vi } from 'vitest';
import { TrainingService } from './training.service';

/**
 * 解释专项 service 层单测（纯 mock，不连真 DB、不调真 LLM）。
 *
 * 重点钉住四件事：
 *   1. 防泄题 —— `start` 的响应里绝不能出现释义/译文/作者；
 *   2. 程序短路 —— 能确定的对错不进 LLM（断言调用次数为 0）；
 *   3. undetermined 语义 —— 漏项/整次失败都逐项降级，**不抛错、不清空已判项**；
 *   4. 不写学生状态 —— 独立子系统，判题不得碰错题本/隐藏题/提示缓存。
 */

const PASSAGE = {
  id: 12,
  work_title: '岳阳楼记',
  author: '范仲淹',
  dynasty: '宋',
  body: '庆历四年春，滕子京谪守巴陵郡。越明年，政通人和。',
  key_terms: [
    { term: '谪守', gloss: '因罪贬谪流放，出任外官', src: 'textbook', sentenceIndex: 0 },
    { term: '越明年', gloss: '到了第二年', src: 'textbook', sentenceIndex: 1 },
  ],
  sentences: [
    { text: '庆历四年春，滕子京谪守巴陵郡。', translation: '庆历四年的春天，滕子京被贬到巴陵郡做太守。' },
    { text: '越明年，政通人和。', translation: '到了第二年，政事顺利，百姓和乐。' },
  ],
  full_translation: '庆历四年的春天，滕子京被贬到巴陵郡做太守。到了第二年，政事顺利，百姓和乐。',
  grade_band: 'junior',
  grade: '九年级',
  semester: '上册',
  sort_order: 2,
  source_ref: 'DEV-FIXTURE',
  verified: 1,
  memorize_required: 1,
  is_active: 1,
  genre: 'prose',
};

/** 模型正常返回：1 个字词判错 + 整句判对 */
const OK_JUDGE = {
  terms: [{ term: '谪守', correct: false, comment: '「谪」含因罪被贬之意' }],
  sentence: { correct: true, comment: null },
};

function makeService(overrides: {
  passage?: unknown;
  list?: unknown;
  random?: unknown;
  byIds?: unknown;
  judged?: unknown;
  judgeThrows?: Error;
  award?: unknown;
  awardThrows?: Error;
  todayKey?: string;
} = {}) {
  const dictationRepo = {
    findById: vi.fn().mockResolvedValue(overrides.passage === undefined ? PASSAGE : overrides.passage),
    findVerifiedForInterpretation: vi.fn().mockResolvedValue(overrides.list ?? [PASSAGE]),
    findRandomVerifiedForInterpretation: vi.fn().mockResolvedValue(overrides.random ?? [PASSAGE]),
    findVerifiedByIdsForInterpretation: vi.fn().mockResolvedValue(overrides.byIds ?? [PASSAGE]),
  };
  const interpretationJudge = {
    generate: vi.fn().mockImplementation(() => {
      if (overrides.judgeThrows) return Promise.reject(overrides.judgeThrows);
      return Promise.resolve(overrides.judged ?? OK_JUDGE);
    }),
  };
  // 发分依赖（甲类逐目标发分，2026-09-17）。
  const points = {
    award: vi.fn().mockImplementation(() => {
      if (overrides.awardThrows) return Promise.reject(overrides.awardThrows);
      return Promise.resolve(overrides.award ?? { pointsAwarded: 3, balance: 3, totalEarned: 3, levelUp: null });
    }),
    todayKey: vi.fn(() => overrides.todayKey ?? '2026-09-17'),
  };
  // 这些 repo 在解释专项里**一个都不该被碰**（不写学生状态）
  const mainErrorRepo = { findErrorBookEntries: vi.fn(), bumpLevels: vi.fn() };
  const hiddenRepo = { mark: vi.fn(), unmark: vi.fn(), unmarkAll: vi.fn(), findAllByStudent: vi.fn() };
  const questionHintsRepo = { findByQuestionId: vi.fn(), upsert: vi.fn() };
  const explanationCache = { ensureExplanation: vi.fn() };

  const service = new TrainingService(
    mainErrorRepo as never, {} as never, {} as never, {} as never,
    questionHintsRepo as never, {} as never, hiddenRepo as never,
    explanationCache as never, {} as never,
    dictationRepo as never, { generate: vi.fn() } as never, interpretationJudge as never,
    points as never,
  );
  return { service, dictationRepo, interpretationJudge, mainErrorRepo, hiddenRepo, questionHintsRepo, explanationCache, points };
}

describe('TrainingService — 解释专项 listInterpretationPassages', () => {
  it('只出 passageId/workTitle/semester，释义与译文一律不下发', async () => {
    const { service } = makeService();
    const res = await service.listInterpretationPassages();
    expect(res.passages).toEqual([{ passageId: 12, workTitle: '岳阳楼记', semester: '上册' }]);
    const json = JSON.stringify(res);
    expect(json).not.toContain('因罪贬谪流放');
    expect(json).not.toContain('庆历四年的春天');
    expect(json).not.toContain('范仲淹');
  });
});

describe('TrainingService — 解释专项 startInterpretation', () => {
  it('随机路径：调 findRandomVerifiedForInterpretation(semester, count)', async () => {
    const { service, dictationRepo } = makeService();
    await service.startInterpretation({ semester: '下册', passageIds: null, count: 3 });
    expect(dictationRepo.findRandomVerifiedForInterpretation).toHaveBeenCalledWith('下册', 3);
    expect(dictationRepo.findVerifiedByIdsForInterpretation).not.toHaveBeenCalled();
  });

  it('指定篇目路径：调 findVerifiedByIdsForInterpretation，忽略 semester', async () => {
    const { service, dictationRepo } = makeService();
    await service.startInterpretation({ semester: '上册', passageIds: [12, 13], count: 2 });
    expect(dictationRepo.findVerifiedByIdsForInterpretation).toHaveBeenCalledWith([12, 13]);
    expect(dictationRepo.findRandomVerifiedForInterpretation).not.toHaveBeenCalled();
  });

  it('字词按 sentenceIndex 挂到正确的句子，越界的字词不出现在任何句子上', async () => {
    const { service } = makeService({
      random: [{
        ...PASSAGE,
        key_terms: [
          { term: '谪守', gloss: 'g1', sentenceIndex: 0 },
          { term: '越明年', gloss: 'g2', sentenceIndex: 1 },
          { term: '越界词', gloss: 'g3', sentenceIndex: 99 },
        ],
      }],
    });
    const res = await service.startInterpretation({ semester: null, passageIds: null, count: 1 });
    expect(res.passages[0].sentences.map((s) => s.terms.map((t) => t.term)))
      .toEqual([['谪守'], ['越明年']]);
  });

  it('字词带注音时同时给「原样 term」与「去注音 plain」两个形式', async () => {
    // 展示用 term（带拼音，学生要看得见读音）；高亮用 plain——正文里没有注音，
    // 前端拿 term 去原文里 indexOf 永远找不到。
    const { service } = makeService({
      random: [{
        ...PASSAGE,
        key_terms: [{ term: '滕子京谪（zhé）守巴陵郡', gloss: 'g', sentenceIndex: 0 }],
      }],
    });
    const res = await service.startInterpretation({ semester: null, passageIds: null, count: 1 });
    expect(res.passages[0].sentences[0].terms).toEqual([
      { term: '滕子京谪（zhé）守巴陵郡', plain: '滕子京谪守巴陵郡' },
    ]);
    // plain 必须真能在该句原文里找到（否则前端高亮不上）
    expect(res.passages[0].sentences[0].text).toContain(
      res.passages[0].sentences[0].terms[0].plain,
    );
  });

  it('响应是白名单序列化：不含 gloss / translation / full_translation / author / dynasty', async () => {
    const { service } = makeService();
    const res = await service.startInterpretation({ semester: null, passageIds: null, count: 1 });
    expect(res.passages[0].sentences[0].text).toBe('庆历四年春，滕子京谪守巴陵郡。');
    const json = JSON.stringify(res);
    expect(json).not.toContain('因罪贬谪流放');
    expect(json).not.toContain('庆历四年的春天');
    expect(json).not.toContain('范仲淹');
    expect(json).not.toContain('full_translation');
  });

  it('sentences 为空/坏形状的篇目被过滤掉（不能下发一张空卡片）', async () => {
    const { service } = makeService({
      random: [
        { ...PASSAGE, id: 1, sentences: null },
        { ...PASSAGE, id: 2, sentences: [] },
        { ...PASSAGE, id: 3, sentences: 'not-an-array' },
        { ...PASSAGE, id: 4 },
      ],
    });
    const res = await service.startInterpretation({ semester: null, passageIds: null, count: 5 });
    expect(res.passages.map((p) => p.passageId)).toEqual([4]);
  });

  it('指定篇目多于 count 时截断', async () => {
    const { service } = makeService({
      byIds: [{ ...PASSAGE, id: 1 }, { ...PASSAGE, id: 2 }, { ...PASSAGE, id: 3 }],
    });
    const res = await service.startInterpretation({ semester: null, passageIds: [1, 2, 3], count: 2 });
    expect(res.passages.map((p) => p.passageId)).toEqual([1, 2]);
  });

  it('sentenceIndex 用数组下标重新编号（不依赖存储值）', async () => {
    const { service } = makeService();
    const res = await service.startInterpretation({ semester: null, passageIds: null, count: 1 });
    expect(res.passages[0].sentences.map((s) => s.index)).toEqual([0, 1]);
  });
});

describe('TrainingService — 解释专项 judgeInterpretation：程序短路', () => {
  it('全空作答 → 全部 unanswered，**不进 LLM**', async () => {
    const { service, interpretationJudge } = makeService();
    const res = await service.judgeInterpretation({
      studentId: 1, passageId: 12, sentenceIndex: 0, terms: [], translation: '',
    });
    expect(interpretationJudge.generate).not.toHaveBeenCalled();
    expect(res.terms).toEqual([
      { term: '谪守', correct: false, method: 'unanswered', standard: '因罪贬谪流放，出任外官', comment: null },
    ]);
    expect(res.sentence.method).toBe('unanswered');
    expect(res.sentence.correct).toBe(false);
    expect(res.allCorrect).toBe(false);
  });

  it('归一化全等 → exact，**不进 LLM**（学生整句不打标点也算对）', async () => {
    const { service, interpretationJudge } = makeService();
    const res = await service.judgeInterpretation({
      studentId: 1,
      passageId: 12,
      sentenceIndex: 0,
      terms: [{ term: '谪守', answer: '因罪贬谪流放,出任外官' }], // 逗号与标准答案不同
      translation: '庆历四年的春天滕子京被贬到巴陵郡做太守',       // 整句无标点
    });
    expect(interpretationJudge.generate).not.toHaveBeenCalled();
    expect(res.terms[0]).toMatchObject({ correct: true, method: 'exact' });
    expect(res.sentence).toMatchObject({ correct: true, method: 'exact' });
    expect(res.allCorrect).toBe(true);
  });

  it('本句无字词且整句为空 → 0 次 LLM 调用，allCorrect=false（未作答）', async () => {
    const { service, interpretationJudge } = makeService({
      passage: { ...PASSAGE, key_terms: [] },
    });
    const res = await service.judgeInterpretation({
      studentId: 1, passageId: 12, sentenceIndex: 0, terms: [{ term: '多传的词', answer: 'x' }], translation: '',
    });
    expect(interpretationJudge.generate).not.toHaveBeenCalled();
    expect(res.terms).toEqual([]);
    expect(res.allCorrect).toBe(false);
  });
});

describe('TrainingService — 解释专项 judgeInterpretation：LLM 补判', () => {
  it('待判项打包**一次**调用，字词与整句合成同一请求', async () => {
    const { service, interpretationJudge } = makeService();
    await service.judgeInterpretation({
      studentId: 1,
      passageId: 12, sentenceIndex: 0,
      terms: [{ term: '谪守', answer: '被贬官' }],
      translation: '庆历四年春天，滕子京被派到巴陵当官。',
    });
    expect(interpretationJudge.generate).toHaveBeenCalledTimes(1);
    const req = interpretationJudge.generate.mock.calls[0][0];
    expect(req.sentence).toBe('庆历四年春，滕子京谪守巴陵郡。');
    expect(req.standardTranslation).toBe('庆历四年的春天，滕子京被贬到巴陵郡做太守。');
    expect(req.studentTranslation).toBe('庆历四年春天，滕子京被派到巴陵当官。');
    expect(req.terms).toEqual([{ term: '谪守', gloss: '因罪贬谪流放，出任外官', answer: '被贬官' }]);
  });

  it('模型判了 → method 变 ai，带上 comment', async () => {
    const { service } = makeService();
    const res = await service.judgeInterpretation({
      studentId: 1,
      passageId: 12, sentenceIndex: 0,
      terms: [{ term: '谪守', answer: '被贬官' }],
      translation: '庆历四年春天，滕子京被派到巴陵当官。',
    });
    expect(res.terms[0]).toMatchObject({
      correct: false, method: 'ai', comment: '「谪」含因罪被贬之意',
    });
    expect(res.sentence).toMatchObject({ correct: true, method: 'ai' });
  });

  it('模型漏项 → 漏的那项保持 undetermined（correct=null），不影响已判项', async () => {
    const { service } = makeService({
      passage: {
        ...PASSAGE,
        key_terms: [
          { term: '谪守', gloss: 'g1', sentenceIndex: 0 },
          { term: '越明年', gloss: 'g2', sentenceIndex: 0 },
        ],
      },
      judged: { terms: [{ term: '谪守', correct: true, comment: null }], sentence: null },
    });
    const res = await service.judgeInterpretation({
      studentId: 1,
      passageId: 12, sentenceIndex: 0,
      terms: [{ term: '谪守', answer: 'a1' }, { term: '越明年', answer: 'a2' }],
      translation: '随便一段译文。',
    });
    expect(res.terms[0]).toMatchObject({ term: '谪守', correct: true, method: 'ai' });
    expect(res.terms[1]).toMatchObject({ term: '越明年', correct: null, method: 'undetermined' });
    // 整句也没判出来
    expect(res.sentence).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.allCorrect).toBe(false);
  });

  it('整次调用失败 → 全部待判项 undetermined，**方法不抛错**', async () => {
    const { service } = makeService({ judgeThrows: new Error('local down') });
    const res = await service.judgeInterpretation({
      studentId: 1,
      passageId: 12, sentenceIndex: 0,
      terms: [{ term: '谪守', answer: '被贬官' }],
      translation: '庆历四年春天，滕子京被派到巴陵当官。',
    });
    expect(res.terms[0]).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.sentence).toMatchObject({ correct: null, method: 'undetermined' });
  });

  it('整次失败时**已短路判出的项原样保留**（学生不会因模型抖动丢掉已得反馈）', async () => {
    const { service } = makeService({
      judgeThrows: new Error('down'),
      passage: {
        ...PASSAGE,
        key_terms: [
          { term: '谪守', gloss: '因罪贬谪流放，出任外官', sentenceIndex: 0 },
          { term: '越明年', gloss: 'g2', sentenceIndex: 0 },
        ],
      },
    });
    const res = await service.judgeInterpretation({
      studentId: 1,
      passageId: 12, sentenceIndex: 0,
      terms: [{ term: '谪守', answer: '因罪贬谪流放，出任外官' }, { term: '越明年', answer: '乱写' }],
      translation: '',
    });
    expect(res.terms[0]).toMatchObject({ correct: true, method: 'exact' });
    expect(res.terms[1]).toMatchObject({ correct: null, method: 'undetermined' });
  });

  it('标准答案只在判题响应里下发（request 里给模型，响应里给学生）', async () => {
    const { service } = makeService();
    const res = await service.judgeInterpretation({
      studentId: 1, passageId: 12, sentenceIndex: 0, terms: [], translation: '',
    });
    expect(res.terms[0].standard).toBe('因罪贬谪流放，出任外官');
    expect(res.sentence.standard).toBe('庆历四年的春天，滕子京被贬到巴陵郡做太守。');
  });
});

describe('TrainingService — 解释专项 judgeInterpretation：边界与副作用', () => {
  it('篇目不存在 → NotFoundException', async () => {
    const { service } = makeService({ passage: null });
    await expect(service.judgeInterpretation({
      studentId: 1, passageId: 999, sentenceIndex: 0, terms: [], translation: '',
    })).rejects.toThrow(/解释篇目不存在/);
  });

  it('sentenceIndex 越界 → BadRequestException', async () => {
    const { service } = makeService();
    await expect(service.judgeInterpretation({
      studentId: 1, passageId: 12, sentenceIndex: 2, terms: [], translation: '',
    })).rejects.toThrow(/越界/);
  });

  it('多传的 term 被忽略，漏传的 term 按空白判 unanswered', async () => {
    const { service, interpretationJudge } = makeService();
    const res = await service.judgeInterpretation({
      studentId: 1,
      passageId: 12, sentenceIndex: 0,
      terms: [
        { term: '谪守', answer: '   ' },      // 漏传 → 空白
        { term: '不存在的词', answer: 'x' },  // 多传 → 忽略
      ],
      translation: '',
    });
    expect(res.terms).toHaveLength(1);
    expect(res.terms[0]).toMatchObject({ term: '谪守', method: 'unanswered' });
    expect(interpretationJudge.generate).not.toHaveBeenCalled();
  });

  it('fullTranslation：最后一句才给，中间句为 null', async () => {
    const { service } = makeService();
    const mid = await service.judgeInterpretation({
      studentId: 1, passageId: 12, sentenceIndex: 0, terms: [], translation: '',
    });
    expect(mid.fullTranslation).toBeNull();
    const last = await service.judgeInterpretation({
      studentId: 1, passageId: 12, sentenceIndex: 1, terms: [], translation: '',
    });
    expect(last.fullTranslation).toBe(PASSAGE.full_translation);
  });

  it('不写任何学生状态：错题本/隐藏题/提示缓存 repo 一个都不该被调用', async () => {
    const { service, mainErrorRepo, hiddenRepo, questionHintsRepo, explanationCache } = makeService();
    await service.judgeInterpretation({
      studentId: 1,
      passageId: 12, sentenceIndex: 0,
      terms: [{ term: '谪守', answer: '被贬官' }],
      translation: '庆历四年春天，滕子京被派到巴陵当官。',
    });
    expect(mainErrorRepo.findErrorBookEntries).not.toHaveBeenCalled();
    expect(mainErrorRepo.bumpLevels).not.toHaveBeenCalled();
    expect(hiddenRepo.mark).not.toHaveBeenCalled();
    expect(hiddenRepo.unmark).not.toHaveBeenCalled();
    expect(questionHintsRepo.upsert).not.toHaveBeenCalled();
    expect(explanationCache.ensureExplanation).not.toHaveBeenCalled();
  });

  it('allCorrect：字词对 + 整句对 → true；有 undetermined → false', async () => {
    const { service } = makeService({ judged: { terms: [], sentence: null } });
    const res = await service.judgeInterpretation({
      studentId: 1, passageId: 12, sentenceIndex: 1, // 第二句的字词是「越明年」
      terms: [{ term: '越明年', answer: '到了第二年' }],
      translation: '到了第二年，政事顺利，百姓和乐。',
    });
    expect(res.terms).toMatchObject([{ term: '越明年', correct: true, method: 'exact' }]);
    expect(res.sentence.method).toBe('exact');
    expect(res.allCorrect).toBe(true);
  });

  it('allCorrect：任一项未判定 → false（不能把「不知道」当成对）', async () => {
    const { service } = makeService({ judged: { terms: [], sentence: null } });
    const res = await service.judgeInterpretation({
      studentId: 1,
      passageId: 12, sentenceIndex: 1,
      terms: [{ term: '越明年', answer: '第二年吧' }], // 需 LLM 判，而模型没回 → undetermined
      translation: '到了第二年，政事顺利，百姓和乐。',
    });
    expect(res.terms[0].method).toBe('undetermined');
    expect(res.sentence.method).toBe('exact');
    expect(res.allCorrect).toBe(false);
  });
});

describe('TrainingService — 解释专项 judgeInterpretation：甲类发分（cn_interpretation，按体裁取档）', () => {
  const ANS = { terms: [], translation: '' };

  it('genre=prose → 按 prose 档发一次，幂等键含 todayKey()，响应带 pointsAwarded', async () => {
    const { service, points } = makeService(); // PASSAGE.genre === 'prose'
    const res = await service.judgeInterpretation({ studentId: 7, passageId: 12, sentenceIndex: 0, ...ANS });
    expect(points.todayKey).toHaveBeenCalled();
    expect(points.award).toHaveBeenCalledTimes(1);
    expect(points.award).toHaveBeenCalledWith({
      studentId: 7,
      taskCode: 'cn_interpretation',
      tierKey: 'prose',
      dedupeKey: 'interp:7:12:2026-09-17',
      refType: 'passage',
      refId: 12,
    });
    expect(res.pointsAwarded).toBe(3);
    expect(res.awardReason).toBeUndefined();
  });

  it('genre=poem → tierKey=poem', async () => {
    const { service, points } = makeService({ passage: { ...PASSAGE, genre: 'poem' } });
    await service.judgeInterpretation({ studentId: 5, passageId: 12, sentenceIndex: 1, ...ANS });
    expect(points.award).toHaveBeenCalledWith(
      expect.objectContaining({ tierKey: 'poem', dedupeKey: 'interp:5:12:2026-09-17' }),
    );
  });

  it('逐句判：第一句判完就发分（同日后续句子靠幂等键不再发）', async () => {
    // 一篇 = 一次分：判题是逐句的，所以首句判完即发，后几句 award 会回 duplicate
    const { service, points } = makeService();
    await service.judgeInterpretation({ studentId: 7, passageId: 12, sentenceIndex: 0, ...ANS });
    await service.judgeInterpretation({ studentId: 7, passageId: 12, sentenceIndex: 1, ...ANS });
    expect(points.award).toHaveBeenCalledTimes(2);
    const [first, second] = points.award.mock.calls.map((c) => c[0].dedupeKey);
    expect(first).toBe(second); // 同一篇同一天 → 同键，第二次必然 duplicate
  });

  it('genre=null（未标定）→ award 不被调用，awardReason=genre_unset', async () => {
    const { service, points } = makeService({ passage: { ...PASSAGE, genre: null } });
    const res = await service.judgeInterpretation({ studentId: 7, passageId: 12, sentenceIndex: 0, ...ANS });
    expect(points.award).not.toHaveBeenCalled();
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBe('genre_unset');
    // 判题本身不受体裁未标定影响
    expect(res.terms).toEqual([
      { term: '谪守', correct: false, method: 'unanswered', standard: '因罪贬谪流放，出任外官', comment: null },
    ]);
  });

  it('award 抛错 → 判题照常返回（含 fullTranslation），pointsAwarded=0', async () => {
    const { service } = makeService({ awardThrows: new Error('db down') });
    const res = await service.judgeInterpretation({
      studentId: 7, passageId: 12, sentenceIndex: 1, terms: [], translation: '',
    });
    expect(res.fullTranslation).toBe(PASSAGE.full_translation);
    expect(res.allCorrect).toBe(false);
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBeUndefined();
  });

  it('award 回 daily_limit → pointsAwarded=0 + awardReason 透传', async () => {
    const { service } = makeService({ award: { pointsAwarded: 0, reason: 'daily_limit' } });
    const res = await service.judgeInterpretation({ studentId: 7, passageId: 12, sentenceIndex: 0, ...ANS });
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBe('daily_limit');
  });

  it('award 回 duplicate（同日重判同一篇）→ 归 0 且静默，不弹假「+N 分」', async () => {
    const { service } = makeService({ award: { pointsAwarded: 3, reason: 'duplicate' } });
    const res = await service.judgeInterpretation({ studentId: 7, passageId: 12, sentenceIndex: 0, ...ANS });
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBeUndefined();
  });
});
