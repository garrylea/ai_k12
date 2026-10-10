import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { BanRegistry } from './guards/ban-registry.js';
import { SessionRegistry } from './guards/session-registry.js';
import { ParentsRepository } from '../database/repositories/parents.repo.js';
import { StudentsRepository } from '../database/repositories/students.repo.js';
import { AuthSessionsRepository } from '../database/repositories/auth-sessions.repo.js';

/** 跨模块共享的进程内单例（BanRegistry 等）。AppModule 与 AdminModule 都 import 本模块以拿到同一实例。 */
@Module({
  providers: [BanRegistry, SessionRegistry, ParentsRepository, StudentsRepository, AuthSessionsRepository],
  exports: [BanRegistry, SessionRegistry, ParentsRepository, StudentsRepository, AuthSessionsRepository],
})
export class CommonModule implements OnModuleInit {
  private readonly logger = new Logger(CommonModule.name);

  constructor(
    private banRegistry: BanRegistry,
    private sessionRegistry: SessionRegistry,
    private parentsRepo: ParentsRepository,
    private studentsRepo: StudentsRepository,
    private authSessionsRepo: AuthSessionsRepository,
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

    // 启动时从 auth_sessions 重建会话序号注册表。失败 → 注册表为空 → 所有旧 token
    // 视为失配被踢（宁踢勿放，各端重新登录即恢复）；与 ban 的 fail-open 相反，必须
    // 大声记录而不是静默吞掉。
    try {
      this.sessionRegistry.load(await this.authSessionsRepo.listAll());
    } catch (err) {
      this.logger.error(`SessionRegistry 启动重建失败（所有旧 token 将被踢，需重新登录）：${String(err)}`);
    }
  }
}
