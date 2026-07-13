# db_loader 设计与 TDD 实现

## 范围
加载 `output/published/<stem>.jsonl`（publish 产物，资产路径已改写）到 MySQL `ai_k12`。派生教材结构（textbook_versions/semesters/units/lessons），入库 cards/questions。不改写资产路径（publish 负责）。

## 输入与 kind 检测
- 输入目录默认 `output/published/`。
- kind：文件名含 `试卷`/`答案` -> questions；否则 -> cards（复用 `_match_source` 逻辑）。

## DB 配置
- `requirements.txt` 加 `pymysql`。
- `.env` 加：`DB_HOST=localhost DB_PORT=3306 DB_USER=ai_k12 DB_PASS=ai_k12 DB_NAME=ai_k12`。
- `config.py` 加 `db_host/db_port/db_user/db_pass/db_name` 字段。

## 核心模块：`src/db_loader.py` + `src/db_loader_cli.py`

### 1. subject 映射
- 别名表 `SUBJECT_ALIASES = {'math':'math','chem':'chemistry','chemistry':'chemistry', ...}` -> canonical code -> 查 `subjects` 拿 id。
- questions：用 jsonl 的 `subject_id`（别名归一）。
- cards：用 rel_path 第 1 段（`数学`/`化学`/...，按 `subjects.name` 查 id）。

### 2. textbook_version 映射（cards，解析 rel_path）★step 3
rel_path 形如 `数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册/page_008.jsonl`，6 段：
- 段1 学科名、段2 学段、段3 版本(出版社)、段4 年级、段5 学期、段6 书名。
- 固定映射表：
  - 学科：`数学->math, 化学->chemistry, 物理->physics, ...`（按 `subjects.name`）
  - 学段：`小学->primary, 初中->junior, 高中->senior`
  - 年级：`九年级->grade_9, 八年级->grade_8, ...`
  - 学期：`上册->first, 下册->second`
- find-or-create `textbook_versions`（by `code=f"{subject_code}_{publisher}_{grade_band}"`，如 `math_人教版_junior`）：subject_id、name=版本(人教版)、grade_band、publisher。
- find-or-create `semesters`（by textbook_version_id+grade+term）：name=`{年级}{学期}`（如 `九年级下册`）。

### 3. lesson_id 解析（cards）
- 规则1 `^第([一二三四五六七八九十百]+)章\s+(.+)$` -> 章号（中文数字转 int）、标题。=> unit（章）+ 章综述 lesson（sort_order=0）。
- 规则2 `^(\d+)\.(\d+)(?:\.(\d+))?\s+(.+)$` -> 章.节[.子]、标题。=> unit（章=第1组）+ lesson（节）。
- 中文数字解析（`二十六->26`、`三十->30`、`一百->100`）。
- find-or-create `units`（by semester_id + 章号作 sort_order）：name=章标题。
- find-or-create `lessons`（by unit_id + name=标签原文）：sort_order=章综述 0 / 节按全书出现序 1,2,3...。

### 4. 入库
- **cards**：全局重排 `sort_order`（每个 lesson 内跨页 1,2,3...，保证 `uniq_cards_lesson_sort` 不冲突）；`lesson_id` 标签 -> `lessons.id`；INSERT。
- **questions**：`subject_id` -> `subjects.id`；options 序列化为 JSON 字符串（`options` 列是 TEXT）；INSERT。
- **幂等**：full-reload。每次跑：DELETE 全部 cards/questions（结构 textbook_versions/semesters/units/lessons 是 find-or-create，不删），再重插。重跑结果一致。`--dry-run` 预览不改库。

### 5. CLI
`db_loader_cli.py --input-dir（默认 output/published） --source {all,zgao,smartedu} --dry-run`。
- 复用 `RefineryCheckpoint`（`.db_checkpoint.json`）记录已加载文件（可选，增量留待后续）。
- 日志：每文件 `[ok] <file> -> N cards/questions`，flush。

## TDD（先红后绿）

### 单元测试（无 DB，`tests/test_db_loader.py`）
- `normalize_subject('chem') == 'chemistry'`；`'math'=='math'`。
- `parse_book_rel_path('数学/初中/人教版/九年级/下册/书名/page.md')` -> `{subject:'数学', grade_band:'初中', publisher:'人教版', grade:'九年级', term:'下册', book:'书名'}`。
- `chinese_to_int('二十六')==26`、`'三十'==30`、`'一百零一'==101`。
- `parse_lesson_id('第二十六章 反比例函数')` -> `{chapter:26, title:'反比例函数', is_overview:True}`。
- `parse_lesson_id('26.1.1 反比例函数')` -> `{chapter:26, section:(1,1), title:'反比例函数', is_overview:False}`。
- `renumber_sort_order(cards_in_lesson)` -> 跨页 1..N 连续。

### 集成测试（真实 `ai_k12` 库）
- find-or-create textbook_version/semester/unit/lesson：重跑不重复、id 稳定。
- 加载 9 张下册 card：lesson_id 正确映射、sort_order 全局连续、章综述归 lesson sort_order=0。
- 加载西城 2024 questions：subject_id->math、26 行入库。
- 幂等：连跑两次，cards/questions 行数一致、不重复。

## 文档同步
- `README.md`：加 db_loader 用法。
- `docs/文档转换设计.md` + `docs/data-refinery-文档对齐总结.md`：db_loader 实现（subject 映射、rel_path 解析、lesson_id 解析、full-reload 幂等）。
- `docs/K12智学系统-数据库设计文档.md`：§3.12 补一句派生数据由 db_loader 入库（已写）。

## 不在本次范围
- 增量加载（checkpoint-based）——MVP 用 full-reload。
- 资产路径改写——publish 负责，db_loader 只读 published 的已改写路径。
- 上册 32 张 stale card 的数据质量（旧 gemma 提示词）——单独处理；本次 db_loader 只加载 published 里有的。
- `publish_cli` 的 `SUBJECT_CODE="math"` 硬编码（化学题资产路径会被误标 math）——publish 侧问题，另开。

## 验收
- 单元 + 集成测试全绿。
- 端到端：publish（extracted->published+assets）-> db_loader（published->MySQL）-> `SELECT COUNT(*) FROM cards/questions` 对得上；cards 的 lesson_id 都解析到 lessons.id，无 null。
