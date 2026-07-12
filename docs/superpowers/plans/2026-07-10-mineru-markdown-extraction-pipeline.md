# MinerU Markdown 转换与 LLM 题目/卡片提取 Pipeline 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `tools/data-refinery/` 中实现两个离线 CLI 程序：① 递归扫描爬虫下载的 PDF/教材图片，调用 `mineru-open-api` 转换为 Markdown；② 递归扫描 Markdown，调用 LLM 提取试卷题目或教材卡片，输出结构化 JSON。

**Architecture:** 两个独立 CLI 子命令组成顺序 pipeline。`convert` 负责文件发现 + mineru 调用，原样保留 mineru 生成的 `*.md` + `images/` + 中间文件；`extract` 负责读取 Markdown、调用 LLM、按 md 文件输出 `<stem>.jsonl`（每份 md 一个，避免多页教材输出互相覆盖）。两者都通过递归文件系统扫描工作，不依赖 `meta.json`，输出写入与 `tools/crawler/data/` 隔离的 `tools/data-refinery/output/` 目录。

**Tech Stack:** Python 3.10+, `mineru-open-api` CLI, `openai` Python SDK, `pydantic`, `pytest`.

---

## 0. 背景与约束

- 命令名称是 `mineru-open-api`（不是 `minieru-open-api`），已安装于 `/usr/local/bin/mineru-open-api`。
- `mineru-open-api extract` 需要 API token；`flash-extract` 不需要 token 但仅输出 Markdown 到 stdout。本计划使用 `extract`，复用用户本地已配置的 token。
- `mineru-open-api extract <file> -o <dir> -f md` 会生成：
  - `<name>.md`
  - `images/` 目录（解析出的图片）
  - 若干中间文件：`<name>_content_list.json`、`<name>_layout.pdf`、`<name>_middle.json`、`<name>_model.json`、`<name>_origin.pdf`
- 输入支持 PDF 与图片（png/jpg 等），因此 smartedu 教材的 `page_*.jpg` 序列可直接作为 mineru 输入。
- 爬虫原始数据目录：`tools/crawler/data/`。
- 输出目录：`tools/data-refinery/output/`，与 `data/` 完全隔离。

---

## 1. 目录与文件结构

### 1.1 输出目录布局

```
tools/
├── crawler/
│   └── data/                              # 只读：爬虫原始数据
│       ├── 数学/初中/second/2024/数学-初三(下)-202407-东城-模拟二-试卷.pdf
│       └── 数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册/page_001.jpg ...
│
└── data-refinery/                         # 本模块
    ├── output/                            # 全新独立输出目录
    │   ├── md/                            # mineru 转换结果
    │   │   ├── 数学/初中/second/2024/数学-初三(下)-202407-东城-模拟二-试卷/
    │   │   │   ├── 数学-初三(下)-202407-东城-模拟二-试卷.md
    │   │   │   ├── images/
    │   │   │   ├── 数学-初三(下)-202407-东城-模拟二-试卷_content_list.json
    │   │   │   ├── 数学-初三(下)-202407-东城-模拟二-试卷_layout.pdf
    │   │   │   ├── 数学-初三(下)-202407-东城-模拟二-试卷_middle.json
    │   │   │   ├── 数学-初三(下)-202407-东城-模拟二-试卷_model.json
    │   │   │   └── 数学-初三(下)-202407-东城-模拟二-试卷_origin.pdf
    │   │   └── 数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册/
    │   │       ├── 义务教育教科书·数学九年级上册.md
    │   │       ├── images/
    │   │       └── ...（中间文件）
    │   │
    │   └── extracted/                     # LLM 提取结果（每份 md 镜像一个 <stem>.jsonl）
    │       ├── 数学/初中/second/2024/数学-初三(下)-202407-东城-模拟二-试卷/
    │       │   └── 数学-初三(下)-202407-东城-模拟二-试卷.jsonl
    │       └── 数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册/
    │           └── page_001.jsonl
    │
    ├── src/
    │   ├── config.py                      # RefineryConfig
    │   ├── scanner.py                     # MaterialScanner
    │   ├── checkpoint.py                  # RefineryCheckpoint
    │   ├── convert.py                     # Converter + MineruRunner
    │   ├── convert_cli.py                 # convert 独立入口
    │   ├── markdown_scanner.py            # MarkdownScanner
    │   ├── extract.py                     # Extractor
    │   ├── extract_cli.py                 # extract 独立入口
    │   ├── llm.py                         # LLMClient
    │   ├── models.py                      # ExamQuestion / TextbookCard
    │   └── prompts/                       # prompt 模板
    │       ├── exam_questions.txt
    │       └── textbook_cards.txt
    ├── tests/
    ├── requirements.txt
    ├── .env.example
    └── README.md
```

---

## 2. Task 分解（已按 TDD 完成）

### Task 1: 配置加载 `src/config.py`

**Files:**
- Create: `tools/data-refinery/src/config.py`
- Test: `tools/data-refinery/tests/test_config.py`

实现 `RefineryConfig.from_env()`，支持 `REFINERY_INPUT_DIR`、`REFINERY_OUTPUT_DIR`、`MINERU_BIN`、`OPENAI_API_KEY` 等环境变量。`MINERU_TOKEN` 由 MinerU CLI 直接读取，程序不传递 `--token`。

### Task 2: 素材扫描器 `src/scanner.py`

**Files:**
- Create: `tools/data-refinery/src/scanner.py`
- Test: `tools/data-refinery/tests/test_scanner.py`

实现 `MaterialScanner`，递归扫描输入目录，识别：
- `.pdf` 文件 → `Material(kind="pdf", ...)`
- 包含 `page_*.jpg` 的目录 → `Material(kind="images", ...)`

### Task 3: 断点续传 `src/checkpoint.py`

**Files:**
- Create: `tools/data-refinery/src/checkpoint.py`
- Test: `tools/data-refinery/tests/test_checkpoint.py`

实现 `RefineryCheckpoint`，持久化 `converted` / `extracted` 集合到 JSON。

### Task 4: 转换器 `src/convert.py`

**Files:**
- Create: `tools/data-refinery/src/convert.py`
- Test: `tools/data-refinery/tests/test_convert.py`

实现 `MineruRunner`（调用 `mineru-open-api extract ... -f md`）和 `Converter`（幂等转换、跳过已转换目录）。

### Task 5: convert CLI `src/convert_cli.py`

**Files:**
- Create: `tools/data-refinery/src/convert_cli.py`
- Test: `tools/data-refinery/tests/test_convert_cli.py`

实现 `convert` 子命令：扫描素材、按 `--source` 过滤、断点续传、错误统计、dry-run。

### Task 6: CLI 入口（独立）

**Files:**
- Create: `tools/data-refinery/src/convert_cli.py`
- Create: `tools/data-refinery/src/extract_cli.py`
- Test: `tools/data-refinery/tests/test_convert_cli.py`
- Test: `tools/data-refinery/tests/test_extract_cli.py`

`convert_cli.py` 与 `extract_cli.py` 作为两个独立 CLI 入口，分别通过 `if __name__ == "__main__"` 直接运行，不经过统一分发器。

### Task 7: Pydantic 模型 `src/models.py`

**Files:**
- Create: `tools/data-refinery/src/models.py`
- Test: `tools/data-refinery/tests/test_models.py`

实现 `ExamQuestion` 和 `TextbookCard`，字段类型使用 `Literal` 校验。

### Task 8: LLM 客户端 `src/llm.py`

**Files:**
- Create: `tools/data-refinery/src/llm.py`
- Test: `tools/data-refinery/tests/test_llm.py`

实现 `LLMClient`，基于 `openai` SDK，固定 `response_format={"type": "json_object"}`。

### Task 9: Prompt 模板 `src/prompts/`

**Files:**
- Create: `tools/data-refinery/src/prompts/exam_questions.txt`
- Create: `tools/data-refinery/src/prompts/textbook_cards.txt`

### Task 10: 提取器 `src/extract.py`

**Files:**
- Create: `tools/data-refinery/src/extract.py`
- Test: `tools/data-refinery/tests/test_extract.py`

实现 `Extractor`，根据 `kind` 将 LLM 返回的 JSON 解析为 `ExamQuestion` 或 `TextbookCard`。

### Task 11: Markdown 扫描器 `src/markdown_scanner.py`

**Files:**
- Create: `tools/data-refinery/src/markdown_scanner.py`
- Test: `tools/data-refinery/tests/test_markdown_scanner.py`

实现 `MarkdownScanner`，按文件名推断 `questions`（试卷/答案）或 `cards`（其他）。

### Task 12: extract CLI `src/extract_cli.py`

**Files:**
- Create: `tools/data-refinery/src/extract_cli.py`
- Test: `tools/data-refinery/tests/test_extract_cli.py`

实现 `extract` 子命令：扫描 Markdown、加载对应 prompt、调用 LLM、输出 JSONL、断点续传。

### Task 13: 依赖与配置

**Files:**
- Create: `tools/data-refinery/requirements.txt`
- Create: `tools/data-refinery/.env.example`

追加 `pydantic>=2.0`、`openai>=1.0`、`python-dotenv>=1.0`。

### Task 14: 文档

**Files:**
- Create: `tools/data-refinery/README.md`

包含安装、配置、convert/extract 用法。

---

## 3. 自检清单

### 3.1 Spec 覆盖检查

| 需求 | 对应 Task |
|------|----------|
| 递归扫描 PDF/图片，不依赖 meta.json | Task 2 |
| 调用 `mineru-open-api` 转换 Markdown | Task 4 |
| 输出目录与 `data/` 独立 | Task 1, Task 5, Task 12 |
| 保留 mineru 原始输出（md + images + 中间文件） | Task 4 |
| 从 Markdown 提取题目/卡片 | Task 10, Task 12 |
| 数据模型对齐 Content Service | Task 7 |
| 支持断点续传 | Task 3 |
| 支持按 source 过滤 | Task 5, Task 12 |

### 3.2 Placeholder 扫描

- [x] 无 `TBD`、`TODO`、`implement later`、`fill in details`
- [x] 无空泛的 "add error handling" / "write tests"
- [x] 每个代码步骤都包含完整代码

### 3.3 类型一致性检查

- [x] `Material.kind` 取值 `"pdf" | "images"`
- [x] `MarkdownSource.kind` 取值 `"questions" | "cards"`
- [x] `ExamQuestion.type` Literal 约束
- [x] `TextbookCard.card_type` Literal 约束
- [x] `RefineryCheckpoint` 字段名一致

---

## 4. 执行状态

**本计划已全部实现并位于 `tools/data-refinery/`。**

测试命令：

```bash
cd tools/data-refinery
pytest tests/ -q
```

使用命令：

```bash
python src/convert_cli.py --source zgkao --dry-run
python src/extract_cli.py --source smartedu --dry-run
```
