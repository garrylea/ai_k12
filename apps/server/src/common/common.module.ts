import { Module, OnModuleInit } from '@nestjs/common';
import { BanRegistry } from './guards/ban-registry.js';
import { ParentsRepository } from '../database/repositories/parents.repo.js';
import { StudentsRepository } from '../database/repositories/students.repo.js';

/** 跨模块共享的进程内单例（BanRegistry 等）。AppModule 与 AdminModule 都 import 本模块以拿到同一实例。 */
@Module({
  providers: [BanRegistry, ParentsRepository, StudentsRepository],
  exports: [BanRegistry, ParentsRepository, StudentsRepository],
})
export class CommonModule implements OnModuleInit {
  constructor(
    private banRegistry: BanRegistry,
    private parentsRepo: ParentsRepository,
    private studentsRepo: StudentsRepository,
  ) {}

  async onModuleInit() {
    // 启动时从 DB is_active=0 重建封禁名单（内存态重启即空，需回填）
    try {
      const [parents, students] = await Promise.all([
        this.parentsRepo.listInactive(), this.studentsRepo.listInactive(),
      ]);
      this.banRegistry.load(
        parents.map((p) => p.id), students.map((s) => s.id));
    } catch { /* DB 不可用忽略，下次登录时 is_active 仍会拦截 */ }
  }
}
