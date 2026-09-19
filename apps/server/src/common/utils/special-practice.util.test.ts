import { describe, it, expect } from 'vitest';
import { collapseUnitVerdict, isCorrectOf } from './special-practice.util.js';

describe('isCorrectOf', () => {
  it('只有 correct/incorrect 是明确对错，其余一律 null', () => {
    expect(isCorrectOf('correct')).toBe(true);
    expect(isCorrectOf('incorrect')).toBe(false);
    expect(isCorrectOf('off_target')).toBeNull();
    expect(isCorrectOf('unanswered')).toBeNull();
    expect(isCorrectOf('undetermined')).toBeNull();
  });
});

describe('collapseUnitVerdict', () => {
  const ok = { correct: true, method: 'exact' };
  const aiOk = { correct: true, method: 'ai' };
  const aiWrong = { correct: false, method: 'ai' };
  const blank = { correct: false, method: 'unanswered' };
  const unknown = { correct: null, method: 'undetermined' };

  it.each([
    ['全对 → correct', [ok, aiOk], 'correct'],
    ['有一项 LLM 判错 → incorrect', [ok, aiWrong], 'incorrect'],
    // 优先级：确定错压过「没作答」
    ['判错 + 没作答 → incorrect', [aiWrong, blank], 'incorrect'],
    // 优先级：没能判定压过「没作答」
    ['没能判定 + 没作答 → undetermined', [unknown, blank], 'undetermined'],
    ['只有没作答 → unanswered', [ok, blank], 'unanswered'],
    ['全没能判定 → undetermined', [unknown, unknown], 'undetermined'],
    // 空集合不该出现（一句话至少有一个待判项），但要有个确定行为而不是抛
    ['空数组 → undetermined（不该发生，但不能抛）', [], 'undetermined'],
  ])('%s', (_name, items, expected) => {
    expect(collapseUnitVerdict(items as any)).toBe(expected);
  });

  it('纯函数：不改动入参', () => {
    const items = [{ correct: false, method: 'ai' }];
    collapseUnitVerdict(items);
    expect(items).toEqual([{ correct: false, method: 'ai' }]);
  });
});
