# K12 智学系统 — 后端 Web 服务设计文档

> 版本：v0.1（阶段 A）
> 对应文档：
> - [K12智学系统-架构设计文档.md](./K12智学系统-架构设计文档.md)（整体架构、子系统划分）
> - [API接口与数据流设计文档.md](./API接口与数据流设计文档.md)（REST/WebSocket 契约）
> - [K12智学系统-数据库设计文档.md](./K12智学系统-数据库设计文档.md)（schema 定义）
> - [K12智学系统-AI-Agent中枢设计文档.md](./K12智学系统-AI-Agent中枢设计文档.md)（ai-core 层）
> - [api/openapi.yaml](./api/openapi.yaml)（OpenAPI 规范）

## 1. 文档说明

本文档定义 `apps/server/` 的 **HTTP 接入层** 技术架构，包括 NestJS 模块划分、数据库访问层、认证方案、错误处理策略及当前实现状态。

整体系统架构、子系统划分、部署视图见《架构设计文档》§2–§4；API 端点契约见《API 接口设计文档》及 `openapi.yaml`。

### 1.1 范围

- NestJS Web 框架选型与项目结构
- 模块化拆分方案（对齐 openapi.yaml tag 分组）
- 数据库访问层设计（mysql2 + Repository 模式）
- 认证与授权流程（JWT Bearer）
- 响应格式与全局错误处理
- ai-core 集成方式

### 1.2 与 ai-core 的关系

`ai-core/` 是独立的能力库（infra + capabilities），**不持有 HTTP 感知**。HTTP 层通过 NestJS Module (`modules/ai/`) 封装调用 ai-core capabilities，负责：

1. **校验**：将 HTTP 请求体经 Zod schema 映射到 capability 的 typed request
2. **鉴权**：JWT Guard 验证身份 + 数据归属
3. **序列化**：将 capability response 包装为 `CommonResponse { code, message, data }`
4. **流式**：对 `/api/ai/tutor`，使用 SSE 包装 `ModelClient.streamChat()`

---

## 2. 技术栈

| 层级 | 选型 | 说明 |
|------|------|------|
| HTTP 框架 | NestJS 10 + Express 适配器 | 架构文档推荐方案，便于模块化拆分 |
| 运行时 | Node.js ≥20 LTS | 与 ai-core 一致 |
| 语言 | TypeScript 5 + ESM (`"type":"module"`) | decorator metadata 经 `@swc-node/register` 支持 |
| 数据库驱动 | mysql2 (promise API) | 与 data-refinery 一致 |
| DB 访问模式 | Repository + 参数化 SQL | 无 ORM；`schema.sql` 为 DDL 唯一源 |
| 认证 | @nestjs/jwt + passport-jwt | Bearer JWT，payload: `{ sub, role, familyId, parentId? }` |
| 校验 | Zod | 与 ai-core 统一定义 |
| 密码哈希 | bcrypt | salt rounds = 10 |

---

## 3. 项目结构

```
apps/server/src/
├── main.ts                          # NestJS 入口
├── app.module.ts                    # 根模块（注册全局 Filter/Interceptor）
│
├── common/                          # 共享基础设施
│   ├── filters/
│   │   └── http-exception.filter.ts # 异常 → CommonResponse 映射
│   ├── interceptors/
│   │   └── response.interceptor.ts  # 成功响应 → { code:0, message:"ok", data }
│   ├── guards/
│   │   ├── jwt-auth.guard.ts        # JWT 验证
│   │   └── roles.guard.ts           # 角色权限（@Roles('parent','student')）
│   └── decorators/
│       ├── current-user.ts          # @CurrentUser() → { sub, role, familyId }
│       └── roles.ts                 # @Roles() 元数据装饰器
│
├── database/                        # 数据访问层
│   ├── database.module.ts           # @Global() DynamicModule，导出连接池
│   ├── connection.ts                # mysql2/promise createPool
│   ├── repositories/                # 每个表一个 Repository 类
│   │   ├── subjects.repo.ts
│   │   ├── students.repo.ts
│   │   ├── textbook-versions.repo.ts
│   │   ├── semesters.repo.ts
│   │   ├── units.repo.ts
│   │   ├── lessons.repo.ts
│   │   ├── cards.repo.ts
│   │   └── progress.repo.ts
│   └── seed.ts                      # Demo 数据种子（开发用）
│
├── modules/                         # 业务模块（对齐 openapi.yaml tag）
│   ├── auth/                        # 认证模块
│   ├── users/                       # 用户管理（待建）
│   ├── content/                     # 内容查询（教材、章节、课时）
│   ├── progress/                    # 学习进度 + 星图聚合
│   ├── ai/                          # AI 能力封装（待建）
│   ├── assessment/                  # 测评考试（待建）
│   ├── error-book/                  # 双错题本（待建）
│   ├── conversations/               # 对话管理（待建）
│   ├── knowledge-graph/             # 知识点图谱（待建）
│   ├── rewards/                     # 奖励（待建）
│   ├── parent/                      # 家长端（待建）
│   ├── refinery/                    # 数据识别（待建）
│   ├── files/                       # 文件上传（待建）
│   └── quota/                       # AI 额度（待建）
│
├── ai-core/                         # [已存在·不改动] AI Agent Hub
│   ├── infra/                       # ModelClient, ModelRouter, SafetyGuard 等
│   ├── capabilities/                # Tutoring, Grading, Explanation 等
│   ├── prompts/                     # Prompt 模板
│   └── *.yaml                       # 模型路由/重试/安全/兜底配置
│
└── services/                        # 领域服务
    └── conversation/                # [已存在] ConversationService（in-memory）
```

---

## 4. 模块详解

### 4.1 模块依赖关系

```
app.module
  ├── DatabaseModule          (@Global, 所有模块可用)
  ├── AuthModule              (→ DatabaseModule)
  ├── UsersModule             (→ DatabaseModule)
  ├── ContentModule           (→ DatabaseModule)
  ├── ProgressModule          (→ DatabaseModule, ContentModule)
  ├── KnowledgeGraphModule    (→ DatabaseModule)
  ├── ErrorBookModule         (→ DatabaseModule, ContentModule)
  ├── ConversationsModule     (→ DatabaseModule)
  ├── AssessmentModule        (→ DatabaseModule, ErrorBookModule, ContentModule)
  ├── AIModule                (→ ai-core/capabilities, ProgressModule, ErrorBookModule)
  ├── RefineryModule          (→ FilesModule)
  ├── FilesModule             (→ DatabaseModule)
  ├── RewardsModule           (→ DatabaseModule, ProgressModule)
  ├── ParentModule            (→ DatabaseModule, ProgressModule, ErrorBookModule)
  └── QuotaModule             (→ DatabaseModule)
```

### 4.2 DatabaseModule（@Global）

```typescript
@Global()
@Module({
  providers: [{ provide: 'DATABASE_POOL', useFactory: () => createPool() }],
  exports: ['DATABASE_POOL'],
})
export class DatabaseModule {}
```

每个 Repository 通过 `@Inject('DATABASE_POOL')` 注入连接池，使用 `pool.execute(sql, params)` 执行参数化查询，返回 camelCase 的 TypeScript 接口。

### 4.3 AuthModule

端点：

| Method | Path | 说明 | 鉴权 |
|--------|------|------|------|
| POST | `/api/auth/login` | 登录返回 JWT | 无 |
| POST | `/api/auth/register` | 学生注册（MVP 简化） | 无 |

JWT Payload：
```json
{
  "sub": 1,
  "role": "student",
  "familyId": 1,
  "parentId": 1,
  "iat": 1785211405,
  "exp": 1785816205
}
```

阶段 A 仅实现学生登录（`students` 表）；家长登录、密码重置等后续实现。

### 4.4 ContentModule

端点：

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/content/subjects` | 学科列表 |
| GET | `/api/content/versions?subjectId=` | 教材版本列表 |
| GET | `/api/content/versions/:versionId/units` | 单元/章节（含 semester 信息） |
| GET | `/api/content/versions/:versionId/units/:unitId/lessons` | 课时/小节（含知识点数量） |

### 4.5 ProgressModule（星图聚合）

端点：

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/progress/students/:studentId/star-map?subjectId=` | 星图聚合数据 |

一次返回前端需要的所有数据（章节 + 小节 + 状态 + 进度），避免多次请求。

聚合逻辑：
1. 查 `progress` → 获取学生当前进度位置
2. 查 content hierarchy → 获取完整章节树
3. 计算 status（completed/current/locked）和 progress
4. 计算 `importance`（基于 lesson 数：≥5=large, 3-4=medium, 1-2=small）
5. 统计每个 lesson 的 knowledgePointCount（从 cards.knowledge_point_ids 去重计数）

---

## 5. 响应格式

所有端点统一通过 `ResponseInterceptor` 包装：

```json
{
  "code": 0,
  "message": "ok",
  "data": { ... }
}
```

### 错误码

| Code | HTTP | 含义 |
|------|------|------|
| 0 | 200 | 成功 |
| 1001 | 400 | 参数校验失败 |
| 1002 | 404 | 资源不存在 |
| 1003 | 401/403 | 未认证 / 无权限 |
| 1004 | 400 | 操作被拒绝（如未清零就解锁） |
| 1005 | 429 | AI 额度耗尽 |
| 2001 | 400 | 非学习内容（AI 阻断） |
| 5000 | 500 | 服务器内部错误 |

---

## 6. Repository 设计模式

每个 Repository 是一个 `@Injectable()` 类，构造函数注入 `@Inject('DATABASE_POOL')`：

```typescript
@Injectable()
export class UnitsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findBySemesterId(semesterId: number): Promise<Unit[]> {
    const [rows] = await this.pool.execute<UnitRow[]>(
      'SELECT * FROM units WHERE semester_id = ? ORDER BY sort_order',
      [semesterId],
    );
    return rows.map(this.mapRow);
  }
}
```

设计原则：
- 每个表一个 Repository 类
- 使用参数化查询（防 SQL 注入）
- 返回 camelCase 的 plain TypeScript 接口（非 ORM entity）
- 不含业务逻辑（业务逻辑在 Service 层）
- `schema.sql` 是 DDL 唯一数据源，不做 ORM 迁移

---

## 7. 当前实现状态

### 7.1 阶段 A（已完成）

| 模块 | 端点 | 状态 |
|------|------|------|
| Auth | `/api/auth/login`, `/api/auth/register` | ✅ |
| Content | `/api/content/subjects`, `/versions`, `/versions/:id/units`, `/versions/:id/units/:id/lessons` | ✅ |
| Progress | `/api/progress/students/:id/star-map` | ✅ |
| Database | connection pool + 8 repositories | ✅ |
| Common | Filter, Interceptor, Guards, Decorators | ✅ |
| Seed | 人教版三年级数学上册 (8 units × 23 lessons) + demo student | ✅ |

### 7.2 待实现

其余 12 个模块（Users、AI、Assessment、ErrorBook、Conversations、KnowledgeGraph、Rewards、Parent、Refinery、Files、Quota、WebSocket）按 MVP 优先级后续迭代。

---

## 8. 开发命令

```bash
cd apps/server

# 安装依赖
npm install

# 开发模式（SWC + watch）
npm run start:dev     # → http://localhost:3001

# 类型检查
npm run build

# 测试
npm test

# 种子数据（需先确保 DB 可连接）
npx tsx src/database/seed.ts

# 导入真实内容数据（需先完成 convert + extract + publish 阶段）
cd tools/data-refinery && python3 src/refinery_cli.py --skip-publish
```
