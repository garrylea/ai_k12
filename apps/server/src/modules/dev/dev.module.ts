import { Module } from '@nestjs/common';
import { DevHandwritingController } from './dev-handwriting.controller.js';
import { DevHandwritingService } from './dev-handwriting.service.js';

@Module({
  controllers: [DevHandwritingController],
  // useFactory 手动实例化：DevHandwritingService 故意不写 @Injectable()（DI 坑，见 Global Constraints）
  providers: [{ provide: DevHandwritingService, useFactory: () => new DevHandwritingService() }],
})
export class DevModule {}
