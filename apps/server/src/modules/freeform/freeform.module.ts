import { Module } from '@nestjs/common';
import { FreeformController } from './freeform.controller.js';
import { FreeformRecognizeService } from './freeform-recognize.service.js';
import { FreeformJudgeService } from './freeform-judge.service.js';
import { MineruRunner } from './mineru-runner.js';
import { FreeformSplitCapability } from '../../ai-core/capabilities/freeform-split.capability.js';
import { FreeformJudgeCapability } from '../../ai-core/capabilities/freeform-judge.capability.js';
import {
  UploadedFilesRepository,
  QuestionsRepository,
  MainErrorBooksRepository,
  AiDialoguesRepository,
  AiMessagesRepository,
} from '../../database/repositories/index.js';
import { ConversationsModule } from '../conversations/conversations.module.js';

/**
 * 自由输入做题模块（任务书 Task 7）。
 *
 * 依赖形状与 practice/training 一致：repos 通过 `@Inject('DATABASE_POOL')` 注入
 * 全局连接池；capabilities 与 MineruRunner 无 `@Injectable()`、构造函数参数可选，
 * 直接作 provider 零参实例化。`FreeformRecognizeService` / `FreeformJudgeService`
 * 用**逐个具体类**的构造参数（不用 deps 对象）——接口类型参数会变成 `Object` token
 * 导致 Nest 启动失败（见 CLAUDE.md 的 DI 坑）。
 */
@Module({
  imports: [ConversationsModule],
  controllers: [FreeformController],
  providers: [
    MineruRunner,
    FreeformSplitCapability,
    FreeformJudgeCapability,
    FreeformRecognizeService,
    FreeformJudgeService,
    UploadedFilesRepository,
    QuestionsRepository,
    MainErrorBooksRepository,
    AiDialoguesRepository,
    AiMessagesRepository,
  ],
})
export class FreeformModule {}
