import { Module } from '@nestjs/common';
import { ParentController } from './parent.controller.js';
import { ParentService } from './parent.service.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { ProgressRepository } from '../../database/repositories/progress.repo.js';
import { TextbookVersionsRepository } from '../../database/repositories/textbook-versions.repo.js';
import { SemestersRepository } from '../../database/repositories/semesters.repo.js';
import { AdminModule } from '../admin/admin.module.js';
import { ContentModule } from '../content/content.module.js';

@Module({
  imports: [AdminModule, ContentModule],
  controllers: [ParentController],
  providers: [
    ParentService,
    StudentsRepository,
    ProgressRepository,
    TextbookVersionsRepository,
    SemestersRepository,
  ],
})
export class ParentModule {}
