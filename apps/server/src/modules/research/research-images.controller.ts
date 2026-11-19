import {
  BadRequestException, Body, Controller, Delete, Post, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ResearchImagesService } from './research-images.service.js';
import { FilesService } from '../files/files.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

/** MIME 白名单 image/*（spec §7.7），导出以便单测直接钉住拒绝行为。 */
export function researchImageFileFilter(
  _req: unknown,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
): void {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new BadRequestException({ code: 1001, message: '仅支持图片' }), false);
  }
}

/** 教研图片上传 / 取消清理 / GC：仅 researcher 可访问（spec §7.7–7.9）。 */
@Controller('api/research/images')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('researcher')
export class ResearchImagesController {
  constructor(
    private readonly service: ResearchImagesService,
    private readonly files: FilesService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: researchImageFileFilter,
  }))
  upload(@UploadedFile() file: Express.Multer.File, @CurrentUser() u: JwtUser) {
    if (!file) {
      throw new BadRequestException({ code: 1001, message: '缺少上传文件' });
    }
    return this.files.store(file, u.sub, 'research', 'researcher');
  }

  @Delete()
  remove(@Body() body: { urls: string[] }, @CurrentUser() u: JwtUser) {
    if (!Array.isArray(body?.urls) || body.urls.some((x) => typeof x !== 'string')) {
      throw new BadRequestException({ code: 1001, message: 'urls 必须是字符串数组' });
    }
    return this.service.cleanupUnreferenced(body.urls, u);
  }

  @Post('gc')
  gc(@Body() body: { olderThanHours?: number } | undefined, @CurrentUser() u: JwtUser) {
    const hours = body?.olderThanHours ?? 24;
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      throw new BadRequestException({ code: 1001, message: 'olderThanHours 范围 1–720' });
    }
    return this.service.gc(hours, u);
  }
}
