import {
  Injectable,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { TutoringCapability } from '../../ai-core/capabilities/tutoring.capability.js';
import { LLMClientError, InsufficientQuotaError } from '../../ai-core/types.js';
import type { TutoringRequest, Attachment, StreamEvent, StructuredQuestionOutput } from '../../ai-core/types.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ErrorBookService } from '../error-book/error-book.service.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TutorDto } from './dto/tutor.dto.js';

@Injectable()
export class AIService {
  private readonly logger = new Logger(AIService.name);
  private readonly MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

  constructor(
    private readonly tutoring: TutoringCapability,
    private readonly conversationsService: ConversationsService,
    private readonly errorBookService: ErrorBookService,
    private readonly filesRepo: UploadedFilesRepository,
    private readonly subjectsRepo: SubjectsRepository,
  ) {}

  async tutor(dto: TutorDto, userId: number) {
    this.validateDto(dto);
    const dialogueId = await this.resolveDialogue(dto, userId);

    // NOTE: TutoringCapability.tutor() internally persists BOTH the user message
    // and the assistant reply via ConversationService.saveMessages() in all code
    // paths (fallback / block / normal). We deliberately do NOT call
    // conversationsService.appendMessage() / appendAssistantMessage() here to
    // avoid creating duplicate rows in ai_messages.

    const attachments = await this.resolveAttachments(dto, userId);
    const request = this.buildRequest(dto, userId, dialogueId, attachments);

    try {
      const response = await this.tutoring.tutor(request);
      if (response.structuredQuestion) {
        await this.ingestStructuredQuestion(userId, dto, attachments, response.structuredQuestion);
      }
      // Fire-and-forget: name the conversation from the user's actual question.
      this.maybeUpdateTitle(dialogueId, userId, dto.message, response.message.content).catch(() => {});
      return {
        dialogueId,
        message: response.message,
        reasoning: response.reasoning,
        safety: response.safety,
        fallback: response.isFallback,
        consecutiveFailCount: response.consecutiveFailCount,
      };
    } catch (err) {
      throw this.mapLLMError(err, dialogueId);
    }
  }

  /**
   * Streaming tutor. Yields reasoning + content deltas as the model generates,
   * then a `done` event (with structuredQuestion for ingestion). Pre-stream
   * errors (validation / dialogue / attachment resolution) throw HttpException;
   * mid-stream model errors are yielded as `{type:'error'}` by the capability.
   */
  async *tutorStream(dto: TutorDto, userId: number, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.validateDto(dto);
    const dialogueId = await this.resolveDialogue(dto, userId);
    const attachments = await this.resolveAttachments(dto, userId);
    const request = this.buildRequest(dto, userId, dialogueId, attachments);

    let assistantContent = '';
    try {
      for await (const event of this.tutoring.tutorStream(request, signal)) {
        if (event.type === 'content') {
          // Track final assistant content (replace = JSON-stripped version) for title gen.
          assistantContent = event.replace ? (event.delta ?? '') : assistantContent + (event.delta ?? '');
        } else if (event.type === 'done' && event.structuredQuestion) {
          await this.ingestStructuredQuestion(userId, dto, attachments, event.structuredQuestion);
        }
        yield event;
      }
    } catch (err) {
      throw this.mapLLMError(err, dialogueId);
    }
    // Fire-and-forget: name the conversation from the user's actual question.
    this.maybeUpdateTitle(dialogueId, userId, dto.message, assistantContent).catch(() => {});
  }

  // ---------- shared helpers ----------

  private validateDto(dto: TutorDto) {
    if (!dto.message || dto.message.trim().length === 0) {
      throw new BadRequestException({ code: 1001, message: 'message 不能为空' });
    }
    if (dto.mode !== 'mainline' && dto.mode !== 'auxiliary') {
      throw new BadRequestException({ code: 1001, message: 'mode 必须为 mainline 或 auxiliary' });
    }
    // TODO: check controls.auxiliary_enabled via ControlsRepository (not yet created in Task 1).
    // For now, auxiliary access is not gated at the service layer.
  }

  private async resolveDialogue(dto: TutorDto, userId: number): Promise<string> {
    if (dto.dialogueId) {
      // Critical: verify the dialogue belongs to the current user before proceeding.
      // ai-core ConversationService.loadContext uses findById (no student_id filter),
      // so without this check a student could read/tamper with another's dialogue.
      await this.conversationsService.get(Number(dto.dialogueId), userId);
      return dto.dialogueId;
    }
    let knowledgePointId: number | undefined;
    if (dto.knowledgeId) {
      knowledgePointId = Number(dto.knowledgeId);
      if (!Number.isFinite(knowledgePointId)) {
        throw new BadRequestException({ code: 1001, message: 'knowledgeId 必须为数字' });
      }
    }
    const dialogue = await this.conversationsService.create(userId, {
      track: dto.mode,
      knowledgePointId,
    });
    if (!dialogue) {
      throw new InternalServerErrorException({ code: 5000, message: '创建会话失败' });
    }
    return String(dialogue.id);
  }

  // Task 14a: resolve attachment fileIds to base64 data URLs for multimodal input.
  // Review #12: only process image attachments; non-image types are skipped.
  private async resolveAttachments(dto: TutorDto, userId: number): Promise<Attachment[]> {
    const attachments: Attachment[] = [];
    if (!dto.attachments || dto.attachments.length === 0) return attachments;

    const uploadDir = process.env.UPLOAD_DIR ?? './uploads';
    for (const att of dto.attachments) {
      if (att.type !== 'image') continue;  // #12: skip non-image attachments
      const fileIdNum = Number(att.fileId);
      if (!Number.isFinite(fileIdNum)) {
        throw new BadRequestException({ code: 1001, message: 'attachment.fileId 必须为数字' });
      }
      // Review #1: ownership check - prevent authorization bypass.
      const fileRow = await this.filesRepo.findByIdAndOwner(fileIdNum, userId);
      if (!fileRow) {
        throw new BadRequestException({ code: 1001, message: '文件不存在或无权访问' });
      }
      // Review #2: mime type validation - only images can be sent to Qwen-VL.
      if (!fileRow.mime_type.startsWith('image/')) {
        throw new BadRequestException({ code: 1001, message: '附件必须是图片' });
      }
      // Review #3: size limit - base64 inflates ~33%, cap before readFileSync.
      if (fileRow.size_bytes > this.MAX_IMAGE_BYTES) {
        throw new BadRequestException({ code: 1001, message: '图片过大（最大 5MB）' });
      }
      const storageKey = fileRow.url.replace(/^\/uploads\//, '');
      const filePath = path.join(uploadDir, storageKey);
      let base64: string;
      try {
        base64 = fs.readFileSync(filePath).toString('base64');
      } catch {
        throw new BadRequestException({ code: 1001, message: `文件读取失败: ${att.fileId}` });
      }
      const dataUrl = `data:${fileRow.mime_type};base64,${base64}`;
      attachments.push({
        type: 'image',
        url: fileRow.url,
        imageUrl: dataUrl,
        fileId: att.fileId,
      });
    }
    return attachments;
  }

  private buildRequest(dto: TutorDto, userId: number, dialogueId: string, attachments: Attachment[]): TutoringRequest {
    // studentId comes from the JWT (user.sub), not the dto.
    return {
      studentId: String(userId),
      mode: dto.mode,
      cardId: dto.cardId,
      knowledgeId: dto.knowledgeId,
      message: dto.message,
      dialogueId,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  // Task 14a: ingest a structured question into questions + aux_error_books.
  // Use dto.subjectId or default to the math subject ID (MVP is math-only).
  private async ingestStructuredQuestion(
    userId: number,
    dto: TutorDto,
    attachments: Attachment[],
    structuredQuestion: StructuredQuestionOutput,
  ): Promise<void> {
    let subjectId = dto.subjectId;
    if (!subjectId) {
      const mathSubject = await this.subjectsRepo.findByCode('math');
      subjectId = mathSubject?.id ?? 1;  // TODO: hardcode fallback, should not happen if DB seeded
    }
    const hasImage = attachments.some(a => a.type === 'image');
    await this.errorBookService.createAuxFromStructured(
      userId,
      subjectId,
      structuredQuestion,
      hasImage ? 'photo' : 'auxiliary',
    ).catch((err) => {
      // Ingestion failure should not block the tutoring response.
      this.logger.error('structured question ingestion failed:', err);
    });
  }

  // Name the conversation from the user's actual question (replaces the static
  // "辅线答疑" temp title). Only acts when the title is still the default; a
  // greeting/ambiguous message yields no title (returns null) so the temp title
  // stays and we retry on the next message. Fire-and-forget from tutor/stream.
  private async maybeUpdateTitle(
    dialogueId: string,
    userId: number,
    userMessage: string,
    assistantContent: string,
  ): Promise<void> {
    try {
      const dialogue = await this.conversationsService.get(Number(dialogueId), userId);
      if (dialogue.title && dialogue.title !== '辅线答疑') return;  // already named
      const topic = await this.tutoring.generateTitle(userMessage, assistantContent);
      if (!topic) return;  // greeting/ambiguous - keep temp title
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const time = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      await this.conversationsService.updateTitle(Number(dialogueId), userId, `${topic} · ${time}`);
    } catch (err) {
      this.logger.error('title generation failed:', err);
    }
  }

  private mapLLMError(err: unknown, dialogueId: string): HttpException {
    // Re-throw HttpExceptions (BadRequest, NotFound from ownership check) as-is
    // so they keep their original status code and payload.
    if (err instanceof HttpException) return err;

    // Map LLM errors to HTTP responses without leaking internal details.
    // Include dialogueId so the frontend can retry against the same dialogue
    // (no new orphan created on retry).
    if (err instanceof InsufficientQuotaError) {
      return new HttpException(
        { code: 1005, message: 'AI 服务额度不足，请稍后重试', dialogueId },
        503,
      );
    }
    if (err instanceof LLMClientError) {
      return new HttpException(
        { code: 5001, message: 'AI 服务繁忙，请稍后重试', dialogueId },
        503,
      );
    }

    // TODO: user message is not persisted if tutoring.tutor() throws before saveMessages.
    // For MVP, the frontend retries with the returned dialogueId.

    // Unknown errors - don't leak internal message.
    return new HttpException(
      { code: 5000, message: 'AI 服务异常', dialogueId },
      500,
    );
  }
}
