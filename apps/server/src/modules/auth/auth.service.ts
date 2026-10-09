import { Injectable, UnauthorizedException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { AdminsRepository } from '../../database/repositories/admins.repo.js';
import { ParentsRepository } from '../../database/repositories/parents.repo.js';
import { SubscriptionsService } from '../billing/subscriptions.service.js';
import { PasswordResetCodeService } from './password-reset-code.service.js';

const PHONE_RE = /^1\d{10}$/;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private studentsRepo: StudentsRepository,
    private adminsRepo: AdminsRepository,
    private parentsRepo: ParentsRepository,
    private jwtService: JwtService,
    private subscriptionsService: SubscriptionsService,
    private resetCodeService: PasswordResetCodeService,
  ) {}

  /**
   * 统一三角色登录：admins(username) -> parents(phone) -> students(username)，
   * 命中即验密签发对应 role token。学生用户名为字母/数字非手机格式，歧义可忽略。
   */
  async login(username: string, password: string) {
    const admin = await this.adminsRepo.findByUsername(username);
    if (admin) {
      this.assertActive(admin.isActive);
      await this.assertPassword(password, admin.passwordHash);
      return {
        token: this.jwtService.sign({ sub: admin.id, role: 'admin' as const }),
        user: { id: admin.id, role: 'admin' as const, name: admin.name, username: admin.username },
      };
    }

    if (PHONE_RE.test(username)) {
      const parent = await this.parentsRepo.findByPhone(username);
      if (parent) {
        this.assertActive(parent.isActive);
        await this.assertPassword(password, parent.passwordHash);
        return {
          token: this.jwtService.sign({ sub: parent.id, role: 'parent' as const }),
          user: { id: parent.id, role: 'parent' as const, name: parent.name, phone: parent.phone },
        };
      }
    }

    const student = await this.studentsRepo.findByUsername(username);
    if (student) {
      this.assertActive(student.isActive);
      await this.assertPassword(password, student.passwordHash);
      return {
        token: this.jwtService.sign({
          sub: student.id,
          role: 'student' as const,
          familyId: student.parentId,
          parentId: student.parentId,
        }),
        user: {
          id: student.id,
          role: 'student' as const,
          name: student.name,
          username: student.username,
          grade: student.grade,
          parentId: student.parentId,
        },
      };
    }

    throw new UnauthorizedException({ code: 1003, message: '用户名或密码错误' });
  }

  /** 家长注册（注册即登录）。手机号唯一（软删行不占号）。 */
  async register(dto: { phone: string; password: string; name?: string }) {
    const existing = await this.parentsRepo.findByPhone(dto.phone);
    if (existing) {
      throw new ConflictException({ code: 1004, message: '该手机号已注册' });
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const parentId = await this.parentsRepo.create({
      phone: dto.phone,
      passwordHash,
      name: dto.name,
    });
    // 注册即送 7 天家庭试用（upsert 幂等）。注册路径无事务，直接 await：
    // 失败让注册可见地失败，保证「注册成功 ⇒ 试用行已存在」。
    await this.subscriptionsService.ensureTrial(parentId);
    return {
      token: this.jwtService.sign({ sub: parentId, role: 'parent' as const }),
      user: { id: parentId, role: 'parent' as const, name: dto.name ?? null, phone: dto.phone },
    };
  }

  private assertActive(isActive: boolean) {
    if (!isActive) {
      throw new UnauthorizedException({ code: 1003, message: '账号已停用' });
    }
  }

  private async assertPassword(plain: string, hash: string) {
    const valid = await bcrypt.compare(plain, hash);
    if (!valid) {
      throw new UnauthorizedException({ code: 1003, message: '用户名或密码错误' });
    }
  }

  /**
   * 忘记密码第一步：请求模拟验证码。验证码直接放进响应体（家庭自部署、
   * 局域网使用，spec 裁决不做防枚举：未注册手机号直接报错）。
   */
  async requestPasswordReset(phone: string) {
    const parent = await this.parentsRepo.findByPhone(phone);
    if (!parent) {
      throw new NotFoundException({ code: 1002, message: '该手机号未注册' });
    }
    const { code, expiresIn } = this.resetCodeService.issue(phone);
    this.logger.log(`[password-reset] phone=${phone.slice(0, 3)}****${phone.slice(7)} code=${code}`);
    return { code, expiresIn };
  }

  /**
   * 忘记密码第二步：验证码 + 新密码重置。成功不失效已签发 token
   * （与家长端「修改自己密码」PATCH /api/parent/password 行为一致）。
   */
  async resetPassword(dto: { phone: string; code: string; newPassword: string }) {
    this.resetCodeService.verify(dto.phone, dto.code);
    const parent = await this.parentsRepo.findByPhone(dto.phone);
    if (!parent) {
      throw new NotFoundException({ code: 1002, message: '该手机号未注册' });
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.parentsRepo.updatePassword(parent.id, passwordHash);
    return { success: true };
  }
}
