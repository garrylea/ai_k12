import { describe, it, expect, vi } from 'vitest';
import { TrainingService, renderBodyDiff } from './training.service';

const PASSAGE = {
  id: 1, work_title: '静夜思', author: '李白', dynasty: '唐',
  body: '床前明月光，疑是地上霜。', grade_band: 'junior', grade: '九年级',
  semester: '上册', sort_order: 1, source_ref: 'DEV-FIXTURE', verified: 1,
  memorize_required: 1, is_active: 1, genre: 'poem',
};

const WRONG_JUDGE = {
  isCorrect: false, method: 'exact',
  fields: { author: { match: true }, dynasty: { match: true }, body: { match: false } },
  bodyDiff: [{ type: 'wrong', expected: '光', actual: '先' }],
};

/** award 干净成功（无 reason）的默认返回。 */
const AWARD_OK = { pointsAwarded: 2, balance: 2, totalEarned: 2, levelUp: null };

function makeService(overrides: {
  passage?: unknown; judgeResult?: unknown; feedback?: unknown;
  award?: unknown; awardThrows?: Error; todayKey?: string;
} = {}) {
  const dictationRepo = {
    findById: vi.fn().mockResolvedValue(overrides.passage === undefined ? PASSAGE : overrides.passage),
    findVerifiedForDictation: vi.fn().mockResolvedValue([PASSAGE]),
    findRandomVerified: vi.fn().mockResolvedValue([PASSAGE]),
    findVerifiedByIds: vi.fn().mockResolvedValue([PASSAGE]),
  };
  const judgeCore = { judgeDictation: vi.fn().mockResolvedValue(overrides.judgeResult ?? WRONG_JUDGE) };
  const dictationFeedback = {
    generate: vi.fn().mockImplementation(() => {
      if (overrides.feedback instanceof Error) return Promise.reject(overrides.feedback);
      return Promise.resolve({ content: overrides.feedback ?? '注意「月光」的「光」' });
    }),
  };
  // 发分依赖（甲类逐目标发分，2026-09-17）：todayKey 是唯一的日期真源，这里钉成定值。
  const points = {
    award: vi.fn().mockImplementation(() => {
      if (overrides.awardThrows) return Promise.reject(overrides.awardThrows);
      return Promise.resolve(overrides.award ?? AWARD_OK);
    }),
    todayKey: vi.fn(() => overrides.todayKey ?? '2026-09-17'),
  };
  const service = new TrainingService(
    {} as never, judgeCore as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
    dictationRepo as never, dictationFeedback as never, {} as never,
    points as never, {} as never,
  );
  return { service, dictationRepo, judgeCore, dictationFeedback, points };
}

describe('renderBodyDiff', () => {
  it('把 diff 渲染成可读文本', () => {
    expect(renderBodyDiff([
      { type: 'equal', text: '床前明月' },
      { type: 'wrong', expected: '光', actual: '先' },
      { type: 'missing', text: '疑' },
      { type: 'extra', text: '啊' },
    ])).toBe('床前明月[光→先][漏:疑][多:啊]');
  });
});

describe('TrainingService.listDictationPassages', () => {
  it('只返回篇名 + 册次，不泄露作者/朝代/正文', async () => {
    const { service } = makeService();
    const res = await service.listDictationPassages();
    expect(res.passages).toEqual([
      { passageId: 1, workTitle: '静夜思', semester: '上册' },
    ]);
    expect(JSON.stringify(res)).not.toContain('床前明月光');
    expect(JSON.stringify(res)).not.toContain('李白');
  });
});

describe('TrainingService.startDictation', () => {
  it('未指定篇目 → 随机抽，题项不含答案字段；题面由篇名生成', async () => {
    const { service, dictationRepo } = makeService();
    const res = await service.startDictation({ semester: '上册', passageIds: null, count: 5 });
    expect(dictationRepo.findRandomVerified).toHaveBeenCalledWith('上册', 5);
    expect(res.questions).toEqual([
      { passageId: 1, prompt: '请默写《静夜思》', workTitle: '静夜思', semester: '上册' },
    ]);
    expect(JSON.stringify(res)).not.toContain('李白');
    expect(JSON.stringify(res)).not.toContain('床前明月光');
  });

  it('指定篇目 → 走 findVerifiedByIds，并按 count 截断', async () => {
    const { service, dictationRepo } = makeService();
    const res = await service.startDictation({ semester: null, passageIds: [1, 2], count: 1 });
    expect(dictationRepo.findVerifiedByIds).toHaveBeenCalledWith([1, 2]);
    expect(res.questions).toHaveLength(1);
  });
});

describe('TrainingService.judgeDictation（判题：纯程序、不等 LLM、不写学生状态）', () => {
  it('判错 → 回判题结果 + feedbackPending=true，且**不调用 LLM**', async () => {
    const { service, dictationFeedback } = makeService();
    const res = await service.judgeDictation({
      studentId: 1, passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(false);
    expect(res.feedback).toBeNull();
    expect(res.feedbackPending).toBe(true);
    expect(res.passageId).toBe(1);
    expect(res.reference).toEqual({ author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' });
    // 解耦的核心断言：判题链路里不能再出现 LLM 调用，否则学生又要等十几秒
    expect(dictationFeedback.generate).not.toHaveBeenCalled();
  });

  it('判对 → feedbackPending=false', async () => {
    const { service, dictationFeedback } = makeService({
      judgeResult: {
        isCorrect: true, method: 'exact',
        fields: { author: { match: true }, dynasty: { match: true }, body: { match: true } },
        bodyDiff: [],
      },
    });
    const res = await service.judgeDictation({
      studentId: 1, passageId: 1, author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(true);
    expect(res.feedback).toBeNull();
    expect(res.feedbackPending).toBe(false);
    expect(dictationFeedback.generate).not.toHaveBeenCalled();
  });

  // 独立化：判定路径只给「纯函数 + 篇目」两样东西，学生身份不再进入判题
  it('只把 expected/student 交给 judgeCore，不透传学生身份/学科/错题本相关字段', async () => {
    const { service, judgeCore } = makeService();
    await service.judgeDictation({ studentId: 1, passageId: 1, author: '李', dynasty: '唐', body: '床' });
    expect(judgeCore.judgeDictation).toHaveBeenCalledWith({
      expected: { author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' },
      student: { author: '李', dynasty: '唐', body: '床' },
    });
  });

  it('篇目不存在 → 404', async () => {
    const { service } = makeService({ passage: null });
    await expect(
      service.judgeDictation({ studentId: 1, passageId: 999, author: '', dynasty: '', body: '' }),
    ).rejects.toThrow();
  });
});

describe('TrainingService.judgeDictation — 甲类发分（cn_dictation，按体裁取档）', () => {
  const ANS = { author: '', dynasty: '', body: '' };

  it('genre=poem → 按 poem 档发一次，幂等键含 todayKey()，响应带 pointsAwarded', async () => {
    const { service, points } = makeService(); // PASSAGE.genre === 'poem'
    const res = await service.judgeDictation({ studentId: 7, passageId: 1, ...ANS });
    expect(points.todayKey).toHaveBeenCalled();
    expect(points.award).toHaveBeenCalledTimes(1);
    expect(points.award).toHaveBeenCalledWith({
      studentId: 7,
      taskCode: 'cn_dictation',
      tierKey: 'poem',
      dedupeKey: 'dict:7:1:2026-09-17',
      refType: 'passage',
      refId: 1,
    });
    expect(res.pointsAwarded).toBe(2);
    expect(res.awardReason).toBeUndefined();
  });

  it('genre=prose → tierKey=prose', async () => {
    const { service, points } = makeService({ passage: { ...PASSAGE, genre: 'prose' } });
    await service.judgeDictation({ studentId: 3, passageId: 1, ...ANS });
    expect(points.award).toHaveBeenCalledWith(
      expect.objectContaining({ tierKey: 'prose', dedupeKey: 'dict:3:1:2026-09-17' }),
    );
  });

  it('判错也发分（完成即给，不看对错）—— 默认 WRONG_JUDGE 即判错', async () => {
    const { service, points } = makeService();
    const res = await service.judgeDictation({ studentId: 7, passageId: 1, ...ANS });
    expect(res.isCorrect).toBe(false);
    expect(points.award).toHaveBeenCalledTimes(1);
    expect(res.pointsAwarded).toBe(2);
  });

  it('genre=null（未标定）→ award 不被调用，awardReason=genre_unset', async () => {
    const { service, points } = makeService({ passage: { ...PASSAGE, genre: null } });
    const res = await service.judgeDictation({ studentId: 7, passageId: 1, ...ANS });
    expect(points.award).not.toHaveBeenCalled();
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBe('genre_unset');
    // 判题本身不受体裁未标定影响
    expect(res.isCorrect).toBe(false);
  });

  it('genre 是其它脏值（如 "ci"）→ 同样按未标定处理，不猜体裁', async () => {
    const { service, points } = makeService({ passage: { ...PASSAGE, genre: 'ci' } });
    const res = await service.judgeDictation({ studentId: 7, passageId: 1, ...ANS });
    expect(points.award).not.toHaveBeenCalled();
    expect(res.awardReason).toBe('genre_unset');
  });

  it('award 抛错 → 判题结果照常返回，pointsAwarded=0', async () => {
    const { service } = makeService({ awardThrows: new Error('db down') });
    const res = await service.judgeDictation({
      studentId: 7, passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先',
    });
    expect(res.isCorrect).toBe(false);
    expect(res.feedbackPending).toBe(true);
    expect(res.reference).toEqual({ author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' });
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBeUndefined();
  });

  it('award 回 daily_limit → pointsAwarded=0 + awardReason 透传', async () => {
    const { service } = makeService({ award: { pointsAwarded: 0, reason: 'daily_limit' } });
    const res = await service.judgeDictation({ studentId: 7, passageId: 1, ...ANS });
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBe('daily_limit');
  });

  it('award 回 duplicate（同日重判同一篇）→ 归 0 且静默，不弹假「+N 分」', async () => {
    // PointsService.award 幂等命中时会带回**首次**分值；直接透传就是历史账（Task 10 Finding C1）
    const { service } = makeService({ award: { pointsAwarded: 2, reason: 'duplicate' } });
    const res = await service.judgeDictation({ studentId: 7, passageId: 1, ...ANS });
    expect(res.pointsAwarded).toBe(0);
    expect(res.awardReason).toBeUndefined();
  });
});

describe('TrainingService.generateDictationFeedback（错因：可选、失败降级）', () => {
  it('判错入参 → 返回 LLM 错因', async () => {
    const { service, dictationFeedback } = makeService();
    const res = await service.generateDictationFeedback({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.feedback).toBe('注意「月光」的「光」');
    expect(dictationFeedback.generate).toHaveBeenCalledOnce();
  });

  it('喂给模型的差异文本与错处字段一致（服务端自己重算，不依赖判题接口）', async () => {
    const { service, dictationFeedback } = makeService();
    await service.generateDictationFeedback({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    const arg = dictationFeedback.generate.mock.calls[0][0];
    expect(arg.workTitle).toBe('静夜思');
    expect(arg.fieldMatch).toEqual({ author: true, dynasty: true, body: false });
    expect(arg.bodyDiffText).toBe('床前明月[光→先]，疑是地上霜。');
  });

  it('LLM 两个模型都失败 → feedback=null（不抛错，不阻断前端）', async () => {
    const { service } = makeService({ feedback: new Error('all down') });
    const res = await service.generateDictationFeedback({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.feedback).toBeNull();
  });

  it('篇目不存在 → 404', async () => {
    const { service } = makeService({ passage: null });
    await expect(
      service.generateDictationFeedback({ passageId: 999, author: '', dynasty: '', body: '' }),
    ).rejects.toThrow();
  });
});
