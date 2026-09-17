import { Module } from '@nestjs/common';
import { TrainingController } from './training.controller.js';
import { TrainingService } from './training.service.js';
import { MeaningController } from './meaning.controller.js';
import { MeaningService } from './meaning.service.js';
import { VocabularyController } from './vocabulary.controller.js';
import { VocabularyService } from './vocabulary.service.js';
import { PracticeModule } from '../practice/practice.module.js';
import { PointsModule } from '../points/points.module.js';
import { MainErrorBooksRepository, QuestionsRepository, QuestionHintsRepository, KnowledgePointsRepository, StudentHiddenQuestionsRepository, AdminNotificationsRepository, ChinesePassagesRepository, EnglishWordsRepository, StudentWordProgressRepository } from '../../database/repositories/index.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';
import { DictationFeedbackCapability } from '../../ai-core/capabilities/dictation-feedback.capability.js';
import { InterpretationJudgeCapability } from '../../ai-core/capabilities/interpretation-judge.capability.js';
import { EnglishWordJudgeCapability } from '../../ai-core/capabilities/english-word-judge.capability.js';
import { ChineseMeaningJudgeCapability } from '../../ai-core/capabilities/chinese-meaning-judge.capability.js';

/**
 * 错题训练模块（Task 1 骨架 + Task 2 判题 + Task 3 提示缓存 + Task 8 专项练习 + Task 7 解析拉取）。
 *
 * imports PracticeModule：复用其导出的 JudgeCoreService（Task 2 错题重做判题用）
 * 与 ExplanationCacheService（Task 7 批量拉解析/单题刷新等待用；已由 PracticeModule 导出注入，
 * 勿在 providers 重复 provide——会产生第二个空队列实例）。
 * repos 通过 @Inject('DATABASE_POOL') 注入全局连接池（DatabaseModule 是 @Global）。
 * HintCapability 构造函数的 modelClient 参数可选，可直接实例化（镜像 practice.module）。
 *
 * 英语背单词（2026-09-16）走**独立的 controller/service**（`/api/training/vocabulary`），
 * 不塞进 TrainingController/TrainingService——那两个已被数学 + 语文撑到数百行，
 * 模块归属不变，只是文件划分更清楚。`EnglishWordJudgeCapability` 同理可直接实例化。
 *
 * 语文古诗文「含义」专项（2026-09-17）同样走独立 controller/service（`/api/training/meaning`），
 * 理由同上；`ChineseMeaningJudgeCapability` 与其它 ai-core capability 一样不写 `@Injectable()`
 * （零参实例化，避开接口类型可选参数的 DI 坑），仍列进 providers 由 Nest 直接 new。
 *
 * imports PointsModule（2026-09-17）：三个语文专项的判题要调 `PointsService.award` 发分
 * （甲类逐目标发分）。**无循环依赖**：PointsModule → ParentModule → AdminModule/ContentModule，
 * 这条链不回到 TrainingModule（改这里之前请复核）。
 */
@Module({
  imports: [PracticeModule, PointsModule],
  controllers: [TrainingController, VocabularyController, MeaningController],
  providers: [TrainingService, VocabularyService, MeaningService, MainErrorBooksRepository, QuestionsRepository, QuestionHintsRepository, KnowledgePointsRepository, StudentHiddenQuestionsRepository, AdminNotificationsRepository, HintCapability, ChinesePassagesRepository, DictationFeedbackCapability, InterpretationJudgeCapability, EnglishWordsRepository, StudentWordProgressRepository, EnglishWordJudgeCapability, ChineseMeaningJudgeCapability],
})
export class TrainingModule {}
