import { Module } from '@nestjs/common';
import { ResearchPapersRepository } from '../../database/repositories/research-papers.repo.js';
import { ResearchQuestionsRepository } from '../../database/repositories/research-questions.repo.js';
import { ContentAuditRepository } from '../../database/repositories/content-audit.repo.js';
import { ResearchPapersController } from './research-papers.controller.js';
import { ResearchPapersService } from './research-papers.service.js';
import { ResearchQuestionsController } from './research-questions.controller.js';
import { ResearchQuestionsService } from './research-questions.service.js';
import { ResearchImagesService } from './research-images.service.js';
import { ResearchImagesController } from './research-images.controller.js';
import { ResearchAuditController } from './research-audit.controller.js';
import { ResearchAuditService } from './research-audit.service.js';
import { FilesModule } from '../files/files.module.js';

/**
 * 教研空间（spec §7）：统一 @Roles('researcher') + JwtAuthGuard/RolesGuard。
 * Task 5/6/7 的详情、题目编辑、图片 controller/provider 在此逐步追加。
 */
@Module({
  imports: [FilesModule],
  controllers: [
    ResearchPapersController, ResearchQuestionsController, ResearchImagesController,
    ResearchAuditController,
  ],
  providers: [
    ResearchPapersRepository,
    ResearchQuestionsRepository,
    ContentAuditRepository,
    ResearchPapersService,
    ResearchQuestionsService,
    ResearchImagesService,
    ResearchAuditService,
  ],
})
export class ResearchModule {}
