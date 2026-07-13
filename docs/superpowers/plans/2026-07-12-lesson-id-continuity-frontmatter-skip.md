# lesson_id 跨页延续 + 前置内容跳过

## 背景与问题
- `cards.lesson_id` 当前由 LLM 每页独立输出。续页（无小节标题）返回 `null`，导致**跨页断裂**：一节的内容散落在不同 lesson_id（有的 null）。
- 前置内容（封面/书名/主编编委/版权出版信息/前言导引/目录）被抽成无意义的 card（如 page_006 目录页被抽成 17 张 card）。
- 章前综述（章前图/章前语）需归为该章"第 0 节"。

## 方案：LLM 给标题标识，CLI 跨页继承

职责切分：LLM 负责"读标题"（擅长），CLI 负责"维护状态/继承"（确定性）。

### 1. 提示词改动（`src/prompts/textbook_cards.txt`）
- `lesson_id` 语义改为"标识"：
  - 卡片处于某小节/章标题之下（本页出现标题且本卡片在其后）→ 填**标题原文**（如 `26.1 反比例函数`、`第二十六章 反比例函数`）。
  - 卡片是上一节内容的跨页延续（本页无新标题，或本卡片在本页第一个新标题之前）→ 填 `null`（由 CLI 沿用上一页）。
- **章前综述**：lesson_id 填该章标题（如 `第二十六章 反比例函数`），`card_type` 用 `reading`。即该章的"第 0 节"。
- **前置内容跳过**：整页是封面/书名页/主编编委/版权出版信息/前言导引/目录（含续页，特征是条目带页码）→ 输出 `{"items": []}`，不生成任何卡片。
- 按页面**阅读顺序**输出卡片（`sort_order` 递增），保证继承逻辑正确。
- 保留：严格 JSON、反斜杠转义、`card_type` 枚举、`textbook_page`、`knowledge_point_ids` 等既有规则。

### 2. CLI 改动（`src/extract_cli.py`）
- 新增 per-book running lesson 状态：`book_state: dict[str, str|None]`（key = `str(source.rel_path)`，即书目录）。
- 处理 `kind == "cards"` 的结果时，按卡片顺序后处理 `lesson_id`：
  - 非 null → `current = item.lesson_id`
  - null → `item.lesson_id = current`
  - 页末把 `current` 写回 `book_state[book_dir]`。
- 跨页延续：依赖 scanner 的全局排序（同一书的 `page_XXX.md` 连续且按名有序），`book_state` 在同书各页间自然延续。
- **断点续传状态回填**：跳过的页（已 checkpoint）从其 jsonl 末条读取 `lesson_id`，回填 `book_state`，保证续跑时状态正确（否则续页会丢上下文）。
- **前置跳过**：`result.items` 为空时不写 jsonl，日志 `[ok] (i/n) <file> -> 0 items (front matter skipped)`，仍 `checkpoint.mark_extracted`。
- `questions` 不受影响（不参与 lesson_id 逻辑）。
- `--file` 单页时不携带跨页状态（被抽页的续页 card 的 lesson_id 可能为 null）——README/文档注明此限制。

### 3. 模型 / Extractor
- **不改**。`TextbookCard.lesson_id` 仍为 `str | None`；LLM 输出标题或 null，CLI 后处理继承。`Extractor.run()` 不变。

### 4. lesson_id 取值
- 保持**标题原文**（`26.1 反比例函数`、`第二十六章 反比例函数`），内含节号 + 标题。
- 章综述用章标题，db_loader 据此识别为该章"第 0 节"。
- 不在 CLI 做编码归一化（如 `1-1`/`N.0`）——节号/章号/标题都内含在标题原文里，db_loader（后置）可解析：章号→`unit`、节号→`lessons.sort_order`、标题→`lessons.name`。

### 5. 测试（`tests/test_extract_cli.py`）
- 跨页继承：mock 两页，第二页 lesson_id=null，验证继承第一页的值。
- 一页多节：mock 一页含两个不同 lesson_id + 中间 null，验证继承顺序正确。
- 前置跳过：mock 返回空 items，验证不写 jsonl、记 checkpoint、日志正确。
- 断点续传回填：mock 一页已 checkpoint 且有 jsonl，验证后续页继承其 lesson_id。
- 更新受影响的现有测试。

### 6. 文档
- `README.md` + `docs/文档转换设计.md`：说明 lesson_id 新语义（LLM 给标识 + CLI 跨页继承）、前置内容跳过、`--file` 单页不携带状态的限制。

## 不在本次范围
- `db_loader`（lessons/units 表 seed、lesson_id 标签 → `lessons.id` 映射）仍后置。
- lesson_id 规范化为纯编码（`N.M`）——目前用标题原文，足够后续 seed。

## 验证
- 在九年级下册整本书上重抽（`--source smartedu` 或按书过滤），检查：
  - 前置页（page_001-006 左右）不产出 card；
  - 章综述页 lesson_id = 章标题；
  - 续页 card 的 lesson_id 继承上一页（非 null）；
  - 一页跨两节时两节 card 各自 lesson_id 正确。
- 全部测试通过。
