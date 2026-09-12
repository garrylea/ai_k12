# K12 数据爬虫

多站点统一框架，当前支持两个数据源：

- **zgkao** - 抓取 zgkao.com 试卷索引页，下载 PDF 试卷/答案
- **smartedu** - 抓取国家中小学智慧教育平台教材预览图（逐页 JPEG）

通过 `SiteAdapter` 接口解耦站点逻辑，共享 fetcher/robots/checkpoint/validator/storage 基础设施。

爬取产物是数据管线（`tools/data-refinery/`）的输入，见文末「[数据去向](#数据去向)」。

## 安装

```bash
# 需要 Python 3.10+（代码使用 PEP 604 联合类型等语法）
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

依赖：`requests`、`beautifulsoup4`、`pypdf`；开发额外需要 `pytest`。

## 用法

### CLI

> 2026-09-12 起 `src/main.py` 与 `src/cli.py` 已合并为 `src/crawler_cli.py`，
> 旧命令 `python src/main.py --url ...` 不再可用。
>
> **迁移提示（破坏性变更，2026-09-12）**：2026-09-12 之前抓取的数据里，初三（上）期末被错归档到
> `second/`，文件名带 `--2025学年-`。修正分两步——**先删错名的旧文件，再用 `--force` 重抓**：
>
> ```bash
> # 1) 先列出来确认（本仓库遗留数据是 11 个，名字里都带 `--20xx学年`）
> find data -type f -name '*--20*学年*'
> # 确认无误后删除
> find data -type f -name '*--20*学年*' -delete
>
> # 2) 重抓受影响的页面。checkpoint 以 PDF URL 为键、与落盘路径无关，
> #    不加 --force 会静默跳过旧 PDF、产出 0 个修正文件
> python src/crawler_cli.py --site zgkao \
>   --url https://www.zgkao.com/shitiku/87761.html \
>   --subject 数学 --output ./data --force
> ```
>
> `--force` 只作用于本次运行，比清空 `data/.checkpoint.json` 更精准——后者会让之后**每个**页面的
> 抓取都重新下载。删文件后各目录的 `meta.json` 会残留已删文件的记录；下游管线按 `*.pdf` 扫描、
> 不读 `meta.json`，不影响流程。
>
> 不要图省事 `rm -rf data/*/*/second`：`second/` 里还有本来就正确的一模/二模数据。
>
> 下游 `tools/data-refinery` 默认读取 `tools/crawler/data`，其 `src/toc_parse_cli.py`
> 同时接受 `first` 与 `second` 作为学期路径段——**清掉旧文件即可，下游无需改代码**。

```bash
python src/crawler_cli.py --site <zgkao|smartedu> [options]
```

`--site` 之外，`--output`/`--force`/`--dry-run`/`--crawl-delay` 为两站通用参数；
其余参数按站点生效（传给不支持的站点会被参数校验拒绝）。

#### zgkao 试卷

```bash
python src/crawler_cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/89047.html \
  --year 2024,2025 \
  --output ./data

# 学科 + 区县过滤（多值用逗号分隔）
python src/crawler_cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/89047.html \
  --subject 数学 \
  --district 海淀,西城

# 试运行：只列出会下载的内容，不落盘、不写 checkpoint
python src/crawler_cli.py --site zgkao --url https://www.zgkao.com/shitiku/89047.html --dry-run

# 忽略断点记录，强制重新下载
python src/crawler_cli.py --site zgkao --url https://www.zgkao.com/shitiku/89047.html --force
```

```bash
# 只下载初三的试卷
python src/crawler_cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/87761.html \
  --subject 数学 --grade 初三
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--url` | 入口页 URL（必填） | - |
| `--output` | 输出目录 | `./data` |
| `--subject` | 学科过滤，逗号分隔多值（如 `数学,英语`） | 不限 |
| `--year` | 年份过滤，逗号分隔多值（如 `2024,2025`） | 不限 |
| `--district` | 区县过滤，逗号分隔多值（如 `海淀,西城`） | 不限 |
| `--grade` | 年级过滤，逗号分隔多值。取值用站点原生写法：`初一`/`初二`/`初三`/`高一`/`高二`/`高三` | 不限 |
| `--crawl-delay` | 重试间隔延时（秒）。两站通用；zgkao 默认 0 | `0` |
| `--force` | 强制重新下载 | 否 |
| `--dry-run` | 只检查不下载 | 否 |

#### smartedu 教材

```bash
python src/crawler_cli.py --site smartedu \
  --subject 数学 \
  --level 初中 \
  --grade 九年级 \
  --semester 上册 \
  --output ./data

# 出版社过滤
python src/crawler_cli.py --site smartedu --subject 数学 --publisher 人教版

# 试运行
python src/crawler_cli.py --site smartedu --subject 数学 --dry-run

# 同一书名保留所有版本（默认只取最新版）
python src/crawler_cli.py --site smartedu --subject 数学 --no-latest-only

# 礼貌延时：每 2 秒一次
python src/crawler_cli.py --site smartedu --subject 数学 --crawl-delay 2
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--output` | 输出目录 | `./data` |
| `--subject` | 学科过滤（如 `数学`） | 不限 |
| `--level` | 学段过滤（小学/初中/高中） | 不限 |
| `--grade` | 年级过滤（如 `九年级`） | 不限 |
| `--semester` | 册次过滤（上册/下册） | 不限 |
| `--publisher` | 版本过滤（如 `人教版`） | 不限 |
| `--latest-only` | 同书只取最新版本。默认开启，无需显式传 | 是 |
| `--no-latest-only` | 关闭 latest-only（同书各版本都下载） | - |
| `--crawl-delay` | 重试间隔延时（秒）。两站通用；smartedu 默认 0.5 | `0.5` |
| `--force` | 强制重新下载 | 否 |
| `--dry-run` | 只检查不下载 | 否 |

### 学期判定（first / second，仅 zgkao）

学期由程序从页面自动识别，**无需命令行指定**（smartedu 教材线仍用 `--semester` 指定上册/下册），优先级：

1. 索引页表头的（上）/（下）标记，如 `海淀区2024-2025学年初三（上）期末考试卷和答案汇总`
2. PDF 文件名 / 试卷标题里的标记，如 `2025北京海淀初三（上）期末数学.pdf`
3. 一模 / 二模 / 三模 —— 约定属下学期
4. 文件名里的月份：9-12、1 月 → 上学期；3-7 月 → 下学期（2、8 月跨学期，不判）
5. 以上都判不出 → 交互式终端会提示 `请填写学期 [上/下]`（同一「年级-考试类型-年份」只问一次）；
   非交互环境（管道 / CI）则跳过该文件并逐条警告，结束时以退出码 2 报告

`--dry-run` 不询问、不因判不出报错。

## 输出结构

### zgkao

```
data/
└── 数学/
    └── 初中/
        └── first/
            └── 2026/
                ├── meta.json
                ├── 数学-初三(上)-202607-海淀-期末-试卷.pdf
                └── 数学-初三(上)-202607-海淀-期末-答案.pdf
```

（区县写成 `海淀` 而非 `海淀区`：解析时已统一去掉末尾「区」，与 README 参数表里的 `--district 海淀,西城` 一致。）

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

## 数据去向

爬取产物**不是终点**，而是数据精炼管线（`tools/data-refinery/`）的输入：

```
crawler（本工具）          ->  convert_cli  ->  extract_cli  ->  publish_cli  ->  db_loader_cli
PDF / JPG（./data/...）        PDF/JPG -> MD    MD -> JSONL     图片物化         JSONL -> MySQL
```

- 数据精炼默认输入目录就是 `tools/crawler/data`（`REFINERY_INPUT_DIR` 默认值），无需搬移。
- 完整流程见 [data-refinery 使用手册](../../docs/data-refinery-使用手册.md)（环境准备、各 CLI 参数、推荐工作流）。
- 也可以在 `.env` 里用 `REFINERY_INPUT_DIR` 指向其他爬取目录。

## 架构

```
src/
├── core/               # 站点无关共享层
│   ├── fetcher.py      # HTTP 请求（重试、HEAD、Range 续传）
│   ├── robots.py       # robots.txt 解析（RFC 9309）
│   ├── checkpoint.py   # 断点续传
│   ├── validator.py    # PdfValidator + ImageValidator
│   ├── storage.py      # ResourceStore -> PdfStore / ImageStore
│   └── crawler.py      # 通用编排（adapter + fetcher + store + checkpoint）
├── adapters/           # 站点适配器
│   ├── base.py         # SiteAdapter 接口、Item、DownloadContext
│   ├── zgkao.py        # zgkao.com 试卷适配器
│   └── smartedu.py     # smartedu.cn 教材适配器
├── parser.py           # zgkao 索引/详情页解析
├── classifier.py       # zgkao 分类维度与规范化文件名
└── crawler_cli.py      # 唯一 CLI 入口（zgkao 试卷 / smartedu 教材）
```

## 测试

```bash
pytest              # 运行全部单元/集成测试（~200 个）
pytest -m network   # 运行真实网络烟雾测试
```

`conftest.py` 将 `src/` 和 `src/core/` 加入 `sys.path`。测试组织：

- `tests/core/` - fetcher、robots、checkpoint、validator、storage、crawler 测试
- `tests/adapters/` - zgkao 和 smartedu 适配器测试
- `tests/test_crawler_cli.py` - CLI 参数解析测试

## 设计要点

- **SiteAdapter 模式**：新增站点只需实现 `list_items` + `download_item`，无需改动核心代码。
- **robots.txt 优先**：遵循 RFC 9309 最长匹配优先规则。
- **熔断机制**（smartedu）：连续 3 页下载失败自动中止，标记 `partial` 状态，继续处理剩余书籍。
- **页数获取**（smartedu）：preview 通常只含约 49 页（全书常 160+ 页），通过 HEAD 请求二分探测最大页码补全总页数。
- **断点续传**：zgkao 按 PDF URL 记录，smartedu 按页 URL + book ID 双层记录。
- **校验失败即丢弃**：PDF 用 pypdf 验证，图片检查 JPEG magic number。
