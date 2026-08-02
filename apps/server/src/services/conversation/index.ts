import { Injectable } from '@nestjs/common';
import type { Message, LoadContextResponse, Subject, Track, Difficulty } from '../../ai-core/types.js';
import type { SaveMessagesRequest, UpdateFailCountRequest, CompleteDialogueRequest } from './types.js';
import { AiDialoguesRepository, AiMessagesRepository } from '../../database/repositories/index.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';

export interface CreateDialogueParams {
  dialogueId: string;          // kept for compatibility; the DB id is what matters
  studentId: number;            // NEW: required for DB persistence
  subject: Subject;             // string union 'math' | 'chinese' | 'english'
  cardContent?: string;         // mainline only; NOT persisted in ai_dialogues (no column)
  track: Track;
  currentKnowledgePoint?: { id: string; name: string; subject: string };
  currentDifficulty?: Difficulty;  // NOT persisted in ai_dialogues (no column)
  currentQuestion?: { content: string; answer?: string };  // NOT persisted (no column)
}

@Injectable()
export class ConversationService {
  constructor(
    private readonly dialoguesRepo: AiDialoguesRepository,
    private readonly messagesRepo: AiMessagesRepository,
    private readonly studentsRepo: StudentsRepository,
  ) {}

  async createDialogue(params: CreateDialogueParams): Promise<number> {
    // subject_id: we only have the subject code (string), not the numeric DB id.
    // Store null for now; loadContext returns 'math' as default (MVP is math-only).
    // TODO: inject SubjectsRepository to resolve code -> id when multi-subject lands.
    const subjectId: number | null = null;

    // knowledge_point_id: try to parse as number; non-numeric IDs (e.g. 'kp_1') -> null
    const kpIdRaw = params.currentKnowledgePoint ? Number(params.currentKnowledgePoint.id) : null;
    const kpId: number | null = kpIdRaw !== null && Number.isFinite(kpIdRaw) ? kpIdRaw : null;

    const id = await this.dialoguesRepo.create({
      student_id: params.studentId,
      subject_id: subjectId,
      track: params.track,
      card_id: null,
      knowledge_point_id: kpId,
      title: params.track === 'auxiliary' ? '辅线答疑' : '主线讨论',
      status: 'active',
      consecutive_fail_count: 0,
    });
    return id;
  }

  async loadContext(dialogueId: string, tokenBudget = 4000): Promise<LoadContextResponse | null> {
    const id = Number(dialogueId);
    if (!Number.isFinite(id)) return null;
    const record = await this.dialoguesRepo.findById(id);
    if (!record) return null;

    const messages = await this.messagesRepo.findByDialogue(id);
    const normalizedMessages: Message[] = messages.map((m) => ({ role: m.role, content: m.content }));

    // Truncation (same algorithm as the in-memory version)
    let finalMessages = normalizedMessages;
    const totalChars = normalizedMessages.reduce((sum, m) => sum + m.content.length, 0);
    const charBudget = tokenBudget * 2;
    if (totalChars > charBudget) {
      const last4 = normalizedMessages.slice(-4);
      const last4Chars = last4.reduce((sum, m) => sum + m.content.length, 0);
      const remainingBudget = charBudget - last4Chars;
      const older = normalizedMessages.slice(0, -4);
      const summaries: Message[] = [];
      const batchCount = Math.max(1, Math.ceil(older.length / 6));
      for (let i = 0; i < older.length; i += 6) {
        const batch = older.slice(i, i + 6);
        const summary = `[对话摘要] ${batch.map((m) => `${m.role}: ${m.content.slice(0, 30)}...`).join(' | ')}`;
        if (summary.length <= remainingBudget / batchCount) {
          summaries.push({ role: 'system', content: summary });
        }
      }
      finalMessages = [...summaries, ...last4];
    }

    const student = await this.studentsRepo.findById(record.student_id);

    // subject: MVP is math-only; subject_id is not resolved to a code here.
    // When multi-subject lands, inject SubjectsRepository to look up the code by id.
    const subject: Subject = 'math';

    return {
      messages: finalMessages,
      student: {
        grade: student?.grade ?? '',
        gradeLevel: student?.schoolLevel ?? '',
        name: student?.name ?? '',
      },
      subject,
      // NOTE: cardContent not persisted in ai_dialogues; mainline flow must pass it
      // separately if needed (e.g., via TutoringRequest.cardId -> CardsRepository).
      cardContent: undefined,
      currentKnowledgePoint: record.knowledge_point_id
        ? { id: record.knowledge_point_id.toString(), name: '', subject }
        : undefined,
      // NOTE: currentDifficulty and currentQuestion are NOT persisted in ai_dialogues.
      // They return undefined here. TutoringCapability must tolerate this (model routing
      // falls back to default difficulty when undefined).
      currentDifficulty: undefined,
      currentQuestion: undefined,
      consecutiveFailCount: record.consecutive_fail_count,
      dialogueMetadata: {
        track: record.track,
        createdAt: record.created_at,
        messageCount: messages.length,
      },
    };
  }

  async saveMessages(request: SaveMessagesRequest): Promise<void> {
    const id = Number(request.dialogueId);
    if (!Number.isFinite(id)) throw new Error(`Invalid dialogueId: ${request.dialogueId}`);
    const record = await this.dialoguesRepo.findById(id);
    if (!record) throw new Error(`Dialogue not found: ${request.dialogueId}`);

    const rows = request.messages.map((msg) => ({
      dialogue_id: id,
      role: msg.role as 'system' | 'user' | 'assistant',
      content: msg.content,
      type: (msg.type ?? null) as 'socratic' | 'hint' | 'explain' | 'fallback' | 'block' | 'chat' | null,
      attachments: null,
      model: (msg.model ?? null) as string | null,
      token_input: null,
      token_output: null,
      response_time_ms: null,
      safety_flag: 0,
    }));
    await this.messagesRepo.createMany(rows);
  }

  async updateFailCount(request: UpdateFailCountRequest): Promise<void> {
    const id = Number(request.dialogueId);
    if (!Number.isFinite(id)) throw new Error(`Invalid dialogueId: ${request.dialogueId}`);
    const record = await this.dialoguesRepo.findById(id);
    if (!record) throw new Error(`Dialogue not found: ${request.dialogueId}`);
    const next = request.increment ? record.consecutive_fail_count + 1 : 0;
    await this.dialoguesRepo.updateFailCount(record.id, next);
  }

  async completeDialogue(request: CompleteDialogueRequest): Promise<void> {
    const id = Number(request.dialogueId);
    if (!Number.isFinite(id)) return;
    await this.dialoguesRepo.archive(id);
  }
}
