# 单点登录互踢（同账号同角色）设计

日期：2026-10-10
状态：设计已获用户批准（对话裁决，见 §0）
PRD：§7.8「账号与权限」单点登录互踢条目

## 0. 背景与裁决

用户发现同一账号可在多设备同时在线（JWT 无状态、7 天有效、服务端不记录登录点），裁决实现**同账号同角色互踢**。逐项裁决：

| 决策点 | 裁决 |
|---|---|
| 互踢粒度 | **同账号同角色**（学生在两台设备登录互踢；家长同理；不同账号互不影响） |
| 被踢端体验 | **401 惰性失效 + 提示**：旧端下次请求收到 401 → 提示「账号已在其他设备登录」→ 回登录页。**不做**专用「在线探测」轮询 |
| 实现方案 | **方案 A：token 版本号（seq）+ 进程内注册表**。否决方案 B（会话表逐请求校验——每请求多一次 DB 往返，单机家庭部署 YAGNI）与方案 C（只缩短期限，不构成互踢） |
| 管理员 | 纳入同角色互踢（成本为零） |
| 修改/重置密码 | 维持现状：**不**踢已发 token |
| token 有效期 | 维持 7 天 |

关键先例：`common/guards/ban-registry.ts`（进程内封禁名单 + AuthMiddleware O(1) 查验 + 重启从 DB 重建）——本设计是同一模式的第二个实例。

## 1. 数据模型

新表 `auth_sessions`（一行 = 一个账号的当前有效会话序号）：

```sql
CREATE TABLE IF NOT EXISTS auth_sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role ENUM('admin','parent','student') NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  token_seq INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_role_user (role, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- 同时进 `tools/db/schema.sql` 与幂等迁移 `tools/db/migrations/2026-10-10_auth_sessions.sql`；批次收尾跑 `python3 tools/db/schema_reconcile.py` 对账。

## 2. 服务端

### 2.1 JWT

- payload 增加 `seq: number`。登录/注册签名前先 bump（见 2.3），签名带 bump 后的 seq。
- 现有 payload 结构（`JwtUser`）只增不改；`seq` 对旧代码是未知字段，无兼容问题。

### 2.2 SessionRegistry（新，仿 BanRegistry）

位置 `common/guards/session-registry.ts`：

- 进程内 `Map<string, number>`（key = `${role}:${sub}`，value = 当前 seq）。
- `bump(role, sub, nextSeq)`：登录时调用（写入方是 AuthService，DB upsert 与内存更新同点完成）。
- `matches(role, sub, seq)`：`map.get(key) === seq`。注册表无该账号的行 → 返回 false（安全默认：内存与 DB 失配时宁踢勿放）。
- `load(rows)`：启动时从 `auth_sessions` 全量重建（接线点与 BanRegistry.load 同处，app 启动 Task 完成）。

### 2.3 AuthService.login / register

- 命中账号、验密通过后：`INSERT ... ON DUPLICATE KEY UPDATE token_seq = token_seq + 1` → 读回新 seq → `sessionRegistry.bump(...)` → 签名带 seq。
- **bump 写库失败 → 登录整体失败**（500）：否则两台设备可能拿到相同 seq，互踢静默失效，宁可报错。

### 2.4 AuthMiddleware

验签通过后、挂 `request.user` 前：

```
if (!sessionRegistry.matches(payload.role, payload.sub, payload.seq))
  throw new UnauthorizedException({ code: 1013, message: '账号已在其他设备登录' });
```

- 旧格式 token（无 `seq`，本功能上线前签发）→ `payload.seq` 为 undefined → matches 为 false → 1013。**上线后存量登录全部失效一次**，属预期，发布说明须写明。
- 401 抛出方式与既有封禁 401 相同（必须穿透中间件的吞错分支到达 HttpExceptionFilter）。
- 错误码沿用既有分段：1003 = 未登录/token 过期，**1013 = 已被踢**（前端据此区分文案）。~~1005~~ 已被 `roles.guard.ts` 占用（无权访问），1004/1006-1010 也各有归属，1013 为下一个空闲号。

## 3. 前端

`src/services/api.ts` 的 401 处理加分支（三角色共用同一拦截逻辑；PC App/Electron 跑同一套 web UI 自动生效）：

- 401 且响应体 `code === 1013` → 提示「账号已在其他设备登录」→ 清本地登录态（token/userId/username/userRole）→ 跳登录页。
- 其余 401（1003 过期/未登录）维持现有行为不变。

## 4. 边界与不变量

- 同浏览器多标签页共用 localStorage 同一 token → 同 seq，互不干扰。
- 「同一登录点」以 token 为单位：同设备浏览器重开（token 未清）不算新登录；重新登录才 bump。
- 单进程假设：注册表在进程内，多实例部署会失配——本项目家庭自部署单机成立；若将来多实例，需把注册表挪到共享存储（记录为已知边界，本期不做）。
- 请求路径零额外 DB 往返（内存比对 O(1)）。
- admin token 同样校验；`auth_sessions` 三角色都写。

## 5. 测试

服务端：

1. SessionRegistry 单测：bump/matches/无行返回 false/load 重建。
2. AuthMiddleware：seq 不匹配 → 401 1013；无 seq 旧 token → 1013；匹配 → 放行；1013 异常穿透吞错分支（对齐 ban 401 的既有钉子）。
3. AuthService：login/register 后 token 带 seq；并发语义（同账号两次登录 → 第二次 seq 更大、第一次的 token matches 为 false）。
4. 链路测试：A 登录 → B 登录 → 用 A 的 token 请求 → 401 1013。

前端：

5. 401 拦截器：code=1013 → 提示文案 + 清登录态 + 跳登录；code=1003 → 行为不变（回归钉子）。

## 6. 文档同步

- API 设计文档 §4.1（认证）：401 错误码补 1013；openapi.yaml 同步。
- PRD §7.8：已补（2026-10-10 条目）。
- `docs/ai-core-changelog.md`：完成后记一条。
