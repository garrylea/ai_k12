import { describe, it, expect, vi } from 'vitest';
import { TrainingService, CHINESE_SUBJECT_ID, renderBodyDiff } from './training.service';

const PASSAGE = {
  id: 1, question_id: 100, work_title: '静夜思', author: '李白', dynasty: '唐',
  body: '床前明月光，疑是地上霜。', grade_band: 'junior', grade: '九年级',
  semester: '上册', sort_order: 1, source_ref: 'DEV-FIXTURE', verified: 1,
  questionContent: '请默写《静夜思》（并写出作者与朝代）',
};

const WRONG_JUDGE = {
  questionId: 100, isCorrect: false, method: 'exact',
  fields: { author: { match: true }, dynasty: { match: true }, body: { match: false } },
  bodyDiff: [{ type: 'wrong', expected: '光', actual: '先' }],
  errorBookId: 555,
};

function makeService(overrides: { passage?: unknown; judgeResult?: unknown; feedback?: unknown } = {}) {
  const dictationRepo = {
    findByQuestionId: vi.fn().mockResolvedValue(overrides.passage === undefined ? PASSAGE : overrides.passage),
    findVerifiedBySubject: vi.fn().mockResolvedValue([PASSAGE]),
    findRandomVerified: vi.fn().mockResolvedValue([PASSAGE]),
    findVerifiedByQuestionIds: vi.fn().mockResolvedValue([PASSAGE]),
  };
  const judgeCore = { judgeDictation: vi.fn().mockResolvedValue(overrides.judgeResult ?? WRONG_JUDGE) };
  const dictationFeedback = {
    generate: vi.fn().mockImplementation(() => {
      if (overrides.feedback instanceof Error) return Promise.reject(overrides.feedback);
      return Promise.resolve({ content: overrides.feedback ?? '注意「月光」的「光」' });
    }),
  };
  const service = new TrainingService(
    {} as never, judgeCore as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
    dictationRepo as never, dictationFeedback as never,
  );
  return { service, dictationRepo, judgeCore, dictationFeedback };
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
  it('只返回白名单字段，不泄露正文', async () => {
    const { service } = makeService();
    const res = await service.listDictationPassages();
    expect(res.passages).toEqual([
      { questionId: 100, workTitle: '静夜思', author: '李白', dynasty: '唐', semester: '上册' },
    ]);
    expect(JSON.stringify(res)).not.toContain('床前明月光');
  });
});

describe('TrainingService.startDictation', () => {
  it('未指定篇目 → 随机抽，题项不含答案字段', async () => {
    const { service, dictationRepo } = makeService();
    const res = await service.startDictation({ studentId: 7, semester: '上册', questionIds: null, count: 5 });
    expect(dictationRepo.findRandomVerified).toHaveBeenCalledWith(7, CHINESE_SUBJECT_ID, '上册', 5);
    expect(res.questions).toEqual([
      { questionId: 100, prompt: '请默写《静夜思》（并写出作者与朝代）', workTitle: '静夜思', semester: '上册' },
    ]);
    expect(JSON.stringify(res)).not.toContain('李白');
    expect(JSON.stringify(res)).not.toContain('床前明月光');
  });

  it('指定篇目 → 走 findVerifiedByQuestionIds，并按 count 截断', async () => {
    const { service, dictationRepo } = makeService();
    const res = await service.startDictation({ studentId: 7, semester: null, questionIds: [100, 101], count: 1 });
    expect(dictationRepo.findVerifiedByQuestionIds).toHaveBeenCalledWith(CHINESE_SUBJECT_ID, [100, 101]);
    expect(res.questions).toHaveLength(1);
  });
});

describe('TrainingService.judgeDictation', () => {
  it('判错 → 附带 LLM 错因与参考答案', async () => {
    const { service, dictationFeedback } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, questionId: 100, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(false);
    expect(res.feedback).toBe('注意「月光」的「光」');
    expect(res.reference).toEqual({ author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' });
    expect(dictationFeedback.generate).toHaveBeenCalledOnce();
  });

  it('判对 → 不调用 LLM，feedback=null', async () => {
    const { service, dictationFeedback } = makeService({
      judgeResult: {
        questionId: 100, isCorrect: true, method: 'exact',
        fields: { author: { match: true }, dynasty: { match: true }, body: { match: true } },
        bodyDiff: [],
      },
    });
    const res = await service.judgeDictation({
      studentId: 7, questionId: 100, author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(true);
    expect(res.feedback).toBeNull();
    expect(dictationFeedback.generate).not.toHaveBeenCalled();
  });

  it('LLM 两个模型都失败 → 不阻断判题，feedback=null', async () => {
    const { service } = makeService({ feedback: new Error('all down') });
    const res = await service.judgeDictation({
      studentId: 7, questionId: 100, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(false);
    expect(res.feedback).toBeNull();
  });

  it('篇目不存在 → 404', async () => {
    const { service } = makeService({ passage: null });
    await expect(
      service.judgeDictation({ studentId: 7, questionId: 999, author: '', dynasty: '', body: '' }),
    ).rejects.toThrow();
  });
});
