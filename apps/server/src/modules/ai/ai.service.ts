import {
  Injectable,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { TutoringCapability } from '../../ai-core/capabilities/tutoring.capability.js';
import { LLMClientError, InsufficientQuotaError } from '../../ai-core/types.js';
import type { TutoringRequest, Attachment } from '../../ai-core/types.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ErrorBookService } from '../error-book/error-book.service.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TutorDto } from './dto/tutor.dto.js';

@Injectable()
export class AIService {
  constructor(
    private readonly tutoring: TutoringCapability,
    private readonly conversationsService: ConversationsService,
    private readonly errorBookService: ErrorBookService,
    private readonly filesRepo: UploadedFilesRepository,
    private readonly subjectsRepo: SubjectsRepository,
  ) {}

  async tutor(dto: TutorDto, userId: number) {
    if (!dto.message || dto.message.trim().length === 0) {
      throw new BadRequestException({ code: 1001, message: 'message 不能为空' });
    }
    if (dto.mode !== 'mainline' && dto.mode !== 'auxiliary') {
      throw new BadRequestException({ code: 1001, message: 'mode 必须为 mainline 或 auxiliary' });
    }
    // TODO: check controls.auxiliary_enabled via ControlsRepository (not yet created in Task 1).
    // For now, auxiliary access is not gated at the service layer.

    let dialogueId = dto.dialogueId;
    if (!dialogueId) {
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
      dialogueId = String(dialogue.id);
    } else {
      // Critical: verify the dialogue belongs to the current user before proceeding.
      // ai-core ConversationService.loadContext uses findById (no student_id filter),
      // so without this check a student could read/tamper with another's dialogue.
      await this.conversationsService.get(Number(dialogueId), userId);
    }

    // NOTE: TutoringCapability.tutor() internally persists BOTH the user message
    // and the assistant reply via ConversationService.saveMessages() in all code
    // paths (fallback / block / normal). We deliberately do NOT call
    // conversationsService.appendMessage() / appendAssistantMessage() here to
    // avoid creating duplicate rows in ai_messages.

    // Task 14a: resolve attachment fileIds to base64 data URLs for multimodal input.
    const attachments: Attachment[] = [];
    if (dto.attachments && dto.attachments.length > 0) {
      const uploadDir = process.env.UPLOAD_DIR ?? './uploads';
      for (const att of dto.attachments) {
        const fileIdNum = Number(att.fileId);
        if (!Number.isFinite(fileIdNum)) {
          throw new BadRequestException({ code: 1001, message: 'attachment.fileId 必须为数字' });
        }
        const fileRow = await this.filesRepo.findById(fileIdNum);
        if (!fileRow) {
          throw new BadRequestException({ code: 1001, message: `文件不存在: ${att.fileId}` });
        }
        // The url field is stored as /uploads/<key>; strip the prefix to get the
        // storage key, then read from disk and encode as base64 data URL.
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
          type: att.type === 'image' ? 'image' : 'formula',
          url: fileRow.url,
          imageUrl: dataUrl,
          fileId: att.fileId,
        });
      }
    }

    // studentId comes from the JWT (user.sub), not the dto.
    const request: TutoringRequest = {
      studentId: String(userId),
      mode: dto.mode,
      cardId: dto.cardId,
      knowledgeId: dto.knowledgeId,
      message: dto.message,
      dialogueId,
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    // TODO (mainline): ConversationService.loadContext() returns cardContent:
    // undefined (not persisted in ai_dialogues). For mainline mode, cardContent
    // should be loaded from CardsRepository via dto.cardId. Auxiliary mode does
    // not need cardContent (open scope).

    try {
      const response = await this.tutoring.tutor(request);

      // Task 14a: if the model produced a structured question, ingest it into
      // questions + aux_error_books. Use dto.subjectId or default to the math
      // subject ID (MVP is math-only).
      if (response.structuredQuestion) {
        let subjectId = dto.subjectId;
        if (!subjectId) {
          const mathSubject = await this.subjectsRepo.findByCode('math');
          subjectId = mathSubject?.id ?? 1;  // TODO: hardcode fallback, should not happen if DB seeded
        }
        const hasImage = attachments.some(a => a.type === 'image');
        await this.errorBookService.createAuxFromStructured(
          userId,
          subjectId,
          response.structuredQuestion,
          hasImage ? 'photo' : 'auxiliary',
        ).catch((err) => {
          // Ingestion failure should not block the tutoring response.
          // The user still gets their Socratic reply; the question just
          // doesn't get saved to the error book.
          console.error('[AIService] structured question ingestion failed:', err);
        });
      }

      return {
        dialogueId,
        message: response.message,
        safety: response.safety,
        fallback: response.isFallback,
        consecutiveFailCount: response.consecutiveFailCount,
      };
    } catch (err) {
      // Re-throw HttpExceptions (BadRequest, NotFound from ownership check) as-is
      // so they keep their original status code and payload.
      if (err instanceof HttpException) throw err;

      // Map LLM errors to HTTP responses without leaking internal details.
      // Include dialogueId so the frontend can retry against the same dialogue
      // (no new orphan created on retry).
      if (err instanceof InsufficientQuotaError) {
        throw new HttpException(
          { code: 1005, message: 'AI 服务额度不足，请稍后重试', dialogueId },
          503,
        );
      }
      if (err instanceof LLMClientError) {
        throw new HttpException(
          { code: 5001, message: 'AI 服务繁忙，请稍后重试', dialogueId },
          503,
        );
      }

      // TODO: user message is not persisted if tutoring.tutor() throws before saveMessages.
      // TutoringCapability.saveMessages only runs on successful model call. For MVP, the
      // frontend retries with the returned dialogueId; a fuller fix would persist the user
      // message in AIService before calling tutor (requires TutoringCapability refactor).

      // Unknown errors - don't leak internal message.
      throw new HttpException(
        { code: 5000, message: 'AI 服务异常', dialogueId },
        500,
      );
    }
  }
}
