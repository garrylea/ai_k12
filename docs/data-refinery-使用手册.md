# K12 数据管线使用手册

> **适用于**：数据工程师、开发者
> **最后更新**：2026-09-12
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
                                          ↘ toc_merge ↗
                                       (card标签合并进TOC)

              pipeline_cli（总控：toc_parse → extract → publish → toc_merge → db_loader）
```

| 步骤 | 工具 | 输入 | 输出 | 核心依赖 |
|------|------|------|------|----------|
| 0 | `crawler` | 网站 URL | PDF / JPG | requests, bs4 |
| 1 | `convert_cli` | PDF / JPG | Markdown (.md) | MinerU CLI |
| 1.5 | `toc_parse_cli` | 目录页 MD | TOC JSON | LLM |
| 2 | `extract_cli` | Markdown (.md) | Cards JSONL | LLM |
| 3 | `publish_cli` | Cards JSONL | Published JSONL + assets | — |
| 3.5 | `toc_merge` | TOC JSON + published JSONL | merged TOC + merge report | — |
| 4 | `db_loader_cli` | Published JSONL | MySQL (cards/questions) | pymysql |
| — | `pipeline_cli` | — | — | 总控 1.5~4（convert 之后一站式） |
| — | `refinery_cli` | — | — | 串联 3+4（旧入口，保留） |

---

## 2. 环境准备

### 2.1 配置文件

所有配置通过 `tools/data-refinery/.env` 设置：

**首跑引导**：无需手写。若 `.env` 缺失，`pipeline_cli` 首次运行时会读取
`apps/server/.env`（deploy.sh 生成，含各 provider 的 BASE_URL/API_KEY 和 DB_*）、
`model-routes.yaml`（模型名）或 `tools/deploy/runtime/deploy.state.json`，
列出已配置的 provider 让你选择一个，自动生成 `.env`（之后再运行不再询问）。
没有这些源文件时会报错提示先运行 `tools/deploy.sh`，或参照
`tools/data-refinery/.env.example` 手动配置。也可以设置环境变量
`REFINERY_PROVIDER=kimi` 跳过交互直接指定。

```bash
# === LLM 配置（extract / toc_parse 共用）===
LLM_PROVIDER=openai                  # openai | kimi | qwen | glm | deepseek | gemini | local | anthropic
LLM_MODEL=deepseek-flash             # 推荐 DeepSeek reasoner
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_AUTH_TOKEN=sk-xxx                # refinery 专属鉴权变量，勿用 ANTHROPIC_* 会被 shell 覆盖
                                     #（fallback 链：LLM_API_KEY -> OPENAI_API_KEY -> ANTHROPIC_API_KEY；
                                     #   token：LLM_AUTH_TOKEN -> ANTHROPIC_AUTH_TOKEN）
LLM_MAX_TOKENS=65536                 # 默认 16384；DeepSeek reasoner 建议 65536
LLM_TIMEOUT=120                      # 秒
LLM_MAX_RETRIES=3                    # LLM 请求失败重试次数（默认 3）
LLM_THINKING=false                   # 开启 thinking 模式（部分 provider 支持）
LLM_ENABLE_CACHE=false               # 开启 provider 侧 prompt 缓存

# === MinerU 配置（convert）===
MINERU_BIN=mineru-open-api           # MinerU CLI 命令（外部依赖，需单独安装）
MINERU_TIMEOUT=300
MINERU_TOKEN=xxx                     # MinerU API token

# === MySQL 配置（db_loader）===
DB_HOST=localhost
DB_PORT=3306
DB_USER=ai_k12
DB_PASS=ai_k12
DB_NAME=ai_k12

# === 路径覆盖（可选）===
REFINERY_INPUT_DIR=tools/crawler/data       # 默认（convert 的素材输入目录）
REFINERY_OUTPUT_DIR=tools/data-refinery/output  # 默认（输出根：md/extracted/toc/published 都在其下）
```

### 2.2 依赖安装

```bash
# Crawler
cd tools/crawler && pip install -r requirements.txt

# Data Refinery
cd tools/data-refinery && pip install -r requirements.txt
```

**MinerU CLI（convert 依赖，需单独安装）**：`convert_cli` 调用 `mineru-open-api`
（MinerU 官方免费 CLI，文档转 Markdown）。安装与鉴权：

```bash
pip install mineru          # 安装（提供 mineru-open-api 命令）
mineru-open-api auth         # 首次使用前登录鉴权（Precision Extraction 需要；
                            #   token 写入 MINERU_TOKEN 或由 CLI 自行管理）
```

本项目用的是 `mineru-open-api extract <files> -o <dir>` 精确提取模式（批量上限见
`convert.py` `_BATCH_SIZE`）。详见 https://mineru.net 。

### 2.3 数据库初始化

```bash
cd tools/db && bash install_mysql.sh
```

---

## 3. 爬虫（Crawler）

**位置**：`tools/crawler/`  
**入口**：`python src/crawler_cli.py --site <zgkao|smartedu> [options]`

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
python src/crawler_cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/89047.html \
  --subject 数学 \
  --year 2024,2025 \
  --district 海淀 \
  --output ./data

# 试运行：查看可下载内容
python src/crawler_cli.py --site zgkao --url https://www.zgkao.com/shitiku/89047.html --dry-run
```

| 参数 | 说明 |
|------|------|
| `--url` | **必填**。zgkao 试卷索引页 URL |
| `--subject` | 学科过滤（如 数学、英语、语文） |
| `--year` | 年份过滤，逗号分隔（如 2024,2025） |
| `--district` | 区县过滤（如 海淀、西城、东城、朝阳） |
| `--grade` | 年级过滤，逗号分隔（zgkao 用 初一/初二/初三/高一/高二/高三） |

**输出结构**：`data/{学科}/初中/{first|second}/{年份}/{试卷名}.pdf`（学期由页面自动识别，判不出时交互询问）

> **迁移提示（破坏性变更，2026-09-12）**：本管线默认输入 `tools/crawler/data`。2026-09-12 前
> 抓取的数据把初三（上）期末错归档到 `second/`、文件名带 `--2025学年-`。修正两步：
>
> ```bash
> cd tools/crawler
> # 1) 先列出来确认，再删（名字里的 `--20xx学年` 是这个 bug 留下的痕迹）
> find data -type f -name '*--20*学年*'
> find data -type f -name '*--20*学年*' -delete
> # 2) 重抓受影响页面。checkpoint 以 PDF URL 为键、与落盘路径无关，
> #    不加 --force 会静默跳过旧 PDF、产出 0 个修正文件
> python src/crawler_cli.py --site zgkao \
>   --url https://www.zgkao.com/shitiku/87761.html --subject 数学 --output ./data --force
> ```
>
> `--force` 只作用于本次运行，比清空 `data/.checkpoint.json` 更精准（后者会让之后每个页面都重下）。
> 也别 `rm -rf data/*/*/second`——`second/` 里还有本来就正确的一模/二模数据。
>
> 目录契约 `{base}/{subject}/{level}/{semester}/{year}/` 不变，仅学期归类更正确；
> `src/toc_parse_cli.py` 同时接受 `first` 与 `second` 作为学期路径段，**下游无需改代码**。

### 3.3 smartedu — 教材下载

从国家中小学智慧教育平台抓取教材预览图。

```bash
# 下载人教版九年级上册数学教材
python src/crawler_cli.py --site smartedu \
  --subject 数学 \
  --level 初中 \
  --grade 九年级 \
  --semester 上册 \
  --publisher 人教版 \
  --output ./data

# 只打印不下载
python src/crawler_cli.py --site smartedu --subject 数学 --level 初中 --dry-run
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

# 只转换指定书目（子串匹配 rel_path，逗号分隔可多条；一条命中多本则全转）
python src/convert_cli.py --source smartedu --materials "（根据2022年版课程标准修订）义务教育教科书·数学九年级上册"

# 批量：列表文件，一行一个子串，# 注释，空行忽略
python src/convert_cli.py --source smartedu --materials-file books.txt

# 按维度精确筛：2025 年 · 下学期 · 全部试卷
python src/convert_cli.py --source zgkao --year 2025 --term 下

# 多值逗号分隔（同参数内取并集）：2026 与 2024 两年
python src/convert_cli.py --source zgkao --year 2026,2024

# 再叠学科/学段；--reconvert 只重转筛出的素材
python src/convert_cli.py --source zgkao --subject 物理 --year 2026 --reconvert
python src/convert_cli.py --source smartedu --stage junior --term 下册

# 重新转换（删除已有输出 + 清 checkpoint）
python src/convert_cli.py --reconvert

# 试运行：查看待处理素材（配合 --materials 可先确认命中哪些书）
python src/convert_cli.py --dry-run
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--input-dir` | path | `tools/crawler/data` | 素材输入目录 |
| `--output-dir` | path | `output`（输出根） | **输出根目录**：MD 落 `{该目录}/md/` 下，不是直接落该目录 |
| `--source` | all / zgkao / smartedu | `all` | 按来源过滤 |
| `--materials` | str | 空 | 只处理 rel_path 包含指定子串的素材，逗号分隔多条，与 `--materials-file` 取并集 |
| `--materials-file` | path | 空 | 素材列表文件，一行一个子串，`#` 开头为注释，空行忽略 |
| `--subject` | str | 空 | 学科过滤，精确匹配目录第 1 段（如 `数学`、`语文`），逗号分隔多个 |
| `--stage` | str | 空 | 学段过滤，第 2 段（`初中`/`小学`/`高中`，或 `junior`/`primary`/`senior`），逗号分隔多个 |
| `--term` | str | 空 | 学期过滤：试卷用 `first`/`second`（可写 `上`/`下`），教材用 `上册`/`下册`，逗号分隔多个 |
| `--year` | str | 空 | 年份过滤（4 位，仅试卷，如 `2025`），逗号分隔多个（如 `2026,2024`） |
| `--force` | flag | 否 | 忽略 checkpoint，处理所有未完成的 |
| `--reconvert` | flag | 否 | 删除已有输出 + 清 checkpoint，全部重转 |
| `--dry-run` | flag | 否 | 只打印不转换 |

**维度过滤（`--subject`/`--stage`/`--term`/`--year`）**：按素材 rel_path 的目录段精确匹配
（试卷 `{学科}/{学段}/{first|second}/{年份}/{试卷名}`，教材 `{学科}/{学段}/{出版社}/{年级}/{上册|下册}/{书名}`），
与 `--materials` 子串过滤**取交集**。每个参数都可用逗号分隔多个值——**同参数内取并集，参数之间取交集**，
如 `--year 2026,2024 --subject 数学,物理` = 这两年的数学和物理试卷。学期中英文互通
（`下` = `second` = `下册`，`上` = `first` = `上册`），学段中英文互通（`初中` = `junior`）。
`--year` 只对试卷有效——教材路径不含年份，带 `--year` 筛教材必为空。
`--reconvert` 只作用于筛出的素材，所以「只重转 2025 年下学期的试卷」= `--year 2025 --term 下 --reconvert`。
几个组合的实测命中（2026-09-12，本仓数据，zgkao 共 123 份）：`--year 2025` → 26、
`--year 2026,2024` → 97（26+97=123 互不重叠）；`--term 上`/`--term 下` → 77/46。

**未命中警告**：`--materials` / `--materials-file` 中命中 0 本的条目会打印 `[WARN] 未命中素材: <条目>`
（判定基于全量扫描结果，因此条目只是被 `--source` 排除时不会误报）；任何过滤条件（含 `--source`）
叠加后一个素材都不剩时打印 `[WARN] 过滤条件未命中任何素材`。列表内已转换的书仍按 checkpoint 跳过，
需重转用 `--reconvert`。

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

**输出**：`output/toc/{学科}/{学段}/{版本}/{年级}/{册次}/{书名}.json`（如 `output/toc/数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册.json`）

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

> 文件名含「试卷」的走独立切题路径（`question_extract`，按题号切分而非按字数）。
> 该路径在切题前会剔除页面里的公众号二维码图片（`qr_detect.strip_qr_images`）：
> 二维码独占一行则删行，与正文同行则只摘掉引用本身。判定规则是
> `cv2.QRCodeDetector` 解码成功 **且** 二维码占图面积 ≥ 0.3——护栏用于避免
> 「真实配图角落里恰好有一个二维码」被整张误删（实测这类图二维码仅占 0.014）。
> 教材卡路径不走这个过滤器（实测 733 张卡片资源里零二维码）。
> 详见 `docs/superpowers/specs/2026-09-12-qr-code-image-filter-design.md`。

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
python src/extract_cli.py --toc output/toc/数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册.json

# LLM 节流：每次 LLM 调用后间隔 2 秒
python src/extract_cli.py --interval 2

# LLM 节流：每 10 页一批，批次间停 60 秒（应对 API 限流）
python src/extract_cli.py --batch-size 10 --batch-sleep 60

# 重新提取指定页（清 checkpoint + 删 JSONL）
python src/extract_cli.py --reconvert --pages "8-20"

# 试运行
python src/extract_cli.py --dry-run
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--input-dir` | path | `output/md` | MD 输入目录 |
| `--output-dir` | path | `output`（输出根） | **输出根目录**：JSONL 落 `{该目录}/extracted/` 下，不是直接落该目录 |
| `--source` | all / zgkao / smartedu | `all` | 来源过滤 |
| `--file` | str | — | 文件名子串匹配 |
| `--pages` | str | — | 页码过滤，如 `1-6` 或 `1,3,5-8` |
| `--book` | str | — | 教材路径子串匹配，如 `九年级/上册` |
| `--force` | flag | 否 | 忽略 checkpoint，不删已有输出 |
| `--reconvert` | flag | 否 | 清 checkpoint + 删已有 JSONL，重新提取 |
| `--toc` | path | — | TOC JSON 路径，启用 lesson_id 校验+修正（单文件模式） |
| `--toc-dir` | path | — | TOC 目录（如 `output/toc`）：按书自动匹配，把合法章节列表注入 LLM prompt（减少标签漂移）+ 逐书后置校验。优先于 `--toc` |
| `--interval` | float | `0` | 每次 LLM 调用后 sleep 秒数（限速节流） |
| `--batch-size` | int | `0` | 每处理 N 页（发生 LLM 调用的页）后进入批次间歇（`0`=不分批） |
| `--batch-sleep` | float | `0` | 批次之间 sleep 秒数（配合 `--batch-size`） |
| `--dry-run` | flag | 否 | 只打印不提取 |

**输出**：`output/extracted/{学科}/…/page_001.jsonl …`  
**TOC 模式额外输出**：`output/extracted/diff_report.json`（`--toc` 单文件模式的差异报告；`--toc-dir` 模式不写此文件，由 toc_merge 的 merge_report 取代）  
**文本归一**：读取每页 MD 后自动把全角括号 `（）` 统一为半角 `()`（OCR 原文同页混用导致题号括号展示不一致；只动括号，`。，；！？` 等其它全角标点保留——详见管线总结 §3 extract 约定）。已抽取的旧 JSONL 不会自动重做，需 `--reconvert` 重抽才吃到归一。

### 4.4 publish_cli — 图片物化与路径改写

读 extracted JSONL，把 MinerU 图片引用物化到 `output/assets/`，改写为规范相对路径。

```bash
# 发布所有
python src/publish_cli.py

# 只发布 smartedu
python src/publish_cli.py --source smartedu

# 只发布某一卷试卷 / 某一本教材（rel_path 子串匹配）
python src/publish_cli.py --book "数学-初三(上)-202507-海淀-（上）期末考-试卷"

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
| `--book` | str | — | 教材/试卷路径子串匹配，如 `数学-初三(上)-202507-海淀-（上）期末考-试卷` |
| `--pages` | str | — | 页码过滤，如 `1-6` 或 `1,3,5-8`（仅 page_*.jsonl，试卷/答案聚合文件不受影响） |
| `--force` | flag | 否 | 忽略 checkpoint |
| `--reconvert` | flag | 否 | 清 checkpoint + 删已有输出 |
| `--dry-run` | flag | 否 | 只打印不发布（**只按 `--source`/`--pages` 过滤，不响应 `--book`**，会列出全部文件） |

**输出**：`output/published/…`（JSONL，图片路径已改写）+ `output/assets/…`（物化图片）

### 4.5 db_loader_cli — MySQL 入库

将 published JSONL 加载进 MySQL。支持四种模式。

**版次（edition）维度**：同一出版社不同课标版次的教材（如人教版 2012 课标 vs「（根据2022年版课程标准修订）」2024 新版九上数学）会入库为**各自独立的 textbook_version**（4 元组 `(subject_id, publisher, grade_band, edition)` 唯一），互不覆盖、骨架不混淆。版次标记从**书名前导括号**自动提取（TOC 文件名/书的 rel_path 均可），无前导括号 = 旧版（edition=''）。九上/九下书名不同但前导括号相同 -> 归同一版次，无需为不同册建不同版次。

#### 模式 A：全量重载（默认，向后兼容）

```bash
# 全部入库（先删后插，幂等）
python src/db_loader_cli.py

# 只入库 smartedu cards
python src/db_loader_cli.py --source smartedu

# 试运行
python src/db_loader_cli.py --dry-run

# 库里有业务数据（错题本/answers/progress 等）时，显式清空后重载（不可恢复！）
python src/db_loader_cli.py --purge-business-data
```

**业务数据守卫（FK 保护）**：`answers`/`main_error_books`/`aux_error_books`/`variation_questions`
等业务表对 `questions` 有 `ON DELETE RESTRICT` 外键，`progress`/`homework_submissions`
会挡住 `textbook_versions` 级联删除。full-reload 会先预检这些表：有数据且未传
`--purge-business-data` 时**报错退出**（防止误删学生数据），提示两条出路：
1. 加 `--purge-business-data` 清空上述业务表后重载（学生侧数据不可恢复）
2. 改用模式 C（`--load-cards`，增量入库，不动业务数据）

#### 模式 B：仅建 TOC 骨架

先跑 `toc_parse_cli` 产出 TOC JSON，再用此模式建章节目录。

```bash
# 只建骨架，不入 card
python src/db_loader_cli.py --load-toc --toc-path output/toc/数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册.json
```

#### 模式 C：仅 card 入库（TOC 模式下）

骨架已由 TOC 建好，此模式只把 card 挂到已有 lesson 下。挂卡前会先做**页码锚定**（2026-09-02，`lesson_anchor.py`）：按卡片 `textbook_page`（md 页码）与 TOC 章区间确定性修正章归属（错章重写/「小结」等同名消歧/「复习题 N」归一到该章「小结」），日志输出 `[anchor] offset/corrected/disambiguated/normalized` 便于观测；无 TOC 或偏移推不出时退化为纯按标签匹配。

```bash
# card 入库，不清表，带 TOC 匹配
python src/db_loader_cli.py --load-cards --toc-path output/toc/数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册.json
```

#### 模式 D：单卷重载（试卷）

只重载某一张试卷的题——新增一张卷、或改卷后重发时用（试卷没有像 TOC 骨架那样的增量入口）。

```bash
# 按文件名 stem 找 output/published/ 下的该卷 jsonl，删旧题后重插
python src/db_loader_cli.py --reload-source "数学-初三(上)-202507-海淀-（上）期末考-试卷"

# 试运行：只打印题数，不入库
python src/db_loader_cli.py --reload-source "数学-初三(上)-202507-海淀-（上）期末考-试卷" --dry-run
```

流程：文件名去扩展名匹配 `published/**/<stem>.jsonl` → `parse_paper_meta` 解析卷元数据并 find-or-create `exam_papers`（source_key = 相对路径去 `.jsonl`）→ 按 `paper_id` 删该卷 `paper_questions` 关联 + 孤立 `questions` → 重插。

- **不 reset 其他表**：不像模式 A 那样 `DELETE questions` 全量，其余卷与教材骨架都不受影响。
- **业务数据保护**：该卷题被 `answers`/错题本/变式题引用时，默认**保留旧题行**（仅清 `paper_questions` 关联后重插，日志会列出被挡住的表与行数，跨卷共享的题也保留）；要连旧题行一起删再加 `--purge-paper-data`（学生数据不可恢复）。
- 元数据解析失败时会打印 `[WARN] 无法解析试卷元数据，跳过删除直接重插`——题照样入库但不归组，此时重复跑会产生重复题。
- **不能替代单卷重载**：模式 C 的 `--load-cards` 会遍历 `published/` 下所有文件逐题入库（`content_hash` 相同的题复用、不会重复插），但改过内容的题会**新插一行、旧行留在库里成脏数据**；单卷更新必须走 `--reload-source`。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--input-dir` | path | `output/published` | published 目录 |
| `--source` | all / zgkao / smartedu | `all` | 来源过滤 |
| `--load-toc` | flag | 否 | TOC 模式：只建骨架不入 card（需 `--toc-path` 或 `--toc-dir`） |
| `--load-cards` | flag | 否 | Card 模式：只入库 card，不 reset（可选 `--toc-path`/`--toc-dir`） |
| `--toc-path` | path | — | TOC JSON 路径（单文件） |
| `--toc-dir` | path | — | TOC 目录（如 `output/toc`）：按书自动匹配 merged TOC（优先 `.merged.json`，fallback 初始 `.json`）；`--load-cards` 时对命中的书先建骨架（幂等）再挂卡。优先于 `--toc-path` |
| `--reload-source` | str | — | 模式 D：只重载该卷（文件名去扩展名）；published 下找不到则报错退出 |
| `--purge-paper-data` | flag | 否 | 配合 `--reload-source`：该卷题被业务表引用时，显式删这些业务记录后重载（**不可恢复**） |
| `--purge-business-data` | flag | 否 | full-reload 前清空引用 cards/questions 的业务数据（answers/错题本/变式题/作业提交/progress，**不可恢复**）；默认遇业务数据报错退出 |
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

# 库里有业务数据时，清空后全量重载（透传给 db_loader_cli，不可恢复！）
python src/refinery_cli.py --purge-business-data
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--source` | all / zgkao / smartedu | `all` | 来源过滤 |
| `--dry-run` | flag | 否 | publish + db_loader 都只打印 |
| `--skip-publish` | flag | 否 | 跳过 publish，直接 db_loader |
| `--skip-load` | flag | 否 | 跳过 db_loader，只 publish |
| `--purge-business-data` | flag | 否 | 透传给 db_loader_cli：full-reload 前清空业务数据（否则遇业务数据报错） |

> 旧入口，保留用于单跑后段。新工作流请用 `pipeline_cli`（§4.7）。

### 4.7 pipeline_cli — 总控管线（推荐入口）

convert 之后的一站式入口：`toc_parse → extract（目录注入）→ publish → toc_merge → db_loader`。

```bash
python src/pipeline_cli.py                          # 无参数：交互式向导（见下）
python src/pipeline_cli.py --source all             # 直接执行全流程（增量入库）
python src/pipeline_cli.py --source smartedu --book "九年级/下册" --pages "8-30"  # 部分提取
python src/pipeline_cli.py --interval 2 --batch-size 10 --batch-sleep 60         # LLM 节流
python src/pipeline_cli.py --purge-business-data   # 全量重载（清学生侧业务数据）
python src/pipeline_cli.py --dry-run                # 试运行
```

**交互式向导**：不带参数运行时逐项询问——

1. **素材来源**：全部 / 仅教材 / 仅试卷
2. **目录提取**：是否跑 toc_parse（试卷来源自动跳过）
3. **卡片范围**：全部 / 部分（列出已转 MD 的书目供选择，教材可再指定页码范围）/ 跳过；
   未跳过时追问**是否强制重做**——选是则忽略已提取记录，重新切割 + LLM 标注 + 重新发布
   （等价 `--reconvert`，仅作用 extract/publish，不动目录）
4. **LLM 模型**：默认用 `.env` 当前配置；列出 deploy 产物（`apps/server/.env` /
   `model-routes.yaml`）中已配置的其他 provider 可选；也可**手动输入自定义模型**
   （provider + 模型名 + Key + Base URL，适合任何未配置的模型，如自建代理）。
   选择**仅本次运行生效，不写入 .env**
5. **入库模式**：增量（默认）/ 全量重载（需二次确认清业务数据）/ 跳过
6. **执行计划**：显示完整计划，`Y` 执行 / `d` 仅试运行（dry-run）/ `n` 取消

带任何参数运行时跳过向导直接执行（兼容脚本化调用）。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--source` | all / zgkao / smartedu | `all` | 来源过滤（zgkao 自动跳过 toc/merge——试卷无目录） |
| `--book` | str | — | 只处理指定书目（rel_path 子串匹配），作用于 toc_parse 和 extract |
| `--pages` | str | — | 只提取指定页码（如 `8-30`），作用于 extract 和 publish |
| `--reconvert` | flag | 否 | 忽略已提取/已发布记录，重新切割 + 标注 + 发布（仅作用 extract/publish；作用域由 `--book`/`--pages` 限定，未限定则全量重做；目录重解析用 `toc_parse_cli --reconvert` 单独跑） |
| `--dry-run` | flag | 否 | 所有步骤只打印 |
| `--purge-business-data` | flag | 否 | 全量重载前清空业务数据（不可恢复）；默认增量入库（`--load-cards` + merged TOC 建骨架） |
| `--skip-toc` | flag | 否 | 跳过 toc_parse |
| `--skip-extract` | flag | 否 | 跳过 extract |
| `--skip-publish` | flag | 否 | 跳过 publish |
| `--skip-load` | flag | 否 | 跳过 toc_merge + db_loader |
| `--interval` / `--batch-size` / `--batch-sleep` | float/int | `0` | extract 节流透传 |

**内置的目录合并（toc_merge）**：extract 阶段 LLM 标注时已注入初始目录的合法章节列表；
card 分析发现的、目录页没有的新小节（如 `26.1.1`）由 `toc_merge` 在入库前合并进
`output/toc/{书名}.merged.json`（不回写初始 `toc.json`），db_loader 用合并版建骨架后挂卡——
新小节会建成自己的 lesson 行（不再是旧 TOC 模式的「折叠进父节/WARN 跳过」）。
合并报告在同名 `.merge_report.json`（含新增小节/补齐章标题/未解析标签），其中
`section_created_from_subsection`（子节补建父节）与 `unresolved` 项建议人工复核。

---

### 4.8 answer_importer — 题目内容回写（答案/解题思路/解析/题型）

把人工或 AI 产出的题目内容回写 `questions` 表：`answer`（答案）、`approach`（解题思路）、`explanation`（详细解析）、`type`（题型）。默认 dry-run 只出 diff 报告，`--apply` 才写入；幂等可重跑。

**输入一：JSONL（推荐，可编程批量）** 每行一条记录：

```jsonl
{"question_id": 12345, "answer": "B", "approach": "先配方求顶点，再取对称轴处最值", "explanation": "完整过程…"}
{"paper_id": 3, "question_no": 17, "approach": "利用相似三角形转化", "type": "calculation"}
{"content_hash": "ab12…（64 位十六进制）", "explanation": "……"}
```

- 定位键三选一：`question_id` ｜ `paper_id` + `question_no` ｜ `content_hash`。
- 内容字段至少一个：`answer` / `approach` / `explanation` / `type`；`note` 可选（只回显报告）。
- `null`/空串=不改（不提供「清空字段」）。

**输入二：Markdown 按卷文档**

```markdown
# 试卷：2024 海淀 初三 模拟二

## 1
答案：B
思路：由顶点式 $y=(x-2)^2+3$ 知顶点为 $(2,3)$，开口向上故在对称轴处取最小值。
解析：完整分步过程……

## 17
答案：解：设……所以 $x=2$。
题型：calculation
```

每题必写「答案」；「思路」「解析」「题型」可选；多行内容直接换行续写，空行保留；围栏 ``` 代码块（如内嵌 SVG）原样保留；公式用 `$...$`。

**常用命令**：

```bash
python src/answer_importer_cli.py --records edits.jsonl                 # dry-run：diff 报告，不写库
python src/answer_importer_cli.py --records edits.jsonl --apply         # 确认后写入（输 yes）
python src/answer_importer_cli.py --doc 答案.md --paper-id 3
python src/answer_importer_cli.py --export --where answer_empty --out to_fill.jsonl
python src/answer_importer_cli.py --list-papers 海淀                    # 标题重名时列候选
```

**选择器 `--where`（只圈范围，不承载内容）**：`--question-id 1,2,10-20`、`--paper-id` / `--paper-title`（+`--question-no`）、`--where answer_empty,approach_empty,explanation_empty`、`--source`（LIKE）/`--type`/`--difficulty`/`--content-hash`。

**导出待补模板 → 填写 → 回导**（批量补缺口的两步法）：

```bash
python src/answer_importer_cli.py --export --where answer_empty --out to_fill.jsonl
# 填写 to_fill.jsonl 顶层的 answer/approach/explanation（_ref 是只读参考，不要改）
python src/answer_importer_cli.py --records to_fill.jsonl --where answer_empty --apply
```

导入时 `--where` 会校验每条记录的目标题仍满足条件，不满足的跳过并报告。

**回写语义**：`answer`/`approach`/`explanation` 提供了非空值即覆盖；`type` 仅在标注且与原值不同时改；任一字段实际写入 → `answer_verified=1`（人工/AI 核验标记）；无变化的记录不发 UPDATE（幂等）。

**安全须知**：默认 dry-run；`--apply` 需交互输 `yes`；`--limit` 默认 500——**导入**时超过即拒绝，**导出**时取前 N 条（达到上限会打印截断警告，需调大后重导）；**全量导入前先做快照**——`mysqldump -u ai_k12 -pai_k12 ai_k12 questions > questions_snapshot.sql`；首次请先小批（2-3 题）验证匹配无误再放量。另注：`db_loader` 的 full-reload 会把 `answer_verified=1` 计入守卫，未被 purge 时中止，不会静默覆盖已核验内容。

### 4.9 dictation_cli — 语文古诗文默写采集入库（旁路管线）

> **这条旁路只服务「训练 → 语文 → 专项 → 古诗文默写」**，产物进 `chinese_passages`
> （2026-09-15 独立化改造已实施：由 `dictation_passages` 改名而来、摘除 `question_id`），
> **既不接进 4.1–4.5 的四阶段主线，也不写 `questions` 表**（避免动到 cards/questions 的既有语义）。
> 前 3 步（爬 / 转 / 目录）复用 §3.3、§4.1、§4.2；后 3 步是本 CLI 新建。
> 设计与实测结论见 `docs/superpowers/specs/2026-09-13-chinese-dictation-content-pipeline-design.md`。

**先看清分工**（决定了哪些步骤要人工介入）：

| 环节 | 谁做 |
|---|---|
| 哪些篇目、在第几页 | **程序**（目录 + 印刷页偏移，自动算） |
| 正文起止 | **程序**（版面规则：标题行 → 跳过编者导语/作者/题解/图片 → 终止符） |
| 尾部编者赏析 / 词前小序 | **程序**（按格律/版面切） |
| 作者 | **程序**（取目录 label 里的「/作者」——教材权威源） |
| 朝代 / 体裁 | **LLM**（目录没有；会把作者钉住再问） |
| 正文纠正 | **LLM**（本地模型优先、`LLM_FALLBACK_*` 兜底） |
| 通过与否 | **程序**（纯程序自检，含词牌格律） |

#### 采集一本新书（6 步）

以 **七年级上册** 为例（七/八年级、上下册完全同理，只换参数）：

```bash
# ── 第 1 步：爬教材（自动）────────────────────────────────
cd tools/crawler
python src/crawler_cli.py --site smartedu --subject 语文 --publisher 统编版 \
       --level 初中 --grade 七年级 --semester 上册
# 先加 --dry-run 确认命中（七上实测 166 页、八上 174 页）

# ── 第 2 步：转 Markdown（自动，调 MinerU）──────────────────
cd tools/data-refinery
python src/convert_cli.py --source smartedu --subject 语文 --term 上册 \
       --materials "七年级/上册"
# ★ --materials 是关键：不加会把所有年级所有册都转一遍

# ── 第 3 步：解析目录（自动，LLM）──────────────────────────
python src/toc_parse_cli.py --source smartedu --subject 语文 --publisher 统编版 \
       --book "七年级/上册"

# ── 第 4 步：建候选清单（★ 目前需人工，见下）────────────────

# ── 第 5 步：抽取（自动）──────────────────────────────────
python src/dictation_cli.py --extract --book "七年级/上册" --term 上册

# ── 第 6 步：入库（自动，幂等）────────────────────────────
python src/dictation_cli.py --load --book "七年级/上册" --term 上册
# 或两步合一：--all
```

#### 第 4 步：候选清单 `candidates.json`（目前人工）

程序读这份清单才知道「要收哪些篇目、各在第几页」。路径（可 `--candidates` 覆盖）：

```
output/dictation/语文/<册次>/candidates.json
```

内容从**教材目录页**（MD 里的 `page_004`~`page_007` 左右）逐条抄出来：

```json
[
  {"label": "9 鱼我所欲也/《孟子》",        "printed_page": 48, "unit_label": "第三单元", "unit_index": 3},
  {"label": "定风波(莫听穿林打叶声)/苏轼",   "printed_page": 69, "unit_label": "第三单元", "unit_index": 3},
  {"label": "20 曹刿论战 /《左传》",         "printed_page": 124, "unit_label": "第六单元", "unit_index": 6}
]
```

三个字段的三个要点：

1. **`label` 写「篇名/作者」**——那一半作者很重要，程序拿它当**权威作者**（LLM 在 48 篇里答错过 4 篇作者，故不采信模型）。
2. **`printed_page` 是书上印的页码**，不是 MD 页号——程序自己算「MD 页 − 印刷页」的偏移众数（九上/九下实测都是 +7）。
3. **只收古诗文**（现代文/现代诗单元不收）；`词四首`、`诗词曲五首`、`课外古诗词诵读` 这类**组合标题要展开成一首一条**，页码都填**所属组的页码**。

#### 产物三份（`output/dictation/语文/<册次>/`）

| 文件 | 用途 |
|---|---|
| `<书名>.jsonl` | 入库候选（`--load` 读它） |
| `<书名>-review.md` | **人工过目清单**：需复核篇目 / 定位留痕 / **已由模型纠正的篇目（原文与纠正稿并列）** |
| `<书名>-unresolved.md` | 待人工处理（切不出来、自检不过且纠正未成） |

> **过目可以发生在入库之前**：`--load` **只读 JSONL、不重跑抽取**。不认可的篇目直接从
> JSONL 删掉再入库即可。

#### 入库后怎么验

```bash
cd apps/server && mysql -u ai_k12 -p ai_k12 -e "
-- 各册篇目数与必背数
SELECT semester, COUNT(*) AS 篇目, SUM(memorize_required) AS 必背 FROM chinese_passages GROUP BY semester WITH ROLLUP;
-- 抽题池（应只有标了必背的）
SELECT work_title, semester FROM chinese_passages WHERE verified=1 AND memorize_required=1;
-- 业务键重复检查（(篇名, 册次) 唯一，应为 0 行）
SELECT work_title, semester, COUNT(*) c FROM chinese_passages GROUP BY work_title, semester HAVING c > 1;"
```

#### 三个必须知道的行为

- **幂等**：`--extract` 覆盖产物、不追加；`--load` 按 `(篇名, 册次)` 这个业务键 **原地更新同一行**（不用 `content_hash` 去重——题面一改 hash 就变、会插重复行；该表也因此**不需要 `question_id`**）。重跑**不会**把已标的 `memorize_required` 刷回 0。
- **两道闸门**：抽题池 = `verified=1`（内容已校验）**且** `memorize_required=1`（教学上要求背诵）。**新采集的篇目 `memorize_required=0`，所以默认抽不到**——要能练必须另外标必背。
- **两册重复**：九上/九下有两册各印一次的篇目（业务键含 `semester` 故各存一行）。抽题在**不筛册次**时按篇名去重，筛了册次则不去重（去重子查询跨册取 `MIN(id)`，筛册时会把该册行整体排除）。

#### 换新书时可能要改的两处代码

实测九下**零改动**即泛化（24/24），但低年级仍可能撞到这两种：

1. **`CI_PATTERNS`（词牌字数表）** 在 `src/dictation_locate.py`。出现新词牌可补。**不补也能跑**——会退化成「丢掉尾部 ≥60 字的长白话行」，只是**词前小序切不掉**（没有定数就没有判据）。
2. **`_GUIDE_HEADINGS`（编者导语标题）** 现为 `预习` / `阅读提示`。低年级若用别的栏目名（如「预习提示」）要补进去，否则那段编者导语会被当正文收进来。

> 跑完 `--extract` 后看 `-unresolved.md` 与 `-review.md` **就知道要不要改**：程序是
> fail-closed 的，切不出来会明确报出来，不会静默塞错的进库。

## 5. 推荐工作流

### 5.1 一站式（pipeline_cli，推荐）

convert 之后只需一条命令，教材/试卷自动分流，各阶段断点续跑：

```bash
cd tools/data-refinery

# Step 1: 爬取素材（ crawler，见 §3）
# Step 2: 转 MD
python src/convert_cli.py --source smartedu

# Step 3: 其余全部（目录→卡片→发布→合并→入库）
python src/pipeline_cli.py --source smartedu

# 追加新页/新书后重跑同一条命令：checkpoint 自动跳过已完成部分
python src/pipeline_cli.py --source smartedu
```

首跑时 `.env` 未配置会自动进入配置引导（从 deploy.sh 产物选择 provider，见 §2.1）。
入库默认增量（不清业务数据）；需要重建全库时显式加 `--purge-business-data`。

### 5.2 分步执行（调试或精细控制）

```bash
# 目录（仅教材）
python src/toc_parse_cli.py --grade 九下

# 卡片（--toc-dir 注入目录约束 + 后置校验）
python src/extract_cli.py --source smartedu --toc-dir output/toc

# 后段（发布 + 入库，merged TOC 建骨架 + 挂卡）
python src/db_loader_cli.py --load-cards --source smartedu --toc-dir output/toc
```

### 5.3 试卷入库

```bash
# 爬虫
cd tools/crawler
python src/crawler_cli.py --site zgkao --url https://www.zgkao.com/shitiku/89047.html --year 2024,2025

# 转换 → 一站式（zgkao 自动跳过 toc/merge）
cd ../data-refinery
python src/convert_cli.py --source zgkao
python src/pipeline_cli.py --source zgkao
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

# 重做后再跑总控（merge 是确定性重算，自动覆盖 merged sidecar）
python src/pipeline_cli.py --source all
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
│       └── diff_report.json     # --toc 单文件模式产出（--toc-dir 模式不写）
├── toc/                         # toc_parse 产物
│   └── 数学/初中/人教版/九年级/下册/
│       ├── 义务教育教科书·数学九年级下册.json            # 初始 TOC（toc_parse 产物）
│       ├── 义务教育教科书·数学九年级下册.merged.json      # toc_merge 合并版（入库用）
│       └── 义务教育教科书·数学九年级下册.merge_report.json  # 合并报告
├── published/                   # publish 产物
│   └── 数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册/
│       └── page_008.jsonl ~ page_049.jsonl
├── dictation/                   # dictation_cli 产物（语文默写旁路，见 §4.9）
│   └── 语文/上册/
│       ├── candidates.json                    # 候选清单（目前需人工建，见 §4.9）
│       ├── <书名>.jsonl                        # 入库候选
│       ├── <书名>-review.md                    # 人工过目清单 + 定位留痕 + 已纠正篇目
│       └── <书名>-unresolved.md                # 待人工处理
├── assets/                      # 物化图片
│   ├── textbooks/{subject}/{hash}/{sort_order}/
│   └── questions/{subject}/{hash}/{idx}/
├── .checkpoint.json             # convert + extract checkpoint
├── .publish_checkpoint.json     # publish checkpoint
└── .toc_checkpoint.json         # toc_parse checkpoint
```

### 6.1 图片的访问方式（无需单独起静态服务）

`output/assets/` 里的物化图片由 **apps/server 直接托管**（`apps/server/src/main.ts`
的 `useStaticAssets`：`/assets/*` -> `tools/data-refinery/output/assets/*`）：

- 开发期：web 的 Vite dev server 已把 `/assets` 代理到 server（`apps/web/vite.config.ts`），
  前端统一用相对路径 `/assets/...` 取图，不跨域；
- 生产：server 一个进程同时提供 API + 图片，不需要额外的静态服务或 CDN；
- 需要切 CDN/OSS 时，设前端的 `VITE_ASSET_BASE_URL` 环境变量即可，无需改代码。

> 旧的「`python3 -m http.server 3000` + `ASSET_BASE_URL`」开发期方案已废弃。

---

## 7. Checkpoint 机制

每一步都有 checkpoint 文件，记录已处理项。默认增量模式——只处理未完成的新文件。

| 步骤 | Checkpoint 文件 | 跳过条件 | 强制重做 |
|------|----------------|----------|----------|
| convert | `.checkpoint.json` → `converted` | 已转换 | `--reconvert` |
| toc_parse | `.toc_checkpoint.json` → `toc_parsed` | 已解析 | `--reconvert` |
| extract | `.checkpoint.json` → `extracted` | 已提取 | `--reconvert` |
| publish | `.publish_checkpoint.json` → `published` | 已发布 | `--reconvert` |
| toc_merge | —（无 checkpoint） | — | 不需要：确定性纯函数，每次全量重算（毫秒级） |

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

**Q: 如何只转换/重转某一年、某一学期的试卷？**
A: 用 `convert_cli` 的维度参数：`--year 2025 --term 下 --source zgkao`
（`--subject 物理`、`--stage 初中` 可再叠加）。学期中英文互通，`下` = `second` = 下册。
多个年份/学科用逗号分隔：`--year 2026,2024 --subject 数学,物理`（同参数取并集）。
只想重转这部分就加 `--reconvert`（只作用于筛出的素材），例如
`python src/convert_cli.py --source zgkao --year 2025 --term 下 --reconvert`。
不确定命中哪些先加 `--dry-run`。注意 `--year` 只对试卷有效（教材路径没有年份维度）。

**Q: db_loader 报「检测到业务数据引用，full-reload 会被外键挡住」？**
A: 库里有学生侧业务数据（错题本/answers/progress 等对 questions/cards 的 FK 引用），
full-reload 的 DELETE 被外键挡住。两种选择：① 确认可丢弃后加 `--purge-business-data`
清空这些业务表再重载；② 改用 `--load-cards` 增量入库（不 reset，不动业务数据）。

**Q: db_loader 报 MySQL ERROR 1451 (FK constraint)？**
A: 通常是业务表手动造过数据或守卫未覆盖的新外键。先排查引用 questions/cards 的表
（`information_schema.KEY_COLUMN_USAGE`），清空引用行或改用 `--load-cards`。

**Q: extract_cli 报 "TOC file not found"？**
A: `--toc` / `--toc-path` 传的路径不对。TOC 实际输出路径是
`output/toc/{学科}/{学段}/{版本}/{年级}/{册次}/{书名}.json`（注意有学段、册次两层目录，
文件名无 `_toc` 后缀），先用 `find output/toc -name "*.json"` 确认实际文件名。
更省事的方式：用 `--toc-dir output/toc` 按书自动匹配，不用拼路径。

**Q: merge_report.json 里的 unresolved / section_created_from_subsection 是什么？**
A: `unresolved` 是无法解析出编号的卡片标签（如非编号孤立标题），不参与合并，靠
lesson 继承兜底；`section_created_from_subsection` 是目录页连 N.M 级节都没列、
由子节标签反推补建的父节（标题用子节标题兜底），建议人工核对。

**Q: pipeline_cli 首跑时卡在「数据管线 LLM 配置」选择？**
A: 这是 `.env` 缺失时的配置引导（见 §2.1）：从 deploy.sh 已配置的 provider 中
选一个即可；也可以预先 `export REFINERY_PROVIDER=kimi` 跳过交互。

**Q: 在向导里选了页码范围，为什么 extract 还是全部 [skip]、没调 LLM？**
A: checkpoint 增量语义（§7）：已提取过的页自动跳过以省 LLM 成本，`[skip]` 日志
正是这个含义。要**重新生成**这些页：向导里对「强制重做已提取的页?」选 `y`
（等价命令行加 `--reconvert`），会清掉对应页的提取/发布记录，重新切割 → 标注 →
发布；入库按书替换，自动覆盖旧卡。
