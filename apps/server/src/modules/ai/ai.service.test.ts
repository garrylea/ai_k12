import { describe, it, expect, vi } from 'vitest';
import { AIService } from './ai.service.js';

const DIALOGUE_ID = '7';
const HISTORY_2_TURNS = [
  { role: 'user', content: '这题怎么做' },
  { role: 'assistant', content: '先看已知条件' },
  { role: 'user', content: '还是不会' },
  { role: 'assistant', content: '再想想' },
];

function mkDeps(over: any = {}) {
  const base = {
    tutoring: {
      tutor: vi.fn(),
      tutorStream: vi.fn(),
      generateTitle: vi.fn().mockResolvedValue(null),
    },
    conversationsService: {
      get: vi.fn().mockResolvedValue({ id: 7, student_id: 7, title: '辅线答疑', question_id: 42 }),
      getMessages: vi.fn().mockResolvedValue(HISTORY_2_TURNS),
    },
    conversationService: {
      saveMessages: vi.fn().mockResolvedValue(undefined),
      updateFailCount: vi.fn().mockResolvedValue(undefined),
      completeDialogue: vi.fn().mockResolvedValue(undefined),
    },
    dialoguesRepo: { updateQuestionId: vi.fn().mockResolvedValue(undefined) },
    mainErrorRepo: {
      existsByStudentAndQuestionId: vi.fn().mockResolvedValue(false),
      create: vi.fn().mockResolvedValue(1),
      updateDialogueId: vi.fn().mockResolvedValue(undefined),
    },
    filesRepo: {},
    subjectsRepo: { findByCode: vi.fn().mockResolvedValue({ id: 1 }) },
    questionsRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 42, answer: '223 元', approach: '按性价比枚举 0/1/2 包', explanation: '第二问是有界背包，枚举比较。',
      }),
      findByContentHash: vi.fn().mockResolvedValue(null),
      findByContentPrefix: vi.fn().mockResolvedValue([]),
      findOrCreate: vi.fn().mockResolvedValue({ id: 42, created: false }),
    },
    extractTasksRepo: {},
  };
  return { ...base, ...over };
}

function mkService(d: any) {
  return new AIService(
    d.tutoring, d.conversationsService, d.conversationService, d.dialoguesRepo,
    d.mainErrorRepo, d.filesRepo, d.subjectsRepo, d.questionsRepo, d.extractTasksRepo,
  );
}

async function collect(iter: AsyncIterable<any>) {
  const out: any[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('AIService stored-explanation short-circuit (aux)', () => {
  it('满 2 轮 + 明确索要 + 题库有解析 -> 直接输出答案/思路/解析，不调模型', async () => {
    const d = mkDeps();
    const svc = mkService(d);
    const events = await collect(svc.tutorStream(
      { mode: 'auxiliary', message: '给我详细解析', dialogueId: DIALOGUE_ID } as any, 7,
    ));

    const content = events.filter((e) => e.type === 'content').map((e) => e.delta).join('');
    expect(content).toContain('223 元');
    expect(content).toContain('按性价比枚举');
    expect(content).toContain('有界背包');
    expect(events.at(-1)).toMatchObject({ type: 'done', fallback: true });
    expect(d.tutoring.tutorStream).not.toHaveBeenCalled();
    expect(d.conversationService.saveMessages).toHaveBeenCalledWith(expect.objectContaining({
      dialogueId: DIALOGUE_ID,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: '给我详细解析' }),
        expect.objectContaining({ role: 'assistant', type: 'fallback' }),
      ]),
    }));
  });

  it('question_id 查不到时用「前 20 字」兜底命中题库', async () => {
    const d = mkDeps({
      conversationsService: {
        get: vi.fn().mockResolvedValue({ id: 7, student_id: 7, title: '辅线答疑', question_id: null }),
        getMessages: vi.fn().mockResolvedValue(HISTORY_2_TURNS),
      },
      questionsRepo: {
        findById: vi.fn(),
        findByContentHash: vi.fn().mockResolvedValue(null),
        findByContentPrefix: vi.fn().mockResolvedValue([{ id: 5005, answer: '223', approach: '枚举', explanation: '解析' }]),
        findOrCreate: vi.fn(),
      },
    });
    const svc = mkService(d);
    const events = await collect(svc.tutorStream(
      { mode: 'auxiliary', message: '给我详细解析', dialogueId: DIALOGUE_ID } as any, 7,
    ));
    const content = events.filter((e) => e.type === 'content').map((e) => e.delta).join('');
    expect(content).toContain('223');
    expect(d.tutoring.tutorStream).not.toHaveBeenCalled();
  });

  it('题库查不到 -> 强制 AI 完整解析兜底（不再苏格拉底）', async () => {
    let captured: any = null;
    const d = mkDeps({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue(null),
        findByContentHash: vi.fn().mockResolvedValue(null),
        findByContentPrefix: vi.fn().mockResolvedValue([]),
        findOrCreate: vi.fn(),
      },
      tutoring: {
        tutor: vi.fn(),
        tutorStream: vi.fn().mockImplementation(async function* (req: any) {
          captured = req;
          yield { type: 'done', fallback: true };
        }),
        generateTitle: vi.fn().mockResolvedValue(null),
      },
    });
    await collect(mkService(d).tutorStream(
      { mode: 'auxiliary', message: '给我详细解析', dialogueId: DIALOGUE_ID } as any, 7,
    ));
    expect(d.tutoring.tutorStream).toHaveBeenCalled();
    expect(captured?.forceFallback).toBe(true);
    // 短路分支不应自己落库（交给 capability 的 fallback 分支）
    expect(d.conversationService.saveMessages).not.toHaveBeenCalled();
  });

  it('题库有题但内容全空 -> 也走 AI 兜底', async () => {
    let captured: any = null;
    const d = mkDeps({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 42, answer: '', approach: null, explanation: null }),
        findByContentHash: vi.fn().mockResolvedValue(null),
        findByContentPrefix: vi.fn().mockResolvedValue([]),
        findOrCreate: vi.fn(),
      },
      tutoring: {
        tutor: vi.fn(),
        tutorStream: vi.fn().mockImplementation(async function* (req: any) {
          captured = req;
          yield { type: 'done', fallback: true };
        }),
        generateTitle: vi.fn().mockResolvedValue(null),
      },
    });
    await collect(mkService(d).tutorStream(
      { mode: 'auxiliary', message: '给我详细解析', dialogueId: DIALOGUE_ID } as any, 7,
    ));
    expect(captured?.forceFallback).toBe(true);
  });

  it('未满 2 轮：不触发（正常苏格拉底）', async () => {
    let captured: any = null;
    const d = mkDeps({
      conversationsService: {
        get: vi.fn().mockResolvedValue({ id: 7, student_id: 7, title: '辅线答疑', question_id: 42 }),
        getMessages: vi.fn().mockResolvedValue([
          { role: 'user', content: '这题怎么做' },
          { role: 'assistant', content: '先看已知条件' },
        ]),
      },
      tutoring: {
        tutor: vi.fn(),
        tutorStream: vi.fn().mockImplementation(async function* (req: any) {
          captured = req;
          yield { type: 'done', fallback: false };
        }),
        generateTitle: vi.fn().mockResolvedValue(null),
      },
    });
    await collect(mkService(d).tutorStream(
      { mode: 'auxiliary', message: '给我详细解析', dialogueId: DIALOGUE_ID } as any, 7,
    ));
    expect(captured?.forceFallback).toBeUndefined();
    expect(d.conversationService.saveMessages).not.toHaveBeenCalled();
  });

  it('非 auxiliary 模式：不触发', async () => {
    let captured: any = null;
    const d = mkDeps({
      tutoring: {
        tutor: vi.fn(),
        tutorStream: vi.fn().mockImplementation(async function* (req: any) {
          captured = req;
          yield { type: 'done', fallback: false };
        }),
        generateTitle: vi.fn().mockResolvedValue(null),
      },
    });
    await collect(mkService(d).tutorStream(
      { mode: 'mainline', message: '给我详细解析', dialogueId: DIALOGUE_ID } as any, 7,
    ));
    expect(captured?.forceFallback).toBeUndefined();
  });
});

describe('AIService structured-question ingestion (dedup + 错题本)', () => {
  const sq = { type: 'short_answer', difficulty: 3, content: '题干', answer: '1', approach: '思路', explanation: '解析', knowledgePoints: [], quality: 'good' };

  function withTutor(sqOut: any, over: any = {}) {
    return mkDeps({
      tutoring: {
        tutor: vi.fn().mockResolvedValue({
          structuredQuestion: sqOut, message: { content: '引导中' }, reasoning: undefined,
          safety: { isLearningRelated: true, alertLevel: 'none' }, isFallback: false, consecutiveFailCount: 0,
        }),
        tutorStream: vi.fn(),
        generateTitle: vi.fn().mockResolvedValue(null),
      },
      ...over,
    });
  }

  it('hash/前20字命中已有题 -> 不重复入库，复用 id，并确保进错题本', async () => {
    const d = withTutor(sq, {
      questionsRepo: {
        findById: vi.fn(),
        findByContentHash: vi.fn().mockResolvedValue(null),
        findByContentPrefix: vi.fn().mockResolvedValue([{ id: 5005 }]),
        findOrCreate: vi.fn(),
      },
    });
    await mkService(d).tutor({ mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID } as any, 7);
    expect(d.questionsRepo.findOrCreate).not.toHaveBeenCalled();     // 不插重复题
    expect(d.dialoguesRepo.updateQuestionId).toHaveBeenCalledWith(7, 5005);
    expect(d.mainErrorRepo.existsByStudentAndQuestionId).toHaveBeenCalledWith(7, 5005);
    expect(d.mainErrorRepo.create).toHaveBeenCalledWith(expect.objectContaining({ question_id: 5005, source: 'auxiliary' }));
  });

  it('未命中 -> 入库；错题本已存在则不重复写', async () => {
    const d = withTutor(sq, {
      mainErrorRepo: {
        existsByStudentAndQuestionId: vi.fn().mockResolvedValue(true),
        create: vi.fn(),
        updateDialogueId: vi.fn(),
      },
      questionsRepo: {
        findById: vi.fn(),
        findByContentHash: vi.fn().mockResolvedValue(null),
        findByContentPrefix: vi.fn().mockResolvedValue([]),
        findOrCreate: vi.fn().mockResolvedValue({ id: 99, created: true }),
      },
    });
    await mkService(d).tutor({ mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID } as any, 7);
    expect(d.questionsRepo.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({ approach: '思路' }));
    expect(d.dialoguesRepo.updateQuestionId).toHaveBeenCalledWith(7, 99);
    expect(d.mainErrorRepo.create).not.toHaveBeenCalled();
  });
});
