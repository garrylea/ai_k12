import { Injectable, BadRequestException } from '@nestjs/common';
import { TutoringCapability } from '../../ai-core/capabilities/tutoring.capability.js';
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
    // TODO: check controls.auxiliary_enabled via ControlsRepository (not yet created in Task 1).
    // For now, auxiliary access is not gated at the service layer.

    let dialogueId = dto.dialogueId;
    if (!dialogueId) {
      const dialogue = await this.conversationsService.create(userId, {
        track: dto.mode,
        knowledgePointId: dto.knowledgeId ? Number(dto.knowledgeId) : undefined,
      });
      if (!dialogue) throw new Error('Failed to create dialogue');
      dialogueId = String(dialogue.id);
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

    const response = await this.tutoring.tutor(request);

    // TODO (mainline): ConversationService.loadContext() returns cardContent:
    // undefined (not persisted in ai_dialogues). For mainline mode, cardContent
    // should be loaded from CardsRepository via dto.cardId. Auxiliary mode does
    // not need cardContent (open scope).

    return {
      dialogueId,
      message: response.message,
      safety: response.safety,
      fallback: response.isFallback,
      consecutiveFailCount: response.consecutiveFailCount,
    };
  }
}
