import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { DevHandwritingService } from './dev-handwriting.service.js';

/** dev-only 调研工具（spec 2026-10-08）：仅 admin 可调（2026-10-08 用户裁决收窄）。 */
@Controller('api/dev/handwriting')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class DevHandwritingController {
  constructor(private readonly service: DevHandwritingService) {}

  @Get('models')
  listModels() {
    return this.service.listModels();
  }

  @Post('recognize')
  recognize(@Body() dto: { image?: string; modelKey?: string }) {
    // 请求体缺失/键缺失时 @Body() 得到 undefined（防 TypeError → 500），与 service 的 400 口径对齐
    if (!dto?.image || !dto?.modelKey) {
      throw new BadRequestException({ code: 4003, message: 'image 与 modelKey 必填' });
    }
    return this.service.recognize(dto.image, dto.modelKey);
  }
}
