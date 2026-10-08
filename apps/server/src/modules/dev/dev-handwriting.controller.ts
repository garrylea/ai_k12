import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { DevHandwritingService } from './dev-handwriting.service.js';

/** 任一已登录角色可调（RolesGuard 无 @Roles 即放行，JWT 由 JwtAuthGuard 把守）。 */
@Controller('api/dev/handwriting')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DevHandwritingController {
  constructor(private readonly service: DevHandwritingService) {}

  @Get('models')
  listModels() {
    return this.service.listModels();
  }

  @Post('recognize')
  recognize(@Body() dto: { image?: string; modelKey?: string }) {
    return this.service.recognize(dto.image as string, dto.modelKey as string);
  }
}
