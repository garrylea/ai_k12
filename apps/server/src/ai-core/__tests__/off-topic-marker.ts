// off-topic-marker.ts
// Task 0 阻塞验证门（spec 2026-09-20-parent-controls-and-alerts-design §3.2）。
// 验证模型是否按提示词在「闲聊」轮次输出 `<!--topic:off-->`、在「学习相关」轮次不输出。
// 走辅线（track=auxiliary）+ 真实模型调用（需 .env 的 QWEN_API_KEY / DEEPSEEK_API_KEY）。
// Run: npx tsx src/ai-core/__tests__/off-topic-marker.ts

import { TutoringCapability } from '../capabilities/tutoring.capability.js';
import { ConversationService } from '../../services/conversation/index.js';

const MARKER = '<!--topic:off-->';

interface Sample {
  id: string;
  label: string;
  studentMessage: string;
  expectMarker: boolean;
}

const SAMPLES: Sample[] = [
  {
    id: 'sample_1',
    label: '① 数学题（期望：无标记）',
    studentMessage: '3x + 5 = 14，x 等于多少？',
    expectMarker: false,
  },
  {
    id: 'sample_2',
    label: '② 语文理解题（期望：无标记 —— 现状关键词分类器会误判的那类）',
    studentMessage: '这首诗表达了什么情感？',
    expectMarker: false,
  },
  {
    id: 'sample_3',
    label: '③ 闲聊（期望：有标记）',
    studentMessage: '你喜欢什么游戏？',
    expectMarker: true,
  },
];

// Minimal in-memory fakes so the script runs without a real DB (same pattern as tutoring-quality.ts).
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

/** 标记是否出现在「最后一行且独占该行」。 */
function markerPlacement(content: string): { present: boolean; onLastLineAlone: boolean; lineIndex: number } {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.includes(MARKER));
  if (idx === -1) return { present: false, onLastLineAlone: false, lineIndex: -1 };
  const lastNonEmpty = [...lines].reverse().findIndex((l) => l.trim() !== '');
  const lastNonEmptyIdx = lastNonEmpty === -1 ? -1 : lines.length - 1 - lastNonEmpty;
  return {
    present: true,
    onLastLineAlone: idx === lastNonEmptyIdx && lines[idx].trim() === MARKER,
    lineIndex: idx,
  };
}

async function run(): Promise<void> {
  let passed = 0;

  for (const sample of SAMPLES) {
    const dialogues = new FakeDialoguesRepo();
    const messages = new FakeMessagesRepo();
    const students = new FakeStudentsRepo();
    const convService = new ConversationService(
      dialogues as any,
      messages as any,
      students as any,
      { findContentById: async () => null } as any,
    );

    const dialogueId = await convService.createDialogue({
      studentId: 1,
      subject: 'math',
      track: 'auxiliary',
      currentKnowledgePoint: { id: 'kp_1', name: '一元一次方程', subject: 'math' },
      currentDifficulty: 1,
      currentQuestion: { content: '解方程 2x+3=7', answer: 'x=2' },
    });

    const capability = new TutoringCapability(convService);

    console.log('='.repeat(72));
    console.log(`[${sample.id}] ${sample.label}`);
    console.log(`学生：${sample.studentMessage}`);

    try {
      const result = await capability.tutor({
        studentId: 'test_student',
        mode: 'auxiliary',
        message: sample.studentMessage,
        dialogueId: String(dialogueId),
      });

      const content = result.message.content ?? '';
      const placement = markerPlacement(content);
      const ok = placement.present === sample.expectMarker;

      console.log(`--- 模型原始回复（${content.length} 字）---`);
      console.log(content);
      console.log('--- 检测 ---');
      console.log(`标记存在：${placement.present}（期望 ${sample.expectMarker}）`);
      if (placement.present) {
        console.log(`标记所在行号：${placement.lineIndex}；独占最后一行：${placement.onLastLineAlone}`);
      }
      console.log(`结果：${ok ? 'PASS' : 'FAIL'}`);
      if (ok) passed++;
    } catch (e) {
      console.error(`[${sample.id}] 调用异常：`, e instanceof Error ? e.message : e);
    }
    console.log('');
  }

  console.log('='.repeat(72));
  console.log(`Task 0 判定：${passed}/${SAMPLES.length} 符合预期`);
  console.log(passed === SAMPLES.length ? '→ 采用方案 A（模型自报标记）' : '→ 方案 A 不通过，需切方案 B（并行 LLM 分类器）');
}

run();
