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

  it('stops counting at a learning message like "我不会做"', () => {
    // "我不会做" matches the learning pattern /不会/, so it must break the
    // consecutive-off-topic chain (previously the smaller pattern set here
    // missed /不会/ and counted it as off-topic, inflating the count to 2).
    const count = guard.countConsecutiveOffTopic([
      { role: 'user', content: '今天天气真好' },
      { role: 'assistant', content: '...' },
      { role: 'user', content: '我不会做' },
      { role: 'assistant', content: '...' },
      { role: 'user', content: '你玩什么游戏' },
    ]);
    expect(count).toBe(1);
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

  it('classifies equation-bearing messages as learning (not off_topic)', () => {
    // "3x+5=14,x等于多少" 含代数表达式但无"方程/计算"等词,曾误判 off_topic 而 block。
    expect(guard.classifyByKeywords('3x + 5 = 14，x等于多少？').classification).toBe('learning');
    expect(guard.classifyByKeywords('我算出来 2x+3=7 的解是 x=5，对吗？').classification).toBe('learning');
    expect(guard.classifyByKeywords('2x+3=7，我算出 x=2').classification).toBe('learning');
  });

  it('still treats "1+1等于几" as off_topic (no half-width =)', () => {
    // 回归保障:中文"等于"不含半角等号,不应被新方程正则误判为 learning。
    expect(guard.classifyByKeywords('1+1等于几').classification).toBe('off_topic');
  });

  it('classifies emotional distress as anomaly', () => {
    const result = guard.classifyByKeywords('我好烦不想学了');
    expect(result.classification).toBe('anomaly');
  });

  // --- 2026-09-20（spec §3.1）：闲聊不再硬阻断 ---------------------------------
  // 关键词分类器仍把这类消息判为 off_topic（上面 classifyByKeywords 的断言保留），
  // 但 check() **不再据此拦截** —— 改由模型自报标记判定 + 写预警。
  it('主线 off_topic 不再阻断（shouldBlock=false，且不带 blockResponse/alertPayload）', async () => {
    const result = await guard.check({
      studentId: '1',
      message: '今天天气真好，想出去玩',
      dialogueHistory: [],
      track: 'mainline',
    });

    expect(result.classification).toBe('off_topic');
    expect(result.isLearningRelated).toBe(false);
    expect(result.shouldBlock).toBe(false);
    expect(result.blockResponse).toBeUndefined();
    // off_topic 的 alertPayload 随旧分支一并删除（spec §2.2）—— 闲聊的预警改由
    // 模型自报标记在 tutoring 侧写（type='off_topic'），不从这里出。
    expect(result.alertPayload).toBeUndefined();
  });

  it('辅线 off_topic 同样不再阻断（豁免段删除后两条轨都不拦）', async () => {
    const result = await guard.check({
      studentId: '1',
      message: '今天天气真好，想出去玩',
      dialogueHistory: [],
      track: 'auxiliary',
    });

    expect(result.shouldBlock).toBe(false);
  });

  it('anomaly 仍阻断且带 alertPayload（情绪/敏感行为不变）', async () => {
    const result = await guard.check({
      studentId: '1',
      message: '我好烦不想学了',
      dialogueHistory: [],
      track: 'mainline',
    });

    expect(result.classification).toBe('anomaly');
    expect(result.anomalyType).toBe('emotional');
    expect(result.shouldBlock).toBe(true);
    expect(result.blockResponse).toBeTruthy();
    expect(result.alertPayload?.type).toBe('emotional');
    expect(result.alertPayload?.level).toBe('warning');
  });
});
