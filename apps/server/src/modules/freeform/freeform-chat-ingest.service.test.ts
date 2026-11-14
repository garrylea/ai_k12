import { describe, it, expect, vi } from 'vitest';
import { FreeformChatIngestService } from './freeform-chat-ingest.service';

const mk = (over: any = {}) => ({
  dialogues: {
    findById: vi.fn().mockResolvedValue({ id: 7, student_id: 9, scene: 'aux_freeform', subject_id: 1, question_id: null }),
    updateQuestionId: vi.fn().mockResolvedValue(undefined),
  },
  messages: {
    findByDialogue: vi.fn().mockResolvedValue([
      { role: 'assistant', type: 'transcription', content: '解方程 $x+1=2$' },
      { role: 'user', type: 'socratic', content: '怎么移项？' },
      { role: 'assistant', type: 'socratic', content: '两边同时减 1。' },
    ]),
  },
  questions: {
    findByContentHash: vi.fn().mockResolvedValue(null),
    findByContentPrefix: vi.fn().mockResolvedValue([]),
    createFreeform: vi.fn().mockResolvedValue(11),
    bindKnowledgePoint: vi.fn().mockResolvedValue(undefined),
    findKnowledgePointIdsByQuestion: vi.fn().mockResolvedValue([]),
  },
  errorBooks: {
    existsByStudentAndQuestionId: vi.fn().mockResolvedValue(false),
    create: vi.fn().mockResolvedValue(22),
    updateDialogueId: vi.fn().mockResolvedValue(undefined),
  },
  kps: { findBySubject: vi.fn().mockResolvedValue([{ id: 11, name: '一元一次方程' }]) },
  subjects: { findById: vi.fn().mockResolvedValue({ id: 1, name: '数学' }) },
  students: { findById: vi.fn().mockResolvedValue({ id: 9, schoolLevel: 'junior' }) },
  tagger: {
    tag: vi.fn().mockResolvedValue({
      type: 'short_answer', difficulty: 2, answer: 'x=1', explanation: '移项',
      approach: '移项求解', options: null, knowledgePointIds: [11], confidence: 'high',
    }),
  },
  ...over,
});

const svc = (d: ReturnType<typeof mk>) =>
  new FreeformChatIngestService(
    d.dialogues as any,
    d.messages as any,
    d.questions as any,
    d.errorBooks as any,
    d.kps as any,
    d.subjects as any,
    d.students as any,
    d.tagger as any,
  );

describe('FreeformChatIngestService.maybeIngest', () => {
  it('有聊天、无题：建题 + 绑 KP + 写错题本 + 回填会话', async () => {
    const d = mk();
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).toHaveBeenCalledWith(expect.objectContaining({
      subject_id: 1, answer: 'x=1', source: 'freeform', full_score: 10,
    }));
    expect(d.questions.bindKnowledgePoint).toHaveBeenCalledWith(11, 11, 'primary');
    expect(d.errorBooks.create).toHaveBeenCalledWith(expect.objectContaining({
      student_id: 9, question_id: 11, source: 'freeform',
    }));
    expect(d.dialogues.updateQuestionId).toHaveBeenCalledWith(7, 11);
  });

  it('会话已有 question_id：直接跳过', async () => {
    const d = mk();
    d.dialogues.findById.mockResolvedValue({ id: 7, student_id: 9, scene: 'aux_freeform', subject_id: 1, question_id: 11 });
    await svc(d).maybeIngest('7', 9);
    expect(d.tagger.tag).not.toHaveBeenCalled();
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
  });

  it('已有该题错题行（含已清零）：不重建（满分后答疑不进）', async () => {
    const d = mk();
    d.questions.findByContentHash.mockResolvedValue({ id: 11 });
    d.errorBooks.existsByStudentAndQuestionId.mockResolvedValue(true);
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
    expect(d.errorBooks.create).not.toHaveBeenCalled();
    expect(d.dialogues.updateQuestionId).toHaveBeenCalledWith(7, 11);
  });

  it('标注失败：仍建空答案题 + 错题本（不可练，但可见）', async () => {
    const d = mk();
    d.tagger.tag.mockResolvedValue({
      type: 'short_answer', difficulty: 1, answer: '', explanation: '',
      approach: null, options: null, knowledgePointIds: [], confidence: 'low',
    });
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).toHaveBeenCalledWith(expect.objectContaining({ answer: '' }));
    expect(d.questions.bindKnowledgePoint).not.toHaveBeenCalled();
    expect(d.errorBooks.create).toHaveBeenCalled();
  });

  it('题目不存在 / 非本人：静默返回', async () => {
    const d = mk();
    d.dialogues.findById.mockResolvedValue({ id: 7, student_id: 999, scene: 'aux_freeform', subject_id: 1, question_id: null });
    await expect(svc(d).maybeIngest('7', 9)).resolves.toBeUndefined();
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
  });

  it('会话没有 subject_id：跳过（不默认数学）', async () => {
    const d = mk();
    d.dialogues.findById.mockResolvedValue({ id: 7, student_id: 9, scene: 'aux_freeform', subject_id: null, question_id: null });
    await svc(d).maybeIngest('7', 9);
    expect(d.tagger.tag).not.toHaveBeenCalled();
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
  });

  it('会话已有判题报告消息：跳过（兜底 question_id 回填失败）', async () => {
    const d = mk();
    d.messages.findByDialogue.mockResolvedValue([
      { role: 'assistant', type: 'transcription', content: '题' },
      { role: 'assistant', type: 'freeform_judge', content: '判题报告' },
    ]);
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
    expect(d.errorBooks.create).not.toHaveBeenCalled();
  });

  it('只有题干锚 + block 回复：跳过（安全阻断不算聊过）', async () => {
    const d = mk();
    d.messages.findByDialogue.mockResolvedValue([
      { role: 'assistant', type: 'transcription', content: '题' },
      { role: 'assistant', type: 'block', content: '先专心学习吧' },
    ]);
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
  });

  it('前缀去重带学科 + 选项剥 isCorrect', async () => {
    const d = mk();
    d.tagger.tag.mockResolvedValue({
      type: 'choice', difficulty: 2, answer: 'A', explanation: '',
      approach: null, options: [{ label: 'A', text: '1', isCorrect: true }],
      knowledgePointIds: [11], confidence: 'high',
    });
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.findByContentPrefix).toHaveBeenCalledWith('解方程 $x+1=2$', { subjectId: 1 });
    expect(d.questions.createFreeform).toHaveBeenCalledWith(expect.objectContaining({
      options: JSON.stringify([{ label: 'A', text: '1' }]),
    }));
  });
});
