import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * 判题服务会按 `posted_file.url` 读 `UPLOAD_DIR` 下的图片转 base64；测试不碰真实磁盘。
 * `readFile` 的返回值就是「文件字节」，用例按需断言 data URL。
 */
const fsMock = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', () => fsMock);

import { Logger } from '@nestjs/common';
import { FreeformJudgeService, type FreeformJudgeEvent } from './freeform-judge.service.js';
import type { FreeformJudgeDto } from './dto/freeform.dto.js';

const baseDto = (over: Partial<FreeformJudgeDto> = {}): FreeformJudgeDto => ({
  subjectId: 1,
  maxScore: 10,
  questionContent: '已知 x+1=2',
  answer: 'x=1',
  ...over,
});

function REPORT_WITH_JSON(total: number, max: number, questionOver: Record<string, unknown> = {}) {
  const json = {
    verdict: total >= max ? 'correct' : total <= 0 ? 'incorrect' : 'partial',
    totalScore: total,
    maxScore: max,
    steps: [],
    suggestions: [],
    question: {
      type: 'short_answer',
      difficulty: 1,
      options: null,
      answer: 'x=1',
      explanation: '移项',
      approach: null,
      ...questionOver,
    },
  };
  return `## 判题结果\n\n**得分：${total} / ${max}**\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}

/** 只有 JSON 块、没有报告正文（用来验证清洗为空时回落到原始 content）。 */
function JSON_ONLY(total: number, max: number) {
  const report = REPORT_WITH_JSON(total, max);
  return report.slice(report.indexOf('```json'));
}

/**
 * 只放服务真正注入的 7 个 dep：服务根本没有 PointsService / MasteryService /
 * PracticeResultsRepository，「不发分 / 不写练习 / 不更新掌握度」是结构性的。
 */
const mkDeps = (over: any = {}) => ({
  capability: { stream: vi.fn(), extractStructured: vi.fn() },
  questions: {
    findById: vi.fn().mockResolvedValue({ id: 1, source: 'freeform' }),
    findByContentHash: vi.fn().mockResolvedValue(null),
    findByContentPrefix: vi.fn().mockResolvedValue([]),
    createFreeform: vi.fn().mockResolvedValue(11),
    updateFreeform: vi.fn().mockResolvedValue(undefined),
  },
  errorBooks: {
    findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(22),
    updateDialogueId: vi.fn().mockResolvedValue(undefined),
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(1),
  },
  dialogues: { updateQuestionId: vi.fn().mockResolvedValue(undefined) },
  messages: { create: vi.fn().mockResolvedValue(1) },
  files: { findByIdAndOwner: vi.fn(), findByUrlAndOwner: vi.fn() },
  conversations: {
    get: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: 33, scene: 'aux_freeform' }),
  },
  ...over,
});

const mkService = (deps: ReturnType<typeof mkDeps>) =>
  new FreeformJudgeService(
    deps.capability as any,
    deps.questions as any,
    deps.errorBooks as any,
    deps.dialogues as any,
    deps.messages as any,
    deps.files as any,
    deps.conversations as any,
  );

const streamOnce = (report: string) =>
  vi.fn().mockImplementation(async function* () {
    yield { type: 'content', delta: report };
  });

const streamReasoningThenContent = (reasoning: string, report: string) =>
  vi.fn().mockImplementation(async function* () {
    yield { type: 'reasoning', delta: reasoning };
    yield { type: 'content', delta: report };
  });

async function collect(it: AsyncIterable<FreeformJudgeEvent>): Promise<FreeformJudgeEvent[]> {
  const out: FreeformJudgeEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeAll(() => {
  process.env.UPLOAD_DIR = '/tmp/u';
});

beforeEach(() => {
  process.env.UPLOAD_DIR = '/tmp/u';
  fsMock.readFile.mockReset();
  fsMock.readFile.mockResolvedValue(Buffer.from('x'));
  // 失败路径（5000 / 5502）会打 Logger 日志，测试输出保持干净。
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FreeformJudgeService —— 落库口径', () => {
  it('不满分：写题 + 写错题本；不发分 / 不写 practice（结构性：没有这些依赖）', async () => {
    const deps = mkDeps({ capability: { stream: streamOnce(REPORT_WITH_JSON(7, 10)), extractStructured: vi.fn() } });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    // 题目按 freeform 口径写：full_score = 学生选的满分，source 固定，不带 KP 行。
    expect(deps.questions.createFreeform).toHaveBeenCalledTimes(1);
    expect(deps.questions.createFreeform).toHaveBeenCalledWith(
      expect.objectContaining({
        subject_id: 1,
        full_score: 10,
        content: '已知 x+1=2',
        answer: 'x=1',
        source: 'freeform',
      }),
    );
    // 不满分 → 查未清行 → 没有则建一条 freeform 错题，并把对话 id 补写回去。
    expect(deps.errorBooks.findUnclearedByStudentQuestionId).toHaveBeenCalledWith(9, 11);
    expect(deps.errorBooks.create).toHaveBeenCalledWith(
      expect.objectContaining({ student_id: 9, subject_id: 1, question_id: 11, source: 'freeform' }),
    );
    expect(deps.errorBooks.updateDialogueId).toHaveBeenCalledWith(22, 33);
    expect(deps.errorBooks.clearUnclearedByStudentQuestionId).not.toHaveBeenCalled();

    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({
      type: 'result',
      questionId: 11,
      totalScore: 7,
      maxScore: 10,
      verdict: 'partial',
      errorBookId: 22,
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    // 结构性证据：构造参数只有这 7 个，没有 points / mastery / practice。
    expect(FreeformJudgeService.length).toBe(7);
  });

  it('满分：清零未清错题，不建错题行', async () => {
    const deps = mkDeps({ capability: { stream: streamOnce(REPORT_WITH_JSON(10, 10)), extractStructured: vi.fn() } });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream({ ...baseDto(), questionId: 5 }, 9));

    expect(deps.errorBooks.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(9, 5);
    expect(deps.errorBooks.create).not.toHaveBeenCalled();
    expect(deps.errorBooks.findUnclearedByStudentQuestionId).not.toHaveBeenCalled();

    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ questionId: 5, totalScore: 10, verdict: 'correct' });
    expect(result).not.toHaveProperty('errorBookId');
  });

  it('已有未清零错题行：复用，不重复建行', async () => {
    const deps = mkDeps({
      capability: { stream: streamOnce(REPORT_WITH_JSON(0, 10)), extractStructured: vi.fn() },
      errorBooks: {
        findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue({ id: 77 }),
        create: vi.fn(),
        updateDialogueId: vi.fn().mockResolvedValue(undefined),
        clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(0),
      },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    expect(deps.errorBooks.create).not.toHaveBeenCalled();
    // 复用行不回写 dialogue_id（只在新建成错题行时补）。
    expect(deps.errorBooks.updateDialogueId).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'result')).toMatchObject({ errorBookId: 77, verdict: 'incorrect' });
  });

  it('已传 questionId 且 source=freeform：更新同一行，不新建', async () => {
    const deps = mkDeps({ capability: { stream: streamOnce(REPORT_WITH_JSON(7, 10)), extractStructured: vi.fn() } });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream({ ...baseDto(), questionId: 5 }, 9));

    expect(deps.questions.updateFreeform).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ full_score: 10, answer: 'x=1' }),
    );
    expect(deps.questions.createFreeform).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'result')).toMatchObject({ questionId: 5 });
  });

  it('已传 questionId 但 source 不是 freeform：只复用、绝不改题', async () => {
    const deps = mkDeps({
      capability: { stream: streamOnce(REPORT_WITH_JSON(7, 10)), extractStructured: vi.fn() },
      questions: {
        findById: vi.fn().mockResolvedValue({ id: 5, source: 'textbook' }),
        findByContentHash: vi.fn(),
        findByContentPrefix: vi.fn(),
        createFreeform: vi.fn(),
        updateFreeform: vi.fn(),
      },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream({ ...baseDto(), questionId: 5 }, 9));

    expect(deps.questions.updateFreeform).not.toHaveBeenCalled();
    expect(deps.questions.createFreeform).not.toHaveBeenCalled();
    // 错题本仍按这道题锚（复用真实题库题）。
    expect(deps.errorBooks.findUnclearedByStudentQuestionId).toHaveBeenCalledWith(9, 5);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ questionId: 5 });
  });

  it('未传 questionId：先按 hash 去重，命中则复用', async () => {
    const deps = mkDeps({
      capability: { stream: streamOnce(REPORT_WITH_JSON(7, 10)), extractStructured: vi.fn() },
      questions: {
        findById: vi.fn(),
        findByContentHash: vi.fn().mockResolvedValue({ id: 88, source: 'freeform' }),
        findByContentPrefix: vi.fn().mockResolvedValue([]),
        createFreeform: vi.fn(),
        updateFreeform: vi.fn(),
      },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    expect(deps.questions.createFreeform).not.toHaveBeenCalled();
    expect(deps.questions.updateFreeform).not.toHaveBeenCalled();
    expect(deps.errorBooks.findUnclearedByStudentQuestionId).toHaveBeenCalledWith(9, 88);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ questionId: 88 });
  });

  it('题库 / 错题本写失败 → error 5000（可重试），不发 result、不写消息', async () => {
    const deps = mkDeps({
      capability: { stream: streamOnce(REPORT_WITH_JSON(7, 10)), extractStructured: vi.fn() },
      questions: {
        findById: vi.fn(),
        findByContentHash: vi.fn().mockResolvedValue(null),
        findByContentPrefix: vi.fn().mockResolvedValue([]),
        createFreeform: vi.fn().mockRejectedValue(new Error('db down')),
        updateFreeform: vi.fn(),
      },
      errorBooks: {
        findUnclearedByStudentQuestionId: vi.fn(),
        create: vi.fn(),
        updateDialogueId: vi.fn(),
        clearUnclearedByStudentQuestionId: vi.fn(),
      },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    expect(events.some((e) => e.type === 'error' && e.code === 5000 && e.retryable)).toBe(true);
    expect(events.some((e) => e.type === 'result')).toBe(false);
    expect(deps.messages.create).not.toHaveBeenCalled();
  });
});

describe('FreeformJudgeService —— 解析与报告清洗', () => {
  it('JSON 坏 + 二次提取仍失败 → error 5502；不写题/错题本/判题消息（会话仍按 spec 先建好）', async () => {
    const deps = mkDeps({
      capability: {
        stream: streamOnce('没有 json'),
        extractStructured: vi.fn().mockResolvedValue(null),
      },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    expect(deps.capability.extractStructured).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'error' && e.code === 5502 && e.retryable)).toBe(true);
    expect(events.some((e) => e.type === 'result')).toBe(false);
    // 会话在解析之前就建好了（spec 处理步骤：先建会话，带上题干锚），所以这里**是**有写入的。
    expect(deps.conversations.create).toHaveBeenCalledTimes(1);
    expect(deps.questions.createFreeform).not.toHaveBeenCalled();
    expect(deps.questions.updateFreeform).not.toHaveBeenCalled();
    expect(deps.errorBooks.create).not.toHaveBeenCalled();
    expect(deps.errorBooks.clearUnclearedByStudentQuestionId).not.toHaveBeenCalled();
    expect(deps.dialogues.updateQuestionId).not.toHaveBeenCalled();
    expect(deps.messages.create).not.toHaveBeenCalled();
  });

  it('JSON 坏但二次提取成功 → 正常落库', async () => {
    const deps = mkDeps({
      capability: {
        stream: streamOnce('## 判题结果\n\n得分 7/10'),
        extractStructured: vi.fn().mockResolvedValue({
          verdict: 'partial', totalScore: 7, maxScore: 10, steps: [], suggestions: [],
          question: { type: 'short_answer', difficulty: 1, options: null, answer: 'x=1', explanation: null, approach: null },
        }),
      },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    expect(deps.questions.createFreeform).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ totalScore: 7, verdict: 'partial' });
  });

  it('报告清洗：去掉尾部 JSON 块后发 replace 事件', async () => {
    const deps = mkDeps({ capability: { stream: streamOnce(REPORT_WITH_JSON(7, 10)), extractStructured: vi.fn() } });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    const cleaned = events.find(
      (e) => e.type === 'content' && (e as { replace?: boolean }).replace === true,
    ) as { type: 'content'; delta: string } | undefined;
    expect(cleaned).toBeDefined();
    expect(cleaned!.delta).toBe('## 判题结果\n\n**得分：7 / 10**');
    expect(cleaned!.delta).not.toContain('```json');
    // assistant 消息存的是清洗后的报告 + 完整思考过程。
    expect(deps.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', type: 'freeform_judge', content: cleaned!.delta, model: 'qwen3.8-max' }),
    );
  });

  it('清洗后为空（正文只有 JSON 块）→ 回落到原始 content，别把气泡清空', async () => {
    const raw = JSON_ONLY(7, 10);
    const deps = mkDeps({ capability: { stream: streamOnce(raw), extractStructured: vi.fn() } });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    const cleaned = events.find(
      (e) => e.type === 'content' && (e as { replace?: boolean }).replace === true,
    ) as { delta: string } | undefined;
    expect(cleaned!.delta).toBe(raw);
    expect(deps.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', type: 'freeform_judge', content: raw }),
    );
    expect(events.find((e) => e.type === 'result')).toMatchObject({ totalScore: 7 });
  });

  it('多个 JSON 块：只用最后一块判分', async () => {
    const report = `${REPORT_WITH_JSON(0, 10)}\n\n补充说明\n\n${REPORT_WITH_JSON(7, 10)}`;
    const deps = mkDeps({ capability: { stream: streamOnce(report), extractStructured: vi.fn() } });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    expect(events.find((e) => e.type === 'result')).toMatchObject({ totalScore: 7, verdict: 'partial' });
    expect(deps.capability.extractStructured).not.toHaveBeenCalled();
  });

  it('模型给了集合外的 type / difficulty → 规范化成 short_answer / 2，不整份判失败', async () => {
    const deps = mkDeps({
      capability: { stream: streamOnce(REPORT_WITH_JSON(7, 10, { type: 'essay', difficulty: 9 })), extractStructured: vi.fn() },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    expect(deps.capability.extractStructured).not.toHaveBeenCalled();
    expect(deps.questions.createFreeform).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'short_answer', difficulty: 2 }),
    );
    expect(events.find((e) => e.type === 'result')).toMatchObject({ totalScore: 7 });
  });

  it('模型调用失败 → error 5502（可重试），不写库', async () => {
    const deps = mkDeps({
      capability: {
        stream: vi.fn().mockImplementation(async function* () {
          throw new Error('upstream 502');
        }),
        extractStructured: vi.fn(),
      },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    expect(events.some((e) => e.type === 'error' && e.code === 5502 && e.retryable)).toBe(true);
    expect(deps.questions.createFreeform).not.toHaveBeenCalled();
  });

  it('reasoning / content 增量原样转发，start 带 dialogueId', async () => {
    const deps = mkDeps({
      capability: { stream: streamReasoningThenContent('先移项', REPORT_WITH_JSON(10, 10)), extractStructured: vi.fn() },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream({ ...baseDto(), questionId: 5 }, 9));

    expect(events[0]).toEqual({ type: 'start', dialogueId: '33', questionId: 5 });
    expect(events).toContainEqual({ type: 'reasoning', delta: '先移项' });
    expect(events).toContainEqual({ type: 'content', delta: REPORT_WITH_JSON(10, 10) });
    expect(deps.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'freeform_judge', reasoning: '先移项' }),
    );
  });
});

describe('FreeformJudgeService —— 对话', () => {
  it('无 dialogueId：建 aux_freeform 会话（带题干锚），两条消息写进该会话', async () => {
    const deps = mkDeps({ capability: { stream: streamOnce(REPORT_WITH_JSON(7, 10)), extractStructured: vi.fn() } });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream(baseDto(), 9));

    expect(deps.conversations.create).toHaveBeenCalledWith(9, {
      track: 'auxiliary',
      scene: 'aux_freeform',
      subjectId: 1,
      questionText: '已知 x+1=2',
      title: '做题 · 已知 x+1=2',
    });
    expect(events[0]).toMatchObject({ type: 'start', dialogueId: '33' });

    const calls = deps.messages.create.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      dialogue_id: 33,
      role: 'user',
      type: 'freeform_submit',
      content: '题目：\n已知 x+1=2\n\n我的作答：\nx=1',
    });
    expect(calls[1]).toMatchObject({ dialogue_id: 33, role: 'assistant', type: 'freeform_judge' });

    // question_id 回填给对话（仓库内部只在 NULL 时写）。
    expect(deps.dialogues.updateQuestionId).toHaveBeenCalledWith(33, 11);
  });

  it('传 dialogueId：校验归属与场景，复用该会话', async () => {
    const deps = mkDeps({
      capability: { stream: streamOnce(REPORT_WITH_JSON(7, 10)), extractStructured: vi.fn() },
      conversations: {
        get: vi.fn().mockResolvedValue({ id: 44, scene: 'aux_freeform', student_id: 9 }),
        create: vi.fn(),
      },
    });
    const svc = mkService(deps);

    const events = await collect(svc.judgeStream({ ...baseDto(), dialogueId: '44' }, 9));

    expect(deps.conversations.get).toHaveBeenCalledWith(44, 9);
    expect(deps.conversations.create).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: 'start', dialogueId: '44' });
    expect(deps.messages.create.mock.calls[0][0]).toMatchObject({ dialogue_id: 44 });
  });

  it('传的 dialogueId 场景不是 aux_freeform → 400/1001，不调模型', async () => {
    const deps = mkDeps({
      conversations: {
        get: vi.fn().mockResolvedValue({ id: 44, scene: 'aux_qna' }),
        create: vi.fn(),
      },
    });
    const svc = mkService(deps);

    await expect(collect(svc.judgeStream({ ...baseDto(), dialogueId: '44' }, 9))).rejects.toMatchObject({
      response: { code: 1001 },
    });
    expect(deps.capability.stream).not.toHaveBeenCalled();
  });
});

describe('FreeformJudgeService —— 参数校验', () => {
  it.each([
    ['学科非 1/4/5', { subjectId: 2 }],
    ['满分非整数', { maxScore: 7.5 }],
    ['满分 < 1', { maxScore: 0 }],
    ['满分 > 100', { maxScore: 101 }],
    ['题干为空', { questionContent: '   ' }],
    ['题干超 30000 字', { questionContent: 'a'.repeat(30001) }],
    ['作答超 30000 字', { answer: 'a'.repeat(30001) }],
    ['无作答且无草稿', { answer: '   ' }],
    ['题干非字符串', { questionContent: 123 }],
    ['作答非字符串', { answer: 123 }],
    ['题图非数组', { questionImages: 'x' }],
    ['配图非数组', { figureUrls: '/uploads/freeform/x.jpg' }],
    ['题图超过 6 张', { questionImages: Array.from({ length: 7 }, () => ({ type: 'image', fileId: '1' })) }],
    ['配图超过 6 张', { figureUrls: Array.from({ length: 7 }, (_, i) => `/uploads/freeform/x/${i}.jpg`) }],
  ])('%s → 400/1001', async (_label, over) => {
    const deps = mkDeps();
    const svc = mkService(deps);

    await expect(collect(svc.judgeStream(baseDto(over as any), 9))).rejects.toMatchObject({
      response: { code: 1001 },
    });
    expect(deps.capability.stream).not.toHaveBeenCalled();
    expect(deps.conversations.create).not.toHaveBeenCalled();
  });

  it('questionId 不存在 → 400/1001', async () => {
    const deps = mkDeps({
      questions: {
        findById: vi.fn().mockResolvedValue(null),
        findByContentHash: vi.fn(),
        findByContentPrefix: vi.fn(),
        createFreeform: vi.fn(),
        updateFreeform: vi.fn(),
      },
    });
    const svc = mkService(deps);

    await expect(collect(svc.judgeStream({ ...baseDto(), questionId: 404 }, 9))).rejects.toMatchObject({
      response: { code: 1001 },
    });
    expect(deps.capability.stream).not.toHaveBeenCalled();
  });
});

describe('FreeformJudgeService —— 图片解析', () => {
  const JPEG = { url: '/uploads/a.jpg', mime_type: 'image/jpeg', size_bytes: 10 };

  it('原题图 / 配图 / 草稿 / 作答内嵌图都转成 data URL 并按序打标签', async () => {
    const deps = mkDeps({
      capability: { stream: streamOnce(REPORT_WITH_JSON(10, 10)), extractStructured: vi.fn() },
      files: {
        findByIdAndOwner: vi.fn().mockImplementation(async (id: number) => {
          if (id === 1) return JPEG;
          if (id === 2) return { url: '/uploads/draft.jpg', mime_type: 'image/jpeg', size_bytes: 10 };
          return null;
        }),
        findByUrlAndOwner: vi.fn().mockImplementation(async (url: string) => ({
          url,
          mime_type: 'image/png',
          size_bytes: 10,
        })),
      },
    });
    const svc = mkService(deps);

    await collect(
      svc.judgeStream(
        {
          ...baseDto(),
          questionId: 5,
          questionImages: [{ type: 'image', fileId: '1' }],
          figureUrls: ['/uploads/freeform/x/fig-1-a.jpg'],
          draftFileId: '2',
          answer: '如图\n\n![x](/uploads/answer.png)',
        },
        9,
      ),
    );

    const images = deps.capability.stream.mock.calls[0][0].images;
    expect(images.map((i: any) => i.label)).toEqual(['原题图1', '配图1', '学生草稿', '作答图1']);
    expect(images[0].dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('x').toString('base64')}`);
    expect(deps.files.findByUrlAndOwner).toHaveBeenCalledWith('/uploads/freeform/x/fig-1-a.jpg', 9);
    expect(deps.files.findByUrlAndOwner).toHaveBeenCalledWith('/uploads/answer.png', 9);
    // 读文件一律在 UPLOAD_DIR 下。
    expect(fsMock.readFile).toHaveBeenCalledWith('/tmp/u/a.jpg');
    expect(fsMock.readFile).toHaveBeenCalledWith('/tmp/u/draft.jpg');
    expect(fsMock.readFile).toHaveBeenCalledWith('/tmp/u/answer.png');

    // user 消息的 attachments 是这些图的 URL（不是 base64）。
    expect(deps.messages.create.mock.calls[0][0].attachments).toBe(
      JSON.stringify(
        images.map((i: any) => ({ type: 'image', url: i.url })),
      ),
    );
  });

  it('fileId 不存在 / 非本人 → 400/1001，不开始判题', async () => {
    const deps = mkDeps({
      files: { findByIdAndOwner: vi.fn().mockResolvedValue(null), findByUrlAndOwner: vi.fn() },
    });
    const svc = mkService(deps);

    await expect(
      collect(svc.judgeStream({ ...baseDto(), questionImages: [{ type: 'image', fileId: '7' }] }, 9)),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    expect(deps.capability.stream).not.toHaveBeenCalled();
  });

  it('figureUrls 找不到归属 → 400/1001（勾选配图必须存在且属于本人）', async () => {
    const deps = mkDeps({
      files: { findByIdAndOwner: vi.fn(), findByUrlAndOwner: vi.fn().mockResolvedValue(null) },
    });
    const svc = mkService(deps);

    await expect(
      collect(svc.judgeStream({ ...baseDto(), figureUrls: ['/uploads/freeform/x/gone.jpg'] }, 9)),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    expect(deps.capability.stream).not.toHaveBeenCalled();
  });

  it('figureUrls 不是 /uploads/freeform/ 前缀 → 400/1001，不查库不读文件', async () => {
    const deps = mkDeps({
      files: { findByIdAndOwner: vi.fn(), findByUrlAndOwner: vi.fn().mockResolvedValue(JPEG) },
    });
    const svc = mkService(deps);

    await expect(
      collect(svc.judgeStream({ ...baseDto(), figureUrls: ['/uploads/a.jpg'] }, 9)),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    expect(deps.files.findByUrlAndOwner).not.toHaveBeenCalled();
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(deps.capability.stream).not.toHaveBeenCalled();
  });

  it('配图非法（作答目录下的图）→ 400/1001，且不建会话（先解析图片再建会话）', async () => {
    const deps = mkDeps({
      files: { findByIdAndOwner: vi.fn(), findByUrlAndOwner: vi.fn().mockResolvedValue(JPEG) },
    });
    const svc = mkService(deps);

    await expect(
      collect(svc.judgeStream({ ...baseDto(), figureUrls: ['/uploads/answer/x.png'] }, 9)),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    // 图片校验失败必须在会话落库之前中止：不留下空的 ai_dialogues 行 + 题干锚。
    expect(deps.conversations.create).not.toHaveBeenCalled();
    expect(deps.conversations.get).not.toHaveBeenCalled();
    expect(deps.files.findByUrlAndOwner).not.toHaveBeenCalled();
    expect(deps.capability.stream).not.toHaveBeenCalled();
  });

  it('单张图 >5MB → 400/1001（上传 20MB 不能直接变 base64 撑爆 prompt）', async () => {
    const deps = mkDeps({
      files: {
        findByIdAndOwner: vi.fn().mockResolvedValue({ ...JPEG, size_bytes: 5 * 1024 * 1024 + 1 }),
        findByUrlAndOwner: vi.fn(),
      },
    });
    const svc = mkService(deps);

    await expect(
      collect(svc.judgeStream({ ...baseDto(), questionImages: [{ type: 'image', fileId: '1' }] }, 9)),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(deps.capability.stream).not.toHaveBeenCalled();
  });

  it('非图片 MIME → 400/1001', async () => {
    const deps = mkDeps({
      files: {
        findByIdAndOwner: vi.fn().mockResolvedValue({ url: '/uploads/a.pdf', mime_type: 'application/pdf', size_bytes: 10 }),
        findByUrlAndOwner: vi.fn(),
      },
    });
    const svc = mkService(deps);

    await expect(
      collect(svc.judgeStream({ ...baseDto(), questionImages: [{ type: 'image', fileId: '1' }] }, 9)),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it('文件 url 解析后越出 UPLOAD_DIR → 400/1001，不读文件', async () => {
    const deps = mkDeps({
      files: {
        findByIdAndOwner: vi.fn().mockResolvedValue({ url: '/uploads/../secret.jpg', mime_type: 'image/jpeg', size_bytes: 10 }),
        findByUrlAndOwner: vi.fn(),
      },
    });
    const svc = mkService(deps);

    await expect(
      collect(svc.judgeStream({ ...baseDto(), questionImages: [{ type: 'image', fileId: '1' }] }, 9)),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });
});
