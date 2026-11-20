import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminsRepository } from '../../database/repositories/admins.repo.js';
import { AuthSessionsRepository } from '../../database/repositories/auth-sessions.repo.js';
import { SessionRegistry } from '../../common/guards/session-registry.js';

/** 教研员账号管理（admin 端，2026-11-19 新增范围）。**只碰 `role='researcher'` 的行**。 */
@Injectable()
export class AdminStaffService {
  constructor(
    private readonly adminsRepo: AdminsRepository,
    private readonly authSessionsRepo: AuthSessionsRepository,
    private readonly sessionRegistry: SessionRegistry,
  ) {}

  async list(search: string) {
    const rows = await this.adminsRepo.listResearchers(search);
    return {
      items: rows.map((r) => ({
        id: r.id,
        username: r.username,
        name: r.name,
        isActive: r.isActive,
        createdAt: r.createdAt,
      })),
    };
  }

  async create(input: { username: string; name?: string; password: string }) {
    // findByUsername 覆盖全部角色：用户名与 admin 撞车也必须拒（登录按用户名分流，重名会串角色）。
    if (await this.adminsRepo.findByUsername(input.username)) {
      throw new ConflictException({ code: 1004, message: '用户名已存在' });
    }
    const passwordHash = await bcrypt.hash(input.password, 10);
    const name = input.name ?? null;
    const id = await this.adminsRepo.createResearcher({
      username: input.username,
      passwordHash,
      name,
    });
    return { id, username: input.username, name, isActive: true };
  }

  async setStatus(id: number, isActive: boolean) {
    await this.requireResearcher(id);
    await this.adminsRepo.setActive(id, isActive);
    if (!isActive) {
      // 停用即时踢下线：bump seq 后旧 token 在 AuthMiddleware 失配 → 1013。
      const seq = await this.authSessionsRepo.bumpAndReturnSeq('researcher', id);
      this.sessionRegistry.bump('researcher', id, seq);
    }
  }

  async resetPassword(id: number, password: string) {
    await this.requireResearcher(id);
    await this.adminsRepo.updatePassword(id, await bcrypt.hash(password, 10));
  }

  /** 目标必须是教研员：不存在 / 是 admin → 一律 404（不泄漏 admin 行的存在性）。 */
  private async requireResearcher(id: number) {
    const row = await this.adminsRepo.findById(id);
    if (!row || row.role !== 'researcher') {
      throw new NotFoundException({ code: 1002, message: '教研员不存在' });
    }
    return row;
  }
}
