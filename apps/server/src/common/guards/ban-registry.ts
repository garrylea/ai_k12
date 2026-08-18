import { Injectable } from '@nestjs/common';

/** 进程内封禁名单：管理员封/解封时同步，AuthMiddleware O(1) 查验（重启从 DB is_active=0 重建）。 */
@Injectable()
export class BanRegistry {
  private parents = new Set<number>();
  private students = new Set<number>();

  banParent(id: number) { this.parents.add(id); }
  unbanParent(id: number) { this.parents.delete(id); }
  banStudent(id: number) { this.students.add(id); }
  unbanStudent(id: number) { this.students.delete(id); }

  isBanned(role: string, id: number): boolean {
    if (role === 'parent') return this.parents.has(id);
    if (role === 'student') return this.students.has(id);
    return false; // admin 不走封禁
  }

  /** 启动时从 DB is_active=0 重建（Task 10 接线调用）。 */
  load(parentIds: number[], studentIds: number[]) {
    this.parents = new Set(parentIds);
    this.students = new Set(studentIds);
  }
}
