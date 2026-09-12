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
│   ├── markdown_scanner.py   # Markdown 扫描器（含 kind 判定：试卷/答案 -> questions）
│   ├── image_scan.py         # 页面图片扫描（尺寸 + 折算字数，小图标舍弃）
│   ├── page_chrome.py        # 运行页眉/页脚/水印剥离（书级频率统计）
│   ├── qr_detect.py          # 二维码图剔除（切题前，避免误挂到选项上）
│   ├── card_splitter.py      # 卡片拆分（内容不动，按标题/长度/图片切块）
│   ├── card_labeler.py       # LLM 卡片标注（page_type/card_type/lesson_id/title）
│   ├── question_splitter.py  # 试卷切题（按题号切分 + 答案对齐 + 选项拆分）
│   ├── question_labeler.py   # LLM 试卷题标注（type/difficulty/KP + 完整性检测/修复）
│   ├── question_extract.py   # 试卷切题编排（切分 -> 标注 -> 写 ExamQuestion JSONL）
│   ├── answer_merger.py      # 试卷/答案两份 MD 的合并或择一（含配对规则）
│   ├── paper_meta.py         # 从相对路径解析试卷元数据（subject/grade/年份/考区）
│   ├── extract.py            # 共用 JSON 解析/修复工具（供各 labeler / KP 脚本复用）
│   ├── extract_cli.py        # extract 子命令（cards / questions 自动分流）
│   ├── toc_parse_cli.py      # 目录页 -> TOC JSON 子命令
│   ├── toc_merge.py           # card 标签合并进 TOC（产出 .merged.json sidecar）
│   ├── env_bootstrap.py       # 首跑配置引导（从 deploy.sh 产物生成 .env）
│   ├── image_rewrite.py      # 图片引用物化 + 路径改写
│   ├── asset_store.py       # 资产存储
│   ├── publish_cli.py        # publish 子命令
│   ├── lesson_anchor.py      # 页码锚定：按 md 页码确定性修正章归属（挂卡时）
│   ├── db_loader.py          # MySQL 入库（find-or-create 结构 + full-reload + 单卷重载）
│   ├── db_loader_cli.py      # db_loader 子命令
│   ├── answer_importer.py    # 题目内容回写核心（answer/approach/explanation/type）
│   ├── answer_importer_cli.py # answer_importer 子命令（--export / --records / --doc）
│   ├── answer_doc.py         # Markdown 按卷答案文档解析（纯函数层）
│   ├── answer_records.py     # JSONL 记录的解析/校验与 export 序列化（纯函数层）
│   ├── refinery_cli.py       # 串联 publish + db_loader（旧入口，保留）
│   ├── pipeline_cli.py       # 总控：toc_parse→extract→publish→toc_merge→db_loader
│   ├── pipeline_wizard.py     # pipeline_cli 无参运行时的交互式向导
│   ├── llm.py                # LLM 客户端（多 provider 工厂）
│   ├── models.py             # Pydantic 数据模型
│   ├── generate_kp_tree.py   # 知识点树生成（LLM -> 校验 -> 种子 SQL）
│   ├── prompts/              # Prompt 模板
│   │   ├── textbook_cards.txt
│   │   ├── question_labeler.txt
│   │   ├── question_kps.txt
│   │   ├── kp_tree.txt
│   │   ├── toc_parse.txt
│   │   └── exam_questions.txt
│   ├── backfill_practice_questions.py  # 一次性：回填练习题（历史数据）
│   ├── backfill_question_kps.py        # 一次性：回填题目知识点（历史数据）
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

> **或者跳过手写**：先跑过 `tools/deploy.sh`（生成了 `apps/server/.env`）的话，
> 直接运行 `pipeline_cli`，首跑会列出已配置的 provider 让你选一个并自动生成 `.env`。

## 使用

### 0. pipeline：一站式总控（推荐）

```bash
python src/pipeline_cli.py                          # 无参数：交互式向导
python src/convert_cli.py --source smartedu   # ① 素材 → MD（仍单独跑）
python src/pipeline_cli.py --source all       # ② 其余全部：目录→卡片→发布→合并→入库
python src/pipeline_cli.py --source all --dry-run
python src/pipeline_cli.py --book "九年级/下册" --pages "8-30"    # 部分提取
python src/pipeline_cli.py --book "九年级/下册" --pages "8-30" --reconvert   # 重新生成这些页
python src/pipeline_cli.py --interval 2 --batch-size 10 --batch-sleep 60   # LLM 节流
python src/pipeline_cli.py --purge-business-data   # 全量重载（清业务数据，不可恢复）
```

**无参数运行进入交互式向导**：逐项选择素材来源 → 是否提取目录 → 卡片范围
（全部 / 选书目 + 页码，可强制重做已提取的页 = `--reconvert`）→ LLM 模型
（当前配置 / deploy 已配置的其他 provider / 手动输入自定义模型，仅本次运行生效）→
入库模式（增量 / 全量重载需二次确认 / 跳过）→ 显示执行计划确认（Y 执行 / d 试运行 /
n 取消）。带参数运行时跳过向导直接执行。

教材/试卷自动分流（试卷跳过目录提取与合并）；各阶段沿用原有 checkpoint，
重复执行只处理新增/未完成部分；入库默认增量（`--load-cards` + merged TOC 建骨架）。
card 分析发现的新小节由 `toc_merge` 在入库前合并进
`output/toc/{书名}.merged.json`（不回写初始 toc.json），新小节会建成自己的 lesson 行。

### 1. convert：素材 → Markdown

```bash
python src/convert_cli.py --source zgkao --dry-run
python src/convert_cli.py --source smartedu
```

按维度筛（精确过滤，与 `--materials` 子串取交集）：

```bash
python src/convert_cli.py --source zgkao --year 2025 --term 下      # 2025 年下学期全部试卷
python src/convert_cli.py --source zgkao --subject 物理,数学 --year 2026,2024   # 多值逗号分隔
python src/convert_cli.py --source smartedu --stage junior --term 下册
python src/convert_cli.py --source smartedu --materials "数学九年级上册"
```

`--subject` / `--stage` / `--term` / `--year` 对应素材路径 `{学科}/{学段}/{学期}/{年份}/…`（试卷）与
`{学科}/{学段}/{出版社}/{年级}/{学期}/{书名}`（教材）；每个参数都可用逗号分隔多个值（同参数内取并集，
参数之间取交集，与 `--materials` 也取交集）。学期中英文互通（`下` = `second` = 下册，
`上` = `first` = 上册），`--year` 仅试卷有。按范围重转加 `--reconvert`（只作用于筛出的素材）。
完整参数表见 [使用手册 §4.1](../../docs/data-refinery-使用手册.md)。

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

# 只发布某一卷试卷 / 某一本教材（rel_path 子串匹配）
python src/publish_cli.py --book "数学-初三(上)-202507-海淀-（上）期末考-试卷"
```

> `--dry-run` 只按 `--source`/`--pages` 过滤，**不响应 `--book`**（会列出全部文件），不能用它验证单卷命中。

读 `output/extracted/` 的 `<stem>.jsonl`，把 `content`/`options`/`explanation` 里的原始图片引用 `![](images/xxx.jpg)` 按 §9 规范名（`stem_NN`、`opt_{label}`、`explain_NN`、`page_{N}_fig_{NN}`）物化到 `output/assets/`，改写为规范相对路径，并填充 `content_metadata.images[]` / `options[].image_url`。产物写到 `output/published/`（与 extracted 同构的 `<stem>.jsonl`）。

> 资源路径用源相对稳定键（`questions/{subject}/{hash}/{idx}`、`textbooks/{subject}/{hash}/{sort_order}`）。subject 按文件路径首段推导（2026-08-26 前曾硬编码 `math` 误标化学，已修）。

#### 图片静态服务（由 apps/server 提供，无需单独起服务）

`output/assets/` 的图片由 **apps/server 直接托管**（`src/main.ts` 的
`app.useStaticAssets`：`/assets/*` -> `tools/data-refinery/output/assets/*`）：

- 开发期：web 的 Vite dev server 已把 `/assets` 代理到 server（`vite.config.ts`），前端按相对路径 `/assets/...` 取图即可；
- 生产：server 与静态图同进程，无需额外静态服务或 CDN；
- 前端构建产物用 `/static/` 前缀（`build.assetsDir`），避免与 `/assets` 代理冲突。

> 旧的「python -m http.server 3000 + ASSET_BASE_URL」方案已废弃（曾作为开发期临时方案）。

### 4. db_loader：published JSONL -> MySQL

四种模式：

```bash
python src/db_loader_cli.py --source all --dry-run   # 模式 A 试运行
python src/db_loader_cli.py --source all              # 模式 A：全量重载（默认）
python src/db_loader_cli.py --load-toc --toc-path output/toc/数学/初中/人教版/九年级/下册/书名.json   # 模式 B：只建 TOC 骨架
python src/db_loader_cli.py --load-cards --toc-path output/toc/....json                            # 模式 C：只入库不 reset
python src/db_loader_cli.py --reload-source "数学-初三(上)-202507-海淀-（上）期末考-试卷"           # 模式 D：单卷重载（试卷）
```

读 `output/published/<stem>.jsonl`，按 kind 入库：

- **cards**（教材）：按书目录分组、按页顺序收集，`sort_order` 跨页全局重排（保证 `uniq_cards_lesson_sort` 不碰撞）；解析 `rel_path`（`学科/学段/版本/年级/学期/书名`）派生 `textbook_versions`+`semesters`；解析 `lesson_id` 标签（`第N章 X` 章综述、`N.M[.K] X` 节）派生 `units`+`lessons`；`lesson_id` 标签映射到 `lessons.id` 后 INSERT cards。
- **questions**（试卷）：`subject_id` 别名归一（`chem`->`chemistry`）-> `subjects.id`，INSERT questions。

幂等：full-reload。每次跑先 `DELETE textbook_versions`（级联清 cards/lessons/units/semesters）+ `DELETE questions`，再重插；结构 find-or-create。`--source smartedu` 只清 cards 侧，`zgkao` 只清 questions。`--dry-run` 只列文件不入库。

**业务数据守卫（FK 保护）**：`answers`/错题本/`variation_questions`/`progress` 等业务表对 questions/cards/textbook_versions 有 `ON DELETE RESTRICT` 外键。full-reload 前会预检这些表：有数据且未传 `--purge-business-data` 时**报错退出**（防止误删学生数据）。两条出路：① 加 `--purge-business-data` 显式清空业务表后重载（不可恢复）；② 改用模式 C（`--load-cards`，增量入库，不动业务数据）。

**模式 D：单卷重载（试卷）**——新增一张卷、或改卷后重发，用 `--reload-source <文件名去扩展名>`。按文件名 stem 在 `output/published/` 找到该卷 jsonl，据 `parse_paper_meta` 建/找 `exam_papers`（source_key = 相对路径去 `.jsonl`），删该卷旧题 + `paper_questions` 关联后重插；**不 reset 其他表、不碰其余卷、不动业务数据**。该卷题被 answers/错题本/变式题引用时默认保留旧题行（仅清关联后重插，跨卷共享题也保留）；要连旧题行一起删才加 `--purge-paper-data`（学生数据不可恢复）。试卷要单卷更新只能用这条——模式 C 的 `--load-cards` 会遍历 `published/` 下所有文件逐题入库（`content_hash` 相同的题复用、不会重复插），但改过内容的题会新插一行、旧行留在库里变脏数据。

> DB 初始化（含 `subjects` seed）由 `tools/db/install_mysql.sh` 完成；连接配置见下表 `DB_*`。

### 5. refinery：一键串联 publish + db_loader（旧入口，保留）

```bash
python src/refinery_cli.py --source all            # publish + db_loader
python src/refinery_cli.py --source all --dry-run  # 两步都只打印
python src/refinery_cli.py --skip-publish          # 只 db_loader
python src/refinery_cli.py --skip-load             # 只 publish
python src/refinery_cli.py --purge-business-data   # 库里有业务数据时显式清空后全量重载
```

把后段（extracted -> published -> MySQL）串起来一键跑。新工作流请用 `pipeline_cli`（总控，含目录注入与 toc_merge）。

> 完整参数表与推荐工作流见 [使用手册](../../docs/data-refinery-使用手册.md)。

### 6. answer_importer：题目内容回写（答案/解题思路/解析/题型）

把人工或 AI 产出的题目内容回写 `questions` 表：`answer`（答案）、`approach`（解题思路）、`explanation`（详细解析）、`type`（题型）。**默认 dry-run 只出 diff 报告，`--apply` 才写库**；幂等可重跑。与题目的切题/入库无关，是对已入库题的内容做人工/AI 补全。

```bash
python src/answer_importer_cli.py --records edits.jsonl                 # dry-run：diff 报告，不写库
python src/answer_importer_cli.py --records edits.jsonl --apply         # 确认后写入（需输 yes）
python src/answer_importer_cli.py --doc 答案.md --paper-id 3            # Markdown 按卷回写
python src/answer_importer_cli.py --export --where answer_empty --out to_fill.jsonl   # 导出待补模板
python src/answer_importer_cli.py --list-papers 海淀                    # 标题重名时列候选
```

**输入一：JSONL（可编程批量）** 每行一条记录，定位键三选一（`question_id` / `paper_id`+`question_no` / `content_hash`），内容字段至少一个：

```jsonl
{"question_id": 12345, "answer": "B", "approach": "先配方求顶点，再取对称轴处最值"}
{"paper_id": 3, "question_no": 17, "type": "calculation"}
```

**输入二：Markdown 按卷文档**——`# 试卷：<标题>` 起头，每题 `## <题号>`，内含「答案」（必写）以及「思路」「解析」「题型」（可选）；多行内容换行续写，围栏代码块（如内嵌 SVG）原样保留。

**补缺口两步法**：`--export --where answer_empty` 导出模板 → 填写 → `--records to_fill.jsonl --where answer_empty --apply`。导入时 `--where` 会校验每条记录的目标题仍满足条件，不满足的跳过并报告。

**回写语义**：`answer`/`approach`/`explanation` 给了非空值即覆盖；`type` 仅在与原值不同时改；任一字段实际写入 → `answer_verified=1`（人工/AI 核验标记）；无变化的记录不发 UPDATE。

> **安全须知**：`--apply` 需交互输 `yes`；`--limit` 默认 500（导入超限直接拒绝，导出取前 N 条并打印截断警告）；**全量导入前先做快照** `mysqldump -u ai_k12 -pai_k12 ai_k12 questions > questions_snapshot.sql`，首次先小批（2-3 题）验证匹配无误再放量。已核验内容（`answer_verified=1`）会计入 `db_loader` 的 full-reload 守卫，未 purge 时中止而非静默覆盖。
>
> 完整参数表、选择器 `--where` 全量取值、锚文档格式见 [使用手册 §4.8](../../docs/data-refinery-使用手册.md)；设计见 `docs/superpowers/specs/2026-09-10-question-content-importer-design.md`。

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
