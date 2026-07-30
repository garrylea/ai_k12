import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { StudentsRepository } from '../../database/repositories/students.repo.js';

@Injectable()
export class AuthService {
  constructor(
    private studentsRepo: StudentsRepository,
    private jwtService: JwtService,
  ) {}

  async login(username: string, password: string) {
    // MVP: student login only (parent login added later)
    const student = await this.studentsRepo.findByUsername(username);
    if (!student) {
      throw new UnauthorizedException({ code: 1003, message: '用户名或密码错误' });
    }

    const valid = await bcrypt.compare(password, student.passwordHash);
    if (!valid) {
      throw new UnauthorizedException({ code: 1003, message: '用户名或密码错误' });
    }

    const payload = {
      sub: student.id,
      role: 'student' as const,
      familyId: student.parentId,
      parentId: student.parentId,
    };

    return {
      token: this.jwtService.sign(payload),
      user: {
        id: student.id,
        role: 'student' as const,
        name: student.name,
        username: student.username,
        grade: student.grade,
      },
    };
  }

  async register(dto: {
    username: string;
    password: string;
    name: string;
    grade?: string;
  }) {
    const existing = await this.studentsRepo.findByUsername(dto.username);
    if (existing) {
      throw new UnauthorizedException({ code: 1003, message: '用户名已存在' });
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    // In MVP, use a default parent ID of 1 (must exist or we create one)
    const studentId = await this.studentsRepo.create({
      parentId: 1,
      username: dto.username,
      passwordHash,
      name: dto.name,
      grade: dto.grade,
    });

    const payload = {
      sub: studentId,
      role: 'student' as const,
      familyId: 1,
      parentId: 1,
    };

    return {
      token: this.jwtService.sign(payload),
      user: {
        id: studentId,
        role: 'student' as const,
        name: dto.name,
        username: dto.username,
        grade: dto.grade,
      },
    };
  }
}
