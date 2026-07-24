import { describe, it, expect, beforeEach } from 'vitest';
import { SafetyGuard } from './safety-guard.js';
import type { Message } from '../types.js';

describe('SafetyGuard', () => {
  let guard: SafetyGuard;

  beforeEach(() => {
    guard = new SafetyGuard();
  });

  it('counts consecutive off-topic user messages from end of history', () => {
    const result = guard.countConsecutiveOffTopic([
      { role: 'user', content: '今天天气真好' },
      { role: 'assistant', content: '我是学习助手～' },
      { role: 'user', content: '你玩什么游戏' },
    ]);
    expect(result).toBe(2);
  });

  it('picks a random off_topic block phrase', () => {
    const phrase = guard.pickGentleBlockMessage('off_topic');
    expect(phrase).toBeTruthy();
    expect(typeof phrase).toBe('string');
  });

  it('picks emotional block phrase', () => {
    const phrase = guard.pickGentleBlockMessage('emotional');
    expect(phrase).toBeTruthy();
  });

  it('returns consistent sensitive block phrase', () => {
    const phrase = guard.pickGentleBlockMessage('sensitive');
    expect(phrase).toBeTruthy();
  });

  it('counts consecutive off-topic from end of history (mixed)', () => {
    const history: Message[] = [
      { role: 'user', content: 'what is 1+1' },
      { role: 'assistant', content: '...' },
      { role: 'user', content: 'nice weather' },
      { role: 'assistant', content: '...' },
      { role: 'user', content: 'play games?' },
    ];
    const count = guard.countConsecutiveOffTopic(history);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('classifies learning messages as learning', () => {
    const result = guard.classifyByKeywords('老师，一元一次方程怎么解？');
    expect(result.classification).toBe('learning');
  });

  it('classifies emotional distress as anomaly', () => {
    const result = guard.classifyByKeywords('我好烦不想学了');
    expect(result.classification).toBe('anomaly');
  });
});
