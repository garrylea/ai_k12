import { Injectable, NotFoundException } from '@nestjs/common';
import { ParentsRepository } from '../../database/repositories/parents.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { BanRegistry } from '../../common/guards/ban-registry.js';

@Injectable()
export class AdminAccountsService {
  constructor(
    private parentsRepo: ParentsRepository,
    private studentsRepo: StudentsRepository,
    private banRegistry: BanRegistry,
  ) {}

  async searchParents(q: string) {
    return this.parentsRepo.search(q);
  }

  async searchStudents(q: string) {
    return this.studentsRepo.search(q);
  }

  async setParentStatus(parentId: number, active: boolean) {
    const p = await this.parentsRepo.findById(parentId);
    if (!p) throw new NotFoundException({ code: 1002, message: '家长不存在' });
    await this.parentsRepo.setActive(parentId, active);
    active ? this.banRegistry.unbanParent(parentId) : this.banRegistry.banParent(parentId);
    const children = await this.studentsRepo.findByParentId(parentId);
    for (const c of children) {
      await this.studentsRepo.setActive(c.id, active);
      active ? this.banRegistry.unbanStudent(c.id) : this.banRegistry.banStudent(c.id);
    }
  }

  async setStudentStatus(studentId: number, active: boolean) {
    const s = await this.studentsRepo.findById(studentId);
    if (!s) throw new NotFoundException({ code: 1002, message: '学生不存在' });
    await this.studentsRepo.setActive(studentId, active);
    active ? this.banRegistry.unbanStudent(studentId) : this.banRegistry.banStudent(studentId);
  }
}
