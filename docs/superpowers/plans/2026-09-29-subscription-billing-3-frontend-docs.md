# 订阅收费（③）前端页面 + 文档同步 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 家长端订阅中心（三态 + 扫码支付弹层 + 订单历史）、学生端锁定页、`api.ts` 2001 全局拦截、家长端顶栏订阅提示条；API 文档 v4.14 + openapi + PRD/UX 注记同步。

**Architecture:** 前端零新状态库——页面本地 `useState` + 轮询；`api.ts` 识别 `code=2001` 全局跳锁定页（仅学生会被 2001 拦，家长永收不到，全局跳转安全）。文档是本批一等交付物（API 文档/openapi 同步铁律）。

**Tech Stack:** React 18 + React Router 6 + Tailwind（CSS 变量取色，`style.md` §2 唯一配色）+ vitest + testing-library（`globals:false`，多用例文件手动 `afterEach(cleanup)`）。

**Spec:** `docs/superpowers/specs/2026-09-29-subscription-billing-design.md` §5/§6。

## Global Constraints

- **不用 emoji**，图标线性 SVG；配色只用 style.md §2 token（CSS 变量）；双轨/页面文案不用颜色区分
- 家长端页面挂 `ParentLayout`；学生锁定页**不进任何 Layout**、硬编码 `data-theme="student-day"`（浅停留页口径）
- 组件改动必须补渲染测试；多用例文件 `afterEach(() => cleanup())`
- API 文档与 openapi.yaml 必须同步（端点清单逐一核对）

---

### Task 1: `api.ts` 类型 + 请求函数 + 2001 全局拦截

**Files:**
- Modify: `apps/web/src/services/api.ts`

**Interfaces:**
- Produces（后续任务消费）:

```typescript
export interface SubscriptionStatusView {
  status: 'trialing' | 'active' | 'expired';
  planCode: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  daysRemaining: number;
  source: 'trial' | 'order' | string;
}
export interface PlanView { planCode: string; name: string; priceCents: number; durationDays: number }
export interface UsageView {
  periodStart: string; periodEnd: string; calls: number; inputTokens: number;
  outputTokens: number; tokensUnknown: number; byDay: { date: string; calls: number; tokens: number }[];
}
export interface BillingOrderView {
  orderNo: string; paymentStatus: 'pending' | 'paid' | 'cancelled' | 'expired';
  amountCents: number; planName: string; channel: string;
  qrContent?: string | null; redirectUrl?: string | null;
  expiresAt?: string; paidAt?: string | null; createdAt: string;
}

export function getSubscriptionStatus(): Promise<SubscriptionStatusView>
export function getSubscriptionPlans(): Promise<PlanView[]>
export function getAiUsage(): Promise<UsageView>
export function createBillingOrder(planCode: string, channel: 'wechat' | 'alipay'): Promise<BillingOrderView>
export function listBillingOrders(page: number, pageSize: number): Promise<{ items: BillingOrderView[]; total: number; page: number; pageSize: number }>
export function getBillingOrder(orderNo: string): Promise<BillingOrderView>
export function cancelBillingOrder(orderNo: string): Promise<void>
export function confirmBillingOrderPaid(orderNo: string): Promise<{ orderNo: string; paymentStatus: string; currentPeriodEnd?: string }>
```

（全部走既有 `fetchApi`，路径与方法对应批②端点。）

- [ ] **Step 1: 实现 2001 全局拦截**——在 `fetchApi` 的错误分支（解析出业务 code 之后、throw 之前）加：

```typescript
if (body?.code === 2001) {
  // 学生端硬门禁：订阅失效。全局跳锁定页（家长角色永远不会收到 2001，跳转对其无影响）。
  window.location.assign('/student/locked');
  return new Promise(() => {}); // 不 resolve：让调用方挂起，页面即将整体跳走
}
```

- [ ] **Step 2: 测试**——现有 api 层测试模式（若 fetchApi 有测试文件则追加；没有则此步并入 Task 5 的页面测试覆盖）。断言点：`code===2001` 触发 `window.location.assign`（mock `window.location`）。
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 订阅/计费 API 封装 + 2001 全局跳锁定页"`

---

### Task 2: 学生端锁定页 `/student/locked`

**Files:**
- Create: `apps/web/src/pages/student/StudentLockedPage.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（新增 `/student/locked`，**不挂任何 Layout**，登录态校验沿用现有 RequireRole('student')）
- Test: `apps/web/src/pages/student/StudentLockedPage.test.tsx`

**Interfaces:**
- Consumes: `getSubscriptionStatus()`
- Produces: 锁定页（读豁免端点 `/api/quota/subscription` 展示状态）

- [ ] **Step 1: 页面实现**（骨架，样式类沿用仓内浅停留页风格）：

```tsx
export default function StudentLockedPage() {
  const [data, setData] = useState<SubscriptionStatusView | null>(null);
  useEffect(() => { getSubscriptionStatus().then(setData).catch(() => setData(null)); }, []);
  const statusText = data?.status === 'trialing'
    ? '试用已结束' : data?.status === 'expired' ? '订阅已过期' : '本账号未订阅';
  return (
    <div className="student-theme-container min-h-screen" data-theme="student-day">
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">{statusText}</h1>
        <p className="text-sm text-[var(--text-secondary)]">学习功能需要有效订阅，请联系家长在家长端订阅或续费。</p>
        {data && data.currentPeriodEnd && (
          <p className="text-xs text-[var(--text-secondary)]">到期时间：{data.currentPeriodEnd.slice(0, 10)}</p>
        )}
        <button
          className="rounded-[var(--radius-pill)] bg-[var(--brand-600)] px-6 py-2 text-sm font-semibold text-white"
          onClick={() => { localStorage.removeItem('token'); localStorage.removeItem('username'); localStorage.removeItem('userId'); window.location.assign('/login'); }}
        >
          返回登录
        </button>
      </div>
    </div>
  );
}
```

（「返回登录」的清理键名与跳转路径**以 `LogoutButton` 现有实现为准**——先读 `src/components/business/LogoutButton.tsx`，键名/登出 API 调用照抄，不要自造第二套登出。）

- [ ] **Step 2: 路由注册**——`routeTable.tsx` 里与 `/student/*` 平级处加 `/student/locked`（复用 RequireRole('student') 包裹）。
- [ ] **Step 3: 渲染测试**：expired 文案 / trialing（试用结束）文案 / 「返回登录」存在 / 清理后跳 `/login`。
- [ ] **Step 4: Commit** — `git commit -m "feat(web): 学生端订阅锁定页 /student/locked"`

---

### Task 3: 家长端订阅中心 `/parent/subscription`

**Files:**
- Create: `apps/web/src/pages/parent/ParentSubscriptionPage.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（`/parent/subscription` 挂 ParentLayout，跟随既有 parent 路由写法）
- Modify: 家长端侧栏导航（先读 `src/components/layout/ParentLayout.tsx` 的导航项数组，按既有项格式追加「订阅管理」，图标用线性 SVG）
- Test: `apps/web/src/pages/parent/ParentSubscriptionPage.test.tsx`

**Interfaces:**
- Consumes: Task 1 全部 API 函数

- [ ] **Step 1: 页面状态机**（spec §6.1，完整实现）：

```tsx
type ViewState = 'loading' | 'ready' | 'paying' | 'success';
// ready: 状态卡 + 套餐选择 + 订单历史
// paying: 二维码弹层，3s 轮询 getBillingOrder(orderNo)
//   paymentStatus==='paid' -> success（展示新到期时间，重拉状态）
//   [我已付款] -> confirmBillingOrderPaid：成功 -> success；catch 2004 -> 提示「渠道尚未确认，稍后再试」
//   [取消订单] -> cancelBillingOrder -> 回 ready
// success: 3s 后自动回 ready（或点击关闭）
```

页面结构（数据驱动，不写死价格）：
1. **状态卡**：`active` 绿色基调文案「订阅生效中 · 剩余 N 天」；`trialing` 同样放行语义但文案「试用中 · 剩余 N 天」；`expired` 红色「已过期」；`daysRemaining <= 7 && status !== 'expired'` 加黄色「即将到期」。`currentPeriodEnd` 显示到期日期。状态卡右侧 `planCode` 展示当前套餐名。
2. **套餐卡**：`getSubscriptionPlans()` 渲染，价格 `priceCents / 100` 显示「¥x.x」；选中态高亮（边框 brand 色）；渠道选择两个 radio（微信支付 / 支付宝）。
3. **立即订阅/续费按钮** → `createBillingOrder(planCode, channel)` → 进 `paying`。2002（有他单）→ 文案「已有待支付订单，请先取消」并刷新历史。
4. **支付弹层**：`qrContent` 用纯 CSS/SVG 画二维码**不需要**——直接引既有依赖或 `qrcode.react`？**仓内若无二维码依赖则新增 `qrcode.react`（唯一新增前端依赖，plan 允许）**；`redirectUrl` 非空时改「跳转支付宝支付」按钮（`window.open(redirectUrl)`）。轮询 `setInterval(3s)` 挂 `useEffect([view, orderNo])`，清理函数必须 clearInterval（`StrictMode` 双跑不重复弹）。
5. **订单历史**：默认收起，展开调 `listBillingOrders(page=1, pageSize=10)`；行内状态徽标（pending 黄/paid 绿/cancelled·expired 灰）+ 金额 + 时间；pending 行带「取消」按钮。
6. **AI 用量卡**（只展示）：`getAiUsage()` 渲染 calls/inputTokens/outputTokens；`tokensUnknown > 0` 显式注明「其中 N 次调用量不到 tokens，未计入」（NULL≠0 仓规）。

- [ ] **Step 2: 路由 + 侧栏入口**——导航项格式照抄既有项（label「订阅管理」+ 线性 SVG 图标）。
- [ ] **Step 3: 渲染测试**（mock api 层，`afterEach(cleanup)`）：
  - `active`/`trialing`/`expired` 三态状态卡文案与高亮类
  - 套餐卡渲染价格（`priceCents/100` 精确断言，如 19800 → ¥198）
  - `paying` 弹层：mock `getBillingOrder` 轮询返回 paid → 进入 success 文案
  - 2002 下单失败 → 「已有待支付订单」文案
  - 用量卡 `tokensUnknown` 注记存在
- [ ] **Step 4: 跑测试 + Commit** — `git commit -m "feat(web): 家长端订阅中心（三态 + 扫码支付弹层 + 订单历史 + AI 用量）"`

---

### Task 4: 家长端顶栏订阅提示条

**Files:**
- Create: `apps/web/src/pages/parent/SubscriptionNoticeBar.tsx`
- Modify: `apps/web/src/components/layout/ParentLayout.tsx`（在 `AlertBanner` 旁**并列**渲染，不合并、不互斥）
- Test: `apps/web/src/pages/parent/SubscriptionNoticeBar.test.tsx`

**Interfaces:**
- Consumes: `getSubscriptionStatus()`
- Produces: 顶栏条——`expired` 红「订阅已过期，学生端已锁定，请续费」；`daysRemaining <= 7` 黄「订阅即将到期，剩余 N 天」；其余不渲染。点击整条跳 `/parent/subscription`。挂载时拉一次状态（不做轮询——惰性口径，家长切页自然刷新）。

- [ ] **Step 1: 组件 + 接入**（失败拉取静默不渲染——提示条永不阻断家长端）
- [ ] **Step 2: 渲染测试**：expired 红条 / 临期黄条 / 正常不渲染；`ParentLayout` 内与 `AlertBanner` 同时存在互不影响（并列断言）。**护栏断言：SubscriptionNoticeBar 与 AlertBanner 是两个独立组件实例，不是同一组件的两种文案**（防后人合并语义——预警=孩子行为，订阅=付费状态）。
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 家长端顶栏订阅提示条（与预警 Banner 并列）"`

---

### Task 5: 前端全量 + 手工走查清单

- [ ] **Step 1: 全量测试 + tsc**：`cd apps/web && npm test && npx tsc -b` 全绿
- [ ] **Step 2: 手工走查**（本地 dev，mock 渠道后端）：家长下单 → 二维码弹层 → mock 回调 → success；学生端把 `trial_ends_at` 改过期 → 刷新任意学生页 → 落锁定页；星图可看；「返回登录」可用。走查完把时刻改回。

---

### Task 6: 文档同步（API v4.14 + openapi + PRD + UX）

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-产品需求文档.md`
- Modify: `docs/UX-UI设计文档.md`（P7.1 节加【实现状态】注记）

- [ ] **Step 1: API 文档**：
  1. §4.14 Quota 整节重写为 3 个已实现端点（subscription/plans/usage，MVP；usage 标注「仅家长 + rolling 30 天口径 + tokensUnknown 语义」）
  2. §4.15 Billing 整节重写：家长 5 端点 + `POST /callback/{channel}`（免 JWT、`@HttpCode(200)`、按渠道应答格式）标 MVP；错误码 2001-2005 定义进错误码表
  3. §4.17 Admin 分组补 `POST /api/admin/billing/orders/{orderNo}/mark-paid` 行
  4. §2 分组总表：Quota/Billing 两行从 P2 占位改为已实现语义（服务归属 Billing Service → `modules/billing`）
  5. §5.6 数据流重写为「实现态」：下单→二维码→回调→续期单事务；confirm-paid 兜底分支
  6. §9 加 v4.14 变更日志（一条写全：表、guard、豁免清单、端点、错误码、轮询 3s、usage 口径近似）
- [ ] **Step 2: openapi.yaml**：新增 9 个 path（quota 3 + billing 5 + callback 1）+ admin 1 + schemas（`SubscriptionStatusView/PlanView/UsageView/BillingOrderView`），全部记实际返回码（POST /orders 记 `'201'`，callback 记 `'200'`）。
- [ ] **Step 3: PRD 注记**：
  - §7.7「订阅与额度管理」段尾加落地说明：已实现范围（微信 Native/支付宝当面付扫码、按家长全家共享、注册送 7 天试用、硬门禁 2001、惰性提醒、admin mark-paid 兜底）+ 本期不做（优惠券、AI 额度拦截——usage 仅展示且为 rolling 30 天近似口径、退款、自动续费）
  - §9 商业模式段尾加同款落地说明（指向 §7.7，不重复展开）
- [ ] **Step 4: UX 文档**：P7.1 节顶部加【实现状态】注记（页面路径、三态、支付弹层 3s 轮询、与学生锁定页/顶栏条的关系），与 spec §6 一致。
- [ ] **Step 5: 端点清单核对**——按 CLAUDE.md 检查清单逐项核对 API 文档 §4 与 openapi paths 数量一致（本批净增 10 path）。
- [ ] **Step 6: Commit** — `git commit -m "docs: 订阅收费 v4.14 —— API 文档/openapi/PRD/UX 四处同步"`

---

### Task 7: 批③收尾

- [ ] **Step 1: 两端全量 + build**：`apps/server && apps/web` 各自 `npm test`；`apps/web npm run build`（**披露**：会覆盖本机 dev server 正在服务的 dist）
- [ ] **Step 2: 真渠道人工验收清单移交**（spec §8，需商户沙箱/正式商户号）：微信 Native 真实下单扫码回调、支付宝当面付同、重复回调、金额篡改、PC App 内完整流程。逐条写在 `docs/ai-core-changelog.md` 待办节。
