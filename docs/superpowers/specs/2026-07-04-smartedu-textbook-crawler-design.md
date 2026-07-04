# smartedu 教材爬虫改造设计

**日期**：2026-07-04
**状态**：已通过头脑风暴，待写实现计划
**关联模块**：`tools/crawler/`

## 1. 背景与目标

现有爬虫（`tools/crawler/`）专为 zgkao.com 试卷设计，HTML 表格 + Nuxt 数据解析。需扩展支持 smartedu.cn 教材抓取，二者架构差异显著：

| 维度 | zgkao | smartedu |
| --- | --- | --- |
| 渲染 | 服务端 HTML + Nuxt | SPA，静态 JSON |
| 入口 | 单索引页 URL | 4+ 分片 JSON |
| 资源 | PDF（试卷+答案） | 原始 PDF 需登录；49 张页面预览图公开 |
| 元数据 | 学科/学段/学期/年份/区县/考试类型 | 学段/学科/版本/年级/册次 |

**目标**：
- 统一爬虫框架，支持多站点（zgkao + smartedu）通过站点适配器接入
- smartedu 抓取页面预览图（不登录、不下 PDF）
- 共享层（fetcher/robots/checkpoint/validator/storage）最大化复用
- 现有 zgkao 140 个测试平滑迁移，行为不变

**非目标**：
- 不实现 smartedu 登录态与 PDF 下载（后续可扩展）
- 不做 OCR / 文本抽取（图片下载即止）
- 不做并发下载（顺序 + crawl_delay 足够）
- 不重构 zgkao 现有 parser/classifier 内部逻辑（仅搬迁位置）

## 2. 架构

```
tools/crawler/
├── src/
│   ├── core/                       # 共享层（站点无关）
│   │   ├── fetcher.py              # 复用，无改动
│   │   ├── robots.py               # 复用，无改动
│   │   ├── checkpoint.py           # 复用，无改动
│   │   ├── validator.py            # 扩展：PdfValidator + ImageValidator
│   │   ├── storage.py              # 重构：ResourceStore 接口 + PdfStore + ImageStore
│   │   └── crawler.py              # 新增：通用编排（替代旧 main.py 的 Crawler 类）
│   ├── adapters/                   # 站点层
│   │   ├── base.py                 # SiteAdapter 抽象接口 + Item/DownloadResult/DownloadContext
│   │   ├── zgkao.py                # 包装现有 parser/classifier/main 逻辑
│   │   └── smartedu.py             # 新增：JSON 列表 + 图片下载
│   ├── parser.py                   # 现有 zgkao parser（adapters/zgkao.py 引用）
│   ├── classifier.py               # 现有 zgkao classifier（adapters/zgkao.py 引用）
│   └── main.py                     # 重写：CLI 入口，选 adapter、注入共享组件、跑 crawler.run()
└── tests/
    ├── core/                       # 共享层测试（迁移自现有）
    │   ├── test_fetcher.py
    │   ├── test_robots.py
    │   ├── test_checkpoint.py
    │   ├── test_validator.py
    │   └── test_crawler.py         # 新增
    ├── adapters/
    │   ├── test_zgkao.py           # 合并自现有 test_main/test_parser/test_classifier/test_storage
    │   └── test_smartedu.py        # 新增
    ├── conftest.py                 # sys.path 注入（保持现有）
    └── pytest.ini
```

### SiteAdapter 接口（`adapters/base.py`）

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

@dataclass
class Item:
    id: str                          # 唯一标识（zgkao: detail_url；smartedu: asset_id）
    title: str
    tags: dict                       # 标准化维度
    raw: dict                        # 原始数据，供 adapter 自用

@dataclass
class DownloadResult:
    files_downloaded: int = 0
    files_skipped: int = 0
    files_failed: int = 0

@dataclass
class DownloadContext:
    fetcher: "Fetcher"
    store: "ResourceStore"
    checkpoint: "Checkpoint"
    validator: "Validator"
    force: bool = False
    dry_run: bool = False

class SiteAdapter(ABC):
    name: str
    @abstractmethod
    def list_items(self, filters: dict) -> Iterator[Item]: ...
    @abstractmethod
    def download_item(self, item: Item, ctx: DownloadContext) -> DownloadResult: ...
    @abstractmethod
    def robots_urls(self) -> list[str]: ...
    @abstractmethod
    def supported_filters(self) -> set[str]: ...
    @abstractmethod
    def required_args(self) -> set[str]: ...
```

### 通用编排（`core/crawler.py`）

```python
class Crawler:
    def __init__(self, adapter, fetcher, store, checkpoint, validator, robots_checker):
        self._adapter = adapter
        # ...

    def run(self, filters: dict) -> CrawlResult:
        for robots_url in self._adapter.robots_urls():
            robots_content = self._fetcher.fetch_text(robots_url)
            checker = RobotsChecker(robots_content)
            if not checker.is_allowed(robots_url):
                return CrawlResult(robots_blocked=True)

        result = CrawlResult()
        for item in self._adapter.list_items(filters):
            if self._checkpoint.is_downloaded(item.id) and not self._force:
                result.skipped += 1
                continue
            download_result = self._adapter.download_item(item, ctx)
            result.downloaded += download_result.files_downloaded
            # ...
        return result
```

## 3. smartedu Adapter 数据流

### 端点

| 用途 | URL |
| --- | --- |
| tag 体系 | `https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/tags/tch_material_tag.json` |
| 分片总数 | `https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/resources/tch_material/version/data_version.json` |
| 分片数据 | `https://s-file-{1,2}.ykt.cbern.com.cn/zxx/ndrs/resources/tch_material/part_{100+i}.json` |
| 页面图片 | `https://r{1,2,3}-ndr.ykt.cbern.com.cn/edu_product/esp/assets/{asset_id}.t/zh-CN/{ts}/transcode/image/{N}.jpg` |

### list_items 流程

```
1. GET tch_material_tag.json（缓存到内存，作为 tag_id → 名称映射）
2. GET data_version.json → 取 part_count
3. for i in range(part_count):
     GET part_{100+i}.json
     for item in data:
       标准化 tag_list → {level, subject, publisher, grade, semester}
       应用 filters
       收集到内存
4. 若 latest_only（默认 true）:
     按 (title, publisher) 分组，每组保留 max(update_time)
5. yield Item(...)
```

### download_item 流程

```
1. 从 item.raw.custom_properties.preview 取 Slide1 的 URL
   → 解析出模板：{scheme}://{host}/edu_product/esp/assets/{asset_id}.t/zh-CN/{ts}/transcode/image/{N}.jpg
2. 探测总页数：从 N=1 开始 HEAD 请求，首个 404 即结束
   （preview 通常只含 9 张缩略图，无法直接得知总页数）
3. mkdir 存储目录
4. 写 meta.json 占位（files: [], total_pages: N, status: "in_progress"）
5. for page in 1..N:
     url = template.format(N=page)
     if checkpoint.is_downloaded(url) and not force: skip
     bytes = fetcher.fetch_bytes(url)   # fetcher 内部已对 HTTP 5xx/timeout 重试 3 次
     ImageValidator 校验
     若校验失败：删文件 → 重新 fetch 1 次 → 仍失败则跳过该页
       consecutive_failures += 1
       若 consecutive_failures >= 3：抛 CircuitBreakerError，停止
     若成功：consecutive_failures = 0
     写 page_{N:03d}.jpg
     checkpoint.mark_downloaded(url)        # 页级标记
     追加 meta.json files 数组
6. 全部完成后：meta.json status = "complete" 或 "partial"
7. checkpoint.mark_downloaded(item.id)       # 书级标记，配合 complete 实现整本跳过
```

**重试层次说明**（避免混淆）：
- **fetcher 层**：HTTP 5xx / 网络异常 / timeout → 自动重试 3 次（现有 `Fetcher._fetch_with_retry`）
- **adapter 层**：HTTP 200 但内容校验失败（损坏 JPEG / HTML 伪装 / 空响应）→ 删文件 + 重新 fetch 1 次
- 两层独立计数，fetcher 重试耗尽后抛 HTTPError，adapter 视为该页失败（计入 `consecutive_failures`）

### tag 标准化映射

| tag_dimension_id | 维度 | 标准化字段 |
| --- | --- | --- |
| `zxxxd` | 学段 | `level`（小学/初中/高中/特殊教育） |
| `zxxxk` | 学科 | `subject`（数学/语文/...） |
| `zxxbb` | 版本 | `publisher`（人教版/北师大版/...） |
| `zxxnj` | 年级 | `grade`（一年级/.../九年级/...） |
| `zxxcc` | 册次 | `semester`（上册/下册） |

## 4. 存储布局与 meta.json

### 目录结构

```
zgkao（保持现有，单文件资源）:
data/数学/初中/second/2025/
  ├── meta.json
  ├── 数学-初三(下)-202507-海淀-模拟二-试卷.pdf
  └── 数学-初三(下)-202507-海淀-模拟二-答案.pdf

smartedu（多文件资源，末层加书名目录）:
data/数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册/
  ├── meta.json
  ├── page_001.jpg
  ├── page_002.jpg
  └── ... page_049.jpg
```

**组织原则一致**：按可用维度分类，多文件资源在末尾加书名目录隔离不同书。维度本身不同（zgkao 有区县/年份/考试类型，smartedu 有版本/年级），无法做到完全相同目录层。

### ResourceStore 接口

```python
class ResourceStore(ABC):
    @abstractmethod
    def save(self, dir_relpath: Path, filename: str, content: bytes,
             source_url: str, file_type: str, classification: dict) -> Path: ...
    @abstractmethod
    def read_meta(self, dir_relpath: Path) -> Optional[dict]: ...
    @abstractmethod
    def write_meta(self, dir_relpath: Path, meta: dict) -> None: ...

class PdfStore(ResourceStore): ...    # zgkao 用，行为同现有 storage.py
class ImageStore(ResourceStore): ...  # smartedu 用，每页写一次 + 累积 meta.json
```

adapter 提供 `storage_dir(classification) -> Path`，store 只管往该目录写文件 + 维护 meta.json。

### meta.json schema（统一）

```json
{
  "classification": {
    "subject": "数学",
    "level": "初中",
    "publisher": "人教版",
    "grade": "九年级",
    "semester": "上册",
    "title": "义务教育教科书·数学九年级上册"
  },
  "source": {
    "site": "smartedu.cn",
    "entry_url": "https://basic.smartedu.cn/tchMaterial",
    "crawl_time": "2026-07-04T10:00:00Z",
    "asset_id": "71a82bac-0c70-4d53-9e8f-22be536415f0",
    "content_id": "937a48c1-de81-4cc6-91b2-617cd859de4b"
  },
  "files": [
    {
      "filename": "page_001.jpg",
      "type": "image",
      "page": 1,
      "source_url": "https://r3-ndr.ykt.cbern.com.cn/.../image/1.jpg",
      "download_time": "2026-07-04T10:00:01Z",
      "size_bytes": 617686,
      "md5": "..."
    }
  ],
  "total_pages": 49,
  "status": "complete",
  "config": {
    "crawler_version": "2.0.0",
    "robots_txt_checked": true,
    "site_adapter": "smartedu"
  }
}
```

zgkao 的 meta.json 沿用现有 schema，仅补 `site_adapter: "zgkao"` 字段，向后兼容。

### 文件命名

- 图片：`page_{N:03d}.jpg`（零填充 3 位）
- 书名目录：保留原 title 中的特殊字符（·、（）、空格），仅去除路径非法字符 `/ \ : * ? " < > |`

### meta.json 写入时机

- 探测完总页数后，先写占位：`files: []`、`total_pages: N`、`status: "in_progress"`
- 每页下载成功后追加 file 记录并重写
- 全部完成：`status: "complete"`；有缺页：`status: "partial"`
- 中断重跑：读 `total_pages` 与已落盘 `page_*.jpg` 对比，缺哪页补哪页；若 `meta.json` 损坏则从磁盘 `page_*.jpg` 重建

## 5. CLI 设计

```bash
# zgkao（保持现有行为）
python src/main.py --site zgkao \
  --url https://www.zgkao.com/shitiku/89047.html \
  --year 2024,2025 \
  --output ./data

# smartedu
python src/main.py --site smartedu \
  --subject 数学 \
  --level 初中 \
  --grade 九年级 \
  --semester 上册,下册 \
  --publisher 人教版,北师大版 \
  --latest-only \         # 默认 true，可用 --no-latest-only 关闭
  --output ./data
```

### 参数矩阵

| 参数 | zgkao | smartedu | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--site` | ✓ 必填 | ✓ 必填 | — | 选 adapter |
| `--url` | ✓ 必填 | ✗ | — | zgkao 入口页 |
| `--output` | ✓ | ✓ | `./data` | 输出目录 |
| `--subject` | ✗ | ✓ | 不限 | 学科过滤 |
| `--level` | ✗ | ✓ | 不限 | 学段过滤（小学/初中/高中/特殊教育） |
| `--year` | ✓ | ✗ | 不限 | 年份过滤 |
| `--district` | ✓ | ✗ | 不限 | 区县过滤 |
| `--grade` | ✗ | ✓ | 不限 | 年级过滤 |
| `--semester` | ✗ | ✓ | 不限 | 册次过滤（上册/下册） |
| `--publisher` | ✗ | ✓ | 不限 | 版本过滤 |
| `--latest-only` | ✗ | ✓ | true | 同书多版本只取最新 |
| `--force` | ✓ | ✓ | false | 忽略断点强制重下 |
| `--dry-run` | ✓ | ✓ | false | 只列项不下 |
| `--crawl-delay` | ✓ | ✓ | zgkao:0 / smartedu:0.5 | 礼貌延时（秒） |

### 参数校验

adapter 各自声明 `required_args()` 与 `supported_filters()`，`main.py` 解析后校验。比如 `--site zgkao --grade 九年级` 报错（zgkao 不支持 grade）。

### dry-run 行为

- zgkao：现有行为（计数不下载）
- smartedu：列出匹配教材（title + publisher + provider），**不探测页数也不下载**

## 6. 错误处理与恢复

| 错误场景 | 处理策略 |
| --- | --- |
| catalog JSON 拉取失败 | 重试 3 次 → 仍失败则整体 abort |
| 单页图片下载失败 | 重试 3 次 → 跳过该页，meta 标 `failed: true`，`consecutive_failures += 1` |
| 连续 3 页失败 | **熔断**：抛 `CircuitBreakerError`，整体 abort |
| 任意一页成功 | `consecutive_failures` 重置为 0 |
| 页数探测 HEAD 404 | 正常信号（书末），不报错 |
| 图片校验失败（损坏/HTML 伪装/空） | 删文件 → 重试 1 次 → 仍失败则跳过该页 |
| HTTP 429 限流 | 指数退避（1s/2s/4s）最多 3 次 |
| robots.txt 拉取失败 | fail-safe，abort 整站点 |
| robots.txt 禁止 | abort 整站点 |
| 磁盘满 / IO 错误 | abort，打印清晰错误 |
| meta.json 损坏（重跑时） | 从磁盘 `page_*.jpg` 重建 files 数组 |

### 断点续传

checkpoint 有两层标记：
- **页级**：每页下载成功后记 `page_url`，重跑时跳过该页
- **书级**：整本完成后记 `item.id`，重跑时跳过整本（含页数探测）

失败页**不记** checkpoint，下次重跑会重试。meta.json `files` 数组里 `failed: true` 的记录，重跑时检测到会重下并覆盖。整本书完成后 meta.json 加 `status: "complete"`；重跑时跳过 `complete` 的书（除非 `--force`）。

### 可观测性

- 控制台：每本书的 `downloaded/skipped/failed` 计数
- 跑完汇总：N 本书完成、M 本有缺页、K 本完全失败
- meta.json 顶层 `status` 字段：`complete` / `partial` / `failed`

## 7. 测试策略

### 测试分层

```
tests/
├── core/                          # 共享层测试
│   ├── test_fetcher.py            # 现有，不动
│   ├── test_robots.py             # 现有，不动
│   ├── test_checkpoint.py         # 现有，不动
│   ├── test_validator.py          # 扩展：加 ImageValidator 用例
│   └── test_crawler.py            # 新增：通用编排（mock adapter）
├── adapters/
│   ├── test_zgkao.py              # 合并自现有 test_main/test_parser/test_classifier/test_storage
│   └── test_smartedu.py           # 新增
├── conftest.py
└── pytest.ini
```

### 现有 140 个测试迁移

- `test_fetcher.py` / `test_robots.py` / `test_checkpoint.py`：原样保留（测共享层，接口不变）
- `test_validator.py`：保留现有 PDF 用例 + 新增 Image 用例
- `test_parser.py` / `test_classifier.py` / `test_storage.py` / `test_main.py`：合并到 `test_zgkao.py`，import 改为 `from adapters.zgkao import ...`
- 迁移后跑一遍，确保 140 个断言全过

### smartedu adapter 测试用例

**catalog 与过滤**：
- catalog 解析（mock part_100.json 片段）
- 过滤 subject=数学
- 过滤 grade=九年级
- 过滤 level=初中
- 过滤 semester=上册
- 过滤 publisher=人教版
- 多过滤组合
- latest-only 去重（同 title 不同 update_time，保留最新）

**页数探测**：
- HEAD 序列 200→200→404 → 总页数=2
- 首页就 404 → 总页数=0，跳过该书
- 全部 200（极端情况）→ 设上限 500 防御

**单本下载（核心）**：
- 3 张图片成功 → 3 个 page_*.jpg + meta.json status=complete
- 单页失败重试成功（第 1 次 500，第 2 次 200）
- 单页失败重试 3 次仍失败 → 跳过该页，meta 标 failed，consecutive_failures=1
- 熔断触发（连续 3 页失败）→ 抛 CircuitBreakerError
- 任意页成功重置 consecutive_failures
- 超时恢复（第 1 次 timeout，第 2 次 200）

**图片内容校验**：
- 损坏 JPEG（200 但 magic number 错，HTML 伪装）→ 删文件 + 重试 + 跳过
- 截断 JPEG（magic number 对但末尾不全）→ 同上
- 空响应（200 但 0 字节）→ 同上
- Content-Type 不匹配但 magic number 对 → 接受（以 magic number 为准）

**存储与命名**：
- 页号零填充（page=1 → page_001.jpg，page=49 → page_049.jpg）
- 页号缺口（page 1/2/4 成功，3 失败）→ meta files 有 3 条，status=partial
- 重跑时磁盘已有该页文件 + md5 一致 → 跳过重下，从磁盘记录重建 meta 条目
- 标题特殊字符（·、（））保留，仅去 `/ \ : * ? " < > |`
- 目录结构按维度落盘

**断点续传与状态**：
- checkpoint 已记第 1 页 → 只下第 2、3 页
- meta.json 有 `status: "complete"` → 整本跳过（不探测、不下）
- `--force` 重跑 complete 书 → 重置 complete，重新探测 + 下载
- meta.json 损坏 → 从 page_*.jpg 重建 files 数组
- 整本完成 → checkpoint 记 book_id（asset_id）

### ImageValidator 接口

```python
@dataclass
class ImageValidationResult:
    is_valid: bool
    file_size_bytes: int
    format: Optional[str]   # "jpeg" / "png" / None
    error: Optional[str]

class ImageValidator:
    def validate(self, file_path) -> ImageValidationResult: ...
```

校验规则：文件存在 + 非空 + JPEG magic number (`\xff\xd8\xff`)。不做尺寸校验。

### MockFetcher 扩展

现有 MockFetcher 只支持 `fetch_text` / `fetch_bytes`，加 `fetch_head(url) -> (status, headers)` 用于页数探测测试。真实图片 bytes 用 1x1 JPEG magic number，不依赖外网。

### 端到端集成测试

- zgkao：保留现有 `SecondaryMockFetcher` 二级索引递归用例
- smartedu：catalog → 过滤 → 探测 → 下载 → 校验 → 落盘 → checkpoint，全 mock

### 烟雾测试（可选，默认跳过）

`@pytest.mark.network` 标记，真实抓 1 本数学九年级上册（约 49 页），本地手动 `pytest -m network` 运行。CI 跳过。

### TDD 实施顺序

1. ImageValidator（最底层，无依赖）
2. ImageStore（依赖 validator）
3. smartedu catalog 解析（tag 标准化、过滤）
4. 页数探测（HEAD 序列）
5. 单本下载（串起 1-4）
6. 熔断 + 断点续传（在 5 基础上加状态）

## 8. zgkao 迁移 checklist

机械性工作，不需独立设计讨论：

1. 创建 `src/core/` 与 `src/adapters/` 目录
2. 移动 `fetcher.py` / `robots.py` / `checkpoint.py` / `validator.py` / `storage.py` 到 `src/core/`（保持文件名）
3. 重构 `storage.py`：抽出 `ResourceStore` 接口，`PdfStore` 实现现有行为
4. 扩展 `validator.py`：加 `ImageValidator`
5. 新增 `src/core/crawler.py`：从现 `main.py` 抽出 `Crawler` 类的通用编排部分
6. 移动 `parser.py` / `classifier.py` 留在 `src/`（zgkao 专用，adapters 引用）
7. 新增 `src/adapters/base.py`：`SiteAdapter` 接口与数据类
8. 新增 `src/adapters/zgkao.py`：包装现有 parser/classifier，实现 SiteAdapter
9. 新增 `src/adapters/smartedu.py`：新 adapter
10. 重写 `src/main.py`：CLI 入口，按 `--site` 选 adapter
11. 迁移测试到 `tests/core/` 与 `tests/adapters/`
12. 更新 `conftest.py` 的 sys.path 注入（指向新结构）
13. 更新 `pytest.ini`（如需要）
14. 跑全部测试，确保 140 + 新增全过
15. 更新 `tools/crawler/README.md`（新增 smartedu 用法、adapter 架构说明）

## 9. 未决问题与未来扩展

- **smartedu PDF 下载**：当前仅下图片。若未来需 PDF，需实现登录态管理（cookie 持久化），新增 `PdfAuthAdapter` 或在 smartedu adapter 加 `--with-pdf` 选项
- **并发下载**：当前顺序 + crawl_delay。若需加速，可在 adapter 层加线程池（每本书内部并发页下载，书之间顺序）
- **OCR / 文本抽取**：图片下载后若需可搜索文本，单独建 `tools/ocr/` 模块，不污染爬虫
- **增量更新**：当前 `complete` 跳过整本。若 smartedu 改版，需 `--refresh` 选项强制重探所有 complete 书的页数
- **第三个站点**：按 SiteAdapter 接口新增 `adapters/<site>.py` 即可，共享层不动
