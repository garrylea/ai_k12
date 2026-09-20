import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationService } from './index.js';

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

class FakeCardsRepo {
  async findContentById(_cardId: number) { return null; }
}

describe('ConversationService', () => {
  let svc: ConversationService;
  let dialogues: FakeDialoguesRepo;
  let messages: FakeMessagesRepo;
  let students: FakeStudentsRepo;
  let cards: FakeCardsRepo;
  let dialogueId: number;

  beforeEach(async () => {
    dialogues = new FakeDialoguesRepo();
    messages = new FakeMessagesRepo();
    students = new FakeStudentsRepo();
    cards = new FakeCardsRepo();
    svc = new ConversationService(dialogues as any, messages as any, students as any, cards as any);
    dialogueId = await svc.createDialogue({
      studentId: 1,
      subject: 'math',
      track: 'mainline',
      currentKnowledgePoint: { id: 'kp1', name: '一元一次方程', subject: 'math' },
      currentDifficulty: 2,
      currentQuestion: { content: '解 2x=4', answer: 'x=2' },
    });
  });

  it('loadContext returns metadata and current KP', async () => {
    const ctx = await svc.loadContext(String(dialogueId));
    expect(ctx).not.toBeNull();
    expect(ctx!.student.name).toBe('小明');
    expect(ctx!.consecutiveFailCount).toBe(0);
    expect(ctx!.dialogueMetadata.track).toBe('mainline');
  });

  it('loadContext returns null for unknown dialogue', async () => {
    expect(await svc.loadContext('99999')).toBeNull();
  });

  it('loadContext returns null for non-numeric dialogueId', async () => {
    expect(await svc.loadContext('not-a-number')).toBeNull();
  });

  it('saveMessages appends to history', async () => {
    await svc.saveMessages({ dialogueId: String(dialogueId), messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]});
    const ctx = await svc.loadContext(String(dialogueId));
    expect(ctx!.messages).toHaveLength(2);
    expect(ctx!.messages[0].content).toBe('hello');
  });

  it('saveMessages throws for unknown dialogue', async () => {
    await expect(svc.saveMessages({ dialogueId: '99999', messages: [] })).rejects.toThrow(/not found/i);
  });

  // --- safety_flag 回写（spec §3.2，2026-09-20 双来源口径）------------------------
  // `FakeMessagesRepo.rows` 是**列名键控**的对象，`row.safety_flag` 天然「列↔值配对」。
  // 每条断言都用 content 锚定到具体那一行，避免只靠数组位置。

  it('saveMessages：显式 safetyFlag 优先于 type==="block" 推导（两个方向都优先）', async () => {
    await svc.saveMessages({ dialogueId: String(dialogueId), messages: [
      // 显式 false + block：显式优先 → 0（若走推导会给 1）
      { role: 'assistant', content: '阻断文案', type: 'block', safetyFlag: false },
      // 显式 true + socratic：显式优先 → 1（若走推导会给 0）
      { role: 'assistant', content: '闲聊回复', type: 'socratic', safetyFlag: true },
    ]});

    const byContent = (text: string) => messages.rows.find((r) => r.content === text)!.safety_flag;
    expect(byContent('阻断文案')).toBe(0);
    expect(byContent('闲聊回复')).toBe(1);
  });

  it('saveMessages：未传 safetyFlag 时行为不变（block→1、其余→0）', async () => {
    await svc.saveMessages({ dialogueId: String(dialogueId), messages: [
      { role: 'assistant', content: '阻断轮', type: 'block' },
      { role: 'assistant', content: '苏格拉底轮', type: 'socratic' },
      { role: 'user', content: '学生提问' },
    ]});

    const byContent = (text: string) => messages.rows.find((r) => r.content === text)!.safety_flag;
    expect(byContent('阻断轮')).toBe(1);
    expect(byContent('苏格拉底轮')).toBe(0);
    expect(byContent('学生提问')).toBe(0);
  });

  it('saveMessages：safety_flag=1 的两个来源（模型自报闲聊 / anomaly 阻断）都落成 1', async () => {
    await svc.saveMessages({ dialogueId: String(dialogueId), messages: [
      { role: 'assistant', content: '闲聊轮', type: 'socratic', safetyFlag: true },
      { role: 'assistant', content: '敏感轮', type: 'block' },
    ]});

    const byContent = (text: string) => messages.rows.find((r) => r.content === text)!.safety_flag;
    expect(byContent('闲聊轮')).toBe(1);
    expect(byContent('敏感轮')).toBe(1);
  });

  it('updateFailCount increments and resets', async () => {
    await svc.updateFailCount({ dialogueId: String(dialogueId), increment: true });
    await svc.updateFailCount({ dialogueId: String(dialogueId), increment: true });
    let ctx = await svc.loadContext(String(dialogueId));
    expect(ctx!.consecutiveFailCount).toBe(2);
    await svc.updateFailCount({ dialogueId: String(dialogueId), increment: false });
    ctx = await svc.loadContext(String(dialogueId));
    expect(ctx!.consecutiveFailCount).toBe(0);
  });

  it('completeDialogue does not throw for existing dialogue', async () => {
    await expect(svc.completeDialogue({ dialogueId: String(dialogueId) })).resolves.toBeUndefined();
  });

  it('truncates long history to fit token budget (keeps last 4)', async () => {
    for (let i = 0; i < 20; i++) {
      await svc.saveMessages({ dialogueId: String(dialogueId), messages: [
        { role: 'user', content: 'X'.repeat(500) },
        { role: 'assistant', content: 'Y'.repeat(500) },
      ]});
    }
    const ctx = await svc.loadContext(String(dialogueId), 100);
    expect(ctx!.messages.length).toBeLessThan(40);
    expect(ctx!.messages.length).toBeGreaterThanOrEqual(4);
  });
});
