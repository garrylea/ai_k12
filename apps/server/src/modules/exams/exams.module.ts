import { Module } from '@nestjs/common';
import { ExamsController } from './exams.controller.js';
import { ExamsService } from './exams.service.js';
import { ExamPapersRepository, ExamSessionsRepository, MainErrorBooksRepository } from '../../database/repositories/index.js';
import { PracticeModule } from '../practice/practice.module.js';

/**
 * 考试模块（Task 1 试卷列表/详情 + Task 2 会话生命周期）。
 *
 * imports PracticeModule：复用其导出的 JudgeCoreService（单题提交/在途补判，
 * source='exam'）。repos 通过 @Inject('DATABASE_POOL') 注入全局连接池
 * （DatabaseModule 是 @Global）。
 */
@Module({
  imports: [PracticeModule],
  controllers: [ExamsController],
  providers: [ExamsService, ExamPapersRepository, ExamSessionsRepository, MainErrorBooksRepository],
})
export class ExamsModule {}
