import { Module } from '@nestjs/common';
import { ProgressController } from './progress.controller.js';
import { ProgressService } from './progress.service.js';
import { ContentModule } from '../content/content.module.js';
import { PracticeModule } from '../practice/practice.module.js';
import { ProgressRepository } from '../../database/repositories/progress.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { LessonsRepository } from '../../database/repositories/lessons.repo.js';
import { UnitsRepository } from '../../database/repositories/units.repo.js';
import { SemestersRepository } from '../../database/repositories/semesters.repo.js';

@Module({
  imports: [ContentModule, PracticeModule],
  controllers: [ProgressController],
  providers: [ProgressService, ProgressRepository, StudentsRepository, LessonsRepository, UnitsRepository, SemestersRepository],
  exports: [ProgressService],
})
export class ProgressModule {}
