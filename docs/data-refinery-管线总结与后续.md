# Data Refinery 管线总结与后续

> 进展截止：2026-07-13。本文是 data-refinery 数据管线的现状总结与后续工作指引，供后续开发参考。

## 1. 管线概览

四阶段顺序管线 + 一个编排入口，全部在 `tools/data-refinery/`：

```
convert_cli  ->  extract_cli  ->  publish_cli  ->  db_loader_cli
   (MinerU)      (LLM 提取)       (物化图片)      (入库 MySQL)
                                                   ^
                              refinery_cli 串联 publish + db_loader
```

| 阶段 | 程序 | 输入 | 输出 | 状态 |
|---|---|---|---|---|
| 1 convert | `src/convert_cli.py` | 爬虫素材（PDF/图片书，`tools/crawler/data`） | `output/md/*.md` + `images/` | ✅ 跑通（2340 文件） |
| 2 extract | `src/extract_cli.py` | `output/md/*.md` | `output/extracted/<stem>.jsonl` | ✅ 跑通（25 文件） |
| 3 publish | `src/publish_cli.py` | `output/extracted/*.jsonl` | `output/published/<stem>.jsonl` + `output/assets/` | ✅ 跑通（25 + 211 assets） |
| 4 db_loader | `src/db_loader_cli.py` | `output/published/*.jsonl` | MySQL `ai_k12` | ✅ 跑通（34 cards + 466 questions） |
| 编排 | `src/refinery_cli.py` | - | 串联 publish -> db_loader | ✅ |

DB 一次性初始化：`tools/db/install_mysql.sh`（建库 + ai_k12 用户 + schema + subjects seed）。

## 2. 当前数据现状

- `output/md/`：2340 文件（convert 产物）。
- `output/extracted/`：25 jsonl = 9 下册 card 页 + 16 试卷/答案。
- `output/published/`：25 jsonl；`output/assets/`：211 图片。
- MySQL `ai_k12`：subjects 9 行（seed）、cards 34、questions 466、textbook_versions 1（math_人教版_junior）、semesters 1（九年级下册）、units 1（第二十六章）、lessons 3（章综述 + 26.1.1 + 26.1.2）。
- 0 个未映射 lesson_id（所有 card 都映射到 lessons.id）。

## 3. 关键实现决策（gotchas，改代码前必读）

### LLM 配置
- 走 **DeepSeek**（Anthropic 兼容端点 `https://api.deepseek.com/anthropic`，模型 `deepseek-v4-flash`，reasoner，需 `LLM_MAX_TOKENS=65536`）。
- `.env` 用 **`LLM_BASE_URL` / `LLM_AUTH_TOKEN`**（refinery 专属），**不要用 `ANTHROPIC_*`**--shell 里 Claude Code 的 `ANTHROPIC_*` 会通过 `load_dotenv(override=False)` 覆盖 refinery 的配置。`config.py` 已优先读 `LLM_*`。
- `llm.py` 支持 `openai` / `anthropic` 两种 provider（`LLM_PROVIDER`）。

### extract（教材 card）
- **lesson_id 跨页继承**：LLM 每张 card 输出小节/章标题原文（标识），续页/续卡片填 `null`；CLI 维护 per-book running 状态继承 null（`extract_cli.py` 的 `book_lesson`）。**只有编号标题**（`N.M`/`N.M.K`/`第N章`）开新课；练习/习题/侧栏标题填 null 继承。章综述归该章"第 0 节"（lesson sort_order=0）。
- **前置内容不抽取**：封面/书名/编委/版权/前言/目录（条目带页码）输出 `{items:[]}`，CLI 不写 jsonl 但记 checkpoint。
- **全角括号统一半角**（2026-09-01）：extract_cli 读页 md 后（`scan_page` 之后、`split_page` 之前）做 `normalize_fullwidth_parens`——全角 `（）`→半角 `()`（OCR 原文同页混用 `（1）`/`(1)` 导致题号括号展示不一致）。1:1 字符替换不改长度（图片 `position_in_text` 偏移仍有效）；NFKC 对两者等价（`content_hash` 去重不受影响）。**其余全角标点（。，；！？）不动**：`。` U+3002 无 NFKC 映射会改变 content_hash；`。！？；` 是 card_splitter 的句末切分点，归一半角会破坏长段落切分。
- **断点续传**：跳过的页从其 jsonl 末条 lesson_id 回填 `book_lesson`（`_last_lesson_id`）。
- `--file` 单页不携带跨页状态（续页 card 的 lesson_id 可能为 null）。

### extract（试卷 question）
- **答案只提取不生成**：从原文"参考答案"按题号提取（选择题填字母、填空填值、解答题填解题过程）；原文无答案填 `""`。**绝不自行推断/计算**（模型答案不可靠，系统另有获取答案机制）。
- **按题号切分**：同一题号的 (1)(2)(3) 小问合并为一个 item，不拆分。
- **JSON 兼容**：`extract.py` 的 `_parse_json_object` 去除 ```` ```json ```` 代码块 + 修复 LaTeX 反斜杠漏转义（`\_`/`\%` 等非法转义补双反斜杠），保留合法 `\n`/`\t`/`\uXXXX`。
- 跳过 `content` 为 null/空的 item（纯图片片段偶发 null，避免整页失败）。

### publish
- 物化图片到 `output/assets/`，路径改写为源相对稳定键（`questions/{subject}/{hash}/{idx}`、`textbooks/{subject}/{hash}/{sort_order}`），填 `content_metadata.images[]` / `options[].image_url`。
- ⚠️ **遗留 bug**：`SUBJECT_CODE="math"` 硬编码（`publish_cli.py:23,107,110`），化学题资产路径会被误标 `math`。DB 的 subject_id 仍正确（来自 jsonl）。

### db_loader
- **subject 归一**：`SUBJECT_ALIASES`（`chem`->`chemistry` 等）-> canonical code -> subjects.id。cards 按 rel_path 学科名查、questions 按 jsonl subject_id 查。
- **rel_path 解析**（cards）：`学科/学段/版本/年级/学期/书名` -> textbook_versions + semesters（find-or-create，幂等）。
- **版次（edition）维度**（2026-08-31 加）：textbook_versions 按 `(subject_id, publisher, grade_band, edition)` 4 元组唯一；edition 从**书名前导括号**提取（`edition_from_book_name`，如「（根据2022年版课程标准修订）义务教育教科书·数学九年级上册」->「根据2022年版课程标准修订」，无标记 = 旧版 2012 课标）。同一出版社不同课标版次是各自独立的 textbook_version/semesters/cards，互不覆盖；九上/九下书名不同但前导括号相同 -> 归同一版次。存量 2012 行 edition='' 与旧书名推导兼容，无需迁移数据（仅 DDL 迁移 `2026-08-31_add_textbook_versions_edition.sql`）。
- **lesson_id 解析**：`第N章 X`（中文数字转 int）-> unit + 章综述 lesson；`N.M[.K] X` -> unit + 节 lesson。find-or-create。
- **页码锚定 lesson_anchor**（2026-09-02 加）：TOC 模式挂卡前 `load_book_cards` 用 `LessonAnchor` 确定性修正章归属——章边界首选综述卡锚定（每章「第N章」标签卡最小 md 页 = 章头页，零偏移误差、取 min 免疫错章综述标签；兜底首节 printed + 偏移众数 − 3 余量）；规则 A 错章重写（content「复习题 N」> 时间线活跃节 > 标题匹配 > 章综述兜底）/ B 同名消歧（「小结」「数学活动」按页所在章，修各章同名 lesson 全挂第一个的 bug）/ C 复习题归一（「复习题 N」挂该章「小结」，不建 TOC 外 lesson）。无 TOC/对不上整体退化纯标签匹配。extract/publish/jsonl 不动；锚定每次 load 重算，重处理任意页不影响结构。观测日志 `[anchor] offset/corrected/disambiguated/normalized`。
- **cards sort_order 跨页全局重排**：每 lesson 内 1..N（抽取的页内序会碰撞 `uniq_cards_lesson_sort`）。
- **full-reload 幂等**：`reset_cards()` 删 `textbook_versions`（级联清 cards/lessons/units/semesters）+ `reset_questions()` 删 questions，再重插。结构 find-or-create。每次跑都全量重载（无增量）。
- **full-reload 守卫**：`business_data_summary` 额外把 `questions.answer_verified=1`（answer_importer 写入的人工/AI 核验内容）计入 blocking——未加 `--purge-business-data` 时 full-reload 会中止而非静默丢弃；确认要丢弃再显式 purge。

### DB
- `ai_k12` 库，业务用户 `ai_k12/ai_k12`（`.env` 的 `DB_*`）。
- `schema.sql` 末尾 `INSERT IGNORE` seed subjects（9 个 K12 学科），由 `install_mysql.sh` 加载。详见数据库设计文档 §3.12。
- ⚠️ `install_mysql.sh` 的 `CREATE USER IF NOT EXISTS` 不重置密码（重跑脚本时 ai_k12 密码不会更新，需手动 ALTER）。

### 辅轨答疑与 data-refinery 的关系（PRD §6.2/§7.10）
- **data-refinery 逻辑不变**：convert+extract 继续做离线教材/试卷管线，不参与辅轨答疑。
- **辅轨图片转换**：apps/server（Node.js）直接 `child_process.spawn('mineru-open-api', ['extract', img, '-o', outDir])` 调 MinerU CLI（`convert.py:12` 的 `MineruRunner` 即此 CLI 的 Python subprocess 封装），拿到 md 文档+图片后交 ai-core 在线 LLM 结构化。不经 Python data-refinery，无需在 apps/server 部署 Python 运行时。
- **题目结构化**：辅轨答疑的 题干/题型/知识点/难度/答案+解析 由 ai-core 调 LLM 在线完成（新 prompt，**不用 data-refinery 的 extract**--extract prompt 要求"答案只提取不生成"，辅轨题无答案需 LLM 生成）。
- **题目入库去重（content_hash）**：
  - `schema.sql` questions 表新增 `content_hash CHAR(64)` + `uniq_q_content_hash` 唯一索引。
  - `db_loader.load_questions` 改造：插入前算 `content_hash`（`normalize_content` NFKC 归一 + 去空白 + 转小写 -> SHA-256），`SELECT id FROM questions WHERE content_hash=%s` 命中则跳过复用，未命中则插入含 hash。辅轨答疑入库走同一去重逻辑。
  - **回填现有 466 题**：因 full-reload 先 DELETE 再全插，重建 DB 后重跑 `refinery_cli` 即可给所有题写入 content_hash，无需单独回填脚本。
  - hash 精确匹配为主，未命中时辅以限制范围（同学科+题型）文本相似度兜底（辅轨入库侧实现）。

## 4. 如何运行

```bash
cd tools/data-refinery

# 一次性：初始化 DB（建库+用户+schema+seed）
./../db/install_mysql.sh -r <root_pass> -t 9.5.0 -p ai_k12

# 前段（单独跑）
python src/convert_cli.py --source all          # 素材 -> md
python src/extract_cli.py --source all          # md -> extracted
python src/extract_cli.py --file "2024/...西城-模拟二-试卷"  # 单文件

# 后段（一键）
python src/refinery_cli.py --source all         # publish + db_loader
python src/refinery_cli.py --source all --dry-run
python src/refinery_cli.py --skip-publish       # 只 db_loader
python src/refinery_cli.py --skip-load          # 只 publish

# 测试
pytest tests/ -q                                # 105 passed
```

## 5. 测试

`tools/data-refinery/tests/`，105 个测试全绿：
- 单元：extract 解析/escape 修复、db_loader 纯函数（subject 归一、rel_path 解析、中文数字、lesson_id 解析、sort_order 重排）、CLI dry-run/过滤。
- 集成：db_loader 连真实 ai_k12 库（find-or-create、入库、幂等），每个测试前后清派生表。

## 6. 已知遗留（按优先级）

1. **`publish_cli` SUBJECT_CODE 硬编码**（化学资产路径误标）--小修。
2. **`install_mysql.sh` CREATE USER 不重置密码**--小修（改 `CREATE OR REPLACE USER`）。
3. **题目数据质量**：466 题里多数是 gemma 旧提示词抽的（答案有捏造、解答题被拆分），需用新提示词 + deepseek 重抽，再 `refinery_cli` 重跑（full-reload 幂等）。
4. **教材 card 覆盖不全**：只有下册 16 页（34 cards），整本下册 50 页 + 上册 + 其它学科教材未抽。
5. **增量加载**：db_loader 用 full-reload，无 checkpoint 增量。
6. **资产静态服务**：开发期用 `python -m http.server` 临时方案，生产需 CDN/OSS（`ASSET_BASE_URL`）。
7. **`questions.content` 字面 `\n` 双转义未还原**（2026-09-04 发现）--LLM 输出 JSON 时把换行写成 `\\n`（双反斜杠+n），`json.loads` 解析后变成**字面 `\n` 两字符**（0x5C 0x6E，反斜杠+n），而非真换行 0x0A。`extract.py:_repair_json_escapes` 把 `\\` 当合法 JSON 转义跳过，没修正，字面 `\n` 一路进 DB。`react-markdown` 不认字面 `\n`（CommonMark 反斜杠转义只对 ASCII 标点生效），原样显示成可见文本。**MVP 阶段前端兼容处理**：`QuestionRunner`/`ChoiceOptionList` 的 `preprocessMarkdown` 把 `\n`（后非字母）还原成真换行，避开 LaTeX 命令（`\ne` `\newline` `\nonumber` `\nabla` `\neg` `\nu` 等）。将来在管线层统一修复（`_repair_json_escapes` 增加 `\\n` → `\n` 的规范化，或 LLM 提示词强调换行用真 0x0A），改完撤掉前端的 `preprocessMarkdown` 兼容层。
8. **题目内容缺口**：`answer_importer`（2026-09-10）已建成，可按单题/批量/按卷/按缺口回写 `answer`/`approach`（新增解题思路列）/`explanation`/`type`。存量约 188 道空答案、451 道无解析待按卷（或按 `--where ..._empty` 导出模板）补全；用法见 `docs/data-refinery-使用手册.md` §4.8，设计见 `docs/superpowers/specs/2026-09-10-question-content-importer-design.md`。

## 7. 下一步（最大缺口）

**后端 API（`apps/server`）**--当前系统还没真正可用：前端 `apps/web` 已存在，但**没有后端可连**（`apps/server` 未建）。API 已设计好（`docs/api/openapi.yaml` + `docs/API接口与数据流设计文档.md`），就等实现。做了它前端才能查 cards/questions、学习进度等，系统才闭环。

建议顺序：先做两个小修（1、2），再进入后端 API；数据重抽（3、4）可后台并行。
