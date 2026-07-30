import { Module } from '@nestjs/common';
import { ProgressController } from './progress.controller.js';
import { ProgressService } from './progress.service.js';
import { ContentModule } from '../content/content.module.js';
import { ProgressRepository } from '../../database/repositories/progress.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';

@Module({
  imports: [ContentModule],
  controllers: [ProgressController],
  providers: [ProgressService, ProgressRepository, StudentsRepository],
  exports: [ProgressService],
})
export class ProgressModule {}
