import { Module } from '@nestjs/common';
import { ExamsController } from './exams.controller.js';
import { ExamsService } from './exams.service.js';
import { ExamPapersRepository } from '../../database/repositories/index.js';

/**
 * 考试模块（Task 1 骨架：试卷列表/详情；Task 2 起加考试会话）。
 *
 * repos 通过 @Inject('DATABASE_POOL') 注入全局连接池（DatabaseModule 是 @Global）。
 * 暂不 import PracticeModule（Task 2 判题复用时再加）。
 */
@Module({
  controllers: [ExamsController],
  providers: [ExamsService, ExamPapersRepository],
})
export class ExamsModule {}
