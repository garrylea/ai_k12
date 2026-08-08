import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { RefineryModule } from '../refinery/refinery.module.js';

@Module({
  imports: [RefineryModule],
  controllers: [FilesController],
  providers: [FilesService, UploadedFilesRepository],
  exports: [FilesService],
})
export class FilesModule {}
