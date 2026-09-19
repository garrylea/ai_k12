import { Module } from '@nestjs/common';
import { PracticeController } from './practice.controller.js';
import { PracticeService } from './practice.service.js';
import { JudgeCoreService } from './judge-core.service.js';
import { QuestionsRepository, MainErrorBooksRepository, CardsRepository, PracticeResultsRepository, ProgressRepository, QuestionSelfAssessmentsRepository, StudentKnowledgeMasteryRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';
import { ExplanationCapability } from '../../ai-core/capabilities/explanation.capability.js';
import { ExplanationCacheService } from './explanation-cache.service.js';
import { MasteryService } from './mastery.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { ContentModule } from '../content/content.module.js';
import { PointsModule } from '../points/points.module.js';

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
 * - imports PointsModule：Task 10 起 JudgeCoreService 注入 PointsService，
 *   答对清零「确实清掉未清错题」时发 `error_fix` 分（PointsModule 已 exports PointsService）。
 */
@Module({
  imports: [ConversationsModule, ContentModule, PointsModule],
  controllers: [PracticeController],
  providers: [
    PracticeService,
    JudgeCoreService,
    QuestionsRepository,
    MainErrorBooksRepository,
    CardsRepository,
    PracticeResultsRepository,
    ProgressRepository,
    QuestionSelfAssessmentsRepository,
    QuestionStructuringCapability,
    JudgmentCapability,
    HintCapability,
    ExplanationCacheService,
    ExplanationCapability,
    // 掌握度回写（埋点 Phase 1B）：JudgeCoreService 判题出口调用（fire-and-forget）。
    // StudentKnowledgeMasteryRepository **只在本模块 provide 一次**（重复 provide 会得到两份实例）。
    StudentKnowledgeMasteryRepository,
    MasteryService,
  ],
  exports: [PracticeService, JudgeCoreService, ExplanationCacheService, MasteryService],
})
export class PracticeModule {}
