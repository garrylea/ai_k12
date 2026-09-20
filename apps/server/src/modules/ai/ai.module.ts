import { Module } from '@nestjs/common';
import { AIController } from './ai.controller.js';
import { AIService } from './ai.service.js';
import { TutoringCapability } from '../../ai-core/capabilities/tutoring.capability.js';
import { ConversationService } from '../../services/conversation/index.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { SafetyAlertsModule } from '../safety/safety-alerts.module.js';
import { SafetyAlertsService } from '../safety/safety-alerts.service.js';
import { AiDialoguesRepository, AiMessagesRepository, ExtractTasksRepository, MainErrorBooksRepository, QuestionsRepository, UploadedFilesRepository, CardsRepository } from '../../database/repositories/index.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';

@Module({
  imports: [ConversationsModule, SafetyAlertsModule],
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
    // 辅线入库的题要确保进主线错题本（source='auxiliary'）。
    MainErrorBooksRepository,
    // Task 5: PDF extraction task lookup for file attachments.
    ExtractTasksRepository,
    {
      provide: TutoringCapability,
      // 预警 sink 由 SafetyAlertsModule 提供（spec §3.1）。`TutoringCapability` 不是
      // `@Injectable()`、走 `useFactory` + `new`，不会发 `design:paramtypes`，
      // 所以 deps 里放**接口类型**（SafetyAlertSink）是安全的 —— 别给它加 @Injectable()。
      useFactory: (conversationService: ConversationService, safetyAlerts: SafetyAlertsService) =>
        new TutoringCapability(conversationService, { safetyAlerts }),
      inject: [ConversationService, SafetyAlertsService],
    },
  ],
})
export class AIModule {}
