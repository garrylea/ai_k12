import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminsRepository } from '../../database/repositories/admins.repo.js';
import { AuthSessionsRepository } from '../../database/repositories/auth-sessions.repo.js';
import { SessionRegistry } from '../../common/guards/session-registry.js';

/** 控制器 zod 与服务层最后防线共用同一规则，避免两处漂移。 */
export const USERNAME_RE = /^[a-zA-Z0-9_]{3,50}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 72;

/**
 * 服务层最后防线（同 parent.controller.ts 的 ChangePasswordSchema 注释口径）：
 * 直连服务的调用方绕过 controller schema 时也必须被拦住，错误一律 400/1001。
 */
function assertUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new BadRequestException({ code: 1001, message: '用户名只能包含字母、数字、下划线，3-50 位' });
  }
}

function assertPassword(password: string): void {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new BadRequestException({ code: 1001, message: `密码需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 位` });
  }
}

/** 教研员账号管理（admin 端，2026-11-19 新增范围）。**只碰 `role='researcher'` 的行**。 */
@Injectable()
export class AdminStaffService {
  constructor(
    private readonly adminsRepo: AdminsRepository,
    private readonly authSessionsRepo: AuthSessionsRepository,
    private readonly sessionRegistry: SessionRegistry,
  ) {}

  async list(search: string) {
    const { items, total } = await this.adminsRepo.listResearchers(search);
    return {
      items: items.map((r) => ({
        id: r.id,
        username: r.username,
        name: r.name,
        isActive: r.isActive,
        createdAt: r.createdAt,
      })),
      total,
    };
  }

  async create(input: { username: string; name?: string; password: string }) {
    assertUsername(input.username);
    assertPassword(input.password);
    // findByUsername 覆盖全部角色：用户名与 admin 撞车也必须拒（登录按用户名分流，重名会串角色）。
    if (await this.adminsRepo.findByUsername(input.username)) {
      throw new ConflictException({ code: 1004, message: '用户名已存在' });
    }
    const passwordHash = await bcrypt.hash(input.password, 10);
    const name = input.name?.trim() || null;
    const id = await this.adminsRepo.createResearcher({
      username: input.username,
      passwordHash,
      name,
    });
    return { id, username: input.username, name, isActive: true };
  }

  /**
   * 启用/停用。**停用必须先 bump 再置 is_active=0**（2026-11-20 终审修正）：
   * bump 会刻意在异常时抛错，若先停用后 bump 失败，账号已停用但旧 token 仍与注册表匹配、
   * 且重启会把未 bump 的 token_seq 载回 —— 安全控制 fail-open。反过来则失败只是
   * 「账号仍启用但旧 token 已被踢」，重试即可收敛（fail-closed）。
   */
  async setStatus(id: number, isActive: boolean) {
    await this.requireResearcher(id);
    if (!isActive) {
      // 停用即时踢下线：bump seq 后旧 token 在 AuthMiddleware 失配 → 1013。
      const seq = await this.authSessionsRepo.bumpAndReturnSeq('researcher', id);
      this.sessionRegistry.bump('researcher', id, seq);
    }
    await this.adminsRepo.setActive(id, isActive);
  }

  async resetPassword(id: number, password: string) {
    assertPassword(password);
    await this.requireResearcher(id);
    await this.adminsRepo.updateResearcherPassword(id, await bcrypt.hash(password, 10));
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
