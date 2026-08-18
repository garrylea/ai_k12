import { Injectable, Inject, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import * as bcrypt from 'bcrypt';
import { AdminsRepository } from '../../database/repositories/admins.repo.js';

@Injectable()
export class AdminDashboardService {
  constructor(
    @Inject('DATABASE_POOL') private pool: Pool,
    private adminsRepo: AdminsRepository,
  ) {}

  /** 管理台仪表盘：四个统计计数 + 最近注册家长前 10。 */
  async get() {
    const [[parentRows], [studentRows], [todayRows], [modelRows], [recentParents]] = await Promise.all([
      this.pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS c FROM parents WHERE deleted_at IS NULL'),
      this.pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS c FROM students WHERE deleted_at IS NULL'),
      this.pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS c FROM ai_dialogues WHERE created_at >= CURDATE()'),
      this.pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS c FROM llm_models WHERE is_enabled = 1'),
      this.pool.execute<RowDataPacket[]>(
        `SELECT p.id, p.phone, p.name, (p.is_active = 1) AS isActive,
                (SELECT COUNT(*) FROM students s WHERE s.parent_id = p.id AND s.deleted_at IS NULL) AS studentCount,
                p.created_at AS createdAt
         FROM parents p WHERE p.deleted_at IS NULL ORDER BY p.id DESC LIMIT 10`),
    ]);
    return {
      parentCount: Number(parentRows[0].c),
      studentCount: Number(studentRows[0].c),
      todayAiCalls: Number(todayRows[0].c),
      enabledModelCount: Number(modelRows[0].c),
      recentParents: recentParents.map((r: any) => ({
        id: r.id, phone: r.phone, name: r.name, isActive: r.isActive === 1, studentCount: Number(r.studentCount), createdAt: r.createdAt,
      })),
    };
  }

  /** 改自己密码：旧密码 bcrypt 验证（错 1003），新密码 6-32 位，bcrypt hash 后更新。 */
  async changePassword(adminId: number, oldPassword: string, newPassword: string) {
    if (newPassword.length < 6 || newPassword.length > 32) {
      throw new ConflictException({ code: 1001, message: '新密码长度需为 6-32 位' });
    }
    const admin = await this.adminsRepo.findById(adminId);
    if (!admin) throw new NotFoundException({ code: 1002, message: '管理员不存在' });
    const ok = await bcrypt.compare(oldPassword, admin.passwordHash);
    if (!ok) throw new UnauthorizedException({ code: 1003, message: '旧密码错误' });
    await this.adminsRepo.updatePassword(adminId, await bcrypt.hash(newPassword, 10));
  }
}
