# 订阅收费批④：自动到账 + 管理员裁决 + 试用/订阅管理 设计

- 日期：2026-09-30
- 状态：设计定稿（用户裁决见 §0），配套实施计划 `docs/superpowers/plans/2026-09-30-subscription-billing-4-adjudication-admin.md`
- 背景：本机部署形态下**支付回调不可达**（无公网地址），到账确认只能靠主动查单；且管理侧需要「人工裁决收费争议」与「试用/订阅全权管理」能力

## 0. 已确认决策（用户裁决 + 主控裁决，均可推翻需重开讨论）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 自动到账 | 家长支付弹层轮询到 pending 单时，**后端限频主动查渠道**，查到已付自动入账——家长扫码后零点击到账 |
| 2 | 家长点「我已付款」但渠道未确认 | 转**人工裁决**：订单打 `claim_status='pending_review'`，管理端可见；生产环境下（真渠道）这就是「家长声称已付/线下转账」的裁决入口 |
| 3 | 通知管理员形态 | **惰性列表 + 侧栏角标**（零推送、零调度，与全仓既有裁决一致）；管理员进后台看「待裁决」列表 |
| 4 | 终态单裁决（沿袭 4b5bd64 口径） | expired 单裁决通过可入账（`markPaidTx` 已放行 pending\|expired）；cancelled 单拒绝 |
| 5 | 试用/订阅管理 | 管理员可查看每个家庭的订阅状态、**调整试用截止日**、**手动赠送/扣减订阅天数**，全部落审计表 |
| 6 | 自动查单限频 | **进程内存 Map 限频**（每单 10s 一次渠道查询）；重启丢失可接受（重启后首次轮询多查一次渠道，无害） |
| 7 | **付费接入主体（2026-09-30 用户裁决）** | 商户号需企业认证（300 元/次），**暂不接入真渠道**：主路径 = 家长选**「线下转账」渠道**下单 → 个人微信转账给管理员 → 点「我已付款」（必填备注）→ 管理员裁决通过 → 手工开通。微信/支付宝在线渠道作为商户号开通后的升级项，代码已就绪 |
| 8 | 线下转账渠道（新增） | `POST /api/billing/orders` 的 `channel` 枚举放开 `manual` 给家长侧：不下适配器、无二维码；弹层显示「请联系管理员付款，付款后点击我已付款」；confirm 必填备注（转账人/方式）→ claim → 裁决。自动查单天然跳过 manual |

## 1. 数据模型变更（迁移 `tools/db/migrations/2026-09-30_billing_claims_and_adjustments.sql`，幂等，同步 schema.sql）

**`orders` 加 3 列**（本期预留语义，向后兼容——现有行 NULL）：

| 列 | 类型 | 说明 |
|---|---|---|
| claim_status | VARCHAR(12) NULL | `pending_review` / `rejected` / `approved`；NULL = 家长从未主张已付 |
| claimed_at | DATETIME(3) NULL | 最近一次主张时刻 |
| claim_note | VARCHAR(200) NULL | 家长备注（如「已微信转账给管理员」），下单方自填 |

**新表 `subscription_adjustments`**（管理员调整审计）：

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT PK | |
| parent_id | BIGINT | FK → parents.id |
| admin_id | BIGINT | 操作管理员 |
| type | VARCHAR(12) | `trial_set`（设定试用截止）/ `grant_days`（正数顺延 / 负数扣减） |
| trial_ends_at | DATETIME(3) NULL | type=trial_set 时的新值 |
| delta_days | INT NULL | type=grant_days 时的增减天数 |
| reason | VARCHAR(200) NULL | 操作原因（管理员填写） |
| created_at / updated_at | DATETIME(3) | |

## 2. 后端逻辑

### 2.1 自动查单（改 `GET /api/billing/orders/{orderNo}` 的 pending 分支）

- 触发条件：订单 `payment_status='pending'` 且 `channel ∈ {wechat, alipay}`（mock 渠道不查——mock 无查单语义，仍走 confirm-paid）
- 限频：内存 `Map<orderNo, lastCheckAt>`，距上次渠道查询 <10s 直接返回 DB 状态；`Map` 不持久化
- 查单结果处理（复用既有方法）：
  - 渠道 paid → `finalizePaidOrder`（单事务入账+顺延；expired 单按终审口径也可入账，markPaidTx 已放行）
  - 渠道未付 → 返回 DB 状态（不变）；渠道异常（2003 类）→ **吞掉**，照常返回 DB 状态（查单失败不该污染家长读路径，日志 warn）
- 返回体不变（OrderDetailView）；家长端弹层每 3s 轮询，后端限频 10s → 渠道查询压力 = 每单每 10s 一次，可接受

### 2.2 裁决链路

- **家长侧**：`POST /orders/{orderNo}/confirm-paid` 查单未确认（现有 2004 分支）→ 额外落 claim：`claim_status='pending_review'`、`claimed_at=now`、body 可带 `note?`（≤200 字）存 `claim_note`。响应体加 `claimStatus: 'pending_review'`，语义 = 「已转人工核实」。重复点击刷新 pending_review 与 claimed_at（幂等）
- **自动闭环**：claim 为 pending_review 期间，家长端轮询继续触发 2.1 自动查单——渠道后续确认已付 → 自动 finalize + `claim_status='approved'`（家长零等待，管理员列表自动消失）
- **管理员侧**：
  - `GET /api/admin/billing/orders/claims?status=pending_review`（分页）→ 列表含：orderNo、家长手机号/昵称、plan_snapshot、amount_cents、claimed_at、claim_note、当前 DB 支付状态；支持管理员点「现场核验」按钮触发一次即时渠道查单（复用 2.1 逻辑，绕过限频）
  - `POST /api/admin/billing/orders/{orderNo}/claims/approve` → 复用 `adminMarkPaid`（adminId 留痕已有），事务内 `claim_status='approved'`；订单为 expired 时照常入账（4b5bd64 口径），cancelled → 2002
  - `POST /api/admin/billing/orders/{orderNo}/claims/reject` → `claim_status='rejected'`（订单保持 pending，家长可修改后重新主张）；body 可带 `reason?` 写入 claim_note 尾部（追加，不覆盖）
- **家长可见性**：支付弹层与订单历史显示 claim 状态——`pending_review`：「已转人工核实，管理员确认后自动开通」；`rejected`：「管理员未确认本次支付，请核实后重试」；approved/paid：成功态

### 2.3 试用 / 订阅管理（admin）

- `GET /api/admin/billing/families?keyword=&page=&pageSize=` → 每行：parent_id、手机号、名下学生数、订阅状态（effectiveStatus 推导）、plan、trial_ends_at、current_period_end
- `PUT /api/admin/billing/families/{parentId}/trial` body `{trialEndsAt: ISO|null}` → 直接 UPDATE `family_subscriptions.trial_ends_at`（null=收回试用）；无行则 upsert；落 `subscription_adjustments(type='trial_set')`；响应返回新 StatusView
- `POST /api/admin/billing/families/{parentId}/grant` body `{days: int, reason?}` → 事务内：按既有顺延规则调整 `current_period_end`（期内从期末顺延 / 过期从 now 起算；负数扣减，扣到 < now 则置 NULL=回到过期态）+ 落 `subscription_adjustments(type='grant_days')` + 同步冗余 `status` 列（`effectiveStatus` 推导）+ logger.log 审计；响应返回新 StatusView
- 错误码：沿用 2xxx——2002（对 cancelled 单 approve/reject 之外的非法操作）、1002/1005（找不到/归属）；grant days=0 → 400/1001

### 2.4 线下转账渠道（家长侧 manual，决策 7/8 的落地）

- `POST /api/billing/orders` 的 `channel` 入参放开 `manual`（家长 JWT）：**不走适配器**——无 `channel_trade_no`/`channel_qr_content`，订单直接 `pending`；返回体 `qrContent/redirectUrl` 均为 null
- `POST /orders/{orderNo}/confirm-paid` 对 manual 单：**跳过渠道查单**（无渠道可查），**备注必填**（body `note` ≤200 字，缺省 400/1001）→ 直接落 claim `pending_review` → 裁决（2.2）
- 防串单 / 2h 超时 expired / 裁决通过 `markPaidTx`（pending|expired）对 manual 单同样适用；自动查单（2.1）天然跳过 manual
- 前端：渠道选择三选（微信支付 / 支付宝 / **线下转账**）；选线下转账时弹层不放二维码，显示「请联系管理员付款（个人微信转账），付款后填写转账备注并点击我已付款」；微信/支付宝渠道在商户号未配置时下单会得到 2003「支付渠道未配置」，错误文案直接展示（引导改选线下转账）
- 明确不做：管理员个人收款码图片展示（家长与管理员相识，第一版文字提示够用；收款码上传留待有 ICP 备案的正式部署）

## 3. 前端

### 3.1 家长端（改 `ParentSubscriptionPage`）

- 支付弹层：订单详情轮询已存在，新增对 `claimStatus` 的三态渲染（见 2.2 家长可见性）；`rejected` 态重新点亮「我已付款」按钮（可带备注输入框，选填 ≤200 字）
- 订单历史行：pending + claim_status=pending_review 显示「人工核实中」徽标

### 3.2 管理端（新页 + 角标）

- 新页 `/admin/billing`（`AdminBillingPage`，参照 AdminAlertsPage 的页面骨架与路由挂法）：
  - **Tab 1 待裁决**：claims 列表（角标数字挂 admin 侧栏「订阅裁决」项，惰性拉取）+ 行内「现场核验」「通过」「驳回」
  - **Tab 2 家庭订阅**：families 列表（keyword 搜索）+ 行内「调整试用」（日期选择/收回）+「赠送/扣减天数」（天数 + 原因）
- UI 纪律照旧：无 emoji、CSS 变量、线性 SVG、afterEach(cleanup)

## 4. 明确不做（本期）

- 管理员推送/短信通知（惰性列表角标替代；全仓零推送通道）
- 家长与管理员的实时聊天（裁决走 claim_note + 驳回 reason 的异步文字）
- 自动查单结果持久化（不做 channel_checked_at 列，内存限频即可）
- 退款流程（维持既有裁决）

## 5. 测试要点

- 自动查单：pending 触发限频（同单 10s 内只查一次）、查到 paid 自动 finalize、渠道异常吞掉、expired 单自动入账、mock 渠道不触发
- claim：confirm-paid 2004 → pending_review 落库（note 透传）；重复点击幂等；approve → paid + claim approved（adminId 留痕）；reject → rejected + reason 追加；自动闭环（claim 期间渠道变 paid → approved）
- 试用/订阅管理：trial 调整 upsert（无行家庭）、grant 正/负天数（负数扣到过期态）、adjustments 审计行、响应 StatusView 正确
- 前端：弹层三态渲染、admin 列表与角标、调整表单

## 6. 交付物

1. 迁移 + schema.sql 同步
2. orders.repo / billing.service / subscriptions.service / admin-billing.controller 扩展
3. 家长弹层改造 + `AdminBillingPage` + admin 侧栏角标
4. API 文档 v4.16 + openapi（新增 admin 5 端点）+ PRD §7.7 注记补一句「人工裁决与试用管理已实现」
