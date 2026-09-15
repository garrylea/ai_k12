import { describe, it, expect, vi } from 'vitest';
import { TrainingService, CHINESE_SUBJECT_ID, renderBodyDiff } from './training.service';

const PASSAGE = {
  id: 1, question_id: 100, work_title: '静夜思', author: '李白', dynasty: '唐',
  body: '床前明月光，疑是地上霜。', grade_band: 'junior', grade: '九年级',
  semester: '上册', sort_order: 1, source_ref: 'DEV-FIXTURE', verified: 1,
  questionContent: '请默写《静夜思》',
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
  it('只返回篇名 + 册次，不泄露作者/朝代/正文', async () => {
    const { service } = makeService();
    const res = await service.listDictationPassages();
    expect(res.passages).toEqual([
      { questionId: 100, workTitle: '静夜思', semester: '上册' },
    ]);
    expect(JSON.stringify(res)).not.toContain('床前明月光');
    expect(JSON.stringify(res)).not.toContain('李白');
  });
});

describe('TrainingService.startDictation', () => {
  it('未指定篇目 → 随机抽，题项不含答案字段', async () => {
    const { service, dictationRepo } = makeService();
    const res = await service.startDictation({ studentId: 7, semester: '上册', questionIds: null, count: 5 });
    expect(dictationRepo.findRandomVerified).toHaveBeenCalledWith(7, CHINESE_SUBJECT_ID, '上册', 5);
    expect(res.questions).toEqual([
      { questionId: 100, prompt: '请默写《静夜思》', workTitle: '静夜思', semester: '上册' },
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

describe('TrainingService.judgeDictation（判题：纯程序、不等 LLM）', () => {
  it('判错 → 回判题结果 + feedbackPending=true，且**不调用 LLM**', async () => {
    const { service, dictationFeedback } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, questionId: 100, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(false);
    expect(res.feedback).toBeNull();
    expect(res.feedbackPending).toBe(true);
    expect(res.reference).toEqual({ author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' });
    // 解耦的核心断言：判题链路里不能再出现 LLM 调用，否则学生又要等十几秒
    expect(dictationFeedback.generate).not.toHaveBeenCalled();
  });

  it('判对 → feedbackPending=false', async () => {
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
    expect(res.feedbackPending).toBe(false);
    expect(dictationFeedback.generate).not.toHaveBeenCalled();
  });

  it('篇目不存在 → 404', async () => {
    const { service } = makeService({ passage: null });
    await expect(
      service.judgeDictation({ studentId: 7, questionId: 999, author: '', dynasty: '', body: '' }),
    ).rejects.toThrow();
  });
});

describe('TrainingService.generateDictationFeedback（错因：可选、失败降级）', () => {
  it('判错入参 → 返回 LLM 错因', async () => {
    const { service, dictationFeedback } = makeService();
    const res = await service.generateDictationFeedback({
      questionId: 100, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.feedback).toBe('注意「月光」的「光」');
    expect(dictationFeedback.generate).toHaveBeenCalledOnce();
  });

  it('喂给模型的差异文本与错处字段一致（服务端自己重算，不依赖判题接口）', async () => {
    const { service, dictationFeedback } = makeService();
    await service.generateDictationFeedback({
      questionId: 100, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    const arg = dictationFeedback.generate.mock.calls[0][0];
    expect(arg.workTitle).toBe('静夜思');
    expect(arg.fieldMatch).toEqual({ author: true, dynasty: true, body: false });
    expect(arg.bodyDiffText).toBe('床前明月[光→先]，疑是地上霜。');
  });

  it('LLM 两个模型都失败 → feedback=null（不抛错，不阻断前端）', async () => {
    const { service } = makeService({ feedback: new Error('all down') });
    const res = await service.generateDictationFeedback({
      questionId: 100, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.feedback).toBeNull();
  });

  it('篇目不存在 → 404', async () => {
    const { service } = makeService({ passage: null });
    await expect(
      service.generateDictationFeedback({ questionId: 999, author: '', dynasty: '', body: '' }),
    ).rejects.toThrow();
  });
});
