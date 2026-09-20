import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TutoringCapability } from './tutoring.capability.js';
import { ConversationService } from '../../services/conversation/index.js';
import { SafetyAlertsService } from '../../modules/safety/safety-alerts.service.js';
import { ModelClient } from '../infra/model-client/index.js';
import { contentToText } from '../types.js';
import type { ChatResponse, StreamEvent } from '../types.js';

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
  async incrementFailCount(id: number) {
    const r = this.rows.find((x) => x.id === id); if (r) r.consecutive_fail_count += 1;
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
  /**
   * 暴露消息仓储以断言**落库的行对象**。`FakeMessagesRepo.rows` 是**列名键控**的对象
   * （不是位置数组），所以 `row.safety_flag` 这种断言天然是「列↔值配对」，
   * 不存在 params 位置错位的风险（见 goals.repo.test.ts 的 zipInsert 注释）。
   */
  let messages: FakeMessagesRepo;

  /** `SafetyAlertSink` 的测试替身：记录 tutoring 侧**实际写进 sink** 的入参。 */
  const mkSink = () => ({ record: vi.fn() });

  /** 非流式模型替身：返回固定 content。 */
  const mkModel = (content: string) => ({
    chat: async (): Promise<ChatResponse> => ({
      id: 'resp_test', model: 'qwen3.8-max', content,
      finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
    }),
  }) as unknown as ModelClient;

  const req = (message: string, mode: 'mainline' | 'auxiliary' = 'mainline') => ({
    studentId: '1',
    mode,
    message,
    dialogueId: String(dialogueId),
  });

  beforeEach(async () => {
    const dialogues = new FakeDialoguesRepo();
    messages = new FakeMessagesRepo();
    const students = new FakeStudentsRepo();
    convService = new ConversationService(dialogues as any, messages as any, students as any, { findContentById: async () => null } as any);
    dialogueId = await convService.createDialogue({
      studentId: 1,
      subject: 'math',
      track: 'mainline',
      currentKnowledgePoint: { id: 'kp_1', name: '一元一次方程', subject: 'math' },
      currentDifficulty: 1,
      currentQuestion: { content: '解方程 2x+3=7', answer: 'x=2' },
    });
  });

  it('off_topic 不再被硬阻断：走模型（socratic）且仍持久化学生消息', async () => {
    // 2026-09-20（spec §3.1）：关键词分类器对语文/英语理解题误判率过高（实测 6/12），
    // 拿它当门禁会拒掉正常提问。闲聊改由模型自报标记判定 —— 这条消息（无标记）必须
    // 走 socratic，**不再**出现 type='block'。
    const capability = new TutoringCapability(convService, { modelClient: mkModel('我们聊点别的吧～') });
    const result = await capability.tutor(req('今天天气真好我们去玩吧'));

    expect(result.message.type).toBe('socratic');
    // 学生消息仍要落库（后续轮次的对话上下文依赖它）
    const persisted = await convService.loadContext(String(dialogueId), 3000);
    expect(persisted!.messages.some(m => m.role === 'user' && contentToText(m.content).includes('今天天气真好'))).toBe(true);
    expect(persisted!.messages.some(m => m.role === 'assistant')).toBe(true);
  });

  it('① 识别模型自报的闲聊标记并从 content 剥离', async () => {
    const capability = new TutoringCapability(convService, {
      modelClient: mkModel('换个话题吧，我们聊聊游戏～\n<!--topic:off-->'),
    });
    const result = await capability.tutor(req('你喜欢什么游戏？', 'auxiliary'));

    expect(result.message.content).toBe('换个话题吧，我们聊聊游戏～');
    expect(result.message.content).not.toContain('<!--topic:off-->');
    expect(result.message.type).toBe('socratic');
  });

  it('② 标记不进入历史（saveMessages 收到的 assistant content 不含标记）', async () => {
    const capability = new TutoringCapability(convService, {
      modelClient: mkModel('换个话题吧～\n<!--topic:off-->'),
    });
    await capability.tutor(req('你喜欢什么游戏？', 'auxiliary'));

    const assistantRow = messages.rows.find((r) => r.role === 'assistant');
    expect(assistantRow).toBeDefined();
    expect(assistantRow.content).toBe('换个话题吧～');
    expect(assistantRow.content).not.toContain('<!--topic:off-->');
  });

  it('③ 模型没自报标记时不写预警（「没有标记 = 不报警」兜底原则）', async () => {
    const sink = mkSink();
    const capability = new TutoringCapability(convService, {
      modelClient: mkModel('你观察一下等式两边，有什么发现？'),
      safetyAlerts: sink,
    });
    await capability.tutor(req('老师，一元一次方程怎么解？'));

    expect(sink.record).not.toHaveBeenCalled();
  });

  it('④a tutor：自报闲聊 → 写一条 off_topic/warning 预警', async () => {
    const sink = mkSink();
    const capability = new TutoringCapability(convService, {
      modelClient: mkModel('换个话题吧～\n<!--topic:off-->'),
      safetyAlerts: sink,
    });
    await capability.tutor(req('你喜欢什么游戏？', 'auxiliary'));

    expect(sink.record).toHaveBeenCalledTimes(1);
    const input = sink.record.mock.calls[0][0];
    expect(input.type).toBe('off_topic');
    expect(input.level).toBe('warning');
    expect(input.studentId).toBe(1);
    expect(input.dialogueId).toBe(dialogueId);
    expect(input.context).toBe('你喜欢什么游戏？');
  });

  it('④b tutorStream：同一入口覆盖 —— 剥离标记 + 写预警 + 回写 safetyFlag', async () => {
    const sink = mkSink();
    const modelClient = {
      streamChat: async function* () {
        yield { content: '换个话题吧～\n<!--topic:off-->' };
      },
    } as unknown as ModelClient;
    const capability = new TutoringCapability(convService, { modelClient, safetyAlerts: sink });

    const events: StreamEvent[] = [];
    for await (const ev of capability.tutorStream(req('你喜欢什么游戏？', 'auxiliary'))) {
      events.push(ev);
    }

    // 剥离后必须发一条整体替换事件，学生端不会看到标记
    const replaceEvent = events.find((e) => e.type === 'content' && 'replace' in e && e.replace);
    expect(replaceEvent).toBeDefined();
    expect((replaceEvent as { delta: string }).delta).toBe('换个话题吧～');
    // done 事件仍要发出（预警写在 done 之前，不吞掉它）
    expect(events.some((e) => e.type === 'done')).toBe(true);

    const assistantRow = messages.rows.find((r) => r.role === 'assistant');
    expect(assistantRow.content).toBe('换个话题吧～');
    expect(assistantRow.safety_flag).toBe(1);
    expect(sink.record).toHaveBeenCalledTimes(1);
    expect(sink.record.mock.calls[0][0].type).toBe('off_topic');
  });

  it('⑤ 模型自报闲聊 → 助手消息 safety_flag = 1（不回写家长端计数会归零）', async () => {
    const capability = new TutoringCapability(convService, {
      modelClient: mkModel('换个话题吧～\n<!--topic:off-->'),
    });
    await capability.tutor(req('你喜欢什么游戏？', 'auxiliary'));

    const assistantRow = messages.rows.find((r) => r.role === 'assistant');
    expect(assistantRow.safety_flag).toBe(1);
  });

  it('⑥ anomaly（敏感）轮次仍阻断，且消费 alertPayload 写 level=critical 的预警', async () => {
    const sink = mkSink();
    // '这是敏感话题' → classifyByKeywords=anomaly，detectAnomalyType='sensitive' → critical
    const capability = new TutoringCapability(convService, {
      modelClient: mkModel('（不该被调用）'),
      safetyAlerts: sink,
    });
    const result = await capability.tutor(req('这是敏感话题'));

    // 阻断行为未变（anomaly 分支不动）
    expect(result.message.type).toBe('block');
    expect(result.safety.alertLevel).toBe('critical');
    // alertPayload 第一次被消费：type/level/context 都来自它
    expect(sink.record).toHaveBeenCalledTimes(1);
    const input = sink.record.mock.calls[0][0];
    expect(input.type).toBe('sensitive');
    expect(input.level).toBe('critical');
    expect(input.context).toBe('这是敏感话题');
  });

  it('⑦ 预警文案表与 SafetyAlertsService.messageFor 逐字一致（跨文件漂移钉子）', async () => {
    // 真实调用 messageFor（不是把两边的常量都 import 进来比对 —— 那是 a === a，恒真无区分力）
    const alertsSvc = new SafetyAlertsService({} as any, {} as any);

    const cases: { message: string; mode: 'mainline' | 'auxiliary'; modelContent?: string }[] = [
      { message: '你喜欢什么游戏？', mode: 'auxiliary', modelContent: '换个话题吧～\n<!--topic:off-->' },
      { message: '我好烦不想学了', mode: 'mainline' },
      { message: '这是敏感话题', mode: 'mainline' },
    ];

    for (const c of cases) {
      const sink = mkSink();
      const capability = new TutoringCapability(convService, {
        modelClient: mkModel(c.modelContent ?? '（不该被调用）'),
        safetyAlerts: sink,
      });
      await capability.tutor(req(c.message, c.mode));

      expect(sink.record).toHaveBeenCalledTimes(1);
      const written = sink.record.mock.calls[0][0];
      // 断言的是 tutoring 侧**实际写进 sink 的 message** 与 messageFor 的返回值一致
      expect(written.message).toBe(alertsSvc.messageFor(written.type));
    }
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
    expect(persisted!.messages.some(m => m.role === 'user' && contentToText(m.content).includes('太难了'))).toBe(true);
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
    expect(persisted!.messages.some(m => m.role === 'user' && contentToText(m.content) === '我不会做')).toBe(true);
  });

  // Task 14a: multimodal tutoring with image attachments
  // 图片直接作为 image_url 部件送入辅导模型（不再两阶段）
  it('tutoring uses the multimodal model even with an image', async () => {
    let capturedModel: string | undefined;
    const mockModelClient = {
      chat: async (req: any): Promise<ChatResponse> => {
        capturedModel = req.model.modelId;
        return {
          id: 'resp_vl', model: 'qwen3.7-max',
          content: '我看到了你的题目图片，这是一道一元一次方程题。',
          finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
        };
      },
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    const result = await capability.tutor({
      studentId: 'student_1',
      mode: 'auxiliary',
      message: '老师帮我看看这道题',
      dialogueId: String(dialogueId),
      attachments: [{ type: 'image', url: '/uploads/test.png', imageUrl: 'data:image/png;base64,abc123' }],
    });

    expect(capturedModel).toBe('qwen3.8-max');
    expect(result.message.type).toBe('socratic');
  });

  it('passes image_url parts to the model when attachment is present', async () => {
    let capturedMessages: any[] = [];
    const mockModelClient = {
      chat: async (req: any): Promise<ChatResponse> => {
        capturedMessages = req.messages;
        return {
          id: 'resp_vl2', model: 'qwen3.8-max',
          content: '题目识别正确，我们一起解。',
          finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
        };
      },
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    await capability.tutor({
      studentId: 'student_1',
      mode: 'auxiliary',
      message: '老师帮我看看这道题',
      dialogueId: String(dialogueId),
      attachments: [{ type: 'image', url: '/uploads/test.png', imageUrl: 'data:image/png;base64,xyz' }],
    });

    // The last user message should have array content with image_url part
    const lastUserMsg = [...capturedMessages].reverse().find((m: any) => m.role === 'user');
    expect(Array.isArray(lastUserMsg.content)).toBe(true);
    const imageParts = lastUserMsg.content.filter((p: any) => p.type === 'image_url');
    expect(imageParts.length).toBe(1);
    expect(imageParts[0].image_url.url).toBe('data:image/png;base64,xyz');
  });

  it('extracts structuredQuestion from model reply and strips JSON from content', async () => {
    const structuredJson = JSON.stringify({
      type: 'short_answer',
      difficulty: 1,
      content: '解方程 2x+3=7',
      answer: 'x=2',
      explanation: '移项得 2x=4，两边除以 2 得 x=2',
      knowledgePoints: ['一元一次方程'],
      quality: 'good',
    });
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'resp_struct', model: 'qwen3.7-max',
        content: `你观察一下等式两边，有什么发现？\n\`\`\`json\n${structuredJson}\n\`\`\``,
        finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
      }),
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    const result = await capability.tutor({
      studentId: 'student_1',
      mode: 'auxiliary',
      message: '老师，一元一次方程怎么解？',
      dialogueId: String(dialogueId),
    });

    expect(result.structuredQuestion).toBeDefined();
    expect(result.structuredQuestion!.type).toBe('short_answer');
    expect(result.structuredQuestion!.content).toBe('解方程 2x+3=7');
    expect(result.structuredQuestion!.answer).toBe('x=2');
    // JSON block should be stripped from displayed content
    expect(result.message.content).not.toContain('```json');
    expect(result.message.content).toContain('你观察一下等式两边');
  });

  it('does not set structuredQuestion when model reply has no JSON block', async () => {
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'resp_nojson', model: 'qwen3.7-max',
        content: '你观察一下等式两边，有什么发现？',
        finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
      }),
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    const result = await capability.tutor({
      studentId: 'student_1',
      mode: 'auxiliary',
      message: '老师，一元一次方程怎么解？',
      dialogueId: String(dialogueId),
    });

    expect(result.structuredQuestion).toBeUndefined();
  });

  it('persists assistant content without the JSON block in conversation history', async () => {
    const structuredJson = JSON.stringify({
      type: 'short_answer', difficulty: 1, content: '1+1=?', answer: '2',
      explanation: 'basic', knowledgePoints: ['加法'], quality: 'good',
    });
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'resp_persist', model: 'qwen3.7-max',
        content: `好题目！\n\`\`\`json\n${structuredJson}\n\`\`\``,
        finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
      }),
    } as unknown as ModelClient;

    const capability = new TutoringCapability(convService, { modelClient: mockModelClient });
    await capability.tutor({
      studentId: 'student_1',
      mode: 'auxiliary',
      message: '老师，1+1等于几？',
      dialogueId: String(dialogueId),
    });

    const persisted = await convService.loadContext(String(dialogueId), 3000);
    const assistantMsg = persisted!.messages.find(m => m.role === 'assistant' && contentToText(m.content).includes('好题目'));
    expect(assistantMsg).toBeDefined();
    expect(contentToText(assistantMsg!.content)).not.toContain('```json');
  });
});

describe('TutoringCapability.generateTitle（title 路由：local -> deepseek）', () => {
  const localModel = { provider: 'local', modelId: 'Qwen3.8-27B', baseUrl: 'http://x', contextWindow: 1, maxOutputTokens: 1, costPer1K: { input: 0, output: 0 }, supportsStreaming: true };
  const dsModel = { provider: 'deepseek', modelId: 'deepseek-flash', baseUrl: 'http://y', contextWindow: 1, maxOutputTokens: 1, costPer1K: { input: 0, output: 0 }, supportsStreaming: true };

  function mk(chatImpl: (req: any) => Promise<{ content: string }>) {
    const modelClient = { chat: vi.fn(chatImpl) };
    const cap: any = new TutoringCapability({} as any, { modelClient: modelClient as any });
    cap.modelRouter = { route: () => ({ primary: localModel, fallback: dsModel, reason: 'test' }) };
    return { cap, modelClient };
  }

  it('本地可用时用本地模型（不碰兜底）', async () => {
    const { cap, modelClient } = mk(async ({ model }: any) => ({
      content: model.modelId === 'Qwen3.8-27B' ? '本地标题' : '兜底标题',
    }));
    expect(await cap.generateTitle('问题', '回复')).toBe('本地标题');
    expect(modelClient.chat).toHaveBeenCalledTimes(1);
  });

  it('本地失败时回退 deepseek-flash', async () => {
    const { cap, modelClient } = mk(async ({ model }: any) => {
      if (model.modelId === 'Qwen3.8-27B') throw new Error('local down');
      return { content: '兜底标题' };
    });
    expect(await cap.generateTitle('问题', '回复')).toBe('兜底标题');
    expect(modelClient.chat).toHaveBeenCalledTimes(2);
  });

  it('两个模型都失败时返回 null（不改标题）', async () => {
    const { cap, modelClient } = mk(async () => { throw new Error('down'); });
    await expect(cap.generateTitle('问题', '回复')).resolves.toBeNull();
    expect(modelClient.chat).toHaveBeenCalledTimes(2);
  });

  it('模型返回 NONE 时不改标题', async () => {
    const { cap } = mk(async () => ({ content: 'NONE' }));
    await expect(cap.generateTitle('问题', '回复')).resolves.toBeNull();
  });
});
