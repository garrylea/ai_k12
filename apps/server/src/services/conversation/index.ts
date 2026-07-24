import type { Message, LoadContextResponse, Difficulty, Subject } from '../../ai-core/types.js';
import type { DialogueRecord, SaveMessagesRequest, UpdateFailCountRequest, CompleteDialogueRequest } from './types.js';

export interface CreateDialogueParams {
  dialogueId: string;
  student: { grade: string; gradeLevel: string; name: string };
  subject: Subject;
  cardContent?: string;
  track: 'mainline' | 'auxiliary';
  currentKnowledgePoint?: { id: string; name: string; subject: string };
  currentDifficulty?: Difficulty;
  currentQuestion?: { content: string; answer?: string };
}

export class ConversationService {
  private dialogues = new Map<string, DialogueRecord>();

  createDialogue(params: CreateDialogueParams): void {
    this.dialogues.set(params.dialogueId, {
      dialogueId: params.dialogueId,
      messages: [],
      failCount: 0,
      student: params.student,
      subject: params.subject,
      cardContent: params.cardContent,
      track: params.track,
      currentKnowledgePoint: params.currentKnowledgePoint,
      currentDifficulty: params.currentDifficulty,
      currentQuestion: params.currentQuestion,
      createdAt: new Date(),
    });
  }

  loadContext(dialogueId: string, tokenBudget: number = 4000): LoadContextResponse | null {
    const record = this.dialogues.get(dialogueId);
    if (!record) return null;

    let messages = [...record.messages];
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const charBudget = tokenBudget * 2;

    if (totalChars > charBudget) {
      const last4 = messages.slice(-4);
      const last4Chars = last4.reduce((sum, m) => sum + m.content.length, 0);
      const remainingBudget = charBudget - last4Chars;

      const older = messages.slice(0, -4);
      const summaries: Message[] = [];
      const batchCount = Math.max(1, Math.ceil(older.length / 6));
      for (let i = 0; i < older.length; i += 6) {
        const batch = older.slice(i, i + 6);
        const summary = `[对话摘要] ${batch.map(m => `${m.role}: ${m.content.slice(0, 30)}...`).join(' | ')}`;
        if (summary.length <= remainingBudget / batchCount) {
          summaries.push({ role: 'system', content: summary });
        }
      }
      messages = [...summaries, ...last4];
    }

    return {
      messages,
      student: record.student,
      subject: record.subject,
      cardContent: record.cardContent,
      currentKnowledgePoint: record.currentKnowledgePoint,
      currentDifficulty: record.currentDifficulty,
      currentQuestion: record.currentQuestion,
      consecutiveFailCount: record.failCount,
      dialogueMetadata: {
        track: record.track,
        createdAt: record.createdAt,
        messageCount: record.messages.length,
      },
    };
  }

  saveMessages(request: SaveMessagesRequest): void {
    const record = this.dialogues.get(request.dialogueId);
    if (!record) throw new Error(`Dialogue not found: ${request.dialogueId}`);
    for (const msg of request.messages) {
      record.messages.push({ role: msg.role, content: msg.content });
    }
  }

  updateFailCount(request: UpdateFailCountRequest): void {
    const record = this.dialogues.get(request.dialogueId);
    if (!record) throw new Error(`Dialogue not found: ${request.dialogueId}`);
    if (request.increment) {
      record.failCount += 1;
    } else {
      record.failCount = 0;
    }
  }

  completeDialogue(request: CompleteDialogueRequest): void {
    const record = this.dialogues.get(request.dialogueId);
    if (!record) throw new Error(`Dialogue not found: ${request.dialogueId}`);
    record.completedAt = new Date();
    record.completeReason = request.reason;
  }

  _reset(): void {
    this.dialogues.clear();
  }
}
