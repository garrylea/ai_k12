# 闯关积分体系 · 家长端 UI 实施计划（三份之三）

- 日期：2026-09-18
- 依据：`docs/superpowers/specs/2026-09-17-gamification-points-design.md` §6.2、§7.3、§8.2、§10（前置 C）、PRD §7.13、`docs/UX-UI设计文档.md` P6.7
- 前置：**计划一（后端）已完成**（`2f58fce..f89d063`）；**计划二（学生端 UI）** 提供 `LevelIcon` 与 `api.ts` 的部分积分类型
- 状态：**待实施**

---

## 0. 范围与依赖

本文只做**家长端**：当前孩子上下文、积分概览、分值规则配置、奖励清单管理、兑换（换钱/换奖励）、兑换记录与兑现状态、兑换设置（汇率/开关）。

### 0.1 前置依赖：一个**尚未完成**的前置项

spec §2.4 与 §10.3 把「家长端当前查看哪个孩子」列为动工前置，但**至今没做**：

- `store/parentStudentStore.ts` **不存在**（`apps/web/src/store/` 只有 auxiliary/chat/learnContext/practice/refinery/theme 六个 store）。
- `ParentLayout.tsx:56-61` 的下拉是**硬编码假数据**（「小明（三年级）」，无 onClick、无数据源）。
- `sidenote`：`/parent/students/:id/config`（`StudentSubjectConfigPage`）是**按路径**取 studentId 的，**不受本 store 影响**，本次不动它。

→ 计划三的 Task 2 必须先补这个前置，否则后面所有「按学生」的页面没有锚点。

### 0.2 计划一交付的家长端接口（本文全部依赖，均已实现且有测试）

| 方法 | 路径 | 返回形状 |
|---|---|---|
| GET | `/api/parent/students/:id/points` | `PointsOverview`（见 §0.3） |
| GET | `/api/parent/students/:id/points/rules` | `{ tasks:[{taskCode,taskName,tiers:[{tierKey,tierLabel,points,dailyLimit,isActive,completedToday,remainingToday}]}] }`，**含已下架档位** |
| PUT | `/api/parent/students/:id/points/rules` | 200，body `{rules:[{taskCode,tierKey,points,dailyLimit,isActive}]}` → `null` |
| GET | `/api/parent/students/:id/points/ledger?page&pageSize` | `{items:[{id,kind,title,points,createdAt,refType}],total,page,pageSize}` |
| GET | `/api/parent/students/:id/reward-catalog` | `RewardCatalogView[]`（**含已下架行**） |
| PUT | `/api/parent/students/:id/reward-catalog` | 200，body `{items:[{id?,name,description,pointsCost,minLevelCode,isActive,sortOrder}]}` → `RewardCatalogView[]` |
| POST | `/api/parent/students/:id/points/redeem` | **201**，body `{type:'cash',points}` 或 `{type:'reward',catalogId}` → `RedeemResult` |
| GET | `/api/parent/students/:id/redemptions?page` | `{items:[RedemptionView],total,page,pageSize}`（pageSize 固定 20） |
| PATCH | `/api/parent/redemptions/:id` | 200，body `{status:'pending'\|'fulfilled'}` → `null`。**路径无 studentId**，服务端自己反查归属 |
| GET | `/api/parent/students/:id/points/settings` | `{pointsPerYuan,rewardRedemptionEnabled}` |
| PUT | `/api/parent/students/:id/points/settings` | 200，body 至少一个字段 → `{pointsPerYuan,rewardRedemptionEnabled}` |

**本文新增 1 个后端端点**（理由见 Task 1，缺口是真实的）：

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/points/levels` | `{ levels:[{code,name,index,threshold}] }`（9 项，有序） |

### 0.3 关键返回形状（照抄后端 DTO，勿自创字段名）

```ts
interface LevelInfo { code: string; name: string; index: number; threshold: number }

interface PointsOverview {
  balance: number; totalEarned: number; todayEarned: number;
  level: LevelInfo;
  nextLevel: LevelInfo | null;          // 满级（王者）为 null
  pointsToNextLevel: number | null;     // 满级为 null
  progressPercent: number;              // 0-100 整数，满级 100
}

interface PointRuleTierView {
  tierKey: string; tierLabel: string; points: number;
  dailyLimit: number | null;            // null = 不限
  isActive: boolean;
  completedToday: number | null;        // 未算时为 null
  remainingToday: number | null;        // dailyLimit=null 或未算时为 null；已超限按 0 封底
}

interface RewardCatalogView {
  id: number; name: string; description: string | null;
  pointsCost: number; minLevelCode: string | null;
  isActive: boolean; sortOrder: number;
}

interface RedemptionView {
  id: number; type: 'cash' | 'reward';
  pointsSpent: number; cashAmount: number | null;
  rewardCatalogId: number | null; rewardName: string | null;
  status: 'pending' | 'fulfilled'; note: string | null; ledgerId: number | null;
  createdAt: string; fulfilledAt: string | null;
}

interface RedeemResult {
  redemption: RedemptionView;
  balance: number; totalEarned: number; level: LevelInfo;   // 兑换后实时段位，永不下降
}
```

### 0.4 与计划二的分工（勿越界）

- **不要**在家长端复用 `PointsToast` / `FireworksCanvas` / `CelebrationOverlay`——那些是学生端的游戏化反馈，家长端是**商务白蓝、强制日间、无装饰动效**（UX §2.1.3）。
- `LevelIcon` **可以**复用（`currentColor`，家长主题下 `--brand-500` = `#2563EB` 自动变蓝，见 `global.css:157-161`）。
- 家长端**不改**学生端任何页面（学生端自己的「兑换记录」缺口见 §6 遗留）。

---

## 1. 全局约束（每条都会被审查）

### 1.1 计划一带过来的必做项（漏了会真坏）

1. **`GET points/rules` 含已下架档位**（`listGrouped` 有意不过滤 `is_active`）。家长页必须显示它们 + 提供「重新启用」，**不能**只渲染 `isActive === true` 的行。
2. **`PUT points/rules` 每条必须带全三个字段**（`points` / `dailyLimit` / `isActive`）——controller 的 Zod 三个都是必填，缺一个直接 400 1001。**只发改动的那一行**也不行（那行也得三字段齐全，这是允许的；但整卡保存更稳）。
3. **`PUT reward-catalog` 是整表语义**：`RedemptionService.saveCatalog` 对「清单里消失的 id」做**软删**。因此保存时必须**把当前列表原样整表提交**（含已下架行的 `isActive: false`）。漏回传 `isActive` 会把已下架的奖励**静默重新上架**（Task 8 审查点名）。
4. **`dailyLimit` 只允许 `null` 或 1–99**。填 `0` 会让 `award()` 的上限判断恒真 → **该档位永久不发分**（后端 400 1001）。前端输入框必须把「空 = 不限」做成一等公民，并在文案里写清「0 无效」。
5. **`points` 只允许 0–9999 整数**（后端 400 1001）。负数会写负流水、拉低 `total_earned` → **破坏「段位只升不降」**。
6. **兑换余额是条件 UPDATE，不是先读后写**（计划一 Task 6 Important 修复）。并发下余额不足会返回 3001，前端必须按错误处理，不要本地判余额就乐观放行。
7. **`minLevelCode` 需要全量段位表**，而后端**当前没有任何端点回传 9 个段位**（`PointsOverview` 只给 `level` + `nextLevel`）。→ Task 1 补 `GET /api/points/levels`；**不要**在前端硬编码段位表（spec §3.1 明确「单一真源在后端」）。
8. **兑换不可撤销**（spec §7.3 已知限制）。确认弹窗必须明写这一点。

### 1.2 仓内硬规则

1. **不用 emoji**；图标必须是**线性 SVG**（`LevelIcon` 已合规）。
2. **不引入新色板**：家长端只用 `style.md` §2.3 的 token（`--brand-500 #2563EB` / `--brand-400` / `--brand-600` / `--brand-100` + `--success/--warning/--error/--info`）。段位图标在家长端统一 `text-[var(--brand-500)]`（**不做**学生端那套明度阶——家长端的重点是「配置表」而不是「打怪」）。
3. **`data-theme="parent"` 强制日间**，无主题切换（`ParentLayout` 已 `setMode('parent')`）。新页面不要引入 `student-theme-container`。
4. iPad 横屏（≥1024px）是主断点；配置表在 ≥1024 用多列栅格，`<1024` 单列堆叠。
5. **不要动** `ParentLayout` 的假 Banner（`hasAlert = true`，第 31 行）——那是「异常预警」pipeline 的地盘，本次不碰。
6. 组件改动**必须补渲染测试**。`@testing-library/react` 配 `globals: false`：**多用例文件必须自己写 `afterEach(() => cleanup())`**。
7. `services/api.ts` 是单文件、按 `// --- 模块 ---` 分区；`fetchApi` 自动带 Bearer 并解 `{code,message,data}`，非 0 抛 `ApiError`（含 `code`/`message`/`status`）。
8. 状态用 Zustand（`themeStore` 是参照）；家长端**不**用持久化存敏感信息，只存 `studentId`。
9. **测试与文档同步铁律**：新增端点必须同步 `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml`（两份互为对照）。注意 **Nest `@Post` 默认 201**；`PUT`/`PATCH`/`GET` 默认 200。
10. **本地起后端只用 `node dist/main.js`**（`npx tsx src/main.ts` 的 DI 是坏的）；验证端点时**禁止 pkill 别人的进程**，需要端口就换一个。

---

## 2. 页面与组件契约（先定接口，再并行做）

### 2.1 `store/parentStudentStore.ts`

```ts
interface ParentStudentState {
  studentId: number | null;
  setStudentId(id: number | null): void;
}
```

- Zustand + `persist`，`name: 'parent-current-student'`，**只持久化 `studentId`**（不存名字/年级，避免展示过期信息）。
- **不做**「拉取学生列表」——那是页面的职责；store 只当被动的锚点。
- **失效回落**：`ParentLayout` mount 时（以及 `location.pathname` 变化时）拉一次 `listMyStudents()`：
  - 列表为空 → `setStudentId(null)`，顶部显示「还没有孩子账号」+ 链接到 `/parent/students`；**主区**由 SubRoute 自己渲染空态（见 §2.3）。
  - 列表非空且当前 `studentId` 不在其中（换账号 / 被删 / 上一个家长遗留）→ 回落到**第一个**学生并 `setStudentId`。
  - **默认选第一个**（首次进家长端 localStorage 为空时同此路径）。
- ⚠️ 不要把 `listMyStudents()` 放进 store 的 setter 里：`ParentLayout` 已有 `loadUnread` 的 pattern，跟随它。

### 2.2 `components/layout/StudentSwitcher.tsx`（家长端顶部下拉）

```ts
interface StudentSwitcherProps { className?: string }
```

- 数据源：`listMyStudents()`（组件内自己拉；与 store 的校验逻辑合并成一处，避免两处各拉一次）。
- 展示：头像（名字首字）+ `name` + 段位小图标（**可选，见下**）+ `▼`。
  - 段位图标需要每个孩子的 `points` 概览——会引入 N 次请求。**本期不做**：只显示「名字 + 年级」。理由写进代码注释，避免后人以为是漏了。
- 交互：点击展开菜单（`role="menu"`，`aria-expanded`），列出全部孩子；选中项打勾；点外部 / Esc 关闭。
- 0 个孩子：不渲染下拉，渲染「还没有孩子账号」+ 链接。
- 1 个孩子：**照常渲染下拉**（保持布局稳定，与「多孩切换」P6.8 的可扩展性一致）。

### 2.3 `pages/parent/ParentPointsPage.tsx` 骨架

路由：**沿用已有占位** `/parent/rewards`（spec §8.2 指定），不新增路由。页面顶部 Tab 用 `useSearchParams` 深链：

| Tab | `?tab=` | 内容 |
|---|---|---|
| 积分规则 | `rules`（**默认**） | §2.4 |
| 奖励清单 | `catalog` | §2.5 |
| 兑换 | `redeem` | §2.6 |
| 兑换记录 | `history` | §2.7 |

- 未知 / 缺省 `tab` → 归一成 `rules`（**不报错、不空页**）。
- **概览卡常驻**在 Tab 之上（四个 Tab 都看得到）：`LevelIcon`（size 40）+ 段位名 + 可用积分 / 累计积分 / 今日获得 + 进度条 + 「距下一档还差 N 分」；满级（`nextLevel === null`）→ 进度条 100% + 「已达最高段位」。
- **概览加载态**：骨架屏。**绝不**先渲染「劈柴 0 分」再跳成真实值（孩子/家长会以为积分归零，spec 明写）。
- **概览错误态**：内联错误条 + 「重试」按钮；**不**整页白屏。
- 页面级状态机：`{ studentId: null } → 空态`；`{ studentId != null, overview: loading } → 骨架`；`ready`；`overviewError`。
- 切换孩子（store 的 `studentId` 变）→ **所有 Tab 数据重拉**（各自 `useEffect` 依赖 `studentId`），并把正在编辑的草稿**丢弃**（跨学生提交是事故）。

### 2.4 「积分规则」Tab

- 按 `taskCode` 分组的卡片（照抄 `StudentSubjectConfigPage.tsx` 骨架：白卡 + `rounded-2xl border` + 标题行 + 保存按钮 + `Modal` + `toast`）。每张卡：`taskName` + `taskCode`（小字，便于对账）+ 该任务的档位行。
- 每行三列：档位名（`tierLabel`，只读）+ 分值 `input[type=number]` + 每日上限 `input[type=number]`（**placeholder 写「不限」**）+ 启用开关 + 今日进度（`completedToday` / `dailyLimit`，`dailyLimit === null` 时显示「今日已发 N 次（不限）」）。
- **草稿状态机**（每张卡一份）：
  - `draft[tierKey] = { points: string; dailyLimit: string; isActive: boolean }`（**字符串**存输入框原值，不要 `Number()` 后回写，否则用户打「1a」「-」会被吞）。
  - 解析规则：
    - `points`：`/^\d+$/` 且 `0 <= n <= 9999`；否则该行标红 + 该卡「保存」禁用。
    - `dailyLimit`：`''`（→ 提交 `null`）或 `/^\d+$/` 且 `1 <= n <= 99`；**`'0'` 明确非法**，错误文案「不限请留空；填 0 会让该档位不再发分」。
  - 脏判定：`draft` 与服务器快照不一致 → 该卡「保存」变 `primary` 且可点；否则 `ghost` + `disabled`。
- **保存流程**：
  1. 校验整卡通过（任一行非法 → 该行 inline 错误，不弹窗）。
  2. 若改动含**分值下调**或**档位由启用改停用** → 弹 `Modal` 二次确认，文案写明后果：下调「孩子之后完成该任务只能拿新分值，历史流水不变」；停用「该档位不会再出现在孩子的可选档位里，也不会再发分（历史流水保留）」。
  3. `PUT points/rules`，body = **该任务的全部档位**，每条带 `taskCode/tierKey/points/dailyLimit/isActive`。
  4. 保存中：按钮 `loading`，整卡输入框 `disabled`（防重复提交）。
  5. 成功：`toast('success', '已保存「数学专项」的分值')` + **重新拉该学生的 rules**（避免并发漂移）。
  6. 失败：`3005 档位不存在` → `toast('error')` + 重新拉 rules（并提示「档位已变化，请确认后重新保存」）；`1001` → `toast('error', err.message)`；其它 → 通用错误。
- **空 / 异常态**：
  - `tasks` 为空数组 → 空态「暂无积分任务配置」（理论上不可达，因为 `ensureRules` 会补齐；仍要处理）。
  - 某个任务 `tiers: []` → 显示「该任务暂无档位」（**不要**崩）。

### 2.5 「奖励清单」Tab

- 列表行（每行一个可编辑表单项，无「行内编辑/查看」两态——保持简单）：
  - `name` `input`（必填，1–100）
  - `description` `input`（≤300，空串 → 提交 `null`）
  - `pointsCost` `input[type=number]`（1–999999 整数）
  - `minLevelCode` `select`（「无门槛」→ `null` + 9 个段位，数据来自 Task 1 的 `GET /api/points/levels`）
  - `isActive` 开关（**下架行照常渲染**，标签「已下架」）
  - `sortOrder` `input[type=number]`（0–9999）——或用「上移/下移」按钮改 `sortOrder`（**推荐**：家长不该看到「排序号」这种内部字段）。选定：**上移/下移按钮**，内部维护 `sortOrder` = 数组下标 × 10。
  - 「删除」按钮（从本地数组移除；`PUT` 时该 id 消失 → 服务端软删）
- 「新增奖励」按钮：往本地数组追加一临时行（`id` 缺省，用本地 `tempKey` 做 React key；**不落库**）。
- **保存 = 整表 PUT**：`{ items: [...] }`，**必须**包含所有行（含 `isActive: false` 的下架行）；`id` 缺省的行是新增。
- 未保存时离开 Tab / 切孩子 → `Modal` 确认「有未保存的修改，确定离开吗？」（或简单地：切 Tab 时丢弃并在 Tab 标题上打「未保存」小圆点。**选定**：Tab 标题打点 + 切走时确认，两者都做，成本很低）。
- 空列表：`PUT { items: [] }` 是合法语义（= 全部软删）→ 保存前弹 `Modal` 确认「将清空全部奖励，孩子端奖励册会变空」。
- 保存成功后：用**响应体**（服务端返回的完整清单）替换本地数组——**不要**自己拼，`id` 由服务端生成。
- 错误：`1001` → 逐字段校验错误提示；其它 → `toast('error')`。

### 2.6 「兑换」Tab

两块，上下排列：

**(a) 兑换设置（`points/settings`）**

- `pointsPerYuan`：`input[type=number]` 1–9999，旁边实时预览「N 积分 = 1 元」；帮文案给个例子「当前设置：100 积分 = 5.00 元」。
- `rewardRedemptionEnabled`：开关，标签「允许积分兑换」，关掉时下方兑换表单整块置灰 + 文案「兑换已关闭，打开开关后可兑换」。
- 保存：只在「有改动」时启用；`PUT` **至少给一个字段**（空 patch 会被后端 400 1001）。成功 `toast` + 用响应体刷新本地。
- 注意 `GET settings` 会 `ensure` 默认行，所以**先读后改**永远不会空。

**(b) 兑换表单**

- 两个子模式（`type`）：**换钱** / **换奖励**，用两块 radio/分段控件切换。
- 换钱：
  - 输入**积分**数（`input[type=number]`，≥1 整数）。
  - 实时预览金额（**仅供预览**）：`Math.round(points * 100 / pointsPerYuan) / 100`（**整除后再取整**，与后端 `redemption.service` 同口径；别写 `points / pointsPerYuan` 再 `toFixed` 了事——非默认汇率下会差 1 分）。
  - 展示「将扣除 N 积分，兑换 ¥X.XX；兑换后余额 M 分」。余额不足时**提交按钮禁用** + inline 提示（服务端仍会兜底 3001）。
  - 提交前 `Modal` 二次确认，**必须**写明「兑换不可撤销，只能再兑一次或线下补偿」。
- 换奖励：
  - 下拉/卡片列表选择已上架奖励（`isActive: true`）；每项显示 `pointsCost` + 门槛（`minLevelCode` 有值时显示段位名 + 该孩子是否已达）+ `gap`。
  - 不满足条件时禁用该项并说明原因（分不够 / 段位不够）。
  - 提交前同样 `Modal` 确认（写明不可撤销）。
- 提交：`POST points/redeem`（**201**，按 `2xx` 判成功）。成功 → `toast('success', '已为孩子兑换 ¥X.XX')` / `'已兑换「周末看电影」'` + **同时刷新**概览卡（余额/段位变了）、兑换记录、奖励清单（如果该奖励被下架）。
- 错误码 → 文案：见 §2.8。

### 2.7 「兑换记录」Tab

- 列表分页（`page`，`pageSize` 固定 20，服务端返回 `total`）。列：时间 / 类型（换钱 / 换奖励）/ 内容（`cashAmount` → `¥X.XX`；`reward` → `rewardName`）/ 扣除积分（**负数样式**，但用中性色**不**用红色——它不是错误）/ 状态。
- **兑现队列**（UX P6.7「物质奖励兑现队列」的落地）：
  - 顶部一个「**本页**待兑现 N 条」的筛选 chip（默认显示全部；点一下只看 `pending`）。
    **N 只统计当前页**：后端 `GET .../redemptions` 只回分页 `items`，既没有 `totalPending`
    也没有 status 过滤参数，本期**不做后端改造**。因此文案显式限定「本页」，并且
    `page < totalPages` 时在 chip 旁注「翻页可看到更多」，避免家长把本页数当成全量、
    清完第 1 页就误判队列已空（第 2 页的待兑现被漏掉）。全局待兑现数需后续后端补
    `totalPending` 或 status 过滤（列为后续项）。数据未到货（加载/错误）时 chip 不渲染。
  - 每条 `pending` 行有「确认已兑现」按钮 → `PATCH /api/parent/redemptions/:id` `{status:'fulfilled'}` → 成功 `toast` + 重拉当前页。**不动积分**（服务端保证）。
  - `fulfilled` 行显示 `fulfilledAt` + 「已兑现」；提供「改回待兑现」的次要按钮（服务端允许 `pending ⇄ fulfilled`）。
- 空态：「暂无兑换记录」+ 一个跳「兑换」Tab 的链接。
- 404 / `1002`（兑换单不存在，如被别的端删了）→ `toast('error')` + 重拉列表。

### 2.8 错误码 → UI 文案与动作（**唯一映射表**，各 Tab 共用）

> ⚠️ **实施中发现的一处注释错误（Task 5 顺手修）**：`api.ts` 里 `rewardRedemptionEnabled` 的注释把「关掉开关」写成拒 **3003**，实际 **3003 = 奖励已下架**、**3004 = 兑换已关闭**（`redemption.service.ts:227` / `:200`）。下表才是权威；照错注释写会把「兑换已关闭」显示成「奖励已下架」。

| HTTP / code | 触发 | 展示 |
|---|---|---|
| 400 / `1001` | Zod 入参（points 越界、`dailyLimit:0`、空 patch settings、空 rules、非法 status） | `toast('error', err.message)`；表单类错误同时标红对应字段 |
| 400 / `3004` | 兑换已关闭 | 兑换表单置灰，inline「兑换已关闭，可在上方设置中开启」 |
| 400 / `3001` | 余额不足 | **inline**（不 toast）「可用积分不足，当前 N 分」，定位到积分输入框 |
| 400 / `3002` | 未达段位门槛 | inline「该奖励需达到「白银」才可兑换」 |
| 400 / `3003` | 奖励已下架 | `toast('error')` + 重拉奖励清单 |
| 400 / `3005` | 档位不存在 | `toast('error', '档位已变化，请刷新后重试')` + 重拉 rules |
| 404 / `1002` | 学生不存在 / 兑换单不存在 | 学生类 → 页面空态「该孩子账号不存在」+ 切回第一个；兑换单 → `toast` + 重拉 |
| 403 / `1005` | 非本人学生 | 页面空态「无权查看该孩子」+ `setStudentId` 回落第一个 |
| 其它 | 网络 / 500 | `toast('error', err.message ?? '操作失败')` |

- `ApiError` 的 `code` 从 `err.code` 取（`fetchApi` 已解 `{code,message}`）。**不要**用 `err.message.includes(...)` 判错。

> **实现注（终审裁决，2026-09-18）**：上表 404/`1002`、403/`1005` 两行的「**+ 切回第一个 / 回落第一个**」本次**未实现**——页面只出各自的空态（`points-student-missing` / `points-student-forbidden`，与通用错误条分开的 testid），**家长需手动在顶部 `StudentSwitcher` 切换孩子**。原因与后继做法见 §6 遗留 5。

### 2.9 `services/api.ts` 家长端新增函数（`// --- Parent: points & rewards ---` 分区）

```ts
// 类型复用：PointsOverview / PointLedgerPage / PointRuleTierView / GroupedPointRules
// 来自计划二 Task 2 已写入 api.ts 的定义；家长端只新增下面这些。
export interface LevelInfo { code: string; name: string; index: number; threshold: number }
export interface RewardCatalogView { /* §0.3 */ }
export interface RewardCatalogItemInput { id?: number; name: string; description: string | null; pointsCost: number; minLevelCode: string | null; isActive: boolean; sortOrder: number }
export type RedemptionType = 'cash' | 'reward';
export type RedemptionStatus = 'pending' | 'fulfilled';
export interface RedemptionView { /* §0.3 */ }
export interface RedemptionList { items: RedemptionView[]; total: number; page: number; pageSize: number }
export interface RedeemResult { redemption: RedemptionView; balance: number; totalEarned: number; level: LevelInfo }
export interface PointsSettings { pointsPerYuan: number; rewardRedemptionEnabled: boolean }
export interface PointRuleSaveInput { taskCode: string; tierKey: string; points: number; dailyLimit: number | null; isActive: boolean }

export function getLevels(): Promise<{ levels: LevelInfo[] }>
export function getParentPoints(studentId: number): Promise<PointsOverview>
export function getParentPointRules(studentId: number): Promise<GroupedPointRules>
export function saveParentPointRules(studentId: number, rules: PointRuleSaveInput[]): Promise<null>
export function getParentPointLedger(studentId: number, page: number, pageSize?: number): Promise<PointLedgerPage>
export function getParentRewardCatalog(studentId: number): Promise<RewardCatalogView[]>
export function saveParentRewardCatalog(studentId: number, items: RewardCatalogItemInput[]): Promise<RewardCatalogView[]>
export function redeemParentPoints(studentId: number, body: { type: 'cash'; points: number } | { type: 'reward'; catalogId: number }): Promise<RedeemResult>
export function getParentRedemptions(studentId: number, page: number): Promise<RedemptionList>
export function setRedemptionStatus(redemptionId: number, status: RedemptionStatus): Promise<null>
export function getParentPointsSettings(studentId: number): Promise<PointsSettings>
export function saveParentPointsSettings(studentId: number, patch: Partial<PointsSettings>): Promise<PointsSettings>
```

- 全部走既有 `fetchApi`；路径按 §0.2 逐字照抄。
- **`getLevels` 是唯一不需要 `studentId` 的**（`/api/points/levels`）。

---

## 3. 任务清单

### Task 1: 后端补 `GET /api/points/levels`（+ 双文档同步）

**为什么必需**：奖励的 `minLevelCode` 是 9 选 1，而现有端点只回 `level` + `nextLevel`；家长端无法列出「白银及以上」这种选项。spec §3.1 要求段位表**单一真源在后端**，所以不能前端硬编码。

**Files**
- Create: `apps/server/src/modules/points/levels.controller.ts`、`levels.controller.test.ts`
- Modify: `apps/server/src/modules/points/points.module.ts`（`controllers` 数组加一项）
- Modify: `docs/API接口与数据流设计文档.md`（§4 端点清单 + §6 数据流各补一行）
- Modify: `docs/api/openapi.yaml`（`/api/points/levels` + `LevelInfo`/`LevelsResponse` schema）

**契约**
- `@Controller('api/points')`、`@UseGuards(JwtAuthGuard, RolesGuard)`、`@Roles('student','parent')`（学生端将来也可能要用）。
- `@Get('levels')` → `{ levels: LEVELS.map(toInfo) }`（**9 项、按 threshold 升序、含 `index`**；`index` 从 0 起——与 `levels.ts` 的 `toInfo` 一致，**不要**在 controller 里重算）。
- 需要 userId 吗？**不需要**——段位表是静态常量，不做任何 DB 访问，也不做归属校验。
- ⚠️ 别把 `@Get('levels')` 加到现有 `PointsController`：那个类上是 `@Roles('student')`，家长会被 403。

**测试**
- metadata：`PATH_METADATA === 'api/points'`、`METHOD_METADATA === RequestMethod.GET`、类上 `ROLES_METADATA` 含 `'student'` 与 `'parent'`（用 `Reflect.getMetadata`，与 `parent-points.controller.test.ts:188` 同风格）。
- 行为：返回 9 项；首项 `pichai/0`、末项 `wangzhe/20000`；`threshold` 严格递增；`index` 与数组下标一致。

**提交**：`feat(server): 新增段位表查询端点 GET /api/points/levels（家长端配奖励门槛用）`

---

### Task 2: `parentStudentStore` + `StudentSwitcher` + `ParentLayout` 接真实切换（前置 C）

**Files**
- Create: `apps/web/src/store/parentStudentStore.ts`、`parentStudentStore.test.ts`
- Create: `apps/web/src/components/layout/StudentSwitcher.tsx`、`StudentSwitcher.test.tsx`
- Modify: `apps/web/src/components/layout/ParentLayout.tsx:54-62`（假下拉换 `<StudentSwitcher />`）

**要点**：见 §2.1 / §2.2。**必须处理**「0 个孩子」「持久化 id 已失效」「换账号残留」。

**测试**
- store：`setStudentId` 后读得到；`persist` 只写 `studentId`（断言 localStorage 里没有别的字段）。
- `StudentSwitcher`：1 个孩子也渲染；点开菜单列出全部；点某个孩子调 `setStudentId(id)` 且关闭菜单；0 个孩子渲染空态文案 + 链接 `/parent/students`；**持久化 id 不在列表里时回落到第一个**（mock 返回 `[id:7]`，store 里是 `99` → 断言 `setStudentId(7)` 被调）。
- `ParentLayout` 回归：渲染后 `StudentSwitcher` 在位；假 Banner 仍渲染（**别顺手删了它**）。

**提交**：`feat(web): 家长端当前孩子上下文（parentStudentStore + 真实切换下拉）`

---

### Task 3: `api.ts` 家长端积分与兑换函数

**Files**
- Modify: `apps/web/src/services/api.ts`（新增 `// --- Parent: points & rewards ---` 分区）
- Modify: `apps/web/src/services/api.test.ts`（若该文件存在则追加；否则在页面测试里覆盖，见下）

**要点**：见 §2.9。**逐字**照抄路径与 body 形状。

**测试**：至少断言两条容易写错的——
- `saveParentPointRules` 把 `dailyLimit: null` 原样发出（**不能**被 `JSON.stringify` 之外的逻辑转成 `0` 或丢掉）。
- `redeemParentPoints` 的 `type:'cash'` body 是 `{type,points}`、`type:'reward'` 是 `{type,catalogId}`（判别联合不串味）。

**提交**：`feat(web): api 家长端积分/奖励/兑换函数`

---

### Task 3.5: 给 `PointRuleTier` 补 `isActive`（**Task 5 的前置，实施中发现**）

> **为什么必需**：Task 5 必须**显示已下架档位**并提供「重新启用」（§1.1 第 1 条，计划一 Task 7 审查点名过）。但前端的 `PointRuleTier`（计划二 Task 2 定义）**没有声明 `isActive`**——因为学生端 controller 把下架档过滤掉了（`points.controller.ts:71`），只有家长端才回全量。wire 上该字段两端都真实存在（后端 `PointRuleTierView`）。
>
> 若不补：Task 5 只有两条坏路——(a) 自己造一个「家长端 tier 类型」→ 一份 wire 形状两个类型，必然漂移；(b) 用 `!tier.isActive` 判断 → 字段是 `undefined` 时**恒为真**，会把**所有档位**当成已下架（这正是 §1.1 第 1 条要防的错）。所以字段必须**必填**（服务器总会下发），学生端测试 fixture 机械补上即可。

**Files**
- Modify: `apps/web/src/services/api.ts`（`PointRuleTier` 加 `isActive: boolean`，注释写明「学生端 `me/rules` 恒为 `true`；家长端才可能是 `false`」）
- Modify: 三处 fixture —— `pages/student/training/point-tiers.test.ts`、`TargetedConfigPage.test.tsx`、`english/VocabularyConfigPage.test.tsx`（各补 `isActive: true`）

**要点**：**纯类型 + fixture 补齐**，不改任何运行时逻辑；学生端代码**不读** `isActive`（已核实 grep 无命中），所以行为不变。

**验收**：`npm test` 全绿（fixture 漏补会被 `tsc -b` 挡下）+ `npm run build` + `npm run lint` 无新增。

**提交**：`fix(web): PointRuleTier 补 isActive（家长端要显示下架档位）`

---

### Task 4: `ParentPointsPage` 骨架 + 概览卡 + Tab 深链

**Files**
- Create: `apps/web/src/pages/parent/ParentPointsPage.tsx`、`.test.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx:327`（`/parent/rewards` 的 `Placeholder` 换成真页面）
  ⚠️ 路由此前在 `routes/index.tsx` 里，2026-09-18 学生端 Task 8 已拆成 `routeTable.tsx`（唯一真源）+ `Placeholder.tsx` + `RoleRedirect.tsx`；**改路由一律改 `routeTable.tsx`**。

**要点**：见 §2.3。四个 Tab 先渲染各自占位子组件（Task 5–7 填内容），但**骨架、深链、概览卡、切孩子重拉**这次就要做全。

**测试**
- 默认（无 `tab` 参数）→ 渲染「积分规则」Tab。
- 非法 `?tab=xyz` → 归一成「积分规则」，不报错。
- 概览：`loading` 时渲染骨架且**页面文本里不出现「0 分」**；`ready` 后显示段位名 + 可用/累计/今日；`nextLevel === null` 时显示「已达最高段位」且**不含**「还差」。
- 概览请求失败 → 显示错误条 + 「重试」按钮，点重试重新调用。
- `studentId` 为 `null` → 页面空态（不是骨架，也不是崩溃）。
- **切孩子重拉**：mock store 从 `1` 改到 `2`，断言 `getParentPoints` 被以 `2` 调用过。

**提交**：`feat(web): 家长端积分页骨架、概览卡与 Tab 深链`

---

### Task 5: 「积分规则」配置表

**Files**
- Create: `apps/web/src/pages/parent/points/PointRulesPanel.tsx`、`.test.tsx`
- Modify: `apps/web/src/pages/parent/ParentPointsPage.tsx`（把 rules 占位换成真组件）

**要点**：见 §2.4。**最容易漏的三条**：下架档位要显示、每条必须三字段齐全、`dailyLimit` 空 = `null` / `0` 非法。

**测试**
- 渲染自接口：两个任务各两个档位，`tierLabel` + 分值都在。
- **下架档位仍渲染**（`isActive:false` 的行存在）+ 「启用」开关可切。
- 空 `tiers` 的任务 → 显示「该任务暂无档位」，不崩。
- 未改动时「保存」disabled；改分值后 enabled。
- `dailyLimit = ''` → 提交 `null`；`dailyLimit = '0'` → 行内错误 + 保存 disabled（**断言 `saveParentPointRules` 未被调用**）。
- 分值下调 → 先出 `Modal`，确认后才发请求（断言**未确认前**没调用）。
- 后端返回 `3005` → `toast` 被调 + rules 被重拉。
- `afterEach(() => cleanup())`。

**提交**：`feat(web): 家长端分值规则配置表（含下架档位与二次确认）`

---

### Task 6: 「奖励清单」管理

**Files**
- Create: `apps/web/src/pages/parent/points/RewardCatalogPanel.tsx`、`.test.tsx`
- Modify: `apps/web/src/pages/parent/ParentPointsPage.tsx`

**要点**：见 §2.5。**最易漏**：整表 PUT 必须带回下架行的 `isActive`（漏了会静默上架）；`sortOrder` 用上移/下移按钮而不是裸输入框。

**测试**
- 渲染含下架行的清单，下架行有「已下架」标签。
- 新增一行 → 本地出现新行；保存时 `items` 长度 +1 且新行**没有** `id`。
- 删除一行 → 保存时 `items` 里没有该 `id`（软删语义在服务端，前端只负责不带）。
- 保存后本地数组被**响应体**替换（mock 返回带新 `id` 的清单 → 断言新行拿到了 `id`）。
- 空清单保存 → 先弹确认 Modal。
- 段位下拉项来自 `getLevels()`（断言调用了 `getLevels` 且渲染了 9 个 option）。
- 未保存就切 Tab → 先弹确认（或 Tab 打点；按 §2.5 选定实现断言）。

**提交**：`feat(web): 家长端奖励清单管理（整表保存 + 上下架）`

---

### Task 7: 「兑换」Tab（换钱 / 换奖励 + 兑换设置）

**Files**
- Create: `apps/web/src/pages/parent/points/RedeemPanel.tsx`、`.test.tsx`
- Create: `apps/web/src/pages/parent/points/PointsSettingsPanel.tsx`、`.test.tsx`
- Modify: `apps/web/src/pages/parent/ParentPointsPage.tsx`

**要点**：见 §2.6。三条硬要求：金额预览与后端**同口径取整**；确认弹窗**写明不可撤销**；错误码按 §2.8 分流（3001/3002 **inline 不 toast**）。

**测试**
- 换钱：输入 100、`pointsPerYuan = 20` → 预览区显示 `¥5.00`。
  - 取整口径**单独测纯函数**：把预览算法导成 `previewCashAmount(points, perYuan)`，断言它等于 `Math.round(points * 100 / perYuan) / 100`（与后端 `redemption.service` 同式）。**不要**用「找一个能区分两种写法的输入」来侧面测——那类输入不存在时测试会变成空断言；页面测试只断言「预览区渲染了 `previewCashAmount` 的返回值」。
- 余额不足 → 提交按钮 disabled + inline 文案；**断言点击后 `redeemParentPoints` 未被调用**。
- 确认 Modal：未确认前不请求；确认后才 `POST`，且 body 是 `{type:'cash',points:100}`。
- 换奖励：`isActive:false` 的奖励不出现在选项里；`levelOk:false` 的项 disabled 且说明「需达到 XX」。
- `3004` → 表单置灰 + inline 文案；`3001` → inline 且**没有** `toast` 调用；`3003` → `toast` + 重拉清单。
- 设置：`pointsPerYuan` 改成 `0` → 保存 disabled；只改开关 → `PUT` body **只含** `rewardRedemptionEnabled`（断言不含 `pointsPerYuan`，因为后端不认「未提供即不动」以外的语义）。
- `afterEach(() => cleanup())`。

**提交**：`feat(web): 家长端兑换（换钱/换奖励）与兑换设置`

---

### Task 8: 「兑换记录」Tab + 兑现状态流转

**Files**
- Create: `apps/web/src/pages/parent/points/RedemptionHistoryPanel.tsx`、`.test.tsx`
- Modify: `apps/web/src/pages/parent/ParentPointsPage.tsx`

**要点**：见 §2.7。

**测试**
- 渲染记录：`cash` 行显示 `¥X.XX`；`reward` 行显示 `rewardName`；扣分用中性色（**正向断言** `--text-secondary` token，不是只断言「不含 `--error`」）。
- 「本页待兑现 N 条」chip 存在且计数正确；点了之后只显示 `pending`；`page < totalPages` 时 chip 旁注「翻页可看到更多」，数据未到货时 chip 不渲染。
- 「确认已兑现」→ `setRedemptionStatus(id, 'fulfilled')` 被调 + 重拉当前页。
- `fulfilled` 行有「改回待兑现」→ 调 `'pending'`。
- 空态文案 + 跳「兑换」Tab 的链接。
- `1002` → `toast` + 重拉。

**提交**：`feat(web): 家长端兑换记录与兑现状态流转`

---

### Task 9: 入口与导航收尾

**Files**
- Modify: `apps/web/src/pages/parent/ParentStudentsPage.tsx:216-228`（每个孩子卡的动作区加「积分与奖励」按钮 → 先 `setStudentId(s.id)` 再 `navigate('/parent/rewards')`）
- Modify: `apps/web/src/components/layout/ParentNav.tsx:13`（确认「奖励管理」标签与顺序；**不改路径**）
- Modify: `apps/web/src/routes/routeTable.tsx:327`（确认 `Placeholder` 已被 Task 4 替换）

**测试**
- 路由渲染测试：`/parent/rewards` 渲染 `ParentPointsPage` 而不是 `Placeholder`（断言 `Placeholder` 的「原型占位」文案**不**出现）。
- `ParentStudentsPage`：点「积分与奖励」→ store 被设为该孩子 + 导航到 `/parent/rewards`。

**提交**：`chore(web): 家长端积分入口与导航收尾`

---

## 4. 验收（人工）

```bash
cd apps/web && npm run build && npm test
cd ../server && npm test && npm run build
cd ../server && node dist/main.js          # 必须 node dist/main.js
cd ../web && npm run dev
```

用家长账号走一遍（先在 `/parent/students` 建两个孩子的账号以便测切换）：

1. 进家长端 → 顶部「当前查看」是**真实名字**（不是「小明（三年级）」）；刷新页面选择不丢。
2. 切到第二个孩子 → 概览卡、规则、奖励、记录**全部换人**；切走时若有未保存草稿，被提示。
3. 直接改 localStorage 里的 `parent-current-student` 为一个不存在的 id → 刷新后**回落到第一个孩子**，不白屏。
4. 积分规则 → 把「数学专项」3 题档从 8 改成 10 → 直接保存生效；再把「英语背单词」10 词档**下调**到 1 分 → **弹确认**，取消 → 不生效。
5. 把某个档位的「每日上限」清空 → 保存后显示「不限」；填 `0` → 保存被拦 + 文案解释。
6. 下架「数学专项」的 10 题档 → 学生端配置页那个档位**消失**（这条依赖计划二 Task 6）。
7. 奖励清单 → 新增「周末看电影 / 200 分 / 白银以上」→ 保存成功、`id` 回填；下架它 → 再现上架 → 保存后状态正确（**这条专测 isActive 不被静默上架**）。
8. 兑换 → 换钱 100 积分（默认 20:1）→ 弹「不可撤销」确认 → 成功后概览余额 -100、**累计积分不变**、**段位不降**；兑换记录里出现一条「待兑现」。
9. 换奖励 → 分不够的项禁用并说明差多少；达成后兑换成功。
10. 兑换记录 → 点「确认已兑现」→ 状态变 `fulfilled`、`fulfilledAt` 有值、积分**没再变**；再点「改回待兑现」也能回去。
11. 把汇率改成 7 → 预览金额与 `point_redemptions.cash_amount` 一致（查库核对，避免前端预览与后端入库不一致）。
12. 关掉「允许积分兑换」→ 兑换表单置灰；直接 `curl` POST redeem 得 400/3004。
13. 全程无夜间模式、无烟花/撒花、无 emoji；配色是商务白蓝。

## 5. 风险

| 风险 | 处置 |
|---|---|
| 奖励清单漏回传 `isActive` → 已下架奖励被静默上架 | Task 6 明确「整表 PUT 含下架行」+ 专门测试；验收第 7 条人工复测 |
| `dailyLimit` 填 0 → 该档位永久不发分 | 前端拦 + 文案「不限请留空」；后端 400 1001 兜底；Task 5 有「0 → 不调保存接口」的断言 |
| `points` 负数 → 破坏「段位只升不降」 | 前端 0–9999 校验；后端兜底 |
| 前端硬编码段位表 → 与后端漂移 | Task 1 新增 `GET /api/points/levels`，前端只读接口；**不建前端常量** |
| 金额预览与后端取整口径不一致 | 预览与后端同用整数运算 `Math.round(points*100/perYuan)/100`；验收第 11 条查库核对 |
| 家长误操作不可撤销的兑换 | 二次确认 + 明写不可撤销；`point_redemptions.status` 已为将来撤销留位（本期不做） |
| 切孩子时把上一个孩子的配置存到新孩子 | 切孩子丢弃草稿 + 所有 Tab 依赖 `studentId` 重拉；Task 4 有「切孩子重拉」断言 |
| 新增端点漏同步 API 双文档 | Task 1 把两份文档列为交付物，逐字核对路径/方法/响应 |

## 6. 遗留与待裁决（**不要**在本计划里顺手做）

1. **学生端缺「兑换记录」只读端点**。计划二 Task 5 的 `ProfilePage` 里有一块「兑换记录」，但 spec §7.1 的学生端点只有 `me` / `me/ledger` / `me/rules` / `me/rewards`——**没有** `me/redemptions`。两条路：新增 `GET /api/points/me/redemptions`（+双文档同步），或把学生端那块删掉只留 `me/ledger`（负流水本身已能看出兑换）。→ **留给用户裁决**，本计划不动。
2. `RewardCard.tsx` 仍是**死组件**（`apps/web/src/components/business/RewardCard.tsx`，仅被 UX §3.2.6 引用）。计划二 Task 5 的奖励册自建卡片、本计划的清单用表格，两处都不用它。→ 建议终审裁决「删掉」或「改造后复用」，本计划不动。
3. `ParentLayout` 的假 Banner（`hasAlert = true`）是「异常预警」的占位，与积分无关，本次不碰。
4. 计划一的 `dailyLimit` 默认值改动**不回溯存量学生**（`insertIgnoreBatch` 不覆盖已有行）。家长若此前已初始化过规则，`math_targeted` 仍是 `dailyLimit: null`（无上限）。→ 上线前用家长页手工设一次，或单独跑迁移；**不做**自动回溯。
5. **学生类 `1002`/`1005` 不自动回落到第一个孩子**（终审裁决的已知取舍，2026-09-18）。页面已按 §2.8 给两个独立空态，但**不替家长换人**。可达场景：顶栏列表加载后孩子在别处被删/被转走，家长在同一 pathname 下切 Tab（`commitTab` 只改 `?tab=`、**不改 pathname**，而 `StudentSwitcher` 的重拉 effect 依赖 `[load, pathname]`）→ 概览与各面板持续报错。**当前行为**：家长手工在顶部切换孩子即可恢复；不切换就一直停在空态。**要做自动回落**得先给 `StudentSwitcher` 开一条重拉通道（它才持有孩子列表），由它发现「当前 id 已不在列表」后 `setStudentId(第一个)`——属另一处改动，本计划不做。
