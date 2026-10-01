# 家长端移动端（PWA 先行）设计 spec

日期：2026-10-01
状态：已与用户逐节确认（形态/范围/触达/管控/访问环境五问 + §1–§4 逐节过审）

## 1. 背景与需求来源

- PRD §5：「后续可考虑移动端，但首发聚焦 WebApp + PC App」——本批启动的正是这一步。
- PRD §7.8「后续规划（物理隔离）」：家长管理功能迁移至独立家长端 Web 应用 / APP。本批以 **PWA** 形态承载家长移动场景，不是新功能开发，而是**形态迁移**。
- 硬约束：不做小程序（CLAUDE.md 规则 8）。移动 App（原生/混合）合法，但被环境否决（见 §2）。

## 2. 环境事实与形态裁决

| 决策点 | 裁决 | 理由 |
|---|---|---|
| 交付形态 | **PWA 先行** | 本机磁盘仅剩 **14GB**（228GB 已用 94%）。Xcode 全套 ~35–40GB 不可行；Android Studio+SDK ~8–12GB 贴边。原生双端在本机不可行。PWA 零磁盘占用。 |
| 功能范围 | **核心场景先行** | 家长端 Web 按 iPad 横屏 ≥1024px 主断点设计，手机竖屏是新主断点；核心场景先行验证效果后再扩。 |
| 预警触达 | **页内轮询** | 沿用现有 30s 轮询语义；系统级 Web Push（VAPID+订阅管理+iOS 16.4+ 主屏限制）是独立一批，本期不做。 |
| 管控操作 | **纳入 v1** | 时效性价值最高（预警来了立刻处理）；页面少，增量小。 |
| 访问环境 | **家里局域网（现状 HTTP）** | 与 PC App 同一部署形态；HTTPS 依赖的能力明确降级（见 §5）。 |

**后续升级路径**：PWA 路由组与数据层可原样被 Capacitor 壳复用（复用 PC App 的壳思维）；将来要上架再评估，本批投入不浪费。

## 3. 范围

**v1 包含**：PWA 化（manifest + iOS meta）+ 移动路由组 `/m/parent/*` + 4 个页面（仪表盘/预警/错题本/管控）+ 「更多」占位 + 登录落点分流 + 交付文档（添加到主屏幕步骤）。

**v1 明确不做（非目标，别当缺陷修）**：
- Service Worker / 离线缓存（局域网 HTTP 下 Chrome 拒绝注册 SW，做了是死代码）。
- 系统级推送（同上，属独立批）。
- 其余 9 个桌面页面（订阅、积分/兑换、报告、AI 对话记录、目标、消息中心、账号、学习配置、学生管理）的移动适配 → 「更多」里列出并指向电脑端。
- 自动跳转：在手机上访问 `/parent/*` 不强制跳 `/m/parent`（iPad 横屏继续用桌面版），只在登录落点按视口分流一次。
- 任何后端端点改动。

## 4. 架构

### 4.1 路由组（方案 B：独立移动页面组）

与 `/parent/*` 平行的新路由组，同挂 `RequireRole role="parent"`：

```
/m/parent                 → Navigate 到 /m/parent/dashboard
/m/parent/dashboard       → 学情仪表盘
/m/parent/alerts          → 预警 + 裁决通知 + 站内消息未读
/m/parent/errors          → 错题本
/m/parent/controls        → 管控（锁定设置/远程解除/进出时间）
/m/parent/more            → 「更多」入口列表
/m/parent/more/:name      → 「该功能请在电脑端使用」占位页
```

- 新建 `MobileParentLayout`（`src/layout/`）：顶部「孩子切换」条 + 裁决/订阅通知条 + **底部 Tab 导航**（仪表盘 / 错题 / 管控 / 更多），单栏竖屏。
- 移动端页面组件放 **`src/pages/parent-mobile/`** 新目录，不复用桌面页面组件。
- 路由表进 `routes/routeTable.tsx`（保持「路由级测试用 createMemoryRouter 挂真表」的既有做法）。

### 4.2 复用与不复用（方案 B 的边界）

| 复用（原样引用） | 不复用（新建） |
|---|---|
| `services/api.ts` 全部接口函数与类型 | 页面组件（13 个桌面页一行不动） |
| Zustand stores（登录态等） | `ParentLayout` 侧栏外壳 |
| `parent` 主题 token（`data-theme="parent"`） | 桌面页的表格/多栏卡片布局 |
| `RequireRole`、登录分流（手机号→家长） | — |
| 共享 Markdown 渲染配置（图片/rehype-raw/repairHtml/KaTeX） | — |

登录落点：登录成功后按视口宽度分流（竖屏窄屏 `<768px` → `/m/parent`，否则现状 `/parent`）；`LoginPage` 本身补必要的竖屏响应式微调（共享组件，改动需过既有测试）。

### 4.3 跨孩子状态纪律（仓规，硬约束）

- 「当前选中孩子」放轻量 `mobileParentStore`，与桌面端互不干扰。
- 派生状态必须**带 `studentId` 归属**：家长切孩子不重挂载，只按自身维度守卫会画出上个孩子的数据。
- 列表页换孩子**必须回第 1 页**（`useEffect(() => setPage(1), [studentId])`）。

## 5. PWA 化（HTTP 现实约束下的降级口径）

- `apps/web/public/manifest.webmanifest`：`display: standalone`、`theme-color` 取 parent 主题底色、图标为**线性 SVG 风格品牌图形**（遵守「不用吉祥物/emoji」硬规则；iOS 需提供 PNG apple-touch-icon）。
- `index.html` 补 `apple-mobile-web-app-capable` / `apple-mobile-web-app-status-bar-style` / `apple-touch-icon` / `theme-color`。
- 交付预期（写进交付文档，不写进代码）：
  - iOS Safari：分享菜单「添加到主屏幕」→ 全屏无浏览器框。**可用**。
  - 安卓 Chrome：HTTP 下不弹安装横幅，手动「添加到主屏幕」可用（无全屏样式保证）。**降级可用**。
  - 两者都**无离线缓存**（SW 注册不了）——家长需在局域网内访问，符合现状部署形态。

## 6. 页面明细（全部只用现有端点，零后端改动）

共用骨架：顶部「孩子切换」条（`getParentStudents`）+ 裁决/订阅通知条。每页「骨架 + 空态 + 错误重试」三态齐备。

### 6.1 仪表盘 `/m/parent/dashboard`
- 数据：`getParentDashboard` + `getParentStudyTime` + `getParentTodayUsage` + `getParentMastery`。
- **学习时长（会话）与近 7 天活跃天数是两套口径、并列展示、文案区分**（既有硬约定，勿合并）。
- 竖屏单栏卡片堆叠，可点展开；薄弱点只读展示，不做图谱交互。

### 6.2 预警 `/m/parent/alerts`
- 数据：`getParentUnreadAlerts`（进页未读数）+ `getParentAlerts`（分页）+ `markParentAlertRead`；裁决通知 `listUnreadBillingNotices` + `ackBillingNotice`（「知道了」就地消失）；站内消息未读 `getUnreadMessageCount`（只显示计数）。
- 轮询放**移动端自己的 hook**（30s 语义不变；不与桌面页共享定时器实例，避免互相重置）。
- **落地说明（2026-10-02）**：裁决 / 订阅 / 未读预警三块上移到外壳顶栏（MobileParentLayout 复用 AlertBanner / BillingNoticeBar / SubscriptionNoticeBar，全局可见），预警页内只做**列表 + 逐条 ack + 站内消息未读计数**——覆盖面比本节原稿（页内轮询 + 页内通知条）更广，以实现为准。

### 6.3 错题本 `/m/parent/errors`
- 数据：`getParentErrors`（分页 + 学科筛选 + `track=main|training` 口径沿用）。
- 列表 + 抽屉看题面/学生答案/正确答案（共享 Markdown 渲染配置）。
- **落地说明（2026-10-02）**：`ParentErrorQuestion` **没有 answer 字段**（`api.ts` 真源），本节原稿「学生答案/正确答案」超出 API 能力——移动端展开详情 = 题面 + 「答案与解析请在电脑端查看」引导，不新造数据源，以实现为准。

### 6.4 管控 `/m/parent/controls`
- 数据：`getParentControls` / `putParentControls`（`session_lock_minutes` 1..480，`NULL`=显式解除）、`issueParentDeviceCommand`（远程解除）、`getParentStudyTime`（进出时间**列表**，不是聚合）。
- 错误处理：无进行中会话时后端 409/1001 → 前端原样展示错误文案，不静默。

## 7. 测试策略

- 每个新页面渲染测试（三态 + 关键交互：远程解锁 409 文案、孩子切换回第 1 页、裁决通知 ack 消失）。
- 路由表测试补 `/m/parent/*` 用例；登录落点分流逻辑单独测试。
- 多用例文件必须自写 `afterEach(cleanup)`（`globals:false` 仓规）。
- 桌面端既有测试零改动；`LoginPage` 微调如碰 DOM 结构，同步修它的测试。

## 8. 文档同步

- UX-UI 设计文档补「家长移动端」章节（断点、布局、导航形态）。
- API 文档无端点变化，不更新（仅引用既有端点）。
- `docs/ai-core-changelog.md` 记录本批。
- 交付文档：双平台「添加到主屏幕」步骤作为本 spec 附章（实施时补全），不放独立文档。

## 附章 A：家长手机「添加到主屏幕」步骤

前提：手机与服务器在同一局域网，浏览器打开 `http://192.168.1.5:5173`（服务器 IP 变了就换）。

**iOS（Safari）**：
1. 底部分享按钮（□↑）→ 2. 「添加到主屏幕」→ 3. 确认「添加」。
   桌面图标全屏打开；状态栏样式为系统默认。

**Android（Chrome）**：
1. 右上角菜单（⋮）→ 2. 「添加到主屏幕」→ 3. 确认「添加」。
   注意：局域网 HTTP 下 Chrome 不弹自动安装横幅，必须手动添加；全屏样式不作保证。

**已知降级**：无离线缓存（Service Worker 需 HTTPS）；无系统级推送（本期未实现）。
预警与通知需打开应用查看（页内 30s 轮询）。

**已知限制**：顶栏行为预警条（AlertBanner）点击后进入移动端预警页（/m/parent/alerts，底部『预警』Tab 同入口）。
