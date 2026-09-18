import { describe, it, expect, vi } from 'vitest';
import { ChatLogsService } from './chat-logs.service.js';

const logRow = {
  id: 55, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值', subjectId: null,
  createdAt: new Date('2026-09-16T10:00:00Z'), updatedAt: new Date('2026-09-16T10:05:00Z'),
  messageCount: 8, blockCount: 2,
};

const dialogueRow = {
  id: 55, student_id: 11, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值',
  subject_id: null, created_at: new Date('2026-09-16T10:00:00Z'),
  updated_at: new Date('2026-09-16T10:05:00Z'),
};

const messageRow = (over: Record<string, any> = {}) => ({
  id: 201, dialogue_id: 55, role: 'user', content: '怎么求最值', reasoning: null,
  type: null, attachments: null, model: null, token_input: null, token_output: null,
  response_time_ms: null, safety_flag: 0, created_at: new Date('2026-09-16T10:00:30Z'),
  deleted_at: null,
  ...over,
});

const mk = () => ({
  repo: { listParentChatLogs: vi.fn().mockResolvedValue({ items: [logRow], total: 80 }) },
  dialoguesRepo: { findById: vi.fn().mockResolvedValue(dialogueRow) },
  messagesRepo: { findByDialogue: vi.fn().mockResolvedValue([messageRow()]) },
});

const mkSvc = (d: ReturnType<typeof mk>) =>
  new ChatLogsService(d.repo as any, d.dialoguesRepo as any, d.messagesRepo as any);

describe('ChatLogsService：列表', () => {
  it('pageSize 固定 20，offset 由 page 推；筛选透传', async () => {
    const d = mk();

    const result = await mkSvc(d).listChatLogs(11, {
      page: 2, track: 'auxiliary', scene: 'aux_qna', from: '2026-09-01', to: '2026-09-18', q: '函数',
    });

    expect(d.repo.listParentChatLogs).toHaveBeenCalledWith(
      11,
      { track: 'auxiliary', scene: 'aux_qna', from: '2026-09-01', to: '2026-09-18', q: '函数' },
      20,
      20,
    );
    expect(result).toMatchObject({ page: 2, pageSize: 20, total: 80 });
    expect(result.items[0]).toMatchObject({ id: 55, track: 'auxiliary', messageCount: 8, blockCount: 2 });
  });

  it('无筛选 → 空 filters（不塞 undefined 字段）', async () => {
    const d = mk();

    await mkSvc(d).listChatLogs(11, { page: 1 });

    expect(d.repo.listParentChatLogs).toHaveBeenCalledWith(11, {}, 20, 0);
  });

  it('无数据 → items 空 + total 0', async () => {
    const d = mk();
    d.repo.listParentChatLogs.mockResolvedValue({ items: [], total: 0 });

    expect(await mkSvc(d).listChatLogs(11, { page: 1 })).toEqual({
      items: [], page: 1, pageSize: 20, total: 0,
    });
  });
});

describe('ChatLogsService：详情', () => {
  it('返回逐句消息（含 reasoning 与 safetyFlag）', async () => {
    const d = mk();
    d.messagesRepo.findByDialogue.mockResolvedValue([
      messageRow(),
      messageRow({ id: 202, role: 'assistant', content: '先判断开口方向', reasoning: '开口向上', type: 'socratic', model: 'qwen3.8-max' }),
      messageRow({ id: 203, role: 'assistant', content: '我是你的学习助手…', type: 'block', safety_flag: 1 }),
    ]);

    const result = await mkSvc(d).getChatLog(11, 55);

    expect(d.messagesRepo.findByDialogue).toHaveBeenCalledWith(55);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toMatchObject({
      id: 202, role: 'assistant', reasoning: '开口向上', type: 'socratic', model: 'qwen3.8-max', safetyFlag: 0,
    });
    expect(result.messages[2].safetyFlag).toBe(1);
  });

  it('不返回 token / 耗时字段（恒 NULL，返回只会误导）', async () => {
    const d = mk();

    const result = await mkSvc(d).getChatLog(11, 55);

    // mysql2 返回的行是 snake_case：只钉 camelCase 会被 `{ ...m }` 展开式实现骗过
    expect(result.messages[0]).not.toHaveProperty('token_input');
    expect(result.messages[0]).not.toHaveProperty('token_output');
    expect(result.messages[0]).not.toHaveProperty('response_time_ms');
    // camelCase 版本一并覆盖（两面都别泄漏）
    expect(result.messages[0]).not.toHaveProperty('tokenInput');
    expect(result.messages[0]).not.toHaveProperty('tokenOutput');
    expect(result.messages[0]).not.toHaveProperty('responseTimeMs');
  });

  it('会话不存在 → 1002', async () => {
    const d = mk();
    d.dialoguesRepo.findById.mockResolvedValue(null);

    await expect(mkSvc(d).getChatLog(11, 55)).rejects.toMatchObject({
      response: { code: 1002 },
    });
  });

  it('会话属于别的学生 → 1002（不泄漏存在性，防 IDOR）', async () => {
    const d = mk();
    d.dialoguesRepo.findById.mockResolvedValue({ ...dialogueRow, student_id: 999 });

    await expect(mkSvc(d).getChatLog(11, 55)).rejects.toMatchObject({
      response: { code: 1002 },
    });
    expect(d.messagesRepo.findByDialogue).not.toHaveBeenCalled();
  });

  it('详情的 updatedAt 与列表同口径：取最后一条消息时间，而不是 dialogue.updated_at', async () => {
    const d = mk();
    // 对话行的 updated_at（若被误用）会明显早于最后一条消息
    d.dialoguesRepo.findById.mockResolvedValue({
      ...dialogueRow,
      updated_at: new Date('2026-09-16T09:00:00Z'),
    });
    d.messagesRepo.findByDialogue.mockResolvedValue([
      messageRow({ id: 201, created_at: new Date('2026-09-16T10:00:30Z') }),
      messageRow({ id: 202, created_at: new Date('2026-09-16T10:07:00Z') }),
    ]);

    const result = await mkSvc(d).getChatLog(11, 55);

    expect(result.updatedAt).toEqual(new Date('2026-09-16T10:07:00Z'));
  });

  it('会话没有任何消息 → updatedAt 退回 dialogue.created_at', async () => {
    const d = mk();
    d.messagesRepo.findByDialogue.mockResolvedValue([]);

    const result = await mkSvc(d).getChatLog(11, 55);

    expect(result.updatedAt).toEqual(dialogueRow.created_at);
  });
});
