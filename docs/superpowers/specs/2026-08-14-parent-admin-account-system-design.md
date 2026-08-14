# 家长与中枢管理系统 · 子项目 1：三角色账号体系设计

> 日期：2026-08-14
> 范围：管理员（seed）+ 家长（自助注册）+ 学生（家长创建）三角色登录与权限地基，家长控制台仅学生账号管理。学生端学习流程零改动。
> 关联：`docs/K12智学系统-产品需求文档.md` §7.7 家长端功能、§7.8 账号与权限；参考项目 `k12-AI-learning` 的 RegisterPage/Accounts/AdminDashboard。

## 1. 背景与分解

用户提出的「家长与中枢管理系统」实际包含 5 个相对独立的子系统：
1. 三角色账号体系（管理员/家长注册登录/家长创建学生）— **本子项目**
2. 管理员中枢（模型配置/封禁/消息推送/管理员 AI 聊天）— 后续
3. 家长学情报告 — 后续
4. 计费缴费（套餐/优惠券/订单/支付）— 后续
5. 家长自带模型（BYO model）— 后续

经确认按依赖顺序切，先做账号体系：后续子系统（封禁作用于账号、学情挂在家长-学生关系下、缴费主体是家长）均依赖它，且 DB 的 `parents`/`students` 表已就绪，工作量可控。

## 2. 架构方案

采用 **方案 A：统一 JWT + 三套角色 Guard**（对比方案 B 分离登录端点过度设计、方案 C 统一 users 表重构风险高均被否）。

- DB：新增 `admins` 表；`parents`/`students` 已存在不动主结构，仅补 `is_active` 字段。
- 认证：沿用现有 JWT（`@nestjs/jwt`），payload 加 `role`。统一登录端点按 admins -> parents -> students 顺序查询命中。
- 后端守卫：Nest 三套 guard（`AdminGuard`/`ParentGuard`/`StudentGuard`）；家长接口在 service 层二次校验学生归属。
- 前端：按返回 `role` 路由（admin->/admin，parent->/parent，student->现状不变）；`/parent/*` 挂已有 `ParentLayout`（商务蓝主题）。
- 不引入刷新 token / `devices` 表接线（沿用现状，记为局限）。

## 3. 数据模型

### 3.1 新增 `admins` 表

对齐 `parents`/`students` 风格（软删 `deleted_at`、`updated_at` 触发器）：

```sql
CREATE TABLE IF NOT EXISTS admins (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(50) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,   -- 管理员自我封禁兜底（首个管理员不可封禁）
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  UNIQUE KEY uniq_admins_username (username, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.2 现有表小改

- `students` 加 `is_active TINYINT(1) NOT NULL DEFAULT 1`（家长停用学生的开关，登录时校验；停用≠删除，数据全留）。
- `parents` 也加 `is_active TINYINT(1) NOT NULL DEFAULT 1`（未来管理员封禁家长的位，本子项目不接管理员台 UI，字段先占位避免后续迁移）。

### 3.3 迁移与 seed

- 迁移 `tools/db/migrations/2026-08-14_add_admins_and_active_flags.sql`：
  - 建 `admins` 表；
  - 给 `students`/`parents` 加 `is_active` 列；
  - 给 `students` 补 `age`/`school_level`（若历史行缺，按 grade 回填）。
- seed 脚本 `apps/server/src/scripts/seed-admin.ts`：读 `.env` 的 `ADMIN_INITIAL_USERNAME`/`ADMIN_INITIAL_PASSWORD`，bcrypt 哈希后写入；若已存在则跳过（幂等）。
- 占位家长：seed 一个 `parents` 行（若 id=1 不存在则创建，phone='legacy', name='历史学生托管账号'）接管现存挂在 parent_id=1 的学生。**不改动现有学生数据**。
- `tools/db/schema.sql` 同步更新（admins 表 + is_active 字段）。

### 3.4 JWT payload

`{ sub, role: 'admin'|'parent'|'student', parentId? }`。学生带 `parentId` 便于归属校验；家长/管理员不带。token 由 `@nestjs/jwt` 签发，无刷新机制（沿用现状）。

### 3.5 DB 设计文档同步

`docs/.../数据库设计文档.md` 新增 `admins` 表节、更新 `students`/`parents` 字段说明、版本号 +1。

## 4. 后端接口与权限守卫

### 4.1 统一登录（改造现有 `POST /api/auth/login`）

原仅支持学生，改为支持三角色。查询顺序：admins(username) -> parents(phone 正则) -> students(username)，命中并验密通过即签发对应 role token。

```
POST /api/auth/login   { username: string, password: string }
→ { token, user: { id, role, name, username?, grade?, parentId? } }
```

- 停用校验：admin/parent/student 命中后若 `is_active=0` 返回 `401 { code:1003, message:'账号已停用' }`。
- 用户名歧义：phone 同时是某 parent 手机号又是某 student 用户名极不可能（学生用户名非手机格式），按 admins->parents->students 顺序命中即可，不额外处理。

### 4.2 家长注册（新增）

```
POST /api/auth/register   { phone: string, password: string, name?: string }
→ { token, user: { id, role:'parent', name, phone } }
```

phone 唯一校验（含软删）；bcrypt 哈希；成功后直接签发 parent token（注册即登录，省一次跳转）。重复注册返回 `409 { code:1004, message:'该手机号已注册' }`。

### 4.3 下线学生自主注册

现有 `auth.service.register`（学生注册）从控制器移除或仅保留内部调试入口（非 `/api` 暴露）。前端移除学生注册入口。符合 PRD §7.8「不支持学生自主注册」。

### 4.4 家长侧学生账号管理（新增，`/api/parent/students`，全部套 `ParentGuard`）

```
POST   /api/parent/students                       新建子账号
GET    /api/parent/students                       列出自己名下学生
PATCH  /api/parent/students/:id/reset-password    { newPassword }
PATCH  /api/parent/students/:id/status            { isActive: boolean }
```

新建 body：`{ name, username, password, age, grade }`；`school_level` 后端按 grade 推导；`parent_id` 取 token。

- **归属校验**：每个 `/:id` 操作先 `studentsRepo.findById(id)` 比对 `parent_id === token.parentId`，不匹配 `403 { code:1005, message:'无权操作该学生' }`（不泄漏存在性）。
- username 全局唯一；创建时同步建 `student_settings` 行（沿用现有默认值：theme=auto, school=按学段）。
- 404 统一 `{ code:1002, message:'学生不存在' }`。

### 4.5 Nest Guards（`apps/server/src/common/guards/`）

- `AdminGuard` / `ParentGuard` / `StudentGuard`：从 JWT 取 role，不匹配 `401/403`。
- 现有学生接口（practice/ai/conversations/progress）全部套 `StudentGuard`，确保家长/管理员 token 不能调用学生接口越权。
- 复用现有 `JwtAuthGuard` 做基础认证，角色 guard 叠加。

### 4.6 Repository

- 新增 `AdminsRepository`：`findByUsername` / `findActiveById`。
- `ParentsRepository`（新增或扩展）：`findByPhone` / `create`（注册）。
- `StudentsRepository` 补：`create`(若缺) / `updatePassword` / `setActive` / `findByParentId`。

### 4.7 模块组织

`AuthModule` 扩展（注入 ParentsRepository/AdminsRepository）；新增 `ParentModule`（控制器+service，管理学生子账号）；`AppModule` 注册。

## 5. 前端路由、页面与状态

### 5.1 路由结构

```
/login                 登录页（调后端，按返回 role 跳转）
/register              家长注册页（新，蓝色卡片风格）
/admin/*               AdminLayout（极简占位 dashboard + 退出登录）
/parent/*              ParentLayout（已有，商务蓝主题）
  /parent/students     学生账号管理页（新，核心）
  /parent/dashboard    占位（学情后续子项目）
/student/*             现状不变
```

### 5.2 路由守卫（新建 `src/guards/RequireRole.tsx`）

- 读 `useAuthStore.role`，不匹配重定向到 `/login`。
- `/parent/*` 需 parent、`/admin/*` 需 admin、`/student/*` 需 student。
- 根 `/` 按 role 跳转：admin->/admin，parent->/parent/students，student->入口选择页。

### 5.3 authStore 改造（`apps/web/src/store/authStore.ts`）

现状是 mock。改为：`login` 调 `/api/auth/login` 拿 token + user，存 `{ token, user: { id, role, name, username?, grade?, parentId? } }`（localStorage 持久化 token）。新增 `register`（家长注册）、`logout`（清 token + 跳 /login）。**删除前端 mock 按用户名格式猜 role 的逻辑**——role 以后端返回为准。

### 5.4 登录页改造（`LoginPage.tsx`）

- 移除"按用户名格式路由"前端猜测；改为调 `login()` 后用返回 `role` 跳转。
- 加"注册家长账号"链接 -> `/register`。
- 错误展示：停用账号、密码错误、手机号已注册等用后端 `code` 映射文案。

### 5.5 家长注册页（`RegisterPage.tsx`，新）

手机号+密码+可选姓名，调 `/api/auth/register`，成功即登录跳 `/parent/students`。复用 ParentLayout 蓝色卡片风格（参考项目 RegisterPage）。

### 5.6 学生账号管理页（`ParentStudentsPage.tsx`，新，仿参考 `Accounts.tsx`）

- 列表卡片：姓名/用户名/年龄·年级/开通日期/状态（正常/已停用）。
- 「开通新账号」表单：姓名、用户名、初始密码、年龄、年级（select 全学段），提交调 `POST /api/parent/students`。
- 每卡片操作：重置密码（弹窗输新密码）、停用/启用（状态切换按钮）。
- 复用 `BackButton`/`LogoutButton`（遵循复用导航控件约定）；浮层提示用现有 Toast。

### 5.7 API 层（`apps/web/src/services/api.ts`）

- `login(username, password)` 改造返回含 role；新增 `registerParent`、`listMyStudents`、`createStudent`、`resetStudentPassword`、`setStudentStatus`。
- 所有 `/api/parent/*` 请求带 JWT（复用现有 Authorization header 机制）。

### 5.8 学生端影响

零改动。学生登录链路不变（后端仍认学生用户名），登录后落 `/student` 入口选择页。

## 6. 错误处理与安全

### 6.1 错误码（沿用现有 `code` 数字约定）

| code | HTTP | 场景 | 文案 |
|------|------|------|------|
| 1003 | 401 | 用户名/密码错误、账号已停用 | 用户名或密码错误 / 账号已停用 |
| 1004 | 409 | 手机号已注册、用户名已存在 | 该手机号已注册 / 用户名已存在 |
| 1002 | 404 | 学生不存在 | 学生不存在 |
| 1005 | 403 | 越权操作非自己名下学生 | 无权操作该学生 |

既有 `HttpException` 异常过滤器透传 `code`+`message`，前端 `ApiError` 已带 code 直接映射文案。归属校验失败一律 1005，不暴露存在性（防枚举）。

### 6.2 安全要点

1. **密码**：bcrypt cost=10（沿用）；`newPassword` 长度/复杂度校验（6-32 位，不做强复杂度，面向家长设的儿童账号）；明文密码不落日志。
2. **JWT**：签名密钥走 `.env`（`JWT_SECRET`，已存在）；过期沿用现有配置；无刷新 token；登出仅前端清 token。
3. **越权**：`ParentGuard` 只验 role；**学生归属在 service 层二次校验**（guard 无法从 URL :id 判断），所有 `/:id` 操作先查 parent_id 匹配。
4. **学生接口越权防护**：现有 `/api/practice/*`、`/api/ai/*`、`/api/conversations/*`、`/api/progress/*` 全部加 `StudentGuard`，service 内从 JWT 取 `sub` 作 studentId（不信任前端传的 studentId，现有代码已如此，本次确认覆盖）。
5. **seed 密码**：管理员初始密码从 `.env` 读；seed 后运营应改密（本子项目不做改密 UI，管理员台子项目再补）。
6. **logs**：登录成功/失败记 info/warn（不含密码），含 IP（从请求头取，便于后续异常登录告警）。
7. **限流**：登录端点加基础限流（同 IP 每分钟 10 次）防爆破，用轻量 `ThrottleInterceptor`（仅作用于 `/api/auth/login`，内存计数，超限返回 `429 { code:1008, message:'请求过于频繁，请稍后再试' }`）。

### 6.3 已知局限（本子项目不修，记录）

- 无刷新 token / 单设备登录；token 过期需重新登录。
- 管理员无改密 UI（seed 即用，改密待管理员台子项目）。
- 家长侧无改自己密码（待管理员台或后续）。
- `devices` 表本子项目不接线（沿用现状）。

## 7. 测试策略

沿用 `apps/server` 现有 Vitest 体系（172 测试绿基线），补以下测试保持 tsc + 全测试绿。

### 7.1 单元/集成测试

1. **登录路由**（`auth.service.spec.ts`）：
   - admin/parent/student 三种正确凭据分别签发对应 role token（mock repo）。
   - 密码错 -> 1003；账号停用（`is_active=0`）-> 1003 停用文案。
   - 查询顺序：admin 命中即返回（不回落 parents/students）。
2. **家长注册**：
   - 新手机号 -> 创建 + 发 parent token。
   - 已存在手机号 -> 1004。
   - 软删后同号可重新注册。
3. **学生账号管理**（`parent.service.spec.ts`，mock StudentsRepository）：
   - 新建：username 唯一校验 -> 1004；`school_level` 按 grade 推导正确；连带建 `student_settings`。
   - 归属校验：操作非自己 `parent_id` 学生 -> 1005。
   - 重置密码 / 停用启用：字段更新正确。
4. **Guards**（`guards.spec.ts`）：
   - 三 guard 对正确 role 放行、错误 role 返回 403。
   - 现有学生接口套 StudentGuard 后 parent/admin token 调用被拒（抽 practice 一端点 e2e 断言）。

沿用现有 mock 注入风格。`apps/web` 无测试框架（CLAUDE.md 明示），前端不补单测，靠 tsc + lint + 手动验收。

### 7.2 手动验收清单

- seed 后管理员登录 -> /admin 占位页。
- 家长注册 -> 登录 -> /parent/students。
- 家长新建学生 -> 学生用该账号登录 -> /student 入口选择页（学习流程不破）。
- 家长停用学生 -> 学生再次登录被拒（停用文案）。
- 家长重置学生密码 -> 旧密码失效、新密码可登录。
- 现有学生（parent_id=1 托管）仍能正常登录学习（回归）。
- parent token 调 `/api/practice/*` -> 403（越权防护）。

## 8. 文档同步

- `docs/K12智学系统-数据库设计文档.md`：admins 表 + students/parents 字段 + 版本号。
- `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml`：登录端点改造（支持三角色）、新增 `/api/auth/register` 与 `/api/parent/students/*`、错误码 1002/1003/1004/1005；遵循 CLAUDE.md「两份文档互为对照必须同步」规则。
- CLAUDE.md：本子项目完成后追加实现记录 note。
