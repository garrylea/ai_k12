# CLAUDE.md

This file provides guidance to Claude Code and CodeBuddy Code when working with this repository. 根目录 `AGENTS.md` 是本文件的软链（CodeBuddy 及其他读 AGENTS.md 的 agent 工具经它加载同一内容）。

> **体量纪律**：本文件只放**跨主题**的仍生效硬约束 —— 读代码 / config / 权威设计文档得不到的「**为什么**」与「**勿动**」。三类内容**不在此**：
> ① 带日期的日志、事故经过、实测数字 → `docs/ai-core-changelog.md`；
> ② **按主题的「勿动」细节**（ai-core / 家长端 / 专项子系统 / PC App / 数学薄弱点 / 数据管线）→ **`docs/constraints/<主题>.md`**（2026-09-24 迁出，索引见下「权威文档索引」）；**动对应子系统前必读那份**。
> ③ 端点、字段、SQL 谓词等已写在 API 文档 / schema 里的内容 → 指过去，不重复。

## Project Overview

K12 智学系统 — 面向中国学生的自适应 AI 学习平台。双轨（主线结构化闯关 + 辅线自由探索）+ 苏格拉底式 AI 辅导。MVP 已覆盖数学、语文古诗文专项、英语背单词。

## Monorepo Structure

```
apps/web/     — Active. React (Vite + TS + Tailwind)
apps/server/  — Active. Node backend；ai-core AI Agent Hub + HTTP API 层（10 模块）均已实现
apps/desktop/ — Active(dev). Electron 壳：加载与 Web 相同的 UI + kiosk 学习管控（见下「PC App 学习管控」节）
                packages/ — Planned. Shared configs/types
tools/crawler/ | tools/data-refinery/ | tools/db/  — Active. 爬虫 / 数据管线 / MySQL schema
docs/         — PRD, API 设计, UX/UI, DB 设计, 数据管线文档
```

## Development Commands

```bash
# apps/web/                      # apps/server/
npm run dev    # :5173           npm test      # vitest
npm run build  # tsc -b + vite   npm run build # tsc + scripts/copy-assets.mjs（把 ai-core 的 yaml 与 prompts 复制进 dist）
npm run lint                     npx tsx src/ai-core/__tests__/safety-classification.ts   # 确定性安全回归，无需 API Key
npm test       # vitest

# tools/*（crawler / data-refinery / db）
pip install -r requirements.txt && pytest   # 测试在 tests/test_*.py；网络依赖测试标记 network，默认 skip
```

⚠️ **起后端的正确方式**：`node dist/main.js`。`npx tsx src/main.ts` 的 DI 是坏的（见下文 DI 坑）。

## 权威文档索引（动手之前先读这里）

| 文档 | 什么时候读 |
|---|---|
| `docs/K12智学系统-产品需求文档.md` | PRD，**所有功能的唯一真源**。与任何设计决策冲突时以它为准，且必须先与用户确认再实现 |
| `docs/UX-UI设计文档.md` | 页面规范与响应式规则 |
| `apps/web/style.md` | **唯一**样式参考：配色（§2）、登录页（§2.5）、入口选择页（§2.6）、学科选择页（§8） |
| `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` | API 契约，两份**互为对照、必须同步**（规则见下）。**各专项的端点、抽题池谓词、判题口径**见 §4.18 / §5.20–§5.23；积分 / 埋点 / 家长端聚合见 §5.24–§5.28 |
| `docs/ai-core-changelog.md` | 历史工作日志。**本文件迁出的带日期细节都在这里**，它同时记录各次事故与踩坑 |
| `docs/data-refinery-管线总结与后续.md` / `使用手册.md` | 数据管线的约定与操作 |
| `docs/constraints/*.md` | **按主题的硬约束与踩坑（动手前必读对应那份，本文迁出的「勿动」细节）**：`ai-core.md`（模型路由 / 流式超时 / 判题分层 / 构建拷贝）、`家长端.md`、`专项子系统.md`（语文·英语）、`pc-app-学习管控.md`、`数学薄弱点图谱.md`、`数据管线.md` |
| `docs/superpowers/specs/` 与 `docs/superpowers/plans/` | 各子系统的设计 spec 与任务级实施计划 |

## 基本原则（硬规则，勿违背）

### UI / 设计

1. UI、组件、文案里**不用 emoji**；图标必须是线性 SVG。
2. **不用吉祥物或装饰元素**（彩虹、气球、星星）。
3. **配色只有一套**（`style.md` §2），**不按学段分色**。
4. **PRD 覆盖任何设计决策**；有冲突必须先与用户确认再实现。
5. iPad 横屏（≥1024px）是**主断点**，PC（≥1280px）次要，移动端暂缓。
6. 苏格拉底原则：「提示」与「讨论」按钮**永远比「看答案」更醒目**。
7. 主线推进必须**先清零错题**才解锁，**这道门禁不许跳**。
8. **不支持小程序**：只做 WebApp、PC App（Electron）、家长 Web。不得引入微信/支付宝小程序等任何小程序相关代码、API、构建目标或文档引用。

### 主题与学段

- 三套主题经 CSS 变量 + 容器 `data-theme` 实现，token 真源 `apps/web/style.md` §2：`student-day`（默认）/ `student-night` / `parent`。
- **主题作用域分两类**（**逐页归属以 `UX-UI设计文档.md` §1.5 为准，不要自行归类**）：① 学习沉浸页 → 包 `.student-theme-container`、18:00–06:00 自动切、允许**页内**手动切；② 非学习阶段学生页（登录/注册/学科选择/入口选择/星链图/个人中心/奖励册）→ **写死 `data-theme="student-day"`、不用容器、无手动切换**。家长端/管理端全程日间。
- **`StudentStayLayout` = 个人中心 / 奖励册专用**浅停留页外壳（写死日间、无侧栏、无日夜切换；顶栏「返回星图」+ `LogoutButton` 是回学习主线的唯一出口）——**不要把这两页合回任何共享 Layout**；训练轨页面全屏、硬编码 `data-theme="student-day"`、不在任何 Layout 下。
- **学生端没有独立设置页**（UX P5.3 已废止，2026-09-18）：护眼/日夜 = 自动 + 沉浸页内手动；字号由 `data-school` 决定（来自家长在「学习配置」选的年级）；行距定死 1.6–1.8（`style.md` §9）；音效 PRD 未定义；`themeStore.motionEnabled` 存在但**无 UI 入口**，本期不做。
- `data-school`（`primary`/`junior`/`senior`）**只调字号**，颜色与圆角三学段一致。
- 双轨区分靠**文字标签**（Tab 名、Tag 文案「主线」「辅线」），**不靠颜色**；物理隔离靠路由（入口选择页，无跨轨链接）。辅线用与主线同一套 brand orange，旧紫色 `Aux #8B5A8E` 已废弃。

### 代码组织

`src/components/` 分 `base/`（通用原语）/ `business/`（领域组件）/ `layout/`（页面外壳）。路由用 React Router 6 `createBrowserRouter`；登录按用户名格式自动分流（手机号 → 家长，否则 → 学生）。状态用 Zustand；API 层 `src/services/api.ts`（JWT 三角色 student/parent/admin）；`src/tokens/` 的 JSON 是 CSS 变量生成的源。

## API 文档同步规则

`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须始终一致：

1. **任何一方变更时，另一方必须同步更新**（路径、方法、参数、响应结构）。
2. **以 API 设计文档为主稿**：端点清单（§4）与数据流（§5）定义业务语义；openapi.yaml 是其机器可读实现。
3. **阶段标记**：openapi.yaml 只收 MVP 端点；P1/P2 在 API 文档里标阶段，进入开发时再补入。
4. **检查清单**：每次 API 变更后核对两文档的端点路径列表，确认无遗漏。
5. 注意 **Nest 的 `@Post` 默认返回 201 而非 200**：新端点按实际记 `'201'`，以 `2xx` 判断成功。本仓**唯一**的 `@HttpCode` 覆盖是 `POST /api/student/learning-sessions`（幂等「取或建」，显式 **200**，见「PC App 学习管控」节）。

## 工程约定（血泪教训，勿重蹈）

- **测试与文档同步铁律**：测试断言与 config/types/设计文档冲突时**测试错** —— 改测试，勿改 config/设计文档。改代码或主文档时，同步更新所有引用它的设计/计划文档。
- **组件改动必须补渲染测试**，别只靠 `tsc + lint + build`（类型检查抓不到「运行时数据形状」问题；`SentenceBlock.test.tsx` 是 React #31 事故的回归钉子，事故经过见该文件头部注释）。
- **`globals: false`**：`@testing-library/react` 不自动注册 `afterEach(cleanup)`，多用例文件必须自己写 `afterEach(() => cleanup())`，否则上个用例的 DOM 泄漏导致选择器重复命中。
- **Nest DI 坑**：带 `@Injectable()` 的类会发 `design:paramtypes`，**接口类型**参数运行时被写成 `Object`，Nest 当 token 去容器找不到就**启动直接失败** —— 必须加 `@Optional()`。`ai-core/capabilities/*` 那些类**故意不写 `@Injectable()`**（零参实例化）才没踩到：区别在有没有装饰器。
- **数据库**：`ai_k12/ai_k12@localhost/ai_k12`（`.env` 的 `DB_*`）。schema 在 `tools/db/schema.sql`，迁移在 `tools/db/migrations/YYYY-MM-DD_*.sql`（**无迁移运行器，手工 apply**；必须幂等；新增表/列要同时进 schema.sql）。`updated_at` 一律用**列级** `ON UPDATE CURRENT_TIMESTAMP(3)`，**不要建 `*_updated_at` 触发器**（触发器是独立对象、会随 schema 漂移静默缺失）。
- **派生状态必须带 `studentId` 归属**：家长端切孩子不重挂载、`useState` 跨孩子存活，只按自身维度守卫会在切换首帧画出上个孩子的数据（`useEffect(reset)` 在 commit 之后才跑，救不了）—— 派生值必须与 `studentId` 一起存、读取时一并比较。
- **列表页换孩子必须回第 1 页**：否则带「上个孩子的第 N 页」请求新孩子，页数不够时停在空态且分页控件只在非空分支渲染（家长无法自救）；加 `useEffect(() => setPage(1), [studentId])`。
- **埋点不得影响请求**：analytics 日志走内存 buffer —— 满时丢最旧、失败批次直接丢弃不重试、**永不抛**；ledger / request-log 写入**绝不在请求路径上 await**。
- **埋点（学习会话）**：`active_seconds` **只由服务端**按 `last_heartbeat_at` 差值累加、**单次封顶 45s**、只在上一状态 visible 时计（客户端上报秒数不采信）。埋点写入**永不阻断主链路**：三个采集端点的失败由**前端传输层吞掉**（`analytics/tracker.ts` 全 `.catch(() => {})`，故端点允许 DB 失败直接 500）；**嵌在业务流里**的埋点（如家长 GET 的 `closeStale`）必须 catch、失败只 warn。家长端「学习时长（会话）」与「近 7 天活跃天数」是**两套口径、并存不替换**，UI 必须并列展示并区分文案。
- **`input_tokens` / `output_tokens` 可为 NULL，NULL = 量不到**：量不到就写 NULL，**绝不写 0**（否则报表分不清「缺口」与「真实读数」；本期只记 token，不记价格/成本）。
- **不用 WebSocket**（2026-09-21 用户裁决）：全仓无 WS 实现、也不再引入。AI 流式一律走 **SSE**（`POST /api/ai/tutor/stream`、`GET /api/refinery/tasks/{taskId}/stream`、`POST /api/admin/chat/stream`）；家长端预警靠 **30s 轮询**（`GET /api/parent/alerts/unread`）。

