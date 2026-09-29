# 订阅收费（Subscription & Billing）设计

- 日期：2026-09-29
- 状态：已与用户确认设计方向，本文为定稿 spec
- 来源：2026-09-29 头脑风暴（PRD §7.7 订阅与额度管理 / §9 商业模式；API 文档 §4.14/§4.15/§5.6 原占位）

## 0. 已确认的六个决策（用户裁决，2026-09-29）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 支付通道 | **有商户资质，接真支付**：微信支付 APIv3（Native 扫码）+ 支付宝（当面付扫码，未开通当面付时降级手机网站支付跳转） |
| 2 | 收费模型 | **本期硬门禁**：未订阅/过期 → 学生端三轨全锁；**AI 额度只展示不拦截**（`llm_call_logs` 数据现成） |
| 3 | 订阅主体 | **按家长，全家共享**：一个订阅盖名下所有学生子账号 |
| 4 | 试用 | **注册送 N 天试用**（默认 7 天，可配置） |
| 5 | 续费提醒 | **惰性展示，零调度**：顶栏/订阅中心读时比对时刻，不建 cron、不写站内信 |
| 6 | 优惠码 | **本期不做**：`orders` 表预留 `coupon_*` 字段不写；PRD §9 优惠券需求保留待下期 |

## 1. 总体架构

```
家长端订阅中心 ──► orders（下单/支付/取消/历史）
                     │
                     ▼
              PayChannelAdapter（渠道适配器接口）
                     ├─ WechatNativePay（微信 Native 扫码，APIv3）
                     └─ AlipayQrPay（当面付扫码；降级手机网站支付跳转）
                     │
                     ▼  异步回调（验签 + 幂等）
              orders.payment_status=paid ──► family_subscriptions 续期
                     │
                     ▼
      SubscriptionGuard（学生端硬门禁，JwtAuthGuard/RolesGuard 之后）
```

- **渠道只适配到「二维码」**：两个渠道统一产出 `{qrContent, orderNo}`，iPad Web 与 PC App 一律展示二维码、家长手机扫码付。规避浏览器内拉起支付的跨端深坑；Electron 壳零改动。支付宝跳转形态仅作为商户未开通当面付时的降级（适配器内实现，前端同个弹层改为「跳转支付宝」按钮）。
- **零调度**：到期判断全部惰性——读时比对 `trial_ends_at` / `current_period_end` / `expires_at`，无 cron、无 `@nestjs/schedule`。

## 2. 数据模型（3 张新表）

迁移 `tools/db/migrations/2026-09-29_subscription_billing.sql`（幂等），同步进 `tools/db/schema.sql`（CLAUDE.md 铁律）。

### 2.1 `subscription_plans`（套餐配置，DB seed 维护，本期不做 admin UI）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT AUTO_INCREMENT PK | |
| plan_code | VARCHAR(20) UNIQUE | `month` / `year` |
| name | VARCHAR(50) | 「月卡」「年卡」 |
| price_cents | INT | 价格，**分**（整数，避免小数）；展示层除 100 |
| duration_days | INT | 30 / 365 |
| is_active | TINYINT(1) | 下架后不可下单、不出现在套餐列表 |
| sort_order | SMALLINT | |
| created_at / updated_at | DATETIME(3) | `updated_at` 列级 `ON UPDATE CURRENT_TIMESTAMP(3)`（仓规） |

Seed：月卡 / 年卡各一行，价格由用户在上线前自行 UPDATE（本 spec 不定价格）。

### 2.2 `family_subscriptions`（家长维度，**每家长一行**，upsert）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT PK | |
| parent_id | BIGINT UNIQUE | FK → parents.id |
| status | VARCHAR(10) | `trialing`/`active`/`expired`——**冗余列，仅供运营 SQL**；代码读写一律走 `effectiveStatus(now)` 纯函数推导 |
| trial_ends_at | DATETIME(3) NULL | 试用截止；非试用来源为 NULL |
| current_period_end | DATETIME(3) NULL | 付费周期截止；从未付费为 NULL |
| plan_code | VARCHAR(20) NULL | 当前套餐快照（最近一次 paid 订单的 plan_code） |
| source | VARCHAR(10) | `trial` / `order`（最近一次状态变更来源） |
| created_at / updated_at | DATETIME(3) | |

**`effectiveStatus(now)` 纯函数**（单一真源，服务层导出、guard 与页面共用）：
- `now <= trial_ends_at` → `trialing`
- `now <= current_period_end` → `active`
- 否则 → `expired`（含无行）

**注册钩子**：家长注册（`POST /api/auth/register`）事务内 upsert trial 行，`trial_ends_at = now + TRIAL_DAYS`。`TRIAL_DAYS` 默认 7，`.env` `SUBSCRIPTION_TRIAL_DAYS` 可覆盖。

**存量家长回填**：迁移脚本为所有已有家长插入 trial 行，`trial_ends_at = 迁移执行时刻 + 7 天`（上线时尚无付费用户，统一送一轮试用，公平且避免部署即全员被锁）。

### 2.3 `orders`（订单状态机）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT PK | |
| order_no | VARCHAR(32) UNIQUE | 业务单号：`ORD` + yyyyMMdd + 10 位随机（应用层生成，唯一键兜底重试） |
| parent_id | BIGINT | FK → parents.id，归属校验用 |
| plan_id | BIGINT | FK → subscription_plans.id |
| plan_snapshot | JSON | 下单时刻快照 `{planCode,name,priceCents,durationDays}`——防套餐改价影响历史（与积分兑换单快照同款心智） |
| amount_cents | INT | 应付金额（= 快照 price_cents；coupon 接入后在此扣减） |
| payment_status | VARCHAR(10) | `pending` / `paid` / `cancelled` / `expired` |
| channel | VARCHAR(10) | `wechat` / `alipay` / `manual` |
| channel_trade_no | VARCHAR(64) NULL | 渠道交易号，**UNIQUE**（回调幂等键之一） |
| channel_qr_content | VARCHAR(255) NULL | 下单返回的二维码内容（`code_url` / 支付宝二维码串），家长可重复拉起 |
| paid_at / cancelled_at | DATETIME(3) NULL | |
| expires_at | DATETIME(3) | 待支付超时（下单时刻 + 2h），读时惰性翻转 `pending→expired` |
| coupon_code / coupon_discount_cents | NULL | **本期预留不写** |
| created_at / updated_at | DATETIME(3) | |

索引：`(parent_id, payment_status, id)`（订单历史）、`channel_trade_no` UNIQUE。

## 3. 支付链路状态机

```
pending ──回调验签成功 / confirm-paid 主动查单确认──► paid（单事务：订单置 paid + 订阅续期）
   ├── 家长取消（cancel）──────────────────────────► cancelled（终态）
   └── expires_at 超时（读时惰性翻转）──────────────► expired（终态）
```

- **续期规则**（`renewSubscription(parentId, plan)`，与订单置 paid 同一事务）：
  - `current_period_end` 在未来 → 从该时刻顺延 `duration_days`（不吞天数）
  - 已过期 / NULL / 试用 → 从 `now` 起算
  - `SELECT ... FOR UPDATE` 行锁防并发回调重复续期；同步写 `status='active'`（冗余列）、`plan_code`、`source='order'`
- **回调幂等**（双保险）：① `channel_trade_no` 唯一键；② 已 `paid` 订单收到重复通知直接返回渠道成功应答，不再续期
- **回调丢失兜底**：家长端「我已付款」→ `confirm-paid` → 服务端调渠道查单 API；渠道明确返回已支付 → 走 paid 续期；否则 2004（家长可继续等待或重新下单）
- **超时翻转**：任何读取订单的路径（详情/列表/查单）发现 `pending && now > expires_at` → 顺带置 `expired`（单条 UPDATE，幂等）

## 4. 门禁（SubscriptionGuard）

- 全局 Guard，注册顺序：`JwtAuthGuard` → `RolesGuard` → **`SubscriptionGuard`**。
- 仅当 `role === 'student'` 时校验：`students.parent_id → family_subscriptions`，`effectiveStatus(now) ∈ {trialing, active}` 放行，否则 **403 `{code:2001, message:'订阅已过期，请联系家长续费'}`**。
- **家长 / 管理员一律放行**（家长必须能进订阅中心；家长端只读功能与付费状态无关）。
- **豁免清单（spec 钉死，护栏测试守护）**：
  1. `POST /api/auth/*`（登录注册本身，免 JWT 链路本就不经过）
  2. `GET /api/progress/students/:studentId/star-map`（锁后学生仍能看到星图与锁定态，否则一脸茫然）
  3. `POST /api/billing/callback/:channel`（渠道回调，免 JWT，验签自证）
  4. `GET /api/quota/subscription`（学生端锁定页展示「找家长续费」需要读状态）
- **前端全局处理**：`api.ts` 响应层识别 `code=2001` → 统一跳学生端锁定页（非关键请求如积分徽章失败被吞的现状不变）。
- **性能**：订阅表单行、`parent_id` UNIQUE 索引，每学生请求 +1 次点查；**先不做缓存**，实测慢再议（避免「刚续费还锁着」类缓存事故）。
- **PC App**：锁定的学生 kiosk 内由前端跳锁定引导页，Electron 壳零改动。

## 5. 端点清单（新增 2 分组 + admin 1 端点；API 文档 v4.14 + openapi 同步）

错误码段位：**2xxx = 订阅/计费**（1009 已被 admin 连通性测试占用，3xxx 已被积分兑换占用）。定义：
- `2001` 订阅失效（guard 拦截）
- `2002` 订单状态不允许该操作（如取消已支付单）
- `2003` 支付渠道异常（下单/查单调渠道失败）
- `2004` 渠道未确认支付（confirm-paid 查单未查到已支付）
- `2005` 套餐不存在或已下架

统一响应 `{code, message, data}`（CommonResponse）。

### 5.1 `/api/quota`（家长 + 学生可读；`/usage` 仅家长，学生 403/1003）

| 方法 | 路径 | 校验与逻辑 | 返回 `data` |
|---|---|---|---|
| GET | `/subscription` | JWT 归属（学生只读自己家的）；读时顺带超时订单翻转；`effectiveStatus` 推导 + 剩余天数 | `{status, planCode?, trialEndsAt?, currentPeriodEnd?, daysRemaining, source}` |
| GET | `/plans` | 只回 `is_active=1`，按 `sort_order` | `[{planCode, name, priceCents, durationDays}]` |
| GET | `/usage` | 家长归属校验（学生 403）；周期 = 当前订阅周期（无订阅/试用 = 最近 30 天）；聚合该家长名下学生 `llm_call_logs` 的 input/output tokens（**NULL 不计入、绝不按 0 处理**，另给 `tokensUnknown` 计数） | `{periodStart, periodEnd, calls, inputTokens, outputTokens, tokensUnknown, byDay: [{date, calls, tokens}]}` |

### 5.2 `/api/billing`（家长操作，学生 403/1003）

| 方法 | 路径 | 校验与逐步逻辑 | 错误码 |
|---|---|---|---|
| POST | `/orders` | body `{planCode, channel}`；① 套餐存在且 active（否则 2005）；② 已有该家长 `pending` 订单：**同套餐同渠道** → 直接复用返回（不重复下单、不重复向渠道要码）；**套餐或渠道不同** → 2002（提示先取消旧订单或等 2h 超时——防串单）；③ 建 `pending` 订单（快照 + amount）→ 调适配器下单拿二维码 → 回写 `channel_trade_no`/`channel_qr_content`；渠道失败 → 2003（订单保留 pending，可重试拉码） | 2005/2002/2003 |
| GET | `/orders` | 分页（`page/pageSize`，越界 400/1001 不钳制——仓规），按 id 倒序；读时惰性翻转超时 | `{items, total, page, pageSize}` |
| GET | `/orders/{orderNo}` | 归属校验（1005）；读时惰性翻转；供支付弹层轮询（前端 3s 一次，spec 定稿时由稿 30s 收紧——支付确认场景 30s 体验不可接受） | 订单详情含 `paymentStatus` |
| POST | `/orders/{orderNo}/cancel` | 仅 `pending` 可取消（否则 2002）；置 `cancelled`；**不调渠道关单 API**（2h 超时兜底，本期简化） | 2002 |
| POST | `/orders/{orderNo}/confirm-paid` | 仅 `pending`；调渠道查单；已支付 → 同 paid 续期事务；未支付 → 2004 | 2002/2004/2003 |
| POST | `/callback/{channel}` | **免 JWT**；按渠道验签（微信 APIv3 平台证书 + AEAD_AES_256_GCM 解密 resource；支付宝 RSA2）→ 解析 `order_no`/`trade_no`/支付金额 → 金额与 `amount_cents` 不符记 alert 不入账 → 幂等后 paid 续期事务 → 返回渠道应答格式（微信 JSON `{"code":"SUCCESS"}`；支付宝文本 `success`）；验签失败 warn + 返回失败应答（渠道会重试） | 验签失败 401 |

### 5.3 admin（人工兜底渠道）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/billing/orders/{orderNo}/mark-paid` | `channel='manual'`，无验签（admin JWT + 角色）；与回调同一 paid 续期事务（`FOR UPDATE`，与真实回调竞态安全）；订单已 `paid` → 幂等返回成功。服务线下收款兜底（与积分兑换「线下给现金」同一心智），操作留 admin 操作日志 |

## 6. UI

### 6.1 家长端 `/parent/subscription`（UX P7.1）

状态机（页面级）：

```
loading ──► ready ──┬── 状态卡：生效中（绿）/ 即将到期 ≤7 天（黄）/ 已过期（红）+ 倒计时
                    ├── 套餐选择（月/年卡，选中态）
                    ├── [立即订阅/续费] → paying 弹层
                    └── 订单历史（折叠列表）

paying ──► 二维码展示 → 每 3s 轮询 GET /orders/{orderNo}
   ├── paymentStatus=paid   → success（展示新到期时间，刷新状态卡）
   ├── 用户点取消 / 2h 超时 → cancelled/expired → 回 ready
   └── [我已付款] → confirm-paid ──┬─ 成功 → success
                                    └─ 2004 → 提示「渠道尚未确认，稍后再试」
```

- 入口：家长端侧栏新增「订阅管理」项。
- 顶栏提示条：`即将到期/已过期` 时黄色条（惰性展示口径），**与现有 `AlertBanner`（异常预警）并列渲染、互不混用**——预警是孩子行为问题，订阅是付费状态，两个语义不合并。
- 支付宝降级形态：适配器返回跳转 URL 时弹层改「跳转支付宝支付」按钮（新窗口）。

### 6.2 学生端锁定页 `/student/locked`

- Guard 403/2001 后前端统一跳转；展示「本账号未订阅/已过期，请联系家长续费」+ 订阅状态（读 `/api/quota/subscription`，豁免清单内）+ 「返回登录」按钮。
- 星图可进（豁免），任何学习动作触发 2001 → 回锁定页。

## 7. 边界与错误处理

- **并发回调**：`FOR UPDATE` 行锁 + `channel_trade_no` UNIQUE，重复通知天然幂等。
- **支付中断线/换设备**：订单 2h `expired`（惰性），可重新下单；`paid` 为终态不可取消。
- **渠道不可用**：下单 2003 明确报错，家长可稍后重试或走线下 + admin mark-paid。
- **回调金额校验**：渠道通知金额 ≠ `amount_cents` → 不入账 + admin 预警日志（人工介入）。
- **token 统计**：`input/output_tokens` NULL = 量不到，聚合时单列 `tokensUnknown` 计数，绝不按 0 混入（仓规）。
- **退款 / 发票本期不做**：争议线下处理；`orders` 无退款字段，将来加 `refund_*` 列演进（不改已有列）。
- **套娃风险**：`SubscriptionGuard` 自身查询订阅表不经过 guard（避免递归）；admin 端点不受订阅门禁影响。

## 8. 测试

服务端（vitest，mock 渠道适配器）：
- `effectiveStatus` 纯函数：trial/active/expired 三个边界时刻（含恰好等于截止时刻的语义：**截止时刻当刻仍有效**）
- 续期顺延：有效期内顺延（不吞天数）vs 过期从 now 起算；并发双回调只续一次（行锁模拟）
- 回调幂等：同 `channel_trade_no` 二次通知不重复续期；金额不符不入账
- Guard：trial 未过期放行 / 过期 403+2001 / 家长角色放行 / 豁免清单护栏（新增学生端点默认被锁，豁免须显式加清单 + 改护栏测试）
- 超时翻转：pending + now>expires_at → expired
- 注册钩子：注册事务内 trial 行存在；存量回填迁移幂等（重复执行不重复插）
- 验签单测：构造微信/支付宝报文验签（密钥用测试密钥对）

前端（vitest + testing-library，`globals:false` 手动 cleanup）：
- 订阅中心三态渲染（绿/黄/红）；支付弹层轮询状态机（paid → success；2004 提示）
- 学生锁定页渲染；`api.ts` 2001 → 跳锁定页
- 顶栏订阅提示条与 AlertBanner 并列不互相替代

人工验收（上线前，需商户沙箱/真实商户号）：
- 微信 Native 真实下单 → 扫码 → 回调入账；支付宝当面付同；断网重试、重复回调、金额篡改（沙箱）
- PC App（Electron）内完整走一遍订阅 + 学生锁定/解锁

## 9. 明确不做（本期）

| 项 | 理由 |
|---|---|
| 优惠券/优惠码 | 用户裁决；表已预留，下期立项 |
| AI 额度拦截 | 用户裁决：本期额度只展示（`/api/quota/usage`），拦截下一期 |
| 退款/发票 | 争议线下处理 |
| 套餐 admin UI | DB seed 手工维护足够；改价直接 UPDATE |
| 调度/短信/推送 | 惰性展示替代；破「零调度」现状需单独立项 |
| 自动续费（代扣） | 需用户签约代扣协议，远期 |
| 支付宝跳转形态的完整 UI | 适配器留接口，商户未开通当面付才需要，届时补前端按钮 |

## 10. 交付物清单

1. 迁移 `tools/db/migrations/2026-09-29_subscription_billing.sql`（幂等，含存量家长 trial 回填）+ `schema.sql` 同步
2. 单一模块 `modules/billing/`：订阅状态（`effectiveStatus`/renew/plans）+ 订单状态机 + 渠道适配器 + 回调 + guard 查询，文件内再分层（与 `modules/points/` 多 service 同构）
3. `SubscriptionGuard` 全局注册 + 豁免清单护栏测试
4. 家长注册钩子（auth register 事务）
5. 家长端 `/parent/subscription`、学生端 `/student/locked`、顶栏提示条
6. API 文档 v4.14 + openapi.yaml 同步（新端点全部收 MVP，含 2xxx 错误码）
7. PRD §7.7/§9 加落地说明注记（订阅已实现范围与本期不做项）
