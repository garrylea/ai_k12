// tutoring-quality.ts
// Scenarios of "student message -> AI guidance" for human evaluation of Socratic quality.
// Requires API keys to run.
// Run: npx tsx src/ai-core/__tests__/tutoring-quality.ts

import { TutoringCapability } from '../capabilities/tutoring.capability.js';
import { ConversationService } from '../../services/conversation/index.js';

interface TutoringScenario {
  id: string;
  description: string;
  studentMessage: string;
  expectedBehavior: string; // e.g., "should ask guiding question, not give answer"
}

const SCENARIOS: TutoringScenario[] = [
  {
    id: 'socratic_001',
    description: '直接问答案 -> 应引导而非直接给答案',
    studentMessage: '3x + 5 = 14，x等于多少？直接告诉我答案吧',
    expectedBehavior: '不应直接给答案，应引导观察等式结构',
  },
  {
    id: 'socratic_002',
    description: '错了一步 -> 应指出错误并引导纠正',
    studentMessage: '我算出来 2x+3=7 的解是 x=5，对吗？',
    expectedBehavior: '应指出计算错误，引导重新求解而非直接给答案',
  },
  {
    id: 'socratic_003',
    description: '概念不清 -> 应通过提问定位误解',
    studentMessage: '我不明白什么是移项',
    expectedBehavior: '应通过提问了解学生的具体困惑，再举例引导',
  },
  {
    id: 'socratic_004',
    description: '正确解答 -> 应肯定并引导拓展',
    studentMessage: '2x+3=7，我算出 x=2',
    expectedBehavior: '应肯定正确，并引导思考更一般的情况或变式',
  },
  {
    id: 'socratic_005',
    description: '反复出错 -> 触发 fallback 给完整解析',
    studentMessage: '我不会做',
    expectedBehavior: '触发 fallback，给出分步完整解析而非继续反问',
  },
  {
    id: 'socratic_006',
    description: '跑题 -> 安全拦截，温和引导回学习',
    studentMessage: '今天天气真好，我们去玩吧',
    expectedBehavior: '安全拦截（block），温和引导回学习主题',
  },
];

// Minimal in-memory fakes so the eval script can run without a real DB.
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
  async findById(_id: number) {
    return { id: _id, grade: '七年级', schoolLevel: 'junior', name: '测试学生' };
  }
}

async function runTutoringTests(): Promise<void> {
  for (const scenario of SCENARIOS) {
    // Fresh fakes per scenario (replaces the old convService._reset() call).
    const dialogues = new FakeDialoguesRepo();
    const messages = new FakeMessagesRepo();
    const students = new FakeStudentsRepo();
    const convService = new ConversationService(dialogues as any, messages as any, students as any);

    const dialogueId = await convService.createDialogue({
      studentId: 1,
      subject: 'math',
      track: 'auxiliary',
      currentKnowledgePoint: { id: 'kp_1', name: '一元一次方程', subject: 'math' },
      currentDifficulty: 1,
      currentQuestion: { content: '解方程 2x+3=7', answer: 'x=2' },
    });

    const capability = new TutoringCapability(convService);
    try {
      const result = await capability.tutor({
        studentId: 'test_student',
        mode: 'auxiliary',
        message: scenario.studentMessage,
        dialogueId: String(dialogueId),
      });

      console.log(`[${scenario.id}] ${scenario.description}`);
      console.log(`  Response: ${result.message.content.slice(0, 150)}...`);
      console.log(`  Reasoning: ${result.reasoning ? result.reasoning.slice(0, 80) + '...' : '(none)'}`);
      console.log(`  Type: ${result.message.type}`);
      console.log(`  Expected: ${scenario.expectedBehavior}`);
      console.log('');
    } catch (e) {
      console.error(`[${scenario.id}] Error:`, e);
    }
  }
}

runTutoringTests();
