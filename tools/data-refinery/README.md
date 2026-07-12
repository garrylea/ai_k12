# Data Refinery（批量模式）

离线数据准备工具，将爬虫下载的 PDF/教材图片转换为 Markdown，再调用 LLM 提取结构化题目或教材卡片。

## 目录

```
tools/data-refinery/
├── src/
│   ├── config.py             # 配置加载
│   ├── scanner.py            # 素材扫描器（PDF / 图片书）
│   ├── checkpoint.py         # 断点续传
│   ├── convert.py            # MinerU 调用
│   ├── convert_cli.py        # convert 子命令
│   ├── markdown_scanner.py   # Markdown 扫描器
│   ├── extract.py            # LLM 提取器
│   ├── extract_cli.py        # extract 子命令
│   ├── llm.py                # OpenAI 客户端
│   ├── models.py             # Pydantic 数据模型
│   └── prompts/              # Prompt 模板
│       ├── exam_questions.txt
│       └── textbook_cards.txt
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
# 填入 OPENAI_API_KEY
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

### 3. publish：物化图片 + 改写路径 -> published JSONL

```bash
python src/publish_cli.py --source zgkao --dry-run
python src/publish_cli.py --source smartedu
```

读 `output/extracted/` 的 `<stem>.jsonl`，把 `content`/`options`/`explanation` 里的原始图片引用 `![](images/xxx.jpg)` 按 §9 规范名（`stem_NN`、`opt_{label}`、`explain_NN`、`page_{N}_fig_{NN}`）物化到 `output/assets/`，改写为规范相对路径，并填充 `content_metadata.images[]` / `options[].image_url`。产物写到 `output/published/`（与 extracted 同构的 `<stem>.jsonl`）。

> **暂不入库 MySQL**：资源路径用源相对稳定键（`questions/{subject}/{hash}/{idx}`、`textbooks/{subject}/{hash}/{sort_order}`）。DB 入库与 `lesson_id` 映射后置（见 `docs/superpowers/plans/2026-07-12-data-refinery-publish-stage.md`）。

#### 开发期静态服务（让 web 能取到图片）

`output/assets/` 需以静态目录暴露，前端通过 `ASSET_BASE_URL` 拼接：

```bash
# 临时静态服务（示例）
cd tools/data-refinery/output && python3 -m http.server 3000
# ASSET_BASE_URL=http://localhost:3000/assets/
```

前端 `resolveAssetUrl('questions/math/.../stem_01.jpg')` -> `http://localhost:3000/assets/questions/math/.../stem_01.jpg`。生产环境切换 CDN/OSS 只改 `ASSET_BASE_URL`。

## 配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `REFINERY_INPUT_DIR` | 素材输入目录 | `tools/crawler/data` |
| `REFINERY_OUTPUT_DIR` | 结果输出目录 | `tools/data-refinery/output` |
| `MINERU_BIN` | MinerU 可执行文件 | `mineru-open-api` |
| `MINERU_TIMEOUT` | MinerU 超时（秒） | `300` |
| `MINERU_TOKEN` | MinerU API token（由 MinerU CLI 直接读取） | - |
| `LLM_PROVIDER` | LLM 提供商 | `openai` |
| `LLM_MODEL` | 模型名称 | `gpt-4o` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | API 密钥 | - |
| `LLM_BASE_URL` | 自定义 API 地址 | - |
| `LLM_TIMEOUT` | LLM 超时（秒） | `120` |
| `LLM_MAX_RETRIES` | 最大重试次数 | `3` |

## 测试

```bash
pytest tests/ -q
```
