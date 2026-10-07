# 家长移动端第二批 B（2B）设计 spec：积分与兑换 / 学习报告 / AI 对话记录

日期：2026-10-06
状态：范围与积分页信息架构经用户裁决（入口与 2A 一致走「更多」；页内保留四区块 Tab 条），设计已过审
前置：v1 + 2A 已上线（spec `2026-10-01-parent-mobile-pwa-design.md` / `2026-10-06-parent-mobile-batch2a-design.md`）；本批延续全部架构裁决

## 1. 背景与范围

2A 后「更多」页仍指向电脑端的 4 项里，本批搬上 3 个：

```
/m/parent/points      → 积分与兑换（页内 Tab：规则 / 兑换 / 奖励册 / 记录）
/m/parent/report      → 学习报告（weekly / monthly + 图表）
/m/parent/chat-logs   → AI 对话记录（会话列表 + 逐句回放）
```

- 「更多」页：3 项 stub 改 live 入口；占位只剩「订阅管理」（用户裁决延后）。
- `ParentViewportGate` 映射：`points / report / chat-logs` → 同名移动页；`rewards` →
  `/m/parent/points`。
- 底部 Tab 不变（仪表盘 / 预警 / 错题 / 管控 + 更多）。

**2B 后「更多」页不再有任何占位项**（订阅待用户立项时回归）。

## 2. 硬约束（继承 v1/2A 全部）

- 零后端改动（端点清单见 §4，名称已对 `api.ts` 真源）；桌面页与其测试零改动。
- 复用 `services/api.ts`、`useParentStudentStore`、token、三条通知条、`ParentViewportGate`；
  新组件放 `src/pages/parent-mobile/`；测试自写 `afterEach(cleanup())`。
- 换孩子：列表回第 1 页；派生状态带 `studentId` 归属；**异步 load 必须 cancelled 守卫**
  （MobileControlsPage / MobileGoalsPage 两次事故教训）；换孩清编辑态/草稿。
- 配色全 token；不用吉祥物/emoji。
- **验收必经 Playwright WebKit（390×844）**。
- 页内数据有未保存草稿时，切 Tab / 换孩子**必须拦截确认**（积分页桌面已有此机制，照搬）。

## 3. 积分与兑换 `/m/parent/points`（信息架构）

- 入口与其它功能一致：「更多」→ 单一页面。
- **概览卡常驻**（Tab 之上）：`MyPoints` 的 余额 / 累计获得 / 今日已得 / 段位与进度条
  （`level` / `nextLevel` / `pointsToNextLevel` / `progressPercent`，满级时 `nextLevel=null`）。
- **页内横向 Tab 条（可横滑）**，四区块 + `?tab=` 深链（`useSearchParams`，未知/缺失归一为
  首个 Tab）；**未保存草稿保护**照搬桌面：面板注册 dirty 守卫，切 Tab / 换孩子前拦截确认。

### 4.1 Tab「规则」（`getParentPointRules` + `saveParentPointRules`）
- 九类任务的分值档位 / 每日上限 / 启用开关（整表结构以 `MyPointRules` 为准）。
- 竖屏表单：每任务一卡，档位行内编辑；保存整表 PUT；未保存切走触发草稿守卫。

### 4.2 Tab「兑换」（`getParentPointsSettings` + `saveParentPointsSettings` + `redeemParentPoints`）
- 兑换设置（汇率/开关）与兑换表单同 Tab（桌面同构：设置保存成功版本号透传给兑换表单）。
- 兑换：输入积分数 → 金额按汇率推导展示 → `redeemParentPoints`；
  余额不足 / 未达段位门槛 / 奖励下架 / 兑换关闭分别被拒（后端文案原样展示）；
  **兑换不可撤销**（PRD §7.13 已知限制）——提交按钮前二次确认。

### 4.3 Tab「奖励册」（`getParentRewardCatalog` + `saveParentRewardCatalog`）
- 奖励项列表 CRUD（含已下架行，整表 PUT 原样带回）；可设段位门槛。
- 竖屏：每项一卡（名称/所需积分/门槛/上架状态），编辑行内展开。

### 4.4 Tab「记录」（`getParentPointLedger(studentId, page, pageSize?)` 分页 + `getParentRedemptions(studentId, page)` 分页）
- 积分流水（正/负、任务名、时间）与兑换记录两个子节，各自分页；换孩子回第 1 页。

## 5. 学习报告 `/m/parent/report`

- 数据：`getParentReport(studentId, period)`（`ParentReportPeriod = 'weekly' | 'monthly'`）、
  `getParentStudyTime(studentId, from)`、`getParentMastery(studentId, limit)`。
- 顶部 weekly / monthly 切换（切换整页重拉，带 cancelled 守卫）。
- 区块（沿用桌面 ParentReportPage 结构，竖屏单栏）：
  1. 统计卡（答题数/正确率/考试场次等 `data.stats`）
  2. **正确率趋势**：复用 `@/components/business/parent/ChartLine`（SVG 自适应宽度）；
     `rate === null` 的点**跳过**（桌面硬注释：画 0 会被读成全错）
  3. **各学科答题量**：复用 `ChartBar`
  4. 学习时长（会话口径 + 活跃天数**两套口径并列**，v1 仪表盘同款文案）
  5. 薄弱知识点（`getParentMastery`，覆盖率三计数一起展示）
- 换孩子回第 1 页（period 保持）；派生状态带归属。

## 6. AI 对话记录 `/m/parent/chat-logs`

- 列表：`getParentChatLogs({ studentId, page, ...筛选 })` → `ParentChatLogPage`
  （track/scene/from/to/q 筛选沿用桌面参数，移动端 v1 先保留 track + q 两个高频筛选，
  其余隐藏）；分页（上一页/下一页）。
- 回放：点会话 → `getParentChatLogDetail(studentId, dialogueId): ParentChatLogDetail`
  → 消息按角色分侧（孩子左 / AI 右或反之，与桌面回放一致）+ Markdown 渲染
  （共享配置：图片 / rehype-raw / repairHtml / KaTeX）。
- 失败语义照搬桌面 `detailFailure`：回放 1002（会话不属于该学生等）显示内联失败条，
  不弹全页错误。
- 回放形态（定稿）：**点会话 → 整页回放 + 页内「返回列表」**（桌面是列表 + 右侧详情，
  移动端竖屏改整页；不做页内左右分栏）。

## 7. 测试策略

- 每页三态 + 关键交互：积分草稿守卫拦截、兑换二次确认与拒绝文案、报告 rate=null 跳过、
  回放 1002 失败条、分页换孩回 1 页。
- 路由表测试补 3 条；`ParentViewportGate` 测试补映射。
- **WebKit 端到端走查**（390×844）为验收必经。

## 8. 文档同步

UX 文档 §5.10、changelog 新条目、「更多」stub 清零说明。

## 附章

双平台「添加到主屏幕」见 v1 spec 附章 A（不变）。
