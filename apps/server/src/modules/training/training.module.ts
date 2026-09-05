import { Module } from '@nestjs/common';
import { TrainingController } from './training.controller.js';
import { TrainingService } from './training.service.js';
import { PracticeModule } from '../practice/practice.module.js';
import { MainErrorBooksRepository, QuestionsRepository, QuestionHintsRepository, KnowledgePointsRepository, StudentHiddenQuestionsRepository } from '../../database/repositories/index.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';

/**
 * 错题训练模块（Task 1 骨架 + Task 2 判题 + Task 3 提示缓存 + Task 8 专项练习）。
 *
 * imports PracticeModule：复用其导出的 JudgeCoreService（Task 2 错题重做判题用）。
 * repos 通过 @Inject('DATABASE_POOL') 注入全局连接池（DatabaseModule 是 @Global）。
 * HintCapability 构造函数的 modelClient 参数可选，可直接实例化（镜像 practice.module）。
 */
@Module({
  imports: [PracticeModule],
  controllers: [TrainingController],
  providers: [TrainingService, MainErrorBooksRepository, QuestionsRepository, QuestionHintsRepository, KnowledgePointsRepository, StudentHiddenQuestionsRepository, HintCapability],
})
export class TrainingModule {}
