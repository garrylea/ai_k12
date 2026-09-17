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
  // PointsModule 的家长端 controller（Task 8）注入 ParentService 做归属校验；
  // 不导出的话 Nest 启动时就报「can't resolve dependencies」。
  exports: [ParentService],
})
export class ParentModule {}
