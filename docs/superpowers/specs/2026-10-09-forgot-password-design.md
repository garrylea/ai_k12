# 家长忘记密码（模拟验证码）设计

日期：2026-10-09
状态：已与用户逐节确认

## 1. 背景与目标

登录页「忘记密码？」按钮（`apps/web/src/pages/auth/LoginPage.tsx:194`）从未绑定行为——API 文档与 openapi.yaml 早已定义两个重置端点并标 MVP，但前后端均未实现。本设计补齐这条链路。

**口径**（来自 `docs/UX-UI设计文档.md`）：家长通过手机验证码自助重置；学生不做自助找回（学生密码由家长在家长端重置，该端点已存在：`PATCH /api/parent/students/:id/reset-password`）。

**已确认的关键裁决**：
- 验证码为**模拟验证码**：不接短信服务商，验证码**直接显示在页面上**，同时打印服务端日志。理由：家庭自部署、局域网使用，能碰到登录页的人本就在局域网内。
- 页面形态：**单页表单**（手机号 + 验证码 + 新密码一屏完成）。
- 验证码存储：**进程内存**（不建表、不写迁移）。理由：一次性短寿命数据，重启失效是天然安全行为；全仓无 Redis，不为验证码破例 MySQL-only 基建。
- 未注册手机号**直接报错**，不做防枚举。理由：局域网家庭场景，友好优先。

## 2. 前端设计

### 2.1 新页面 `/forgot-password`

新文件 `apps/web/src/pages/auth/ForgotPasswordPage.tsx`，路由在 `apps/web/src/routes/routeTable.tsx` 与 `/register` 平级注册。

页面元素（风格跟随登录/注册页，主题写死日间，同非学习阶段学生页处理）：

1. 顶部说明：「本流程用于家长账号；学生密码请联系家长在家长端重置」。
2. 手机号输入框：校验 `^1\d{10}$`（与注册一致），不合法时禁用「获取验证码」。
3. 「获取验证码」按钮：调用端点 ①；成功后页面上**直接显示返回的模拟验证码**（如「验证码：123456，5 分钟内有效」），按钮进入 60 秒倒计时防重复请求；失败展示错误信息。
4. 验证码输入框：6 位数字。
5. 新密码 + 确认新密码：6–32 位（与注册一致）；两次不一致时前端先拦截提示。
6. 「重置密码」按钮：调用端点 ②；成功后提示成功并跳转 `/login`；失败展示错误信息。
7. 「返回登录」链接。

### 2.2 改动点

- `LoginPage.tsx:194`：死按钮改为 `<Link to="/forgot-password">`。
- `apps/web/src/services/api.ts`：新增 `requestPasswordReset(phone)` 与 `resetPassword(phone, code, newPassword)` 两个无 token 函数（openapi 中 `security: []`）。

## 3. 后端设计

模块：`apps/server/src/modules/auth/`。两个端点均挂 `ThrottleInterceptor`。

### 3.1 端点 ① `POST /api/auth/password/reset-request`

入参 zod：`{ phone: string }`，正则 `^1\d{10}$`。

逐步逻辑：
1. 格式错 → 400。
2. `parentsRepo.findByPhone` 查不到 → 错误响应「该手机号未注册」（业务错误码沿用 auth 模块 100x 段）。
3. 同一手机号 60 秒内已有未过期验证码 → 拒绝，提示「请求过于频繁，请稍后再试」。
4. 生成 6 位数字验证码，存内存 `{ code, expiresAt = now + 5min, attempts: 0, lastSentAt }`。
5. 响应体直接返回验证码：`{ code: "123456", expiresIn: 300 }`（形状以 openapi.yaml 为主稿对齐），同时打一行服务端日志（如 `[password-reset] phone=138**** code=123456`）。

### 3.2 端点 ② `POST /api/auth/password/reset`

入参 zod：`{ phone, code, newPassword }`；`code` 为 6 位数字，`newPassword` 6–32 位。

逐步逻辑：
1. 格式错 → 400。
2. 内存取码：不存在或已过 expiresAt → 「验证码已过期，请重新获取」，并清除该过期码。
3. `code` 不匹配 → `attempts + 1`；若 `attempts >= 5` 则作废该码，之后须重新获取；错误响应「验证码错误」。
4. 匹配 → bcrypt 哈希（cost 10，与注册一致）→ 复用 `parentsRepo.updatePassword`（`apps/server/src/database/repositories/parents.repo.ts:49`）→ 从内存删除该码 → 返回 `{ success: true }`。
5. **不失效该家长已签发的 token**——与家长端「修改自己密码」（`PATCH /api/parent/password`）行为一致。

### 3.3 新增组件 `PasswordResetCodeService`

`@Injectable`，注册进 AuthModule。职责：生成、存储、校验、作废、60 秒重发间隔。全部状态在进程内 Map（key 为手机号）。对 controller 暴露的方法大致为：

- `issue(phone): { code, expiresIn }` —— 内含 60s 间隔判断，间隔内抛业务错误
- `verify(phone, code): void` —— 不匹配/过期/超次数时抛对应业务错误；成功时内部消费掉验证码

### 3.4 安全参数汇总

| 参数 | 值 |
|---|---|
| 验证码长度 | 6 位数字 |
| 有效期 | 5 分钟 |
| 同手机号重发间隔 | 60 秒 |
| 最大错误尝试 | 5 次（超次作废） |
| 请求限流 | 复用 `ThrottleInterceptor` |
| 密码哈希 | bcrypt cost 10 |
| 旧 token | 不失效 |

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| 手机号/验证码/新密码格式错 | 400（zod） |
| 手机号未注册 | 业务错误「该手机号未注册」 |
| 60 秒内重复取码 | 业务错误「请求过于频繁」 |
| 验证码过期 | 业务错误「验证码已过期，请重新获取」 |
| 验证码错误（<5 次） | 业务错误「验证码错误」，attempts+1 |
| 验证码错误（第 5 次） | 同上报错，且码作废 |
| 触发节流 | 沿用 ThrottleInterceptor 现有行为 |
| 内存态丢失（服务重启） | 用户端表现为「验证码已过期」，重新获取即可，无需特殊处理 |

## 5. 文档同步

- `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 中两端点**早已定义**，本设计响应形状以其为主稿对齐，不改文档语义。实现时核对两文档端点清单一致（仓库铁律）。
- `docs/ai-core-changelog.md` 追加一条工作日志。

## 6. 测试

**后端**：
- `PasswordResetCodeService` 单测：过期判断、5 次作废、60 秒重发间隔、成功消费后不可复用。
- 重置链路测试：未注册手机号报错 → 取码 → 错码拒绝 → 正确重置 → 用新密码能登录、旧密码不能登录。

**前端**（渲染测试铁律）：
- `ForgotPasswordPage.test.tsx`：渲染、验证码展示、倒计时、两次密码不一致拦截、成功跳转。
- 路由测试：`routeTable` 挂 `/forgot-password` 指向该页一条断言。

## 7. 范围外（明确不做）

- 不接短信服务商（接口形状已预留，将来只换「发送」环节）。
- 学生自助找回（口径：联系家长）。
- 管理员找回（schema 中 admins 无手机号，不在设计范围）。
- 不建 `password_reset_codes` 表、不写迁移。
