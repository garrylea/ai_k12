# Data Refinery（批量模式）

离线数据准备工具，将爬虫下载的 PDF/教材图片转换为 Markdown，再调用 LLM 提取结构化题目或教材卡片。

## 目录

```
tools/data-refinery/
├── src/
│   ├── cli.py                # CLI 入口
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
python src/cli.py convert --source zgkao --dry-run
python src/cli.py convert --source smartedu
```

输出到 `tools/data-refinery/output/md/`，保留 MinerU 生成的 `.md`、`images/` 及中间文件。

### 2. extract：Markdown → 结构化 JSONL

```bash
python src/cli.py extract --source zgkao --dry-run
python src/cli.py extract --source smartedu
```

输出到 `tools/data-refinery/output/extracted/`，试卷生成 `questions.jsonl`，教材生成 `cards.jsonl`。

## 配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `REFINERY_INPUT_DIR` | 素材输入目录 | `tools/crawler/data` |
| `REFINERY_OUTPUT_DIR` | 结果输出目录 | `tools/data-refinery/output` |
| `MINERU_BIN` | MinerU 可执行文件 | `mineru-open-api` |
| `MINERU_TIMEOUT` | MinerU 超时（秒） | `300` |
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
