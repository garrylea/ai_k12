import { Module } from '@nestjs/common';
import { RefineryController } from './refinery.controller.js';
import { RefineryService } from './refinery.service.js';
import { MinerUService } from './mineru.service.js';
import { ExtractTasksRepository } from '../../database/repositories/extract-tasks.repo.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';

@Module({
  controllers: [RefineryController],
  providers: [RefineryService, MinerUService, ExtractTasksRepository, UploadedFilesRepository, QuestionStructuringCapability],
  exports: [RefineryService],
})
export class RefineryModule {}
