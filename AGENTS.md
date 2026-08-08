# Repository Guidelines

## Project Structure & Module Organization

AI_k12 (K12智学系统) is a monorepo for an adaptive, AI-powered K-12 learning platform:

- `apps/web` — React frontend (Vite + TypeScript + Tailwind CSS)
- `apps/server` — NestJS backend API; `src/ai-core` holds the AI Agent Hub
- `apps/desktop` — planned Electron wrapper
- `tools/crawler`, `tools/data-refinery` — Python crawling and data-processing pipelines
- `tools/db` — MySQL schema and setup scripts
- `docs/` — PRD, architecture, API, and UX/UI design documents

## Build, Test, and Development Commands

Frontend, from `apps/web/`:

- `npm run dev` — Vite dev server at http://localhost:5173
- `npm run build` — type-check (`tsc -b`) then bundle with Vite
- `npm run lint` — ESLint over `.ts`/`.tsx` files

Backend, from `apps/server/`:

- `npm test` — run the Vitest suite once; `npm run test:watch` re-runs on change
- `npm run build` — type-check and emit to `dist/`
- `npm run start:dev` — run the API with hot reload

Python tools, from each `tools/*` directory:

- `pip install -r requirements.txt` then `pytest`

## Coding Style & Naming Conventions

- TypeScript is strict; use 2-space indentation, PascalCase for components/classes, and camelCase for functions and variables
- Python follows PEP 8 with `snake_case`
- Run `npm run lint` in `apps/web` before committing; no formatter is configured yet

## Testing Guidelines

- `apps/server`: Vitest. Unit tests sit next to source as `*.test.ts`/`*.spec.ts` and run with `npm test`. LLM eval scripts under `src/ai-core/__tests__` require API keys and run via `tsx`
- Python tools: pytest. Tests live in `tests/` as `test_*.py` with shared fixtures in `conftest.py`; network-dependent tests are marked `network` and skipped by default

## Commit & Pull Request Guidelines

Git history uses Conventional Commits: `feat(scope): subject`, `fix(scope): ...`, `test(scope): ...`, `docs(scope): ...`. Common scopes are `web`, `server`, `aux`, `ai-core`, `data-refinery`, `toc_parse`, and `db_loader`. Example: `feat(web): refactor CourseDetailPage layout`.

Pull requests should describe the change, link related issues, and reference the governing design-doc section (e.g., PRD §7.10) when behavior changes. Include screenshots for UI work.

## Documentation

`docs/` is the source of truth: read the PRD before implementing features and keep design documents in sync with code changes.
