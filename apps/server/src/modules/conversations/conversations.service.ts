import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { AiDialoguesRepository, AiMessagesRepository } from '../../database/repositories/index.js';
import type { AiMessageRow } from '../../database/repositories/types.js';

@Injectable()
export class ConversationsService {
  private readonly PAGE_SIZE = 10;

  constructor(
    private readonly dialoguesRepo: AiDialoguesRepository,
    private readonly messagesRepo: AiMessagesRepository,
  ) {}

  async create(
    studentId: number,
    dto: { track: 'mainline' | 'auxiliary'; subjectId?: number; knowledgePointId?: number; cardId?: number },
  ) {
    if (dto.track !== 'mainline' && dto.track !== 'auxiliary') {
      throw new BadRequestException({ code: 1001, message: 'track 必须为 mainline 或 auxiliary' });
    }
    const id = await this.dialoguesRepo.create({
      student_id: studentId,
      subject_id: dto.subjectId ?? null,
      track: dto.track,
      // mainline 讨论按 cardId 限定范围（loadContext 据此解析 cardContent 作 prompt 边界）；
      // auxiliary 无卡片，保持 null。
      card_id: dto.cardId ?? null,
      knowledge_point_id: dto.knowledgePointId ?? null,
      title: dto.track === 'auxiliary' ? '辅线答疑' : '主线讨论',
      status: 'active',
      consecutive_fail_count: 0,
    });
    return this.dialoguesRepo.findById(id);
  }

  async list(studentId: number, track: 'mainline' | 'auxiliary', cursor?: number) {
    return this.dialoguesRepo.findByStudentAndTrack(studentId, track, this.PAGE_SIZE, cursor);
  }

  async get(dialogueId: number, studentId: number) {
    const dialogue = await this.dialoguesRepo.findById(dialogueId);
    if (!dialogue || dialogue.student_id !== studentId) throw new NotFoundException('dialogue not found');
    return dialogue;
  }

  /**
   * 卡片级讨论 find-or-create：复用该学生在该卡片上已有的 mainline 对话，
   * 没有则新建。让卡片级讨论跨刷新/跨设备续接同一讨论线（不入错题本，
   * 故以 student+card 为锚，而非题目级的 error_book.dialogue_id）。
   */
  async findOrCreateMainlineByCard(studentId: number, cardId: number, subjectId?: number): Promise<{ id: number }> {
    const existing = await this.dialoguesRepo.findMainlineByStudentAndCard(studentId, cardId);
    if (existing) return { id: existing.id };
    const id = await this.dialoguesRepo.create({
      student_id: studentId,
      subject_id: subjectId ?? null,
      track: 'mainline',
      card_id: cardId,
      knowledge_point_id: null,
      title: '主线讨论',
      status: 'active',
      consecutive_fail_count: 0,
    });
    return { id };
  }

  async updateTitle(dialogueId: number, studentId: number, title: string) {
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new BadRequestException({ code: 1001, message: 'title 不能为空' });
    }
    if (title.trim().length > 100) {
      throw new BadRequestException({ code: 1001, message: 'title 过长（≤100 字）' });
    }
    await this.get(dialogueId, studentId);  // ownership check
    await this.dialoguesRepo.updateTitle(dialogueId, title.trim());
  }

  async delete(dialogueId: number, studentId: number) {
    await this.get(dialogueId, studentId);  // ownership check
    await this.dialoguesRepo.softDelete(dialogueId);
  }

  /** 软删除单条消息：校验 dialogue 归属 + 消息存在，写 deleted_at。 */
  async deleteMessage(dialogueId: number, messageId: number, studentId: number) {
    await this.get(dialogueId, studentId);
    await this.messagesRepo.softDelete(messageId);
  }

  async getMessages(dialogueId: number, studentId: number, lastMessageId?: number) {
    await this.get(dialogueId, studentId);
    return this.messagesRepo.findByDialogue(dialogueId, lastMessageId);
  }

  async appendMessage(dialogueId: number, studentId: number, content: string) {
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new BadRequestException({ code: 1001, message: 'content 不能为空' });
    }
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
