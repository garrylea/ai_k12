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
    dialoguesRepo: {
      findById: vi.fn().mockResolvedValue({ id: 7, scene: 'aux_qna' }),
      updateQuestionId: vi.fn().mockResolvedValue(undefined),
    },
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
    studentScope: {
      resolve: vi.fn().mockResolvedValue({
        gradeLabel: '初二', textbookLabel: '人教版', learnedContent: '一次函数',
      }),
    },
    freeformChatIngest: { maybeIngest: vi.fn().mockResolvedValue(undefined) },
  };
  return { ...base, ...over };
}

function mkService(d: any) {
  return new AIService(
    d.tutoring, d.conversationsService, d.conversationService, d.dialoguesRepo,
    d.mainErrorRepo, d.filesRepo, d.subjectsRepo, d.questionsRepo, d.extractTasksRepo,
    d.studentScope, d.freeformChatIngest,
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

  it('aux_freeform：结构化题不入题库、不写错题本、不锚会话（tutor）', async () => {
    const d = withTutor(sq, {
      dialoguesRepo: {
        findById: vi.fn().mockResolvedValue({ id: 7, scene: 'aux_freeform' }),
        updateQuestionId: vi.fn(),
      },
    });
    await mkService(d).tutor({ mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID } as any, 7);

    // 做题入口的答疑固定走千问（freeform_tutor），不再走默认 tutoring 路由
    expect(d.tutoring.tutor).toHaveBeenCalledWith(
      expect.objectContaining({ routeScene: 'freeform_tutor' }),
    );
    expect(d.questionsRepo.findByContentHash).not.toHaveBeenCalled();
    expect(d.questionsRepo.findOrCreate).not.toHaveBeenCalled();
    expect(d.mainErrorRepo.create).not.toHaveBeenCalled();
    expect(d.dialoguesRepo.updateQuestionId).not.toHaveBeenCalled();
  });

  it('aux_freeform：结构化题不入题库、不写错题本（tutorStream）', async () => {
    const d = mkDeps({
      dialoguesRepo: {
        findById: vi.fn().mockResolvedValue({ id: 7, scene: 'aux_freeform' }),
        updateQuestionId: vi.fn(),
      },
      tutoring: {
        tutor: vi.fn(),
        tutorStream: vi.fn().mockImplementation(async function* () {
          yield { type: 'content', delta: '一起看条件' };
          yield { type: 'done', structuredQuestion: sq };
        }),
        generateTitle: vi.fn().mockResolvedValue(null),
      },
    });
    const events = await collect(mkService(d).tutorStream(
      { mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID } as any, 7,
    ));

    expect(events.map((e) => e.type)).toEqual(['content', 'done']);
    expect(d.tutoring.tutorStream).toHaveBeenCalledWith(
      expect.objectContaining({ routeScene: 'freeform_tutor' }),
      undefined,
    );
    expect(d.questionsRepo.findOrCreate).not.toHaveBeenCalled();
    expect(d.mainErrorRepo.create).not.toHaveBeenCalled();
    expect(d.dialoguesRepo.updateQuestionId).not.toHaveBeenCalled();
  });

  it('aux_qna：结构化题仍照常入库（不受 freeform 豁免影响）', async () => {
    const d = withTutor(sq, {
      dialoguesRepo: {
        findById: vi.fn().mockResolvedValue({ id: 7, scene: 'aux_qna' }),
        updateQuestionId: vi.fn().mockResolvedValue(undefined),
      },
    });
    await mkService(d).tutor({ mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID } as any, 7);

    // 普通答疑仍走 tutoring 路由（不被 freeform 的模型覆盖影响）
    expect(d.tutoring.tutor).toHaveBeenCalledWith(
      expect.objectContaining({ routeScene: 'tutoring' }),
    );
    expect(d.questionsRepo.findOrCreate).toHaveBeenCalledTimes(1);
    expect(d.mainErrorRepo.create).toHaveBeenCalledTimes(1);
  });
});

describe('AIService freeform 学习档案与学科（全部从 DB 推导）', () => {
  function freeformDeps(over: any = {}) {
    return mkDeps({
      dialoguesRepo: {
        findById: vi.fn().mockResolvedValue({ id: 7, scene: 'aux_freeform', subject_id: 5 }),
        updateQuestionId: vi.fn(),
      },
      tutoring: {
        tutor: vi.fn().mockResolvedValue({
          message: { content: '讲解' }, reasoning: undefined,
          safety: { isLearningRelated: true, alertLevel: 'none' }, isFallback: false, consecutiveFailCount: 0,
        }),
        tutorStream: vi.fn(),
        generateTitle: vi.fn().mockResolvedValue(null),
      },
      ...over,
    });
  }

  it('做题页：按 studentId + 学科解出学习档案，随请求下发', async () => {
    const d = freeformDeps();
    await mkService(d).tutor({
      mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID, subjectId: 4,
    } as any, 7);

    expect(d.studentScope.resolve).toHaveBeenCalledWith(7, 4);
    expect(d.tutoring.tutor).toHaveBeenCalledWith(expect.objectContaining({
      routeScene: 'freeform_tutor',
      subjectId: 4,
      learningProfile: { grade: '初二', textbook: '人教版', learnedContent: '一次函数' },
    }));
  });

  it('dto 没给 subjectId 时回落到会话的 subject_id', async () => {
    const d = freeformDeps();
    await mkService(d).tutor({ mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID } as any, 7);
    expect(d.studentScope.resolve).toHaveBeenCalledWith(7, 5);
    expect(d.tutoring.tutor).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 5 }));
  });

  it('非做题页：不解学习档案、不带 subjectId/learningProfile', async () => {
    const d = mkDeps({
      tutoring: {
        tutor: vi.fn().mockResolvedValue({
          message: { content: '引导' }, reasoning: undefined,
          safety: { isLearningRelated: true, alertLevel: 'none' }, isFallback: false, consecutiveFailCount: 0,
        }),
        tutorStream: vi.fn(), generateTitle: vi.fn().mockResolvedValue(null),
      },
    });
    await mkService(d).tutor({
      mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID, subjectId: 4,
    } as any, 7);

    const req = d.tutoring.tutor.mock.calls[0][0];
    expect(d.studentScope.resolve).not.toHaveBeenCalled();
    expect(req.routeScene).toBe('tutoring');
    expect(req.learningProfile).toBeUndefined();
    expect(req.subjectId).toBeUndefined();
  });

  it('DB 推不出任何信息（scope 全空）→ 请求里不出现 learningProfile', async () => {
    const d = freeformDeps({
      studentScope: {
        resolve: vi.fn().mockResolvedValue({ gradeLabel: '', textbookLabel: '', learnedContent: '' }),
      },
    });
    await mkService(d).tutor({ mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID } as any, 7);
    expect(d.tutoring.tutor.mock.calls[0][0]).not.toHaveProperty('learningProfile');
  });

  it('前端私自带 learningProfile 也不会被采信（防绕过 DB 口径）', async () => {
    const d = freeformDeps();
    await mkService(d).tutor({
      mode: 'auxiliary', message: '这题怎么做', dialogueId: DIALOGUE_ID,
      learningProfile: { grade: '高三', textbook: '伪造版', learnedContent: '伪造内容' },
    } as any, 7);
    expect(d.tutoring.tutor).toHaveBeenCalledWith(expect.objectContaining({
      learningProfile: { grade: '初二', textbook: '人教版', learnedContent: '一次函数' },
    }));
  });

  it('做题页不走「详细解析」快路径（不查题库、不直出库解析）', async () => {
    const d = freeformDeps({
      tutoring: {
        tutor: vi.fn(),
        tutorStream: vi.fn().mockImplementation(async function* () {
          yield { type: 'content', delta: '先看条件' };
          yield { type: 'done' };
        }),
        generateTitle: vi.fn().mockResolvedValue(null),
      },
    });
    const events = await collect(mkService(d).tutorStream(
      { mode: 'auxiliary', message: '给我详细解析', dialogueId: DIALOGUE_ID } as any, 7,
    ));

    expect(events.map((e) => e.type)).toEqual(['content', 'done']);
    expect(d.questionsRepo.findById).not.toHaveBeenCalled();
    expect(d.conversationService.saveMessages).not.toHaveBeenCalled();
    expect(d.tutoring.tutorStream).toHaveBeenCalled();
  });
});
