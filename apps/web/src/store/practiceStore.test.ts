import { beforeEach, describe, expect, it } from 'vitest';
import { usePracticeStore } from './practiceStore';

const QUESTIONS = [
  { n: '0-1', text: '(1) $2x^{2}-8=0$' },
  { n: '0-2', text: '(2) $9x^{2}-5=3$' },
];

const EMPTY_STATE = {
  cardId: null,
  questions: [],
  answers: {},
  hints: {},
  discussDialogues: {},
  currentIndex: 0,
};

beforeEach(() => {
  usePracticeStore.setState(EMPTY_STATE);
});

describe('practiceStore', () => {
  it('setSession 重置 answers/hints 并记录 session', () => {
    usePracticeStore.getState().record('0-1', 'x=2', { questionId: 1, isCorrect: true, method: 'exact' });
    usePracticeStore.getState().setSession(42, QUESTIONS);

    const s = usePracticeStore.getState();
    expect(s.cardId).toBe(42);
    expect(s.questions).toEqual(QUESTIONS);
    expect(s.answers).toEqual({});
    expect(s.hints).toEqual({});
  });

  it('record 按复合题号写入 answer 且不影响其它题', () => {
    usePracticeStore.getState().setSession(42, QUESTIONS);
    usePracticeStore.getState().record('0-1', 'x=2', { questionId: 1, isCorrect: true, method: 'exact' });

    let s = usePracticeStore.getState();
    expect(s.answers['0-1']).toMatchObject({ studentAnswer: 'x=2', isCorrect: true, method: 'exact' });
    expect(s.answers['0-2']).toBeUndefined();

    usePracticeStore.getState().record('0-2', 'x=3', { questionId: 2, isCorrect: false, method: 'ai', errorType: 'calculation' });
    s = usePracticeStore.getState();
    expect(s.answers['0-1']).toBeDefined(); // 先答的题不被覆盖
    expect(s.answers['0-2']).toMatchObject({ studentAnswer: 'x=3', isCorrect: false, errorType: 'calculation' });
  });

  it('record 判定失败时带 failed 标记', () => {
    usePracticeStore.getState().setSession(42, QUESTIONS);
    usePracticeStore.getState().record('0-1', 'x=2', { questionId: null, isCorrect: false, method: 'ai' }, { failed: true });

    expect(usePracticeStore.getState().answers['0-1'].failed).toBe(true);
  });

  it('loadResults 用 DB 结果填充 answers（key = questionN）', () => {
    usePracticeStore.getState().setSession(42, QUESTIONS);
    usePracticeStore.getState().loadResults(42, QUESTIONS, [
      { questionN: '0-1', questionText: 'q1', studentAnswer: 'x=2', isCorrect: true, method: 'exact', errorType: null },
    ]);

    const s = usePracticeStore.getState();
    expect(s.answers['0-1']).toMatchObject({ studentAnswer: 'x=2', isCorrect: true });
    expect(s.answers['0-2']).toBeUndefined();
  });

  it('loadResults 同卡重入时保留在途作答（current 优先）', () => {
    usePracticeStore.getState().setSession(42, QUESTIONS);
    // 用户已作答 0-2（尚未落库），随后 loadResults 返回 DB 只含 0-1
    usePracticeStore.getState().record('0-2', 'x=3', { questionId: 99, isCorrect: true, method: 'exact' });
    usePracticeStore.getState().loadResults(42, QUESTIONS, [
      { questionN: '0-1', questionText: 'q1', studentAnswer: 'x=2', isCorrect: false, method: 'ai', errorType: null },
    ]);

    const s = usePracticeStore.getState();
    expect(s.answers['0-1']).toMatchObject({ studentAnswer: 'x=2', isCorrect: false });
    expect(s.answers['0-2']).toMatchObject({ studentAnswer: 'x=3', isCorrect: true }); // 在途作答保留
  });

  it('clearAnswers 只清 answers，保留 cardId/questions/hints', () => {
    usePracticeStore.getState().setSession(42, QUESTIONS);
    usePracticeStore.getState().record('0-1', 'x=2', { questionId: 1, isCorrect: true, method: 'exact' });
    usePracticeStore.getState().setHint('0-1', '提示');

    usePracticeStore.getState().clearAnswers();
    const s = usePracticeStore.getState();
    expect(s.answers).toEqual({});
    expect(s.cardId).toBe(42);
    expect(s.questions).toEqual(QUESTIONS);
    expect(s.hints).toEqual({ '0-1': '提示' });
  });

  it('reset 清空整个 session', () => {
    usePracticeStore.getState().setSession(42, QUESTIONS);
    usePracticeStore.getState().record('0-1', 'x=2', { questionId: 1, isCorrect: true, method: 'exact' });
    usePracticeStore.getState().reset();

    expect(usePracticeStore.getState()).toMatchObject(EMPTY_STATE);
  });
});
