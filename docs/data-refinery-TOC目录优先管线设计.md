# TOC 目录优先管线设计

**日期**：2026-07-30
**状态**：spec（待实现计划）
**关联文档**：`docs/data-refinery-管线总结与后续.md`、`docs/K12智学系统-数据库设计文档.md`

## 1. 问题

当前 `extract_cli` 的 lesson_id 完全依赖 LLM 从正文页提取，存在两个问题：

1. **目录页被浪费**：教材目录页（如 page_005/006 MD）包含完整的章→节→子节层级，但被 LLM 标记为 `front_matter` 后跳过。
2. **章节结构不完整**：如果只转了前 20 页（仅覆盖第 26 章），DB 中只有第 26 章的 units/lessons。前端无法展示完整教学大纲。

## 2. 目标

- **TOC 为骨架**：用教材目录页建 DB 结构，一次跑全量创建整本书的章节目录。
- **Card 为血肉**：extract 产的 card 按 lesson_id 挂到已有骨架，支持分批增量入库。
- **校验兜底**：TOC 与 card 的 lesson_id 交叉验证，差异自动修正+报告。

## 3. 核心流程

```
convert_cli: PDF → MD pages
    ├─→ toc_parse_cli [新增]: 目录页 MD → TOC JSON (完整层级树)
    │       └─→ db_loader.load_toc_structure(): 全量建 units/lessons (骨架)
    │
    └─→ extract_cli: 正文页 MD → cards JSONL
            └─→ db_loader.load_book_cards(): cards 挂到已有 lesson (血肉)
                   ↑ 可选传入 TOC JSON 做 lesson_id 校验+修正
```

**关键模式**：骨架和血肉可先后独立运行，骨架建一次即可，card 可分多次增量入库。

## 4. 改动清单

### 4.1 新增 `toc_parse_cli.py`

**职责**：扫描 MD 目录，找目录页，LLM 解析为结构化 JSON。

```
输入：output/md/{subject}/{publisher}/{grade}/{term}/{book}/page_XXX.md（目录页）
输出：output/toc/{subject}/{publisher}/{grade}/{term}_{book}.json
```

**目录页识别**：前 10 页内，MD 内容包含 `目录` heading 的页。

**LLM 解析**：复用 `LLMClient` + 新增 `prompts/toc_parse.txt`。输入目录页 MD 原文，输出：

```json
{
  "book": "义务教育教科书·数学九年级下册",
  "chapters": [
    {
      "number": 26,
      "title": "反比例函数",
      "label": "第二十六章 反比例函数",
      "sections": [
        {
          "number": [26, 1],
          "title": "反比例函数",
          "label": "26.1 反比例函数",
          "printed_page": 2,
          "subsections": [
            {
              "number": [26, 1, 1],
              "title": "反比例函数",
              "label": "26.1.1 反比例函数",
              "printed_page": 2
            },
            {
              "number": [26, 1, 2],
              "title": "反比例函数的图象和性质",
              "label": "26.1.2 反比例函数的图象和性质",
              "printed_page": 4
            }
          ]
        }
      ]
    }
  ]
}
```

**非编号条目**：信息技术应用、阅读与思考、数学活动、小结、复习题 → `type: "supplement"`，保留在结构中（lesson sort_order 排在节之后）。

**CLI 参数**：

| 参数 | 说明 |
|---|---|
| `--input-dir` | MD 目录（默认 output/md） |
| `--output-dir` | TOC JSON 输出目录（默认 output/toc） |
| `--book` | 指定教材（路径子串匹配，如 "九年级/下册"） |
| `--reconvert` | 清除 checkpoint + 删除已有 TOC JSON，重新解析 |
| `--dry-run` | 只打印将要处理的目录页 |

**Checkpoint**：复用 `RefineryCheckpoint`，新增 `toc_parsed` 集合。`--reconvert` 清理 checkpoint + 删除已有 TOC JSON。

**LLM 容错**：
- JSON 解析失败：重试 1 次，仍失败则跳过该教材并报错。
- 层级不完整（有章无节）：警告但保留，后续 extract 阶段可能补全。
- 目录页识别失败（前 10 页无 `目录` heading）：扩展搜索到前 20 页，仍无则跳过。

### 4.2 新增 `prompts/toc_parse.txt`

LLM prompt 规则：

```
你是 K12 教材目录解析专家。从教材目录页 Markdown 中提取章→节→子节层级。

规则：
1. 只提取编号标题：第N章、N.M、N.M.K
2. 非编号内容（信息技术应用/阅读与思考/数学活动/小结/复习题）保留，type 标记为 "supplement"
3. 提取教材页码（标题后的数字），存为 printed_page
4. 输出严格 JSON，不使用 ```json``` 代码块
```

### 4.3 修改 `db_loader.py`

#### 新增 `load_toc_structure(toc_path)`

```python
def load_toc_structure(self, toc_path: str) -> dict:
    """用 TOC JSON 全量建教材骨架。

    Returns:
        dict: {chapters: int, lessons: int} 创建的章数和节数
    """
    # 1. 读 TOC JSON
    # 2. 解析 rel_path → subject, grade_band, publisher, grade, term
    # 3. find-or-create: textbook_version → semester
    # 4. 遍历 chapters:
    #    - find-or-create unit (章)
    #    - find-or-create lesson for 章综述 (sort_order=0, card_type=reading)
    #    - 遍历 sections:
    #      - find-or-create lesson for 节 (sort_order=1..N)
    #      - 遍历 subsections:
    #        - find-or-create lesson for 子节 (sort_order 按序递增)
    #    - 遍历 supplements (sort_order 排在所有节之后)
    # 5. 幂等：已存在的 unit/lesson 不重复创建
```

#### 修改 `load_book_cards()`

- 新增可选参数 `toc_path: str | None = None`
- 当 `toc_path` 有值时：
  - Card 的 lesson_id **不再负责建 lessons**（骨架已由 TOC 建好）
  - Card 按 `lesson_id` 名称匹配到已有 lesson
  - 匹配不到的 card → 警告，尝试 TOC 模糊匹配修正
- `toc_path` 为 None 时，完全保持现有行为

#### 新增 `_match_lesson_by_name(name)`

```python
def _match_lesson_by_name(self, name: str) -> int | None:
    """按 lesson name 查已有 lesson 的 DB id。"""
```

### 4.4 修改 `extract_cli.py`

新增 `--toc` 参数（可选）：

```
--toc PATH    TOC JSON 路径，用于：
              1. 注入合法 lesson_id 列表到 LLM prompt（提高标注准确率）
              2. 提取完成后校验 + 自动修正 lesson_id
              3. 输出 diff_report.json
```

**校验逻辑**（extract 完成后执行）：

```python
def validate_and_correct(cards, toc):
    """Levenshtein 编辑距离 ≤2 视为匹配，自动修正。"""
    diff_report = {"matched": [], "corrected": [], "unmatched": [], "missing_from_cards": []}
    toc_labels = toc.all_labels  # 扁平化的所有合法 lesson_id

    for card in cards:
        if card.lesson_id in toc_labels:
            diff_report["matched"].append(card.lesson_id)
            continue
        # 尝试模糊匹配（编辑距离 ≤2）
        best = min(toc_labels, key=lambda t: levenshtein(card.lesson_id, t))
        if levenshtein(card.lesson_id, best) <= 2:
            old = card.lesson_id
            card.lesson_id = best
            diff_report["corrected"].append({"original": old, "corrected": best})
        else:
            diff_report["unmatched"].append(card.lesson_id)

    # 反向检查：TOC 中有但 card 中没有的 lesson_id
    card_labels = {c.lesson_id for c in cards}
    diff_report["missing_from_cards"] = [l for l in toc_labels if l not in card_labels]
```

`diff_report.json` 输出到 extracted 目录同级，格式：
```json
{
  "book": "义务教育教科书·数学九年级下册",
  "matched": 12,
  "corrected": [{"original": "26.1.3 反比利函数", "corrected": "26.1.2 反比例函数的图象和性质"}],
  "unmatched": [],
  "missing_from_cards": ["27.1 图形的相似", "27.2 相似三角形"],
  "summary": "12 matched, 1 auto-corrected, 0 unmatched, 16 missing (not yet extracted)"
}
```

### 4.5 修改 `checkpoint.py`

新增 `_toc_parsed` 集合，及对应 getter/setter/unmark 方法。

### 4.6 修改 `db_loader_cli.py`

新增参数：

| 参数 | 说明 |
|---|---|
| `--load-toc` | 只跑 `load_toc_structure()`，不入库 card |
| `--load-cards` | 只跑 card 入库（含 questions），不建骨架 |
| `--toc-path PATH` | TOC JSON 路径（`--load-cards` 时可选传入做校验） |

不传任何 `--load-*` flag 时，行为与当前完全一致（card 动态建骨架）。默认保持此向后兼容行为。

## 5. 数据流

```
第1次运行（只转了第26章前几页）：

toc_parse: page_005/006.md → 九年级下册_toc.json
    ↓
db_loader --load-toc:
    units:  第26章, 第27章, 第28章, 第29章
    lessons: 26.1, 26.1.1, 26.1.2, 26.2, 27.1, 27.2, 27.3, ...
    cards:   (空，等 extract)
    ↓
extract → cards JSONL (page_008~016 only)
    ↓
db_loader --load-cards:
    cards 挂到 26.1.1, 26.1.2 等 lesson 下
    27章~29章的 lessons 有骨架但无 card（前端可展示为"内容准备中"）

第2次运行（转完了第27章）：

extract → cards JSONL (page_030~060)
    ↓
db_loader --load-cards:
    新的 27章 cards 挂入已有 27章 lessons
    旧的 26章 cards 覆盖（幂等）
```

## 6. 使用示例

```bash
# ==== 首次：建完整骨架 ====
# 1. 转教材全部 MD（已有）
python src/convert_cli.py --source smartedu

# 2. 解析目录 → TOC JSON
python src/toc_parse_cli.py

# 3. 建骨架
python src/db_loader_cli.py --load-toc

# ==== 日常：增量产 card ====
# 4. 提取卡片（可指定页、可 reconvert）
python src/extract_cli.py --toc output/toc/math/人教版/九年级下册.json --pages "8-16"

# 5. card 入库
python src/db_loader_cli.py --load-cards
```

## 7. 向后兼容

- 不传 `--toc` 时，extract_cli 和 db_loader 行为与当前完全一致
- 不执行 `toc_parse` + `--load-toc` 时，骨架由 extract 的 lesson_id 动态建（现有逻辑）

## 8. 验证方式

1. 对九年级下册跑 `toc_parse_cli`，验证 TOC JSON 层级正确
2. `db_loader --load-toc` 后查 DB：units 有 4 章（26-29），lessons 覆盖全部节+子节
3. 只 extract 前 20 页 card，入库后查 cards 表：26 章 card 完整，27-29 章 lessons 存在但无 card
4. 用 `--reconvert --pages "5-6"` 测试 TOC 的 checkpoint 清理+重解析

## 9. 注意事项

- **教材目录页位置**：不同教材目录页位置可能不同（不总是第 5-6 页）。用"前 10 页内含 `目录` heading"来识别，不完全可靠时降级为 LLM 扫描所有页判断。
- **目录与正文标题不一致**：极少情况目录写的"A"正文写的"B"——diff report 记录，需人工决策。
- **非编号条目排序**：supplement（信息技术应用/阅读与思考等）排在章节最后，sort_order 紧随最后一节。
