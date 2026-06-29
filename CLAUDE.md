# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

K12 智学系统 — an adaptive AI-powered K-12 education platform for Chinese students. MVP scope: Mathematics only. The platform uses a dual-track learning model (mainline structured progression + auxiliary free exploration) with Socratic AI tutoring.

## Monorepo Structure

```
apps/web/        — Active. React frontend (Vite + TypeScript + Tailwind)
apps/server/     — Planned. Node.js backend
apps/desktop/    — Planned. Electron wrapper
packages/        — Planned. Shared configs/types
tools/crawler/   — Planned. Python data pipeline
docs/            — PRD, AI tutoring flow design, UX/UI design doc
```

Only `apps/web` has working code. No monorepo workspace tooling is configured yet.

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
