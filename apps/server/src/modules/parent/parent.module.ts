import { Module } from '@nestjs/common';
import { ParentController } from './parent.controller.js';
import { ParentService } from './parent.service.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { AdminModule } from '../admin/admin.module.js';

@Module({
  imports: [AdminModule],
  controllers: [ParentController],
  providers: [ParentService, StudentsRepository],
})
export class ParentModule {}
