import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import type { AiDialogueScene } from '../../database/repositories/types';

class FakeDialoguesRepo {
  rows: any[] = [];
  nextId = 1;
  async create(row: any) {
    const id = this.nextId++;
    const rec = {
      id,
      ...row,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    };
    this.rows.push(rec);
    return id;
  }
  async findById(id: number) {
    return this.rows.find((r) => r.id === id && !r.deleted_at) ?? null;
  }
  async findByStudentTrackSceneQuestion(studentId: number, track: string, scene: AiDialogueScene, questionId: number) {
    const hits = this.rows
      .filter((r) => r.student_id === studentId && r.track === track && r.scene === scene && r.question_id === questionId && !r.deleted_at)
      .sort((a, b) => b.id - a.id);
    return hits[0] ?? null;
  }
  async findByStudentAndTrack(studentId: number, track: string, limit: number, _cursor?: number, scene?: AiDialogueScene) {
    return this.rows
      .filter((r) => r.student_id === studentId && r.track === track && !r.deleted_at && (!scene || r.scene === scene))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
  async findMainlineByStudentAndCard() { return null; }
  async updateTitle() {}
  async softDelete() {}
}

class FakeMessagesRepo {
  rows: any[] = [];
  nextId = 1;
  async create(row: any) {
    this.rows.push({ id: this.nextId++, ...row });
    return this.rows.length;
  }
  async findByDialogue(dialogueId: number) {
    return this.rows.filter((r) => r.dialogue_id === dialogueId);
  }
  async softDelete() {}
}

describe('ConversationsService (scene 分型 + 训练讲一讲按题锚定)', () => {
  let svc: ConversationsService;
  let dialogues: FakeDialoguesRepo;
  let messages: FakeMessagesRepo;

  beforeEach(() => {
    dialogues = new FakeDialoguesRepo();
    messages = new FakeMessagesRepo();
    svc = new ConversationsService(dialogues as any, messages as any);
  });

  it('aux_qna：总是新建，scene/question_id 落库正确', async () => {
    const a = await svc.create(1, { track: 'auxiliary' });
    const b = await svc.create(1, { track: 'auxiliary' });
    expect(a!.scene).toBe('aux_qna');
    expect(a!.question_id).toBeNull();
    expect(b!.id).not.toBe(a!.id);  // 自由问答不复用
  });

  it('aux_training：同一道题复用既有会话，不重复写题面锚', async () => {
    const first = await svc.create(1, {
      track: 'auxiliary',
      scene: 'aux_training',
      questionId: 7,
      questionText: '解方程 2x+3=7',
    });
    expect(first!.scene).toBe('aux_training');
    expect(first!.question_id).toBe(7);
    // 新建时只写一条 assistant 题面锚消息
    expect((await messages.findByDialogue(first!.id)).filter((m) => m.role === 'assistant')).toHaveLength(1);

    const second = await svc.create(1, {
      track: 'auxiliary',
      scene: 'aux_training',
      questionId: 7,
      questionText: '解方程 2x+3=7',
    });
    expect(second!.id).toBe(first!.id);  // 复用，不新建
    expect(messages.rows.filter((m) => m.dialogue_id === first!.id)).toHaveLength(1);  // 未重复写锚
  });

  it('aux_training：不同题新建会话并各自写题面锚', async () => {
    const a = await svc.create(1, { track: 'auxiliary', scene: 'aux_training', questionId: 1, questionText: '题A' });
    const b = await svc.create(1, { track: 'auxiliary', scene: 'aux_training', questionId: 2, questionText: '题B' });
    expect(b!.id).not.toBe(a!.id);
    expect(messages.rows).toHaveLength(2);
  });

  it('aux_training：无 questionId（孤儿题）退化为新建，scene 仍隔离', async () => {
    const a = await svc.create(1, { track: 'auxiliary', scene: 'aux_training', questionText: '孤儿题' });
    const b = await svc.create(1, { track: 'auxiliary', scene: 'aux_training', questionText: '孤儿题' });
    expect(a!.question_id).toBeNull();
    expect(b!.id).not.toBe(a!.id);  // 无锚不复用
    expect(messages.rows.filter((m) => m.role === 'assistant')).toHaveLength(2);  // 每次新建各写一次锚
  });

  it('无 questionText 的新建会话不写题面锚', async () => {
    const c = await svc.create(1, { track: 'auxiliary', scene: 'aux_training', questionId: 9 });
    expect(messages.rows.filter((m) => m.dialogue_id === c!.id)).toHaveLength(0);
  });

  it('scene 与 track 不匹配时报错', async () => {
    await expect(
      svc.create(1, { track: 'auxiliary', scene: 'mainline_card' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.create(1, { track: 'mainline', scene: 'aux_training' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('list 支持按 scene 过滤', async () => {
    await svc.create(1, { track: 'auxiliary' });  // aux_qna
    await svc.create(1, { track: 'auxiliary', scene: 'aux_training', questionId: 3, questionText: '题' });
    const qna = await svc.list(1, 'auxiliary', undefined, 'aux_qna');
    const training = await svc.list(1, 'auxiliary', undefined, 'aux_training');
    expect(qna.every((r) => r.scene === 'aux_qna')).toBe(true);
    expect(qna).toHaveLength(1);
    expect(training).toHaveLength(1);
    expect(training[0].scene).toBe('aux_training');
  });
});
