import { describe, it, expect, vi } from 'vitest';
import { AdminChatService } from './admin-chat.service';

const mk = (o: any = {}) => ({
  chatRepo: {
    createDialogue: vi.fn().mockResolvedValue(1), findDialogue: vi.fn().mockResolvedValue({ id: 1, adminId: 1, modelKey: 'm1', title: null, updatedAt: new Date() }),
    listDialogues: vi.fn().mockResolvedValue([]), deleteDialogue: vi.fn(),
    addMessage: vi.fn(), listMessages: vi.fn().mockResolvedValue([]),
  },
  modelsRepo: { listEnabled: vi.fn().mockResolvedValue([{ modelKey: 'm1', providerType: 'kimi', modelId: 'm1', baseUrl: 'https://x', apiKey: 'sk-1', contextWindow: 8, maxOutputTokens: 8, isEnabled: true }]) },
  modelClient: {
    streamChat: async function* () { yield { content: '你' }; yield { content: '好' }; },
  },
  ...o,
});
const svc = (d: any) => new AdminChatService(d.chatRepo, d.modelsRepo, d.modelClient);

describe('AdminChatService', () => {
  it('新建会话校验模型启用中（1004）', async () => {
    await expect(svc(mk()).createDialogue(1, 'ghost')).rejects.toMatchObject({ response: { code: 1004 } });
  });

  it('新建会话成功返回 id', async () => {
    const r = await svc(mk()).createDialogue(1, 'm1');
    expect(r.id).toBe(1);
  });

  it('流式对话：事件序列 + 落库 user/assistant', async () => {
    const d = mk();
    const events: any[] = [];
    for await (const e of svc(d).chatStream({ dialogueId: 1, message: 'hi' }, 1)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['message', 'message', 'done']);
    expect(events[0].delta).toBe('你');
    expect(events[1].delta).toBe('好');
    expect(d.chatRepo.addMessage).toHaveBeenCalledWith(1, 'user', 'hi');
    expect(d.chatRepo.addMessage).toHaveBeenCalledWith(1, 'assistant', '你好', undefined);
  });

  it('非本人会话 -> 1005', async () => {
    const d = mk({ chatRepo: { ...mk().chatRepo, findDialogue: vi.fn().mockResolvedValue({ id: 1, adminId: 999, modelKey: 'm1', title: null, updatedAt: new Date() }) } });
    await expect(async () => { for await (const _ of svc(d).chatStream({ dialogueId: 1, message: 'x' }, 1)) {} })
      .rejects.toMatchObject({ response: { code: 1005 } });
  });
});
