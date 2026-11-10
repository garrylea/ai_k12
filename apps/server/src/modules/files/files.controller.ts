import {
  BadRequestException,
  Controller,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FilesService } from './files.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

@Controller('api/files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtUser,
    @Query('source') source?: string,
  ) {
    if (!file) {
      throw new BadRequestException({ code: 1001, message: '缺少上传文件' });
    }
    const s = source ?? 'auxiliary';
    if (s !== 'auxiliary' && s !== 'freeform') {
      throw new BadRequestException({ code: 1001, message: 'source 仅支持 auxiliary | freeform' });
    }
    return this.filesService.upload(file, user.sub, s);
  }
}
