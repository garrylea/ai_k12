// off-topic-marker.ts
// Task 0 阻塞验证门（spec 2026-09-20-parent-controls-and-alerts-design §3.2）。
// 验证模型是否按提示词在「闲聊」轮次输出 `<!--topic:off-->`、在「学习相关」轮次不输出。
// 走辅线（track=auxiliary）+ 真实模型调用（需 .env 的 QWEN_API_KEY / DEEPSEEK_API_KEY）。
// Run: npx tsx src/ai-core/__tests__/off-topic-marker.ts
//
// ⚠️ 2026-09-20（Task 5）**观测点变更**：`parseContent` 现在会剥离该标记（标记不该进
// 学生端内容、也不该进历史），所以「标记是否存在」**不能再从 `result.message.content`
// 观察** —— 旧断言在 Task 5 之后恒为 false（原样重跑会误报 2/3「方案 A 不通过」，
// 实测原始输出见 `.superpowers/sdd/task-5-report.md`）。
// 现在从**标记的下游产物**观察：注入一个假 sink，看 tutoring 侧是否真的写了一条
// `off_topic` 预警（这正是标记在生产里唯一的消费方式）；同时仍断言学生端内容**不含**标记。
//
// 另注：`recordSafetySignals` 只接受**数字** studentId（生产是 JWT 的 user.sub），
// 所以这里传 '1'；传 'test_student' 会因 `Number()` 为 NaN 而被静默跳过。

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

/** 假 sink：记录 tutoring 侧实际写进来的预警（`off_topic` 是标记的唯一消费方式）。 */
class FakeSafetyAlerts {
  calls: { type: string; level: string; message: string; context: string | null }[] = [];
  record(input: { type: string; level: string; message: string; context: string | null }): void {
    this.calls.push(input);
  }
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

    const safety = new FakeSafetyAlerts();
    const capability = new TutoringCapability(convService, { safetyAlerts: safety as any });

    console.log('='.repeat(72));
    console.log(`[${sample.id}] ${sample.label}`);
    console.log(`学生：${sample.studentMessage}`);

    try {
      const result = await capability.tutor({
        studentId: '1',
        mode: 'auxiliary',
        message: sample.studentMessage,
        dialogueId: String(dialogueId),
      });

      const content = result.message.content ?? '';
      const offTopicSignals = safety.calls.filter((c) => c.type === 'off_topic');
      const signalRecorded = offTopicSignals.length > 0;
      const markerLeaked = content.includes(MARKER);
      const ok = signalRecorded === sample.expectMarker && !markerLeaked;

      console.log(`--- 模型回复（已剥离标记，${content.length} 字）---`);
      console.log(content);
      console.log('--- 检测 ---');
      console.log(`模型自报闲聊（sink 收到 off_topic 预警）：${signalRecorded}（期望 ${sample.expectMarker}）`);
      console.log(`标记残留于学生端内容：${markerLeaked}（期望 false）`);
      if (signalRecorded) {
        console.log(`预警 level：${offTopicSignals[0].level}；context：${offTopicSignals[0].context}`);
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
