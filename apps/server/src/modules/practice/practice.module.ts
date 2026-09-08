import { Module } from '@nestjs/common';
import { PracticeController } from './practice.controller.js';
import { PracticeService } from './practice.service.js';
import { JudgeCoreService } from './judge-core.service.js';
import { QuestionsRepository, MainErrorBooksRepository, CardsRepository, PracticeResultsRepository, ProgressRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';
import { ExplanationCapability } from '../../ai-core/capabilities/explanation.capability.js';
import { ExplanationCacheService } from './explanation-cache.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { ContentModule } from '../content/content.module.js';

/**
 * 课堂练习模块 - 主线练习判对错 + 提示 + 讨论。
 *
 * providers 镜像 ErrorBookModule 模式：
 * - repos（QuestionsRepository / MainErrorBooksRepository / CardsRepository）通过
 *   @Inject('DATABASE_POOL') 注入全局连接池（DatabaseModule 是 @Global）。
 * - capabilities（QuestionStructuringCapability / JudgmentCapability / HintCapability）
 *   构造函数的 modelClient 参数可选，默认 new ModelClient()，可直接实例化。
 * - imports ConversationsModule：startDiscuss 创建带 card_id 的 mainline 对话
 *   （复用 ConversationsService.create）。
 */
@Module({
  imports: [ConversationsModule, ContentModule],
  controllers: [PracticeController],
  providers: [
    PracticeService,
    JudgeCoreService,
    QuestionsRepository,
    MainErrorBooksRepository,
    CardsRepository,
    PracticeResultsRepository,
    ProgressRepository,
    QuestionStructuringCapability,
    JudgmentCapability,
    HintCapability,
    ExplanationCacheService,
    ExplanationCapability,
  ],
  exports: [PracticeService, JudgeCoreService],
})
export class PracticeModule {}
