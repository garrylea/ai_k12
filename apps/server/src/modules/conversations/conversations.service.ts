import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { AiDialoguesRepository, AiMessagesRepository } from '../../database/repositories/index.js';
import type { AiDialogueScene, AiMessageRow } from '../../database/repositories/types.js';
import type { CreateConversationDto } from './dto/create-conversation.dto.js';

const SCENE_BY_TRACK: Record<'mainline' | 'auxiliary', AiDialogueScene[]> = {
  mainline: ['mainline_question', 'mainline_card'],
  auxiliary: ['aux_qna', 'aux_training'],
};

@Injectable()
export class ConversationsService {
  private readonly PAGE_SIZE = 10;

  constructor(
    private readonly dialoguesRepo: AiDialoguesRepository,
    private readonly messagesRepo: AiMessagesRepository,
  ) {}

  async create(studentId: number, dto: CreateConversationDto) {
    if (dto.track !== 'mainline' && dto.track !== 'auxiliary') {
      throw new BadRequestException({ code: 1001, message: 'track 必须为 mainline 或 auxiliary' });
    }

    const scene = dto.scene ?? (dto.track === 'auxiliary' ? 'aux_qna' : 'mainline_card');
    if (!SCENE_BY_TRACK[dto.track].includes(scene)) {
      throw new BadRequestException({ code: 1001, message: `scene ${scene} 与 track ${dto.track} 不匹配` });
    }
    // questionId 仅用于 aux_training 按题锚；缺省时退化为“每次新建”（孤儿题等场景，仍按 scene 隔离）。
    if (dto.questionId != null && !Number.isInteger(dto.questionId)) {
      throw new BadRequestException({ code: 1001, message: 'questionId 必须为正整数' });
    }

    // 训练讲一讲：按题 find-or-create，命中复用（跨刷新/跨设备续接同一讨论线）。
    if (scene === 'aux_training' && dto.questionId) {
      const existing = await this.dialoguesRepo.findByStudentTrackSceneQuestion(
        studentId,
        'auxiliary',
        'aux_training',
        dto.questionId,
      );
      if (existing) {
        // 兼容存量空锚会话（曾因题面锚写入失败只建了会话、无任何消息）：
        // 复用时若会话还没有任何消息，则补写一次题面锚，避免 AI 首问缺上下文。
        if (dto.questionText && dto.questionText.trim().length > 0) {
          const msgs = await this.messagesRepo.findByDialogue(existing.id);
          if (msgs.length === 0) {
            await this.writeQuestionSeed(existing.id, dto.questionText.trim());
          }
        }
        return existing;
      }
    }

    const id = await this.dialoguesRepo.create({
      student_id: studentId,
      subject_id: dto.subjectId ?? null,
      track: dto.track,
      scene,
      // mainline 讨论按 cardId 限定范围（loadContext 据此解析 cardContent 作 prompt 边界）；
      // auxiliary 无卡片，保持 null。
      card_id: dto.cardId ?? null,
      question_id: scene === 'aux_training' ? (dto.questionId ?? null) : null,
      knowledge_point_id: dto.knowledgePointId ?? null,
      title: dto.track === 'auxiliary' ? '辅线答疑' : '主线讨论',
      status: 'active',
      consecutive_fail_count: 0,
    });

    // 新建（非复用）且提供题面时：写一条 assistant 题面锚消息进历史，
    // AI 每轮靠对话历史带题面，学生消息保持干净（辅线拍照题转录同款做法）。
    if (dto.questionText && dto.questionText.trim().length > 0) {
      await this.writeQuestionSeed(id, dto.questionText.trim());
    }

    return this.dialoguesRepo.findById(id);
  }

  /** 写一条 assistant 题面锚消息（role=assistant, type=transcription, content=题面）。 */
  private async writeQuestionSeed(dialogueId: number, questionText: string): Promise<void> {
    await this.messagesRepo.create({
      dialogue_id: dialogueId,
      role: 'assistant',
      content: questionText,
      type: 'transcription',
      reasoning: null,
      attachments: null,
      model: null,
      token_input: null,
      token_output: null,
      response_time_ms: null,
      safety_flag: 0,
    });
  }

  async list(
    studentId: number,
    track: 'mainline' | 'auxiliary',
    cursor?: number,
    scene?: AiDialogueScene,
  ) {
    return this.dialoguesRepo.findByStudentAndTrack(studentId, track, this.PAGE_SIZE, cursor, scene);
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
      scene: 'mainline_card',
      card_id: cardId,
      question_id: null,
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
      reasoning: null,
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
    /**
     * 是否记为「偏离学习」（写 `safety_flag = 1`）。与 `ConversationService.saveMessages`
     * 的同名可选字段同口径（spec §3.2）：显式传入时优先，未传时回落到 `type === 'block'`
     * 推导 —— 删掉 off_topic 硬阻断后，`type === 'block'` 只剩 anomaly（情绪 / 敏感）。
     */
    safetyFlag?: boolean,
  ) {
    await this.get(dialogueId, studentId);
    await this.messagesRepo.create({
      dialogue_id: dialogueId,
      role: 'assistant',
      content,
      type,
      reasoning: null,
      attachments: null,
      model: null,
      token_input: null,
      token_output: null,
      response_time_ms: null,
      // 与 `ConversationService.saveMessages` 同一表达式（`Number(...)` 是必需的：
      // `safetyFlag` 是 boolean，`??` 会原样返回它，而列是 INT）。
      safety_flag: Number(safetyFlag ?? (type === 'block' ? 1 : 0)),
    });
  }
}
