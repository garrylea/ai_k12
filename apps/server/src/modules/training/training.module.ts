import { Module } from '@nestjs/common';
import { TrainingController } from './training.controller.js';
import { TrainingService } from './training.service.js';
import { PracticeModule } from '../practice/practice.module.js';
import { MainErrorBooksRepository, QuestionsRepository } from '../../database/repositories/index.js';

/**
 * 错题训练模块（骨架，Task 1）。
 *
 * imports PracticeModule：复用其导出的 JudgeCoreService（Task 2 错题重做判题用）。
 * repos 通过 @Inject('DATABASE_POOL') 注入全局连接池（DatabaseModule 是 @Global）。
 */
@Module({
  imports: [PracticeModule],
  controllers: [TrainingController],
  providers: [TrainingService, MainErrorBooksRepository, QuestionsRepository],
})
export class TrainingModule {}
