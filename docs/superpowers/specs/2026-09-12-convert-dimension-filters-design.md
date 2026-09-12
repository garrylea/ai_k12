# convert_cli 维度过滤（--subject / --stage / --term / --year）设计

日期：2026-09-12
状态：已确认（用户选定范围：四个参数都加）

## 背景

爬虫产出的素材路径本身就编码了「学科/学段/学期/年份」等维度：

```
试卷  {学科}/{学段}/{first|second}/{年份}/{试卷名}.pdf
教材  {学科}/{学段}/{出版社}/{年级}/{上册|下册}/{书名}/page_NNN.jpg
```

但 `convert_cli.py` 只有 `--source`（all/zgkao/smartedu）和 `--materials`（rel_path 子串）两道过滤，
想「只转 2025 年下学期的试卷」只能靠 `--materials "second/2025/"` 这种带斜杠的子串硬凑，有三个问题：

1. 学期目录是英文 `first`/`second`，用户得先知道目录命名才能写对；
2. 子串无锚定，`--materials "2025"` 会命中任何含 2025 的路径（文件名里还有 `-202507-`），过宽；
3. 与 `--source` 叠加时，`[WARN] 未命中素材` 会误报（条目在输入目录里存在，只是被 source 排除了）。

同期 `toc_parse_cli`（`--subject/--publisher/--grade/--term`）、`extract_cli`/`publish_cli`/`pipeline_cli`
（`--book/--pages`）都有结构化过滤，convert 是唯一缺的。

## 需求

1. 支持按 学科 / 学段 / 学期 / 年份 精确过滤，语义一目了然，不必记目录命名；
2. 学期同时接受中英文写法（试卷 `first`/`second` 与 `上`/`下`；教材 `上册`/`下册`）；
3. 每个参数支持逗号分隔多值（与同仓 `tools/crawler/src/crawler_cli.py:83` 的 `--year 2024,2025`、
   `--subject 数学,英语` 口径一致）：**同参数内取并集，参数之间取交集**；
4. 新参数与 `--materials` 子串过滤**取交集**（都是「缩小范围」的语义）；
5. 不传新参数时行为与现状完全一致（无破坏）；
6. 修掉 `--source` 过滤后的 `[WARN] 未命中素材` 误报，并在「带了过滤条件却一个素材都不剩」时给出提示。

## 设计

### 参数

```
--subject 数学,物理              # 精确匹配路径第 1 段，逗号分隔多值
--stage 初中 | junior,...        # 第 2 段，中英文别名互通
--term 下 | second | 上册,...    # 试卷 first/second，教材 上册/下册，统一归一到 first/second
--year 2026,2024                 # 4 位年份，仅试卷
```

与 `--materials` / `--materials-file` 可同时使用，取交集。

### 多值语义

`_split_filters` 按逗号切分并去空白（`"物理, 数学"` -> `['物理', '数学']`），
每个值再经别名归一，最后与素材的维度值做**集合成员判断**——
即「同参数 OR，跨参数 AND」。`--term 上,下` 等价于不加学期过滤（并集覆盖全部），
`--year 2026,2024` 即「2026 或 2024」。传空串或纯逗号等同不传。

### 维度解析（`_parse_dimensions`）

按位置取段，兼容平面与嵌套（`{试卷名}/{试卷名}.pdf`）两种布局：

- 判定试卷布局：第 3 段 ∈ {`first`,`second`} 且第 4 段是 4 位数字；
- 否则按教材布局：第 5 段（`parts[4]`）作学期；
- rel_path 少于 5 段时全部维度为 None（如根目录直接放 PDF 的异常布局），带过滤条件时一律不命中。

**为什么不用现成的 `paper_meta.parse_paper_meta`**：它是入库侧元数据解析，要求 `.jsonl` 后缀，
且对文件名命名规范（`subject-grade(学期)-YYYYMM-district-exam_type-file_type`）做严格校验，
不符合就返回 None——用它过滤会静默漏掉命名不规范的试卷。convert 只关心目录维度，按位置取段更稳。

### 别名

```python
# 学期别名：目录段值 -> 规范键（first=上学期/上册，second=下学期/下册）
_TERM_ALIASES = {
    "first": "first", "上": "first", "上册": "first", "上学期": "first",
    "second": "second", "下": "second", "下册": "second", "下学期": "second",
}
# 学段别名（爬虫目录用中文，PaperMeta/DB 用英文）
_STAGE_ALIASES = {
    "primary": "primary", "小学": "primary",
    "junior": "junior", "初中": "junior",
    "senior": "senior", "高中": "senior",
}
```

两侧都归一后再比：`--term 下册` 能命中试卷的 `second` 目录，`--term second` 也能命中教材的 `下册`。

### 过滤顺序与 WARN

```
scanner.scan()  ->  scanned（全量）
  -> _match_source      --source
  -> _match_materials   --materials / --materials-file（子串，并集）
  -> _match_filters     --subject / --stage / --term / --year（精确，交集）
```

- `_warn_unmatched_entries` 改为传 `scanned`（全量），修复 `--source` 造成的误报；
- 新增 `_warn_no_match`：`filters_active and not materials` 时打印
  `[WARN] 过滤条件未命中任何素材（--source/--materials/--subject/--stage/--term/--year）`，
  覆盖「`--source smartedu --year 2025` 这类必然为空的组合」等静默空转场景。

## 用法示例

```bash
# 2025 年 · 下学期 · 全部学科的试卷（等价于原来的 --materials "second/2025/"）
python src/convert_cli.py --source zgkao --year 2025 --term 下

# 多值：2026 与 2024 两年、数学与物理两科
python src/convert_cli.py --source zgkao --year 2026,2024 --subject 数学,物理

# 再叠学科；想重转这个子集就加 --reconvert（只作用于筛出的素材）
python src/convert_cli.py --source zgkao --subject 物理 --year 2026 --reconvert

# 教材按学期（first/second 与 上册/下册 互通）
python src/convert_cli.py --source smartedu --stage junior --term 下册

# 先看命中情况
python src/convert_cli.py --source zgkao --year 2025 --term 下 --dry-run
```

实测（2026-09-12，本仓 `tools/crawler/data`，zgkao 共 123 份）：

| 过滤 | 命中 |
|---|---|
| `--source zgkao --year 2025` | 26 |
| `--source zgkao --year 2026,2024` | 97（26 + 97 = 123，互不重叠） |
| `--source zgkao --term 上` / `下` | 77 / 46 |
| `--source smartedu --term 上册` / `second` | 3 / 2 |

## 测试（tests/test_convert_cli.py）

- `_parse_dimensions`：试卷平面/嵌套布局、教材、段数不足；
- `_match_filters`：不传参数全通过；`--subject` 精确；`--stage` 中英文别名；`--term` 中英文别名；
  `--year` 只命中试卷（教材无年份维度）；多条件交集；多值并集（`--year 2024,2025` 命中、
  `--year 2024,2026` 不命中、带空白的 `"物理, 数学"`、跨中英文别名的 `"下册,first"`）；
- main 级：`--year 2025` + `--term 下` 的组合筛出正确子集；
  `--materials` 条目存在但被 `--source` 排除时不再误报 WARN；带过滤条件零命中时打印 `过滤条件未命中任何素材`。

## 影响范围

- `tools/data-refinery/src/convert_cli.py` + `tests/test_convert_cli.py`；
- 文档：`tools/data-refinery/README.md` §1、`docs/data-refinery-使用手册.md` §4.1；
- 不涉及 scanner / convert / checkpoint，也不涉及下游 extract / publish / db_loader
  （下游要按维度筛选时，各自的 `--book` / `--pages` / `--file` 仍是既有入口）。
