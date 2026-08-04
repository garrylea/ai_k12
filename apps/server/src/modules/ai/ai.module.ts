import { Module } from '@nestjs/common';
import { AIController } from './ai.controller.js';
import { AIService } from './ai.service.js';
import { TutoringCapability } from '../../ai-core/capabilities/tutoring.capability.js';
import { ConversationService } from '../../services/conversation/index.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { ErrorBookModule } from '../error-book/error-book.module.js';
import { AiDialoguesRepository, AiMessagesRepository, UploadedFilesRepository } from '../../database/repositories/index.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';

@Module({
  imports: [ConversationsModule, ErrorBookModule],
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
    // Task 14a: for attachment resolution (fileId -> base64 data URL) and
    // subjectId lookup (math subject ID for structured question ingestion).
    UploadedFilesRepository,
    SubjectsRepository,
    {
      provide: TutoringCapability,
      useFactory: (conversationService: ConversationService) =>
        new TutoringCapability(conversationService),
      inject: [ConversationService],
    },
  ],
})
export class AIModule {}
