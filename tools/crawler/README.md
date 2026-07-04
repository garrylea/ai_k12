# K12 试卷爬虫

抓取 zgkao.com 试卷索引页，解析详情页 PDF 下载链接，按 `学科/学段/学期/年份` 落盘并写入 `meta.json`。支持 robots.txt 检查、断点续传、PDF 完整性校验。

## 安装

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

依赖：`requests`、`beautifulsoup4`、`pypdf`；开发额外需要 `pytest`。

## 用法

```bash
python src/main.py --url <入口页 URL> [options]
```

参数：

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--url` | 入口页 URL（必填） | — |
| `--output` | 输出目录 | `./data` |
| `--subject` | 学科过滤（逗号分隔多个） | 不限 |
| `--year` | 年份过滤（逗号分隔多个） | 不限 |
| `--district` | 区县过滤（逗号分隔多个） | 不限 |
| `--force` | 强制重新下载，忽略断点 | 否 |
| `--dry-run` | 只检查不下载 | 否 |

示例：

```bash
python src/main.py \
  --url https://www.zgkao.com/shitiku/89047.html \
  --year 2024,2025 \
  --output ./data
```

## 输出结构

```
data/
└── 数学/
    └── 初中/
        └── second/
            └── 2025/
                ├── meta.json
                ├── 数学-初三(下)-202507-海淀-模拟二-试卷.pdf
                └── 数学-初三(下)-202507-海淀-模拟二-答案.pdf
```

`meta.json` 记录分类维度、来源站点、爬取时间，以及 `files` 数组（每个文件的 `filename` / `type` / `source_url` / `download_time` / `size_bytes` / `md5`）。

断点信息记录在 `data/.checkpoint.json`，重启后已下载的 URL 会被跳过（除非 `--force`）。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/main.py` | CLI 入口与爬虫编排 |
| `src/fetcher.py` | HTTP 请求（重试、自定义 UA、Range 续传） |
| `src/robots.py` | robots.txt 解析（RFC 9309 长匹配优先） |
| `src/parser.py` | 索引页表格 + 详情页 `__NUXT_DATA__` / 下载锚点解析 |
| `src/classifier.py` | 分类维度与规范化文件名 |
| `src/storage.py` | 落盘与 `meta.json` 维护 |
| `src/validator.py` | PDF 完整性校验（pypdf） |
| `src/checkpoint.py` | 断点续传 |

## 测试

```bash
pytest
```

140 个测试覆盖每个模块。`conftest.py` 将 `src/` 加入 `sys.path`，因此测试可直接 `from main import ...` 等扁平导入；`src/` 是脚本目录而非 Python 包，故不需要 `__init__.py`。

## 设计要点

- **robots.txt 优先**：每次运行重新拉取并解析，按 user-agent 分组匹配，遵循 RFC 9309 的"最长匹配优先"规则（不依赖标准库 `urllib.robotparser`，因其为先匹配优先）。
- **二级索引递归**：若详情页未直接提供 PDF 链接，会尝试将其作为二级索引页继续解析。
- **答案 / 试卷分离**：当详情页同时提供"试卷"与"答案"两个 PDF 时，分别归类为 `试卷` / `答案` 文件类型；只有一个文件时统一归为 `试卷`。
- **校验失败即丢弃**：下载后用 pypdf 验证完整性，无效 PDF 会被删除并计入 `papers_failed`。
