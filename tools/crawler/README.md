# K12 数据爬虫

多站点统一框架，当前支持两个数据源：

- **zgkao** — 抓取 zgkao.com 试卷索引页，下载 PDF 试卷/答案
- **smartedu** — 抓取国家中小学智慧教育平台教材预览图（逐页 JPEG）

通过 `SiteAdapter` 接口解耦站点逻辑，共享 fetcher/robots/checkpoint/validator/storage 基础设施。

## 安装

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

依赖：`requests`、`beautifulsoup4`、`pypdf`；开发额外需要 `pytest`。

## 用法

### 多站点 CLI（推荐）

```bash
python src/cli.py --site <zgkao|smartedu> [options]
```

#### zgkao 试卷

```bash
python src/cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/89047.html \
  --year 2024,2025 \
  --output ./data
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--url` | 入口页 URL（必填） | — |
| `--output` | 输出目录 | `./data` |
| `--subject` | 学科过滤 | 不限 |
| `--year` | 年份过滤 | 不限 |
| `--district` | 区县过滤 | 不限 |
| `--force` | 强制重新下载 | 否 |
| `--dry-run` | 只检查不下载 | 否 |

#### smartedu 教材

```bash
python src/cli.py --site smartedu \
  --subject 数学 \
  --level 初中 \
  --grade 九年级 \
  --semester 上册 \
  --output ./data
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--output` | 输出目录 | `./data` |
| `--subject` | 学科过滤 | 不限 |
| `--level` | 学段过滤（小学/初中/高中） | 不限 |
| `--grade` | 年级过滤 | 不限 |
| `--semester` | 册次过滤（上册/下册） | 不限 |
| `--publisher` | 版本过滤（人教版等） | 不限 |
| `--latest-only` | 同书只取最新版本 | 是 |
| `--crawl-delay` | 礼貌延时（秒） | 0.5 |
| `--force` | 强制重新下载 | 否 |
| `--dry-run` | 只检查不下载 | 否 |

### 旧版 CLI（仅 zgkao）

```bash
python src/main.py --url <入口页 URL> [options]
```

## 输出结构

### zgkao

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

### smartedu

```
data/
└── 数学/
    └── 初中/
        └── 人教版/
            └── 九年级/
                └── 上册/
                    └── 义务教育教科书·数学九年级上册/
                        ├── meta.json
                        ├── page_001.jpg
                        ├── page_002.jpg
                        └── ...
```

`meta.json` 记录分类维度、来源站点、爬取时间、状态（`in_progress`/`complete`/`partial`），以及 `files` 数组。

断点信息记录在 `data/.checkpoint.json`，重启后已下载的 URL/book ID 会被跳过（除非 `--force`）。

## 架构

```
src/
├── core/               # 站点无关共享层
│   ├── fetcher.py      # HTTP 请求（重试、HEAD、Range 续传）
│   ├── robots.py       # robots.txt 解析（RFC 9309）
│   ├── checkpoint.py   # 断点续传
│   ├── validator.py    # PdfValidator + ImageValidator
│   ├── storage.py      # ResourceStore → PdfStore / ImageStore
│   └── crawler.py      # 通用编排（adapter + fetcher + store + checkpoint）
├── adapters/           # 站点适配器
│   ├── base.py         # SiteAdapter 接口、Item、DownloadContext
│   ├── zgkao.py        # zgkao.com 试卷适配器
│   └── smartedu.py     # smartedu.cn 教材适配器
├── parser.py           # zgkao 索引/详情页解析
├── classifier.py       # zgkao 分类维度与规范化文件名
├── main.py             # 旧版 zgkao CLI（向后兼容）
└── cli.py              # 新版多站点 CLI 入口
```

## 测试

```bash
pytest              # 运行全部单元/集成测试（~200 个）
pytest -m network   # 运行真实网络烟雾测试
```

`conftest.py` 将 `src/` 和 `src/core/` 加入 `sys.path`。测试组织：

- `tests/core/` — fetcher、robots、checkpoint、validator、storage、crawler 测试
- `tests/adapters/` — zgkao 和 smartedu 适配器测试
- `tests/test_cli.py` — CLI 参数解析测试

## 设计要点

- **SiteAdapter 模式**：新增站点只需实现 `list_items` + `download_item`，无需改动核心代码。
- **robots.txt 优先**：遵循 RFC 9309 最长匹配优先规则。
- **熔断机制**（smartedu）：连续 3 页下载失败自动中止，标记 `partial` 状态，继续处理剩余书籍。
- **页数获取**（smartedu）：直接从目录数据的 preview Slide 键数量确定总页数，无需额外网络请求。
- **断点续传**：zgkao 按 PDF URL 记录，smartedu 按页 URL + book ID 双层记录。
- **校验失败即丢弃**：PDF 用 pypdf 验证，图片检查 JPEG magic number。
