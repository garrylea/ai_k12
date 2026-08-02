import { Injectable, NotFoundException } from '@nestjs/common';
import { AiDialoguesRepository, AiMessagesRepository } from '../../database/repositories/index.js';
import type { AiMessageRow } from '../../database/repositories/types.js';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly dialoguesRepo: AiDialoguesRepository,
    private readonly messagesRepo: AiMessagesRepository,
  ) {}

  async create(
    studentId: number,
    dto: { track: 'mainline' | 'auxiliary'; subjectId?: number; knowledgePointId?: number },
  ) {
    const id = await this.dialoguesRepo.create({
      student_id: studentId,
      subject_id: dto.subjectId ?? null,
      track: dto.track,
      card_id: null,
      knowledge_point_id: dto.knowledgePointId ?? null,
      title: dto.track === 'auxiliary' ? '辅线答疑' : '主线讨论',
      status: 'active',
      consecutive_fail_count: 0,
    });
    return this.dialoguesRepo.findById(id);
  }

  async list(studentId: number, track: 'mainline' | 'auxiliary', cursor?: number) {
    return this.dialoguesRepo.findByStudentAndTrack(studentId, track, 10, cursor);
  }

  async get(dialogueId: number, studentId: number) {
    const dialogue = await this.dialoguesRepo.findById(dialogueId);
    if (!dialogue || dialogue.student_id !== studentId) throw new NotFoundException('dialogue not found');
    return dialogue;
  }

  async getMessages(dialogueId: number, studentId: number, lastMessageId?: number) {
    await this.get(dialogueId, studentId);
    return this.messagesRepo.findByDialogue(dialogueId, lastMessageId);
  }

  async appendMessage(dialogueId: number, studentId: number, content: string) {
    await this.get(dialogueId, studentId);
    await this.messagesRepo.create({
      dialogue_id: dialogueId,
      role: 'user',
      content,
      type: 'socratic',
      attachments: null,
      model: null,
      token_input: null,
      token_output: null,
      response_time_ms: null,
      safety_flag: 0,
    });
  }

  async appendAssistantMessage(
    dialogueId: number,
    studentId: number,
    content: string,
    type: AiMessageRow['type'] = 'socratic',
  ) {
    await this.get(dialogueId, studentId);
    await this.messagesRepo.create({
      dialogue_id: dialogueId,
      role: 'assistant',
      content,
      type,
      attachments: null,
      model: null,
      token_input: null,
      token_output: null,
      response_time_ms: null,
      safety_flag: type === 'block' ? 1 : 0,
    });
  }
}
