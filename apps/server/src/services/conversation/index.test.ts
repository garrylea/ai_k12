import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationService } from './index.js';

describe('ConversationService', () => {
  let svc: ConversationService;
  beforeEach(() => {
    svc = new ConversationService();
    svc.createDialogue({
      dialogueId: 'd1',
      student: { grade: '七年级', gradeLevel: 'junior', name: '小明' },
      subject: 'math',
      track: 'mainline',
      cardContent: '一元一次方程',
      currentKnowledgePoint: { id: 'kp1', name: '一元一次方程', subject: 'math' },
      currentDifficulty: 2,
      currentQuestion: { content: '解 2x=4', answer: 'x=2' },
    });
  });

  it('loadContext returns metadata and current KP/question/difficulty', () => {
    const ctx = svc.loadContext('d1')!;
    expect(ctx.subject).toBe('math');
    expect(ctx.cardContent).toBe('一元一次方程');
    expect(ctx.student.name).toBe('小明');
    expect(ctx.currentKnowledgePoint?.id).toBe('kp1');
    expect(ctx.currentDifficulty).toBe(2);
    expect(ctx.currentQuestion?.content).toBe('解 2x=4');
    expect(ctx.consecutiveFailCount).toBe(0);
    expect(ctx.dialogueMetadata.track).toBe('mainline');
  });

  it('loadContext returns null for unknown dialogue', () => {
    expect(svc.loadContext('nope')).toBeNull();
  });

  it('saveMessages appends to history', () => {
    svc.saveMessages({ dialogueId: 'd1', messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]});
    const ctx = svc.loadContext('d1')!;
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].content).toBe('hello');
    expect(ctx.dialogueMetadata.messageCount).toBe(2);
  });

  it('updateFailCount increments and resets', () => {
    svc.updateFailCount({ dialogueId: 'd1', increment: true });
    svc.updateFailCount({ dialogueId: 'd1', increment: true });
    expect(svc.loadContext('d1')!.consecutiveFailCount).toBe(2);
    svc.updateFailCount({ dialogueId: 'd1', increment: false });
    expect(svc.loadContext('d1')!.consecutiveFailCount).toBe(0);
  });

  it('completeDialogue does not throw for existing dialogue', () => {
    expect(() => svc.completeDialogue({ dialogueId: 'd1', reason: 'fallback_triggered' })).not.toThrow();
  });

  it('saveMessages throws for unknown dialogue', () => {
    expect(() => svc.saveMessages({ dialogueId: 'nope', messages: [] })).toThrow(/not found/i);
  });

  it('truncates long history to fit token budget (keeps last 4)', () => {
    for (let i = 0; i < 20; i++) {
      svc.saveMessages({ dialogueId: 'd1', messages: [
        { role: 'user', content: 'X'.repeat(500) },
        { role: 'assistant', content: 'Y'.repeat(500) },
      ]});
    }
    const ctx = svc.loadContext('d1', 100)!;
    expect(ctx.messages.length).toBeLessThan(40);
    expect(ctx.messages.length).toBeGreaterThanOrEqual(4);
  });
});
