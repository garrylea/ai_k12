import { Module } from '@nestjs/common';
import { PracticeHistoryController } from './practice-history.controller.js';
import { PracticeHistoryService } from './practice-history.service.js';
import { TrainingModule } from '../training/training.module.js';
import {
  ExamSessionsRepository,
  SpecialPracticeSessionsRepository,
  SpecialAnswerRecordsRepository,
  ChinesePassagesRepository,
  QuestionsRepository,
} from '../../database/repositories/index.js';

/**
 * 练习记录模块（Task 4，2026-11-01）。
 *
 * 只读查询：考试 + 专项练习 UNION 列表、逐题作答详情。
 * 2026-11-06 起新增单题重做（POST …/redo）：复用 TrainingModule 导出的 HistoryPracticeService
 * 回放原题；仍不建会话、不写作答、不发分。
 * repos 通过 `@Inject('DATABASE_POOL')` 注入全局连接池（DatabaseModule 是 @Global）。
 */
@Module({
  imports: [TrainingModule],
  controllers: [PracticeHistoryController],
  providers: [
    PracticeHistoryService,
    ExamSessionsRepository,
    SpecialPracticeSessionsRepository,
    SpecialAnswerRecordsRepository,
    ChinesePassagesRepository,
    QuestionsRepository,
  ],
})
export class PracticeHistoryModule {}
