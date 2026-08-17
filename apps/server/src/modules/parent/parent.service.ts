import { Injectable, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { StudentsRepository } from '../../database/repositories/students.repo.js';

/** grade -> school_level（data-school 字体档位）。 */
export function deriveSchoolLevel(grade: string): 'primary' | 'junior' | 'senior' {
  if (grade.startsWith('小学')) return 'primary';
  if (['初一', '初二', '初三'].includes(grade)) return 'junior';
  if (['高一', '高二', '高三'].includes(grade)) return 'senior';
  throw new ConflictException({ code: 1001, message: '年级不合法' });
}

@Injectable()
export class ParentService {
  constructor(private studentsRepo: StudentsRepository) {}

  async createStudent(
    parentId: number,
    dto: { name: string; username: string; password: string; age: number; grade: string },
  ) {
    const existing = await this.studentsRepo.findByUsername(dto.username);
    if (existing) {
      throw new ConflictException({ code: 1004, message: '用户名已存在' });
    }
    const schoolLevel = deriveSchoolLevel(dto.grade);
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const studentId = await this.studentsRepo.create({
      parentId,
      username: dto.username,
      passwordHash,
      name: dto.name,
      age: dto.age,
      grade: dto.grade,
      schoolLevel,
    });
    await this.studentsRepo.createDefaultSettings(studentId, schoolLevel);
    return { id: studentId };
  }

  async listStudents(parentId: number) {
    const students = await this.studentsRepo.findByParentId(parentId);
    return students.map(({ passwordHash: _ph, ...rest }) => rest);
  }

  async resetPassword(parentId: number, studentId: number, newPassword: string) {
    const student = await this.requireOwnedStudent(parentId, studentId);
    if (newPassword.length < 6 || newPassword.length > 32) {
      throw new ConflictException({ code: 1001, message: '密码长度需为 6-32 位' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.studentsRepo.updatePassword(student.id, passwordHash);
  }

  async setStatus(parentId: number, studentId: number, isActive: boolean) {
    const student = await this.requireOwnedStudent(parentId, studentId);
    await this.studentsRepo.setActive(student.id, isActive);
  }

  /** 归属校验：先查存在（1002），再比对 parent_id（1005，不泄漏存在性）。 */
  private async requireOwnedStudent(parentId: number, studentId: number) {
    const student = await this.studentsRepo.findById(studentId);
    if (!student) {
      throw new NotFoundException({ code: 1002, message: '学生不存在' });
    }
    if (student.parentId !== parentId) {
      throw new ForbiddenException({ code: 1005, message: '无权操作该学生' });
    }
    return student;
  }
}
