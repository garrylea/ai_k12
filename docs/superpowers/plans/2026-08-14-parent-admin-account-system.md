# 三角色账号体系（管理员/家长/学生）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员（seed）+ 家长（自助注册）+ 学生（家长创建）三角色统一登录与权限地基，家长控制台学生账号管理（建/重置密码/停用启用），学生端零改动。

**Architecture:** 方案 A——新增 `admins` 表，`parents`/`students` 补 `is_active` 字段；统一 `POST /api/auth/login` 按 admins->parents->students 顺序查询命中并签发带 `role` 的 JWT；复用已存在的 `RolesGuard`+`@Roles()` 装饰器做角色守卫（此前从未接线）；新增 `ParentModule` 管理学生子账号；前端按 role 路由 + `RequireRole` 守卫组件。规格见 `docs/superpowers/specs/2026-08-14-parent-admin-account-system-design.md`。

**Tech Stack:** NestJS 10 + mysql2 + bcrypt + Zod + Vitest（server）；React Router 6 + Vite + TS + Tailwind（web）；MySQL 迁移 SQL。

**重要背景（工程师必读）：**
- 所有 server 命令在 `apps/server/` 下跑：`npm test`（vitest）、`npm run build`（tsc）、`npx tsx src/scripts/<x>.ts`（脚本；Nest 应用本身别用 tsx 跑，DI 会全 undefined）。
- 所有 web 命令在 `apps/web/` 下跑：`npm run build`（tsc -b + vite）、`npm run lint`。
- 响应格式：成功 `{ code:0, message, data }`（ResponseInterceptor 包裹），异常经 `HttpExceptionFilter` 输出 `{ code, message, data:null }`（透传 `...rest`）。controller 直接 return 数据、throw `HttpException({code,message}, status)`。
- 现有 `JwtUser`（`apps/server/src/common/guards/jwt-auth.guard.ts`）只有 `'parent'|'student'`，`familyId` 必填；本计划改为三角色 + `familyId?`。
- `RolesGuard`（`apps/server/src/common/guards/roles.guard.ts`）和 `@Roles()`（`apps/server/src/common/decorators/roles.ts`）已实现未接线，直接用。
- 前端无 authStore；`LoginPage` 直接调 `login()` 后把 `token`/`userRole`/`username`/`userId` 写 localStorage，`fetchApi` 自动带 `Authorization`。沿用此模式，不新建 store。
- DB 连接：`apps/server/.env` 的 `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME`（当前 localhost/ai_k12/ai_k12/ai_k12）。

---

### Task 1: DB 迁移 + schema.sql + DB 设计文档同步

**Files:**
- Create: `tools/db/migrations/2026-08-14_add_admins_and_active_flags.sql`
- Modify: `tools/db/schema.sql`（§1 用户与权限节）
- Modify: `docs/K12智学系统-数据库设计文档.md`（版本号 + admins 表 + 字段说明）

- [ ] **Step 1: 写迁移 SQL**

```sql
-- 2026-08-14 三角色账号体系：admins 表 + parents/students is_active。
-- 一次性运行；幂等性靠 IF NOT EXISTS / 条件判断（MySQL 8 无 ADD COLUMN IF NOT EXISTS，重复跑会报错，可忽略）。

CREATE TABLE IF NOT EXISTS admins (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(50) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  UNIQUE KEY uniq_admins_username (username, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE parents ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER avatar_url;
ALTER TABLE students ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER school_level;

-- 历史行兜底：age/school_level 缺失的按 grade 回填（grade 为空则置小学，最保守）。
UPDATE students SET school_level = CASE
    WHEN grade LIKE '小学%' THEN 'primary'
    WHEN grade IN ('初一','初二','初三') THEN 'junior'
    WHEN grade IN ('高一','高二','高三') THEN 'senior'
    ELSE 'primary' END
  WHERE school_level IS NULL OR school_level = '';
UPDATE students SET age = 11 WHERE age IS NULL OR age = 0;
```

- [ ] **Step 2: 在 MySQL 执行迁移**

Run: `mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-08-14_add_admins_and_active_flags.sql && mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW TABLES LIKE 'admins'; SHOW COLUMNS FROM students LIKE 'is_active';"`
Expected: `admins` 出现在表清单、`is_active` 列存在、无报错。

- [ ] **Step 3: 同步 `tools/db/schema.sql`**

在 `parents` 表 `avatar_url` 行后加：

```sql
  is_active TINYINT(1) NOT NULL DEFAULT 1,
```

在 `students` 表 `school_level` 行后加同上一行。在 `students` 表定义之后（`student_settings` 之前）插入 Task 1 Step 1 的完整 `CREATE TABLE IF NOT EXISTS admins (...)` 块，并把文件头部注释「版本 v1.5」升为 v1.7（v1.6 已被 2026-08-12 占用）。

- [ ] **Step 4: 同步 DB 设计文档**

`docs/K12智学系统-数据库设计文档.md`：版本日志加 v1.7 条目（admins 表、parents/students.is_active）；§3.1 加 admins 表字段表（对齐 parents 节格式）；parents/students 字段表各加 `is_active` 行，含义「账号启停开关，0=停用（登录被拒，数据保留）」。

- [ ] **Step 5: Commit**

```bash
git add tools/db/migrations/2026-08-14_add_admins_and_active_flags.sql tools/db/schema.sql docs/K12智学系统-数据库设计文档.md
git commit -m "feat(db): admins 表 + parents/students is_active 迁移与文档同步"
```

---

### Task 2: AdminsRepository + ParentsRepository

**Files:**
- Create: `apps/server/src/database/repositories/admins.repo.ts`
- Create: `apps/server/src/database/repositories/parents.repo.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（如该文件做统一导出）

- [ ] **Step 1: 写 `admins.repo.ts`**（对齐 `students.repo.ts` 风格）

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AdminRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  name: string | null;
  is_active: number;
  deleted_at: Date | null;
}

export interface Admin {
  id: number;
  username: string;
  passwordHash: string;
  name: string | null;
  isActive: boolean;
}

@Injectable()
export class AdminsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findByUsername(username: string): Promise<Admin | null> {
    const [rows] = await this.pool.execute<AdminRow[]>(
      'SELECT * FROM admins WHERE username = ? AND deleted_at IS NULL',
      [username],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  private mapRow(row: AdminRow): Admin {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      name: row.name,
      isActive: row.is_active === 1,
    };
  }
}
```

- [ ] **Step 2: 写 `parents.repo.ts`**

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface ParentRow extends RowDataPacket {
  id: number;
  phone: string;
  password_hash: string;
  name: string | null;
  is_active: number;
  deleted_at: Date | null;
}

export interface Parent {
  id: number;
  phone: string;
  passwordHash: string;
  name: string | null;
  isActive: boolean;
}

@Injectable()
export class ParentsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  /** 软删行（deleted_at 非空）不返回，同手机号可重新注册。 */
  async findByPhone(phone: string): Promise<Parent | null> {
    const [rows] = await this.pool.execute<ParentRow[]>(
      'SELECT * FROM parents WHERE phone = ? AND deleted_at IS NULL',
      [phone],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async create(data: { phone: string; passwordHash: string; name?: string }): Promise<number> {
    const [result] = await this.pool.execute(
      'INSERT INTO parents (phone, password_hash, name) VALUES (?, ?, ?)',
      [data.phone, data.passwordHash, data.name ?? null],
    );
    return (result as any).insertId;
  }

  private mapRow(row: ParentRow): Parent {
    return {
      id: row.id,
      phone: row.phone,
      passwordHash: row.password_hash,
      name: row.name,
      isActive: row.is_active === 1,
    };
  }
}
```

- [ ] **Step 3: `index.ts` 追加导出**（若该文件按名字导出各 repo，加两行；否则跳过）

```ts
export { AdminsRepository } from './admins.repo.js';
export { ParentsRepository } from './parents.repo.js';
```

- [ ] **Step 4: 验证编译**

Run: `cd apps/server && npm run build`
Expected: tsc 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/admins.repo.ts apps/server/src/database/repositories/parents.repo.ts apps/server/src/database/repositories/index.ts
git commit -m "feat(server): AdminsRepository + ParentsRepository"
```

---

### Task 3: StudentsRepository 扩展（is_active + 家长侧方法）

**Files:**
- Modify: `apps/server/src/database/repositories/students.repo.ts`

- [ ] **Step 1: 扩展 `StudentRow`/`Student` 类型**

`StudentRow` 加 `is_active: number;`；`Student` 加 `isActive: boolean;`；`mapRow` 加 `isActive: row.is_active === 1,`。现有 `SELECT *` 会自动带出该列，无需改 SQL。

- [ ] **Step 2: 追加三个方法**（加在 `create` 之后）

```ts
  /** 家长控制台列表：自己名下、未软删的学生，按创建时间倒序。 */
  async findByParentId(parentId: number): Promise<Student[]> {
    const [rows] = await this.pool.execute<StudentRow[]>(
      'SELECT * FROM students WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id DESC',
      [parentId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    await this.pool.execute(
      'UPDATE students SET password_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [passwordHash, id],
    );
  }

  async setActive(id: number, isActive: boolean): Promise<void> {
    await this.pool.execute(
      'UPDATE students SET is_active = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [isActive ? 1 : 0, id],
    );
  }

  /** 新建子账号时连带建默认 student_settings（school 随学段）。 */
  async createDefaultSettings(studentId: number, schoolLevel: string): Promise<void> {
    await this.pool.execute(
      'INSERT INTO student_settings (student_id, school) VALUES (?, ?) ON DUPLICATE KEY UPDATE school = VALUES(school)',
      [studentId, schoolLevel],
    );
  }
```

- [ ] **Step 3: 验证编译与既有测试**

Run: `cd apps/server && npm run build && npm test`
Expected: tsc 无错误；172+ 既有测试全绿（students.repo 无专属测试文件，无回归面）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/database/repositories/students.repo.ts
git commit -m "feat(server): students repo 加 is_active/findByParentId/updatePassword/setActive"
```

---

### Task 4: JwtUser 三角色 + AuthMiddleware 同步

**Files:**
- Modify: `apps/server/src/common/guards/jwt-auth.guard.ts:7-13`
- Modify: `apps/server/src/common/middleware/auth.middleware.ts:22-27`

- [ ] **Step 1: 改 `JwtUser`**（`familyId` 变可选，role 加 `'admin'`）

```ts
export interface JwtUser {
  sub: number;
  role: 'admin' | 'parent' | 'student';
  /** 仅学生 token 携带（= parent_id）；家长/管理员无。 */
  familyId?: number;
  parentId?: number;
}
```

- [ ] **Step 2: 改 `AuthMiddleware`**（`familyId: payload.familyId` 类型天然兼容可选，无需改逻辑；仅确认编译通过。若 tsc 报 `familyId` 必填相关错误，把赋值行改成条件赋值：`...(payload.familyId !== undefined ? { familyId: payload.familyId } : {}),`）

- [ ] **Step 3: 验证**

Run: `cd apps/server && npm run build`
Expected: tsc 无错误（唯一引用方是 auth.service.ts 的学生 payload，本就传 familyId）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/common/guards/jwt-auth.guard.ts apps/server/src/common/middleware/auth.middleware.ts
git commit -m "feat(server): JwtUser 扩展 admin 角色，familyId 改可选"
```

---

### Task 5: AuthService 三角色登录（TDD）

**Files:**
- Test: `apps/server/src/modules/auth/auth.service.test.ts`（新建）
- Modify: `apps/server/src/modules/auth/auth.service.ts`
- Modify: `apps/server/src/modules/auth/auth.module.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { AuthService } from './auth.service';

const mkDeps = (overrides: Record<string, any> = {}) => ({
  studentsRepo: {
    findByUsername: vi.fn().mockResolvedValue(null),
  },
  parentsRepo: {
    findByPhone: vi.fn().mockResolvedValue(null),
  },
  adminsRepo: {
    findByUsername: vi.fn().mockResolvedValue(null),
  },
  jwtService: { sign: vi.fn().mockReturnValue('fake-token') },
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mkDeps>) =>
  new AuthService(d.studentsRepo, d.adminsRepo, d.parentsRepo, d.jwtService as any);

const student = {
  id: 7, parentId: 3, username: 'xiaoming', passwordHash: '$2a$10$hash',
  name: '小明', age: 13, grade: '初二', schoolLevel: 'junior', isActive: true,
};
const parent = { id: 3, phone: '13800000000', passwordHash: '$2a$10$hash', name: '家长甲', isActive: true };
const admin = { id: 1, username: 'admin', passwordHash: '$2a$10$hash', name: '超管', isActive: true };

describe('AuthService.login 三角色', () => {
  it('管理员用户名命中 -> admin token', async () => {
    const d = mkDeps({ adminsRepo: { findByUsername: vi.fn().mockResolvedValue(admin) } });
    const r = await mkSvc(d).login('admin', 'pw');
    expect(r.user.role).toBe('admin');
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 1, role: 'admin' });
  });

  it('手机号命中 parents -> parent token', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(parent) } });
    const r = await mkSvc(d).login('13800000000', 'pw');
    expect(r.user.role).toBe('parent');
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 3, role: 'parent' });
  });

  it('学生用户名命中 -> student token 带 familyId/parentId', async () => {
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(student) } });
    const r = await mkSvc(d).login('xiaoming', 'pw');
    expect(r.user.role).toBe('student');
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 7, role: 'student', familyId: 3, parentId: 3 });
  });

  it('密码错误 -> 1003', async () => {
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(student) } });
    await expect(mkSvc(d).login('xiaoming', 'wrong'))
      .rejects.toMatchObject({ response: { code: 1003 } });
  });

  it('学生被停用 -> 1003 且文案为「账号已停用」', async () => {
    const s = { ...student, isActive: false };
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(s) } });
    await expect(mkSvc(d).login('xiaoming', 'pw'))
      .rejects.toMatchObject({ response: { code: 1003, message: '账号已停用' } });
  });

  it('家长被停用 -> 1003 停用文案；全部未命中 -> 1003', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue({ ...parent, isActive: false }) } });
    await expect(mkSvc(d).login('13800000000', 'pw'))
      .rejects.toMatchObject({ response: { code: 1003, message: '账号已停用' } });
    const d2 = mkDeps();
    await expect(mkSvc(d2).login('nobody', 'pw'))
      .rejects.toMatchObject({ response: { code: 1003, message: '用户名或密码错误' } });
  });
});
```

密码比对用真 bcrypt 太慢，测试里 hash 用预生成：在测试文件顶部加
```ts
import * as bcrypt from 'bcrypt';
const HASH = bcrypt.hashSync('pw', 4);
```
并把上面三个 fixture 的 `passwordHash: '$2a$10$hash'` 换成 `HASH`（登录密码均为 `'pw'`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/auth/auth.service.test.ts`
Expected: FAIL（构造函数签名不匹配 / register 未定义等）。

- [ ] **Step 3: 重写 `auth.service.ts`**

```ts
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
```

（旧的学生 `register` 方法整体删除。）

- [ ] **Step 4: 更新 `auth.module.ts` providers**

```ts
import { AdminsRepository } from '../../database/repositories/admins.repo.js';
import { ParentsRepository } from '../../database/repositories/parents.repo.js';
// ...
  providers: [AuthService, StudentsRepository, AdminsRepository, ParentsRepository],
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/auth/auth.service.test.ts`
Expected: 7 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/auth/
git commit -m "feat(server): 统一三角色登录 + 家长注册（service 层）"
```

---

### Task 6: AuthController 改造 + 登录限流

**Files:**
- Modify: `apps/server/src/modules/auth/auth.controller.ts`
- Create: `apps/server/src/common/interceptors/throttle.interceptor.ts`

- [ ] **Step 1: 写限流拦截器**

```ts
import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';

/**
 * 轻量内存限流：同 IP 每窗口期 10 次，仅用于登录端点防爆破。
 * 单进程内存计数（无 Redis），重启即清零，MVP 够用。
 */
@Injectable()
export class ThrottleInterceptor implements NestInterceptor {
  private readonly limit = 10;
  private readonly windowMs = 60_000;
  private hits = new Map<string, { count: number; windowStart: number }>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<Request>();
    const ip = (req.ip ?? (req.headers['x-forwarded-for'] as string) ?? 'unknown').toString();
    const now = Date.now();
    const rec = this.hits.get(ip);
    if (!rec || now - rec.windowStart > this.windowMs) {
      this.hits.set(ip, { count: 1, windowStart: now });
    } else {
      rec.count += 1;
      if (rec.count > this.limit) {
        throw new HttpException(
          { code: 1008, message: '请求过于频繁，请稍后再试' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return next.handle();
  }
}
```

- [ ] **Step 2: 重写 `auth.controller.ts`**（学生注册端点下线，家长注册上线，登录加限流）

```ts
import { Controller, Post, Body, UseInterceptors } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { ThrottleInterceptor } from '../../common/interceptors/throttle.interceptor.js';
import { z } from 'zod';

const LoginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(100),
});

const ParentRegisterSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式有误'),
  password: z.string().min(6).max(32),
  name: z.string().min(1).max(50).optional(),
});

@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  @UseInterceptors(ThrottleInterceptor)
  async login(@Body() body: unknown) {
    const { username, password } = LoginSchema.parse(body);
    return this.authService.login(username, password);
  }

  /** 家长注册（注册即登录）。学生自主注册已下线（PRD §7.8）。 */
  @Post('register')
  async register(@Body() body: unknown) {
    const dto = ParentRegisterSchema.parse(body);
    return this.authService.register(dto);
  }
}
```

- [ ] **Step 3: 验证全量测试 + 编译**

Run: `cd apps/server && npm run build && npm test`
Expected: tsc 无错误、全测试绿（旧 register 若被任何测试引用，改测试引用新签名——测试错改测试，不改实现）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/modules/auth/auth.controller.ts apps/server/src/common/interceptors/throttle.interceptor.ts
git commit -m "feat(server): 登录限流 + 家长注册端点（学生注册下线）"
```

---

### Task 7: 学生接口角色守卫接线（TDD）

**Files:**
- Test: `apps/server/src/common/guards/roles.guard.test.ts`（新建）
- Modify: `apps/server/src/modules/practice/practice.controller.ts`、`modules/ai/ai.controller.ts`、`modules/conversations/conversations.controller.ts`、`modules/progress/progress.controller.ts`

- [ ] **Step 1: 写 RolesGuard 失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles';
import { UnauthorizedException } from '@nestjs/common';

const mkCtx = (user: unknown, handler: unknown) => ({
  switchToHttp: () => ({ getRequest: () => ({ user }) }),
  getHandler: () => handler,
  getClass: () => undefined,
}) as any;

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  it('无角色元数据 -> 放行', () => {
    const handler = () => {};
    expect(guard.canActivate(mkCtx({ sub: 1, role: 'parent' }, handler))).toBe(true);
  });

  it('角色匹配 -> 放行；不匹配 -> 抛 403', () => {
    const handler = () => {};
    Reflect.defineMetadata(ROLES_KEY, ['student'], handler);
    expect(guard.canActivate(mkCtx({ sub: 1, role: 'student' }, handler))).toBe(true);
    expect(() => guard.canActivate(mkCtx({ sub: 1, role: 'parent' }, handler))).toThrow();
  });

  it('未登录 -> 抛 UnauthorizedException', () => {
    const handler = () => {};
    Reflect.defineMetadata(ROLES_KEY, ['student'], handler);
    expect(() => guard.canActivate(mkCtx(undefined, handler))).toThrow(UnauthorizedException);
  });
});
```

注意：现有 `RolesGuard.canActivate` 在 `!user` 时 `return false`（Nest 转成 403）。为让未登录返回 401，把 `roles.guard.ts` 的 `if (!user) return false;` 改为：

```ts
    if (!user) {
      throw new UnauthorizedException({ code: 1003, message: '未登录或 token 已过期' });
    }
```

（并在文件顶部 import `UnauthorizedException`。）

- [ ] **Step 2: 跑测试**

Run: `cd apps/server && npx vitest run src/common/guards/roles.guard.test.ts`
Expected: 改 guard 前 FAIL（return false 而非 throw）；改后 3 PASS。

- [ ] **Step 3: 四个学生控制器接线**

对 `practice.controller.ts`、`ai.controller.ts`、`conversations.controller.ts`、`progress.controller.ts` 各做同样修改——把类装饰器行

```ts
@UseGuards(JwtAuthGuard)
```

改为

```ts
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
```

并在文件头补 import：

```ts
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
```

（各文件 import 相对路径以现状为准：progress/conversations 在 `modules/<x>/` 下，同层级即 `../../common/...`。）

- [ ] **Step 4: 验证全量**

Run: `cd apps/server && npm run build && npm test`
Expected: tsc 无错误、全测试绿（若既有 e2e/集成测试用非 student token 打这些端点，改测试 token 的 role 为 student——测试错改测试）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/common/guards/ apps/server/src/modules/
git commit -m "feat(server): 学生接口全部套 RolesGuard(student)，防家长/管理员越权"
```

---

### Task 8: ParentModule 学生账号管理（TDD）

**Files:**
- Create: `apps/server/src/modules/parent/parent.module.ts`
- Create: `apps/server/src/modules/parent/parent.controller.ts`
- Create: `apps/server/src/modules/parent/parent.service.ts`
- Create: `apps/server/src/modules/parent/parent.service.test.ts`
- Modify: `apps/server/src/app.module.ts`（注册 ParentModule）

- [ ] **Step 1: 写失败测试 `parent.service.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ParentService } from './parent.service';

const mk = (overrides: Record<string, any> = {}) => ({
  studentsRepo: {
    findById: vi.fn().mockResolvedValue(null),
    findByUsername: vi.fn().mockResolvedValue(null),
    findByParentId: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(11),
    updatePassword: vi.fn().mockResolvedValue(undefined),
    setActive: vi.fn().mockResolvedValue(undefined),
    createDefaultSettings: vi.fn().mockResolvedValue(undefined),
  },
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mk>) => new ParentService(d.studentsRepo as any);

const own = { id: 5, parentId: 3, username: 'xiaoming', passwordHash: 'h', name: '小明', age: 13, grade: '初二', schoolLevel: 'junior', isActive: true };

describe('ParentService 学生子账号管理', () => {
  it('新建：grade 推导 school_level + 连带建 settings', async () => {
    const d = mk();
    await mkSvc(d).createStudent(3, { name: '二宝', username: 'erbao', password: '123456', age: 8, grade: '小学三年级' });
    expect(d.studentsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ schoolLevel: 'primary', parentId: 3 }));
    expect(d.studentsRepo.createDefaultSettings).toHaveBeenCalledWith(11, 'primary');
  });

  it('新建：用户名已存在 -> 1004', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findByUsername: vi.fn().mockResolvedValue(own) }) });
    await expect(mkSvc(d).createStudent(3, { name: 'x', username: 'xiaoming', password: '123456', age: 13, grade: '初二' }))
      .rejects.toMatchObject({ response: { code: 1004, message: '用户名已存在' } });
  });

  it('重置密码：非自己名下学生 -> 1005（不泄漏存在性）', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue({ ...own, parentId: 999 }) }) });
    await expect(mkSvc(d).resetPassword(3, 5, 'newpass123'))
      .rejects.toMatchObject({ response: { code: 1005, message: '无权操作该学生' } });
  });

  it('重置密码：学生不存在 -> 1002；成功 -> updatePassword', async () => {
    const d = mk();
    await expect(mkSvc(d).resetPassword(3, 5, 'newpass123'))
      .rejects.toMatchObject({ response: { code: 1002, message: '学生不存在' } });
    const d2 = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }) });
    await mkSvc(d2).resetPassword(3, 5, 'newpass123');
    expect(d2.studentsRepo.updatePassword).toHaveBeenCalledWith(5, expect.any(String));
  });

  it('停用/启用：归属校验 + setActive', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }) });
    await mkSvc(d).setStatus(3, 5, false);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(5, false);
  });

  it('列表：只传 parentId，脱敏 passwordHash', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findByParentId: vi.fn().mockResolvedValue([own]) }) });
    const list = await mkSvc(d).listStudents(3);
    expect(list[0]).not.toHaveProperty('passwordHash');
    expect(list[0]).toMatchObject({ username: 'xiaoming', isActive: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/parent/parent.service.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `parent.service.ts`**

```ts
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
```

- [ ] **Step 4: 写 `parent.controller.ts` 与 `parent.module.ts`**

```ts
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards, Request } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { z } from 'zod';
import { ParentService } from './parent.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';

const CreateStudentSchema = z.object({
  name: z.string().min(1).max(50),
  username: z.string().min(2).max(50).regex(/^[a-zA-Z0-9_]+$/, '用户名仅限字母/数字/下划线'),
  password: z.string().min(6).max(32),
  age: z.number().int().min(3).max(18),
  grade: z.string().min(1).max(20),
});

const ResetPasswordSchema = z.object({ newPassword: z.string().min(6).max(32) });
const StatusSchema = z.object({ isActive: z.boolean() });

@Controller('api/parent/students')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class ParentController {
  constructor(private parentService: ParentService) {}

  @Post()
  async create(@Request() req: ExpressRequest, @Body() body: unknown) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const dto = CreateStudentSchema.parse(body);
    return this.parentService.createStudent(user.sub, dto);
  }

  @Get()
  async list(@Request() req: ExpressRequest) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    return this.parentService.listStudents(user.sub);
  }

  @Patch(':id/reset-password')
  async resetPassword(
    @Request() req: ExpressRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const { newPassword } = ResetPasswordSchema.parse(body);
    return this.parentService.resetPassword(user.sub, id, newPassword);
  }

  @Patch(':id/status')
  async setStatus(
    @Request() req: ExpressRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const { isActive } = StatusSchema.parse(body);
    return this.parentService.setStatus(user.sub, id, isActive);
  }
}
```

```ts
import { Module } from '@nestjs/common';
import { ParentController } from './parent.controller.js';
import { ParentService } from './parent.service.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';

@Module({
  controllers: [ParentController],
  providers: [ParentService, StudentsRepository],
})
export class ParentModule {}
```

在 `app.module.ts` 的 imports 数组加 `ParentModule,`（import 行加 `import { ParentModule } from './modules/parent/parent.module.js';`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/parent/parent.service.test.ts && npm run build && npm test`
Expected: 6 PASS；tsc 无错误；全量绿。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/parent/ apps/server/src/app.module.ts
git commit -m "feat(server): ParentModule 学生子账号管理（建/列表/重置密码/停用启用）"
```

---

### Task 9: seed 脚本（管理员 + 占位家长）

**Files:**
- Create: `apps/server/src/scripts/seed-admin.ts`
- Modify: `apps/server/.env.example`（加 ADMIN_INITIAL_* 与 DB_* 说明）

- [ ] **Step 1: 写脚本**（风格对齐 `backfill-error-question-n.ts`：dotenv + mysql2 直连）

```ts
/**
 * seed：首个管理员账号 + 历史学生占位家长。
 *
 * - 管理员：读 .env 的 ADMIN_INITIAL_USERNAME / ADMIN_INITIAL_PASSWORD（缺省 admin/admin123，
 *   仅开发便利；生产必须显式设置）。已存在同名管理员则跳过（幂等）。
 * - 占位家长：确保 id=1 的 parent 存在（phone='legacy'），接管 auth 旧实现挂在
 *   parent_id=1 下的存量学生。已存在则不动。
 *
 * 运行：cd apps/server && npx tsx src/scripts/seed-admin.ts   （幂等可重复跑）
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import * as bcrypt from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../../.env') });

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  // 1) 管理员
  const username = process.env.ADMIN_INITIAL_USERNAME ?? 'admin';
  const password = process.env.ADMIN_INITIAL_PASSWORD ?? 'admin123';
  const [adminRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM admins WHERE username = ? AND deleted_at IS NULL',
    [username],
  );
  if (adminRows.length > 0) {
    console.log(`[seed] 管理员 "${username}" 已存在(id=${adminRows[0].id})，跳过`);
  } else {
    const hash = await bcrypt.hash(password, 10);
    await pool.execute(
      'INSERT INTO admins (username, password_hash, name) VALUES (?, ?, ?)',
      [username, hash, '超级管理员'],
    );
    console.log(`[seed] 管理员 "${username}" 已创建（初始密码来自 .env，请尽快修改）`);
  }

  // 2) 占位家长（id=1）
  const [parentRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM parents WHERE id = 1',
  );
  if (parentRows.length > 0) {
    console.log(`[seed] parent id=1 已存在，跳过`);
  } else {
    const hash = await bcrypt.hash('legacy-placeholder', 10);
    await pool.execute(
      "INSERT INTO parents (id, phone, password_hash, name) VALUES (1, 'legacy', ?, '历史学生托管账号')",
      [hash],
    );
    console.log('[seed] 占位家长 id=1 已创建（phone=legacy，密码为随机串不可登录）');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[seed] 失败:', err);
  process.exit(1);
});
```

- [ ] **Step 2: `.env.example` 追加**

```
# Admin seed (scripts/seed-admin.ts)
ADMIN_INITIAL_USERNAME=admin
ADMIN_INITIAL_PASSWORD=

# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=ai_k12
DB_PASS=ai_k12
DB_NAME=ai_k12
```

（DB 段若 .env.example 尚无则一并补上；本地 `apps/server/.env` 已含 DB_*，不动。）

- [ ] **Step 3: 运行验证**

Run: `cd apps/server && npx tsx src/scripts/seed-admin.ts && npx tsx src/scripts/seed-admin.ts`
Expected: 第一次输出两行「已创建」；第二次输出两行「已存在，跳过」（幂等）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/scripts/seed-admin.ts apps/server/.env.example
git commit -m "feat(server): seed-admin 脚本（管理员 + 占位家长 id=1）"
```

---

### Task 10: 前端 API 层

**Files:**
- Modify: `apps/web/src/services/api.ts`（`// --- Auth ---` 节）

- [ ] **Step 1: 替换 Auth 节**

```ts
// --- Auth ---

export type UserRole = 'admin' | 'parent' | 'student';

export interface LoginResult {
  token: string;
  user: {
    id: number;
    role: UserRole;
    name: string | null;
    username?: string;
    grade?: string | null;
    phone?: string;
    parentId?: number;
  };
}

export function login(username: string, password: string): Promise<LoginResult> {
  return fetchApi<LoginResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

/** 家长注册（注册即登录）。 */
export function registerParent(phone: string, password: string, name?: string): Promise<LoginResult> {
  return fetchApi<LoginResult>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ phone, password, name: name || undefined }),
  });
}

// --- Parent: student accounts ---

export interface MyStudentItem {
  id: number;
  parentId: number;
  username: string;
  name: string;
  age: number | null;
  grade: string | null;
  schoolLevel: string | null;
  isActive: boolean;
}

export function listMyStudents(): Promise<MyStudentItem[]> {
  return fetchApi<MyStudentItem[]>('/parent/students');
}

export function createStudent(req: {
  name: string;
  username: string;
  password: string;
  age: number;
  grade: string;
}): Promise<{ id: number }> {
  return fetchApi<{ id: number }>('/parent/students', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export function resetStudentPassword(id: number, newPassword: string): Promise<null> {
  return fetchApi<null>(`/parent/students/${id}/reset-password`, {
    method: 'PATCH',
    body: JSON.stringify({ newPassword }),
  });
}

export function setStudentStatus(id: number, isActive: boolean): Promise<null> {
  return fetchApi<null>(`/parent/students/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });
}
```

- [ ] **Step 2: 验证编译**

Run: `cd apps/web && npx tsc -b`
Expected: 无错误（旧 `login` 调用点 LoginPage 的 `result.user.username` 改为可选后，LoginPage 在 Task 11 同步调整；本步若 LoginPage 报错属预期，直接进入 Task 11）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): 家长注册/学生子账号管理 API"
```

---

### Task 11: LoginPage 三角色路由 + RegisterPage

**Files:**
- Modify: `apps/web/src/pages/auth/LoginPage.tsx`
- Create: `apps/web/src/pages/auth/RegisterPage.tsx`

- [ ] **Step 1: 改 `LoginPage.tsx` 的 `handleLogin`**（role 以后端为准；旧代码只认 parent/student）

```tsx
  const handleLogin = async () => {
    if (!username || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await login(username, password);
      localStorage.setItem('token', result.token);
      localStorage.setItem('username', result.user.username ?? '');
      localStorage.setItem('userId', String(result.user.id));
      localStorage.setItem('userRole', result.user.role);

      if (result.user.role === 'admin') {
        navigate('/admin');
      } else if (result.user.role === 'parent') {
        navigate('/parent/students');
      } else {
        navigate('/student/entry');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '登录失败，请重试') : '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };
```

在登录卡片底部（表单提交按钮之后）加注册入口：

```tsx
        <p className="text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          家长还没有账号？{' '}
          <Link to="/register" className="font-semibold" style={{ color: 'var(--brand-500)' }}>
            注册家长账号
          </Link>
        </p>
```

（文件头补 `import { Link } from 'react-router-dom';`，具体位置贴紧现有按钮下方、卡片内边距容器里。）

- [ ] **Step 2: 写 `RegisterPage.tsx`**（家长蓝白风格，`data-theme="parent"`；结构对齐 LoginPage 的卡片式）

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input } from '@/components/base';
import { registerParent } from '@/services/api';

export default function RegisterPage() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    if (!/^1\d{10}$/.test(phone)) {
      setError('请输入 11 位手机号');
      return;
    }
    if (password.length < 6 || password.length > 32) {
      setError('密码长度需为 6-32 位');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await registerParent(phone, password, name || undefined);
      localStorage.setItem('token', result.token);
      localStorage.setItem('username', '');
      localStorage.setItem('userId', String(result.user.id));
      localStorage.setItem('userRole', result.user.role);
      navigate('/parent/students');
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '注册失败，请重试') : '注册失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-theme="parent"
      className="min-h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-base)' }}
    >
      <div
        className="w-full max-w-md rounded-[var(--radius-card)] overflow-hidden bg-white"
        style={{ boxShadow: 'var(--shadow-card-strong)' }}
      >
        <div className="px-10 pt-8 pb-6 text-center space-y-3">
          <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--brand-500)' }}>
            注册家长账号
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            注册后可为孩子开通独立学习账号
          </p>
        </div>
        <div className="px-10 pb-10 space-y-5">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>手机号</label>
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="请输入手机号"
              maxLength={11}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>姓名（可选）</label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如何称呼您"
              maxLength={50}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>设置密码</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6-32 位"
              maxLength={32}
            />
          </div>
          {error && (
            <p className="text-sm" style={{ color: 'var(--error)' }}>{error}</p>
          )}
          <Button variant="primary" onClick={handleRegister} loading={loading} className="w-full">
            完成注册
          </Button>
          <p className="text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
            已有账号？{' '}
            <Link to="/login" className="font-semibold" style={{ color: 'var(--brand-500)' }}>
              返回登录
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
```

（若 `Input`/`Button` 的 props 与 `@/components/base` 现有签名不完全一致——如 `loading` 不存在——以 base 组件实际 API 为准调整，保持视觉规范即可。）

- [ ] **Step 3: 验证编译**

Run: `cd apps/web && npx tsc -b`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/auth/
git commit -m "feat(web): 登录三角色路由 + 家长注册页"
```

---

### Task 12: 路由守卫 + /admin 占位 + 路由改造

**Files:**
- Create: `apps/web/src/routes/RequireRole.tsx`
- Create: `apps/web/src/components/layout/AdminLayout.tsx`
- Modify: `apps/web/src/routes/index.tsx`

- [ ] **Step 1: 写 `RequireRole.tsx`**

```tsx
import { Navigate } from 'react-router-dom';
import type { ReactElement } from 'react';

/** 前端路由守卫：role 不匹配重定向登录页（越权防护以后端 Guard 为准，此处仅 UX）。 */
export default function RequireRole({
  role,
  children,
}: {
  role: 'admin' | 'parent' | 'student';
  children: ReactElement;
}) {
  const userRole = localStorage.getItem('userRole');
  if (userRole !== role) {
    return <Navigate to="/login" replace />;
  }
  return children;
}
```

- [ ] **Step 2: 写 `AdminLayout.tsx`**（极简占位，复用 LogoutButton）

```tsx
import { Outlet } from 'react-router-dom';
import { LogoutButton } from '@/components/base';

/** 管理员中枢占位壳：模型配置/封禁/消息推送等待后续子项目。 */
export default function AdminLayout() {
  return (
    <div data-theme="parent" className="min-h-screen bg-[var(--bg-base)]">
      <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6">
        <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          管理员中枢
        </h1>
        <LogoutButton />
      </header>
      <main className="p-8">
        <div className="bg-white rounded-2xl border border-gray-200 p-6 max-w-2xl">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            管理员功能（模型配置 / 账号封禁 / 消息推送 / AI 对话）将在后续子项目中实现。
          </p>
        </div>
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: 改 `routes/index.tsx`**

1. 根路由 `'/'` 的 element 改为按 role 分流的小组件（文件内定义）：

```tsx
const RoleRedirect = () => {
  const role = localStorage.getItem('userRole');
  if (role === 'admin') return <Navigate to="/admin" replace />;
  if (role === 'parent') return <Navigate to="/parent/students" replace />;
  if (role === 'student') return <Navigate to="/student/entry" replace />;
  return <Navigate to="/login" replace />;
};
```

2. `/login` 下方加：

```tsx
  { path: '/register', element: <RegisterPage /> },
  {
    path: '/admin',
    element: (
      <RequireRole role="admin">
        <AdminLayout />
      </RequireRole>
    ),
  },
```

3. `/parent` 子树的 element 包守卫，并加 `students` 路由：

```tsx
  {
    path: '/parent',
    element: (
      <RequireRole role="parent">
        <ParentLayout />
      </RequireRole>
    ),
    children: [
      { path: '', element: <Navigate to="/parent/students" replace /> },
      { path: 'students', element: <ParentStudentsPage /> },
      { path: 'dashboard', element: <Placeholder title="家长仪表盘 P6.1" /> },
      // ...其余占位路由原样保留
    ],
  },
```

4. `/student` 子树（含 `/student/entry`、`/student/subjects`、`/student/star-map`、`/student/course-detail`、`/student/auxiliary*`）整体包 `RequireRole role="student"`——这些是独立全屏路由，逐个把 `element: <X />` 改为 `element: <RequireRole role="student"><X /></RequireRole>`（`Navigate` 类路由不用包）。

5. 文件头补 import：`RegisterPage`、`ParentStudentsPage`（Task 13 创建，可先注释一行并在 Task 13 解开；更简单的顺序是先做 Task 13 再回来——**本计划按 Task 13 先创建页面文件再执行本步**调整执行顺序：若 Task 13 未完成，先跳到 Task 13 再回来）。

- [ ] **Step 4: 验证编译 + lint**

Run: `cd apps/web && npx tsc -b && npm run lint`
Expected: 无错误（0 error；既有 warning 不增加）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/ apps/web/src/components/layout/AdminLayout.tsx
git commit -m "feat(web): RequireRole 路由守卫 + /admin 占位 + 三角色路由分流"
```

---

### Task 13: ParentStudentsPage 学生账号管理页

**Files:**
- Create: `apps/web/src/pages/parent/ParentStudentsPage.tsx`

（在 Task 12 Step 3 之前完成，否则 routes/index.tsx 引用会编译失败。）

- [ ] **Step 1: 写页面**（交互对齐参考 `k12-AI-learning/src/pages/parent/Accounts.tsx`，用本项目 base 组件与 parent 主题 CSS 变量；Toast 用 base 组件）

```tsx
import { useEffect, useState } from 'react';
import { Button, Input, Modal, Toast } from '@/components/base';
import {
  listMyStudents,
  createStudent,
  resetStudentPassword,
  setStudentStatus,
  type MyStudentItem,
} from '@/services/api';

const GRADES = [
  '小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级',
  '初一', '初二', '初三', '高一', '高二', '高三',
];

const emptyForm = { name: '', username: '', password: '', age: '', grade: '' };

export default function ParentStudentsPage() {
  const [students, setStudents] = useState<MyStudentItem[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [resetTarget, setResetTarget] = useState<MyStudentItem | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setStudents(await listMyStudents());
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : '加载失败');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const handleCreate = async () => {
    setError('');
    if (!form.name || !form.username || !form.password || !form.age || !form.grade) {
      setError('请完整填写所有字段');
      return;
    }
    setLoading(true);
    try {
      await createStudent({
        name: form.name,
        username: form.username,
        password: form.password,
        age: Number(form.age),
        grade: form.grade,
      });
      setShowCreate(false);
      setForm(emptyForm);
      notify(`学生账号 ${form.name} 已开通`);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '开通失败');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    if (!resetTarget) return;
    if (newPassword.length < 6 || newPassword.length > 32) {
      setError('密码长度需为 6-32 位');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await resetStudentPassword(resetTarget.id, newPassword);
      setResetTarget(null);
      setNewPassword('');
      notify(`已重置 ${resetTarget.name} 的密码`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '重置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleStatus = async (s: MyStudentItem) => {
    try {
      await setStudentStatus(s.id, !s.isActive);
      notify(s.isActive ? `已停用 ${s.name} 的账号` : `已启用 ${s.name} 的账号`);
      await load();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : '操作失败');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
            学生账号管理
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            为每个孩子开通独立学习账号，可重置密码或临时停用。
          </p>
        </div>
        {!showCreate && (
          <Button variant="primary" onClick={() => setShowCreate(true)}>开通新账号</Button>
        )}
      </div>

      {showCreate && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>配置新的学生子账号</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>学生姓名</label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：二宝" />
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>登录用户名</label>
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="字母或数字，如：erbao" />
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>年龄</label>
              <Input type="number" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} placeholder="如：13" />
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>年级</label>
              <select
                value={form.grade}
                onChange={(e) => setForm({ ...form, grade: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white"
              >
                <option value="" disabled>请选择年级...</option>
                {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>初始登录密码</label>
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="6-32 位" className="max-w-md" />
          </div>
          {error && <p className="text-sm" style={{ color: 'var(--error)' }}>{error}</p>}
          <div className="flex gap-3 pt-2 border-t border-gray-100">
            <Button variant="primary" onClick={handleCreate} loading={loading}>确认开通</Button>
            <Button variant="secondary" onClick={() => { setShowCreate(false); setError(''); }}>取消</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {students.map((s) => (
          <div key={s.id} className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="flex gap-3 items-center mb-4">
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center font-bold text-blue-600">
                {s.name.charAt(0)}
              </div>
              <div>
                <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{s.name}</h3>
                <span
                  className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded mt-1"
                  style={{
                    color: s.isActive ? 'var(--success, #059669)' : 'var(--text-secondary)',
                    backgroundColor: s.isActive ? 'rgba(5,150,105,0.08)' : 'rgba(0,0,0,0.04)',
                  }}
                >
                  {s.isActive ? '状态正常' : '已停用'}
                </span>
              </div>
            </div>
            <div className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <div className="flex justify-between border-b border-gray-50 pb-2">
                <span>登录账号</span>
                <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{s.username}</span>
              </div>
              <div className="flex justify-between border-b border-gray-50 pb-2">
                <span>年龄/年级</span>
                <span>{s.age ? `${s.age}岁 / ` : ''}{s.grade ?? '-'}</span>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <Button variant="secondary" className="flex-1 !text-xs" onClick={() => { setResetTarget(s); setNewPassword(''); setError(''); }}>
                重置密码
              </Button>
              <Button variant={s.isActive ? 'secondary' : 'primary'} className="flex-1 !text-xs" onClick={() => handleToggleStatus(s)}>
                {s.isActive ? '停用账号' : '启用账号'}
              </Button>
            </div>
          </div>
        ))}
        {students.length === 0 && !showCreate && (
          <div className="col-span-full bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
            还没有为孩子开通账号，点击右上角「开通新账号」开始。
          </div>
        )}
      </div>

      <Modal
        open={resetTarget !== null}
        title={`重置 ${resetTarget?.name ?? ''} 的密码`}
        onClose={() => { setResetTarget(null); setError(''); }}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setResetTarget(null); setError(''); }}>取消</Button>
            <Button variant="primary" onClick={handleReset} loading={loading}>确认重置</Button>
          </>
        }
      >
        <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="输入新密码（6-32 位）" />
        {error && <p className="text-sm mt-2" style={{ color: 'var(--error)' }}>{error}</p>}
      </Modal>

      {toast && <Toast message={toast} />}
    </div>
  );
}
```

（`Button`/`Input`/`Modal`/`Toast` 的实际 props 以 `@/components/base` 现有导出为准——先看一眼 `src/components/base/index.ts` 再落笔，签名不一致就按实际调整，视觉规范不变：无 emoji、线性图标、parent 主题变量。）

- [ ] **Step 2: 验证编译 + lint**

Run: `cd apps/web && npx tsc -b && npm run lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/parent/ParentStudentsPage.tsx
git commit -m "feat(web): 家长端学生账号管理页（建/列表/重置密码/停用启用）"
```

---

### Task 14: 端到端手动验收

**Files:** 无代码改动（发现问题回前面对应 Task 修）。

前置：`apps/server` 起 dev（`npm run start:dev`）、`apps/web` 起 dev（`npm run dev`）、MySQL 已跑 Task 1 迁移 + Task 9 seed。

- [ ] **Step 1: 按清单逐项验收**

1. `admin`/`admin123`（或 .env 设置值）登录 -> 落 `/admin` 占位页，LogoutButton 可退出。
2. `/register` 注册新手机号 -> 直接落 `/parent/students`（注册即登录）。
3. 重复注册同手机号 -> 报「该手机号已注册」（1004）。
4. 家长新建学生（如 erbao/123456/8 岁/小学三年级）-> 列表出现卡片；用该账号登录 -> 落 `/student/entry`，学习流程可走通（星图->课程->练习）。
5. 家长重置该学生密码 -> 旧密码登录失败（1003），新密码可登录。
6. 家长停用该学生 -> 学生登录报「账号已停用」；启用后恢复。
7. 存量学生（parent_id=1 托管）登录学习正常（回归）。
8. 用 parent token 直接 `curl -X POST localhost:3000/api/practice/judge -H "Authorization: Bearer <parent-token>"`（任一学生接口）-> 403。
9. 11 次连续错误登录 -> 第 11 次返回 1008「请求过于频繁」。
10. 未登录直接访问 `/parent/students` -> 重定向 `/login`。

- [ ] **Step 2: 全量回归**

Run: `cd apps/server && npm run build && npm test && cd ../web && npm run build && npm run lint`
Expected: 全绿。

- [ ] **Step 3: Commit（如有修复）**

```bash
git add -A && git commit -m "fix: 端到端验收修复"
```

---

### Task 15: 文档同步（openapi + API 设计文档 + CLAUDE.md）

**Files:**
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: openapi.yaml**

- `POST /api/auth/login`：requestBody `username` 语义改为「管理员用户名/家长手机号/学生用户名」；响应 `user.role` 枚举 `admin|parent|student`，`user` 加 `phone?`/`parentId?`，去掉 `username` 必填（家长无 username）。
- `POST /api/auth/register`：改为家长注册 `{ phone, password, name? }`，响应同 login（role 恒为 parent）；删除原学生注册描述。
- 新增 `paths`：`/api/parent/students`（GET 列表 / POST 新建，`MyStudentItem` schema）与 `/api/parent/students/{id}/reset-password`、`/api/parent/students/{id}/status`（PATCH）。
- 错误码表（若有该节）补 1005（无权操作该学生）、1008（请求过于频繁）。

- [ ] **Step 2: API 设计文档**

- §4 端点清单同步上述变更；§6 加「家长创建学生子账号数据流」小节（家长 token -> ParentGuard -> 归属校验 -> students + student_settings 写入）；版本日志加 v1.9（v1.8 已被 08-12 占用）。
- 按 CLAUDE.md「API 文档同步规则」跑一次端点列表 grep 对照，确认两文档路径一致：

Run: `grep -oE "'?/api/[a-z/-]+[a-z]" docs/api/openapi.yaml | sort -u > /tmp/openapi-paths.txt && grep -cE "/api/" docs/API接口与数据流设计文档.md`
Expected: 人工比对两清单无遗漏。

- [ ] **Step 3: CLAUDE.md 追加实现记录 note**

在「2026-08-14 修正」note 之后追加一段「2026-08-14 新增（三角色账号体系）」：admins 表 + is_active、统一三角色登录（admins->parents->students）、家长注册（注册即登录）、RolesGuard 接线（practice/ai/conversations/progress 四控制器）、ParentModule（/api/parent/students 建列表重置停用）、ThrottleInterceptor 登录限流（10 次/分/IP）、seed-admin.ts、前端 RequireRole + /admin 占位 + RegisterPage + ParentStudentsPage、局限（无刷新 token/管理员改密 UI 待管理员台子项目）。分支 `feat/parent-admin-account-system`。

- [ ] **Step 4: Commit**

```bash
git add docs/api/openapi.yaml docs/API接口与数据流设计文档.md CLAUDE.md
git commit -m "docs: 三角色账号体系 API/openapi/CLAUDE.md 同步"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §3（DB/迁移/seed）-> Task 1/2/3/9；§4（登录/注册/守卫/ParentModule）-> Task 5/6/7/8；§5（前端）-> Task 10-13；§6（错误码/限流/安全）-> Task 5/6/7/8 内嵌；§7（测试/验收）-> 各 TDD Task + Task 14；§8（文档）-> Task 1/15。无缺口。
- **占位符扫描**：无 TBD/TODO；「以 base 组件实际 API 为准」两处是对既有组件签名的引用约束，非占位。
- **类型一致性**：`LoginResult.user.role: UserRole` 三处一致；`MyStudentItem` 前后端字段一致（isActive/parentId/username/name/age/grade/schoolLevel）；`ParentService` 四方法名与 controller/测试一致。
- **执行顺序依赖**：Task 13（页面文件）须先于 Task 12 Step 3（路由 import）完成，计划内已标注。
