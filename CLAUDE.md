# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

K12 智学系统 — an adaptive AI-powered K-12 education platform for Chinese students. MVP scope: Mathematics only. The platform uses a dual-track learning model (mainline structured progression + auxiliary free exploration) with Socratic AI tutoring.

## Monorepo Structure

```
apps/web/             — Active. React frontend (Vite + TypeScript + Tailwind)
apps/server/          — Planned. Node.js backend（下一个大件，见下文 Data Refinery 节）
apps/desktop/         — Planned. Electron wrapper
packages/             — Planned. Shared configs/types
tools/crawler/        — Active. 爬虫（zgkao 试卷 / smartedu 教材）
tools/data-refinery/  — Active. 数据管线 convert->extract->publish->db_loader（见下文）
tools/db/             — Active. MySQL schema + install_mysql.sh
docs/                 — PRD, API 设计, UX/UI, DB 设计, 数据管线总结
```

`apps/web` 与 `tools/data-refinery`、`tools/db` 已有可运行代码；`apps/server` 待建。

## Development Commands

All commands run from `apps/web/`:

```bash
npm run dev      # Vite dev server at http://localhost:5173
npm run build    # tsc -b + vite build (type-check then bundle)
npm run preview  # Serve production build locally
npm run lint     # ESLint for .ts/.tsx
```

No test framework is configured yet.

## Architecture (apps/web)

### Theme System

Three themes via CSS variables + `data-theme` attribute on containers:
- `student-day` — warm orange-red palette (default)
- `student-night` — dark tea-gold, auto-activates 18:00–06:00 via Zustand themeStore
- `parent` — business blue-white, forced day mode

Night mode only applies inside `.student-theme-container` (learning immersion pages). Login, subject select, star map, and parent pages are physically excluded from night mode.

### School-level Font Scaling

`data-school` attribute (`primary`/`junior`/`senior`) adjusts font sizes only — colors and radii stay consistent across all levels.

### Visual Distinction: Dual-track

- Mainline: orange-red (#E55A2B)
- Auxiliary: purple (#8B5A8E)

These must be visually distinct in navigation, tags, and error books.

### Component Layers

- `src/components/base/` — Reusable UI primitives (Button, Input, Card, Modal, Toast, etc.)
- `src/components/business/` — Domain components (PlanetNode, SectionCard, AIDialogue, TextbookCard, etc.)
- `src/components/layout/` — Page shells (StudentLayout, ParentLayout with nav + header + outlet)

### Routing

React Router 6 with `createBrowserRouter`. Login auto-routes by username format: phone number → parent, otherwise → student.

### State

Zustand for theme/motion preferences. No API layer yet.

### Design Tokens

`src/tokens/` contains JSON files (colors, layout, typography) that are the source of truth for CSS variable generation.

## Mandatory Design Constraints

Before any UI work, read the authoritative docs:
- `docs/K12智学系统-产品需求文档.md` — PRD (single source of truth for all features)
- `docs/UX-UI设计文档.md` — Page specs and responsive rules
- `apps/web/style.md` — Color palette, typography, spacing (the only style reference)

Hard rules:
1. No emoji in UI/components/copy. Icons must be linear SVG.
2. No mascots or decorative elements (rainbows, balloons, stars).
3. Single unified color palette from style.md — no per-school-level color variations.
4. PRD overrides any design decision. Conflicts must be resolved with the user before implementation.
5. iPad landscape (>=1024px) is the primary breakpoint; PC (>=1280px) secondary; mobile deferred.
6. Socratic principle: "hint" and "discuss" buttons always more prominent than "show answer".
7. Mainline progression requires error-clearing before unlock — never skip this gate.
8. **No mini-program support**: the platform targets WebApp, PC App (Electron), and parent-facing Web only. Do not introduce WeChat mini-program, Alipay mini-program, or any other mini-program specific code, APIs, build targets, or documentation references.

## API 文档同步规则

`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 互为对照，必须始终保持一致：

1. **任何一方变更时，另一方必须同步更新**。新增、删除或修改端点（路径、方法、参数、响应结构）时，两份文档都要一并调整。
2. **以 API 设计文档为主稿**：端点清单（§4）和数据流（§6）定义需求级别和业务语义；openapi.yaml 是其机器可读实现，用于代码生成和接口测试。
3. **阶段标记**：openapi.yaml 当前仅收录 MVP 阶段端点。P1/P2 端点在 API 设计文档中标注阶段，待进入开发时再补入 openapi.yaml。
4. **检查清单**：每次 API 变更后，运行 `grep` 或对比两文档的端点路径列表，确认无遗漏。

## Data Refinery 数据管线

`tools/data-refinery/` 是离线数据准备管线，四阶段顺序执行：

```
convert_cli (MinerU) -> extract_cli (LLM) -> publish_cli (物化图片) -> db_loader_cli (MySQL)
```

`refinery_cli.py` 串联 publish + db_loader 一键执行；DB 由 `tools/db/install_mysql.sh` 初始化（schema + subjects seed）。

**现状**：管线已端到端跑通（105 tests），DB `ai_k12` 有 34 cards + 466 questions。详细总结与后续见 `docs/data-refinery-管线总结与后续.md`。

**改代码前必读的关键约定**（详见上述总结文档 §3）：
- LLM 配置用 `.env` 的 `LLM_BASE_URL`/`LLM_AUTH_TOKEN`（refinery 专属），**不要用 `ANTHROPIC_*`**（会被 shell 里 Claude Code 覆盖）。当前用 DeepSeek `deepseek-v4-flash`（reasoner，需 `LLM_MAX_TOKENS=65536`）。
- extract：lesson_id 由 LLM 给标题标识 + CLI 跨页继承（per-book 状态）；只有编号标题（`N.M`/`N.M.K`/`第N章`）开新课；章综述归该章"第 0 节"；前置内容（封面/目录/版权/前言）不抽取；试卷答案只提取不生成（从参考答案按题号提取，无则空）。
- publish：资产路径用源相对稳定键；⚠️ `SUBJECT_CODE="math"` 硬编码是遗留 bug（化学资产路径误标）。
- db_loader：subject 别名归一（chem->chemistry）、rel_path/lesson_id 解析派生教材结构、cards sort_order 跨页全局重排、full-reload 幂等。
- DB：`ai_k12/ai_k12@localhost/ai_k12`（`.env` 的 `DB_*`）。

**下一个大件**：后端 API（`apps/server`，未建）——前端 `apps/web` 还连不上 DB。API 已设计（`docs/api/openapi.yaml` + `docs/API接口与数据流设计文档.md`），等实现。
