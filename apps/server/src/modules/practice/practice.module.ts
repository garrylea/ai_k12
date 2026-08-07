import { Module } from '@nestjs/common';
import { PracticeController } from './practice.controller.js';
import { PracticeService } from './practice.service.js';
import { QuestionsRepository, MainErrorBooksRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';

/**
 * 课堂练习模块 - 主线练习判对错。
 *
 * providers 镜像 ErrorBookModule 模式：
 * - repos（QuestionsRepository / MainErrorBooksRepository）通过 @Inject('DATABASE_POOL')
 *   注入全局连接池（DatabaseModule 是 @Global）。
 * - capabilities（QuestionStructuringCapability / JudgmentCapability）构造函数的
 *   modelClient 参数可选，默认 new ModelClient()，可直接实例化。
 */
@Module({
  controllers: [PracticeController],
  providers: [
    PracticeService,
    QuestionsRepository,
    MainErrorBooksRepository,
    QuestionStructuringCapability,
    JudgmentCapability,
  ],
  exports: [PracticeService],
})
export class PracticeModule {}
