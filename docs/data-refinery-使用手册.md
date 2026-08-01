# K12 数据管线使用手册

> **适用于**：数据工程师、开发者
> **最后更新**：2026-07-30
> **关联文档**：[管线总结](./data-refinery-管线总结与后续.md) | [TOC 设计](./data-refinery-TOC目录优先管线设计.md) | [DB 设计](./K12智学系统-数据库设计文档.md)

---

## 1. 管线总览

```
┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────┐    ┌────────┐
│ crawler  │ →  │  convert_cli │ →  │ extract_cli  │ →  │ publish   │ →  │ MySQL  │
│ (爬虫)   │    │  PDF→MD      │    │  MD→JSONL    │    │ _cli      │    │        │
│ PDF/JPG  │    │  (MinerU)    │    │  (LLM标注)   │    │ 图片物化   │    │        │
└──────────┘    └──────────────┘    └──────────────┘    └───────────┘    └────────┘
                                         ↑                                 ↑
                                    toc_parse_cli                  db_loader_cli
                                    (目录→TOC JSON)                (JSONL→MySQL)

                              refinery_cli（串联 publish + db_loader）
```

| 步骤 | 工具 | 输入 | 输出 | 核心依赖 |
|------|------|------|------|----------|
| 0 | `crawler` | 网站 URL | PDF / JPG | requests, bs4 |
| 1 | `convert_cli` | PDF / JPG | Markdown (.md) | MinerU CLI |
| 1.5 | `toc_parse_cli` | 目录页 MD | TOC JSON | LLM |
| 2 | `extract_cli` | Markdown (.md) | Cards JSONL | LLM |
| 3 | `publish_cli` | Cards JSONL | Published JSONL + assets | — |
| 4 | `db_loader_cli` | Published JSONL | MySQL (cards/questions) | pymysql |
| — | `refinery_cli` | — | — | 串联 3+4 |

---

## 2. 环境准备

### 2.1 配置文件

所有配置通过 `tools/data-refinery/.env` 设置：

```bash
# === LLM 配置（extract / toc_parse 共用）===
LLM_PROVIDER=openai                  # openai | anthropic
LLM_MODEL=deepseek-v4-flash          # 推荐 DeepSeek reasoner
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_AUTH_TOKEN=sk-xxx                # refinery 专属，勿用 ANTHROPIC_* 会被 shell 覆盖
LLM_MAX_TOKENS=65536
LLM_TIMEOUT=120

# === MinerU 配置（convert）===
MINERU_BIN=mineru-open-api
MINERU_TIMEOUT=300
MINERU_TOKEN=xxx                     # MinerU API token

# === MySQL 配置（db_loader）===
DB_HOST=localhost
DB_PORT=3306
DB_USER=ai_k12
DB_PASS=ai_k12
DB_NAME=ai_k12

# === 路径覆盖（可选）===
REFINERY_INPUT_DIR=tools/crawler/data       # 默认
REFINERY_OUTPUT_DIR=tools/data-refinery/output  # 默认
```

### 2.2 依赖安装

```bash
# Crawler
cd tools/crawler && pip install -r requirements.txt

# Data Refinery
cd tools/data-refinery && pip install -r requirements.txt
```

### 2.3 数据库初始化

```bash
cd tools/db && bash install_mysql.sh
```

---

## 3. 爬虫（Crawler）

**位置**：`tools/crawler/`  
**入口**：`python src/cli.py --site <zgkao|smartedu> [options]`

### 3.1 通用参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--site` | zgkao / smartedu | **必填** | 站点适配器 |
| `--output` | path | `./data` | 输出根目录 |
| `--force` | flag | 否 | 忽略 checkpoint，强制重下 |
| `--dry-run` | flag | 否 | 只检查不下载 |

### 3.2 zgkao — 试卷下载

从 zgkao.com 抓取试卷 PDF（含试卷和答案）。

```bash
# 下载 2024-2025 年海淀区数学试卷
python src/cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/89047.html \
  --subject 数学 \
  --year 2024,2025 \
  --district 海淀 \
  --output ./data

# 试运行：查看可下载内容
python src/cli.py --site zgkao --url https://www.zgkao.com/shitiku/89047.html --dry-run
```

| 参数 | 说明 |
|------|------|
| `--url` | **必填**。zgkao 试卷索引页 URL |
| `--subject` | 学科过滤（如 数学、英语、语文） |
| `--year` | 年份过滤，逗号分隔（如 2024,2025） |
| `--district` | 区县过滤（如 海淀、西城、东城、朝阳） |

**输出结构**：`data/{学科}/初中/second/{年份}/{试卷名}.pdf`

### 3.3 smartedu — 教材下载

从国家中小学智慧教育平台抓取教材预览图。

```bash
# 下载人教版九年级上册数学教材
python src/cli.py --site smartedu \
  --subject 数学 \
  --level 初中 \
  --grade 九年级 \
  --semester 上册 \
  --publisher 人教版 \
  --output ./data

# 只打印不下载
python src/cli.py --site smartedu --subject 数学 --level 初中 --dry-run
```

| 参数 | 说明 |
|------|------|
| `--subject` | 学科（数学、语文、英语……） |
| `--level` | 学段（小学 / 初中 / 高中） |
| `--grade` | 年级（如 九年级） |
| `--semester` | 册次（上册 / 下册） |
| `--publisher` | 版本（如 人教版） |
| `--latest-only` | 同书只取最新版（默认开启）。`--no-latest-only` 关闭 |
| `--crawl-delay` | 礼貌延时秒数（默认 smartedu=0.5, zgkao=0） |

**输出结构**：`data/{学科}/初中/{版本}/{年级}/{册次}/{书名}/page_001.jpg …`

### 3.4 断点续传

爬虫自动在 `data/.checkpoint.json` 记录已下载项，下次运行自动跳过。用 `--force` 强制重下。

---

## 4. 数据精炼（Data Refinery）

**位置**：`tools/data-refinery/`  
**工作目录**：所有命令从 `tools/data-refinery/` 运行

### 4.1 convert_cli — PDF/图片转 Markdown

调用 MinerU 将爬虫产出的 PDF/JPG 转为 Markdown。

```bash
# 转换所有素材
python src/convert_cli.py

# 只转换 smartedu 教材
python src/convert_cli.py --source smartedu

# 重新转换（删除已有输出 + 清 checkpoint）
python src/convert_cli.py --reconvert

# 试运行：查看待处理素材
python src/convert_cli.py --dry-run
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--input-dir` | path | `tools/crawler/data` | 素材输入目录 |
| `--output-dir` | path | `output/md` | Markdown 输出目录 |
| `--source` | all / zgkao / smartedu | `all` | 按来源过滤 |
| `--force` | flag | 否 | 忽略 checkpoint，处理所有未完成的 |
| `--reconvert` | flag | 否 | 删除已有输出 + 清 checkpoint，全部重转 |
| `--dry-run` | flag | 否 | 只打印不转换 |

**输出**：`output/md/{学科}/{学段}/{版本}/{年级}/{册次}/{书名}/page_001.md …`

### 4.2 toc_parse_cli — 目录解析

用 LLM 从教材目录页 MD 提取完整的章→节→子节层级，输出结构化 TOC JSON。

```bash
# 扫描所有教材的目录页（默认只处理教材，排除试卷）
python src/toc_parse_cli.py

# 指定年级+学期（支持简写）
python src/toc_parse_cli.py --grade 九上                  # 九年级上册
python src/toc_parse_cli.py --grade 9上                   # 同上
python src/toc_parse_cli.py --grade 七下                  # 七年级下册

# 指定学科+出版社
python src/toc_parse_cli.py --subject 数学 --publisher 人教版

# 组合过滤：数学 人教版 九年级上册
python src/toc_parse_cli.py --subject 数学 --publisher 人教版 --grade 九上

# 路径子串匹配（兼容旧方式）
python src/toc_parse_cli.py --book "九年级/下册"

# 重新解析
python src/toc_parse_cli.py --reconvert

# 试运行
python src/toc_parse_cli.py --dry-run
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--input-dir` | path | `output/md` | MD 输入目录 |
| `--output-dir` | path | `output/toc` | TOC JSON 输出目录 |
| `--source` | all / zgkao / smartedu | `smartedu` | 来源过滤（默认 smartedu。只有教材有目录，自动排除试卷） |
| `--subject` | str | — | 学科过滤（如 数学、语文） |
| `--publisher` | str | — | 出版社过滤（如 人教版） |
| `--grade` | str | — | 年级过滤，支持简写：`九上`→九年级上册、`9上`→九年级上册 |
| `--term` | str | — | 学期过滤：上册/下册。`--grade` 简写已含学期时无需单独指定 |
| `--book` | str | — | 路径子串匹配（兼容旧方式，如 `九年级/下册`） |
| `--reconvert` | flag | 否 | 清 checkpoint + 删已有 JSON，重新解析 |
| `--dry-run` | flag | 否 | 只打印目录页不解析 |

**输出**：`output/toc/{学科}/{版本}/{年级}/{书名}_toc.json`

**TOC JSON 格式**：见 [TOC 设计文档](./data-refinery-TOC目录优先管线设计.md) §4.1。

**重新解析**：如果 TOC JSON 内容有误（LLM 标错章节），用 `--reconvert` 配合过滤条件重新生成：

```bash
# 重新解析单本教材（推荐：用 --grade 简写定位）
python src/toc_parse_cli.py --reconvert --grade 九下

# 重新解析全部教材
python src/toc_parse_cli.py --reconvert

# 试运行看会清理哪些 checkpoint
python src/toc_parse_cli.py --reconvert --grade 九下 --dry-run
```

### 4.3 extract_cli — Markdown 提取卡片

从 MD 正文页拆分卡片，LLM 标注 card_type/lesson_id/title，输出 JSONL。

```bash
# 提取所有已转 MD
python src/extract_cli.py

# 只提取 smartedu 教材
python src/extract_cli.py --source smartedu

# 只提取第 8-20 页
python src/extract_cli.py --pages "8-20"

# 只提取指定教材
python src/extract_cli.py --book "九年级/上册"

# 带 TOC 校验 + 自动修正
python src/extract_cli.py --toc output/toc/数学/人教版/九年级/九年级上册_toc.json

# 重新提取指定页（清 checkpoint + 删 JSONL）
python src/extract_cli.py --reconvert --pages "8-20"

# 试运行
python src/extract_cli.py --dry-run
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--input-dir` | path | `output/md` | MD 输入目录 |
| `--output-dir` | path | `output/extracted` | JSONL 输出目录 |
| `--source` | all / zgkao / smartedu | `all` | 来源过滤 |
| `--file` | str | — | 文件名子串匹配 |
| `--pages` | str | — | 页码过滤，如 `1-6` 或 `1,3,5-8` |
| `--book` | str | — | 教材路径子串匹配，如 `九年级/上册` |
| `--force` | flag | 否 | 忽略 checkpoint，不删已有输出 |
| `--reconvert` | flag | 否 | 清 checkpoint + 删已有 JSONL，重新提取 |
| `--toc` | path | — | TOC JSON 路径，启用 lesson_id 校验+修正 |
| `--dry-run` | flag | 否 | 只打印不提取 |

**输出**：`output/extracted/{学科}/…/page_001.jsonl …`  
**TOC 模式额外输出**：`output/extracted/diff_report.json`（差异报告）

### 4.4 publish_cli — 图片物化与路径改写

读 extracted JSONL，把 MinerU 图片引用物化到 `output/assets/`，改写为规范相对路径。

```bash
# 发布所有
python src/publish_cli.py

# 只发布 smartedu
python src/publish_cli.py --source smartedu

# 只发布指定页（如教材第 8-20 页）
python src/publish_cli.py --pages "8-20"

# 发布指定单页 / 多页
python src/publish_cli.py --pages "12,20"

# 重新发布
python src/publish_cli.py --reconvert

# 试运行
python src/publish_cli.py --dry-run
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--input-dir` | path | `output/extracted` | extracted JSONL 目录 |
| `--output-dir` | path | `output/published` | published 输出目录 |
| `--source` | all / zgkao / smartedu | `all` | 来源过滤 |
| `--pages` | str | — | 页码过滤，如 `1-6` 或 `1,3,5-8`（仅 page_*.jsonl，试卷/答案聚合文件不受影响） |
| `--force` | flag | 否 | 忽略 checkpoint |
| `--reconvert` | flag | 否 | 清 checkpoint + 删已有输出 |
| `--dry-run` | flag | 否 | 只打印不发布 |

**输出**：`output/published/…`（JSONL，图片路径已改写）+ `output/assets/…`（物化图片）

### 4.5 db_loader_cli — MySQL 入库

将 published JSONL 加载进 MySQL。支持三种模式。

#### 模式 A：全量重载（默认，向后兼容）

```bash
# 全部入库（先删后插，幂等）
python src/db_loader_cli.py

# 只入库 smartedu cards
python src/db_loader_cli.py --source smartedu

# 试运行
python src/db_loader_cli.py --dry-run
```

#### 模式 B：仅建 TOC 骨架

先跑 `toc_parse_cli` 产出 TOC JSON，再用此模式建章节目录。

```bash
# 只建骨架，不入 card
python src/db_loader_cli.py --load-toc --toc-path output/toc/数学/人教版/九年级/下册.json
```

#### 模式 C：仅 card 入库（TOC 模式下）

骨架已由 TOC 建好，此模式只把 card 挂到已有 lesson 下。

```bash
# card 入库，不清表，带 TOC 匹配
python src/db_loader_cli.py --load-cards --toc-path output/toc/数学/人教版/九年级/下册.json
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--input-dir` | path | `output/published` | published 目录 |
| `--source` | all / zgkao / smartedu | `all` | 来源过滤 |
| `--load-toc` | flag | 否 | TOC 模式：只建骨架不入 card（需 `--toc-path`） |
| `--load-cards` | flag | 否 | Card 模式：只入库 card，不 reset（可选 `--toc-path`） |
| `--toc-path` | path | — | TOC JSON 路径 |
| `--dry-run` | flag | 否 | 只打印不入库 |

**不传 `--load-*` 时**，行为与旧版完全一致（full-reload：DELETE + 重插）。

### 4.6 refinery_cli — 后段管线串联

一键串联 publish + db_loader。

```bash
# 完整后段
python src/refinery_cli.py

# 指定来源 + 试运行
python src/refinery_cli.py --source smartedu --dry-run

# 只 publish（跳过入库）
python src/refinery_cli.py --skip-load

# 只入库（跳过 publish，要求 published 已存在）
python src/refinery_cli.py --skip-publish
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--source` | all / zgkao / smartedu | `all` | 来源过滤 |
| `--dry-run` | flag | 否 | publish + db_loader 都只打印 |
| `--skip-publish` | flag | 否 | 跳过 publish，直接 db_loader |
| `--skip-load` | flag | 否 | 跳过 db_loader，只 publish |

---

## 5. 推荐工作流

### 5.1 完整教科书入库（TOC 优先）

```bash
cd tools/data-refinery

# Step 1: 爬取教材图片
cd ../crawler
python src/cli.py --site smartedu --subject 数学 --level 初中 --grade 九年级 --semester 下册

# Step 2: 转换全部 MD（可只转部分页）
cd ../data-refinery
python src/convert_cli.py --source smartedu

# Step 3: 解析目录 → TOC JSON（简写）
python src/toc_parse_cli.py --grade 九下

# Step 4: 建 DB 骨架（整本书章节目录完整）
python src/db_loader_cli.py --load-toc \
  --toc-path output/toc/数学/人教版/九年级/义务教育教科书·数学九年级下册_toc.json

# Step 5: 提取卡片（可分批）
python src/extract_cli.py --toc output/toc/数学/人教版/九年级/义务教育教科书·数学九年级下册_toc.json \
  --pages "8-30"

# Step 6: 发布 + 入库
python src/refinery_cli.py --source smartedu
```

### 5.2 增量卡片（已有骨架，追加新页）

```bash
# 上回只转了 page_008~030，这次追加 page_031~049
python src/extract_cli.py --toc output/toc/数学/人教版/九年级/...json --pages "31-49"
python src/refinery_cli.py --source smartedu
```

### 5.3 试卷入库

```bash
# 爬虫
cd tools/crawler
python src/cli.py --site zgkao --url https://www.zgkao.com/shitiku/89047.html --year 2024,2025

# 转换 → 提取 → 入库
cd ../data-refinery
python src/convert_cli.py --source zgkao
python src/extract_cli.py --source zgkao
python src/refinery_cli.py --source zgkao
```

### 5.4 重新处理（出错了或 prompt 更新）

```bash
# 重新提取指定页
python src/extract_cli.py --reconvert --pages "8-16"

# 重新解析目录
python src/toc_parse_cli.py --reconvert --book "九年级/下册"

# 全部重做
python src/convert_cli.py --reconvert
python src/toc_parse_cli.py --reconvert
python src/extract_cli.py --reconvert
```

---

## 6. 输出目录结构

```
tools/data-refinery/output/
├── md/                          # convert 产物
│   └── 数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册/
│       ├── page_001.md ~ page_049.md
│       └── images/              # MinerU 提取的图片
├── extracted/                   # extract 产物
│   └── 数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册/
│       ├── page_008.jsonl ~ page_049.jsonl
│       └── diff_report.json     # --toc 模式产出
├── toc/                         # toc_parse 产物
│   └── 数学/人教版/九年级/
│       └── 义务教育教科书·数学九年级下册_toc.json
├── published/                   # publish 产物
│   └── 数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册/
│       └── page_008.jsonl ~ page_049.jsonl
├── assets/                      # 物化图片
│   ├── textbooks/{subject}/{hash}/{sort_order}/
│   └── questions/{subject}/{hash}/{idx}/
├── .checkpoint.json             # convert + extract checkpoint
├── .publish_checkpoint.json     # publish checkpoint
└── .toc_checkpoint.json         # toc_parse checkpoint
```

---

## 7. Checkpoint 机制

每一步都有 checkpoint 文件，记录已处理项。默认增量模式——只处理未完成的新文件。

| 步骤 | Checkpoint 文件 | 跳过条件 | 强制重做 |
|------|----------------|----------|----------|
| convert | `.checkpoint.json` → `converted` | 已转换 | `--reconvert` |
| toc_parse | `.toc_checkpoint.json` → `toc_parsed` | 已解析 | `--reconvert` |
| extract | `.checkpoint.json` → `extracted` | 已提取 | `--reconvert` |
| publish | `.publish_checkpoint.json` → `published` | 已发布 | `--reconvert` |

**`--force` vs `--reconvert`**：
- `--force`：跳过 checkpoint 检查，重新处理，但**不删除**已有输出文件
- `--reconvert`：清除 checkpoint **+ 删除已有输出文件**，完全重做

---

## 8. 常见问题

**Q: 为什么 extract 跑得慢？**
A: 每页都要调 LLM 做标注。用 `--pages "1-10"` 分批处理，或加 `--dry-run` 先看范围。

**Q: 目录页没有被提取？**
A: 正确行为——目录页被 LLM 识别为 `front_matter` 跳过。如需章节结构，用 `toc_parse_cli` 单独解析。

**Q: db_loader 报 "lesson_id not found"？**
A: card 的 `lesson_id` 和 DB 中已有的 lesson name 不匹配。先跑 `toc_parse_cli` + `--load-toc` 建骨架，再跑 `--load-cards`。

**Q: 如何只重做某一本教材？**
A: 大部分 CLI 支持 `--book "九年级/下册"` 过滤，配合 `--reconvert` 只重做指定教材。
