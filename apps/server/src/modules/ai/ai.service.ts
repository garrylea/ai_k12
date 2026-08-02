import {
  Injectable,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { TutoringCapability } from '../../ai-core/capabilities/tutoring.capability.js';
import { LLMClientError, InsufficientQuotaError } from '../../ai-core/types.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import type { TutoringRequest } from '../../ai-core/types.js';
import type { TutorDto } from './dto/tutor.dto.js';

@Injectable()
export class AIService {
  constructor(
    private readonly tutoring: TutoringCapability,
    private readonly conversationsService: ConversationsService,
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

    // studentId comes from the JWT (user.sub), not the dto.
    // TODO: attachments - dto uses {type, fileId} but ai-core Attachment expects
    // {type: 'image'|'formula', url}. A file service is needed to resolve
    // fileId -> url; omitting attachments for now.
    const request: TutoringRequest = {
      studentId: String(userId),
      mode: dto.mode,
      cardId: dto.cardId,
      knowledgeId: dto.knowledgeId,
      message: dto.message,
      dialogueId,
    };

    // TODO (mainline): ConversationService.loadContext() returns cardContent:
    // undefined (not persisted in ai_dialogues). For mainline mode, cardContent
    // should be loaded from CardsRepository via dto.cardId. Auxiliary mode does
    // not need cardContent (open scope).

    try {
      const response = await this.tutoring.tutor(request);

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
