# 家长忘记密码（模拟验证码）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐登录页「忘记密码」链路：家长凭手机号 + 页面直显的模拟验证码自助重置密码。

**Architecture:** 后端在 auth 模块新增 `PasswordResetCodeService`（进程内存存验证码，不建表）+ `POST /api/auth/password/reset-request` / `POST /api/auth/password/reset` 两个公开端点；前端新增 `/forgot-password` 单页表单，登录页死按钮接上链接。设计 spec：`docs/superpowers/specs/2026-10-09-forgot-password-design.md`。

**Tech Stack:** NestJS + zod + bcrypt + vitest（后端）；React 19 + React Router 6 + Tailwind + testing-library（前端）。

## Global Constraints

- 成功响应由全局 `ResponseInterceptor` 包成 `{code: 0, message, data}`；前端 `fetchApi` 只认 `code === 0` 并取 `data`。
- Zod 校验失败必须转 400（code 1001）——裸 `ZodError` 会被全局过滤器兜成 500（参照 `apps/server/src/modules/points/parent-points.controller.ts:129` 的 `parseInput` 模式）。
- 新 POST 端点按 openapi 声明返回 200：必须显式 `@HttpCode(200)`（CLAUDE.md 约定）。
- 业务错误码沿用全仓语义：1001 入参、1002 资源不存在、1003 认证失败、1008 频率限制（与 `ThrottleInterceptor` 一致）。
- `api/auth/*` 已在 `app.module.ts:89-94` 的 AuthMiddleware exclude 清单里，新端点天然免 JWT，无需改动中间件。
- UI 不用 emoji；颜色全走 CSS 变量 token；页面仿 `RegisterPage` 用 `data-theme="parent"`。
- 前端组件改动必须补渲染测试；多用例文件必须自己写 `afterEach(() => cleanup())`。
- 密码哈希 bcrypt cost 10（与注册一致）；重置成功**不失效**已签发 token。
- 后端单测跑 `cd apps/server && npm test`；前端跑 `cd apps/web && npm test`。改动涉及分页查询的护栏测试与本功能无关，无需跑 tools/*。

---

### Task 1: 后端 PasswordResetCodeService（内存验证码服务）

**Files:**
- Create: `apps/server/src/modules/auth/password-reset-code.service.ts`
- Test: `apps/server/src/modules/auth/password-reset-code.service.test.ts`
- Modify: `apps/server/src/modules/auth/auth.module.ts`

**Interfaces:**
- Consumes: 无（零依赖，纯内存）
- Produces: `PasswordResetCodeService`，两个公开方法：
  - `issue(phone: string): { code: string; expiresIn: number }` —— 生成 6 位数字验证码存内存；同手机号 60s 内重复调用抛 `HttpException`(429, code 1008)
  - `verify(phone: string, code: string): void` —— 校验通过即消费（删除）；不匹配抛 1003「验证码错误」并计次；过期抛 1003「验证码已过期，请重新获取」；累计错 5 次作废
- Task 2 的 `AuthService` 依赖这两个方法签名。

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/modules/auth/password-reset-code.service.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordResetCodeService } from './password-reset-code.service';

/**
 * 内存验证码服务：全部时间相关行为用 vitest fake timers 驱动，
 * 不依赖真实等待。参数（5 分钟有效期 / 60s 重发间隔 / 5 次作废）与
 * spec §3.4 一致，这里逐条钉住。
 */
describe('PasswordResetCodeService', () => {
  let svc: PasswordResetCodeService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    svc = new PasswordResetCodeService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issue 返回 6 位数字验证码，expiresIn 为 300 秒', () => {
    const { code, expiresIn } = svc.issue('13800000000');
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresIn).toBe(300);
  });

  it('同一手机号 60 秒内重复 issue -> 429 / code 1008', () => {
    svc.issue('13800000000');
    vi.advanceTimersByTime(59_000);
    let caught: any;
    try {
      svc.issue('13800000000');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught).toMatchObject({ status: 429, response: { code: 1008, message: '请求过于频繁，请稍后再试' } });
  });

  it('超过 60 秒后可以重新 issue，旧码被替换', () => {
    const first = svc.issue('13800000000');
    vi.advanceTimersByTime(61_000);
    const second = svc.issue('13800000000');
    expect(second.code).toMatch(/^\d{6}$/);
    // 旧码已不可用
    expect(() => svc.verify('13800000000', first.code)).toThrowError(/验证码错误/);
    // 新码可用
    expect(() => svc.verify('13800000000', second.code)).not.toThrow();
  });

  it('不同手机号互不影响（60s 间隔只按手机号算）', () => {
    svc.issue('13800000000');
    expect(() => svc.issue('13900000000')).not.toThrow();
  });

  it('verify 正确验证码 -> 通过且消费（第二次同码报过期）', () => {
    const { code } = svc.issue('13800000000');
    expect(() => svc.verify('13800000000', code)).not.toThrow();
    expect(() => svc.verify('13800000000', code)).toThrowError(/验证码已过期/);
  });

  it('verify 未知手机号 -> 1003 过期文案（不泄漏码是否存在）', () => {
    let caught: any;
    try {
      svc.verify('13700000000', '123456');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught).toMatchObject({ status: 401, response: { code: 1003, message: '验证码已过期，请重新获取' } });
  });

  it('verify 错误码 -> 1003「验证码错误」，且不消费（改对后仍可通过）', () => {
    const { code } = svc.issue('13800000000');
    expect(() => svc.verify('13800000000', '000000')).toThrowError(/验证码错误/);
    expect(() => svc.verify('13800000000', code)).not.toThrow();
  });

  it('累计错 5 次作废该码，之后即使码正确也报过期', () => {
    const { code } = svc.issue('13800000000');
    for (let i = 0; i < 4; i++) {
      expect(() => svc.verify('13800000000', '000000')).toThrowError(/验证码错误/);
    }
    // 第 5 次错误：码被作废
    expect(() => svc.verify('13800000000', '000000')).toThrowError(/验证码错误/);
    expect(() => svc.verify('13800000000', code)).toThrowError(/验证码已过期/);
  });

  it('有效期 5 分钟：4分59秒可用，5分钟后报过期', () => {
    const { code } = svc.issue('13800000000');
    vi.advanceTimersByTime(4 * 60_000 + 59_000);
    expect(() => svc.verify('13800000000', code)).not.toThrow();

    const { code: code2 } = svc.issue('13900000000');
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    expect(() => svc.verify('13900000000', code2)).toThrowError(/验证码已过期/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/auth/password-reset-code.service.test.ts`
Expected: FAIL（模块不存在，编译报错）

- [ ] **Step 3: 写实现**

创建 `apps/server/src/modules/auth/password-reset-code.service.ts`：

```ts
import { Injectable, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

/** 验证码有效期：5 分钟。 */
const CODE_TTL_MS = 5 * 60_000;
/** 同手机号重发间隔：60 秒。 */
const RESEND_INTERVAL_MS = 60_000;
/** 累计错误次数上限：达到即作废（须重新获取）。 */
const MAX_ATTEMPTS = 5;

interface CodeEntry {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

/**
 * 忘记密码的模拟验证码服务：验证码存进程内存（spec 裁决：不建表、不写迁移）。
 * 服务重启后内存清空，未完成的找回流程表现为「验证码已过期」，重新获取即可。
 * 将来接真实短信时只替换「发送」环节（issue 的返回/通知方式），存储与校验不变。
 */
@Injectable()
export class PasswordResetCodeService {
  private entries = new Map<string, CodeEntry>();

  /** 生成并存储验证码。同手机号 60s 内重复请求抛 429/1008。 */
  issue(phone: string): { code: string; expiresIn: number } {
    const now = Date.now();
    const existing = this.entries.get(phone);
    if (existing && now - existing.lastSentAt < RESEND_INTERVAL_MS) {
      throw new HttpException(
        { code: 1008, message: '请求过于频繁，请稍后再试' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const code = String(Math.floor(100_000 + Math.random() * 900_000));
    this.entries.set(phone, {
      code,
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      lastSentAt: now,
    });
    return { code, expiresIn: CODE_TTL_MS / 1000 };
  }

  /**
   * 校验验证码：通过即消费（删除）；不匹配计次，累计错 MAX_ATTEMPTS 次作废；
   * 不存在或已过期按「已过期」报（不区分，避免泄漏码的存在性）。
   */
  verify(phone: string, code: string): void {
    const entry = this.entries.get(phone);
    if (!entry || Date.now() >= entry.expiresAt) {
      this.entries.delete(phone);
      throw new UnauthorizedException({ code: 1003, message: '验证码已过期，请重新获取' });
    }
    if (entry.code !== code) {
      entry.attempts += 1;
      if (entry.attempts >= MAX_ATTEMPTS) {
        this.entries.delete(phone);
      }
      throw new UnauthorizedException({ code: 1003, message: '验证码错误' });
    }
    this.entries.delete(phone);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/auth/password-reset-code.service.test.ts`
Expected: PASS（10 个用例全绿）

- [ ] **Step 5: 注册进 AuthModule**

修改 `apps/server/src/modules/auth/auth.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordResetCodeService } from './password-reset-code.service.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { AdminsRepository } from '../../database/repositories/admins.repo.js';
import { ParentsRepository } from '../../database/repositories/parents.repo.js';
import { BillingModule } from '../billing/billing.module.js';

@Module({
  imports: [
    BillingModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'k12-dev-secret',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordResetCodeService,
    StudentsRepository,
    AdminsRepository,
    ParentsRepository,
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
```

（该类零构造参数、无装饰器依赖注入问题，不受 CLAUDE.md 的 DI 坑影响。）

- [ ] **Step 6: 跑 auth 模块全部测试确认无回归**

Run: `cd apps/server && npx vitest run src/modules/auth/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/auth/password-reset-code.service.ts apps/server/src/modules/auth/password-reset-code.service.test.ts apps/server/src/modules/auth/auth.module.ts
git commit -m "feat(auth): 忘记密码内存验证码服务（5min 有效/60s 重发/5 次作废）"
```

---

### Task 2: 后端两个重置端点（AuthService 方法 + Controller）

**Files:**
- Modify: `apps/server/src/modules/auth/auth.service.ts`
- Modify: `apps/server/src/modules/auth/auth.controller.ts`
- Test: `apps/server/src/modules/auth/auth.service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PasswordResetCodeService.issue/verify`；现有 `ParentsRepository.findByPhone`（`parents.repo.ts:26`）与 `updatePassword`（`parents.repo.ts:49`）
- Produces: HTTP 端点（`security: []`，免 JWT）：
  - `POST /api/auth/password/reset-request`，body `{phone}`；成功（200）`data: {code: string, expiresIn: number}`；错误：400/1001 格式错、404/1002 未注册、429/1008 重发过频
  - `POST /api/auth/password/reset`，body `{phone, code, newPassword}`；成功（200）`data: {success: true}`；错误：400/1001 格式错、401/1003 验证码错误或过期、404/1002 未注册

- [ ] **Step 1: 写失败测试（AuthService 新方法）**

修改 `apps/server/src/modules/auth/auth.service.test.ts`。注意：`AuthService` 构造函数新增第 6 个参数 `resetCodeService`，**现有 `mkDeps`/`mkSvc` 必须同步加**，否则全部既有用例编译失败。

mkDeps 增加一项：

```ts
const mkDeps = (overrides: Record<string, any> = {}) => ({
  studentsRepo: {
    findByUsername: vi.fn().mockResolvedValue(null),
  },
  parentsRepo: {
    findByPhone: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(9),
    updatePassword: vi.fn().mockResolvedValue(undefined),
  },
  adminsRepo: {
    findByUsername: vi.fn().mockResolvedValue(null),
  },
  jwtService: { sign: vi.fn().mockReturnValue('fake-token') },
  subscriptionsService: {
    ensureTrial: vi.fn().mockResolvedValue(undefined),
  },
  resetCodeService: {
    issue: vi.fn().mockReturnValue({ code: '123456', expiresIn: 300 }),
    verify: vi.fn(),
  },
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mkDeps>) =>
  new AuthService(
    d.studentsRepo as any,
    d.adminsRepo as any,
    d.parentsRepo as any,
    d.jwtService as any,
    d.subscriptionsService as any,
    d.resetCodeService as any,
  );
```

文件末尾追加新 describe（`parent` 常量文件里已有）：

```ts
describe('AuthService.requestPasswordReset', () => {
  it('未注册手机号 -> 1002「该手机号未注册」，不 issue', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).requestPasswordReset('13800000000'))
      .rejects.toMatchObject({ response: { code: 1002, message: '该手机号未注册' } });
    expect(d.resetCodeService.issue).not.toHaveBeenCalled();
  });

  it('已注册手机号 -> issue 并返回 {code, expiresIn}', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(parent) } });
    const r = await mkSvc(d).requestPasswordReset('13800000000');
    expect(r).toEqual({ code: '123456', expiresIn: 300 });
    expect(d.resetCodeService.issue).toHaveBeenCalledWith('13800000000');
  });
});

describe('AuthService.resetPassword', () => {
  const dto = { phone: '13800000000', code: '123456', newPassword: 'new-pass-1' };

  it('验证码校验失败 -> 原样上抛（1003），不动数据库', async () => {
    const d = mkDeps({
      resetCodeService: {
        issue: vi.fn(),
        verify: vi.fn().mockImplementation(() => {
          throw Object.assign(new Error('验证码错误'), {
            response: { code: 1003, message: '验证码错误' },
          });
        }),
      },
    });
    await expect(mkSvc(d).resetPassword(dto)).rejects.toMatchObject({ response: { code: 1003 } });
    expect(d.parentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('验证通过但家长已不存在（竞态）-> 1002，不更新密码', async () => {
    const d = mkDeps(); // findByPhone 默认 null
    await expect(mkSvc(d).resetPassword(dto))
      .rejects.toMatchObject({ response: { code: 1002, message: '该手机号未注册' } });
    expect(d.parentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('成功路径 -> bcrypt 新哈希写入 updatePassword，返回 {success: true}，不签发 token', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(parent), updatePassword: vi.fn().mockResolvedValue(undefined) } });
    const r = await mkSvc(d).resetPassword(dto);
    expect(r).toEqual({ success: true });
    expect(d.parentsRepo.updatePassword).toHaveBeenCalledTimes(1);
    const [id, hash] = (d.parentsRepo.updatePassword as any).mock.calls[0];
    expect(id).toBe(parent.id);
    expect(hash).not.toBe(dto.newPassword);
    // bcrypt 可比对：新哈希确实对应新密码（bcrypt 已在文件顶部 `import * as bcrypt`）
    expect(await bcrypt.compare(dto.newPassword, hash)).toBe(true);
    expect(d.jwtService.sign).not.toHaveBeenCalled(); // 不失效/不新发 token
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/auth/auth.service.test.ts`
Expected: FAIL（`requestPasswordReset is not a function` 等）

- [ ] **Step 3: 实现 AuthService 两个方法**

修改 `apps/server/src/modules/auth/auth.service.ts`：

import 区新增：

```ts
import { Injectable, UnauthorizedException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { PasswordResetCodeService } from './password-reset-code.service.js';
```

（原 import 里的 `Injectable, UnauthorizedException, ConflictException` 合并进上面一行。）

类内：构造函数追加第 6 个参数，并加 logger：

```ts
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
```

类末尾（`assertPassword` 之后）追加两个方法：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/auth/auth.service.test.ts`
Expected: PASS（既有 + 新增用例全绿）

- [ ] **Step 5: Controller 加两个端点**

修改 `apps/server/src/modules/auth/auth.controller.ts`（完整替换为）：

```ts
import { Controller, Post, Body, UseInterceptors, HttpCode, BadRequestException } from '@nestjs/common';
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

const ResetRequestSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式有误'),
});

const ResetSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式有误'),
  code: z.string().regex(/^\d{6}$/, '验证码必须是 6 位数字'),
  newPassword: z.string().min(6).max(32),
});

/**
 * Zod 校验 + 把 `ZodError` 转成 400（code 1001）。
 * 裸 ZodError 不是 HttpException，会被全局 HttpExceptionFilter 兜成 500 ——
 * 客户端入参错误必须是 400（同 parent-points.controller.ts 的 parseInput 模式）。
 */
function parseInput<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
  }
  return parsed.data;
}

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
  @UseInterceptors(ThrottleInterceptor)
  async register(@Body() body: unknown) {
    const dto = ParentRegisterSchema.parse(body);
    return this.authService.register(dto);
  }

  /** 忘记密码①：请求模拟验证码（验证码直接在响应体返回 + 服务端日志）。 */
  @Post('password/reset-request')
  @HttpCode(200)
  @UseInterceptors(ThrottleInterceptor)
  async requestPasswordReset(@Body() body: unknown) {
    const { phone } = parseInput(ResetRequestSchema, body);
    return this.authService.requestPasswordReset(phone);
  }

  /** 忘记密码②：验证码 + 新密码重置（成功后不失效旧 token）。 */
  @Post('password/reset')
  @HttpCode(200)
  @UseInterceptors(ThrottleInterceptor)
  async resetPassword(@Body() body: unknown) {
    const dto = parseInput(ResetSchema, body);
    return this.authService.resetPassword(dto);
  }
}
```

（既有 `login`/`register` 保持裸 `.parse()` 不动——本任务不顺手重构它们，避免扩大变更面。）

- [ ] **Step 6: 跑后端全量测试**

Run: `cd apps/server && npm test`
Expected: PASS（全量无回归）

- [ ] **Step 7: 本机冒烟（可选但推荐，需后端已 build）**

Run: `cd apps/server && npm run build && node dist/main.js &` 后：

```bash
curl -s -X POST localhost:3000/api/auth/password/reset-request -H 'Content-Type: application/json' -d '{"phone":"<库里真实家长手机号>"}'
# 期望：{"code":0,...,"data":{"code":"<6位数字>","expiresIn":300}}
curl -s -X POST localhost:3000/api/auth/password/reset -H 'Content-Type: application/json' -d '{"phone":"<同上>","code":"<上一步的码>","newPassword":"smoke-test-1"}'
# 期望：{"code":0,...,"data":{"success":true}}
curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"<同上手机号>","password":"smoke-test-1"}'
# 期望：code 0，返回 parent token
```

冒烟后把该家长密码改回原值（或告知用户已改动）。完成后 kill 冒烟进程（按 PID，别 pkill）。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/auth/auth.service.ts apps/server/src/modules/auth/auth.service.test.ts apps/server/src/modules/auth/auth.controller.ts
git commit -m "feat(auth): POST /api/auth/password/reset-request + /reset 忘记密码两端点"
```

---

### Task 3: 前端 API 函数 + 登录页死按钮接链

**Files:**
- Modify: `apps/web/src/services/api.ts`（Auth 区，`registerParent` 之后）
- Modify: `apps/web/src/pages/auth/LoginPage.tsx:194-196`
- Test: `apps/web/src/pages/auth/LoginPage.test.tsx`

**Interfaces:**
- Consumes: 现有 `fetchApi`（`api.ts:40`，自动包 `{code:0,data}` 解包）
- Produces: 两个导出函数（Task 4 页面调用）：
  - `requestPasswordReset(phone: string): Promise<{ code: string; expiresIn: number }>`
  - `resetPassword(phone: string, code: string, newPassword: string): Promise<{ success: boolean }>`

- [ ] **Step 1: 写失败测试（LoginPage 链接钉子）**

修改 `apps/web/src/pages/auth/LoginPage.test.tsx`。`renderLoginPage` 的 `Routes` 里加一条路由（供链接跳转目标渲染）：

```tsx
<Route path="/forgot-password" element={<div>forgot-password-page</div>} />
```

`describe('LoginPage')` 里追加用例：

```tsx
  it('「忘记密码？」是可点击的链接，指向 /forgot-password（曾是无 onClick 的死按钮）', async () => {
    const user = userEvent.setup();
    renderLoginPage();

    const link = screen.getByRole('link', { name: '忘记密码？' });
    expect(link).toHaveAttribute('href', '/forgot-password');
    await user.click(link);
    expect(screen.getByText('forgot-password-page')).toBeInTheDocument();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/auth/LoginPage.test.tsx`
Expected: FAIL（`getByRole('link', { name: '忘记密码？' })` 找不到——现在是 `<button>`）

- [ ] **Step 3: 实现**

`apps/web/src/pages/auth/LoginPage.tsx:194-196` 替换为：

```tsx
              <Link to="/forgot-password" className="hover:text-[var(--brand-500)] hover:underline">
                忘记密码？
              </Link>
```

`apps/web/src/services/api.ts` 的 Auth 区（`registerParent` 函数之后）追加：

```ts
/** 忘记密码①：请求模拟验证码。家庭自部署无短信服务，验证码直接返回由页面展示（spec 裁决）。 */
export function requestPasswordReset(phone: string): Promise<{ code: string; expiresIn: number }> {
  return fetchApi<{ code: string; expiresIn: number }>('/auth/password/reset-request', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
}

/** 忘记密码②：验证码 + 新密码重置。成功不失效已登录的其他设备 token。 */
export function resetPassword(phone: string, code: string, newPassword: string): Promise<{ success: boolean }> {
  return fetchApi<{ success: boolean }>('/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ phone, code, newPassword }),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/auth/LoginPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/pages/auth/LoginPage.tsx apps/web/src/pages/auth/LoginPage.test.tsx
git commit -m "feat(web): 登录页忘记密码按钮接链 + api 层两个重置函数"
```

---

### Task 4: ForgotPasswordPage 页面 + 路由 + 渲染测试

**Files:**
- Create: `apps/web/src/pages/auth/ForgotPasswordPage.tsx`
- Create: `apps/web/src/pages/auth/ForgotPasswordPage.test.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（import 区 + `/register` 路由后）
- Test: `apps/web/src/routes/routeTable.test.tsx`（追加一个 describe）

**Interfaces:**
- Consumes: Task 3 的 `requestPasswordReset` / `resetPassword`
- Produces: 路由 `/forgot-password`（公开页，无 RequireRole）；页面不导出供他人使用的接口

- [ ] **Step 1: 写失败测试（页面渲染测试）**

创建 `apps/web/src/pages/auth/ForgotPasswordPage.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ForgotPasswordPage from './ForgotPasswordPage';
import { requestPasswordReset, resetPassword } from '@/services/api';

/**
 * 忘记密码页渲染测试（渲染测试铁律）。核心用户路径：
 * 输手机号 → 获取验证码（页面直显模拟验证码 + 60s 倒计时）→
 * 填验证码与新密码 → 提示成功 → 自动跳回登录页。
 */

vi.mock('@/services/api', () => ({
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));

const mockRequest = vi.mocked(requestPasswordReset);
const mockReset = vi.mocked(resetPassword);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/login" element={<div>login-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ForgotPasswordPage', () => {
  it('渲染学生口径说明、三个输入区与两个按钮', () => {
    renderPage();
    expect(screen.getByText(/学生密码请联系家长在家长端重置/)).toBeInTheDocument();
    expect(screen.getByLabelText('手机号')).toBeInTheDocument();
    expect(screen.getByLabelText('验证码')).toBeInTheDocument();
    expect(screen.getByLabelText('新密码', { selector: 'input' })).toBeInTheDocument();
    expect(screen.getByLabelText('确认新密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重置密码' })).toBeInTheDocument();
  });

  it('手机号格式不合法时不发请求，提示错误', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '123');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(mockRequest).not.toHaveBeenCalled();
    expect(screen.getByText('请输入 11 位手机号')).toBeInTheDocument();
  });

  it('获取验证码成功：页面直显模拟验证码，按钮进入倒计时禁用', async () => {
    const user = userEvent.setup();
    mockRequest.mockResolvedValue({ code: '123456', expiresIn: 300 });
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(await screen.findByTestId('displayed-code')).toHaveTextContent('123456');
    const btn = screen.getByRole('button', { name: /秒后可重发/ });
    expect(btn).toBeDisabled();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('获取验证码失败：展示后端错误信息，不显示验证码', async () => {
    const user = userEvent.setup();
    mockRequest.mockRejectedValue(new Error('该手机号未注册'));
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(await screen.findByText('该手机号未注册')).toBeInTheDocument();
    expect(screen.queryByTestId('displayed-code')).not.toBeInTheDocument();
  });

  it('两次新密码不一致时前端拦截，不发重置请求', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.type(screen.getByLabelText('验证码'), '123456');
    await user.type(screen.getByLabelText('新密码', { selector: 'input' }), 'abc123');
    await user.type(screen.getByLabelText('确认新密码'), 'abc124');
    await user.click(screen.getByRole('button', { name: '重置密码' }));
    expect(mockReset).not.toHaveBeenCalled();
    expect(screen.getByText('两次输入的密码不一致')).toBeInTheDocument();
  });

  it('重置成功：提示成功并自动跳回登录页（spec §2.1：先提示后跳转）', async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockReset.mockResolvedValue({ success: true });
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.type(screen.getByLabelText('验证码'), '123456');
    await user.type(screen.getByLabelText('新密码', { selector: 'input' }), 'abc123');
    await user.type(screen.getByLabelText('确认新密码'), 'abc123');
    await user.click(screen.getByRole('button', { name: '重置密码' }));

    expect(await screen.findByText('密码重置成功，正在返回登录页…')).toBeInTheDocument();
    expect(mockReset).toHaveBeenCalledWith('13800000000', '123456', 'abc123');

    // 1.2s 自动跳转
    await act(async () => {
      vi.advanceTimersByTime(1300);
    });
    expect(screen.getByText('login-page')).toBeInTheDocument();
  });

  it('重置失败：展示后端错误信息（如验证码过期），停留本页', async () => {
    const user = userEvent.setup();
    mockReset.mockRejectedValue(new Error('验证码已过期，请重新获取'));
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.type(screen.getByLabelText('验证码'), '123456');
    await user.type(screen.getByLabelText('新密码', { selector: 'input' }), 'abc123');
    await user.type(screen.getByLabelText('确认新密码'), 'abc123');
    await user.click(screen.getByRole('button', { name: '重置密码' }));
    expect(await screen.findByText('验证码已过期，请重新获取')).toBeInTheDocument();
    expect(screen.queryByText('login-page')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/auth/ForgotPasswordPage.test.tsx`
Expected: FAIL（页面不存在）

- [ ] **Step 3: 实现页面**

创建 `apps/web/src/pages/auth/ForgotPasswordPage.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/base';
import { requestPasswordReset, resetPassword } from '@/services/api';

/**
 * 忘记密码（家长自助，模拟验证码直显；spec: 2026-10-09-forgot-password-design.md）。
 *
 * 状态机（单页表单）：
 * - idle：可输入手机号；「获取验证码」仅在手机号匹配 ^1\d{10}$ 时可点
 * - codeIssued：验证码直显（模拟验证码，spec 裁决）+ 60s 倒计时禁用重发
 * - 任何一步失败：error 区展示后端 message（如「该手机号未注册」「验证码已过期」）
 * - resetSuccess：提示「密码重置成功」→ 1.2s 后自动跳回 /login
 * 学生按 UX 口径不做自助找回（顶部说明文案）。
 */
export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayedCode, setDisplayedCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (navigateTimerRef.current) clearTimeout(navigateTimerRef.current);
    };
  }, []);

  const phoneValid = /^1\d{10}$/.test(phone);

  const handleRequestCode = async () => {
    if (!phoneValid) {
      setError('请输入 11 位手机号');
      return;
    }
    setRequesting(true);
    setError('');
    try {
      const result = await requestPasswordReset(phone);
      setDisplayedCode(result.code);
      setCountdown(60);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setCountdown((n) => {
          if (n <= 1 && timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
            return 0;
          }
          return n - 1;
        });
      }, 1000);
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '获取验证码失败，请重试') : '获取验证码失败，请重试');
    } finally {
      setRequesting(false);
    }
  };

  const handleReset = async () => {
    if (!phoneValid) {
      setError('请输入 11 位手机号');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError('请输入 6 位数字验证码');
      return;
    }
    if (newPassword.length < 6 || newPassword.length > 32) {
      setError('密码长度需为 6-32 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setResetting(true);
    setError('');
    try {
      await resetPassword(phone, code, newPassword);
      // spec §2.1：先提示成功，1.2s 后自动回登录页
      setSuccess(true);
      navigateTimerRef.current = setTimeout(() => navigate('/login'), 1200);
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '重置失败，请重试') : '重置失败，请重试');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div
      data-theme="parent"
      className="min-h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-md">
        <div
          className="rounded-[var(--radius-card)] overflow-hidden"
          style={{
            backgroundColor: 'var(--bg-card)',
            boxShadow: 'var(--shadow-card-strong)',
          }}
        >
          {/* 上半部：标题区（与注册页同构：家长蓝白主题） */}
          <div className="px-10 pt-8 pb-6 text-center space-y-3">
            <h1 className="text-[1.75rem] font-bold tracking-wide" style={{ color: 'var(--brand-500)' }}>
              忘记密码
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              本流程用于家长账号；学生密码请联系家长在家长端重置
            </p>
          </div>

          <form
            className="bg-white px-10 pt-7 pb-8 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              handleReset();
            }}
          >
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="fp-phone"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  手机号
                </label>
                <div className="flex gap-2">
                  <input
                    id="fp-phone"
                    type="tel"
                    placeholder="请输入家长手机号"
                    value={phone}
                    maxLength={11}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      setError('');
                    }}
                    className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                  />
                  <Button
                    type="button"
                    variant="primary"
                    onClick={handleRequestCode}
                    disabled={!phoneValid || requesting || countdown > 0}
                    className="shrink-0 whitespace-nowrap !bg-[var(--brand-500)] !text-white hover:!bg-[var(--brand-400)] active:!bg-[var(--brand-600)]"
                  >
                    {countdown > 0 ? `${countdown} 秒后可重发` : requesting ? '获取中…' : '获取验证码'}
                  </Button>
                </div>
              </div>

              {displayedCode && (
                <div
                  data-testid="displayed-code"
                  className="text-sm px-3 py-2 rounded-[var(--radius-input)]"
                  style={{ backgroundColor: 'var(--bg-form)', color: 'var(--text-primary)' }}
                >
                  模拟验证码：<span className="font-bold tracking-widest">{displayedCode}</span>
                  （5 分钟内有效；接入短信服务前临时展示于此）
                </div>
              )}

              <div>
                <label
                  htmlFor="fp-code"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  验证码
                </label>
                <input
                  id="fp-code"
                  type="text"
                  inputMode="numeric"
                  placeholder="6 位数字"
                  value={code}
                  maxLength={6}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setError('');
                  }}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
              </div>

              <div>
                <label
                  htmlFor="fp-new-password"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  新密码
                </label>
                <input
                  id="fp-new-password"
                  type="password"
                  placeholder="6-32 位"
                  value={newPassword}
                  maxLength={32}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setError('');
                  }}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
              </div>

              <div>
                <label
                  htmlFor="fp-confirm-password"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  确认新密码
                </label>
                <input
                  id="fp-confirm-password"
                  type="password"
                  placeholder="再次输入新密码"
                  value={confirmPassword}
                  maxLength={32}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setError('');
                  }}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
                {error && (
                  <div className="mt-2 text-sm text-[var(--error)] bg-[var(--error)]/10 px-3 py-1.5 rounded-[var(--radius-input)]">
                    {error}
                  </div>
                )}
                {success && (
                  <div
                    className="mt-2 text-sm px-3 py-1.5 rounded-[var(--radius-input)]"
                    style={{ backgroundColor: 'var(--bg-form)', color: 'var(--text-primary)' }}
                  >
                    密码重置成功，正在返回登录页…
                  </div>
                )}
              </div>
            </div>

            <Button
              variant="primary"
              size="lg"
              type="submit"
              className="w-full !bg-[var(--brand-500)] !text-white hover:!bg-[var(--brand-400)] active:!bg-[var(--brand-600)]"
              disabled={resetting || success}
            >
              {resetting ? '重置中…' : '重置密码'}
            </Button>

            <p className="text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              想起密码了？{' '}
              <Link to="/login" className="font-semibold hover:underline" style={{ color: 'var(--brand-500)' }}>
                返回登录
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
```

注意：`Button` 组件来自 `@/components/base`（与 LoginPage/RegisterPage 同一导入）。若其 props 不含 `onClick`/`disabled`/`type` 的某项，以该组件实际类型为准调整（LoginPage 用了 `type="submit"` 与 `disabled`，RegisterPage 同，`onClick` 见 LoginPage 对 `variant/size/className/disabled` 的用法，预计齐备）。

- [ ] **Step 4: 跑页面测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/auth/ForgotPasswordPage.test.tsx`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: 注册路由 + 路由级测试**

修改 `apps/web/src/routes/routeTable.tsx`：

import 区（RegisterPage 导入行旁）加：

```tsx
import ForgotPasswordPage from '@/pages/auth/ForgotPasswordPage';
```

`/register` 路由对象后（`routeTable.tsx:92-94` 之后）插入：

```tsx
  {
    path: '/forgot-password',
    element: <ForgotPasswordPage />,
  },
```

`apps/web/src/routes/routeTable.test.tsx` 末尾追加（该文件挂真实路由表，公开页无需 stub 登录态、页面挂载不调接口、无需加 mock）：

```tsx
/**
 * 忘记密码页（2026-10-09 批）：`/forgot-password` 是新页，从零加进路由表。
 * 公开页（无 RequireRole、不进 Layout），主题写死家长蓝白（同注册页）。
 */
describe('路由表：忘记密码页', () => {
  it('/forgot-password 渲染 ForgotPasswordPage，公开可达且用家长主题', async () => {
    renderAt('/forgot-password');

    expect(await screen.findByRole('heading', { name: '忘记密码' })).toBeInTheDocument();
    // 学生口径说明（UX 文档：学生联系家长重置，不走本流程）
    expect(screen.getByText(/学生密码请联系家长在家长端重置/)).toBeInTheDocument();
    expect(document.querySelector('[data-theme="parent"]')).not.toBeNull();
  });
});
```

- [ ] **Step 6: 跑路由测试 + 前端全量测试**

Run: `cd apps/web && npx vitest run src/routes/routeTable.test.tsx && npm test`
Expected: PASS（全量无回归）

- [ ] **Step 7: lint + build 验证**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 0 error

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/auth/ForgotPasswordPage.tsx apps/web/src/pages/auth/ForgotPasswordPage.test.tsx apps/web/src/routes/routeTable.tsx apps/web/src/routes/routeTable.test.tsx
git commit -m "feat(web): /forgot-password 忘记密码页（模拟验证码直显 + 60s 倒计时）"
```

---

### Task 5: 文档同步 + changelog

**Files:**
- Modify: `docs/api/openapi.yaml`（`/auth/password/reset-request` 与 `/auth/password/reset` 两个 path，约 :114-159）
- Modify: `docs/API接口与数据流设计文档.md`（§4.1 表 :163-164 两行）
- Modify: `docs/ai-core-changelog.md`（文末追加）

**Interfaces:** 无代码接口；纯文档。铁律：两份 API 文档必须同步。

- [ ] **Step 1: openapi.yaml 补响应 data 形状**

`docs/api/openapi.yaml` 中 `/auth/password/reset-request` 的 200 响应改为：

```yaml
      responses:
        '200':
          description: 请求已发送（模拟验证码直接在 data.code 返回，页面展示用；接入短信服务商前临时口径）
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        type: object
                        properties:
                          code:
                            type: string
                            description: 6 位数字模拟验证码
                          expiresIn:
                            type: integer
                            description: 有效期（秒），固定 300
```

`/auth/password/reset` 的 200 响应改为：

```yaml
      responses:
        '200':
          description: 密码已重置（不失效已签发 token）
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        type: object
                        properties:
                          success:
                            type: boolean
```

错误语义在 description 里点一句（可选）：reset-request 的 404/1002=未注册、429/1008=60s 重发过频；reset 的 401/1003=验证码错误/过期（错 5 次作废）。

- [ ] **Step 2: API 设计文档标注已实现**

`docs/API接口与数据流设计文档.md:163-164` 两行改为：

```markdown
| POST | `/api/auth/password/reset-request` | 请求重置密码（已实现：MVP 阶段为模拟验证码，直接在响应 `data.code` 返回并展示于页面；未注册手机号报 1002；同号 60s 重发间隔报 1008） | MVP |
| POST | `/api/auth/password/reset` | 确认重置密码（已实现：验证码 + 新密码；验证码错 5 次作废报 1003；成功不失效旧 token） | MVP |
```

- [ ] **Step 3: changelog 追加日志**

`docs/ai-core-changelog.md` 文末追加（格式对齐该文件既有条目风格）：

```markdown
## 2026-10-09 忘记密码（家长模拟验证码）

- 补齐登录页死按钮：`/forgot-password` 单页表单（家长手机号 → 页面直显模拟验证码 → 新密码）。
- 后端：`PasswordResetCodeService`（进程内存，5min 有效 / 60s 重发 / 错 5 次作废，不建表）+ `POST /api/auth/password/reset-request`、`POST /api/auth/password/reset`（免 JWT、@HttpCode(200)、ThrottleInterceptor）。
- 口径：学生不做自助找回（联系家长）；未注册手机号直接报 1002（局域网场景不做防枚举）；重置成功不失效旧 token（与家长端改密码一致）。
- 验证码直显是家庭自部署的临时口径，将来接短信只换 `issue` 的发送环节。
- 踩坑记录：Zod 裸 parse 会被全局过滤器兜成 500，新端点用 `parseInput` 转 400/1001（同 parent-points.controller.ts 模式）。
```

- [ ] **Step 4: 端点清单一致性核对（仓库铁律）**

Run: `grep -n "password/reset" docs/API接口与数据流设计文档.md docs/api/openapi.yaml apps/server/src/modules/auth/auth.controller.ts`
Expected: 三处端点路径一致（reset-request / reset 各两文档 + 控制器装饰器）。

- [ ] **Step 5: Commit**

```bash
git add docs/api/openapi.yaml docs/API接口与数据流设计文档.md docs/ai-core-changelog.md
git commit -m "docs: 忘记密码两端点响应形状与口径同步（openapi + API 文档 + changelog）"
```

---

## 验收清单（全部任务完成后人工走查）

1. `cd apps/server && npm run build && node dist/main.js`（正确起服方式，见 CLAUDE.md）。
2. 登录页点「忘记密码？」→ 到 `/forgot-password`，家长蓝白主题。
3. 输入未注册手机号 → 提示「该手机号未注册」。
4. 输入真实家长手机号 → 页面显示 6 位验证码，服务端日志有一行 `[password-reset]`，按钮 60s 倒计时。
5. 填错验证码 → 「验证码错误」；连错 5 次 → 重新取码才行。
6. 正确流程重置 → 跳回登录页，新密码可登录。
7. 移动端视口（<768px）查看页面不破版（iPad 横屏为主断点，此页面向家长，两端都过一眼）。
