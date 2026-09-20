# 家长端「管得住」批（行为管控 P6.6 / 异常预警中心 P6.9 / 账号设置 P6.10）· 设计

日期：2026-09-20
状态：**待实施**（Task 0 标记验证门已通过 3/3 → 方案 A，2026-09-20；见 §3.2）
相关：`docs/K12智学系统-产品需求文档.md` §7.7（第 203 / 206 / 223 行）、`docs/UX-UI设计文档.md` §P6.6 / §P6.9 / §P6.10、`docs/API接口与数据流设计文档.md` §4.13 / §7、`docs/api/openapi.yaml`、`apps/server/src/modules/parent-insights/`、`apps/server/src/ai-core/`、`apps/web/src/pages/parent/`
上游：`docs/superpowers/specs/2026-09-18-parent-insights-design.md`（§1.1 把本批列为「管得住」批）、`docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md`（心跳与 `study_sessions` 的来源）

---

## 1. 定位与边界

家长控制台的第三批：把「家长能否管住、能否第一时间知道」这条链打通。三个页面从 `Placeholder` 变成真实页，并让 `safety_alerts` 从死表变成有真实写入的预警闭环。

**页面与链路**：

```
P6.6 行为管控（设灵敏度） ─┐
                          ├─→ controls.alert_away_minutes / alert_idle_minutes
P6.9 异常预警中心（看预警）←─┴─← safety_alerts（闲聊 / 情绪 / 敏感 / 走神）
P6.10 账号设置（账号信息 + 改密码 + 退出）
```

### 1.1 用户裁决记录（2026-09-20，实施时不得推翻）

需求沟通中发现**用户把 P6.6 与 P6.9 混淆了**，且混淆有道理——他描述的两件事恰好是 UX §P6.9 已列的预警类型：

| 用户原话 | 实际归属 | 原文出处 |
|---|---|---|
| 「学生与 AI 聊无关学习的内容时给家长报警」 | **P6.9**「闲聊频繁」 | PRD 206、PRD 223（§7.9）、UX §P6.9 |
| 「学生登录着但一直没有任何操作…都应该给家长告警」 | **P6.9**「长时间无学习」 | UX §P6.9 预警类型第 4 条 |
| 「每日使用时长、禁用时段、开关」 | **P6.6**（提前设限，非事后告警） | UX §P6.6（全文仅三行） |

据此逐项裁决（理由一并记录，避免以后被当成漏做）：

| # | 裁决 | 理由（用户原话/依据） |
|---|---|---|
| 1 | 范围 = P6.6 + P6.9 + P6.10，一批交付；P6.10 只做「账号信息只读 + 修改密码 + 退出登录」 | 用户选择「两页都做，一批交付」；P6.10 由用户选定「只做这三项」 |
| 2 | 预警**只写 `safety_alerts`**，不写 `parent_messages` | 站内信表**无 `student_id`**，多孩家庭分不清是哪个孩子；`safety_alerts` 天生带 `student_id`/`level`/`context`/`dialogue_id` |
| 3 | 闲聊判定**由模型自报标记**，不再靠关键词正则 | 用户提出：「在提示词中已经说了…通过这个 LLM 的回复不就可以判断了吗（可以让 AI 回一个特定标记）」 |
| 4 | 闲聊**不硬拦**，交给模型温和引导 | 用户选择「交给模型温和引导」；且硬阻断正是误伤语文题的元凶（见 §2.1） |
| 5 | 走神信号**分开记**「页面被切走」与「前台无操作」，**两类都报** | 用户选择「分开记，两类都报」 |
| 6 | 等待时长**家长可调，不写死** | 用户明确要求：「报警时间可设置，不要写死，家长可以根据孩子习惯调整等待时长」 |
| 7 | **每日最大使用时长、禁用时段：本批不做**，页面上也不出现 | 用户原话：「这个目前没什么用。等以后有需要的时候再增加」 |
| 8 | **辅线访问开关：撤掉** | 用户原话：「不要隐藏辅学系统，这是过度设计，辅学系统就应该一直有。而且我们用的是启发式引导回答，学生一般不会用这个问其它问题」 |
| 9 | **拍照解题开关：撤掉** | 辅线一直可用，拍照也一直可用 |
| 10 | `ai.service.ts:153` 的 TODO **保留不删**；`controls` 的 `alert_level` / `auxiliary_enabled` / `photo_search_enabled` 三列**保留、不标废弃** | 用户原话：「这个不要删呀，先留着，等以后可能还有用」 |

### 1.2 与 UX §P6.6 的偏差（必须写进文档）

UX §P6.6 全文只有三行：

```
- 每日最大使用时长（小时滑块）
- 禁用时段（多段时间窗）
- 开关：奖励兑换、辅线访问、拍照解题
```

按上表裁决 7/8/9，**四项不做**（每日时长、禁用时段、辅线开关、拍照开关），奖励兑换已有独立归属（奖励管理页）。因此本批 P6.6 页的实际内容为：

| P6.6 页内容 | 性质 |
|---|---|
| 预警灵敏度（切走 / 无操作两个等待时长 + 宽松/标准/严格预设） | 本页主体，新增 |
| 奖励兑换：已开启/已关闭（只读 + 跳转奖励管理页） | 既有功能的只读入口 |

**这是裁决导致的，不是漏做。** 该偏差与上表一并写进 API 文档与 UX 文档的相关批注。

### 1.3 本批明确不做（后续批次）

| 项 | 归属 |
|---|---|
| 每日最大使用时长 / 禁用时段的学生端强制 | 用户裁决暂不做；需要时单独立项 |
| 辅线访问 / 拍照解题门禁 | 用户裁决不做；`ai.service.ts:153` TODO 与 `controls` 相关列保留待用 |
| 订阅 / 订单 / 优惠券 / 额度（P7.1–P7.3） | 独立 spec（连表都没有）；本批**不放假卡** |
| 家长改手机号 / 改姓名 | PRD 无要求，本批不做 |
| 实时推送（WebSocket / SSE / 短信） | 全仓无基础设施；本批走「打开页面拉取」 |
| 小窗口覆盖检测、「家长来了切回来」检测 | 见 §9 已知限制，技术上测不到 |
| 「连续多课兜底触发」（UX §P6.9 第 3 类预警） | 需新聚合，且与训练轨耦合；本批不做 |
| 学生端行为管控拦截层 | 无内容可拦（§1.2），不做 |

---

## 2. 调研结论（决定了本批的全部技术选择）

### 2.1 闲聊分类器不可用（实测）

`apps/server/src/ai-core/infra/safety-guard.ts` 的 `classifyByKeywords` 是**纯正则**，判定顺序为：

1. 命中 `LEARNING_PATTERNS`（`:16-40`，约 40 个以数学为中心的词）→ `learning`
2. 命中 8 个 anomaly 正则（`:133-136`）→ `anomaly`
3. **否则一律 `off_topic`**（`:142`，confidence 0.6）

**实测 12 句（2026-09-20，逐条比对 `:16-40` 与 `:133-136`）**：

| 输入 | 判定 | 是否合理 |
|---|---|---|
| 这道题第三步为什么是减号 | learning | ✓ |
| 什么是勾股定理 | learning | ✓ |
| 3x+5=14 | learning | ✓ |
| 下列加点字解释正确的一项是 | learning | ✓ |
| **这首诗表达了什么情感** | **off_topic** | ✗ 语文理解题 |
| **作者写这句的用意是什么** | **off_topic** | ✗ |
| **这段文字的修辞手法分析一下** | **off_topic** | ✗ |
| **请概括文章第二段的主要内容** | **off_topic** | ✗ |
| **翻译一下这句文言文** | **off_topic** | ✗ |
| **背诵全文** | **off_topic** | ✗ |
| 今天天气真好，想出去玩 | off_topic | ✓ |
| 你喜欢什么游戏 | off_topic | ✓ |

**6/12 正常学习问题被判「闲聊」。** 这不是新 bug——辅线被显式豁免（`:65-72`）的注释给的理由正是这件事：

> Auxiliary (free-exploration) track supports all K12 subjects. Its keyword classifier is math-centric, so non-math subjects (语文/物理/英语…) and image captions would be false-positive off_topic.

即前人踩过这个坑，用「辅线全放行」来绕。**但主线没有豁免**，所以语文/英语类提问在主线会被真阻断（`shouldBlock` → `:323-343` 短路返回「请专注于学习内容」）。

**结论：把这样一个分类器接上「给家长告警」不可接受**——家长会收到大量「孩子在看语文」的假警报，而误报比漏报更伤信任，且家长无法分辨。

### 2.2 模型自报标记的管道已经存在

- 辅导提示词要求模型在回复后另起一行输出结构化 JSON 块（`prompts/tutoring/math/auxiliary.md:61-69`）。
- `capabilities/tutoring.capability.ts:196-201`：流结束后 `parseContent` 抽取该块、剥离，并 `yield { type:'content', delta: finalContent, replace: true }`，前端据此**整体替换**已流出的内容。
- `parseContent` 定义在 `:389-402`，调用点 `:91`、`:197`。
- ⚠️ 但提示词规定结构化题目块**仅在实际辅导某道题时输出**（`auxiliary.md:66`），纯闲聊轮次不输出 → **标记不能寄生在那个块里**，需独立机制。

**`safety.yaml` 与 `prompts/safety/classifier.md` 是被搁置的另一条路**：`safety.yaml` 声明了 `classifier.model: deepseek-flash` + `confidenceThreshold: 0.7`，**全仓无代码读它**；`classifier.md` 是一份完整的 LLM 分类器提示词（输出 `{"classification":"learning"|"off_topic"|"anomaly","confidence":...,"reason":...}`），从未接线。→ 作为方案 B 备用。

**`alertPayload` 从未被消费**：`safety-guard.ts:98-104` / `:118-124` 构造了 `SafetyAlert` 对象，但全仓无读取方；唯一调用点只用了 `alertLevel`（`tutoring.capability.ts:338`）。本批是它**第一次**被消费——但只有 anomaly 那一支（`:118-124`）会留下，off_topic 那一支（`:98-104`）随该分支一并删除（§3.1）。

### 2.3 走神信号：两类混在一起

| 事实 | 位置 |
|---|---|
| 心跳 30s；无输入 120s 判 idle；idle 轮询 5s | `apps/web/src/analytics/tracker.ts:22,23,25` |
| 监听 `visibilitychange` / `pagehide` / `pointerdown` / `keydown` / `scroll` / `touchstart` | `analytics/AnalyticsShell.tsx:46-66` |
| **未监听** `mousemove` / `focus` / `blur` / `resize` | 同上（缺口） |
| `active --IDLE_TIMEOUT--> hidden` 与 `active --HIDDEN--> hidden` **合并成同一个 `hidden`，原因丢失** | `analytics/sessionMachine.ts:48-51` |
| 服务端累加：仅当**上一次** `client_state='visible'` 才累加，每次上限 45s，服务端权威 | `database/repositories/study-sessions.repo.ts:124-150` |
| hidden 期间**心跳继续发**，所以 `last_heartbeat_at` 保持新鲜、`closeStale` 不误收尾，而 `active_seconds` 停止增长 | `tracker.ts:240-249` |
| `end_reason` 的 `idle_timeout` / `hidden_timeout` **声明了但从未发出** | `analytics/types.ts:61` 是唯一出现处 |

**结论**：挂机时长这个数**已经有**（`墙钟 - active_seconds`），但「切走」与「前台发呆」**在数据里分不开**，必须改采集（§3.3）。

### 2.4 预警表与投递现状

| 资产 | 状态 |
|---|---|
| `safety_alerts` 表（`tools/db/schema.sql:803-822`） | ✅ 结构齐备：`student_id`/`parent_id`/`type`/`level`/`message`/`context`/`dialogue_id`/`message_id`/`is_read`/`read_at`；索引 `idx_sa_parent_unread(parent_id,is_read)`、`idx_sa_student(student_id)`；4 个 FK |
| `safety-alerts.repo.ts` | ✅ `create` / `findByParent` / `markRead`，但**未在任何 module 注册、零注入** |
| `dashboard.service.ts:85,90` | ❌ `unreadAlerts: 0` **硬编码**，且有测试断言它恒为 0（`dashboard.service.test.ts:179-183`） |
| `ParentLayout.tsx:32` | ❌ `const hasAlert = true;` + `:41-52` 假标题「检测到孩子今日 3 次闲聊偏离学习」，CTA **无 onClick** |
| `ParentNav.tsx` | ❌ 10 项里**没有「异常预警」入口**；`routeTable.tsx:334` `/parent/alerts` 是 `Placeholder` |
| `parent_messages`（唯一的真投递通道） | ✅ 家长端铃铛 + 未读数可用（`ParentLayout.tsx:20-30,60-76`）；但唯一写入者是管理台手动群发（`admin-messages.service.ts:24`），**无 `student_id`** |
| 调度器 / WebSocket / 短信 | ❌ **全仓皆无**（`apps/server/package.json` 无 `@nestjs/schedule` / `socket.io` / `ws`） |

### 2.5 `controls` 表与仓储现状

- 列（`tools/db/schema.sql:861-877`）：`student_id`、`daily_time_limit_minutes`、`disabled_hours`、`reward_redemption_enabled`(默认1)、`points_per_yuan`(默认20)、`auxiliary_enabled`(默认1)、`photo_search_enabled`(默认1)、`alert_level`(默认 `'standard'`)、`break_reminder_minutes`、时间戳；唯一键 `uniq_controls_student`；FK → `students`。
- `controls.repo.ts`：`ensure` / `findByStudent`（只 SELECT 两列）/ `findDailyTimeLimit` / `update`（**白名单只有 `pointsPerYuan`、`rewardRedemptionEnabled`**）。
- **唯一写入方**是 `parent-points.controller.ts:255` `PUT students/:id/points/settings`。
- `daily_time_limit_minutes` 无写入方（`controls.repo.ts:74-76` 注释已说明恒 NULL）；`disabled_hours` / `alert_level` / `break_reminder_minutes` / `photo_search_enabled` **零代码读**；`auxiliary_enabled` 只出现在 `ai.service.ts:153` 的**过时 TODO**（注释说仓储未建，实际早已建好）。
- **「开关真生效」的现成范例**：`points/redemption.service.ts:198-202` —— `ensure` → `findByStudent` → 关闭时 `BadRequestException({ code: 3004 })`。

### 2.6 家长账号现状

| 项 | 状态 |
|---|---|
| `POST /api/auth/login`、`POST /api/auth/register` | ✅ 仅此两个（`auth.controller.ts:21,29`）；**无 logout、无 refresh** |
| 密码哈希 | bcrypt cost 10（`auth.service.ts:77`） |
| JWT | `expiresIn: '7d'`，secret 来自 `JWT_SECRET`（`auth.module.ts:11-14`） |
| 家长改**自己**密码 | ❌ **端点不存在**；`parents.repo.ts` **无 `updatePassword`** |
| 管理员改自己密码 | ✅ `PATCH /api/admin/password`（`admin.controller.ts:58-66` + `admin-dashboard.service.ts:38-47`，含旧密码校验）→ **本批照抄** |
| 家长重置**孩子**密码 | ✅ `PATCH /api/parent/students/:id/reset-password`（`parent.controller.ts:50-59`） |
| `GET /api/parent/account` | ❌ **未实现**（API 文档 `:335` 标 MVP、openapi `:2993` + `ParentAccount` schema `:7398` 已有）→ 典型「文档先于代码」 |
| 前端参照 | `pages/admin/AdminSecurityPage.tsx`（旧/新/确认三段密码表单 + toast） |

### 2.7 文档漂移（本批一并修）

| 漂移 | 位置 |
|---|---|
| `Alert.type` 枚举两套对不上：openapi 是 `chat_off_topic/anomaly/quota_warning/goal_reminder`，代码是 `off_topic/emotional/sensitive/abusive` | `openapi.yaml:6971` vs `database/repositories/types.ts:82` |
| `Controls` schema 缺 `pointsPerYuan`，且用 camelCase 的 `dailyTimeLimit`/`disabledHours` | `openapi.yaml:6941-6960` |
| `ParentAccount` schema 引用了**不存在的** subscription / AIQuota | `openapi.yaml:7398-7414` |
| 四个路径**有契约无实现**：`/parent/students/{id}/controls`、`/parent/alerts`、`/parent/alerts/{id}/read`、`/parent/account` | `openapi.yaml:2885,2956,2975,2993`；API 文档 `:330-335` 标 MVP |

---

## 3. 设计

### 3.1 三条预警链路

| `type` | 产生点 | 判定方式 | `level` |
|---|---|---|---|
| `off_topic`（闲聊） | 辅导链路 | 模型自报标记（§3.2） | `warning`（每次发生即报，30 分钟去重；见 §9） |
| `emotional` / `sensitive` | 辅导链路 | 现有 8 个低误报正则（**保留不动**） | `warning` / `critical`（沿用既有硬编码规则） |
| `away` / `idle`（走神） | 心跳链路 | 分开累计两类挂机时长，各自到家长设定阈值 | `info` |

**写入落点（两个入口共用，必须都覆盖）**：`tutoring.capability.ts` 有两个入口 `tutor()`（`:75`）与 `tutorStream()`（`:121`），它们共用私有方法 `prepare()`（`:241`，安全判定在其内 `:315-343`）：

| 信号 | 写入落点 |
|---|---|
| `emotional` / `sensitive` | `prepare()` 里 `safetyResult` 可用处（`alertPayload` 在这里被消费）—— 一处即覆盖两个入口 |
| `off_topic` | `parseContent()`（`:389-402`）返回 `offTopic: boolean`，由 `tutor()`（`:91` 之后）与 `tutorStream()`（`:197` 之后）**各调用一次**共享的私有方法 `recordSafetySignals(...)` |

`recordSafetySignals` 以 `void` 调用（不 `await`），内部整段 try/catch —— 符合 `CLAUDE.md` 的「埋点写入永不阻断主链路」。

**行为变化**：

- **删掉 `off_topic` 的硬阻断**（`shouldBlock` 短路）。闲聊由模型温和引导；服务端只记录 + 报警。→ 顺带修掉「语文题被误判阻断」的既有 bug。
- **anomaly（情绪/敏感）的阻断行为保持不变**（继续 `shouldBlock` + `blockResponse`）。
- 学生端**零入口隐藏、零拦截层**（§1.3）。

### 3.2 闲聊判定：模型自报标记（方案 A，带阻塞验证门）

**标记格式**：`<!--topic:off-->`

- **只在模型判定为「与 K12 学习无关」时输出**；判定为学习相关时**不输出任何标记**。
- 必须出现在**回复的最后一行、独占一行、前后无其他字符**。
- 选 HTML 注释形式而非 JSON 的理由：学生端 markdown 管道含 `rehype-raw`（见 `CLAUDE.md` 的 Markdown 渲染器约定），HTML 注释渲染为**不可见**，不像现有 JSON 块那样会在流式过程中闪现给学生。

**服务端处理**：在 `parseContent`（`tutoring.capability.ts:389-402`）中检测并剥离，返回 `offTopic: boolean`；两个入口据此写 `safety_alerts(type='off_topic')`（落点见 §3.1 的表）。

**检测规则（精确口径，2026-09-20 Task 5 收紧后）**：`offTopic = true` **当且仅当**「标记独占**最后一个非空行**」—— 取 `content.trimEnd()` 的最后一行做全等匹配（该行除标记外只允许前后空白）。因此：
- 标记独占一行但**在正文中段**（其后还有正文）→ **不**判闲聊；
- 标记**夹在句子中间**（非独占一行，如 `……<!--topic:off-->……`）→ **不**判闲聊。
> 旧实现的正则带 `m` 但不锚定末尾，任何独占一行的标记都会判闲聊 —— 比本节要求**宽**，属静默偏离，已收紧。**位置之外的宽松点**：剥离是**另一条规则**（见下），它不看位置，因此正文中段独占一行的标记仍会被**剥离**（但**不**判闲聊）。

**剥离规则**：凡是**独占一行**的标记一律删掉（**不管它在第几行**），保证「标记永不进学生可见内容与历史」（§3.2 的核心要求）。夹在句子中间的（非独占一行）不匹配、保持原样。实现用**全局**替换（`replace` 带 `g`）并去掉首尾多余换行 —— 模型若写了两遍标记，两处都要清掉（只去第一处会让第二处残留进学生可见内容）。换行**同时容忍 LF 与 CRLF**（`\r?\n`）：检测走 `trimEnd()`（`\r` 属空白，故能认 CRLF 的末行），剥离必须与之**口径对称**，否则模型若用 CRLF 换行会「判了闲聊却剥不掉」、标记泄漏进学生可见内容与持久化历史（Task 5 fix wave 2 修的回归）。删标记时**保留原有行尾风格**（不把 CRLF 打成 LF），也不合并相邻两行。

**⚠️ 必须同时回写 `ai_messages.safety_flag`（否则会打坏既有功能）**：**改动前** `safety_flag` 的唯一来源是「助手回复的 `type === 'block'`」（`services/conversation/index.ts:152`、`modules/conversations/conversations.service.ts:207`）。闲聊不再硬阻断 ⇒ 不再有 `block` 消息 ⇒ **`safety_flag` 将永远是 0，家长端「对话回放」页的「闲聊/偏离学习」标签与「闲聊 N」计数会全部归零**（`parent-insights.repo.ts:673` 的 `block_count`、`ParentChatLogsPage.tsx:66,410`）。

因此：给 `saveMessages` 的消息对象加**可选** `safetyFlag?: boolean`，取值规则改为 `Number(msg.safetyFlag ?? (msg.type === 'block' ? 1 : 0))`；两条入口保存 assistant 消息时传 `safetyFlag: offTopic`。

> **⚠️ 外层 `Number(...)` 必需，别当多余代码删掉**（Task 5 实现时踩过）：`safetyFlag` 是 `boolean`，`??` 会**原样返回它**（`true` 而非 `1`），而 `ai_messages.safety_flag` / `safety_alerts` 的列类型是 INT。**`tsc` 不报这个错** —— `AiMessageRow extends RowDataPacket` 带 `[column: string]: any` 索引签名（`types.ts:26`），而 `createMany` 的入参是 `Omit<AiMessageRow, …>`；`Omit` 用 `keyof`（被索引签名撑成 `string | number`）把具名属性**全部抹成 `any`**，于是类型检查不再约束 `safety_flag`。不加 `Number(...)` 的后果：单测断言 `= 1` 直接红，且真库里靠 mysql2 转义把 `true` 写进 INT 列。**本 spec 这一处是设计真源，plan Step 3 与两处实现（`services/conversation/index.ts`、`modules/conversations/conversations.service.ts`）都必须与之逐处一致**（Task 5 fix wave 2 发现本行曾被漏改、留下未包 `Number` 的版本）。

**⚠️ 删掉硬阻断后 `safety_flag = 1` 变成「双来源」（用户 2026-09-20 裁决）**：① 模型自报标记（闲聊）；② `type === 'block'`（**现在只剩 anomaly**：情绪/敏感）。两类**都计入**——它们都属于「偏离学习」。因此家长端文案**从「闲聊」改成「偏离学习」**（`ParentChatLogsPage.tsx:66` 的标签、`:410` 的 `闲聊 N` 计数，以及 `services/api.ts:2338` 的注释），否则情绪/敏感轮次会被误标成闲聊。这样「对话回放」的口径从「被阻断的轮次」变成「被判闲聊**或**被阻断的轮次」——**更准确**，但**语义有变**，必须写进 §8 的文档同步与 §9 的限制。

**响应里的 `safety` 字段本批不动**：`tutor()` 返回的 `safety: { isLearningRelated, alertLevel }` 在学生端**只有类型声明、从不被读取**（`apps/web/src/services/api.ts:468` 是全仓唯一出现处），所以闲聊不再阻断不会带来学生端连带影响，本批**不新增任何学生端提示**（不让学生知道自己被标记）。

**兜底原则（关键）**：**没有标记 = 不报警**。模型的失败模式因此是**漏报**而非误报，符合「宁漏勿误报」。

**⚠️ 阻塞验证门（Task 0，必须先做且必须通过）**：

1. 改 `prompts/tutoring/math/auxiliary.md` 与 `mainline.md` 加入标记指令；
2. `npm run build`（server）+ 独立端口 `node dist/main.js` 起后端，用 **3 条真实样本**走辅线：
   - ① 一条数学题（期望**无**标记）
   - ② 一条语文理解题「这首诗表达了什么情感」（期望**无**标记 —— 这正是现状会误判的那类）
   - ③ 一条闲聊「你喜欢什么游戏」（期望**有**标记）
3. 判定：**3/3 符合预期** → 采用方案 A；**否则** → 切**方案 B**。
4. 同时核对辅导质量无退化（回复仍自然、无多余元信息、不解释该标记）。

**✅ 验证结果（2026-09-20，已通过 → 采用方案 A）**

用新增的手工 eval 脚本 `npx tsx src/ai-core/__tests__/off-topic-marker.ts`（仿 `tutoring-quality.ts`：内存 fake 仓储 + 真模型，辅线 track、`subject=math`）跑 3 条真实样本，**3/3 符合预期**：

| 样本 | 学生消息 | 期望 | 实测 | 结果 |
|---|---|---|---|---|
| ① 数学题 | 3x + 5 = 14，x 等于多少？ | 无标记 | 无标记 | ✅ |
| ② 语文理解题 | 这首诗表达了什么情感？ | 无标记 | 无标记 | ✅ |
| ③ 闲聊 | 你喜欢什么游戏？ | 有标记 | 有标记，且**独占最后一行**（`trim() === '<!--topic:off-->'`） | ✅ |

走的是 `tutoring/math/auxiliary.md`（辅线只有 math 一套模板、全学科共用），路由 `qwen3.8-max`。

**质量核对**：三条回复均自然、无多余元信息、未解释该标记；样本③是「我更喜欢和你一起玩学习里的『闯关游戏』呀…」——温和引导，符合 §1.1 裁决 4（不硬拦）。**无退化。**

**⚠️ 实测同时确认**：现有 `parseContent` **不剥离**该标记（标记原样留在 `content` 里）→ §3.1/§3.2 的剥离改造是**必需**的；即便漏剥，因标记是 HTML 注释、学生端 markdown 管道含 `rehype-raw`，仍不可见（§3.2 的选型理由）。

**方案 B（仅当验证门不通过时启用）**：新建 LLM 场景做**并行**分类调用——复用已写好的 `prompts/safety/classifier.md`，启用 `safety.yaml` 里已声明的 `classifier.model`，与辅导调用**并行发出**（不增加学生等待时间）。注意：**新增 LLM 场景需同步改 8 处**（见 `CLAUDE.md`）。

### 3.3 走神采集改造

**目标**：把「页面被切走」与「前台无操作」分开记，并知道**当前这一挂机段连续了多久**。

**⚠️ 先读这段：两个「分钟数」不是一回事（最易误解，实施与验收都按这个口径）**

| 数 | 值 | 谁定 | 作用 |
|---|---|---|---|
| 前端空闲判定阈值 | **120 秒，写死**（`tracker.ts:23` 的 `IDLE_TIMEOUT_MS`） | 代码常量；**本批不接入家长配置** | 决定客户端状态机**多久**从 `active` 翻成 `hidden` |
| `controls.alert_idle_minutes` | 默认 15，家长可调 1..180 | 家长 | 决定翻成 `hidden` **之后**连续挂机多久写一条 `idle` 预警 |

两者**相加**才是家长感知的「孩子多久没操作会收到预警」：默认档 15 分钟 ⇒ 距最后一次操作约 **17 分钟**报警。验收「改阈值真的生效」（§7.4 第 5 条）必须按这个口径算，别把 15 分钟当成「无操作 15 分钟」。

**「有操作 / 无操作」的判定口径**：客户端在 **`window`** 上挂监听（`AnalyticsShell.tsx:46-66`），事件冒泡即可命中，**无需**监听具体输入元素。

| 算「有操作」（刷新 `lastInputAt`，把 120 秒计时推后） | 不算（§2.3 的既有缺口，本批不补） |
|---|---|
| `keydown` —— 打字、退格/删除、改字、Enter/Space 激活聚焦按钮 | `mousemove`（只移动鼠标、不点任何东西） |
| `pointerdown` —— 鼠标 / 触摸 / 触控笔按下，**覆盖一切按钮点击** | `focus` / `blur`（窗口失焦、重新聚焦） |
| `scroll` / `touchstart` | `resize`（缩放窗口） |

即**按键、在文本框输入/删除/修改、点任意 button、滚动、触屏点按**都算「有操作」，120 秒内有过任意一次就保持 `active`。节流 5 秒（`tracker.ts:27`）无害——最多让 `lastInputAt` 落后真实活动 5 秒，远小于 120 秒阈值。

| 层 | 改动 |
|---|---|
| 客户端状态机 | `sessionMachine.ts` 让 `IDLE_TIMEOUT`（`:48-49`）产出 `reason='idle'`、`HIDDEN`（`:50-51`）产出 `reason='away'`；`SessionEffects.heartbeat` 从 `ClientState` 改为 `{ state, reason }` |
| 客户端 tracker | `tracker.ts` 的 `sendHeartbeat` 带上 `reason`（仅 `state='hidden'` 时有意义） |
| 协议 | `HeartbeatSchema`（`analytics.controller.ts:34-37`）加**可选** `reason: z.enum(['away','idle'])` —— 可选是为了兼容旧客户端 |
| 服务端仓储 | `study-sessions.repo.ts` 的 `heartbeat` / `end` SQL 增加「按 `hidden_reason` 累加对应累计列 + 维护 `hidden_since`/`hidden_reason` + 回到 visible 时清空连续段」 |

**新列语义**：

| 列 | 语义 |
|---|---|
| `hidden_away_seconds` | 累计「页面不可见」秒数（会话内） |
| `hidden_idle_seconds` | 累计「前台无操作」秒数（会话内） |
| `hidden_since` | **当前连续挂机段的起点**（回到 visible 时置 NULL） |
| `hidden_reason` | 当前连续挂机段的原因（`away` / `idle`） |

**⚠️ SET 列顺序是承重的**（`study-sessions.repo.ts:104-119` 注释已说明，且有测试钉住）：MySQL 单表 `SET` 从左到右求值，读的是**已更新后**的值。所以两个累计列必须排在 `client_state = ?` 与 `hidden_reason = ?` **之前**（它们要读旧值）。本批新增的行必须插在正确位置，不得打乱既有 `active_seconds` 那段的顺序。

**判定时机（两处，缺一不可）**：

1. **心跳时**：若 `client_state='hidden'` 且 `TIMESTAMPDIFF(SECOND, hidden_since, NOW(3)) >= 对应阈值` → 写预警。
2. **结束时**（`end` 路径）：同样检查一次 —— 覆盖「学生最小化后直接关掉页面」（此时 `pagehide` 触发 end，之后不会再有心跳）。

**为什么在阈值处就报、而不是等挂机段结束**：学生切走后再不回来，正是家长最需要知道的场景；若只在「回到前台」时判定，这个场景永远报不出来。

### 3.4 数据模型

| 表 | 改动 | 备注 |
|---|---|---|
| `controls` | 新增 `alert_away_minutes SMALLINT NOT NULL DEFAULT 5`、`alert_idle_minutes SMALLINT NOT NULL DEFAULT 15` | 迁移必须**幂等**（`information_schema` 守卫）且同步 `tools/db/schema.sql` |
| `controls` | `alert_level` / `auxiliary_enabled` / `photo_search_enabled` **保留、不标废弃** | 本批不读；DB 设计文档注明「预留未用」 |
| `study_sessions` | 新增 4 列（见 §3.3） | 迁移 + `schema.sql` |
| `safety_alerts` | **不加列** | 现成结构够用 |
| 类型枚举 | `database/repositories/types.ts:82` 的 `SafetyAlertRow.type` 补 `'away'` / `'idle'` | `abusive` 保留（`pickGentleBlockMessage` 仍映射它） |

**`safety_alerts.context` / `message` 的写入口径**（面向家长的文案）：

| `type` | `message` | `context` |
|---|---|---|
| `off_topic` | 检测到孩子在学习中发起了与学习无关的闲聊 | 学生消息片段（截断 200 字） |
| `emotional` | 检测到孩子出现情绪发泄类输入 | 学生消息片段（截断 200 字） |
| `sensitive` | 检测到敏感内容输入，建议尽快关注 | 学生消息片段（截断 200 字） |
| `away` | 孩子离开了学习页面 N 分钟 | `切走 N 分钟` |
| `idle` | 孩子在学习页面 N 分钟无操作 | `无操作 N 分钟` |

**「建议家长行动」不入库**：UX §P6.9 要求每条预警含「建议家长行动」，但 `safety_alerts` 无对应列。本批由**前端按 `type` 静态映射**生成（纯展示文案），避免为文案改表。

### 3.5 防轰炸与分级

| 规则 | 值 | 理由 |
|---|---|---|
| 去重窗口 | 同一 `student_id` + 同一 `type`，**30 分钟**内只写一条 | 心跳每 30 秒一次，不去重会刷屏 |
| 走神 `level` | `info` | 走神 ≠ 问题，不该天天弹红条 |
| 闲聊 `level` | `warning`（**每次发生即报**） | 见 §9：已去掉关键词计数，无法判断 PRD 所说的「**频繁**发起」 |
| 情绪/敏感 `level` | `warning` / `critical` | 沿用 `SafetyGuard` 的既有硬编码规则（`sensitive`/`abusive` → `critical`，`emotional` → `warning`） |
| **Banner 只弹 `warning` / `critical`** | — | `info` 只进列表页 |

### 3.6 家长端

| 位置 | 设计 |
|---|---|
| **Banner**（`ParentLayout.tsx`） | 删除 `:32` 的 `const hasAlert = true` 与假文案；改为拉「**当前选中孩子**的最新一条未读 `warning`/`critical` 预警」；无则**完全不渲染**；CTA 跳 `/parent/alerts`。**`studentId` 为 null 时不显示** |
| **预警中心页** `/parent/alerts` | 列表含触发时间、**孩子名**、类型、级别、上下文片段、建议行动；支持「只看未读」筛选；逐条标记已读；闲聊类（有 `dialogue_id`）可跳该对话回放；空态齐备 |
| **侧栏** | 加「异常预警」入口（`ParentNav.tsx` + 复用 `NavIcon`）。UX 侧栏清单未列，但不加则 Banner 点掉后页面不可达 → **偏差，写进文档** |
| **P6.6 页** `/parent/controls` | 预警灵敏度：两个分钟数输入（1..180）+ 宽松/标准/严格预设按钮（**纯前端一键填值，无服务端预设状态**）；奖励兑换只读状态 + 跳转奖励管理页。保存沿用 `PointsSettingsPanel` 的「只提交改动字段」模式 + toast |
| **P6.10 页** `/parent/account` | 账号信息只读（姓名、手机号）+ 修改密码（旧/新/确认，6..32，两次一致）+ 退出登录（复用 `LogoutButton`） |

**预设档的取值**（纯前端常量）：

| 预设 | `alertAwayMinutes` | `alertIdleMinutes` |
|---|---|---|
| 宽松 | 15 | 30 |
| 标准（默认） | 5 | 15 |
| 严格 | 2 | 5 |

### 3.7 多孩归属纪律

沿用 `CLAUDE.md` 的硬规则（家长端切孩子不重挂载）：

- **派生状态必须带 `studentId` 归属**：`data` 存 `{ studentId, value }`，读取时一并比较。
- **列表页换孩子必须回第 1 页**：`useEffect(() => setPage(1), [studentId])`。
- Banner 只认**当前选中孩子**；预警中心列表默认显示**全部孩子**（带孩子名），并支持按孩子筛选。

---

## 4. 端点契约

**归属（2026-09-20 裁决，spec 原文未指定）**：`controls`（§4.1/§4.2）与 `alerts`（§4.3/§4.4）放 **`parent-insights.controller.ts`** —— 它已是 `@Controller('api/parent')` + `@Roles('parent')`，且已有 `students/:studentId/...` 模式与 `parentService.requireOwnedStudent`；`account`（§4.5）与 `password`（§4.6）放 **`parent.controller.ts` + `ParentService`**（账号级、非按学生）。两个 controller 都是 `api/parent`，**新增路径不得与既有路径撞车**（既有清单见各自的 controller）。

### 4.1 `GET /api/parent/students/{studentId}/controls`

读行为管控配置。**仅返回本批实际拥有的两个阈值**（奖励兑换状态由前端另调既有的 `GET .../points/settings`，避免同一字段两个归属）。

- 鉴权：`JwtAuthGuard` + `RolesGuard` + `@Roles('parent')`
- 校验链：
  1. 学生归属（`parent.service.ts:196` 的 `requireOwnedStudent`）→ 不存在 `404`/`1002`；不属于本家长 `403`/`1005`
- 逻辑：`controlsRepo.ensure(studentId)` → `findByStudent(studentId)` → 组装
- 返回（200）：
  ```json
  { "alertAwayMinutes": 5, "alertIdleMinutes": 15 }
  ```
- 无行时：`ensure` 已建行，故两个字段恒为 `NOT NULL` 默认值

### 4.2 `PUT /api/parent/students/{studentId}/controls`

更新预警灵敏度。

- 鉴权：同上
- Body：
  ```json
  { "alertAwayMinutes": 5, "alertIdleMinutes": 15 }
  ```
  Schema：两个字段**均可选**、均为 `z.number().int().min(1).max(180)`
- 校验链：
  1. 学生归属 → `404`/`1002`、`403`/`1005`
  2. **至少一个字段**（两个都缺 → `409`/`1001`「没有要更新的字段」）
  3. 范围 1..180（越界 → `409`/`1001`）
- 逻辑：`ensure` → `update(studentId, patch)` → **回读** `findByStudent` → 返回完整对象
- 返回（200）：同 4.1 的完整形状
- 注意：`controls.repo.ts` 的 `update` 是**白名单**构建 `SET`，本批把两个分钟数加入白名单；空 patch 返回 0 行（既有行为，测试已钉住）

### 4.3 `GET /api/parent/alerts`

预警列表。

- 鉴权：同上
- Query：`studentId?`（正整数，给了就校验归属）、`unreadOnly?`（`'1'` 视为真）、`page?`（≥1，默认 1）、`pageSize?`（1..50，默认 20）
- 逻辑：`safety_alerts` join `students`（取孩子名），`WHERE parent_id = ?`，`ORDER BY created_at DESC, id DESC`，分页
- 返回（200）：
  ```json
  {
    "items": [{
      "id": 12,
      "studentId": 3,
      "studentName": "小明",
      "type": "off_topic",
      "level": "warning",
      "message": "检测到孩子在学习中发起了与学习无关的闲聊",
      "context": "你喜欢什么游戏？",
      "dialogueId": 88,
      "isRead": false,
      "createdAt": "2026-09-20T10:00:00.000Z"
    }],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
  ```
- `studentName` 由 join `students` 得到；`safety_alerts` 的两个 FK 都是 `ON DELETE CASCADE`，所以正常不会出现孤儿行，但前端仍按「取不到名字就显示『未知学生』」处理，不做非空断言
- 空结果返回 `items: []`、`total: 0`（**不是错误**）

### 4.4 `PATCH /api/parent/alerts/{alertId}/read`

标记已读。

- 鉴权：同上
- 校验链：
  1. `alertId` 为正整数（否则 `409`/`1001`）
  2. 预警存在 → 否则 `404`/`1002`
  3. `parent_id` = 当前家长 → 否则 `403`/`1005`
- 逻辑：`UPDATE safety_alerts SET is_read = 1, read_at = NOW(3) WHERE id = ?`（幂等：重复标记不报错）
- 返回（200）：`null`（照 `PATCH .../reset-password` 的惯例，全局拦截器包装）

### 4.5 `GET /api/parent/account`

家长账号信息。

- 鉴权：同上
- 逻辑：按 `req.user.sub` 取 `parents` 行
- 返回（200）：`{ "id": 7, "name": "张三", "phone": "13800000000" }`
- **不返回**订阅 / 额度 / 订单（那些表不存在）；`ParentAccount` 的 openapi schema 同步收敛
- 家长行不存在（理论上不可能）→ `404`/`1002`

### 4.6 `PATCH /api/parent/password`

家长修改**自己**的密码。照 `admin-dashboard.service.ts:38-47` 写。

- 鉴权：同上
- Body：`{ "oldPassword": "…", "newPassword": "…" }`
  Schema：`oldPassword` `z.string().min(1).max(100)`、`newPassword` `z.string().min(6).max(32)`
- 校验链：
  1. Schema（越界 → `409`/`1001`）
  2. 取当前家长的 `password_hash`；`bcrypt.compare(oldPassword, hash)` 失败 → `401`/`1003`（与登录失败同码）
  3. 新密码与旧密码相同 → `409`/`1001`「新密码不能与旧密码相同」
- 逻辑：`bcrypt.hash(newPassword, 10)` → `parentsRepo.updatePassword(id, hash)`
- 返回（200）：`null`
- **不做**会话失效（本仓无 token 版本机制，与 `admin-dashboard.service.ts` 保持一致）；在文档里注明「旧 token 在 7 天内仍有效」

---

## 5. 页面状态机

### 5.1 Banner（`ParentLayout`）

```
读 useParentStudentStore.studentId
├─ studentId == null        → 不渲染（不请求）
└─ studentId != null
   └─ GET /api/parent/alerts?studentId=&unreadOnly=1&pageSize=1
      ├─ 加载中              → 不渲染（不占位、不抖动）
      ├─ 失败                → 不渲染（静默；与未读数拉取失败一致）
      ├─ items[0].level ∈ {warning, critical}
      │                      → 渲染红色 Banner（标题=message，描述=「点击查看详情，建议适时介入」）
      └─ 其他（空 / 只有 info）→ 不渲染
```

- CTA `onClick` → `navigate('/parent/alerts')`（补上现有按钮缺失的 handler）
- 刷新时机：与未读数一致——`location.pathname` 变化时重拉（`ParentLayout.tsx:28-30` 的既有模式）

### 5.2 预警中心页（`/parent/alerts`）

```
初始：studentId 可为 null（显示全部孩子）
状态：
  ├─ 加载中        → Skeleton
  ├─ 请求失败      → 错误卡 + 重试按钮
  ├─ 空（无预警）  → 空态文案（「暂无预警」）+ 无 CTA
  ├─ 空（筛选后）  → 「当前筛选下没有预警」+ 清除筛选按钮
  └─ 有数据        → 列表
交互：
  ├─ 切换「只看未读」→ setPage(1) 并重拉
  ├─ 切换孩子        → setPage(1) 并重拉（CLAUDE.md 硬规则）
  ├─ 点「标记已读」  → PATCH → 本地就地更新该条 isRead=true（不整页重拉）
  │                    ├─ 成功 → 该条按钮消失；若列表在「只看未读」下则移除该行
  │                    └─ 失败 → toast('error')，状态不变
  └─ 有 dialogueId  → 「查看对话」链接 → /parent/chat-logs
```

- 派生状态带 `studentId` 归属（§3.7）
- 建议行动按 `type` 前端静态映射

### 5.3 行为管控页（`/parent/controls`）

```
依赖：studentId（null → 空态「请先选择孩子」）
两个数据源：
  ├─ GET .../controls       → { alertAwayMinutes, alertIdleMinutes }
  └─ GET .../points/settings → { rewardRedemptionEnabled }（只读展示用）

状态：
  ├─ 任一加载中   → Skeleton
  ├─ controls 失败 → 错误卡 + 重试
  ├─ points 失败   → 该卡片单独显示「状态获取失败」（不影响灵敏度表单）
  └─ 就绪
交互：
  ├─ 点预设（宽松/标准/严格）→ 就地填两个输入框（不改服务端）
  ├─ 手动改输入 → 预设高亮消失
  ├─ 点保存
  │   ├─ 本地校验 1..180 整数 → 失败：Input error 文案，不发请求
  │   ├─ 无改动 → 按钮 disabled（不发请求，避免 P6.5 那种「零反馈」问题）
  │   ├─ 只发改动字段
  │   ├─ 成功 → toast('success', 回显服务端返回的值) + 重置 dirty
  │   └─ 失败 → toast('error', 服务端 message)
  └─ 奖励兑换卡片 → 「去奖励管理」链接 → /parent/rewards
```

### 5.4 账号设置页（`/parent/account`）

```
状态：
  ├─ GET account 加载中 → Skeleton
  ├─ 失败              → 错误卡 + 重试
  └─ 就绪              → 账号信息卡（姓名/手机号只读）+ 修改密码卡 + 退出登录

改密码：
  ├─ 本地校验：旧密码非空；新密码 6..32；两次一致 → 否则 Input error，不发请求
  ├─ 提交 → 按钮 loading、禁用
  │   ├─ 成功 → toast('success', '密码已修改') + 清空三个输入框
  │   └─ 失败 → toast('error', 服务端 message)；1003 时给旧密码框标错
  └─ 退出登录 → 复用 LogoutButton（清 localStorage + 跳登录页）
```

---

## 6. 错误处理与不变量

| 不变量 | 说明 |
|---|---|
| **预警写入永不阻断主链路** | 辅导链路与心跳链路的判定+写入**整段 try/catch，失败只 `logger.warn`**。心跳路径尤其重要：绝不能影响 `active_seconds` 累加与心跳响应——所以**判定与写入一律 `void` 调用、不得 `await`**：判定里含 `findAlertThresholds` 的一次 DB 往返，学生处于 hidden 时**每次心跳**（30s）都会走到它，`await` 会把这次往返静默叠加到心跳响应上（前端 fire-and-forget、用户无感、日志看不出）。`void` 的安全前提是该方法**永不 reject**（整段含 `await` 的拒绝都在 try 里），有专门的 unhandled-rejection 用例钉住 |
| **`active_seconds` 语义不变** | 本批新增的列不参与既有的学习时长统计口径（`parent-analytics.repo.ts:43-44` 的 `EFFECTIVE_SESSION` 不动） |
| **SET 列顺序不变** | 既有 `active_seconds` 那段的顺序不得打乱（§3.3） |
| **预警读取失败 → 空态** | 家长端不因预警接口失败而白屏 |
| **归属校验前置** | 所有涉及 `studentId` 的端点先过 `requireOwnedStudent` |
| **不新增调度器** | 判定全部在请求路径上内联完成，符合「本仓零调度基础设施」的现状 |
| **不写 `parent_messages`** | 本批不动站内信（§1.1 裁决 2） |

---

## 7. 测试

### 7.1 后端（Vitest）

| 文件 | 覆盖 |
|---|---|
| `ai-core/infra/safety-guard.test.ts` | **改写**：删除 off_topic 相关断言（该行为已移除）；保留 anomaly 断言；新增「辅线不再被豁免」的断言 |
| `ai-core/__tests__/safety-classification.ts` | **改写**：`off_topic` 用例（`:47-56`）改为断言「不再判 off_topic / 不再阻断」，并在注释里说明原因 |
| `ai-core/capabilities/tutoring.capability.test.ts` | 新增：标记被识别并剥离、标记**不进历史**、无标记时不写预警、**两条入口（`tutor` / `tutorStream`）都覆盖**、`safetyFlag` 正确回写 |
| `services/conversation/index.ts` 与 `modules/conversations/conversations.service.ts` 的既有测试 | 新增：`safetyFlag` 显式传入时优先于 `type === 'block'` 的推导；未传时行为不变（向后兼容） |
| `modules/analytics/study-sessions.*.test.ts` | 新增：`reason` 校验、两类累计列分别累加、`hidden_since` 的建立与清空、**SET 顺序回归**（沿用既有顺序测试的写法） |
| `database/repositories/controls.repo.test.ts` | 新增：两个分钟数列的读写；**保持** `ensure` 无副作用断言（`:26-27`） |
| `database/repositories/safety-alerts.repo.test.ts`（新建） | 新增：`existsRecent` 去重窗口、`listByParent` 分页与筛选、`markRead` 归属校验 |
| `modules/parent-insights/*.test.ts` | 新增：`controls.service` 校验链（空 patch、越界、归属）、`alerts.service` 分页与已读 |
| `dashboard.service.test.ts` | **改写** `:179-183` 那条「`unreadAlerts` 恒为 0」的断言 → 改为真查后的行为 |

### 7.2 前端（Vitest）

| 文件 | 覆盖 |
|---|---|
| `components/layout/ParentLayout.test.tsx` | **改写** `:76-83` 那条名为「假 Banner 仍在（异常预警占位，本次不碰）」的用例（`:80` 钉住了假文案）→ 改为：有 `warning`/`critical` 未读时渲染、无或只有 `info` 时不渲染、请求失败时不渲染 |
| `components/layout/ParentNav.test.tsx` | 新增「异常预警」入口存在 |
| `pages/parent/ParentAlertsPage.test.tsx`（新建） | 四态（加载/失败/空/有数据）、筛选、标记已读、换孩子回第 1 页 |
| `pages/parent/ParentControlsPage.test.tsx`（新建） | 预设填值、本地校验、无改动禁用、只发改动字段、toast 回显 |
| `pages/parent/ParentAccountPage.test.tsx`（新建） | 信息只读、密码三段校验、1003 路径 |
| `analytics/sessionMachine.test.ts` | 新增：`IDLE_TIMEOUT` → `reason='idle'`、`HIDDEN` → `reason='away'` |

### 7.3 验证命令

- 后端 `npm test`（server 目录）
- 前端 `npm test`（web 目录）+ **`TZ=UTC` 再跑一遍**（防挂钟依赖，沿用 `d31ffa2` 的做法）
- `tsc` / `lint` / `build` 两端
- **Task 0 标记验证**（需 API Key，非 CI）：`npx tsx src/ai-core/__tests__/off-topic-marker.ts`（结果见 §3.2）

### 7.4 手工走查清单（交付时一并给出）

1. 辅线发一条语文理解题 → **不被拒答**（修复验证）
2. 辅线发一条闲聊 → 模型温和引导，且家长端预警中心出现 `off_topic` 预警
3. 家长端任意页顶部出现红色 Banner → 点 CTA 进预警中心 → 标记已读 → 返回后 Banner 消失
4. 学生端切走 ≥ 5 分钟（改小阈值便于验证）→ 出现 `away` 预警，且**不弹 Banner**（`info` 级）
5. 改「切走等待时长」为 2 分钟 → 再切走 2 分钟即报警（阈值真的生效）
6. 改密码：旧密码错 → 报错；旧密码对 → 成功且新密码可登录
7. 多孩：切换孩子 → Banner 与列表按所选孩子变化，列表页回到第 1 页

---

## 8. 文档同步

| 文档 | 改动 |
|---|---|
| `docs/API接口与数据流设计文档.md` | §4.13：`controls` / `alerts` / `account` 从「文档先于代码」改为已实现；新增 `/password`；§7 页面→端点映射补 P6.6/P6.9/P6.10；补本批的 UX 偏差批注（§1.2） |
| `docs/api/openapi.yaml` | 四个路径从「有契约无实现」转为实现；订正 `Controls`（收敛为两个字段）、`Alert`（`type` 枚举以代码为准）、`ParentAccount`（去掉不存在的 subscription/AIQuota）；新增 `/parent/password` |
| `docs/K12智学系统-数据库设计文档.md` | `controls` 新列 + 三列「预留未用」注明；`study_sessions` 4 个新列；`safety_alerts` 的 `type` 枚举；**`ai_messages.safety_flag` 的语义变更**（从「被阻断的轮次」→「被判闲聊的轮次」） |
| `docs/UX-UI设计文档.md` | §P6.6 补批注（四项按裁决不做，见 §1.2）、§P6.9 补批注（四类预警中「连续多课兜底触发」本批不做，另实现「敏感内容」一类，共 3 类）、侧栏清单补「异常预警」 |
| `docs/ai-core-changelog.md` | 本批日志（日期 + 变更 + 裁决） |
| `CLAUDE.md`（根） | 只留仍生效的约束，保持 ~15KB |
| `docs/家长端学情批-完成情况与待办清单.md` | §6 标已完成；把 §1.1 的裁决与 §1.2 的偏差写进去 |

---

## 9. 已知限制（必须写进交付说明）

| 限制 | 说明 |
|---|---|
| **「家长来了迅速切回来」测不到** | 系统不记录切换次数与每次操作的时间点，这种快进快出在数据上与正常学习无法区分。**已在设计阶段向用户说明是天花板** |
| **「小窗口摆在旁边」测不到** | `document.hidden` 为 false（浏览器仍可见），且无 `resize` 监听、`screen_class` 只在会话开始时采一次。若学生不碰学习页，会被 `idle` 兜住 |
| **「前台发呆」与「认真阅读/思考」无法区分** | 120 秒无输入即判 `idle`，阅读长文或思考难题很容易超过。缓解手段：默认阈值取保守值（15 分钟）、家长可调、只记 `info` 不弹 Banner。**这是设计上的取舍，不是缺陷** |
| **`idle` 段的计时起点晚 2 分钟（两个「分钟数」不是一回事）** | 客户端空闲阈值 `IDLE_TIMEOUT_MS = 120_000`（`tracker.ts:23`）是**写死的**，本批**不接入家长配置**；家长的 `alert_idle_minutes` 只从 `hidden_since` 起算。所以默认档「无操作 15 分钟」实际是「距最后一次操作约 17 分钟」。验收时按 §3.3 的口径，别拿 15 分钟当「无操作 15 分钟」 |
| **只移动鼠标、窗口失焦/聚焦、缩放窗口不算「有操作」** | 未监听 `mousemove` / `focus` / `blur` / `resize`（§2.3 缺口）。学生只看不动键鼠时会被 120 秒空闲判定兜住（判 `idle`，`info` 级）。本批**不新增这些监听**——`mousemove` 高频、且会放大「人在但没学」的误判面 |
| **`hidden_reason` 在极少数情况会贴错标签** | 若先因 `idle` 变 hidden、随后标签页又被切走，客户端不再发新心跳（状态机在 `hidden` 下对 `HIDDEN` 是空操作），该段仍记为 `idle` |
| **改密码不失效旧 token** | 本仓无 token 版本机制，旧 token 在 7 天有效期内仍可用（与管理员改密码的既有行为一致） |
| **预警不是实时推送** | 无调度器 / 无 WebSocket，家长在**打开或切换页面时**才拉到新预警 |
| **`alert_level` / `auxiliary_enabled` / `photo_search_enabled` 仍未被读取** | 按裁决保留（用户要求「先留着，等以后可能还有用」），DB 设计文档注明「预留未用」 |
| **闲聊预警没有「频繁」语义** | PRD 206 的措辞是「**频繁**发起与学习无关的闲聊」，但本批去掉了关键词计数（`countConsecutiveOffTopic` 依赖被删的 `off_topic` 判定），无法可靠判断「频繁」。实现为**每次发生即报**，靠 30 分钟去重兜住频率。若以后要真正的「频繁」语义，需给 `safety_alerts` 加出现次数或按窗口计数 |
| **`countConsecutiveOffTopic` 与 `safety.yaml` 的 `off_topic.escalateThreshold`/`criticalThreshold` 保留但不再被调用** | 与上一条同源。按「先留着」的既有原则保留（含其单测），文档注明「预留未用」 |
| **`ai_messages.safety_flag` 的语义有变（双来源）** | 从「被硬阻断的轮次」变为「被模型判为闲聊 **或** 被阻断的轮次」（后者现在只剩情绪/敏感）。家长端「对话回放」的标签与计数因此会变（**更准确**，文案已从「闲聊」改为「偏离学习」），历史数据的口径不一致 |
| **走神预警在挂机**进行中**就会报** | 不等挂机段结束——因为「切走后不再回来」正是家长最需要知道的场景。副作用：学生仍在挂机时预警已产生，若其后回来并继续学习，该条预警依然存在 |
| **无 `end` 的会话（浏览器崩溃 / 被强杀 / 断电）不判走神阈值** | 阈值判定只在两处发生：**心跳**与 **`end`**（§3.3「判定时机两处」）。若浏览器**崩溃 / 被系统强杀 / 断电**（不发 `pagehide`），不再有任何心跳 → 会话只能被 `closeStale` 惰性收尾（家长拉学情时触发，`end_reason='closed'`，`ended_at=last_heartbeat_at`）→ **没有任何路径做阈值判定** → 走神预警**永不产生**。正常关标签 / 页面内导航会发 `pagehide`（由 `end` 覆盖），所以风险集中在崩溃/强杀这一类。要补需让 `closeStale` 也做判定（本批**不做**：`closeStale` 的调用方在家长 GET 的路径上，判定要读阈值 + 写预警，属另一处要评估的写入点） |
| **历史挂机数据无法回填** | 4 个新列在迁移前不存在，旧会话的「切走/无操作」细分永久缺失（与 Phase 1A 的 `subject_id` 回填同类问题） |
| **标记若未落在「最后一个非空行」→ 该轮不判闲聊、不产生预警** | §3.2 的检测规则要求标记独占最后一行；若模型把标记写在正文中段或夹在句子里，该轮**不**判闲聊（剥离仍会处理独占一行的标记）。Task 0 实测模型稳定写在末行；**本批的验证门（`off-topic-marker.ts` 真模型 3/3）会兜住这一点** —— 若模型不再把标记写在末行，sample③ 的 `signalRecorded` 会变 false → 门 FAIL。这是**有意收紧**（对齐 §3.2 与提示词），残余风险由此门覆盖 |
| **`SafetyAlertSink` 的 union 含 `'abusive'` 但运行时不可达** | `SafetyGuard.detectAnomalyType` 的声明返回类型是 `AnomalyType`（含 `abusive`），anomaly 分支把 `alertPayload.type` 原样透传，不收窄过不了 `tsc`；`SafetyAlertsService.messageFor('abusive')` 已覆盖（→ 敏感文案）。但检测器只可能返回 `'emotional'`/`'sensitive'`，**从不返回 `abusive`**，故该分支在运行时不可达。同理 `level` 在调用点收窄为 `'critical' | 'warning'`（anomaly 的 level 恒为这两者之一） |

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 模型忘记写标记 → 漏报 | 兜底「无标记 = 不报警」；**Task 0 阻塞验证门**；不通过则切方案 B（并行小模型分类） |
| 提示词改动影响辅导质量 | Task 0 一并核对回复自然度；标记用 HTML 注释（不可见），不让学生看到元信息 |
| 心跳路径新增逻辑影响学习计时 | 判定与写入整段 try/catch、失败只 warn；**不改既有 `active_seconds` 的 SET 顺序**；补 SET 顺序回归测试 |
| 走神误报 | 默认阈值保守（无操作 15 分钟）+ 家长可调 + 只记 `info` 不弹 Banner（§9） |
| 删 off_topic 兜底是**破坏性变更** | 同步改 2 个测试文件；改前确认无其他消费方依赖 `shouldBlock` |
| `openapi.yaml` 三处 schema 漂移 | §8 统一订正，`Alert.type` 以**代码**为准 |
| 保留的 TODO 含过时表述会误导后来人 | 只订正事实部分（「仓储未建」是错的），TODO 的意图与位置原样保留 |
| 家长端「奖励兑换」出现双入口 | `/controls` 端点**不接受** `rewardRedemptionEnabled`，P6.6 页只读展示 + 跳转奖励管理页 |

---

## 11. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-20 | 初稿。含 §1.1 的 10 条用户裁决、§1.2 与 UX §P6.6 的偏差说明、§2 的实测调研结论（含闲聊分类器 6/12 误判的实测数据） |
| 2026-09-20 | 自查修正三处内部矛盾：① 闲聊的 `level` 原写「沿用连续 3/5 次升级」，但升级依赖被删的关键词计数 → 改为恒 `warning` 并把「无频繁语义」列入 §9；② 补上「必须同时回写 `ai_messages.safety_flag`」——否则家长端对话回放的闲聊标签与计数会归零（§3.2 / §7.1 / §8 / §9）；③ 补明两条入口（`tutor` / `tutorStream`）共用 `prepare()` 的写入落点（§3.1） |
| 2026-09-20 | 用户审核后补「走神判定口径」（§3.3 新增段 + §9 两条）：显式区分**前端写死的 120 秒空闲阈值**与**家长可调的 `alert_idle_minutes`**（两者相加才是家长感知的报警延迟，默认档约 17 分钟），并列出「哪些交互算有操作 / 哪些不算」（打字、删除、点按钮、滚动、触屏均算；`mousemove`/`focus`/`blur`/`resize` 不算） |
| 2026-09-20 | **Task 0 验证门已执行并通过（3/3）→ 采用方案 A**。改动：`tutoring/math/auxiliary.md` 与 `mainline.md` 加入 `<!--topic:off-->` 标记指令；新增手工 eval 脚本 `src/ai-core/__tests__/off-topic-marker.ts`。实测三条（数学题 / 语文理解题 / 闲聊）标记行为均符合预期、辅导质量无退化；同时确认现有 `parseContent` 不剥离该标记 → 剥离改造必需。结果见 §3.2，命令见 §7.3 |
| 2026-09-20 | **Task 5 评审收尾（Fix 1）**：§3.2 补**精确**的检测/剥离规则（检测只认「最后一个非空行独占」；剥离对所有独占一行的标记做**全局**替换并去首尾换行）；§9 补两条已知限制（①标记未落末行 → 该轮不判闲聊、由验证门兜住；②sink union 含 `abusive` 但运行时不可达）。plan 同步回写 3 处实现偏离（`Number(...)` 必需、验证门观测点前移、union 扩 `abusive`）与 3 个已知错误代码块，并订正 Step 5 的假钉断言（辅线用例须断言 `classification`/`isLearningRelated`） |
| 2026-09-20 | 计划评审期补两处裁决：① **`safety_flag` 双来源**（闲聊标记 ∪ anomaly 阻断）都计入，家长端文案从「闲聊」改「偏离学习」（§3.2 / §9 / §8）；② **端点归属**——`controls`/`alerts` 进 `parent-insights.controller.ts`，`account`/`password` 进 `parent.controller.ts` + `ParentService`（§4 开头）。实施计划见 `docs/superpowers/plans/2026-09-20-parent-controls-and-alerts.md` |
| 2026-09-20 | **Task 4 评审修复**：§9 补一条已知限制——「无 `end` 的会话（浏览器崩溃 / 被强杀 / 断电）不判走神阈值」（评审 M-3；`closeStale` 收尾路径不做判定，本批不改代码） |
| 2026-09-20 | **Task 5 评审收尾（Fix 2）**：① §3.2 剥离规则补「换行同时容忍 LF 与 CRLF」——检测走 `trimEnd()` 能认 CRLF 末行，剥离正则若只认 `\n` 就会「判了闲聊却剥不掉」（Fix 1 引入的回归，已修）；② §3.2 的 `safety_flag` 取值规则补外层 `Number(...)`（Fix 1 漏改本行，留下会写 boolean 的版本）并附为什么必需 |
