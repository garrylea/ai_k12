import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { AdminsRepository } from '../../database/repositories/admins.repo.js';
import { ParentsRepository } from '../../database/repositories/parents.repo.js';

const PHONE_RE = /^1\d{10}$/;

@Injectable()
export class AuthService {
  constructor(
    private studentsRepo: StudentsRepository,
    private adminsRepo: AdminsRepository,
    private parentsRepo: ParentsRepository,
    private jwtService: JwtService,
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
}
