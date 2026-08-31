# convert_cli 素材列表过滤（--materials / --materials-file）设计

日期：2026-08-31
状态：已确认（用户口头批准设计）

## 背景

爬虫按教材下载素材后，convert 阶段默认全量扫描 `tools/crawler/data`，靠 checkpoint 跳过已转换素材。当用户只想转换特定几本书时（如刚下载的 2024 新版九年级上册），无法在命令行指定；且 crawl 与 convert 分属两个工具，批量转换多本书时需要显式的书目列表。

## 需求

给 `convert_cli.py` 增加指定书目的能力：

1. 支持命令行内联列表（逗号分隔），转一两本时免建文件；
2. 支持列表文件（一行一本，支持 `#` 注释与空行），批量转换时使用；
3. 每个条目作为子串与素材 `rel_path` 匹配，一个条目命中多本时全部转换；
4. 条目命中 0 本时给出警告（防拼写错误静默无操作）；
5. 不传新参数时行为与现状完全一致（无破坏）。

## 设计

### 参数

```
--materials "子串1,子串2"        # 逗号分隔的匹配子串
--materials-file books.txt       # 列表文件，一行一条，# 开头为注释，空行忽略
```

两者可同时使用，条目取并集。条目去除首尾空白后为空则忽略。

### 匹配规则

- 在现有 `_match_source(material, source)` 过滤之后，追加 `_match_materials(material, entries)`：素材 `rel_path` 字符串包含任一条目即命中；
- 未传任何条目 -> 不过滤（全量，与现状一致）；
- 全部素材处理完后，统计每个条目的命中次数，命中 0 次的条目打印 `[WARN] 未命中素材: <条目>`。

### 与现有参数的交互

- `--dry-run`：打印的素材列表已含列表过滤结果（顺带可见命中情况）；
- checkpoint / `--force` / `--reconvert` / `--source` 逻辑一概不动：列表内已转换的书照样 skip；
- 不采用「`--input-dir` 直接指向书目录」方案：会改变 rel_path 根，破坏 md 输出目录结构及下游 publish 的 subject 路径推导。

### 用法示例

```bash
python src/convert_cli.py --source smartedu \
  --materials "（根据2022年版课程标准修订）义务教育教科书·数学九年级上册" --dry-run

# 批量：books.txt 每行一本
python src/convert_cli.py --source smartedu --materials-file books.txt
```

## 测试（tests/test_convert_cli.py）

- 单条内联命中：只处理命中素材，未命中素材不处理；
- 多条目（内联 + 文件并集）：多个条目各自命中；
- 条目命中 0 本：打印 WARN，且不误伤正常流程（退出码仍为 0）；
- 不传参数：行为与现状一致（全量）。

## 影响范围

仅 `tools/data-refinery/src/convert_cli.py` 与其测试；不涉及 scanner、convert、checkpoint、下游 extract/publish/db_loader。
