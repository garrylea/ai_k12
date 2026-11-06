import { Module } from '@nestjs/common';
import { PracticeHistoryController } from './practice-history.controller.js';
import { PracticeHistoryService } from './practice-history.service.js';
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
 * repos 通过 `@Inject('DATABASE_POOL')` 注入全局连接池（DatabaseModule 是 @Global）。
 */
@Module({
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
