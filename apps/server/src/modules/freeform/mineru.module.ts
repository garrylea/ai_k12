import { Module } from '@nestjs/common';
import { MineruConfigRepository } from '../../database/repositories/mineru-config.repo.js';
import { MineruRunner } from './mineru-runner.js';
import { MineruConfigService } from './mineru-config.service.js';

/**
 * 识图（MinerU）配置与执行器的共享模块：freeform 识题要用，admin 后台要读写配置。
 * `MineruRunner` 零参构造、无 `@Injectable()`，直接作 provider 零参实例化。
 */
@Module({
  providers: [MineruConfigRepository, MineruRunner, MineruConfigService],
  exports: [MineruConfigService, MineruRunner],
})
export class MineruModule {}
