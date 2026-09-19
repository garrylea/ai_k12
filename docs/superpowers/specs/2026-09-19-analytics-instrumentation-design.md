# 学习埋点采集层 + 家长/运营双仪表盘 · 设计

日期：2026-09-19
状态：**待实施**
相关：`docs/家长端学情批-完成情况与待办清单.md` §2（本 spec 的直接来源）、`docs/superpowers/specs/2026-09-18-parent-insights-design.md` §1.1（把「学习时长埋点 / 掌握度写入」挂到独立 spec —— 本批即那份）、`docs/K12智学系统-产品需求文档.md` §7.7 与 §6.1/P6.5、`docs/UX-UI设计文档.md` §5.6、`docs/API接口与数据流设计文档.md` §4.13/§4.23/§4.24/§6.25–6.26、`docs/api/openapi.yaml`、`tools/db/schema.sql`

---

## 1. 定位与边界

把「平台本来就该知道的事」变成可查的数据：学生在哪学、学多久、在哪一步放弃、哪个模块真带来效果、每一次 LLM 调用花了多少钱。消费方有三方，需求差别很大，本 spec 一次设计到位：

| 消费方 | 要什么 | 粒度需求 |
|---|---|---|
| **家长**（P6.1–P6.5） | 每个孩子的、可解释的学情：**总学习时长 / 各科学了多久** / 哪科弱 / 错在哪 / **今日累计学习时长**（= 今天真正在学的时间，用来和「每日上限」「每日目标」比较，见下） | 结果类 + 时长 |
| **运营/公司管理者**（管理台） | 跨学生的聚合 + 漏斗 + 留存 + 模块效果 + 内容与接口质量 + 模型费用 + **设备分布**（大多数学生用什么设备学习） | 过程类行为流 |
| **家长协同**（P6.5 目标 / P6.6 管控） | 「今日已用时长」这种实时用量，用于与上限/目标比较 | 实时聚合 |

> **「今日累计学习时长」的口径**：只累计**页面在前台且有操作**的时间（切后台、挂机 > 2 分钟不计）。它存在的理由是补齐 P6.6 行为管控缺失的另一半——`controls.daily_time_limit_minutes` 只是**上限**，库里现在没有「已用」，所以那个上限目前是摆设；P6.5 的「每日学习 30 分钟」目标同理需要它算达成率。

**边界**：

- 本批**只加采集与只读聚合**，不改任何学习业务规则、不动主线清零门禁、不改判题口径。
- **家长端既有口径一行不改**。新时长是**新增口径**，不是修正旧的「近 7 天活跃天数」（详见 §10）。
- **隐私分层是硬约束**：一部分行为信号（看答案/提示依赖、连续失败、放弃点、「我不会」自评）**只进运营端**，永不进家长端（§5.4）。
- **不做 A/B 实验框架、不做归因模型、不做 ML 预测**。效果归因止步于「描述指标 + 分组对比」，并明确标注相关非因果。
- **不改 `homeworks` / `assessments` 的接线**——那是整块产品面（智能组卷），不是埋点。
- **设备统计只到「类别」，不建设备指纹**：不存任何能唯一定位一台设备的标识（也不存原始 UA 字符串），粒度只到 `platform_class` / `browser` / `screen_class` / `input_type` / `app_shell`（§4.2、§8.3）。设备维度属 **ops-only**，不进家长端。

---

## 2. 调研结论（实测，决定了口径与可得性）

### 2.1 全库没有任何时长/事件/账本数据

| 结论 | 证据 |
|---|---|
| 无任何时长/心跳/事件/点击/指标表 | grep `heartbeat\|event\|click\|metric\|telemetry\|study_time\|page_view` 全库零命中；`schema.sql` 58 表无一张可充当事件存储 |
| `progress.last_active_at` 只在首次领课时写一次，且仓储不读 | `schema.sql:510` |
| `devices.last_active_at` 存在但**无仓储、从未写入** | `schema.sql:78` |
| `devices` 表**不能**当设备画像复用：它是登录 token 记录（`token_hash` / `expires_at`，`device_name` 只是备注），且从未写入 | `schema.sql:72-83` |
| 前后端**都没有** UA 解析依赖（`ua-parser` / `bowser` / `platform` 全无） | `apps/server/package.json`、`apps/web/package.json` |
| `ai_messages` 的 `model` / `token_input` / `token_output` / `response_time_ms` 四列**生产恒写 NULL** | `conversations.service.ts:91,176,198`、`services/conversation/index.ts:143`；DTO 亦如此注明（`parent-insights.dto.ts:182`） |
| `training_sessions` 是唯一「有 started_at/completed_at」的会话表，仅覆盖 `math_targeted` / `en_vocabulary`，且**全仓未计算过时长** | `schema.sql:1136`、`training-sessions.repo.ts:44,72,87` |
| prom-client 指标**未接线**（只定义、无自增调用者、无 `/metrics` 路由） | `ai-core/infra/metrics.ts:13-19,64`；CLAUDE.md 的「metrics 未接入 capability」 |
| Nest 的 `APP_INTERCEPTOR` / 中间件机制**在用**，有现成挂载点 | `app.module.ts:47-68`（`ResponseInterceptor` + `AuthMiddleware` exclude+forRoutes） |
| `routes/index.tsx:8` 就是 `createBrowserRouter(routes)`，可包 pathless wrapper | `apps/web/src/routes/index.tsx` |
| 前端零埋点：无 gtag/Sentry/sendBeacon，`visibilitychange` 从未使用 | grep 全仓；`RunExitGuard.tsx:37` 的 `beforeunload` 是导航守卫，不是埋点 |

### 2.2 死表（表在、零写入）—— 本批只复活其中一张

`student_knowledge_mastery`（**本批复活，补写入**）、`goals`（**本批复活，加 `metric` 列**）。
**不复活**：`safety_alerts`、`learning_reports`、`error_redo_logs`、`variation_questions`、`knowledge_relations`、`homeworks`、`assessments`、`homework_submissions`、`assessment_submissions`。

### 2.3 最严重的一处：生产 token 恒为 0

```
model-client/index.ts:64   useStream = request.stream !== false && provider !== 'gemini'   ← 默认就是流式
model-client/index.ts:99   usage: { inputTokens: 0, outputTokens: 0, cost: 0 }              ← 硬编码 0
```

所以**不只 Kimi**——生产环境所有 LLM 调用的 token 都是 0，`cost` 更是永远 0。加上：

```
model-config-registry.ts:70        costPer1K: { input: 0, output: 0 }   ← DB 路径把单价写死
modules/admin/admin-chat.service.ts:84  costPer1K: { input: 0, output: 0 }
schema.sql:937-951                 llm_models 表**没有价格列**（真价只在 model-routes.yaml）
```

即「次数 / token / 钱」三样现在**全都算不出来**。这就是 §12 把「钱」放在 Phase 0 的原因。

---

## 3. 总体架构

```
学生端页面 ──[前端 tracker]──┬─ A 组 心跳(30s) ──→ /api/study-sessions/*  ──→ study_sessions
                             └─ B 组 语义事件(批量) ─→ /api/track/events   ──→ behavior_events
   └─[所有 HTTP 请求]───┐
                        │
服务端 ─[AnalyticsInterceptor]─→ api_request_logs        (D：失败率/错误码/慢接口/SSE 时长)
   ├─[JudgeCoreService 出口]──→ student_knowledge_mastery (C) + behavior_events(判题/清零)
   ├─[专项判题出口]───────────→ special_practice_logs     (C：语文三专项逐句 / 英语逐词)
   ├─[PointsService.award]────→ behavior_events(points_awarded / exam_submitted)
   └─[ModelClient.chat]───────→ llm_call_logs            (E：每次调用 + tokens + cost + fallback)

家长端 → parent-analytics.repo.ts（**硬编码 tier='parent'**）→ 时长/趋势/专项/掌握度/今日用量/目标
运营端 → /api/admin/analytics/* → overview·funnel·retention·modules·cohort-compare·quality·llm-cost·events·requests
```

**两条写入纪律（贯穿全设计）**：

1. **分析类日志走唯一 buffer**：`TelemetryBuffer` 统一承载 `behavior_events` / `api_request_logs` / `llm_call_logs`。2s 或满 200 条 flush；环形上限 5000，满则丢最旧并自增 `droppedCount`；flush 失败**整批丢弃、永不重试、永不抛**。
2. **业务数据直写但不阻断**：`study_sessions` / `special_practice_logs` 是业务数据，`await` 直写，但一律包 try/catch —— 失败只 `logger.warn`，**绝不 500**（心跳失败前端无感；专项日志失败不影响判题返回）。

---

## 4. 数据模型

全部 `DATETIME(3)` / InnoDB / utf8mb4 / 列级 `ON UPDATE CURRENT_TIMESTAMP(3)` / **不用触发器**。新建表用 `CREATE TABLE IF NOT EXISTS`（天然幂等）；改列用 information_schema + PREPARE 守卫（沿用 `2026-09-16_chinese_interpretation_columns.sql`）。**新表必须同时写进 `tools/db/schema.sql`**（无迁移运行器）。

### 4.1 原始 / 派生定性

| 表 | 性质 | 保留期 |
|---|---|---|
| `study_sessions` | 原始（真源） | 180 天，之后折进 `daily_study_stats`（Phase 3） |
| `behavior_events` | 原始（真源） | 180 天 |
| `special_practice_logs` | 原始（真源） | **永久**（量小、可审计） |
| `api_request_logs` | 原始（技术日志） | 30 天 |
| `llm_call_logs` | 原始（账本） | 400 天 |
| `student_knowledge_mastery` | 权威状态（可重算） | 永久 |
| `goals` | 权威状态 | 永久 |
| `daily_study_stats` | 派生（可重建） | Phase 3 才引入 |

**v1 不建任何 per-day rollup**。英语「每天背了几个词」必须落 `special_practice_logs` 原始行——`student_word_progress.last_seen_at` 是**覆盖式最新值**，历史不可重建；语文三专项现在只能从 `point_ledger` 的 `dedupeKey` 间接数「今天做了几篇」，那是积分账本，语义脆弱且依赖发分配置。

### 4.2 `study_sessions`

```sql
CREATE TABLE IF NOT EXISTS study_sessions (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id        BIGINT       NOT NULL,
  session_uid       CHAR(36)     NOT NULL COMMENT '前端生成的幂等键',
  module            VARCHAR(32)  NOT NULL COMMENT '低基数枚举，见 §5.1',
  scene             VARCHAR(40)  NOT NULL COMMENT '路由级细分，比 module 细',
  subject_id        BIGINT       DEFAULT NULL,
  ref_type          VARCHAR(24)  DEFAULT NULL COMMENT 'lesson|card|paper|passage|word|dialogue',
  ref_id            BIGINT       DEFAULT NULL,
  status            VARCHAR(12)  NOT NULL DEFAULT 'active' COMMENT 'active|ended|abandoned',
  client_state      VARCHAR(10)  NOT NULL DEFAULT 'visible' COMMENT 'visible|hidden（上次心跳时的可见性）',
  active_seconds    INT          NOT NULL DEFAULT 0 COMMENT '服务端累计；客户端上报的秒数一律不采信',
  heartbeat_count   INT          NOT NULL DEFAULT 0,
  started_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_heartbeat_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at          DATETIME(3)  DEFAULT NULL,
  end_reason        VARCHAR(20)  DEFAULT NULL COMMENT 'route_change|pagehide|idle_timeout|closed|hidden_timeout',
  -- 设备画像：只到「类别」，不存任何唯一标识（见 §1 边界）
  platform_class    VARCHAR(20)  DEFAULT NULL COMMENT 'ipad|iphone|android_tablet|android_phone|mac|windows|linux|other（服务端解析 UA）',
  browser           VARCHAR(20)  DEFAULT NULL COMMENT 'chrome|safari|edge|firefox|electron|other（服务端解析 UA）',
  screen_class      VARCHAR(20)  DEFAULT NULL COMMENT 'ipad_landscape|desktop|tablet_portrait|mobile（前端上报）',
  input_type        VARCHAR(10)  DEFAULT NULL COMMENT 'touch|mouse|hybrid（前端上报）',
  app_shell         VARCHAR(10)  DEFAULT NULL COMMENT 'web|electron（前端上报）',
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ss_uid (session_uid),
  KEY idx_ss_student_time   (student_id, started_at),
  KEY idx_ss_student_module (student_id, module, started_at),
  KEY idx_ss_open           (status, last_heartbeat_at),
  KEY idx_ss_platform_time  (platform_class, started_at),
  CONSTRAINT fk_ss_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**设备画像的来源与分工**（粗分类，**不引依赖**——前后端都没有 UA 解析库，而我们只需要约 8 类、不要版本号）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `platform_class` / `browser` | **服务端**解析 `User-Agent` 请求头 | 页面 JS 改不了（仍是弱信号，UA 本身可伪造）。自研粗正则 + **按 UA 字符串 memoize**，避免每请求重复解析 |
| `screen_class` / `input_type` | **前端**上报 | 服务端拿不到：屏幕档按视口宽度 + 宽高比分档（对齐 `UX-UI设计文档` 的 iPad 横屏主断点）；`input_type` 用 `matchMedia('(pointer: coarse)')` |
| `app_shell` | **前端**上报 | `web` / `electron`（Electron 有 UA 标记，双保险） |

> 原设计里的 `client_platform`（`web|electron|ipad` 自报）被上面 5 列取代——它是这三列的子集，留着会语义重叠。

**⚠️ 必须做的交叉校正（否则 iPad 全部会被算成 Mac）**：iPadOS 13+ 的 Safari UA 字符串写的是 `Macintosh`（苹果的「desktop-class browsing」策略），所以**只看 UA 会把 iPad 误判为 Mac**——而 iPad 正是这个产品的主断点目标设备，误判会让这个报表直接失去意义。校正规则：

```
若 platform_class == 'mac' 且 input_type == 'touch'  →  platform_class = 'ipad'
```

服务端在写入 `study_sessions` 时应用这条规则（`input_type` 是前端上报的，二者在同一个请求里，可当场校正）。单测必须覆盖：`Macintosh` UA + `input_type='touch'` → `ipad`；`Macintosh` UA + `input_type='mouse'` → `mac`。

**会话与设备的对应关系（决定了能做哪些设备分析）**：

- **一个会话 = 一台设备**。会话生命周期是「进入学习页 → 离开 / 挂机结束」，`session_uid` 由前端在内存中生成，**重新登录必然产生新会话**。
- 因此「先在 PC 上学，出门换 Pad 重新登录继续学」是**两段会话、两行 `study_sessions`**，各自带自己的设备画像。这是正常且预期内的数据形态，不是重复计数。
- **由此可做的分析**（虽然不认「同一台物理设备」，但按**类别**足够）：
  - 「大多数学生用什么设备学习」= 按 `platform_class` 分组做 `COUNT(DISTINCT student_id)`（**按人头，不按会话**——一个学生一天开 10 次会话只能算 1 人）。
  - **多设备学生**：`COUNT(DISTINCT platform_class) GROUP BY student_id` → 「有多少学生用过不止一类设备」。
  - **设备切换**：相邻两段会话的 `platform_class` 不同 → 切换次数；配合 `byDay` 还能看出「平时 PC、周末 Pad」这类模式。
- **做不到**（需设备指纹，已明确排除）：「同一个学生是不是在用**同一台** Mac」「人均持有几台设备」。

**心跳累计算法（唯一实现，写在 `StudySessionsService`）**

```sql
UPDATE study_sessions
SET active_seconds = active_seconds
      + IF(client_state = 'visible',
           LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45),
           0),
    client_state      = ?,
    heartbeat_count   = heartbeat_count + 1,
    last_heartbeat_at = NOW(3)
WHERE session_uid = ? AND student_id = ? AND status = 'active';
```

参数（服务端常量，一处可调）：心跳间隔 **30s**、每次增量封顶 **45s**、idle 阈值 **120s**、`active AND last_heartbeat_at < NOW() - INTERVAL 5 MINUTE` 视为已结束（惰性收尾）+ 夜间 `closeStaleSessions()` 兜底。封顶是必须的：不封顶时「关标签 2 小时」会被算成 2 小时。

### 4.3 `behavior_events`

```sql
CREATE TABLE IF NOT EXISTS behavior_events (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_role   VARCHAR(10)  NOT NULL DEFAULT 'student' COMMENT 'student|parent|admin|system',
  student_id   BIGINT       DEFAULT NULL COMMENT 'admin/parent/匿名事件为 NULL',
  event        VARCHAR(40)  NOT NULL COMMENT '封闭字典，见 §5.2',
  tier         VARCHAR(8)   NOT NULL COMMENT 'parent|ops —— 写时由字典决定，调用方不可覆盖',
  module       VARCHAR(32)  DEFAULT NULL,
  scene        VARCHAR(40)  DEFAULT NULL,
  subject_id   BIGINT       DEFAULT NULL,
  ref_type     VARCHAR(24)  DEFAULT NULL,
  ref_id       BIGINT       DEFAULT NULL,
  session_uid  CHAR(36)     DEFAULT NULL COMMENT '关联 study_sessions.session_uid',
  request_id   VARCHAR(64)  DEFAULT NULL COMMENT '关联 api_request_logs.request_id',
  source       VARCHAR(8)   NOT NULL COMMENT 'server|client',
  props        JSON         DEFAULT NULL COMMENT '只放低基数补充，禁止塞自由文本',
  client_ts_ms BIGINT       DEFAULT NULL COMMENT '仅参考，以 created_at 为准',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_be_student_event_time (student_id, event, created_at),
  KEY idx_be_event_time         (event, created_at),
  KEY idx_be_module_time        (module, created_at),
  KEY idx_be_tier_time          (tier, created_at),
  KEY idx_be_session            (session_uid),
  CONSTRAINT fk_be_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 4.4 `special_practice_logs`

```sql
CREATE TABLE IF NOT EXISTS special_practice_logs (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT       NOT NULL,
  module         VARCHAR(32)  NOT NULL COMMENT 'chinese_dictation|chinese_interpretation|chinese_meaning|en_vocabulary',
  subject_id     BIGINT       DEFAULT NULL,
  ref_type       VARCHAR(24)  NOT NULL COMMENT 'passage|word',
  ref_id         BIGINT       DEFAULT NULL COMMENT 'passage_id / word_id；**故意不设外键**（同 student_word_progress.word_id）',
  ref_key        VARCHAR(128) DEFAULT NULL COMMENT '篇目标题 / 词面快照，便于排查与无 id 场景',
  sentence_index SMALLINT     DEFAULT NULL COMMENT '解释/含义专项逐句；默写/背词为 NULL',
  verdict        VARCHAR(20)  NOT NULL COMMENT 'correct|incorrect|off_target|unanswered|undetermined',
  is_correct     TINYINT(1)   DEFAULT NULL COMMENT 'correct=1 / incorrect=0 / 其它 NULL（沿用「空答案不计对错」）',
  error_counted  TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '必须复用 normalize-english.util 的 progressDelta 判决',
  session_uid    CHAR(36)     DEFAULT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_spl_student_module_time (student_id, module, created_at),
  KEY idx_spl_student_ref         (student_id, module, ref_id),
  KEY idx_spl_time                (created_at),
  CONSTRAINT fk_spl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

> `error_counted` **不得**在此另写一套「什么算错」：必须复用 `normalize-english.util.ts` 的 `progressDelta` 口径（只有 `wrong` 计错；`off_target` / `unanswered` / `undetermined` 三者都不计）。

### 4.5 `api_request_logs`

```sql
CREATE TABLE IF NOT EXISTS api_request_logs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id  VARCHAR(64)  DEFAULT NULL,
  actor_role  VARCHAR(10)  DEFAULT NULL COMMENT 'student|parent|admin|anonymous',
  student_id  BIGINT       DEFAULT NULL,
  method      VARCHAR(8)   NOT NULL,
  route       VARCHAR(120) NOT NULL COMMENT '归一化模板：/api/practice/:cardId/results',
  raw_path    VARCHAR(255) DEFAULT NULL COMMENT '原路径（含 id），仅排查用',
  module      VARCHAR(32)  DEFAULT NULL COMMENT '由 route 前缀推导',
  status_code SMALLINT     NOT NULL,
  biz_code    INT          DEFAULT NULL COMMENT '响应体 code（1001/5001...）',
  error_code  VARCHAR(40)  DEFAULT NULL COMMENT 'TimeoutError 等',
  latency_ms  INT          NOT NULL,
  is_sse      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_arl_route_time   (route, created_at),
  KEY idx_arl_status_time  (status_code, created_at),
  KEY idx_arl_student_time (student_id, created_at),
  KEY idx_arl_time         (created_at),
  CONSTRAINT fk_arl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

> 这里用 `ON DELETE SET NULL`（**唯一**偏离仓库 CASCADE 约定，且是**有意**的）：审计日志在删除学生后应保留聚合量、仅匿名化；列可空故 FK 合法。`llm_call_logs` 同理。

### 4.6 `llm_call_logs` + `llm_models` 价格列

```sql
CREATE TABLE IF NOT EXISTS llm_call_logs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id          VARCHAR(64)   DEFAULT NULL COMMENT '关联 api_request_logs.request_id',
  student_id          BIGINT        DEFAULT NULL COMMENT '**有归属时必填**（不是可选优化）；仅探活/系统任务等无归属调用为 NULL，见 §6.5',
  dialogue_id         BIGINT        DEFAULT NULL COMMENT '无外键：对话可删，账本不可',
  scene               VARCHAR(30)   NOT NULL,
  subject             VARCHAR(20)   DEFAULT NULL,
  capability          VARCHAR(30)   DEFAULT NULL,
  model_key           VARCHAR(50)   DEFAULT NULL COMMENT '路由条目 key（聚合按它，不按 model_id）',
  model_id            VARCHAR(100)  DEFAULT NULL COMMENT '实际下发 model id',
  provider            VARCHAR(20)   NOT NULL,
  attempt             SMALLINT      NOT NULL DEFAULT 1,
  request_kind        VARCHAR(8)    NOT NULL COMMENT 'chat|stream',
  is_fallback         TINYINT(1)    NOT NULL DEFAULT 0,
  success             TINYINT(1)    NOT NULL,
  error_type          VARCHAR(40)   DEFAULT NULL COMMENT 'TimeoutError|RateLimitError|ServerError|...',
  http_status         SMALLINT      DEFAULT NULL,
  input_tokens        INT           DEFAULT NULL,
  output_tokens       INT           DEFAULT NULL,
  usage_source        VARCHAR(12)   NOT NULL DEFAULT 'unavailable' COMMENT 'provider|estimated|unavailable',
  input_price_per_1k  DECIMAL(10,6) DEFAULT NULL COMMENT '价格快照，防改价后历史成本漂移',
  output_price_per_1k DECIMAL(10,6) DEFAULT NULL,
  cost                DECIMAL(12,6) DEFAULT NULL COMMENT '**NULL = 算不出，绝不写 0**',
  latency_ms          INT           NOT NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lcl_scene_time    (scene, created_at),
  KEY idx_lcl_model_time    (model_key, created_at),
  KEY idx_lcl_student_time  (student_id, created_at),
  KEY idx_lcl_fallback_time (is_fallback, created_at),
  KEY idx_lcl_time          (created_at),
  CONSTRAINT fk_lcl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE llm_models
  ADD COLUMN input_price_per_1k  DECIMAL(10,6) NOT NULL DEFAULT 0
    COMMENT '每 1K 输入 token 价，单位与 model-routes.yaml 的 costPer1K.input 一致',
  ADD COLUMN output_price_per_1k DECIMAL(10,6) NOT NULL DEFAULT 0
    COMMENT '每 1K 输出 token 价，单位与 costPer1K.output 一致';
```

### 4.7 `goals`（复活，加 `metric` 列）

```sql
ALTER TABLE goals
  ADD COLUMN metric VARCHAR(40) DEFAULT NULL
    COMMENT 'daily_study_minutes|daily_words|weekly_passages|weekly_clear_errors';
```

配套：`metric` 为 NULL 的历史行按 `daily_study_minutes` 解释（或在迁移里回填）；家长端 `/parent/goals` 从 `Placeholder` 变真页，支持读/写目标。默认目标**懒初始化**（仿 `point_rules` 的做法），家长可改。

### 4.8 `student_knowledge_mastery` 补写入（DDL 不变）

UPSERT（MySQL 8.0.20+ 的 `AS new` 别名写法，`VALUES()` 已废弃）：

```sql
INSERT INTO student_knowledge_mastery
  (student_id, knowledge_point_id, correct_count, error_count, mastery_score, level, last_seen_at)
VALUES (?, ?, ?, ?, ?, ?, NOW(3)) AS new
ON DUPLICATE KEY UPDATE
  correct_count = student_knowledge_mastery.correct_count + new.correct_count,
  error_count   = student_knowledge_mastery.error_count   + new.error_count,
  mastery_score = (student_knowledge_mastery.correct_count + new.correct_count)
                / NULLIF(student_knowledge_mastery.correct_count + new.correct_count
                       + student_knowledge_mastery.error_count + new.error_count, 0),
  level         = FLOOR(5 * ((student_knowledge_mastery.correct_count + new.correct_count)
                / NULLIF(student_knowledge_mastery.correct_count + new.correct_count
                       + student_knowledge_mastery.error_count + new.error_count, 0))),
  last_seen_at  = NOW(3);
```

四条规则：① 只在该题**绑了 KP** 时写（当前 `question_knowledge_points` 只覆盖 203/529 题，UI 必须显式展示「未覆盖」计数）；② `isCorrect === null`（空答案 / self_assess 待评）**不写**；③ `questionId == null` 跳过；④ 失败只 warn，不阻断判题。

### 4.9 迁移与 schema 落点

| 文件 | 内容 |
|---|---|
| `tools/db/migrations/2026-09-20_analytics_ledger.sql` | `llm_call_logs` + `api_request_logs` 建表；`llm_models` 加两价格列（带守卫） |
| `tools/db/migrations/2026-09-21_study_sessions_events.sql` | `study_sessions` + `behavior_events` + `special_practice_logs` 建表；`goals` 加 `metric` |
| `tools/db/schema.sql` | 上述全部**同步**写入（新建表放对应域段落；`llm_models` 与 `goals` 直接改列定义） |

---

## 5. 事件字典与隐私分层

### 5.1 低基数枚举

- `module`：`mainline` / `aux_qna` / `training_targeted` / `training_error_practice` / `exam` / `chinese_dictation` / `chinese_interpretation` / `chinese_meaning` / `en_vocabulary` / `admin` / `parent`
- `scene`：`course_detail` / `star_map` / `aux_chat` / `targeted_run` / `error_run` / `exam_run` / `dictation_run` / `interpretation_run` / `meaning_run` / `vocabulary_run` / `profile` / `rewards` / `parent_dashboard` / `admin_dashboard`
- `verdict`：`correct` / `incorrect` / `off_target` / `unanswered` / `undetermined`
- `end_reason`：`route_change` / `pagehide` / `idle_timeout` / `closed` / `hidden_timeout`

### 5.2 事件清单（18 个）

| event | 来源 | 必填 props | tier | 备注 |
|---|---|---|---|---|
| `study_session_started` | client | session_uid, module, scene | parent | |
| `study_session_heartbeat` | client | session_uid | —（不落事件流） | **不落 behavior_events**，只 UPDATE `study_sessions`，故不登记 tier |
| `study_session_ended` | client + server 兜底 | session_uid, end_reason | parent | `active_seconds` 取**服务端累计值**，不采信客户端上报（与 §4.2 一致） |
| `study_session_idle` | client | session_uid, idle_ms | **ops** | 「在哪走神/中断」 |
| `page_view` | client | scene, route | ops | 只记学习/家长/管理页；**登录页不记** |
| `answer_submitted` | server | verdict, method, is_correct, question_id? | parent | 主线/专项/错题/考试共用一个收口 |
| `hint_requested` | server | question_id? | **ops** | 「看了几次提示」——绝不进家长 UI |
| `answer_revealed` | client | question_id? | **ops** | 「看答案」点击 |
| `self_assess_answered` | server | assessment, question_id | **ops** | 含「我不会」 |
| `consecutive_failures` | server | count, question_id? | **ops** | 连续答错 |
| `card_flipped` | client | card_id | ops | |
| `ai_message_sent` | client + server | dialogue_id, scene | parent | **只记「发过」，不记内容** |
| `error_book_added` | server | question_id, subject_id | parent | |
| `error_book_cleared` | server | question_id, cleared_count | parent | |
| `points_awarded` | server | task_code, points, ref_type | parent | `PointsService.award` 内 |
| `exam_submitted` | server | session_id, paper_id | parent | |
| `special_unit_judged` | server | module, ref_type, ref_id, verdict | parent | 同时写 `special_practice_logs` |
| `llm_fallback_triggered` | server | scene, from_model, to_model | **ops** | 同时进 `llm_call_logs` |

**不落 `behavior_events` 的高频项**：`study_session_heartbeat`（直接 UPDATE `study_sessions`）、所有 API 请求（只在 `api_request_logs`）、每次 LLM 调用（只在 `llm_call_logs`）。`api_error` 同理**只落 `api_request_logs`**，不重复进事件流。

### 5.3 `scene` / `module` 推导的唯一真源

前端 `apps/web/src/analytics/sceneMap.ts`（pathname 正则 → `{module, scene, isStudyScene}`）是**唯一**真源。服务端**不维护第二份表**：拦截器需要 module 时由 **route 前缀**推导（服务端自己的路径，与前端无关）；对**客户端上报的语义事件**（§8.1 `/api/track/events`），只从请求体读 client 自报的 `module`/`scene` 并做**白名单校验**（非法 → NULL）。服务端权威事件（判题、发分、考试）由代码**显式传** module，从机制上消除两处漂移。

### 5.4 隐私分层：三道锁，缺一不可

1. **写时定 tier**：`events.service.ts` 的 `EVENT_TIER[event]` 是唯一真源；调用方**不能覆盖**；未登记 tier 的事件**直接拒写**（穷尽性类型，新增事件忘记登记会在编译期/启动时暴露）。
2. **查时硬过滤**：`parent-analytics.repo.ts` 所有查询硬编码 `AND tier = 'parent'`。
3. **守卫测试**：断言 `parent-analytics.repo.ts` 文件内容**不含** `hint_requested` / `answer_revealed` / `self_assess_answered` / `consecutive_failures` / `study_session_idle` 任一字符串（仿仓库既有的漂移守卫用例风格）。

家长端**只给中性「建议」结论**（如「本周在计算类知识点仍有未清零错题，建议巩固」），由后端基于 parent 层信号生成，**不暴露任何次数**。

---

## 6. 服务端打点

### 6.1 新增模块与文件

```
apps/server/src/modules/analytics/
  analytics.module.ts
  analytics.controller.ts          # /api/study-sessions/*, /api/track/*（student）
  admin-analytics.controller.ts    # /api/admin/analytics/*（admin）
  study-sessions.service.ts
  events.service.ts                # EVENT_TIER 字典 + record()
  telemetry.service.ts             # 各 repo 的薄封装
  telemetry-buffer.ts              # 纯缓冲实现（可单测）
  request-context.ts               # AsyncLocalStorage<RequestContext>
  mastery.service.ts
  dashboard/{overview,funnel,retention,quality,cost}.service.ts
apps/server/src/database/repositories/
  study-sessions.repo.ts, behavior-events.repo.ts, api-request-logs.repo.ts,
  llm-call-logs.repo.ts, special-practice-logs.repo.ts,
  student-knowledge-mastery.repo.ts   # ← 当前不存在，必须新建
  parent-analytics.repo.ts            # 只读，硬过滤 tier='parent'
apps/server/src/common/interceptors/analytics.interceptor.ts
apps/server/src/common/middleware/request-context.middleware.ts
apps/server/src/ai-core/infra/llm-call-log.ts   # LlmCallSink 单例（仿 model-config-registry 的全局单例法）
apps/server/src/scripts/seed-llm-prices.ts
```

**修改**：`app.module.ts`、`main.ts`（`enableShutdownHooks()` 以在退出时 flush buffer）、`ai-core/infra/model-client/index.ts`、`model-router.ts`、`model-config-registry.ts`、`ai-core/types.ts`、`database/repositories/llm-models.repo.ts`、`modules/admin/{admin-models.service.ts, admin.controller.ts, admin-chat.service.ts}`、`modules/practice/judge-core.service.ts`、`modules/training/{training.service.ts, meaning.service.ts, vocabulary.service.ts}`、`modules/points/points.service.ts`、`modules/exams/exams.service.ts`、`modules/parent-insights/{parent-insights.controller.ts, dto/parent-insights.dto.ts}`。

### 6.2 API 自动埋点（`AnalyticsInterceptor`）

- 注册：`app.module.ts` 的 `APP_INTERCEPTOR`，**排在 `ResponseInterceptor` 之后**（这样 `next.handle()` 包住业务与响应包装）。
- 身份：直接读 `req.user`（`AuthMiddleware` 已填充）；未登录 → `actor_role='anonymous'`。
- route 归一化：优先 `req.baseUrl + req.route?.path`（Express 路由模板，如 `/api/practice/:cardId/results`）；拿不到时对 `req.path` 做数字/UUID 段替换。
- `biz_code`：从响应体 `data?.code` 取；异常路径读 `exception.getResponse()`。
- **跳过名单**：`/api/admin/analytics/*`（自指噪音）、`/assets/*`、`/uploads/*`、`/api/track/events`（避免自指放大）。
- **绝不 `await` DB**：只 `telemetry.record(...)` 入内存 buffer。

### 6.3 `TelemetryBuffer`（纯类，可单测）

环形数组 `maxEntries = 5000`；`push()` O(1)；满则丢最旧并自增 `droppedCount`；`setInterval(2000).unref()` 定时 flush，或 `size >= 200` 立即 flush；flush 用 `pool.query` 拼多行 INSERT（占位符数量动态，**不能用 `execute`**）；整体 try/catch，失败整批丢弃并计数。`OnModuleDestroy` + `enableShutdownHooks()` 各 flush 一次（仍可能丢 < 2s，可接受）。

### 6.4 掌握度写回

新增 `MasteryService`，由 `PracticeModule` **只 provide 一次**并注入 `JudgeCoreService`——**勿在其它模块重复 provide**（会分裂状态，同 `ExplanationCacheService` 的教训）。挂载点：`judgeQuestion`（`:143`）、`judgeForPractice`（`:265`）、`recordSelfAssessment`（`:533`）。逻辑见 §4.8。

必测用例：空答案不写 / 无 KP 不写 / 对错各累加 / repo 抛错不冒泡。

### 6.5 `llm_call_logs` 写入点与归因传播

**写入点 = `ModelClient.chat()` 内部**（每次逻辑调用一行，每次重试尝试各一行，`attempt` 递增）。理由：所有 capability 最终都经 `ModelClient.chat` / `streamChat`；Router 只做选择（拿不到 tokens/latency/结果）；capability 有 14 个且会新增，逐个埋点必漏。

**归因传播（零改 14 个 capability）**：

1. `ai-core/types.ts` 两处类型改动：① `RoutedModel = ModelConfig & { apiKey?: string; scene?: Scene; subject?: Subject; isFallbackEntry?: boolean }`；② `ChatRequest` 增加 `meta?: { studentId?: number; scene?: Scene; subject?: Subject; dialogueId?: number; capability?: string }`（供后台路径显式归因，见第 4 条）。
2. `model-router.ts:39 route()` 给 `primary` 打 `scene`/`subject`，给 `fallback` 额外打 `isFallbackEntry: true`。
3. capability 原样把 `routeResult.primary | fallback` 放进 `ChatRequest.model` → `ModelClient` 直接读。
4. `student_id` / `request_id` 走 `AsyncLocalStorage`（`request-context.ts`）：`RequestContextMiddleware` 在入口 `als.run({requestId, studentId, role}, next)`。

   **`student_id` 不是「有则更好」而是硬要求** —— 它是「哪个学生最费 LLM / 用最多」这个分析的全部依据（用户明确要求，用于后续系统优化）。因此：

   - **HTTP 路径**：ALS 自动带出，无需改 capability。
   - **后台路径**（`ExplanationCacheService` fire-and-forget、title 生成等）：**必须显式传** `ChatRequest.meta: {studentId, scene, subject, dialogueId?, capability}`。取值来源现成——explanation 从被判题目的 `student_id` 取、title 从对话的 `student_id` 取。**不允许**以「ALS 可能丢上下文」为由留下 NULL。
   - **可观测**：把 `student_id IS NULL` 的占比作为指标（`llm_call_logs` 的**归属覆盖率**）暴露在 `/analytics/quality` 上。目标是「只有探活/系统任务这类真正无归属的调用落在 NULL」。有覆盖率的仪表盘，缺口不会被静默藏住。
   - **唯一允许 NULL 的情形**：`admin-chat`（管理员对话，无学生）、`routes/validate-connection` 探活、系统定时任务。
5. 后台复制 `ModelConfig` 的地方（探活、admin chat）不带这些字段 → `scene` 允许 NULL（已知限制，非缺陷）。

### 6.6 usage 修复（Phase 0 必做，否则成本永远算不出）

- `aggregateStream()` 不再硬编码 `{0,0,0}`：优先取 provider 流末个 chunk 的 usage——OpenAI 兼容端点请求体加 `stream_options: {include_usage: true}`（仅对该 provider 支持时下发）；拿不到则 `estimateTokens()` 兜底（CJK 按字、拉丁 char/4，**口径写在一处并加测试**）→ `usage_source = 'estimated'`；两者都无 → `usage_source = 'unavailable'`，tokens/cost 写 **NULL**。
- **输入与输出是独立的两个量，各用自己的数据源**：输入估自 `request.messages`（经 `contentToText` 兼容多模态），输出估自响应正文（含 reasoning）。**不要**把输入当输出的附属品、也不要因为「请求体已随流发送」就放弃输入估算——长 prompt 下输入往往是大头，漏掉会让成本严重低估。
- **绝不把「未知」写成 0**（与家长端 `answered = 0 → rate = null` 同一纪律）。`local` 模型价格真为 0 → cost 可写 0，但 `usage_source` 必须是 `provider`。
- 价格真源统一到 DB：`model-config-registry.ts:70` 改读 `llm_models` 的两个价格列；`scripts/seed-llm-prices.ts` 从 `model-routes.yaml` **幂等**回填；`admin-chat.service.ts:84` 的硬编码 0 一并消除。

---

## 7. 前端打点

### 7.1 新增文件

```
apps/web/src/analytics/
  tracker.ts         # track / startStudySession / heartbeat / endStudySession / flush / setEnabled / setTransport
  sceneMap.ts        # 路由正则 → {module, scene, isStudyScene}
  sessionMachine.ts  # 纯 reducer，可单测
  beacon.ts          # flush 传输实现
  types.ts
  AnalyticsShell.tsx
```

### 7.2 全局壳的落点（**不是 `App.tsx`**）

`App.tsx` 在 `RouterProvider` 之外，拿不到 `useLocation`。正确做法是改 `apps/web/src/routes/index.tsx:8`，包一层 **pathless wrapper route**：

```tsx
const router = createBrowserRouter([{ element: <AnalyticsShell />, children: routes }]);
```

`AnalyticsShell` 渲染 `<Outlet/>`，并承载：`useLocation()` 的路由变化副作用（起/止会话 + `page_view`）、`document.visibilitychange`、`window.pagehide`、心跳定时器。这样**同一个组件同时覆盖布局页与全屏沉浸页**（训练/考试/课程详情都不在 `StudentLayout` 下），也覆盖 `RequireRole` 之下的一切。`routeTable.tsx` **不改**（其测试继续 `createMemoryRouter(routes)` 挂真实表），`AnalyticsShell` 单独测试。

### 7.3 路由 → scene 映射（节选，最终以 `sceneMap.ts` 为准）

| pathname 正则 | module | scene | 开学习会话 |
|---|---|---|---|
| `^/student/course-detail` | mainline | course_detail | 是 |
| `^/student/auxiliary$` | aux_qna | aux_chat | 是 |
| `^/student/training/targeted/run` | training_targeted | targeted_run | 是 |
| `^/student/training/errors/run` | training_error_practice | error_run | 是 |
| `^/student/training/exam/run/` | exam | exam_run | 是 |
| `^/student/training/chinese/dictation/run` | chinese_dictation | dictation_run | 是 |
| `^/student/training/chinese/interpretation/run` | chinese_interpretation | interpretation_run | 是 |
| `^/student/training/chinese/meaning/run` | chinese_meaning | meaning_run | 是 |
| `^/student/training/english/vocabulary/run` | en_vocabulary | vocabulary_run | 是 |
| `^/student/(star-map\|subjects\|entry)` 及配置页 | mainline / — | star_map 等 | **否**（只 `page_view`） |
| `^/student/(profile\|rewards)` | — | profile / rewards | 否 |
| `^/parent/` | parent | parent_dashboard | 否 |
| `^/admin/` | admin | admin_dashboard | 否 |
| `^/(login\|register)$` | — | — | 否，完全不记 |

**配置页不算学习会话**——避免把「挑题 10 分钟」算成学习时长。`subject_id` 从 `useLearnContextStore` 取，不额外发请求。

**设备信息在 `startStudySession` 时一并上报**（一次性，不随心跳重复发）：`screen_class`（按视口宽度 + 宽高比分档，对齐 `UX-UI设计文档` 的 iPad 横屏主断点）、`input_type`（`matchMedia('(pointer: coarse)')` → `touch` / `mouse` / `hybrid`）、`app_shell`（`web` / `electron`）。这三项**只在会话开始时取一次**，会话中途转屏不改（一次会话代表一段连续学习，用哪块屏不重要）。`platform_class` / `browser` **不由前端上报**，由服务端从 `User-Agent` 解析，避免客户端伪造。

### 7.4 会话状态机

```
states: idle | active | hidden | ended
events: ROUTE_ENTER(studyScene) | ROUTE_LEAVE | VISIBLE | HIDDEN | IDLE_TIMEOUT | PAGEHIDE

idle    --ROUTE_ENTER-->  active   起会话 + 首次心跳
active  --IDLE_TIMEOUT--> hidden   idleMs=120s 无输入 → 发 state=hidden 心跳（暂停计时）
hidden  --输入/VISIBLE--> active   发 state=visible 心跳（恢复计时）
active  --HIDDEN-->       hidden   visibilitychange
hidden  --VISIBLE-->      active
active|hidden --ROUTE_LEAVE|PAGEHIDE--> ended   带 end_reason
```

- 用户活动检测：`pointerdown` / `keydown` / `scroll` / `touchstart`，节流 5s 更新 `lastInputAt`。
- idle 期间**仍定期发心跳**（`state=hidden`），让服务端知道会话没死、但不加时长。
- 学习页 A → 学习页 B：先 `end(A, route_change)` 再 `start(B)`。
- 心跳仅在 `active` / `hidden` 状态发送，间隔 30s。

### 7.5 批量与 pagehide 上报

`behavior_events` 走内存队列，flush 触发条件 = 10s 定时 / 队列 ≥ 20 / 路由离开 / 隐藏 / pagehide。传输**优先 `fetch('/api/track/events', {method:'POST', keepalive:true, headers:{Authorization}, body})`**——因为 `sendBeacon` **不能设 `Authorization` 头**。`sendBeacon` 只作 Phase 2 可选兜底（需专用端点 + body 内 token + 手工 verify JWT + 限流），v1 不做。`client_ts_ms` 仅参考，服务端 `created_at` 为准。

### 7.6 SSE / upload 绕开 `fetchApi` 的处理

`api.ts:504`(tutor stream) / `:568`(extraction) / `:800`(admin chat) / `:350`(upload) 都绕开 `fetchApi`，但**服务端拦截器已自动覆盖**这些 HTTP 端点（SSE 的 `latency_ms` = 整段流时长，`is_sse = 1`），所以 `api_request_logs` 不缺。前端只在**调用点**补业务事件：`ai_message_sent`（`hooks/useAuxChat.ts:233`、`hooks/useDiscussChat.ts:178`）、`answer_revealed`（看答案按钮）。**不改 `api.ts` 里的裸 fetch**——不给纯网络层塞业务语义。

### 7.7 被复用的既有收口点

答案提交：`components/business/answer/QuestionRunner.tsx:206`（主线/靶向/错题/考试共用）+ 专项各自提交点 `DictationRunPage.tsx:82`、`InterpretationRunPage.tsx:126`、`MeaningRunPage.tsx:94`、`VocabularyRunPage.tsx:114`、`CourseDetailPage.tsx:1081`。翻卡：`CourseDetailPage.tsx:447`、`VocabularyRunPage.tsx:102`、`QuestionRunner.tsx:191`。

家长端/管理端**不启动会话追踪**（`setEnabled` 按角色关闭），只记 `page_view`。

---

## 8. API 契约

约定：全局 `ResponseInterceptor` 自动包 `{code, message, data}`；新 `@Post` 默认 **201**（本仓无端点用 `@HttpCode` 覆盖）；家长端点第一行必须 `await parentService.requireOwnedStudent(user.sub, studentId)`（归属校验先于取数）。

### 8.1 采集端（student 角色）

| method | path | 入参 | 校验与逻辑 | 返回 |
|---|---|---|---|---|
| POST | `/api/study-sessions` | `{sessionUid, module, scene, subjectId?, refType?, refId?, screenClass?, inputType?, appShell?}` | `sessionUid` 必填 UUID；`module`/`scene` 白名单校验；`subjectId` 若给需属于该学生可选学科 → 否则 1001；`screenClass`/`inputType`/`appShell` 白名单校验（非法 → 存 NULL，不报错——设备信息是尽力而为）；`sessionUid` 重复 → **幂等返回已存在会话**（不报错，不新建）。`platform_class`/`browser` 由服务端从 `User-Agent` 解析后落库，**不接受客户端上报** | `{sessionUid, startedAt}` 201 |
| PATCH | `/api/study-sessions/:uid/heartbeat` | `{state:'visible'\|'hidden'}` | `state` 必填枚举 → 否则 1001；会话不存在 / 非本人 / 非 `active` → **静默 200 返回 `{activeSeconds: null}`**（不报错：心跳是尽力而为，报错会污染前端日志） | `{activeSeconds: number\|null}` |
| PATCH | `/api/study-sessions/:uid/end` | `{reason}` | `reason` 枚举校验；会话不存在 / 已结束 → 幂等返回现有值 | `{activeSeconds, endedAt}` |
| POST | `/api/track/events` | `{events:[{event, module?, scene?, subjectId?, refType?, refId?, sessionUid?, props?, clientTsMs?}]}` | 批量 ≤ 50 条，超出 → 1001；逐条校验：`event` 必须在 `EVENT_TIER` 字典内、且**必须属于 client 白名单**（防伪造 `answer_submitted` 等服务端权威事件）；`module`/`scene` 白名单；`props` 序列化后 ≤ 2KB | `{accepted, rejected}` 201（`rejected` 计数，不整体失败） |

`POST /api/track/beacon`（body 内 token、手工 verify JWT、限流）留 Phase 2 可选。

### 8.2 家长端新增（parent 角色，挂 `/api/parent`）

| path | query | 逻辑与边界 | 返回形状 |
|---|---|---|---|
| `/students/:id/study-time` | `from, to`（YYYY-MM-DD，缺省 = 近 7 天） | 只聚合 `status IN ('ended','abandoned')` 或已惰性收尾的会话；窗口由**应用层**算好传参（不用 `CURDATE()`，避免 DB 时区差一天） | `{totalSeconds, activeDays, byDay:[{date, seconds}], byModule:[{module, seconds}], bySubject:[{subjectId, seconds}], source:'sessions'}` |
| `/students/:id/today-usage` | — | `limitMinutes` 取 `controls.daily_time_limit_minutes`；为 NULL = 未设限 → `exceeded = false`；今日 = 应用层算好的本地日 | `{date, activeSeconds, limitMinutes\|null, exceeded, byModule:[{module, seconds}]}` |
| `/students/:id/specials` | `from, to` | 四模块各自聚合 `special_practice_logs`；**`rate` 沿用 `answered=0 → null`**（不许写 0） | `{dictation:{units,correct,rate\|null,byDay}, interpretation:{...}, meaning:{...}, vocabulary:{units,correct,rate\|null,newWords,byDay}}` |
| `/students/:id/mastery` | `limit`（默认 10，上限 50） | 按 `mastery_score ASC` 取最弱；**必须回 `coveredQuestions` / `totalQuestions` / `uncovered` 计数**（KP 只覆盖 203/529 题，不展示会让家长误以为只有这些薄弱点） | `{items:[{knowledgePointId,name,masteryScore,level,correctCount,errorCount,lastSeenAt}], coveredQuestions, totalQuestions, uncovered}` |
| `/students/:id/goals/attainment` | — | 读该学生 `goals`（`is_active=1`）；无目标 → 懒初始化默认目标；达成值来源按 `metric` 分派（`daily_study_minutes` ← `study_sessions`、`daily_words` ← `special_practice_logs`、`weekly_passages` ← `special_practice_logs`、`weekly_clear_errors` ← `main_error_books`） | `{items:[{metric, period, target, achieved, rate\|null}]}` |

**返回形状**：家长端点**不得**含任何 `tier='ops'` 派生字段；「建议」文案由后端生成中性结论。

### 8.3 运营端（admin 角色，`/api/admin/analytics`）

| method | path | query | 回答的问题 |
|---|---|---|---|
| GET | `/overview` | `from,to` | DAU/WAU、总时长、总答题、正确率、模块 Top |
| GET | `/funnel` | `module,from,to` | 各步人数/转化率、步间流失 |
| GET | `/retention` | `cohortStart,days` | 首次活跃分组的 D1/D7/D30 留存 |
| GET | `/modules` | `from,to` | 各模块使用/时长/正确率横向对比 |
| GET | `/cohort-compare` | `metric,outcome,from,to` | 分组对比；响应**必须带** `disclaimer: 'correlation-not-causation'` |
| GET | `/quality` | `from,to` | API 失败率/错误码分布、LLM 超时率/fallback 率、内容质量四指标 |
| GET | `/llm-cost` | `from,to,groupBy=scene\|model\|day\|student` | 成本/token 汇总与时序；`groupBy=student` 即「**哪个学生最费 LLM / 调用最多**」排行（用户明确要求的优化依据，见 §6.5）。`cost` 为 NULL 的计数单列为 `unpricedCalls`（**不许当 0 求和**）；同时返回 `attributed` / `unattributed` 调用数（归属覆盖率） |
| GET | `/llm-calls` | `from,to,scene,model,success,page` | 逐条调用排查（分页 20） |
| GET | `/events` | `event,module,from,to,page` | 行为事件流排查（**仅 ops tier**） |
| GET | `/requests` | `path,status,minLatency,from,to,page` | 慢接口 / 错误码排查 |
| GET | `/devices` | `from,to` | **大多数学生用什么设备学习**。返回三块：① **设备分布**按 `platform_class`（并列 `screen_class` / `input_type` / `app_shell` / `browser` 交叉表），指标 = `COUNT(DISTINCT student_id)`（**按人头，不按会话**——一个学生一天开 10 次会话只能算 1 人）+ `totalSeconds` + `accuracy` + `sessions`，用于回答「手机上是不是学得更短/更差」；② **多设备学生**：每学生 `COUNT(DISTINCT platform_class)` 的分档人数与占比；③ **设备切换**：相邻两段会话平台不同的次数与人次（见 §4.2「会话与设备的对应关系」） |

`/quality` 字段：`apiFailureRate`、`errorCodeDistribution`、`llmTimeoutRate`、`llmFallbackRate`、**`llmAttributionCoverage`（`llm_call_logs` 中 `student_id` 非空的占比，见 §6.5）**、`questionsWithoutStandardAnswer`、`kpCoverage:{covered,total,rate}`、`globalWordErrorRate:{wrong,total,rate}`（源 `english_words.error_count`）、`passageSkipRate`（抽中但未提交的篇目 / 抽中的篇目）。

### 8.4 现有端点形状变化（**触发 openapi + API 文档同步**）

| 端点 | 变化 |
|---|---|
| `GET /api/admin/models` | 每项新增 `inputPricePer1k` / `outputPricePer1k`（`admin-models.service.ts:24-30` 需带出新列） |
| `PATCH /api/admin/models/:modelKey` | `ModelSchema` / `ModelUpdateSchema` 增加两个 `z.number().nonnegative()` 字段 |
| `GET /api/admin/dashboard` | 可选加 `todayActiveStudents` / `todayLlmCost` |
| `GET /api/parent/dashboard` | **v1 不动**（避免破坏 `ParentDashboard` 契约；今日时长走独立 `/today-usage`） |
| `GET /api/parent/students/:id/reports` | **v1 不动**（保留 `weakPoints` 的代理语义） |

**文档落点**：`docs/API接口与数据流设计文档.md`（主稿）新增 §4.23 StudySessions+Track、§4.24 AdminAnalytics，§4.13 Parent 下补 5 个端点；§6 新增两条数据流 —— **§6.25 会话心跳 → 学习时长聚合**、**§6.26 LLM 调用 → 账本 → 成本**。`docs/api/openapi.yaml` 逐字段同步（本批端点即 MVP，一并进）。

---

## 9. 管理端 ops 仪表盘信息架构

沿用 `AdminLayout` + `AdminNav`（navItems 加项），新建 `apps/web/src/pages/admin/analytics/`：

| 路由 | 页面 | 回答 |
|---|---|---|
| `/admin/analytics` | `AnalyticsOverviewPage` | 今天/本周多少人学、学多久、答多少、正确率、最热模块 |
| `/admin/analytics/funnel` | `AnalyticsFunnelPage` | 各模块答题漏斗在哪一步掉人 |
| `/admin/analytics/retention` | `AnalyticsRetentionPage` | D1/D7/D30 留存（按首次活跃分组） |
| `/admin/analytics/modules` | `AnalyticsModulesPage` | 模块使用/时长/正确率对比 + 分组对比（标注「相关非因果」） |
| `/admin/analytics/quality` | `AnalyticsQualityPage` | 接口失败率、错误码分布、LLM 超时/fallback、内容质量四指标 |
| `/admin/analytics/llm-cost` | `AnalyticsLlmCostPage` | 按场景/模型/天/学生的 token 与成本 + `unpricedCalls`；**「最费 LLM 的学生」排行**（用于定位异常用量与做系统优化） |
| `/admin/analytics/devices` | `AnalyticsDevicesPage` | **大多数学生用什么设备学习**；各设备上的学习时长与正确率对比；多设备学生占比与设备切换（验证「iPad 横屏主断点」假设、决定要不要做移动端） |
| `/admin/analytics/events` | `AnalyticsEventsPage` | 原始事件 + 慢/错接口排查（v1 可推迟并入 quality） |

计费配置留在已有 `/admin/models`（`AdminModelsPage.tsx` 表单加两个价格输入）。图表复用既有的 `chart-theme.ts` + `ChartLine` / `ChartBar`（recharts，取色从最近的 `[data-theme]` 容器读）。

---

## 10. 家长端：新口径与旧口径**并存，不替换**

**这是本批最容易做错的地方。** 以下四条一行都不能改：

1. 旧「活跃」是 `practice_results ∪ point_ledger ∪ exam_sessions ∪ ai_messages` 的**四路时间戳代理**（`parent-insights.repo.ts:241`），新的「时长」只来自**显式会话**——两者数字会明显不同（孩子挂机不答题 = 旧口径不活跃，但如果页面开着会新口径有；反之亦然）。UI 必须**并列展示 + 区分文案**（如「学习时长（会话）」vs「活跃天数」），**不能悄悄换掉**让家长看到数字莫名下降。
2. 正确率 `answered = 0 → rate = null`，不是 0。
3. 错题列表**刻意不 JOIN** `question_knowledge_points`（41% 一题多 KP，JOIN 会让 `LIMIT` 作用在翻倍行上）→ 拆两条查询。
4. 「已开始学科」= `progress.status <> 'not_started'`（不是「有 progress 行」）。

另外：`weakPoints`（错题数**代理**）与新的 `mastery`（**真掌握度**）**两张卡并存**，标题必须不同、不得合并。

---

## 11. 数据量与性能

**假设（待确认）**：MVP 目标 < 10k 学生、DAU < 2k。按此估算单人/天：

| 表 | 单人/天 | DAU=2k | 累计 |
|---|---|---|---|
| `study_sessions` | 5–30 会话（心跳不落表，只 UPDATE） | 1–6 万 | 180 天：200 万–1000 万 |
| `special_practice_logs` | 20–80 | 4–16 万 | v1 永久保留；若量级超出本假设（> 3000 万），再按 §11 的时机引入 rollup 并改为保留 180 天原始行 |
| `behavior_events` | 50–200 | 10–40 万 | 180 天：2000 万–7000 万 |
| `api_request_logs` | 100–400 | 20–80 万 | 30 天滚动，峰值约 2000 万 |
| `llm_call_logs` | 20–80 | 4–16 万 | 400 天：700 万–3000 万 |

**索引策略**：每表 `(维度, created_at)` 复合索引 + `(created_at)`；`study_sessions` 额外 `(status, last_heartbeat_at)` 服务惰性收尾；**不给 `tier` 单独建低选择性索引**（复合 `(tier, created_at)` 才有效）。`LIMIT ?` 一律 `pool.query`（沿用 `parent-insights.repo.ts:530` 的坑）。

**何时上 rollup**：任一大盘查询 p95 > 500ms 或扫描 > 500 万行时引入 `daily_study_stats`（`UNIQUE(student_id, stat_date, module, subject_id)`，`subject_id` 用 `NOT NULL DEFAULT 0` 哨兵以免 NULL 破坏唯一性），夜间任务增量重建。**家长端单人查询永远走原始表**（有 `student_id` 前缀索引，天然快），不依赖 rollup，避免落后导致数字不一致。

**窗口计算**：`from`/`to` 由**应用层**算好传参（沿用 `point_ledger` 的既有约定，不用 `CURDATE()`）。大盘聚合可加进程内 60s 缓存（v1 可选，不做）。

**清理**：v1 不做分区。`api_request_logs` / `behavior_events` / `study_sessions` 用 `DELETE ... WHERE created_at < ?` 的定时任务；分区与 `DROP PARTITION` 留 Phase 3。注意 MySQL 要求分区键出现在**每个唯一键**（含主键）里——若日后给 `study_sessions` 分区需先放弃 `uniq_ss_uid`，因此该表**建议不分区**，用 DELETE 清理。

---

## 12. 分阶段实施

### Phase 0 — 地基与「钱」（成本报告的前置，必须先做）

1. 迁移 `2026-09-20_analytics_ledger.sql` + `schema.sql` 同步。
2. `llm-models.repo.ts` 映射价格；`model-config-registry.ts:70` 读真价；`scripts/seed-llm-prices.ts` 从 YAML 幂等回填。
3. `admin-models.service.ts` + `admin.controller.ts` + `AdminModelsPage.tsx` 支持编辑价格。
4. **修 `aggregateStream` 的 usage** + `stream_options.include_usage`（不修则成本面板全空）。
5. `ai-core/infra/llm-call-log.ts`（sink 单例）+ `ModelClient` 埋点 + `RoutedModel` 归因 + `request-context` ALS。
6. `AnalyticsInterceptor` + `TelemetryBuffer` → `api_request_logs`。
7. 修 `admin-chat.service.ts:84` 的硬编码 0。

**解锁**：`/admin/analytics/llm-cost`、`/admin/analytics/quality`（API 失败率 / LLM 兜底率）。

### Phase 1 — 家长「看得见」的赢（A + C，**不依赖 Phase 0，可并行**）

1. `study_sessions` 建表（迁移 `2026-09-21_study_sessions_events.sql`，**含 5 个设备画像列**）+ `StudySessionsService` + 采集端点 + 服务端 UA 粗分类工具。
2. 前端 `analytics/` 全套 + `routes/index.tsx` 包壳。
3. `special_practice_logs` 建表 + 三个专项判题点写入。
4. `student-knowledge-mastery.repo.ts`（新建）+ `MasteryService` + `JudgeCoreService` 挂载。
5. `goals` 加 `metric` 列 + 家长目标配置页（`/parent/goals` 从 Placeholder 变真页）。
6. 家长端点 5 个 + 家长页新卡片（`ParentDashboardPage` / `ParentReportPage`）。

**解锁**：家长端学习时长、每日趋势、专项卡、真薄弱点、今日已用时长、目标达成率。

### Phase 2 — Ops 产品面（B + D 的行为侧）

1. `behavior_events` 建表 + `EventsService`（字典/tier）+ 服务端事件挂载（判题、清零、发分、考试、专项）。
2. 前端显式事件（提示 / 看答案 / 翻卡 / 发消息 / 闲置）。
3. ops 聚合 service + 11 个端点（含 `/devices`）+ admin 分析页（含 `AnalyticsDevicesPage`）+ `AdminNav`。

> **设备列在 Phase 1 就建好并开始采集**（随 `study_sessions` 一起），但设备**报表**属运营面，放 Phase 2 —— 这样到 Phase 2 时已经有真实数据可看，不用等采满。

### Phase 3 — 规模与治理（非必须）

`daily_study_stats` rollup + 夜间任务、分区与 `DROP PARTITION`、prom-client 指标接入、beacon 兜底端点、大盘 60s 缓存。

---

## 13. 本批明确不做

- `homeworks` / `assessments` / `homework_submissions` / `assessment_submissions` 接线（整块产品面，属智能组卷批）。
- `variation_questions` / `knowledge_relations` / `safety_alerts` / `learning_reports` / `error_redo_logs` 的复活。
- `devices.last_active_at` / `progress.last_active_at` 接线。
- **A/B 实验框架**、归因模型、ML 预测。
- 家长端暴露任何 ops 信号或逐学生 LLM 成本。
- `daily_study_stats`（Phase 3）。
- `sendBeacon` 专用端点（Phase 2 可选）。
- 新增 LLM scene（埋点顺手加 scene 会牵动 8 处，本批不碰）。

---

## 14. 风险与陷阱

| # | 风险 | 说明与对策 |
|---|---|---|
| 1 | **生产 token 恒为 0** | `model-client/index.ts:64/99`：默认流式 + usage 硬编码 0。**Phase 0 第 4 步是成本功能的前置**，不修则账本与面板全 0 |
| 2 | **价格三处漂移** | YAML 真价 / DB 0（`model-config-registry.ts:70`）/ `admin-chat.service.ts:84` 硬编码 0 → 必须让 DB 成唯一真源 + seed 回填，否则新旧部署行为不一致 |
| 3 | **`cost` 的 0 vs NULL** | 本地模型真价 0 可写 0；无用量/无价必须写 **NULL**。UI 单列 `unpricedCalls`，**不能把 NULL 当 0 求和** |
| 4 | **流式 usage 可能拿不到** | Kimi 可能既不支持 `include_usage` 也不回 usage → 只能估算，`usage_source='estimated'` 必须可见；估算口径写一处并加测试 |
| 5 | **`model_key` vs `model_id` 混用** | `kimi` 的 key 是 `kimi`、modelId 是 `kimi-latest`；DeepSeek 只认 `deepseek-flash`/`deepseek-v4-pro`。聚合**按 key**，别按 model_id 关联 `llm_models` |
| 6 | **ALS 传播边界 → 已收紧为硬要求** | 后台生成类（explanation / title）**必须显式传 `meta.studentId`**，不许以「ALS 可能丢上下文」为由留 NULL；`student_id` 缺失率（归属覆盖率）要能在 `/analytics/quality` 上看到 |
| 7 | **复活死表的副作用** | `student_knowledge_mastery` 有 CASCADE 到 KP（删 KP 连带删掌握度）；写入是 UPSERT **非全量重算**，未来若加重算脚本必须复用同一公式常量 |
| 8 | **`goals` 语义变化** | 原表只有 `period`/`target_value`，加 `metric` 后需回填历史行，否则 NULL 语义要靠约定兜底 |
| 9 | **Nest DI 坑** | `@Injectable()` + **接口类型**的可选构造参数 → 必须 `@Optional()` 或显式 `@Inject(token)`，否则**启动直接失败** |
| 10 | **无迁移运行器** | 迁移必须幂等、手工 apply、`mysql --force` 禁用；新表/新列**必须同时**进 `schema.sql` |
| 11 | **心跳必须封顶** | 不封顶时「关标签 2 小时」会被算成 2 小时；封顶 45s + 乐观锁条件 `status='active'` |
| 12 | **埋点不得影响主链路** | 分析类日志走 buffer 且失败静默；业务数据直写但 catch；**任何埋点异常都不许让请求 500** |

---

## 15. 测试与文档同步义务

**必测用例**：

- 纯函数 / reducer：`sceneMap`（表驱动，覆盖每条正则）、`sessionMachine`（表驱动，覆盖 §7.4 全部迁移）、**UA 粗分类器**（表驱动：iPad / iPhone / Android 平板与手机 / Mac / Windows / Linux / Electron / 未知，并断言**同一 UA 只解析一次**的 memoize 生效）。
- 前端：`tracker`（`setTransport` 注入假传输 + `vi.useFakeTimers()` 推进心跳与 flush）、`AnalyticsShell`（`createMemoryRouter` + `Object.defineProperty(document,'visibilityState')` + `dispatchEvent(new Event('pagehide'))`，断言收到 start/heartbeat/end 与批量 events）、**设备上报只在 start 发生一次**（心跳不重复带设备字段）。
- 后端：`TelemetryBuffer`（满丢最旧 / flush 失败不抛 / 计数）、`MasteryService`（空答案不写 / 无 KP 不写 / 对错累加 / repo 抛错不冒泡）、`StudySessionsService`（心跳封顶 / 非本人不写 / 幂等 start / 设备字段白名单非法存 NULL / **Mac+touch → ipad 校正**）、usage 估算、**`llm_call_logs` 的 `student_id` 归属**（HTTP 路径自动带上；explanation / title 后台调用因显式传 `meta.studentId` 也带上；只有探活/管理员对话/系统任务为 NULL——用一条用例钉住「不许出现无归属的学习类调用」）、**`/analytics/devices` 按 `COUNT(DISTINCT student_id)` 聚合**（构造一个学生多会话的用例，断言不会被算重）、`parent-analytics.repo` 的**隐私守卫测试**。
- 每个新页面/组件补至少一条渲染测试（CLAUDE.md 硬规则，React #31 的教训）。
- `globals: false`：多用例文件必须自己 `afterEach(() => cleanup())`，并复位模块级 Zustand 单例。

**回归**：`apps/server` `npm test`（现 1166）+ `apps/web` `npm test`（现 573）全绿。起服务用 `node dist/main.js`（`tsx` 的 DI 是坏的）；冒烟用**独立端口 + 按 PID 收尾**，**别 `pkill -f 'node dist/main.js'`**。

**已知既有问题（与本批无关，别算到新改动头上）**：`routes/routeTable.test.tsx` 里「主轨侧边导航不含辅轨入口」那条在 **18:00–06:00 跑必红**（`StudentLayout` 挂载时 `autoToggleNightMode()` 按挂钟切 `data-theme`）。修法见待办清单 §3.3 第 6 项。

**文档同步**：§8.4 是硬清单；另需同步 `docs/K12智学系统-数据库设计文档.md`（新表/新列）与 `docs/ai-core-changelog.md`（本批完成后追加一条）；根 `CLAUDE.md` 的「独立子系统」「工程约定」节按需补一条（埋点的两条写入纪律与隐私三道锁）。

---

## 16. 开放问题（待确认，不影响开工）

> **已拍板（评审时确认，原 Open Q1）**：`llm_call_logs` **一定**带 `student_id` —— 用户要求「能统计出哪个学生用的 LLM 最多，据此做系统优化」。落地要求见 §6.5 第 4 条（HTTP 走 ALS、后台必须显式传 `meta.studentId`、NULL 只允许探活/管理员/系统任务，并暴露归属覆盖率）。仅 ops 可见。

| # | 问题 | 当前取用的默认 |
|---|---|---|
| 1 | 心跳参数（30s / 封顶 45s / idle 120s / 5min 惰性收尾）是否符合对「学习时长」的产品预期？ | 按此默认，放服务端常量一处可调 |
| 2 | `api_request_logs` 是否保留 `raw_path` / `client_ts_ms`（可识别信息）？ | 保留，30 天清理；若要最小化可只留归一化 route |
| 3 | ops 分析端点是否进 openapi？ | **进**（本批实现即 MVP） |
| 4 | `study_sessions` 180 天后折 rollup 还是直接删？ | 折 rollup（Phase 3 建）；若不需跨年趋势，直接删更省 |
| 5 | `goals.metric` 的取值集合是否就是这四种（`daily_study_minutes` / `daily_words` / `weekly_passages` / `weekly_clear_errors`）？ | 按此默认 |
| 6 | 数据量假设（< 10k 学生 / DAU < 2k）是否成立？ | 按此设计；若量级更高，Phase 3 的 rollup 与分区需提前 |
