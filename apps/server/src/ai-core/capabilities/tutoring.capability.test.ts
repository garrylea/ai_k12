import { describe, it, expect, beforeEach } from 'vitest';
import { TutoringCapability } from './tutoring.capability.js';
import { ConversationService } from '../../services/conversation/index.js';
import { ModelClient } from '../infra/model-client/index.js';
import type { ChatResponse } from '../types.js';

class FakeDialoguesRepo {
  rows: any[] = [];
  nextId = 1;
  async create(row: any) {
    const id = this.nextId++;
    this.rows.push({ id, ...row, created_at: new Date(), updated_at: new Date(), deleted_at: null });
    return id;
  }
  async findById(id: number) { return this.rows.find((r) => r.id === id) ?? null; }
  async updateFailCount(id: number, count: number) {
    const r = this.rows.find((x) => x.id === id); if (r) r.consecutive_fail_count = count;
  }
  async archive(id: number) { const r = this.rows.find((x) => x.id === id); if (r) r.status = 'archived'; }
  async findByStudentAndTrack() { return []; }
  async updateTitle() {}
}

class FakeMessagesRepo {
  rows: any[] = [];
  async createMany(msgs: any[]) { for (const m of msgs) this.rows.push(m); }
  async findByDialogue(dialogueId: number) {
    return this.rows.filter((r) => r.dialogue_id === dialogueId);
  }
}

class FakeStudentsRepo {
  async findById(id: number) {
    return { id, grade: '七年级', schoolLevel: 'junior', name: '小明' };
  }
}

describe('TutoringCapability', () => {
  let convService: ConversationService;
  let dialogueId: number;

  beforeEach(async () => {
    const dialogues = new FakeDialoguesRepo();
    const messages = new FakeMessagesRepo();
    const students = new FakeStudentsRepo();
    convService = new ConversationService(dialogues as any, messages as any, students as any);
    dialogueId = await convService.createDialogue({
      dialogueId: 'test_dialogue_1',
      studentId: 1,
      subject: 'math',
      track: 'mainline',
      currentKnowledgePoint: { id: 'kp_1', name: '一元一次方程', subject: 'math' },
      currentDifficulty: 1,
      currentQuestion: { content: '解方程 2x+3=7', answer: 'x=2' },
    });
  });

  it('blocks off-topic messages via safety guard and persists the user message', async () => {
    const capability = new TutoringCapability(convService);
    const result = await capability.tutor({
      studentId: 'student_1',
      mode: 'mainline',
      message: '今天天气真好我们去玩吧',
      dialogueId: String(dialogueId),
    });

    expect(result.safety.isLearningRelated).toBe(false);
    expect(result.message.type).toBe('block');
    // The user's off-topic message must be persisted so consecutive-off-topic
    // escalation can fire across repeated blocks.
    const persisted = await convService.loadContext(String(dialogueId), 3000);
    expect(persisted!.messages.some(m => m.role === 'user' && m.content.includes('今天天气真好'))).toBe(true);
    expect(persisted!.messages.some(m => m.role === 'assistant')).toBe(true);
  });

  it('routes learning messages through socratic flow with mocked model', async () => {
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'resp_1',
        model: 'qwen3.7-max',
        content: '你观察一下等式两边，有什么发现？',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
        latencyMs: 5,
      }),
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    const result = await capability.tutor({
      studentId: 'student_1',
      mode: 'mainline',
      message: '老师，一元一次方程怎么解？',
      dialogueId: String(dialogueId),
    });

    expect(result.dialogueId).toBe(String(dialogueId));
    expect(result.message.type).toBe('socratic');
    expect(result.message.content).toBe('你观察一下等式两边，有什么发现？');
    expect(result.isFallback).toBe(false);
    expect(result.consecutiveFailCount).toBe(0);
  });

  it('treats a help request "怎么做" as socratic, not fallback', async () => {
    // "怎么做" was removed from giveUpKeywords so a natural help request
    // ("怎么做这道题") routes to Socratic guidance, not a full-answer fallback.
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'resp_3', model: 'qwen3.7-max',
        content: '我们先看看等式两边有什么不同。',
        finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
      }),
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    const result = await capability.tutor({
      studentId: 'student_1', mode: 'mainline',
      message: '老师，这道题怎么做？',
      dialogueId: String(dialogueId),
    });

    expect(result.isFallback).toBe(false);
    expect(result.message.type).toBe('socratic');
  });

  it('triggers fallback on give-up keyword "太难" (not blocked by safety)', async () => {
    // "太难" is a giveUpKeyword but not a learning pattern; the give-up check
    // runs before safety so the student reaches the fallback full-explanation
    // instead of an off-topic block.
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'resp_4', model: 'qwen3.7-max',
        content: '## 知识点总结\n一元一次方程的标准形式是 ax+b=0。\n\n## 建议\n- 多做基础练习',
        finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
      }),
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    const result = await capability.tutor({
      studentId: 'student_1', mode: 'mainline',
      message: '太难了，我不会',
      dialogueId: String(dialogueId),
    });

    expect(result.isFallback).toBe(true);
    expect(result.message.type).toBe('fallback');
    const persisted = await convService.loadContext(String(dialogueId), 3000);
    expect(persisted!.messages.some(m => m.role === 'user' && m.content.includes('太难了'))).toBe(true);
  });

  it('triggers fallback on "不会做" and persists the user message', async () => {
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'resp_2', model: 'qwen3.7-max',
        content: '## 知识点总结\n一元一次方程的标准形式是 ax+b=0。\n\n## 建议\n- 多做基础练习\n- 理解移项规则',
        finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
      }),
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    const result = await capability.tutor({
      studentId: 'student_1', mode: 'mainline',
      message: '我不会做',
      dialogueId: String(dialogueId),
    });

    expect(result.isFallback).toBe(true);
    expect(result.message.type).toBe('fallback');
    const persisted = await convService.loadContext(String(dialogueId), 3000);
    expect(persisted!.messages.some(m => m.role === 'user' && m.content === '我不会做')).toBe(true);
  });
});
