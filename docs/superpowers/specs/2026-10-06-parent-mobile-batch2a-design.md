# 家长移动端第二批 A（2A）设计 spec：学生管理 / 消息中心 / 学习目标 / 账号设置 / 学习配置

日期：2026-10-06
状态：范围经用户裁决（分两批；**订阅移出**，想做时另立项），设计逐节过审
前置：v1 已上线并合并（spec `2026-10-01-parent-mobile-pwa-design.md`）；本批延续其全部架构裁决

## 1. 背景与范围

v1 家长移动端只做了 4 个核心页，其余功能在「更多」里指向电脑端。本批（2A）把
**学生管理闭环 + 消息 + 目标 + 账号**搬上手机。用户裁决要点：

- 分两批：2A = 本 spec 的 5 个页面；2B = 积分兑换 / 学习报告 / AI 对话记录（另立 spec）。
- **订阅不做**（用户：目前意义不大，想做时再立项）。
- 学生管理的子页**学习配置纳入 2A**（不做则学生管理是半截流程）。

**v1 结尾残留的占位（2A 后仍在「更多」指向电脑端）**：订阅管理、积分与兑换、
学习报告、AI 对话记录。

## 2. 硬约束（沿用 v1，逐条继承）

- **零后端改动**：只用 `services/api.ts` 既有导出（端点清单见 §4，名称已逐一对过真源）。
- 桌面端零回归：13 个桌面家长页面与其测试一行不动。
- 复用 `services/api.ts`、`useParentStudentStore`、parent 主题 token、三条通知条、
  `RequireRole`、`ParentViewportGate`；不复用桌面页面组件。
- 新页面组件放 `src/pages/parent-mobile/`；测试自写 `afterEach(cleanup())`。
- 派生状态带 `studentId` 归属；列表换孩子回第 1 页。
- **验收必经 Playwright WebKit 实测**（2026-10-02 教训：桌面 Chromium 不算测过移动端）。
- 配色全 token（禁止 `text-black/60` 类快捷写法）；不用吉祥物/emoji。

## 3. 路由与入口

新增 5 条移动路由，全挂 `MobileParentLayout` + `RequireRole role="parent"`：

```
/m/parent/messages              → 消息中心
/m/parent/students              → 学生管理
/m/parent/students/:id/config   → 学习配置（学生管理子页）
/m/parent/goals                 → 学习目标
/m/parent/account               → 账号设置
```

- 「更多」页（`MobileMorePage`）：上述 5 项改为**真实入口**（`MOBILE_MORE_ITEMS`
  拆成「已实现入口 + 仍指向电脑端占位」两组，占位组剩：订阅管理、积分与兑换、
  学习报告、AI 对话记录）。
- `ParentViewportGate` 映射扩充：`messages/students/goals/account` → 同名移动页；
  `students/:id/config` → `/m/parent/students/:id/config`（带 id 直跳）。
  底部 Tab 不变。
- 学习配置页内部**需要当前孩子 id**：从路由参数取（`students/:id/config`），
  不读 `parentStudentStore`——桌面端即按路径 id，保持一致；换孩子锚点不影响该页。

## 4. 页面明细（端点名已对 `api.ts` 真源）

### 4.1 消息中心 `/m/parent/messages`
- 数据：`listMyMessages(): ParentMessageItem[]`、进页与展开时 `getUnreadMessageCount()`。
- 交互：列表点条目**就地展开全文**（沿用桌面 expandedId 交互）+ `markMessageRead(id)`
  （展开即已读；失败静默，条目不消失）；站内消息无分页（桌面端同款全量）。
- 三态齐备；空态「暂无消息」。

### 4.2 学生管理 `/m/parent/students`
- 数据：`listMyStudents(): MyStudentItem[]`。
- 交互：
  - 新建学生表单：姓名 / 用户名 / 密码 / 年龄 / 年级（**年龄与年级强制录入**，
    PRD §7.8；`createStudent(req)`，桌面端同款校验：必填、用户名冲突 1004 提示）。
  - 重置密码：`resetStudentPassword(id, newPassword)`，确认弹窗 → 成功后**展示新密码**
    （沿用桌面交互）。
  - 停用/启用：`setStudentStatus(id, isActive)`；停用需确认弹窗；状态徽标展示。
- 新建/改名后 `MobileStudentSwitcher` 自动刷新（pathname 重拉机制 v1 已有，无需接线）。

### 4.3 学习配置 `/m/parent/students/:id/config`
- 数据：`getStudentSubjectConfigs(studentId): SubjectConfigsResponse`（含学生名/各科当前配置）；
  选项：`fetchSubjects()` + `fetchVersions(subjectId)`。
- 交互：按学科单栏卡片（当前教材/册别）→ 点修改 → 年级代码 + 册别（上/下）+ 版本选择 →
  `updateStudentSubjectConfig(studentId, subjectId, { gradeCode, term, textbookVersionId? })`。
- **保存返回 `reset: true` 时必须弹「该学科学习进度已重置」提示**（沿用桌面语义，勿删）。
- 返回学生管理页（页内返回按钮 + 底部 Tab 均可）。

### 4.4 学习目标 `/m/parent/goals`
- 数据：`getParentGoalAttainment(studentId): ParentGoalAttainment`（达成度列表）。
- 交互：每行展示 目标值 / 当前达成 / 达成率（**rate 允许 >100，前端不截断**）；
  点编辑 → 数字输入 → `putParentGoalTarget(studentId, metric, target, subjectId)`
  → 用返回的 item 就地更新；无效输入（非正数）行内报错不发请求。
- 页顶「当前孩子」来自切换器锚点；换孩子整页重拉。

### 4.5 账号设置 `/m/parent/account`
- 数据：`getParentAccount(): ParentAccount`（只读：手机号/姓名等）。
- 交互：修改密码表单（旧密码 / 新密码 / 确认新密码）→
  `changeParentPassword(oldPassword, newPassword)` → 成功 toast「密码已修改」；
  校验：新密码 ≥6 位、两次一致；旧密码错误原样展示后端文案。
- 退出登录不在此页（顶栏已有），页内加一行说明文案即可。

## 5. 测试策略

- 每页渲染测试（三态 + 关键交互：消息展开即已读、新建学生必填校验与成功刷新、
  配置保存 reset 提示、目标 >100 不截断、改密成功/旧密码错误文案）。
- 路由表测试补 5 条新路由；`ParentViewportGate` 测试补新映射用例。
- 多用例文件自写 `afterEach(cleanup)`；桌面端既有测试零改动。
- **WebKit 端到端走查**：5 个页面在 390×844 下逐页过（截图核对配色/布局/交互）。

## 6. 文档同步

- UX 文档 §5.10 扩充本批页面清单。
- `docs/ai-core-changelog.md` 新条目。
- 本 spec 提交后，v1 spec 的「更多占位」口径以本 spec §1 为准（v1 文档不改）。

## 附章：双平台「添加到主屏幕」步骤

见 v1 spec 附章 A（不变）。
