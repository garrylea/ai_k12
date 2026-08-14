# AI_k12: Intelligent Specialized Breakthrough & Self-Learning System

## Project Vision
AI_k12 is a next-generation, adaptive learning platform designed for K12 education. It leverages artificial intelligence to provide personalized learning paths, hierarchical knowledge explanations, and precision assessment across core subjects (Math, Chinese, English, Physics, Chemistry, and Moral & Rule of Law).

The goal is to move away from "blanket teaching" towards "precision learning" by diagnosing student levels and providing targeted, deep-dive explanations and practice.

## Core Features
- **Diagnostic Engine**: Precision assessment of student's current academic level.
- **Hierarchical Knowledge System**: Systemic explanations ranging from broad semester overviews to deep-dives into specific granular points.
- **Adaptive Learning Loop**: Exercises that assess absorption and provide targeted remedial explanations.
- **Multi-level Proficiency Testing**: Tiered assessments to verify mastery.
- **Intelligent Q&A**: An AI tutor that guides students through problem-solving rather than just providing answers.

## Technology Stack
- **Frontend**: React (latest)
- **Desktop App**: Electron
- **Backend**: Node.js
- **Data Crawling & Processing**: Python
- **Core AI**: LLM-driven (Prompt Engineering & RAG)

## Project Structure
- `apps/web`: React-based web application.
- `apps/desktop`: Electron-based desktop application.
- `apps/server`: Node.js backend API (NestJS + ai-core AI Agent Hub).
- `tools/crawler`: Python-based data crawling and processing service.
- `packages/`: Shared configurations and types.
- `docs/`: Design documents and requirements.

## 快速启动 (Quick Start)

### 前置条件
- **Node.js**：推荐 LTS 版本。
- **MySQL 8.x**：Server 端连接所需。首次可用 `tools/db/install_mysql.sh` 初始化库（建 schema + seed 学科），库名/账号默认 `ai_k12/ai_k12@localhost/ai_k12`。
- 各端依赖分别安装（monorepo 未统一装包）：在 `apps/web`、`apps/server` 目录下各执行一次 `npm install`。

### Web 端 (`apps/web`)

Vite + React + TypeScript 前端，所有命令在 `apps/web/` 下执行：

```bash
cd apps/web
npm install          # 首次安装依赖
npm run dev          # 启动开发服务器，访问 http://localhost:5173
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器（默认端口 5173） |
| `npm run build` | `tsc -b` 类型检查 + `vite build` 打包 |
| `npm run preview` | 本地预览生产构建 |
| `npm run lint` | ESLint 检查 `.ts/.tsx` |

### Server 端 (`apps/server`)

NestJS 后端，内含 ai-core AI Agent Hub。开发服务器默认监听 `http://localhost:3001`，CORS 已放行 `localhost:5173/5174/3000`。所有命令在 `apps/server/` 下执行：

```bash
cd apps/server
npm install          # 首次安装依赖
cp .env.example .env # 复制环境变量模板，并按下方说明填写
npm run start:dev    # 开发模式：免编译热重载，监听 http://localhost:3001
```

> ℹ️ 开发用 `npm run start:dev`（`node --watch` + `@swc-node/register`，免编译热重载，已实测 DI 正常）。生产或需稳定启动时用 `npm run build && npm start`（`tsc` 编译后 `node dist/main.js`）。**不要用 `tsx` 直接跑** `src/main.ts`——会导致 NestJS 依赖注入失效（实测不可用）。

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run start:dev` | 开发热重载（swc-node，免编译，推荐开发用） |
| `npm run build` | `tsc` 类型检查 + 编译到 `dist/` |
| `npm start` / `npm run start:prod` | 运行 `node dist/main.js`（需先 `build`） |
| `npm test` | `vitest run` 执行单元测试 |
| `npm run test:watch` | vitest watch 模式 |

#### 环境变量 (`.env`)

`apps/server/.env.example` 仅含 LLM 凭证模板，实际运行还需补充 DB 与 JWT 配置。完整所需项：

- **LLM 提供商**（至少填一个，含 `*_BASE_URL` + `*_API_KEY`）：
  - `KIMI_API_KEY` / `QWEN_API_KEY` / `GEMINI_API_KEY` / `DEEPSEEK_API_KEY`
  - 注意：ai-core 专属变量，**不要用 `ANTHROPIC_*`**（会被 shell 里的 Claude Code 覆盖）。
- **数据库**：`DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`（默认 `ai_k12`）。
- **鉴权**：`JWT_SECRET`。
- **可选**：`PORT`（默认 `3001`）、`UPLOAD_DIR`（用户上传图片目录，默认 `./uploads`）。

### 本地联调

```bash
# 终端 1：启动后端
cd apps/server && npm run start:dev            # http://localhost:3001（开发热重载）

# 终端 2：启动前端
cd apps/web && npm run dev                     # http://localhost:5173
```

前端默认通过 `/api/*` 访问后端；后端启动时会把 `tools/data-refinery/output/assets` 挂到 `/assets/`、`UPLOAD_DIR` 挂到 `/uploads/` 提供静态服务。

## Development Roadmap (Phase 1: Knowledge Learning System)
1. Initialize Project Skeleton
2. Design Hierarchical Knowledge Data Model
3. Build Node.js Knowledge API
4. Build React Knowledge Navigation & Display UI
5. Electron Desktop Integration
