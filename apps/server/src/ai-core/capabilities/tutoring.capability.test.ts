import { describe, it, expect, beforeEach } from 'vitest';
import { TutoringCapability } from './tutoring.capability.js';
import { ConversationService } from '../../services/conversation/index.js';
import { ModelClient } from '../infra/model-client/index.js';
import type { ChatResponse } from '../types.js';

describe('TutoringCapability', () => {
  let convService: ConversationService;

  beforeEach(() => {
    convService = new ConversationService();
    convService._reset();
    convService.createDialogue({
      dialogueId: 'test_dialogue_1',
      student: { grade: '七年级', gradeLevel: 'junior', name: '小明' },
      subject: 'math',
      track: 'mainline',
      currentKnowledgePoint: { id: 'kp_1', name: '一元一次方程', subject: 'math' },
      currentDifficulty: 1,
      currentQuestion: { content: '解方程 2x+3=7', answer: 'x=2' },
    });
  });

  it('blocks off-topic messages via safety guard', async () => {
    const capability = new TutoringCapability(convService);
    const result = await capability.tutor({
      studentId: 'student_1',
      mode: 'mainline',
      message: '今天天气真好我们去玩吧',
      dialogueId: 'test_dialogue_1',
    });

    expect(result.safety.isLearningRelated).toBe(false);
    expect(result.message.type).toBe('block');
  });

  it('routes learning messages through socratic flow with mocked model', async () => {
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'resp_1',
        model: 'qwen-3.7-max',
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
      dialogueId: 'test_dialogue_1',
    });

    expect(result.dialogueId).toBe('test_dialogue_1');
    expect(result.message.type).toBe('socratic');
    expect(result.message.content).toBe('你观察一下等式两边，有什么发现？');
    expect(result.isFallback).toBe(false);
    expect(result.consecutiveFailCount).toBe(0);
  });

  it('triggers fallback on give-up keyword', async () => {
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'resp_2',
        model: 'qwen-3.7-max',
        content: '## 知识点总结\n一元一次方程的标准形式是 ax+b=0。\n\n## 建议\n- 多做基础练习\n- 理解移项规则',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
        latencyMs: 5,
      }),
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    const result = await capability.tutor({
      studentId: 'student_1',
      mode: 'mainline',
      message: '我不会做',
      dialogueId: 'test_dialogue_1',
    });

    expect(result.isFallback).toBe(true);
    expect(result.message.type).toBe('fallback');
  });
});
