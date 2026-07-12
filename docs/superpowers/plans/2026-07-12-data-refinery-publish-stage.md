# Data Refinery publish 阶段实施计划（素材物化 + 路径改写 + 入库）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**创建日期：** 2026-07-12
**前置：** `tools/data-refinery/` 的 convert / extract pipeline 已完成并对齐（见 `docs/文档转换设计.md`）。

> **进展（2026-07-12）：** Task 1（asset_store）、Task 2（image_rewrite）、Task 4（publish_cli）已实现并测试（57 passed），产出 `output/published/<stem>.jsonl` + `output/assets/`。采用 §5.2 方案 2（源相对稳定键，暂不入库）。**Task 3（db_loader）后置**——待教材元数据映射（§8 #1）确定后再实现。Task 5 文档/静态服务说明已完成，apps/server 接线待后端就绪。

---

## 1. 背景与问题

`extract_cli.py` 当前输出 `<stem>.jsonl`，每条记录的 `content` / `options` / `explanation` 里保留 mineru 原始图片相对路径 `![alt](images/xxx.jpg)`，指向 `output/md/<rel>/images/`。这导致：

1. **web 服务无法服务图片**：路径相对 md 文件所在目录，该目录未被 web 服务暴露。
2. **未上传到对象存储/静态资源目录**。
3. **不符合数据库设计文档 §9 规范**：§9 规定素材统一存 `/assets/{questions|materials|textbooks}/{subject}/{id}/stem_01.png`，DB 仅存相对路径，前端运行时拼 `ASSET_BASE_URL`（CDN）。
4. **`cards.content_metadata.images[].url`、`questions.options[].image_url` 从未填充**（schema 已预留，见 `tools/db/schema.sql`）。

架构文档（`docs/K12智学系统-架构设计文档.md` §4.2.3）明确："Data Refinery 批量模式…提取题目后写入 Content Service"。当前实现只到 extract（产出 JSONL），缺中间的 **publish 阶段**。

## 2. Goal

在 `tools/data-refinery/` 新增 publish 阶段，桥接 extract 输出与 Content Service：

1. **素材物化**：把 `output/md/<rel>/images/*` 复制到规范资源目录，按 §9 命名。
2. **路径改写**：把 JSON 里的 `images/xxx.jpg` 改写为规范相对路径；填充 `content_metadata.images[]` / `options[].image_url`。
3. **DB 入库**：批量 `INSERT` 进 MySQL `cards` / `questions`，分配 ID、解析 `lesson_id` / `subject_id`。
4. **静态服务**：开发期以 `ASSET_BASE_URL=http://localhost:3000/assets/` 暴露资源目录。

## 3. 范围决策（已与用户确认）

- **图片存储目标**：本地 `tools/data-refinery/output/assets/` + 静态服务（开发/MVP）。**暂不接 OSS/MinIO**，但 `AssetStore` 抽象成接口，后续可平滑替换为 OSS 实现。
- **本次只产计划文档**，不写实现代码。

## 4. Architecture

```
extract 输出                 publish 阶段                          Content Service (MySQL)
output/extracted/            output/assets/                        cards / questions 表
  <stem>.jsonl  ──►  ① 物化图片 ──►  /assets/questions/{subject}/{id}/stem_01.png
                     ② 改写路径       /assets/textbooks/{subject}/{lesson_id}/page_01_fig_01.png
                     ③ 入库    ─────────────────────────────────────►  INSERT cards/questions
```

publish 是独立 CLI（`publish_cli.py`），与 convert/extract 同级，复用 `RefineryConfig` / `RefineryCheckpoint` 模式。

### 目录结构（新增）

```
tools/data-refinery/
├── output/
│   ├── md/                  # convert 产物（已有）
│   ├── extracted/           # extract 产物（已有，<stem>.jsonl）
│   └── assets/              # 【新】规范资源目录，按 §9 结构
│       ├── questions/{subject}/{question_id}/stem_01.png ...
│       ├── materials/{subject}/{group_id}/content.md ...
│       └── textbooks/{subject}/{lesson_id}/page_01_fig_01.png ...
└── src/
    ├── publish_cli.py       # 【新】publish 子命令入口
    ├── asset_store.py       # 【新】AssetStore 抽象 + LocalAssetStore 实现
    ├── image_rewrite.py     # 【新】图片路径改写 + content_metadata/options 填充
    ├── db_loader.py         # 【新】批量入库 MySQL（cards/questions）
    └── ...
```

## 5. 关键设计点

### 5.1 图片名 → 规范名映射

mineru 输出 `images/abc123.jpg`（任意名）。规范名按图片**出现位置**决定（§9.2）：

| 出现位置 | 规范名 | 例 |
|---|---|---|
| 题干 `content` | `stem_{NN}.{ext}` | `stem_01.png` |
| 选项 `options[].image_url` | `opt_{label}.{ext}` | `opt_a.png` |
| 解析 `explanation` | `explain_{NN}.{ext}` | `explain_01.png` |
| 卡片正文 `content` | `page_{页码}_fig_{NN}.{ext}` | `page_01_fig_01.png` |
| 材料配图 | `fig_{NN}.{ext}` | `fig_01.png` |

**实现要点**：解析每条记录的 `content` / `options` / `explanation` 中的 `![alt](images/xxx.jpg)` 引用，按出现顺序编号，复制对应图片文件并改名。需读 `output/md/<rel>/images/` 拿到源文件。

### 5.2 资源路径与 DB ID 的先后（鸡生蛋）

§9 路径含 `{question_id}` / `{lesson_id}`，而 ID 由 DB `AUTO_INCREMENT` 产生。两种方案：

- **方案 1（两阶段入库，推荐）**：① 先 `INSERT` 记录（`content` 暂留原始 `images/xxx.jpg`）拿回 ID；② 物化图片到 `assets/.../{id}/`；③ `UPDATE` 对应行的 `content` / `options` / `explanation` / `content_metadata` 为改写后路径。优点：完全符合 §9；缺点：每条需 UPDATE，批次内多一轮 DB 操作。
- **方案 2（稳定源相对键）**：用与 DB ID 无关的键（如 `questions/{subject}/{paper_hash}/{q_idx}/stem_01.png`），一次 `INSERT` 即可。优点：单次入库；缺点：偏离 §9 的 `{question_id}` 约定，下游需知此例外。

**建议**：MVP 用方案 1，保证与 §9 / 前端 `resolveAssetUrl()` 完全一致。

### 5.3 `subject_id` / `lesson_id` 解析

- `subject_id`：MVP 只有数学（`math`），可从 `rel_path` 顶层目录或 `RefineryConfig` 默认推导。需查 `subjects` 表拿 `id`。
- `lesson_id`（cards 必填 FK）：需把"教材版本 → 学期 → 单元 → 课"映射到 `output/md/数学/初中/人教版/九年级/上册/书名/` 这类 `rel_path`。**这是未决问题**：爬虫目录结构如何映射到 `lessons` 表？可能需要一份人工/半自动的"教材元数据映射表"（书名 → textbook_version_id/lesson_id 序列）。

### 5.4 静态服务配置

开发期 web 服务把 `tools/data-refinery/output/assets/` 暴露为静态目录，环境变量：

| 环境 | `ASSET_BASE_URL` |
|---|---|
| 本地开发 | `http://localhost:3000/assets/` |
| 测试 / 生产 | CDN（后续 OSS 接入后切换） |

前端 `resolveAssetUrl('questions/math/1024/stem_01.png')` → `http://localhost:3000/assets/questions/math/1024/stem_01.png`。

### 5.5 `AssetStore` 抽象

```python
class AssetStore(Protocol):
    def put(self, rel_path: str, src_file: Path) -> str: ...  # 返回规范相对路径
    def exists(self, rel_path: str) -> bool: ...
```

`LocalAssetStore`：复制到 `output/assets/<rel_path>`。后续 `OssAssetStore`：上传到 OSS 同路径。DB 存的相对路径不变，只换 `ASSET_BASE_URL`。

## 6. Task 分解

### Task 1: `asset_store.py` — `AssetStore` 抽象 + `LocalAssetStore`

- [ ] Step 1: 实现 `AssetStore` Protocol + `LocalAssetStore`（复制文件到 `output/assets/<rel>`，幂等、自动建目录）
- [ ] Step 2: 测试（`test_asset_store.py`：put 后 exists、重复 put 幂等、子目录自动创建）

### Task 2: `image_rewrite.py` — 图片引用解析与改写

- [ ] Step 1: 实现 `rewrite_item(item, kind, md_images_dir, asset_store, asset_prefix)`：扫描 `content`/`options`/`explanation` 的 `![](images/xxx.jpg)`，按 §9 规范名复制图片，改写路径，填充 `content_metadata.images[]` / `options[].image_url`
- [ ] Step 2: 测试（`test_image_rewrite.py`：题干图→stem_NN、选项图→opt_a、卡片图→page_NN_fig_NN、无图记录原样返回）

### Task 3: `db_loader.py` — 批量入库 MySQL

- [ ] Step 1: 实现两阶段入库（INSERT 拿 ID → 物化 → UPDATE content 路径）；解析 `subject_id`/`lesson_id`
- [ ] Step 2: 测试（用 sqlite/mysql mock 或 `pytest-mysql`；验证行数、ID 回填、content 路径已改写）

### Task 4: `publish_cli.py` — publish 子命令入口

- [ ] Step 1: 实现 CLI（`--input-dir`=extracted、`--source`、`--force`、`--dry-run`、`--db-url`），串联 asset_store + image_rewrite + db_loader，复用 checkpoint
- [ ] Step 2: 测试（`test_publish_cli.py`：dry-run 打印计划、端到端跑通一份试卷 + 一本教材页）

### Task 5: 静态服务接线 + 文档同步

- [ ] Step 1: 在 `apps/server`（就绪后）或开发期静态服务器暴露 `output/assets/`，配置 `ASSET_BASE_URL`
- [ ] Step 2: 更新 `docs/文档转换设计.md` 增补 publish 阶段章节；更新 `README.md` 用法；更新 `docs/API接口与数据流设计文档.md` 与 `openapi.yaml`（如涉及 `/api/content/cards/{id}` 返回的图片 URL 约定）
- [ ] Step 3: 更新 `docs/data-refinery-文档对齐总结.md` 3.7 节状态

## 7. 自检清单

- [ ] `content`/`options`/`explanation` 中无残留 `images/xxx.jpg` 原始路径
- [ ] 所有图片在 `output/assets/` 下可按规范路径访问
- [ ] `cards.content_metadata.images[].url`、`questions.options[].image_url` 已填充
- [ ] DB `cards`/`questions` 行数与 JSONL 记录数一致
- [ ] 资源路径符合 §9（`{question_id}` / `{lesson_id}`）
- [ ] `AssetStore` 抽象可替换为 OSS 实现而不改 db_loader / image_rewrite
- [ ] 前端 `resolveAssetUrl()` 拼接后可取到图片

## 8. 未决问题（实现前需确认）

1. **教材元数据映射**：`rel_path`（如 `数学/初中/人教版/九年级/上册/书名/`）如何映射到 `textbook_versions`/`semesters`/`units`/`lessons`？是否需要一份"书名 → lesson 序列"映射表？谁维护？
2. **`textbook_page` 推导**：extract 已移除 `extra_context`，`textbook_page` 需从 `page_NNN.md` 文件名推导（publish 阶段可补）。
3. **图片与题干/选项的位置关联**：LLM 输出的 `content` 里 `![](images/xxx.jpg)` 的位置是否足够判定属题干还是解析？若 LLM 把图归错字段，需人工校验。
4. **入库幂等**：重跑 publish 如何避免重复 INSERT？以 `source` + `source_year` + 题干 hash 做去重键，或清表重灌？
5. **MySQL 连接配置**：`RefineryConfig` 需新增 `DB_URL` / `MINERU_DB_*` 环境变量。

---

**相关文档：**
- `docs/K12智学系统-数据库设计文档.md` §9（素材存储规范）、§3.2（cards 表）、§3.3（questions 表）
- `docs/K12智学系统-架构设计文档.md` §4.2.3（Data Refinery）
- `docs/文档转换设计.md`（convert/extract 现状）
- `tools/db/schema.sql`（`cards` / `questions` / `uploaded_files` 表定义）
