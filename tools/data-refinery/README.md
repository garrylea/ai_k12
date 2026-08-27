# Data Refinery（批量模式）

离线数据准备工具，将爬虫下载的 PDF/教材图片转换为 Markdown，再调用 LLM 提取结构化题目或教材卡片。

## 目录

```
tools/data-refinery/
├── src/
│   ├── config.py             # 配置加载（.env）
│   ├── scanner.py            # 素材扫描器（PDF / 图片书）
│   ├── checkpoint.py         # 断点续传
│   ├── convert.py            # MinerU 调用（含 resume：已有 .md 的页跳过）
│   ├── convert_cli.py        # convert 子命令
│   ├── markdown_scanner.py   # Markdown 扫描器
│   ├── image_scan.py         # 页面图片扫描（尺寸 + 折算字数，小图标舍弃）
│   ├── card_splitter.py      # 卡片拆分（内容不动，按标题/长度/图片切块）
│   ├── card_labeler.py       # LLM 卡片标注（page_type/card_type/lesson_id/title）
│   ├── extract.py            # LLM 提取器（试卷题目）
│   ├── extract_cli.py        # extract 子命令
│   ├── toc_parse_cli.py      # 目录页 -> TOC JSON 子命令
│   ├── image_rewrite.py      # 图片引用物化 + 路径改写
│   ├── asset_store.py       # 资产存储
│   ├── publish_cli.py        # publish 子命令
│   ├── db_loader.py          # MySQL 入库（find-or-create 结构 + full-reload）
│   ├── db_loader_cli.py      # db_loader 子命令
│   ├── refinery_cli.py       # 串联 publish + db_loader 一键执行
│   ├── llm.py                # LLM 客户端（多 provider 工厂）
│   ├── models.py             # Pydantic 数据模型
│   ├── prompts/              # Prompt 模板
│   │   ├── exam_questions.txt
│   │   ├── textbook_cards.txt
│   │   └── toc_parse.txt
│   ├── backfill_practice_questions.py  # 一次性：回填练习题（历史数据）
│   └── migrate_flat_to_groups.py        # 一次性：扁平结构迁移到 groups（历史数据）
├── tests/
├── requirements.txt
└── .env.example
```

## 安装

```bash
cd tools/data-refinery
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

复制并编辑环境变量：

```bash
cp .env.example .env
# 填入 LLM_AUTH_TOKEN（refinery 专属鉴权，勿用 ANTHROPIC_* 会被 shell 覆盖）、DB_* 等
```

## 使用

### 1. convert：素材 → Markdown

```bash
python src/convert_cli.py --source zgkao --dry-run
python src/convert_cli.py --source smartedu
```

输出到 `tools/data-refinery/output/md/`，保留 MinerU 生成的 `.md`、`images/` 及中间文件。

### 2. extract：Markdown → 结构化 JSONL

```bash
python src/extract_cli.py --source zgkao --dry-run
python src/extract_cli.py --source smartedu
```

只提取单个文件（按相对路径子串匹配，如某份漏抽的试卷）：

```bash
python src/extract_cli.py --file "2024/数学-初三(下)-202407-西城-模拟二-试卷"
```

输出到 `tools/data-refinery/output/extracted/`，每份 Markdown 镜像一个 `<stem>.jsonl`（如 `page_001.jsonl`、`<试卷名>.jsonl`），多页教材各自独立、互不覆盖。

**lesson_id（教材卡片）**：LLM 每张卡片输出小节/章标题原文作为标识，续页/续卡片填 null，由 CLI 按书跨页继承（per-book running 状态），保证一节的内容落在同一 lesson_id。章前综述归该章"第 0 节"。封面/目录/版权/前言等前置内容不抽取（输出空 items）。断点续传时从已抽页 jsonl 回填状态。`--file` 只抽单页时不携带跨页状态，续页 card 的 lesson_id 可能为 null。

### 3. publish：物化图片 + 改写路径 -> published JSONL

```bash
python src/publish_cli.py --source zgkao --dry-run
python src/publish_cli.py --source smartedu
```

读 `output/extracted/` 的 `<stem>.jsonl`，把 `content`/`options`/`explanation` 里的原始图片引用 `![](images/xxx.jpg)` 按 §9 规范名（`stem_NN`、`opt_{label}`、`explain_NN`、`page_{N}_fig_{NN}`）物化到 `output/assets/`，改写为规范相对路径，并填充 `content_metadata.images[]` / `options[].image_url`。产物写到 `output/published/`（与 extracted 同构的 `<stem>.jsonl`）。

> 资源路径用源相对稳定键（`questions/{subject}/{hash}/{idx}`、`textbooks/{subject}/{hash}/{sort_order}`）。subject 按文件路径首段推导（2026-08-26 前曾硬编码 `math` 误标化学，已修）。

#### 开发期静态服务（让 web 能取到图片）

`output/assets/` 需以静态目录暴露，前端通过 `ASSET_BASE_URL` 拼接：

```bash
# 临时静态服务（示例）
cd tools/data-refinery/output && python3 -m http.server 3000
# ASSET_BASE_URL=http://localhost:3000/assets/
```

前端 `resolveAssetUrl('questions/math/.../stem_01.jpg')` -> `http://localhost:3000/assets/questions/math/.../stem_01.jpg`。生产环境切换 CDN/OSS 只改 `ASSET_BASE_URL`。

### 4. db_loader：published JSONL -> MySQL

三种模式：

```bash
python src/db_loader_cli.py --source all --dry-run   # 模式 A 试运行
python src/db_loader_cli.py --source all              # 模式 A：全量重载（默认）
python src/db_loader_cli.py --load-toc --toc-path output/toc/数学/初中/人教版/九年级/下册/书名.json   # 模式 B：只建 TOC 骨架
python src/db_loader_cli.py --load-cards --toc-path output/toc/....json                            # 模式 C：只入库不 reset
```

读 `output/published/<stem>.jsonl`，按 kind 入库：

- **cards**（教材）：按书目录分组、按页顺序收集，`sort_order` 跨页全局重排（保证 `uniq_cards_lesson_sort` 不碰撞）；解析 `rel_path`（`学科/学段/版本/年级/学期/书名`）派生 `textbook_versions`+`semesters`；解析 `lesson_id` 标签（`第N章 X` 章综述、`N.M[.K] X` 节）派生 `units`+`lessons`；`lesson_id` 标签映射到 `lessons.id` 后 INSERT cards。
- **questions**（试卷）：`subject_id` 别名归一（`chem`->`chemistry`）-> `subjects.id`，INSERT questions。

幂等：full-reload。每次跑先 `DELETE textbook_versions`（级联清 cards/lessons/units/semesters）+ `DELETE questions`，再重插；结构 find-or-create。`--source smartedu` 只清 cards 侧，`zgkao` 只清 questions。`--dry-run` 只列文件不入库。

**业务数据守卫（FK 保护）**：`answers`/错题本/`variation_questions`/`progress` 等业务表对 questions/cards/textbook_versions 有 `ON DELETE RESTRICT` 外键。full-reload 前会预检这些表：有数据且未传 `--purge-business-data` 时**报错退出**（防止误删学生数据）。两条出路：① 加 `--purge-business-data` 显式清空业务表后重载（不可恢复）；② 改用模式 C（`--load-cards`，增量入库，不动业务数据）。

> DB 初始化（含 `subjects` seed）由 `tools/db/install_mysql.sh` 完成；连接配置见下表 `DB_*`。

### 5. refinery：一键串联 publish + db_loader

```bash
python src/refinery_cli.py --source all            # publish + db_loader
python src/refinery_cli.py --source all --dry-run  # 两步都只打印
python src/refinery_cli.py --skip-publish          # 只 db_loader
python src/refinery_cli.py --skip-load             # 只 publish
python src/refinery_cli.py --purge-business-data   # 库里有业务数据时显式清空后全量重载
```

把后段（extracted -> published -> MySQL）串起来一键跑。前段（`convert_cli` 素材->md、`extract_cli` md->extracted）仍单独执行。`--source` / `--dry-run` / `--purge-business-data` 透传给两步。

> 完整参数表与推荐工作流见 [使用手册](../../docs/data-refinery-使用手册.md)。

## 配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `REFINERY_INPUT_DIR` | 素材输入目录 | `tools/crawler/data` |
| `REFINERY_OUTPUT_DIR` | 结果输出根目录（md/extracted/toc/published 都在其下） | `tools/data-refinery/output` |
| `MINERU_BIN` | MinerU 可执行文件 | `mineru-open-api` |
| `MINERU_TIMEOUT` | MinerU 超时（秒） | `300` |
| `MINERU_TOKEN` | MinerU API token（由 MinerU CLI 直接读取） | - |
| `LLM_PROVIDER` | LLM 提供商（openai/kimi/qwen/glm/deepseek/gemini/local/anthropic） | `openai` |
| `LLM_MODEL` | 模型名称 | `gpt-4o` |
| `LLM_AUTH_TOKEN` | **推荐**。refinery 专属鉴权（勿用 `ANTHROPIC_*` 会被 shell 里 Claude Code 覆盖） | - |
| `LLM_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | API 密钥 fallback 链 | - |
| `LLM_BASE_URL` | 自定义 API 地址 | - |
| `LLM_TIMEOUT` | LLM 超时（秒） | `120` |
| `LLM_MAX_RETRIES` | 最大重试次数 | `3` |
| `LLM_MAX_TOKENS` | 最大输出 tokens（DeepSeek reasoner 建议 65536） | `16384` |
| `LLM_THINKING` | thinking 模式开关 | `false` |
| `LLM_ENABLE_CACHE` | provider 侧 prompt 缓存开关 | `false` |
| `DB_HOST` / `DB_PORT` | MySQL 地址 / 端口 | `localhost` / `3306` |
| `DB_USER` / `DB_PASS` | MySQL 业务用户 / 密码（db_loader 用） | `ai_k12` / - |
| `DB_NAME` | MySQL 库名 | `ai_k12` |

## 测试

```bash
pytest tests/ -q
```
