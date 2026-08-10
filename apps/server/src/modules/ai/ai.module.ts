import { Module } from '@nestjs/common';
import { AIController } from './ai.controller.js';
import { AIService } from './ai.service.js';
import { TutoringCapability } from '../../ai-core/capabilities/tutoring.capability.js';
import { ConversationService } from '../../services/conversation/index.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { AiDialoguesRepository, AiMessagesRepository, ExtractTasksRepository, QuestionsRepository, UploadedFilesRepository, CardsRepository } from '../../database/repositories/index.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';

@Module({
  imports: [ConversationsModule],
  controllers: [AIController],
  providers: [
    AIService,
    // ConversationService (ai-core internal) needs its own repo providers.
    // These are separate instances from ConversationsModule's repos, but repos
    // are stateless wrappers around the global DATABASE_POOL, so this is safe.
    ConversationService,
    AiDialoguesRepository,
    AiMessagesRepository,
    StudentsRepository,
    // mainline 对话按 card_id 解析卡片 content 作 prompt 范围边界（loadContext 用）。
    CardsRepository,
    // Task 14a: for attachment resolution (fileId -> base64 data URL) and
    // subjectId lookup (math subject ID for structured question ingestion).
    UploadedFilesRepository,
    SubjectsRepository,
    // B1: direct question bank insertion (aux_error_books no longer used).
    QuestionsRepository,
    // Task 5: PDF extraction task lookup for file attachments.
    ExtractTasksRepository,
    {
      provide: TutoringCapability,
      useFactory: (conversationService: ConversationService) =>
        new TutoringCapability(conversationService),
      inject: [ConversationService],
    },
  ],
})
export class AIModule {}
