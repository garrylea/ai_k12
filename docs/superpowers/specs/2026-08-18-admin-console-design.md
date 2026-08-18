# 家长与中枢管理系统 · 子项目 2：管理员中枢设计

> 日期：2026-08-18
> 范围：管理台（模型配置/账号封禁/消息推送/管理员 AI 聊天/dashboard/管理员改密）+ 家长台消息中心。
> 前置：子项目 1 三角色账号体系已完成（admins 表/统一三角色登录/RolesGuard/@Roles 装饰器/RequireRole 前端守卫/AdminLayout 占位壳）。
> 关联：PRD §7.7 家长端功能、§9 商业模式（优惠推送）；spec 见 `docs/superpowers/specs/2026-08-14-parent-admin-account-system-design.md`（账号地基）。

## 1. 需求决策记录（头脑风暴锁定）

| 决策点 | 结论 |
|---|---|
| 模型配置粒度 | **模型池 + 场景路由表**（scene×subject -> primary/fallback），难度维度保留代码内约定不进 UI/DB |
| 封禁语义 | 封家长**连封其名下所有学生**（is_active 级联），解封反向；旧 token 经内存 BanRegistry **即时失效** |
| 消息推送 | **站内消息中心**（家长台铃铛+未读数+列表页），支持定向/广播，不做外部通道（微信/短信后续） |
| 管理员 AI 聊天 | **独立会话表 + 管理员自选模型 + SSE 流式**，无 SafetyGuard 学习边界限制，不复用辅轨学生链路 |
| Dashboard | 四张基础统计卡 + 最近注册家长前 10 |
| 管理员改密 | 本次补齐（改自己密码，销掉子项目 1 遗留局限） |

## 2. 架构方案

采用 **方案 A：DB 为运行时真源 + YAML 为种子兜底**（对比方案 B 管理台读写 YAML 文件有并发/只读 FS/审计问题、方案 C 配置中心过度设计，均否）。

- 新增 `llm_models`/`llm_routes` 表，seed 从 `model-routes.yaml` 幂等导入。
- **apiKey 随模型条目走**：`ModelRouter.route()` 返回的 ModelConfig 携带 apiKey（不再剥离）；`ModelClient.getProvider` 优先用 `request.model.apiKey`，env 的 `getApiKeyByProvider` 降为兜底。适配器本就按 `request.model.baseUrl` 发请求，适配器层零改动。
- 新单例 `ModelConfigRegistry`（内存快照）承接 DB 读取；管理员保存即 `reload()`，无需重启。
- `model-routes.yaml` 保留为 seed 来源与 DB 不可用时的兜底。

## 3. 数据模型

迁移 `tools/db/migrations/2026-08-18_add_admin_console.sql` + schema.sql + DB 设计文档 v1.8 同步。

### 3.1 模型池 `llm_models`

```sql
CREATE TABLE llm_models (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  model_key VARCHAR(50) NOT NULL,            -- 路由引用键（如 qwen3.7-max、my-glm）
  name VARCHAR(100) NOT NULL,                -- 展示名
  provider_type VARCHAR(20) NOT NULL,        -- kimi|qwen|deepseek|gemini|openai_compatible
  model_id VARCHAR(100) NOT NULL,            -- 供应商实际模型 ID
  base_url VARCHAR(255) NOT NULL,
  api_key VARCHAR(500) NOT NULL,             -- AES-256-GCM 加密存储（见 §7）
  context_window INT NOT NULL DEFAULT 131072,
  max_output_tokens INT NOT NULL DEFAULT 16384,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_llm_models_key (model_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.2 场景路由 `llm_routes`

```sql
CREATE TABLE llm_routes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  scene VARCHAR(30) NOT NULL,                -- tutoring|grading|judgment|hint|explanation|variation|structuring|transcribe
  subject VARCHAR(20) NOT NULL,              -- math|chinese|english|*（subjects 表 code）
  primary_model_key VARCHAR(50) NOT NULL,
  fallback_model_key VARCHAR(50) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_llm_routes (scene, subject),
  CONSTRAINT fk_llm_routes_primary FOREIGN KEY (primary_model_key) REFERENCES llm_models (model_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.3 站内消息 `parent_messages` + `message_reads`

```sql
CREATE TABLE parent_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT NOT NULL,                 -- 指定家长；NULL=全员广播
  type VARCHAR(20) NOT NULL,                 -- promo|learning|system
  title VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,     -- 仅定向消息使用；广播的已读走 message_reads
  read_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_parent_messages_parent (parent_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE message_reads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  read_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_message_reads (parent_id, message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- **广播**：`parent_id=NULL` 行表示广播；家长列表查 `parent_id=自己 OR parent_id IS NULL`，广播已读经 `message_reads` upsert（UNIQUE 幂等）。定向消息直接行级 `is_read`。

### 3.4 管理员 AI 聊天 `admin_dialogues`/`admin_messages`

新建镜像表（不复用学生 `ai_dialogues`/`ai_messages`，避免 students FK 语义混淆与学生数据链路污染）：

```sql
CREATE TABLE admin_dialogues (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  model_key VARCHAR(50) NOT NULL,
  title VARCHAR(200) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_admin_dialogues_admin (admin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  dialogue_id BIGINT NOT NULL,
  role VARCHAR(10) NOT NULL,                 -- user|assistant
  content TEXT NOT NULL,
  reasoning TEXT DEFAULT NULL,               -- 透传思考链（与 ai_messages 一致）
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_admin_messages_dialogue (dialogue_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.5 seed

`scripts/seed-llm-config.ts`：把 `model-routes.yaml` 的 models（含 env 插值后的 apiKey）与 routes 幂等导入 `llm_models`/`llm_routes`（已存在同 model_key/同 scene+subject 跳过）。首次导入后 apiKey 加密落库。

## 4. ai-core 改造（配置动态化）

### 4.1 `ModelConfigRegistry`（`apps/server/src/ai-core/infra/model-config-registry.ts`，单例）

```ts
interface RegistrySnapshot {
  models: Record<string, ModelConfig & { apiKey: string }>;  // key = model_key
  routes: Record<string, RouteRule[]>;
  default: { primary: string; fallback: string };
}
```

- `getSnapshot(): RegistrySnapshot`--内存缓存，读不加锁。
- `async reload()`--读 `llm_models`（is_enabled=1）+ `llm_routes`（解密 apiKey）构建快照；**DB 查询失败或两表为空时回落 YAML `routeConfig`**（seed 前系统照常跑）。
- 启动：Nest `onModuleInit` 首次 `reload()`（异步不阻塞启动，失败回落）。
- 刷新：管理员保存模型池/路由表的 service 方法末尾调用--保存即生效。

### 4.2 `ModelRouter` 改造（最小侵入）

- 构造函数 `constructor(registry?: ModelConfigRegistry)`；**无参时行为完全不变**（直接读 YAML `routeConfig`，既有测试与 DI mock 零影响）。
- 传 registry 时 `route()` 从快照匹配规则，返回带 apiKey 的 ModelConfig。匹配算法（scene 精确->subject->通配->default）原样保留。
- 各 capability 的 `new ModelRouter()` 改为 `new ModelRouter(getRegistry())`（模块级单例 getter，非 DI 注入--capability 构造签名不变、mock 注入路径不变）。

### 4.3 `ModelClient` 改造

- `getProvider` 的 apiKey 优先级：`request.model.apiKey`（DB 条目携带）-> `getApiKeyByProvider`（env 兜底）。
- providers 缓存 key 从 provider 名改为 `provider + hash(apiKey)`（同 provider 不同 key 共存，如自定义 OpenAI 兼容模型与官方 qwen）。
- 新 provider 类型 `openai_compatible`：复用 `KimiClient`（标准 `/v1/chat/completions` OpenAI 风格，providerName='OpenAI'），零新适配器。
- gemini 流式限制照旧；`openai_compatible` 走流式。

### 4.4 不改的部分

PromptBuilder/capabilities 流程/retry/timeout/SafetyGuard 全部不动；`model-routes.yaml` 保留为 seed 来源与兜底。

## 5. 后端接口

### 5.1 AdminModule（`/api/admin/*`，全部 `@Roles('admin')`）

```
── 模型池 ──
GET    /api/admin/models                       列表（apiKey 打码 sk-***abc3）
POST   /api/admin/models                       新增 { modelKey, name, providerType, modelId, baseUrl, apiKey, contextWindow?, maxOutputTokens? }
PATCH  /api/admin/models/:modelKey             编辑（apiKey 留空=不改）
PATCH  /api/admin/models/:modelKey/status      启用/停用（停用前校验无启用中路由引用，否则 1004）

── 场景路由表 ──
GET    /api/admin/routes                       列表（含场景/学科枚举）
PUT    /api/admin/routes                       全量保存（整表提交，事务 delete+insert；校验 modelKey 存在且启用，否则 1004 拒整批）
POST   /api/admin/routes/validate-connection   连通性测试（10s 超时，发“1+1=?”探活，返回延迟/成败）

── 账号管理 ──
GET    /api/admin/parents?search=              家长列表（手机号/姓名模糊，含 is_active/名下学生数）
PATCH  /api/admin/parents/:id/status           封禁/解封（封=parent+名下 students 全部 is_active=0；解封反向全部=1；同步 BanRegistry）
GET    /api/admin/students?search=             学生列表（用户名/姓名）
PATCH  /api/admin/students/:id/status          单独封禁/解封学生

── 消息推送 ──
GET    /api/admin/messages                     已发列表（触达数/已读数）
POST   /api/admin/messages                     发送 { type, title, content, parentId? }（无 parentId=广播）
DELETE /api/admin/messages/:id                 撤回（直接删行+级联 message_reads）

── 管理员 AI 聊天 ──
POST   /api/admin/chat/dialogues               新建会话 { modelKey }（须启用中）
GET    /api/admin/chat/dialogues               会话列表（仅自己的）
DELETE /api/admin/chat/dialogues/:id           删除会话
POST   /api/admin/chat/stream                  SSE 流式对话 { dialogueId, message }（无学习边界；复用 ai-core 流式管道）
GET    /api/admin/chat/messages?dialogueId=    拉历史

── Dashboard + 自助 ──
GET    /api/admin/dashboard                    { parentCount, studentCount, todayAiCalls, enabledModelCount, recentParents[10] }
                                              -- todayAiCalls 口径：当日新建 ai_dialogues 行数（学生 AI 使用量粗计数）
PATCH  /api/admin/password                     改自己密码 { oldPassword, newPassword }（旧密码错 1003）
```

### 5.2 家长侧（ParentModule，`@Roles('parent')`）

```
GET    /api/parent/messages                    我的消息（定向+广播合并，倒序，含 isRead）
GET    /api/parent/messages/unread-count       铃铛未读数
PATCH  /api/parent/messages/:id/read           标已读（广播走 message_reads upsert，定向改行）
```

### 5.3 封禁即时生效（`BanRegistry`）

- AdminModule 封/解封时同步更新内存 `Set<parentId>`/`Set<studentId>`；`AuthMiddleware` 在 token 解析后查验（O(1) 内存），命中即 401。
- 单进程 MVP 成立；重启后从 DB `is_active=0` 重建。

## 6. 前端管理台

### 6.1 布局与路由

`AdminLayout` 升级为正式侧栏布局（对齐 ParentNav 模式：左侧栏导航 + 底部用户信息卡（管理员名+退出按钮，三端一致）+ 右侧内容区），`data-theme="parent"`。路由全部包 `RequireRole role="admin"`：

```
/admin                  Dashboard
/admin/models           模型配置（模型池 + 路由表）
/admin/accounts         账号管理（Tab 家长/学生）
/admin/messages         消息推送
/admin/chat             AI 聊天
/admin/security         账号安全（改密）
```

### 6.2 页面要点

1. **Dashboard**：四张统计卡（家长数/学生数/今日 AI 调用/启用模型数）+ 最近注册家长表格（手机号打码/姓名/时间）。
2. **模型配置**：上半模型池表格（key/modelId/baseUrl/key 打码/类型/状态/操作）+ Modal 新增/编辑（编辑 apiKey 占位“留空则不修改”）+「测试连接」（显示延迟）；下半路由表（场景/学科/主模型/备选四个下拉，下拉选项=启用中模型），行内改、顶部「保存路由表」整表提交，成功 toast“已生效”。
3. **账号管理**：Tab 家长/学生 + 搜索框；行内状态徽章 + 封禁/解封按钮；封家长 ConfirmDialog 明示“将连带停用其名下 N 个学生账号”。
4. **消息推送**：发送表单（类型：优惠/学情/系统公告；标题；正文；范围：全员广播/指定家长搜索选择）+ 已发列表（触达/已读数、撤回带确认）。
5. **AI 聊天**：布局复用辅线 `AuxiliaryHomePage` 结构（左会话列表+右聊天窗+底部输入），独立 `adminChatStore`（不与 chatStore 混）；新建会话选模型；流式渲染复用 Markdown+KaTeX 原语；顶部提示“此聊天不受 K12 学习边界限制”。
6. **家长台消息中心**：`ParentNav` 加「消息」入口（`/parent/messages` 列表页：类型标签/标题/时间/已读，点击标已读）；头部铃铛图标带未读数徽章。

### 6.3 api.ts 增量

admin 侧 ~15 个函数 + parent 消息 3 个，走既有 `fetchApi`；SSE 另写 `streamAdminChat`（仿共享 `streamTutorEvents` 模式）。

## 7. 安全

1. **apiKey 存储**：AES-256-GCM 加密，密钥 `.env` 的 `LLM_CONFIG_ENC_KEY`（seed 未设则生成写回 `.env`）；接口永不回明文（列表打码，编辑留空=不改）；内存快照解密仅供 ModelClient。
2. **越权**：`/api/admin/*` 全 `@Roles('admin')`；`/api/parent/messages*` 全 `@Roles('parent')`；管理员聊天与学生对话物理分表。
3. **封禁即时生效**：`BanRegistry` 内存 Set + `AuthMiddleware` O(1) 查验；重启从 DB 重建。
4. **改密**：旧密码 bcrypt 验证；新密码 6-32 位；改后当前 token 不作废（无多设备管理，记录局限）。
5. **连通性测试**：10s 超时，仅探活不落对话。
6. **广播已读竞态**：`message_reads` UNIQUE(parent_id, message_id) upsert 幂等。

## 8. 错误码（沿用既有约定）

| code | 场景 |
|---|---|
| 1001 | 参数校验失败 |
| 1002 | 资源不存在（模型/路由/消息/家长/学生会话） |
| 1003 | 旧密码错误/未登录/被封禁（401 + 文案） |
| 1004 | 拒绝：model_key 重复、停用被启用中路由引用的模型、路由引用不存在/停用的模型（拒整批） |
| 1005 | 无权访问（角色不符/非本人会话） |
| 1009 | 连通性测试失败（含 provider 原始错误信息） |

## 9. 测试策略

1. `model-config-registry.test.ts`：DB 空/失败回落 YAML；reload 快照正确；停用模型不入快照；apiKey 解密。
2. `model-router.test.ts` 增量：传 registry 走快照匹配、返回带 apiKey；无参行为不变（既有测试零改动验证零回归）。
3. `admin.service.test.ts`：模型 CRUD（key 重复 1004、停用被引用 1004）；路由全量保存（引用坏 key 拒整批、事务回滚）；封家长级联学生 + BanRegistry；消息发送/列表/已读（定向行 vs 广播 reads）；改密（旧密码错 1003）。
4. `admin-chat`：SSE 流式事件序列（mock ModelClient）；会话隔离（管理员只见自己的）。
5. **端到端手测清单**：改模型池 baseUrl 为错值 -> 学生辅导请求回落 fallback；改判题路由模型 -> 不重启判题走新模型；封家长 -> 其学生旧 token 立即 401；广播消息 -> 两个家长铃铛均+1；管理员聊天选自定义 OpenAI 兼容模型可流式对话。

## 10. 文档同步

- openapi.yaml + API 设计文档：§4 新增 Admin 分组与 Parent messages 端点、版本日志 v2.0。
- DB 设计文档 v1.8（五张新表）。
- CLAUDE.md 实现记录 note。
