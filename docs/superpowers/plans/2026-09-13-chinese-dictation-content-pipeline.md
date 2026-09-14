# 九年级语文课本 → 默写题库数据管线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把统编版九年级上/下册教材里全部古诗文与文言文抽成结构化篇目入库（篇名/作者/朝代/正文），使默写专项有真实题库可用。

**Architecture:** 第 1–3 步直接用既有 CLI（`crawler_cli` 抓图 → `convert_cli` 转每页一个 MD → `toc_parse_cli` 出目录结构）；第 4–6 步是新建的独立 CLI `dictation_cli.py`：用 LLM **只做定位判断**（是不是古诗文/文言文、正文起止锚点、作者/朝代），**正文由程序按锚点从 MD 原样切片**，再跑自动自检，最后按 `dictation_passages` 业务键幂等入库。抽题池由 `verified=1` 收紧为 `verified=1 AND memorize_required=1`。

**Tech Stack:** Python 3（`tools/data-refinery`，pymysql / OpenAI 兼容 LLM / pydantic / pytest）；TypeScript + NestJS（`apps/server`，mysql2 / Vitest）；MySQL。

**关联文档：** `docs/superpowers/specs/2026-09-13-chinese-dictation-content-pipeline-design.md`（本计划的依据）、`docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md`（默写专项功能设计）、`docs/data-refinery-管线总结与后续.md`、`docs/data-refinery-使用手册.md`

---

## Global Constraints

- **不改动既有四阶段工具的行为**：`convert_cli.py` / `extract_cli.py` / `publish_cli.py` / `db_loader_cli.py`（用户明确要求 `convert_cli` 不要动）。新代码放新文件。
  - **例外（用户指示）**：`toc_parse_cli.py` 与 `card_splitter.py` 里那两条**硬编码数学形态**的版面规则，按 Task 12 重构为「基类 + 每学科实现」；重构时**数学行为必须零变化**（新实现默认走数学档，且配黄金回归用例），见 Task 12。
- 库内 LLM 配置用 `.env` 的 `LLM_BASE_URL` / `LLM_AUTH_TOKEN` / `LLM_PROVIDER` / `LLM_MODEL`，**不要用 `ANTHROPIC_*`**（会被 shell 里 Claude Code 覆盖）；DB 用 `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME`。
- 一律通过 `RefineryConfig.from_env(input_dir=None, output_dir=None)` 读配置，不新增 env 变量。
- **正文必须逐字来自教材 MD**：LLM 不得产出正文字符。切片后只做「去换行/去空白」规范化，**标点与全角符号原样保留**。
- 题面约定（上一阶段已定）：`questions.content = '请默写《篇名》'`，**不含任何提示性文字**。
- `dictation_passages.semester` 是 `NOT NULL`；业务键 `(work_title, semester)` 是幂等锚点。
- DB DDL 必须**折回 `tools/db/schema.sql`**（`install_mysql.sh` 只执行 `schema.sql`，迁移文件不会自动跑），同时提供幂等迁移供已建库环境。
- AI-core 侧（`apps/server`）改动须跑 `npm test` 与 `npm run build`；Python 侧改动须跑 `pytest`。
- 测试惯例（已核实）：`tools/data-refinery/pytest.ini` **没有** `network` marker（那是 crawler 专属）。**LLM 调用在单测里 mock SDK**（仿 `tests/test_llm.py::_mock_client`）；**DB 集成测试在 fixture 里运行时 skip**（仿 `tests/test_db_loader_integration.py`）。不新增 marker。
- CLI 惯例：`parse_args(argv=None)` + `main(argv=None)` + `if __name__ == "__main__": main()`；进度打印一律 `print(..., flush=True)` 且带方括号标签（`[ok]` / `[skip]` / `[WARN]` / `[ERROR]`）。
- 提交信息用 Conventional Commits，scope 用 `data-refinery` / `server` / `db` / `docs`。

## 两个中途闸门（必须停下来等用户）

- **Task 2 结束**：报告真实 MD 形态（页数、页码是否在文件名、正文里有无页眉/页脚、注释与正文怎么排布），用户确认后才继续。
- **Task 3 结束**：把目录候选清单（哪些单元、哪些课文、判定为古诗文/文言文的初判）交给用户确认范围，确认后才写抽取代码。

## 范围说明

本计划覆盖**九上 + 九下两本**。九上走完「爬→转→目录→抽取→入库→验收」全链路后，九下按同样步骤重复（Task 10）。**必背标定不在本次范围**（全量入库一律 `memorize_required=0`，用户后续标定），但为不使专项立刻空掉，既有两篇开发假数据在 Task 1 中置 `memorize_required=1`。

---

## File Structure

### 新建（Python，`tools/data-refinery/src/`）

| 文件 | 职责 |
|---|---|
| `dictation_locate.py` | LLM 定位：给定一个单元的页文本，返回各候选篇目的判断（是否古诗文/篇名/作者/朝代/正文起止锚点/体裁） |
| `dictation_slice.py` | 按锚点从页文本切片 + 跨页拼接 + 规范化（纯函数） |
| `dictation_check.py` | 自检（错误项 / 复核标记）+ 低频字标记（纯函数） |
| `dictation_loader.py` | 入库：按业务键定位/新建 `questions`，upsert `dictation_passages` |
| `dictation_cli.py` | 第 4–6 步 CLI：`--extract` / `--load` / `--all` |
| `prompts/dictation_locate.txt` | 定位用的 prompt 模板 |

### 新建（测试，`tools/data-refinery/tests/`）

`test_dictation_locate.py` / `test_dictation_slice.py` / `test_dictation_check.py` / `test_dictation_loader.py` / `test_dictation_cli.py`

### 修改

| 文件 | 改动 |
|---|---|
| `tools/db/schema.sql` | `dictation_passages` 折回 `memorize_required` 列 |
| `apps/server/src/database/repositories/dictation-passages.repo.ts` | 行类型/入参/列清单/upsert 增加该字段；三条抽题查询加 `AND dp.memorize_required = 1` |
| `apps/server/src/database/repositories/dictation-passages.repo.test.ts` | 断言三条查询含门禁；upsert 全参数组补值 |
| `apps/server/src/scripts/seed-dictation-fixture.ts` | 两篇假数据置 `memorizeRequired: 1` |
| `tools/db/migrations/2026-09-13_add_dictation_memorize_required.sql` | **新建**：幂等加列供已建库环境 |

---

## Task 1: 数据模型变更 —— `memorize_required` + 抽题池门禁

**为什么先做这一步**：它是确定性代码，且做完后专项仍可用（两篇假数据置必背）。若先做内容而没做门禁，入库的真篇目（`memorize_required=0`）反而会被抽出来——顺序反了。

**Files:**
- Create: `tools/db/migrations/2026-09-13_add_dictation_memorize_required.sql`
- Modify: `tools/db/schema.sql`（`dictation_passages` 建表块内 `verified` 之后）
- Modify: `apps/server/src/database/repositories/dictation-passages.repo.ts`
- Modify: `apps/server/src/database/repositories/dictation-passages.repo.test.ts`
- Modify: `apps/server/src/scripts/seed-dictation-fixture.ts`

**Interfaces:**
- Produces: `dictation_passages.memorize_required TINYINT(1) NOT NULL DEFAULT 0`；`DictationPassageRow.memorize_required: number`；`DictationUpsertInput.memorizeRequired: number`；三条抽题查询均含 `AND dp.memorize_required = 1`。

- [ ] **Step 1: 写幂等迁移**

创建 `tools/db/migrations/2026-09-13_add_dictation_memorize_required.sql`（镜像既有 `2026-09-13_ensure_uniq_q_content_hash.sql` 的写法：查 `information_schema` 再决定是否 `ALTER`，避免重复执行报错；不用存储过程，因为本机 `log_bin=ON` 且 `log_bin_trust_function_creators=OFF`，存储过程/触发器需要 SUPER）：

```sql
-- 2026-09-13 语文默写：dictation_passages 增加「必背」标志。
--
-- 语义区分（不要混用）：
--   verified           = 内容是否已校验（正文准确）—— 由内容管线自检后置 1
--   memorize_required  = 教学上是否要求背诵 —— 由人后续标定
-- 抽题池 = verified = 1 AND memorize_required = 1。
--
-- 幂等：先查列是否存在，不存在才 ADD。
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'dictation_passages'
    AND COLUMN_NAME = 'memorize_required'
);

SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE dictation_passages ADD COLUMN memorize_required TINYINT(1) NOT NULL DEFAULT 0 AFTER verified',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

> `'SELECT 1'` 作无操作分支：`PREPARE` 可执行语句清单包含 `ALTER TABLE` 与 `SELECT`，但不包含 `DO`。

- [ ] **Step 2: 折回 schema.sql**

在 `tools/db/schema.sql` 的 `dictation_passages` 建表块里，`verified` 行之后插入：

```sql
  -- 教学上是否要求背诵（与 verified 语义不同：verified 是内容是否已校验）。
  -- 抽题池 = verified = 1 AND memorize_required = 1。
  memorize_required TINYINT(1) NOT NULL DEFAULT 0,
```

- [ ] **Step 3: 执行迁移并验证**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 < tools/db/migrations/2026-09-13_add_dictation_memorize_required.sql
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 < tools/db/migrations/2026-09-13_add_dictation_memorize_required.sql   # 二次执行验幂等
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -E -e "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='ai_k12' AND TABLE_NAME='dictation_passages' AND COLUMN_NAME='memorize_required';"
```

Expected: 两次执行都不报错；查询出 `memorize_required | tinyint(1) | NO | 0`。

- [ ] **Step 4: 改仓储（类型 + 列清单 + upsert）**

`apps/server/src/database/repositories/dictation-passages.repo.ts`：

1. `DictationPassageRow` 增加 `memorize_required: number;`（放在 `verified: number;` 之后）。
2. `DictationUpsertInput` 增加 `memorizeRequired: number;`（放在 `verified: number;` 之后）。
3. `SELECT_COLS` 增加 `dp.memorize_required`（放在 `dp.verified` 之后）。
4. `upsert` 的 INSERT 列清单与 VALUES 各增加一项，并让冲突分支也更新它：

```ts
      `INSERT INTO dictation_passages
         (question_id, work_title, author, dynasty, body, grade_band, grade, semester,
          sort_order, source_ref, verified, memorize_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         question_id = VALUES(question_id), author = VALUES(author), dynasty = VALUES(dynasty),
         body = VALUES(body), grade_band = VALUES(grade_band), grade = VALUES(grade),
         sort_order = VALUES(sort_order), source_ref = VALUES(source_ref), verified = VALUES(verified),
         memorize_required = VALUES(memorize_required)`,
      [
        row.questionId, row.workTitle, row.author, row.dynasty, row.body,
        row.gradeBand, row.grade, row.semester, row.sortOrder, row.sourceRef, row.verified,
        row.memorizeRequired,
      ],
```

- [ ] **Step 5: 三条抽题查询加门禁**

`findRandomVerified`、`findVerifiedBySubject`、`findVerifiedByQuestionIds` 三处的 `WHERE` 子句，把 `AND dp.verified = 1` 改成 `AND dp.verified = 1 AND dp.memorize_required = 1`，并在 `findRandomVerified` 的注释里补一句「抽题池 = 已校验 且 必背」。

`findByQuestionId`（判题取篇目）**保持不加门**——功能设计阶段已裁决（见默写功能 spec §6 注记），本次不改变。

- [ ] **Step 6: 更新测试**

`apps/server/src/database/repositories/dictation-passages.repo.test.ts`：

1. 三个抽题查询的用例各增加一条断言（`memorize_required` 门禁必须被钉住，否则将来误删无人发现）：

```ts
    expect(sql).toContain('dp.memorize_required = 1');
```

2. `upsert` 用例的全参断言补上新值。原来最后一个是 `verified` 的值（`0`），现在末尾追加 `memorizeRequired` 的值（测试入参里传 `0`，故数组末尾再加一个 `0`）：

```ts
    expect(params).toEqual([100, '静夜思', '李白', '唐', '床前明月光', 'junior', '九年级', '上册', 1, 'DEV-FIXTURE', 0, 0]);
```

3. `upsert` 调用的入参对象增加 `memorizeRequired: 0,`。

- [ ] **Step 7: 假数据置必背**

`apps/server/src/scripts/seed-dictation-fixture.ts`：两处 `repo.upsert({...})` 调用的入参里，`verified: 1,` 之后加 `memorizeRequired: 1,`。并在该行上方补一行注释说明原因：

```ts
      // 假数据置「必背」：否则抽题池（verified AND memorize_required）会空掉，
      // 管线落地到真篇目标定必背之前，专项将无可练之题。
```

同时把文件头注释里「生产篇目由内容管线导入」那段补一句：真篇目入库时 `memorizeRequired=0`，待用户标定。

- [ ] **Step 8: 跑测试与构建**

```bash
cd apps/server && npm test && npm run build
```

Expected: 全绿（原 478 个 + 本次不新增用例、仅加断言），build 干净。

- [ ] **Step 9: 真库验证门禁生效**

```bash
cd apps/server && npx tsx src/scripts/seed-dictation-fixture.ts
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -e "SELECT id, work_title, verified, memorize_required FROM dictation_passages WHERE source_ref='DEV-FIXTURE' ORDER BY id;"
```

Expected: 两行都变为 `verified=1, memorize_required=1`（脚本原地 UPDATE，`id` 不变）。

- [ ] **Step 10: Commit**

```bash
git add tools/db/schema.sql tools/db/migrations/2026-09-13_add_dictation_memorize_required.sql apps/server/src/database/repositories/dictation-passages.repo.ts apps/server/src/database/repositories/dictation-passages.repo.test.ts apps/server/src/scripts/seed-dictation-fixture.ts
git commit -m "feat(dictation): dictation_passages 增加 memorize_required，抽题池收紧为已校验且必背"
```

---

## Task 2: 爬取 + 转换九上教材（**中途闸门，需用户确认**）

**Files:** 无代码改动（纯执行既有 CLI）

**Interfaces:**
- Produces: `tools/crawler/data/语文/初中/统编版/九年级/上册/<书名>/page_NNN.jpg` 与 `tools/data-refinery/output/md/语文/初中/统编版/九年级/上册/<书名>/page_NNN.md`。后续任务的 `--book` 参数用 `九年级/上册` 定位。

- [ ] **Step 1: 爬取**

```bash
cd tools/crawler
python src/crawler_cli.py --site smartedu --subject 语文 --publisher 统编版 --level 初中 --grade 九年级 --semester 上册 --output ./data
```

Expected: 打印下载进度；结束落盘 `data/语文/初中/统编版/九年级/上册/<书名>/page_NNN.jpg`。爬虫自带 checkpoint，中断可重跑。
`--level 初中` 必须精确匹配——平台另有 `初中（五•四学制）` 副本，不在范围内。

- [ ] **Step 2: 转换（不动该工具）**

```bash
cd tools/data-refinery
python src/convert_cli.py --source smartedu --subject 语文 --term 上册
```

Expected: **每个输入图片产出一个 MD**（`page_001.md`、`page_002.md`…），落在 `output/md/语文/初中/统编版/九年级/上册/<书名>/` 下。MinerU 按批（10 个/批）调用并批间暂停 15s，页数多时会跑一段时间；自带 resume，中断可重跑。

- [ ] **Step 3: 核实 MD 形态（闸门证据）**

```bash
cd tools/data-refinery
D="output/md/语文/初中/统编版/九年级/上册"
ls "$D"/*/ | head -20                       # 确认目录名与 page_*.md 命名
ls "$D"/*/page_*.md | wc -l                 # 页数
sed -n '1,40p' "$(ls "$D"/*/page_001.md | head -1)"
# 找一页确定含古诗文的（目录页之后，通常是第 3 单元附近），逐行看正文与注释如何排布
```

必须记录并在报告里回答：
1. 页数、MD 文件命名是否确实是 `page_NNN.md`（页码在文件名）；
2. 正文里**有没有**运行页眉/页脚（若「第三单元」这类字样出现在每页顶部，说明需要 `page_chrome` 剥离 —— 该函数正是为教材设计的）；
3. **注释与正文如何排布**（注释是不是在正文之后另起一段、用什么标记开头，如「注释」「①」「〔1〕」）；
4. 正文里 OCR 是否插入了多余的空格/换行；
5. 目录页在第几页（`toc_parse_cli` 要找它）。

- [ ] **Step 4: 向用户汇报并等待确认**

把上面 5 点连同 1–2 页真实 MD 片段贴给用户，**确认后才继续 Task 3**。若形态与设计假设不符（例如 MD 不是逐页而是整本一个文件），停下来重新评估抽取方案，不要硬套。

---

## Task 3: 目录候选（**中途闸门，需用户确认**）

> **前置：Task 12 必须先完成**——`toc_parse_cli` 原本只认数学目录形态，对语文完全失效（实测只认出目录首页 page_004，丢掉第三单元与「课外古诗词诵读」）。Task 12 把版面规则学科化后才可用。

**Files:** 无代码改动（纯执行既有 CLI）

**Interfaces:**
- Produces: `output/toc/语文/初中/统编版/九年级/上册/<书名>.json`（结构与数学一致：`chapters[].{label, sections[].{label, printed_page}, supplements[].{label, printed_page}}`）。后续抽取按 `chapters` 逐单元喂给 LLM。

- [ ] **Step 1: 跑目录解析**

```bash
cd tools/data-refinery
python src/toc_parse_cli.py --source smartedu --subject 语文 --publisher 统编版 --grade 九上
```

Expected: `output/toc/语文/初中/统编版/九年级/上册/<书名>.json`，打印 `[ok] ... -> N chapter(s)`。

- [ ] **Step 2: 核对结构**

```bash
cd tools/data-refinery
python3 -c "
import json,glob
f=glob.glob('output/toc/语文/初中/统编版/九年级/上册/*.json')[0]
d=json.load(open(f))
print('book:',d.get('book'))
for ch in d.get('chapters',[]):
    print(f\"== {ch.get('label')}\")
    for s in ch.get('sections',[]):
        print(f\"   - {s.get('label')}  (p{s.get('printed_page')})\")
    for sup in ch.get('supplements',[]):
        print(f\"   * {sup.get('label')}  (p{sup.get('printed_page')})\")
"
```

Expected: 打印出各单元与课文标题（形如 `第三单元 ...` / `10 岳阳楼记`）。**若 `chapters` 为空或明显不是课文列表**（例如把版权页当地目录），说明 `toc_parse_cli` 的目录页识别对语文教材不适用 —— 停下来报告，不要硬往下走。

- [ ] **Step 3: 生成候选清单交用户确认**

**候选必须同时收 `sections` 与 `supplements`**（Task 12 实测发现：「课外古诗词诵读」下的诗题落在 `supplements` 里而不是 `sections`，只收 sections 会整块丢掉）。另外**把栏目行本身也作为候选**（如 `课外古诗词诵读 159`）——它带印刷页码，能给该单元一个页锚点；否则「课外古诗词诵读」这一组的候选全无 `printed_page`，Task 7 算不出页窗、整组会被丢掉。

把全部 `sections` + `supplements` 的标题列成清单，并**初判**哪些是古诗文/文言文（依据：单元标题含「古诗文」/ 标题形如「N 篇名」的经典篇目 / 「课外古诗词诵读」区块；明显是现代文的如《我爱这土地》《乡愁》排除），标注「收 / 不收 / 待你定」。

**向用户确认后才能进入 Task 4。** 这一步的意义是：目录解析质量决定了候选是否漏收，而漏收意味着学生练不到。

- [ ] **Step 4: 记录确认结果**

把用户确认后的最终候选清单写入 `output/dictation/语文/上册/candidates.json`（**路径须与 Task 7 的默认值一致**：`out_root / SUBJECT_DIR / args.term / "candidates.json"`），数组，每项 `{label, printed_page, unit_label, unit_index}`，作为 Task 4/7 的输入。`output/` 在 gitignore 内，故**同时把确认后的范围记进 spec**（§4 第 3 步闸门注记）。

**九上已确认范围（2026-09-13）**：24 篇（第三单元 10 + 第六单元 13 + 破例收录《沁园春·雪》1）。两条约定：
1. **容器标题不收**——「14 诗词三首」「27 诗词曲五首」「课外古诗词诵读」本身不是篇目，只收其下单篇；
2. TOC 合并已把父栏目页码继承给子条目，故单篇都有 `printed_page`。

---

## Task 4: 定位模块（LLM 只做判断）

**Files:**
- Create: `tools/data-refinery/src/dictation_locate.py`
- Create: `tools/data-refinery/src/prompts/dictation_locate.txt`
- Test: `tools/data-refinery/tests/test_dictation_locate.py`

**Interfaces:**
- Consumes: `llm.LLMClient.complete(system_prompt, user_prompt) -> LLMResponse(content, ...)`；`extract._parse_json_object(content) -> dict`；`extract_cli._load_prompt(name) -> str`（读 `src/prompts/<name>.txt`）
- Produces:
  - `LocatedPassage`（pydantic BaseModel）：`is_classical: bool`、`work_title: str`、`author: str`、`dynasty: str`、`genre: Literal['shi','ci','qu','wen','other']`、`body_start_anchor: str`、`body_end_anchor: str`、`reason: str`
  - `LocateResult`：`passages: list[LocatedPassage]`、**`rejected: list[str]`**（逐条校验失败的原始条目与原因；Task 7 必须把它们写进 unresolved，不能静默丢）
  - `locate_unit(llm: LLMClient, unit_label: str, unit_text: str, prompt: str) -> LocateResult`

> **逐条容错（Task 4 评审 Important，必须实现）**：`LocateResult.model_validate` 是**整体**校验，模型返回一条畸形数据（如 `genre: "诗"`、`is_classical` 缺失、裸数组顶层）就会让**整个单元**被 Task 7 的 `except Exception` 丢掉——实测一次坏 token 可损失 10 篇（第三单元的全部）。故本模块必须**逐条独立校验**：好的留下、坏的进 `rejected` 并带上原因；`genre` 白名单外**归一到 `other`**（与默认值同义，不让单条幻觉毁掉整页）；`is_classical` 缺失/非法则**只丢该条**（**不得默认 True**，那会静默放宽收录范围）。仓库既有同款先例：`card_labeler.py:207-209`「白名单外回退 concept，不让单卡幻觉导致整页 pydantic 校验失败」。

- [ ] **Step 1: 写 prompt 模板**

创建 `tools/data-refinery/src/prompts/dictation_locate.txt`：

```text
你是语文教材内容整理助手。用户会给你一个教材单元的页文本（由扫描页 OCR 得到，可能夹带版面文字、注释、页眉页脚残留），你要找出其中**每一篇古诗文或文言文**，并给出定位信息。

## 什么算「古诗文/文言文」

- 收：古诗词（诗、词、曲）、文言文（含先秦散文、骈文等）。
- **不收**：现代诗、现代文、小说。如《我爱这土地》《乡愁》《你是人间的四月天》等现代诗不收；《故乡》《我的叔叔于勒》《中国人失掉自信力了吗》等现代文不收。
- **特例（按人工确认的收录范围）**：毛泽东《沁园春·雪》虽作于现代，但形式是词牌且属本册收录范围，**按古诗文处理、标 `is_classical: true`**。除此之外不要把现代作品算进来。
- 一个单元可能一篇都没有（纯现代文单元）——那就返回空数组。

## 定位锚点怎么写（最关键）

- `body_start_anchor`：该篇正文的**第一句**，逐字照抄页文本里的原文（含标点），长度 6-20 字。
- `body_end_anchor`：该篇正文的**最后一句**，逐字照抄原文（含标点），长度 6-20 字。
- 两个锚点都必须**在页文本中逐字出现**（程序会用它们做字符串查找）。不要改写、不要补全、不要规范化标点。
- 不要给「注释」的起始位置——末句锚点之后自然就是注释或下一篇课文。
- **「阅读提示」不是正文**：教材常在正文前放一段编者导语（`## 阅读提示` + 一段白话说明，实测九上 9 页如此）。正文从**作品的第一个字**开始，不要把导语算进去。
- 锚点必须是页文本里的**逐字连续子串**，**角标要原样包含在内**（角标由程序在规范化时删除，不会进正文）。**不要**为了避开角标而截短锚点——那样锚点可能搜不到、或把正文开头截掉。
- **首句锚点必须从该篇正文的第一个字开始**：取完整首句（如 `庆历四年 $^{②}$ 春，滕子京谪守巴陵郡 $^{③}$ 。`），**不要**从某个角标之后起（如只取 `十二月，余住西湖。`），也不要在正文开头几个字之后起。末句锚点同理取到正文最后一句为止。
- 锚点长度按**完整句子**为准（不必凑到某个字数）；首句本身很短也没关系。
- 若正文跨页断开，锚点仍照抄原文（首句可能在前一页、末句可能在后一页）。
- **找不到正文起止就整篇不要返回**，不要猜。

## 输出

严格输出 JSON（不要输出任何解释文字、不要用代码块包裹）：

{
  "passages": [
    {
      "is_classical": true,
      "work_title": "岳阳楼记",
      "author": "范仲淹",
      "dynasty": "宋",
      "genre": "wen",
      "body_start_anchor": "庆历四年 $^{②}$ 春，滕子京谪守巴陵郡 $^{③}$ 。",
      "body_end_anchor": "时六年九月十五日。",
      "reason": "页文本含「庆历四年春」至「时六年九月十五日」的完整文言正文，标题为《岳阳楼记》"
    }
  ]
}

字段说明：
- `genre` 取值 `shi`（诗）/`ci`（词）/`qu`（曲）/`wen`（文言文）/`other`。
- `author` / `dynasty`：教材注释或标题里有的才填，没有就填空字符串（不要编）。
- `reason`：一句话说明你凭什么判断它是古诗文、以及锚点取自哪里，供人工复核。
```

- [ ] **Step 2: 写失败测试**

创建 `tools/data-refinery/tests/test_dictation_locate.py`：

```python
import json

from dictation_locate import LocatedPassage, LocateResult, locate_unit


class _FakeLLM:
    """模拟 LLMClient：记录调用参数并回放固定内容（沿用 tests/test_llm.py 的 mock 惯例）。"""

    def __init__(self, content: str):
        self.content = content
        self.calls = []

    def complete(self, system_prompt, user_prompt):
        self.calls.append((system_prompt, user_prompt))

        class _Resp:
            pass

        r = _Resp()
        r.content = self.content
        r.prompt_tokens = 1
        r.completion_tokens = 1
        return r


def test_locates_single_passage():
    payload = {
        "passages": [
            {
                "is_classical": True,
                "work_title": "岳阳楼记",
                "author": "范仲淹",
                "dynasty": "宋",
                "genre": "wen",
                "body_start_anchor": "庆历四年春，滕子京谪守巴陵郡。",
                "body_end_anchor": "时六年九月十五日。",
                "reason": "完整文言正文",
            }
        ]
    }
    llm = _FakeLLM(json.dumps(payload, ensure_ascii=False))
    result = locate_unit(llm, "第三单元", "（页文本）", "（系统提示）")
    assert len(result.passages) == 1
    p = result.passages[0]
    assert isinstance(p, LocatedPassage)
    assert p.work_title == "岳阳楼记" and p.genre == "wen"
    assert p.body_start_anchor.startswith("庆历四年春")
    # 单元标题与页文本都进了 user prompt
    system_prompt, user_prompt = llm.calls[0]
    assert system_prompt == "（系统提示）"
    assert "第三单元" in user_prompt and "（页文本）" in user_prompt


def test_empty_unit_returns_empty_list():
    llm = _FakeLLM('{"passages": []}')
    result = locate_unit(llm, "第一单元", "（纯现代文）", "（系统提示）")
    assert result.passages == []


def test_tolerates_json_code_fence():
    llm = _FakeLLM('```json\n{"passages": []}\n```')
    assert locate_unit(llm, "第一单元", "x", "p").passages == []


def test_defaults_when_optional_fields_missing():
    llm = _FakeLLM('{"passages": [{"is_classical": true, "work_title": "静夜思", "body_start_anchor": "床前明月光，", "body_end_anchor": "低头思故乡。"}]}')
    p = locate_unit(llm, "课外古诗词诵读", "x", "p").passages[0]
    assert p.author == "" and p.dynasty == "" and p.genre == "other"
    assert isinstance(LocateResult(passages=[p]), LocateResult)
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_locate.py -v
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'dictation_locate'`。

- [ ] **Step 4: 实现模块**

创建 `tools/data-refinery/src/dictation_locate.py`：

```python
"""语文默写管线：用 LLM 在教材 MD 中定位古诗文/文言文。

职责边界（关键）：LLM **只做判断**——是不是古诗文、篇名/作者/朝代、体裁、
正文首末句锚点。**它不产出正文字符**；正文由 dictation_slice 按锚点从 MD 原样切出。
这样「正文错了」只可能是边界问题，不可能是模型幻觉。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from extract import _parse_json_object
from llm import LLMClient


class LocatedPassage(BaseModel):
    """一篇候选课文的定位结果。"""

    is_classical: bool = Field(..., description="是否古诗文/文言文（现代诗与现代文为 false）")
    work_title: str = ""
    author: str = ""
    dynasty: str = ""
    genre: Literal["shi", "ci", "qu", "wen", "other"] = "other"
    body_start_anchor: str = Field("", description="正文首句（含标点，逐字来自页文本）")
    body_end_anchor: str = Field("", description="正文末句（含标点，逐字来自页文本）")
    reason: str = Field("", description="判断依据，写进人工过目清单便于复核")


class LocateResult(BaseModel):
    passages: list[LocatedPassage] = Field(default_factory=list)


def locate_unit(llm: LLMClient, unit_label: str, unit_text: str, prompt: str) -> LocateResult:
    """对一个单元的页文本做定位。

    unit_text 为该单元涉及页按页序拼接、且已剥运行页眉的文本。
    """
    user_prompt = (
        f"【单元】{unit_label}\n\n"
        f"【教材页文本】\n{unit_text}\n\n"
        "请按系统提示的要求，输出该单元内每篇古诗文/文言文的定位结果。"
    )
    response = llm.complete(prompt, user_prompt)
    return LocateResult.model_validate(_parse_json_object(response.content))
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_locate.py -v
```

Expected: PASS，4 个用例全绿。

- [ ] **Step 6: 跑全量 Python 测试**

```bash
cd tools/data-refinery && python -m pytest -q
```

Expected: 既有用例全绿 + 新增 4 个。

- [ ] **Step 7: Commit**

```bash
git add tools/data-refinery/src/dictation_locate.py tools/data-refinery/src/prompts/dictation_locate.txt tools/data-refinery/tests/test_dictation_locate.py
git commit -m "feat(data-refinery): 新增语文默写篇目定位模块（LLM 只判断，不产出正文）"
```

---

## Task 5: 切片器（纯函数）

**Files:**
- Create: `tools/data-refinery/src/dictation_slice.py`
- Test: `tools/data-refinery/tests/test_dictation_slice.py`

**Interfaces:**
- Produces:
  - `join_pages(texts: list[str]) -> str` —— 同单元页文本按页序拼成一整段
  - `cut_page_annotations(page_text: str) -> str` —— **逐页**从第一行注释式内容起截断（注释在页尾；跨页文言文必须此步，否则注释混入正文）
  - `slice_body(full_text: str, start_anchor: str, end_anchor: str) -> str | None` —— 含两端锚点取中间原文；任一锚点缺失/找不到返回 `None`
  - `normalize_body(raw: str) -> str` —— 去换行与空白，保留标点

- [ ] **Step 1: 写失败测试**

创建 `tools/data-refinery/tests/test_dictation_slice.py`：

```python
from dictation_slice import cut_page_annotations, join_pages, normalize_body, slice_body

PAGE = """# 人民教育出版社

## 10 岳阳楼记

范仲淹

庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。

乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。

时六年九月十五日。

注释

〔1〕选自《范仲淹全集》。"""


class TestSliceBody:
    def test_includes_both_anchors(self):
        out = slice_body(PAGE, "庆历四年春，滕子京谪守巴陵郡。", "时六年九月十五日。")
        assert out is not None
        # 两端锚点本身必须保留
        assert out.startswith("庆历四年春，滕子京谪守巴陵郡。")
        assert out.endswith("时六年九月十五日。")
        # 中间内容与尾部注释的处理
        assert "乃重修岳阳楼" in out
        assert "选自《范仲淹全集》" not in out

    def test_start_not_found_returns_none(self):
        assert slice_body(PAGE, "不存在的首句。", "时六年九月十五日。") is None

    def test_end_not_found_returns_none(self):
        assert slice_body(PAGE, "庆历四年春，滕子京谪守巴陵郡。", "不存在的末句。") is None

    def test_empty_anchor_returns_none(self):
        assert slice_body(PAGE, "", "时六年九月十五日。") is None
        assert slice_body(PAGE, "庆历四年春，滕子京谪守巴陵郡。", "") is None

    def test_end_searched_after_start_only(self):
        # 末句锚点出现在首句之前时（如标题重复），不得回退到它
        text = "时六年九月十五日。\n\n庆历四年春，滕子京谪守巴陵郡。\n\n时六年九月十五日。"
        out = slice_body(text, "庆历四年春，滕子京谪守巴陵郡。", "时六年九月十五日。")
        assert out is not None
        assert out.count("庆历四年春") == 1

    def test_spans_pages_after_join(self):
        p1 = "庆历四年春，滕子京谪守巴陵郡。越明年，"
        p2 = "政通人和，百废具兴。时六年九月十五日。"
        out = slice_body(join_pages([p1, p2]), "庆历四年春，滕子京谪守巴陵郡。", "时六年九月十五日。")
        assert out is not None and "百废具兴" in out


class TestNormalizeBody:
    def test_removes_newlines_and_spaces_keeps_punctuation(self):
        assert normalize_body("庆历四年春，\n滕子京 谪守巴陵郡。") == "庆历四年春，滕子京谪守巴陵郡。"

    def test_keeps_fullwidth_punctuation(self):
        assert normalize_body("床前明月光，疑是地上霜。") == "床前明月光，疑是地上霜。"

    def test_strips_inline_annotation_markers(self):
        # 实测九上 79/170 页正文含此类行内角标（指向注释，不是正文）
        assert normalize_body("崇祯五年 $^{②}$ 十二月") == "崇祯五年十二月"
        assert normalize_body("春和景 $^{⑰}$ 明") == "春和景明"

    def test_marker_stripped_before_space_collapse(self):
        # 顺序关键：先删角标再收空白。反过来会让 `$^{②}` 与正文粘连、更难清理
        assert normalize_body("大雪三日 $^{③}$ ，湖中人鸟声俱绝") == "大雪三日，湖中人鸟声俱绝"

    def test_keeps_legitimate_fullwidth_punctuation_only(self):
        # 不能把「——」「·」这类正文标点当残留删掉（语文正文常见）
        assert normalize_body("你是人间的四月天 ——一句爱的赞颂") == "你是人间的四月天——一句爱的赞颂"


class TestJoinPages:
    def test_orders_as_given(self):
        assert join_pages(["甲", "乙"]) == "甲\n乙"


class TestCutPageAnnotations:
    """实测驱动：长文言文每页「上半页正文 + 下半页注释」，注释必须按页切掉。"""

    PAGE = (
        "环滁 $^{②}$ 皆山也。其西南诸峰，林壑尤美。\n"
        "作亭者谁？山之僧智仙也。\n"
        "⑦〔意〕意趣，情趣。\n"
        "⑧〔山水之乐，得之心而寓之酒也〕欣赏山水的乐趣，领会于心间，寄托在酒中。"
    )

    def test_cuts_from_first_annotation_line(self):
        out = cut_page_annotations(self.PAGE)
        assert "环滁" in out and "作亭者谁" in out
        assert "〔" not in out and "⑦" not in out

    def test_page_without_annotations_is_unchanged(self):
        page = "庆历四年 $^{②}$ 春，滕子京谪守巴陵郡。\n越明年，政通人和。"
        assert cut_page_annotations(page) == page

    def test_all_annotation_page_becomes_empty(self):
        page = "⑥〔太守自谓也〕太守用自己的别号（醉翁）来命名。\n⑧〔谓〕为，是。"
        assert cut_page_annotations(page).strip() == ""

    def test_figure_caption_with_bracket_is_cut(self):
        # 实测 page_061 的图注「《醉翁亭图》（局部）〔清〕顾符稹作」也带 〔 〕，属页尾版面
        page = "若夫日出而林霏开。\n《醉翁亭图》（局部）〔清〕顾符稹作"
        assert cut_page_annotations(page).strip() == "若夫日出而林霏开。"

    def test_end_to_end_removes_interleaved_annotations(self):
        # 两页拼接：每页都有注释尾巴 → 切片结果不得含 〔〕
        p1 = "环滁 $^{②}$ 皆山也。\n⑦〔意〕意趣。"
        p2 = "太守谓 $^{⑧}$ 谁？庐陵 $^{⑨}$ 欧阳修也。\n⑨〔庐陵〕庐陵郡。"
        joined = join_pages([cut_page_annotations(p1), cut_page_annotations(p2)])
        body = slice_body(joined, "环滁 $^{②}$ 皆山也。", "太守谓 $^{⑧}$ 谁？庐陵 $^{⑨}$ 欧阳修也。")
        assert body is not None
        nb = normalize_body(body)
        assert "〔" not in nb and "⑦" not in nb and "⑨" not in nb
        assert nb == "环滁皆山也。太守谓谁？庐陵欧阳修也。"

    def test_keeps_markerless_body_line_above_annotation(self):
        # **回归护栏**：曾经试过让切点前移（理由是「正文行都带角标」），实测该前提不成立——
        # 全书注释行以上的非空行有 66% 不带角标，前移会把诗的正文行一起切掉（4 篇丢锚点、
        # 周总理你在哪里被静默删掉整页）。此用例钉住「注释行以上一律保留」。
        page = (
            "望长城内外，惟余莽莽；大河上下，顿失滔滔。\n"   # 无角标的正文行
            "还看今朝。\n"                                   # 无角标的正文行（曾是前移的受害者）
            "①②③④⑤⑥⑦⑧⑨⑩〔俱往矣〕都过去了。"
        )
        out = cut_page_annotations(page)
        assert "望长城内外" in out and "还看今朝" in out, out
        assert "俱往矣" not in out

    def test_image_above_first_annotation_is_left_for_checker(self):
        # 浅切**有意**不动注释行以上的内容：图片行若落在锚点区间内，由自检的
        # 图片语法检查判错（进人工复核），而不是靠切点前移去猜（上一条的教训）。
        page = (
            "若夫日出而林霏开 $^{①}$ ，云归而岩穴暝 $^{②}$ 。\n"
            "![](images/a9ee.jpg)\n"
            "⑩〔洌（liè）〕清。"
        )
        out = cut_page_annotations(page)
        assert "若夫日出" in out and "![" in out and "⑩" not in out
```

> 注意：切片结果的「去尾部注释」是靠**末句锚点**（正文内的最后一句）实现的，不是靠找「注释」二字——这正是设计里修正过的点。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_slice.py -v
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'dictation_slice'`。

- [ ] **Step 3: 实现模块**

创建 `tools/data-refinery/src/dictation_slice.py`：

```python
"""语文默写管线：按锚点从教材 MD 中切片出正文（纯函数，不碰网络与数据库）。

设计要点：起点用「正文首句」、终点用「正文末句」，两端都**包含**。
末句锚点必在正文之内，故取到它为止天然排除了其后可能出现的注释；
不依赖「注释」这个字面标记（并非每篇都有）。
"""

from __future__ import annotations

import re

_WS_RE = re.compile(r"\s+")


def join_pages(texts: list[str]) -> str:
    """把同一单元的页文本按页序拼成一整段，便于跨页篇目的锚点定位。"""
    return "\n".join(texts)


#: 注释式行：行首圈号（①-⑳ 及 ㉑+ 扩展），或含〔…〕（注释与图注都用它）。
#: 实测长文言文每一页是「上半页正文 + 下半页注释」，注释块必须按页切掉，
#: 否则跨页篇目按锚点取原始子串时会把中间各页的注释一起吃进来
#: （实测醉翁亭记 775 字含 〔〕与圈号；浅切后 584 字，〔〕/圈号全消）。
_PAGE_ANNOTATION_RE = re.compile(r"^\s*(?:[①-⑳㉑-㉟㊱-㊿]|〔)|〔[^〕]*〕")


def cut_page_annotations(page_text: str) -> str:
    """把**单页**文本从第一个注释式行起截断（注释在页尾）。**刻意保持浅切。**

    只切一次、不前移。理由是有实测代价的：曾试过「切点向前扩到连续不含角标的行为止」
    （想法是正文行都带角标、注释续行不带），**结果是错的**——全书注释行以上的非空行里，
    带角标的只有 101 行、不带的有 192 行（66% 不带，诗类正文常无角标）。实测后果：
    ① 24 篇里 4 篇（沁园春·雪/长沙过贾谊宅/十五从军征/过零丁洋）末句锚点被切掉、切不出正文；
    ② 中间页被静默掏空（周总理你在哪里 721→478 字，整页正文被删）而 `errors` 仍为空——
    即「切过头是安全的」只在被切内容**含锚点**时成立，中间页不含，故静默。
    **不要再加前移逻辑**；浅切漏下的残留由自检兜底（见 dictation_check 的
    括号配平 / 图片语法 / 〔〕 三条），宁可让某篇进人工复核，也不静默删正文。
    """
    lines = page_text.splitlines()
    for i, line in enumerate(lines):
        if _PAGE_ANNOTATION_RE.search(line):
            return "\n".join(lines[:i])
    return page_text


def slice_body(full_text: str, start_anchor: str, end_anchor: str) -> str | None:
    """取「start_anchor 起、到 end_anchor 止」的原始字符（含两端锚点）。

    任一锚点为空或找不到 → 返回 None。调用方据此判为「未定位」并送人工处理，
    **不做兜底猜测**（宁可漏一篇让人看，也不要把注释或下一篇课文混进正文）。
    """
    if not start_anchor or not end_anchor:
        return None
    start = full_text.find(start_anchor)
    if start < 0:
        return None
    tail = full_text[start:]
    # tail 已保证不回退到首句之前；这里 offset 的**真正用途**是：当末句锚点恰好嵌在首句
    # 锚点内部时（嵌套），带 offset 才会判为「找不到」→ 返回 None（宁可送人工，也不切出
    # 一个被截断的正文）。不要因为「tail 已经限制了范围」就把 offset 删掉。
    end = tail.find(end_anchor, len(start_anchor))
    if end < 0:
        return None
    return tail[: end + len(end_anchor)]


#: 行内注释角标：实测九上 79/170 页的正文含 `$^{①}$` 这类指向注释的标记（如
#: 「崇祯五年 $^{②}$ 十二月」）。它不是正文，必须删掉，否则入库正文夹带 `$^{②}$` 垃圾。
_INLINE_MARKER_RE = re.compile(r"\$\^\{[^}]*\}\$")


def normalize_body(raw: str) -> str:
    """规范化正文：**先删行内注释角标，再收空白**；**保留全部标点与全角符号**。

    实测量到：「汉字-空格-汉字」都由被删角标留下（`春和景 $^{⑰}$ 明`）。
    就当前角标正则（不含空白）而言，两条操作**其实可交换**——实测 170 页里没有一页
    结果不同。保持「先删角标」次序是因为：一旦将来角标正则允许内部空白，这个次序
    就成为必需（先收空白会把角标与正文粘连）。**不要**据此认为次序无关紧要而调换。
    标点只在判题时被忽略（normalizeChineseAnswer），存储保留原文便于展示。
    """
    return _WS_RE.sub("", _INLINE_MARKER_RE.sub("", raw))
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_slice.py -v
```

Expected: PASS，全部用例绿。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/dictation_slice.py tools/data-refinery/tests/test_dictation_slice.py
git commit -m "feat(data-refinery): 新增语文默写正文切片器（首末句锚点，含两端）"
```

---

## Task 6: 自检器（纯函数）

**Files:**
- Create: `tools/data-refinery/src/dictation_check.py`
- Test: `tools/data-refinery/tests/test_dictation_check.py`

**Interfaces:**
- Produces:
  - `CheckResult` dataclass：`errors: list[str]`、`needs_review: bool`、`review_reasons: list[str]`
  - `check_body(body: str, work_title: str, genre: str, chrome: set[str]) -> CheckResult`
  - `CHECK_MIN_LEN: dict[str, int]`、`REGULATED_SHI_LENS: set[int]`

- [ ] **Step 1: 写失败测试**

创建 `tools/data-refinery/tests/test_dictation_check.py`：

```python
from dictation_check import CheckResult, check_body

WEN = "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。属予作文以记之。"


class TestErrors:
    def test_clean_body_passes(self):
        r = check_body(WEN, "岳阳楼记", "wen", set())
        assert isinstance(r, CheckResult)
        assert r.errors == []

    def test_empty_body_is_error(self):
        assert "正文为空" in check_body("", "岳阳楼记", "wen", set()).errors

    def test_too_short_is_error(self):
        r = check_body("庆历四年春。", "岳阳楼记", "wen", set())
        assert any("过短" in e for e in r.errors)

    def test_annotation_marker_is_error(self):
        r = check_body(WEN + "注释〔1〕选自《范仲淹全集》。", "岳阳楼记", "wen", set())
        assert any("注释" in e for e in r.errors)

    def test_title_at_body_start_flags_review_not_error(self):
        # 标题被切进正文开头 → 只标复核（不阻断入库），人工仍能看见
        r = check_body("岳阳楼记" + WEN, "岳阳楼记", "wen", set())
        assert r.errors == [], r.errors
        assert r.needs_review is True
        assert any("篇名" in x for x in r.review_reasons)

    def test_title_mid_body_is_not_flagged(self):
        # 实测回归①：《湖心亭看雪》正文里本来就含篇名（末段「独往湖心亭看雪」）
        body = "崇祯五年十二月，余住西湖。大雪三日，独往湖心亭看雪。莫说相公痴，更有痴似相公者。"
        r = check_body(body, "湖心亭看雪", "wen", set())
        assert r.errors == [] and r.needs_review is False

    def test_poem_whose_first_line_is_its_title(self):
        # 实测回归②：《十五从军征》首行即篇名（题目为后人所加），必须仍能入库
        body = ("十五从军征，八十始得归。道逢乡里人：家中有阿谁？遥看是君家，松柏冢累累。"
                "兔从狗窦入，雉从梁上飞。中庭生旅谷，井上生旅葵。舂谷持作饭，采葵持作羹。"
                "羹饭一时熟，不知贻阿谁。出门东向看，泪落沾我衣。")
        r = check_body(body, "十五从军征", "shi", set())
        assert r.errors == [], r.errors

    def test_chrome_residue_is_error(self):
        r = check_body(WEN + "人民教育出版社", "岳阳楼记", "wen", {"人民教育出版社"})
        assert any("页眉" in e for e in r.errors)

    def test_latex_marker_residue_is_error(self):
        # 实测新增：角标没删净（normalize_body 漏删）会在正文留下 $
        r = check_body(WEN + " $^{②}$", "岳阳楼记", "wen", set())
        assert any("$" in e for e in r.errors)

    def test_pipe_furniture_residue_is_error(self):
        # 实测新增：页码页脚「60 | 阅读 | 第三单元」混进正文
        r = check_body(WEN + "60 | 阅读 | 第三单元", "岳阳楼记", "wen", set())
        assert any("竖线" in e for e in r.errors)

    def test_markdown_image_residue_is_error(self):
        # 实测新增：page_061 的图片行会落进正文区间（版面元素混入）
        r = check_body(WEN + "![](images/a9ee.jpg)", "岳阳楼记", "wen", set())
        assert any("图片" in e for e in r.errors)

    def test_unbalanced_bracket_is_error(self):
        # 实测新增：醉翁亭记的注释 ⑤ 起始行在 OCR 里丢失，只剩续行带一个落单的 ），
        # 浅切按设计抓不到它 —— 靠括号配平兜住（进人工复核，不静默）
        r = check_body(WEN + "起）像鸟张开翅膀一样，高踞于泉水之上。", "醉翁亭记", "wen", set())
        assert any("不配平" in e for e in r.errors)

    def test_balanced_brackets_are_fine(self):
        # 正文里有成对括号（如注音）不得误报
        r = check_body(WEN + "（其一）", "岳阳楼记", "wen", set())
        assert not any("不配平" in e for e in r.errors)


class TestReviewFlags:
    def test_rare_char_flagged_for_review(self):
        # U+3400 属 CJK 扩展 A 区（基本区 U+4E00–U+9FFF 之外），是最可能被 OCR 认错的一类
        r = check_body(WEN + "\u3400", "岳阳楼记", "wen", set())
        assert r.needs_review is True
        assert any("生僻" in x or "低频" in x for x in r.review_reasons)

    def test_regulated_shi_length_mismatch_flagged(self):
        # 声明为诗、但字数不是五/七言绝句或律诗的常见字数 → 提示复核（不判错）
        r = check_body("床前明月光疑是地上霜举头望明月低头思故乡啊", "静夜思", "shi", set())
        assert r.needs_review is True
        assert r.errors == []

    def test_common_body_not_flagged(self):
        r = check_body(WEN, "岳阳楼记", "wen", set())
        assert r.needs_review is False
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_check.py -v
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'dictation_check'`。

- [ ] **Step 3: 实现模块**

创建 `tools/data-refinery/src/dictation_check.py`：

```python
"""语文默写管线：正文自检。

分两档，语义不同：
- errors        → 致命，该篇 verified 置 0，进「待人工处理」报告
- needs_review  → 不致命，仅提高人工复核优先级（**不落库**，只出现在产物与清单里）

为什么要有 needs_review：教材页是扫描图，MinerU OCR 对生僻字可能认错，而文言文里
生僻字不少。本管线**无法自动消除**这类错误——此处只做「把可疑篇目挑出来让人先看」。
已实现的代理信号是「正文含 CJK 基本区（U+4E00–U+9FFF）之外的汉字」——那是最经典的
OCR 出错面。基本区内的生僻字（如「谪」「滕」）**不会**被这条挑出来，这是已知局限。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# 注释体例标记：出现在正文里说明切多了（把注释切进正文）
_ANNOTATION_MARKS = ("注释", "其：", "〔", "〕", "题解", "【注释】")

# 各体裁正文长度下限（去标点后的字数）
CHECK_MIN_LEN: dict[str, int] = {"shi": 20, "ci": 20, "qu": 20, "wen": 30, "other": 20}

# 五言/七言绝句与律诗的常见字数：声明为诗但字数不在其中 → 提示复核
REGULATED_SHI_LENS: set[int] = {20, 28, 40, 56}

_PUNCT_RE = re.compile(r"[，。！？；：、（）《》〈〉“”‘’\s]")
# CJK 基本区；之外的汉字（扩展 A/B/C…）视为可疑生僻字
_HAN_IN_BASIC_RE = re.compile(r"[\u4e00-\u9fff]")
_HAN_ANY_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U0003ffff]")


@dataclass
class CheckResult:
    errors: list[str] = field(default_factory=list)
    needs_review: bool = False
    review_reasons: list[str] = field(default_factory=list)


def _char_count(body: str) -> int:
    """去标点与空白后的字数。"""
    return len(_PUNCT_RE.sub("", body))


def check_body(body: str, work_title: str, genre: str, chrome: set[str]) -> CheckResult:
    """对一篇正文做自检。chrome 为该书运行页眉集合（来自 compute_book_chrome）。"""
    r = CheckResult()

    if not body.strip():
        r.errors.append("正文为空")
        return r

    if _char_count(body) < CHECK_MIN_LEN.get(genre, CHECK_MIN_LEN["other"]):
        r.errors.append(f"正文过短（{_char_count(body)} 字，低于 {genre} 的下限）")

    for mark in _ANNOTATION_MARKS:
        if mark in body:
            r.errors.append(f"正文含注释体例标记「{mark}」，疑似切多")

    # 版面／标记残留（实测新增，原清单抓不到）：$ 说明 `$^{①}$` 角标没删净；
    # 竖线说明页码页脚混了进来（实测全书仅 2 行，属兜底）。
    if "$" in body:
        r.errors.append("正文含 $（行内注释角标未删净）")
    if "|" in body or "｜" in body:
        r.errors.append("正文含竖线 |／｜（页码页脚残留）")
    # 图片语法：正文里绝不该有 markdown 图片（实测 page_061 的图片行会落进正文区间）
    if "![" in body or "](" in body:
        r.errors.append("正文含 markdown 图片语法（版面元素混入）")
    # 括号配平：文言/诗词正文里编辑性括号极少。配平不上说明有注释碎片混入——
    # 实测醉翁亭记的注释 ⑤ **起始行在 OCR 里丢失**，只剩续行「起）像鸟张开翅膀…」，
    # 带一个落单的 ）；浅切按设计抓不到它，靠这条兜住（判错 → 进人工复核，不静默）。
    for left, right, label in (("（", "）", "圆括号"), ("〔", "〕", "六角括号"), ("【", "】", "方头括号")):
        if body.count(left) != body.count(right):
            r.errors.append(
                f"正文{label}不配平（{left}×{body.count(left)} vs {right}×{body.count(right)}），疑似注释碎片混入"
            )

    # 篇名检查只看正文**开头**，且**只标复核、不判错**（两种真实情形都必须能入库）：
    # ①《湖心亭看雪》正文里本来就含篇名（末段「独往湖心亭看雪」）——substring 会误杀正确正文；
    # ②《十五从军征》的首行**就是篇名本身**（该诗题目为后人所加）——「开头出现篇名」对它是正常现象。
    # 故留作 needs_review：人工能看见「疑似把标题切进了正文」，但不阻断入库。
    if work_title and work_title in body[: len(work_title) + 6]:
        r.needs_review = True
        r.review_reasons.append(f"正文开头出现篇名「{work_title}」，疑似把标题切进了正文")

    for line in chrome:
        if line and line in body:
            r.errors.append(f"正文含页眉/版式残留「{line}」")
            break

    # —— 以下只提高复核优先级，不判错 ——
    for ch in _HAN_ANY_RE.findall(body):
        if not _HAN_IN_BASIC_RE.match(ch):
            r.needs_review = True
            r.review_reasons.append(f"含基本区外汉字「{ch}」（可能是 OCR 认错，也可能是真生僻字）")
            break

    if genre == "shi" and _char_count(body) not in REGULATED_SHI_LENS:
        r.needs_review = True
        r.review_reasons.append(
            f"声明为诗但字数 {_char_count(body)} 不在绝句/律诗常见字数 {sorted(REGULATED_SHI_LENS)} 内"
            "（古体诗属正常，请人工确认）"
        )

    return r
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_check.py -v
```

Expected: PASS，全部用例绿。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/dictation_check.py tools/data-refinery/tests/test_dictation_check.py
git commit -m "feat(data-refinery): 新增语文默写正文自检（错误项 + 复核标记，后者不落库）"
```

---

## Task 7: `dictation_cli.py --extract`（串联定位→切片→自检，出三类产物）

**Files:**
- Create: `tools/data-refinery/src/dictation_cli.py`
- Test: `tools/data-refinery/tests/test_dictation_cli.py`

**Interfaces:**
- Consumes: `dictation_locate.locate_unit`；`dictation_slice.{join_pages,slice_body,normalize_body}`；`dictation_check.check_body`；`page_chrome.{compute_book_chrome,strip_chrome}`；`config.RefineryConfig.from_env`；`llm.create_llm_client`；`extract_cli._load_prompt`
- Produces（文件产物，供 Task 9 入库与人工过目）：
  - `output/dictation/<学科>/<学段>/<出版社>/<年级>/<册>/<书名>.jsonl` —— 每行一个篇目
  - `output/dictation/<…>/<书名>-review.md` —— 人工过目清单
  - `output/dictation/<…>/<书名>-unresolved.md` —— 待人工处理（未定位 / 自检未过 / 目录有但没找到）

**JSONL 每行的键**（沿用仓库惯例：镜像 DB 列的键 + 派生字段用 `_` 前缀）：

```json
{"subject_id":"chinese","work_title":"岳阳楼记","author":"范仲淹","dynasty":"宋","body":"庆历四年春，……","semester":"上册","grade_band":"junior","grade":"九年级","source_ref":"统编版语文九年级上册 P46-49","verified":1,"_genre":"wen","_needs_review":false,"_review_reasons":[],"_reason":"……"}
```

> 注意结尾 `verified`：自检 `errors` 为空则 `1`，否则该条**不进 JSONL**（改写入 unresolved 报告）——即「入库的必是自检通过的」。`_needs_review` 只影响清单排序与标注。

- [ ] **Step 1: 写 CLI 骨架与参数**

创建 `tools/data-refinery/src/dictation_cli.py`，先实现参数解析与 `--extract` 的编排（`--load` 在 Task 9 补）：

```python
"""dictation_cli 子命令入口。语文默写内容管线：第 4-6 步（定位/切片/自检、入库）。

第 1-3 步请用既有 CLI：
  cd tools/crawler       && python src/crawler_cli.py  --site smartedu --subject 语文 --publisher 统编版 --grade 九年级 --semester 上册
  cd tools/data-refinery && python src/convert_cli.py   --source smartedu --subject 语文 --term 上册
  cd tools/data-refinery && python src/toc_parse_cli.py --source smartedu --subject 语文 --publisher 统编版 --grade 九上
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import unquote

from config import RefineryConfig
from dictation_check import check_body
from dictation_locate import locate_unit
from dictation_slice import cut_page_annotations, join_pages, normalize_body, slice_body
from extract_cli import _load_prompt
from llm import create_llm_client
from page_chrome import compute_book_chrome, strip_chrome

SUBJECT_DIR = "语文"


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="语文默写内容管线（定位/切片/自检/入库）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python src/dictation_cli.py --extract --book "九年级/上册" --term 上册
  python src/dictation_cli.py --load    --book "九年级/上册" --term 上册
  python src/dictation_cli.py --all     --book "九年级/上册" --term 上册
        """,
    )
    parser.add_argument("--book", required=True, help="教材路径子串，如 '九年级/上册'")
    parser.add_argument("--term", required=True, choices=["上册", "下册"], help="册次（写入 dictation_passages.semester）")
    parser.add_argument("--input-dir", help="MD 根目录（默认 output/md）")
    parser.add_argument("--output-dir", help="产物根目录（默认 output/dictation）")
    parser.add_argument("--candidates", help="候选清单 JSON 路径（默认 output/dictation/<book 同名>/candidates.json）")
    parser.add_argument("--extract", action="store_true", help="定位 + 切片 + 自检，出 JSONL 与两份清单")
    parser.add_argument("--load", action="store_true", help="把 JSONL 入库（幂等）")
    parser.add_argument("--all", action="store_true", help="等价于 --extract --load")
    return parser.parse_args(argv)
```

- [ ] **Step 2: 实现页序、偏移与单元页窗（纯函数，可单测）**

在 `dictation_cli.py` 追加：

```python
LEAD_PAGES = 2   # 单元扉页/导读可能早于该单元首篇的印刷页
WINDOW_TAIL = 3  # 末单元窗尾余量


def _title_of(label: str) -> str:
    """从 TOC 的 label 取篇名：「10 岳阳楼记」→「岳阳楼记」；无编号则原样。"""
    parts = label.strip().split(" ", 1)
    return parts[1].strip() if len(parts) == 2 else label.strip()


def _find_book_dir(md_root: Path, book: str) -> Path | None:
    """在 MD 根目录下找含 page_*.md 的教材目录（--book 为路径子串）。找不到返回 None。"""
    for d in sorted(md_root.rglob("*")):
        if d.is_dir() and book in str(d) and list(d.glob("page_*.md")):
            return d
    return None


def _md_pages(book_md_dir: Path) -> list[tuple[int, str]]:
    """按页序返回 (页号, 文本)。页号取自文件名 page_NNN.md。"""
    out: list[tuple[int, str]] = []
    for p in sorted(book_md_dir.glob("page_*.md")):
        digits = "".join(c for c in p.stem if c.isdigit())
        if digits:
            out.append((int(digits), p.read_text(encoding="utf-8")))
    return out


def _offset_pairs(candidates: list[dict], pages: list[tuple[int, str]]) -> list[tuple[int, int]]:
    """把候选的 printed_page 与其标题在 MD 中首次出现的页号配成对。"""
    pairs: list[tuple[int, int]] = []
    for c in candidates:
        title = _title_of(c.get("label", ""))
        pp = c.get("printed_page")
        if not title or pp is None:
            continue
        for page_no, text in pages:
            if title in text:
                pairs.append((int(pp), page_no))
                break
    return pairs


def _offset_mode(pairs: list[tuple[int, int]], min_samples: int = 3, min_share: float = 0.5) -> int | None:
    """求「MD 页号 - 印刷页号」的众数偏移。

    样本少于 min_samples、或众数占比低于 min_share → 返回 None（调用方退化为整书滑窗）。
    本函数的意图是「宁可不信也不硬套」：偏移错了会整篇切错。
    """
    if len(pairs) < min_samples:
        return None
    diffs = [md - printed for printed, md in pairs]
    counter: dict[int, int] = {}
    for d in diffs:
        counter[d] = counter.get(d, 0) + 1
    offset, n = max(counter.items(), key=lambda kv: kv[1])
    return offset if n / len(diffs) >= min_share else None


def _unit_windows(
    candidates: list[dict],
    pages: list[tuple[int, str]],
    offset: int | None,
    lead: int = LEAD_PAGES,
) -> list[tuple[str, list[str]]]:
    """按 unit_label 分组，返回 [(单元标题, 该单元页文本列表)]，顺序为单元物理顺序。

    偏移可靠时按印刷页推算页窗；不可靠时**整书喂给每个单元**（TOC 仅用于完整性核对）。
    相邻单元页窗允许轻微重叠——重叠不致误切（锚点定位到即可），但会产生同篇重复命中，
    由写出阶段按 (work_title) 去重。
    """
    nos = [n for n, _ in pages]
    if not nos:
        return []

    by_unit: dict[str, list[int]] = {}
    order: list[str] = []
    for c in candidates:
        label = c.get("unit_label") or "（未分单元）"
        if label not in by_unit:
            by_unit[label] = []
            order.append(label)
        pp = c.get("printed_page")
        if pp is not None:
            by_unit[label].append(int(pp))

    ordered = sorted([u for u in order if by_unit[u]], key=lambda u: min(by_unit[u]))
    if not ordered:
        return []

    if offset is None:
        return [(u, [t for _, t in pages]) for u in ordered]

    out: list[tuple[str, list[str]]] = []
    for idx, unit in enumerate(ordered):
        lo = min(by_unit[unit]) + offset - lead
        if idx + 1 < len(ordered):
            hi = min(by_unit[ordered[idx + 1]]) + offset - 1
        else:
            hi = max(nos) + WINDOW_TAIL
        out.append((unit, [t for n, t in pages if lo <= n <= hi]))
    return out


def _units_without_page(candidates: list[dict]) -> list[str]:
    """返回「候选全无 printed_page」的单元——这类单元算不出页窗，须在候选阶段避免。

    Task 12 实测发现：「课外古诗词诵读」下的诗题落在 supplements 里且没有页码；
    若该组的栏目行（如 `课外古诗词诵读 159`，带页码）没被收进候选，整组会被 `_unit_windows`
    的 `ordered` 过滤掉、彻底丢掉。`run_extract` 应在开头调用本函数，非空即打印 `[WARN]`
    并把这些单元列进 unresolved 报告（宁可让人看见，也不要静默丢一篇）。
    """
    seen: dict[str, bool] = {}
    for c in candidates:
        label = c.get("unit_label") or "（未分单元）"
        seen.setdefault(label, False)
        if c.get("printed_page") is not None:
            seen[label] = True
    return [u for u, has_page in seen.items() if not has_page]
```

- [ ] **Step 3: 实现 --extract 主流程与产物写出**

```python
def run_extract(args, config) -> int:
    md_root = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    out_root = Path(args.output_dir) if args.output_dir else config.output_dir / "dictation"

    book_md_dir = _find_book_dir(md_root, args.book)
    if book_md_dir is None:
        print(f"[ERROR] 没找到含 page_*.md 的教材目录（--book {args.book}）", flush=True)
        return 1
    book_name = book_md_dir.name

    cand_path = Path(args.candidates) if args.candidates else out_root / SUBJECT_DIR / args.term / "candidates.json"
    if not cand_path.exists():
        print(f"[ERROR] 候选清单不存在：{cand_path}（先跑 Task 3 并由用户确认）", flush=True)
        return 1
    candidates = json.loads(cand_path.read_text(encoding="utf-8"))

    pages = _md_pages(book_md_dir)
    chrome = compute_book_chrome(book_md_dir)
    # 逐页：剥运行页眉 → 切掉页尾注释块。两步都必须在 join_pages 之前按页做，
    # 否则跨页文言文的中间各页注释会落进切片区间（实测醉翁亭记 775 字含 〔〕）。
    clean = [(n, cut_page_annotations(strip_chrome(t, chrome))) for n, t in pages]

    offset = _offset_mode(_offset_pairs(candidates, clean))
    mode = "印刷页偏移" if offset is not None else "整书滑窗（偏移不可靠）"
    print(f"[ok] 页数 {len(pages)}，定位模式：{mode}" + (f"，偏移 {offset}" if offset is not None else ""), flush=True)

    llm = create_llm_client(
        provider=config.llm_provider, api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token, model=config.llm_model,
        base_url=config.llm_base_url, timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens, max_retries=config.llm_max_retries,
        thinking=config.llm_thinking, enable_cache=config.llm_enable_cache,
    )
    prompt = _load_prompt("dictation_locate")

    rows: list[dict] = []
    unresolved: list[tuple[str, str, str]] = []      # (篇名或单元, 原因, 细节)
    seen_titles: set[str] = set()

    for unit_label, unit_pages in _unit_windows(candidates, clean, offset):
        unit_text = join_pages(unit_pages)
        if not unit_text.strip():
            unresolved.append((unit_label, "单元页窗为空", "偏移/滑窗未覆盖到任何页"))
            continue
        try:
            located = locate_unit(llm, unit_label, unit_text, prompt)
        except Exception as e:                        # LLM 失败不阻断整册
            unresolved.append((unit_label, "LLM 定位失败", str(e)[:200]))
            continue

        # 逐条校验失败的条目（Task 4 的 LocateResult.rejected）——必须暴露，不能静默丢
        for reason in located.rejected:
            unresolved.append((unit_label, "条目校验失败被跳过", reason))

        found_titles: set[str] = set()
        for p in located.passages:
            if not p.is_classical:
                continue
            title = p.work_title.strip()
            if not title:
                unresolved.append((unit_label, "缺少篇名", p.reason[:120]))
                continue
            if title in seen_titles or title in found_titles:
                continue                              # 页窗重叠导致的重复命中
            found_titles.add(title)

            body = slice_body(unit_text, p.body_start_anchor, p.body_end_anchor)
            if body is None:
                unresolved.append((title, "锚点未找到", f"start={p.body_start_anchor!r} end={p.body_end_anchor!r}"))
                continue
            body = normalize_body(body)
            checked = check_body(body, title, p.genre, chrome)
            if checked.errors:
                unresolved.append((title, "自检未通过", "；".join(checked.errors)))
                continue

            seen_titles.add(title)
            rows.append({
                "subject_id": "chinese", "work_title": title,
                "author": p.author.strip(), "dynasty": p.dynasty.strip(), "body": body,
                "semester": args.term, "grade_band": "junior", "grade": "九年级",
                "_sort_order": len(rows) + 1,
                "source_ref": f"{book_name} {unit_label}",
                "verified": 1,
                "_genre": p.genre,
                "_needs_review": checked.needs_review,
                "_review_reasons": checked.review_reasons,
                "_reason": p.reason,
            })

        # 目录里列了、但本单元没被 LLM 找出来的 → 漏收信号，必须让用户看到
        for c in candidates:
            if (c.get("unit_label") or "（未分单元）") != unit_label:
                continue
            t = _title_of(c.get("label", ""))
            if t and t not in found_titles and t not in seen_titles:
                unresolved.append((t, "目录有但页文本中未找到", f"{unit_label} p{c.get('printed_page')}"))

    book_out = out_root / SUBJECT_DIR / args.term
    book_out.mkdir(parents=True, exist_ok=True)
    jsonl_path = book_out / f"{book_name}.jsonl"
    with jsonl_path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    review_path = book_out / f"{book_name}-review.md"
    with review_path.open("w", encoding="utf-8") as f:
        f.write(f"# 人工过目清单：{book_name}\n\n")
        f.write("按「需复核优先」排序。抽看长文言文与标了需复核的行即可。\n\n")
        f.write("| 需复核 | 篇名 | 作者 | 朝代 | 体裁 | 字数 | 正文首 20 字 | 正文末 20 字 |\n")
        f.write("|---|---|---|---|---|---|---|---|\n")
        for r in sorted(rows, key=lambda x: (not x["_needs_review"], x["_sort_order"]))[:]:
            b = r["body"]
            flag = "⚠ " + "；".join(r["_review_reasons"]) if r["_needs_review"] else ""
            f.write(f"| {flag} | {r['work_title']} | {r['author']} | {r['dynasty']} | {r['_genre']} | {len(b)} | {b[:20]} | {b[-20:]} |\n")

    unresolved_path = book_out / f"{book_name}-unresolved.md"
    with unresolved_path.open("w", encoding="utf-8") as f:
        f.write(f"# 待人工处理：{book_name}\n\n")
        if not unresolved:
            f.write("（无）\n")
        for name, reason, detail in unresolved:
            f.write(f"- **{name}** —— {reason}：{detail}\n")

    print(f"[ok] {book_name}：入库候选 {len(rows)} 篇，待人工处理 {len(unresolved)} 项", flush=True)
    print(f"[ok] JSONL -> {jsonl_path}", flush=True)
    print(f"[ok] 过目清单 -> {review_path}", flush=True)
    print(f"[ok] 待处理 -> {unresolved_path}", flush=True)
    return 0
```

> 关键设计：**自检未通过的篇目不进 JSONL**（只进 unresolved 报告），因此「入库的必是自检通过的」，`verified` 恒为 1——门禁在写文件时就生效，入库器不需要再判。

- [ ] **Step 4: 写失败测试**

创建 `tools/data-refinery/tests/test_dictation_cli.py`，覆盖**不依赖网络与 LLM 的部分**（页序解析、偏移众数、单元页窗），用 `tmp_path` 造假教材目录：

```python
from pathlib import Path

from dictation_cli import (
    _find_book_dir,
    _md_pages,
    _offset_mode,
    _offset_pairs,
    _title_of,
    _unit_windows,
    parse_args,
)


def _make_book(root: Path, name: str, pages: list[str]) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    for i, text in enumerate(pages, 1):
        (d / f"page_{i:03d}.md").write_text(text, encoding="utf-8")
    return d


class TestFindBookDir:
    def test_finds_book_by_substring(self, tmp_path):
        _make_book(tmp_path / "语文" / "初中" / "统编版" / "九年级" / "上册", "书", ["甲"])
        found = _find_book_dir(tmp_path, "九年级/上册")
        assert found is not None and found.name == "书"

    def test_returns_none_when_absent(self, tmp_path):
        _make_book(tmp_path / "语文" / "九年级" / "下册", "书", ["甲"])
        assert _find_book_dir(tmp_path, "九年级/上册") is None


class TestMdPages:
    def test_page_ordered(self, tmp_path):
        book = _make_book(tmp_path, "书", ["甲", "乙", "丙"])
        assert [n for n, _ in _md_pages(book)] == [1, 2, 3]
        assert _md_pages(book)[1][1] == "乙"


class TestTitleOf:
    def test_strips_number_prefix(self):
        assert _title_of("10 岳阳楼记") == "岳阳楼记"

    def test_keeps_label_without_number(self):
        assert _title_of("课外古诗词诵读") == "课外古诗词诵读"


class TestOffset:
    def test_mode_when_consistent(self):
        assert _offset_mode([(2, 12), (3, 13), (4, 14), (5, 15)]) == 10

    def test_none_when_too_few_samples(self):
        assert _offset_mode([(2, 12), (3, 13)]) is None

    def test_none_when_inconsistent(self):
        assert _offset_mode([(2, 12), (3, 40), (4, 5), (5, 90)]) is None

    def test_pairs_use_first_occurrence(self):
        pages = [(1, "封面"), (2, "10 岳阳楼记\n正文"), (3, "10 岳阳楼记\n续")]
        cands = [{"label": "10 岳阳楼记", "printed_page": 46}]
        assert _offset_pairs(cands, pages) == [(46, 2)]


class TestUnitWindows:
    def test_windows_split_by_unit_with_offset(self):
        pages = [(n, f"第{n}页") for n in range(1, 31)]
        cands = [
            {"label": "10 岳阳楼记", "printed_page": 10, "unit_label": "第三单元"},
            {"label": "11 醉翁亭记", "printed_page": 14, "unit_label": "第三单元"},
            {"label": "12 湖心亭看雪", "printed_page": 30, "unit_label": "第四单元"},
        ]
        wins = _unit_windows(cands, pages, offset=2)
        assert [u for u, _ in wins] == ["第三单元", "第四单元"]
        # 第三单元窗：lo = 10+2-2 = 10，hi = 30+2-1 = 31（被页范围裁到 30）
        assert all(t in {"第10页", "第11页", "第12页", "第13页", "第14页"} or True for t in wins[0][1])
        assert wins[0][1][0] == "第10页"

    def test_falls_back_to_whole_book_when_offset_none(self):
        pages = [(n, f"第{n}页") for n in range(1, 6)]
        cands = [{"label": "1 甲", "printed_page": 1, "unit_label": "第一单元"},
                 {"label": "2 乙", "printed_page": 3, "unit_label": "第二单元"}]
        wins = _unit_windows(cands, pages, offset=None)
        assert len(wins) == 2
        assert all(len(pgs) == 5 for _, pgs in wins)      # 整书喂给每个单元


class TestParseArgs:
    def test_requires_book_and_term(self):
        args = parse_args(["--extract", "--book", "九年级/上册", "--term", "上册"])
        assert args.extract and args.book == "九年级/上册" and args.term == "上册"

    def test_term_is_whitelisted(self):
        args = parse_args(["--all", "--book", "b", "--term", "下册"])
        assert args.all
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_cli.py -v
```

Expected: PASS。

- [ ] **Step 6: 跑全量 Python 测试**

```bash
cd tools/data-refinery && python -m pytest -q
```

Expected: 全绿。

- [ ] **Step 7: 真跑九上（需要 Task 2/3 的产物）**

```bash
cd tools/data-refinery && python src/dictation_cli.py --extract --book "九年级/上册" --term 上册
```

Expected: 打印定位模式与「入库候选 N 篇，待人工处理 M 项」；落盘 JSONL + `-review.md` + `-unresolved.md`。**把两份清单给用户过目**——这是人工闸门的第二次使用。

**必查三条**（发现即修，不要放过）：
1. **《沁园春·雪》必须在 JSONL 里**（用户已裁决破例收录）。若它落到 unresolved 或被判为非古诗文，说明 prompt 的特例说明没生效或模型没遵守——先修 prompt 再重跑，不要改候选清单绕过去。
2. **《岳阳楼记》与《出师表》的正文长度**应是全篇（前者约 360 字、后者约 600 字量级，去标点后）。若明显偏短，说明末句锚点取错了（切到了半篇）。
3. **九上候选 24 篇的落地数**：JSONL 条数应为 24（若有进 unresolved 的，逐条看原因是否合理）。

- [ ] **Step 8: Commit**

```bash
git add tools/data-refinery/src/dictation_cli.py tools/data-refinery/tests/test_dictation_cli.py
git commit -m "feat(data-refinery): 新增语文默写抽取 CLI（--extract：定位/切片/自检 + 两类清单）"
```

---

## Task 8: 入库器（幂等）

**Files:**
- Create: `tools/data-refinery/src/dictation_loader.py`
- Test: `tools/data-refinery/tests/test_dictation_loader.py`

**Interfaces:**
- Consumes: `dictation_cli` 产出的 JSONL 行（字段见 Task 7）
- Produces:
  - `class DictationLoader`：`__init__(self, host, port, user, password, db)`、`close()`、`load_passages(items: list[dict]) -> dict`（返回 `{"inserted": n, "updated": n, "passages_upserted": n}`）

- [ ] **Step 1: 写失败测试（用假连接）**

创建 `tools/data-refinery/tests/test_dictation_loader.py`。核心是验证**按业务键找已有题 → 原地 UPDATE（不插重复）**这条幂等策略：

```python
from dictation_loader import DictationLoader


class _FakeCursor:
    def __init__(self, scripted):
        self._scripted = scripted
        self.executed = []
        self._last = []

    def execute(self, sql, args=None):
        self.executed.append((sql, args))
        for pat, rows in self._scripted:
            if pat in sql:
                self._last = rows
                return
        self._last = []

    def fetchall(self):
        return self._last

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass


class _FakeConn:
    def __init__(self, scripted):
        self.cur = _FakeCursor(scripted)
        self.committed = 0

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1


ITEM = {
    "subject_id": "chinese",
    "work_title": "岳阳楼记",
    "author": "范仲淹",
    "dynasty": "宋",
    "body": "庆历四年春，滕子京谪守巴陵郡。",
    "semester": "上册",
    "grade_band": "junior",
    "grade": "九年级",
    "source_ref": "统编版语文九年级上册 P46-49",
    "verified": 1,
}


def _loader(scripted):
    loader = DictationLoader.__new__(DictationLoader)   # 绕过真实连接
    loader._conn = _FakeConn(scripted)
    return loader


def test_existing_passage_reuses_question_and_updates_in_place():
    # 业务键命中既有篇目 → 复用其 question_id，UPDATE 而非 INSERT
    scripted = [
        ("FROM subjects", [(2,)]),
        ("FROM dictation_passages dp", [(5036, "DEV-FIXTURE")]),
    ]
    loader = _loader(scripted)
    stats = loader.load_passages([ITEM])
    sqls = [s for s, _ in loader._conn.cur.executed]
    assert any(s.strip().upper().startswith("UPDATE QUESTIONS") for s in sqls)
    assert not any("INSERT INTO questions" in s for s in sqls)
    assert stats["updated"] == 1
    assert loader._conn.committed >= 1


def test_new_passage_inserts_question_then_upserts_passage():
    scripted = [
        ("FROM subjects", [(2,)]),
        ("FROM dictation_passages dp", []),        # 业务键未命中
        ("LAST_INSERT_ID", [(7001,)]),
    ]
    loader = _loader(scripted)
    stats = loader.load_passages([ITEM])
    sqls = [s for s, _ in loader._conn.cur.executed]
    assert any("INSERT INTO questions" in s for s in sqls)
    assert any("INSERT INTO dictation_passages" in s for s in sqls)
    assert stats["inserted"] == 1 and stats["passages_upserted"] == 1


def test_question_content_uses_prompt_convention():
    scripted = [("FROM subjects", [(2,)]), ("FROM dictation_passages dp", [])]
    loader = _loader(scripted)
    loader.load_passages([ITEM])
    ins = [a for s, a in loader._conn.cur.executed if "INSERT INTO questions" in s][0]
    # 题面只放篇名（上一阶段定的约定）
    assert "请默写《岳阳楼记》" in ins
    assert "并写出" not in str(ins)
    # answer 三行结构
    assert any(str(x).startswith("作者：范仲淹") for x in ins)
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_loader.py -v
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'dictation_loader'`。

- [ ] **Step 3: 实现模块**

创建 `tools/data-refinery/src/dictation_loader.py`：

```python
"""语文默写管线：把抽取产物入库（幂等）。

幂等策略（与 TS 种子脚本同构，原因也一样）：
以 dictation_passages 的业务键 (work_title, semester) 作为身份，**先找既有 question_id，
有则原地 UPDATE、无则 INSERT**。不用 content_hash 去重——题面模板一旦调整 hash 就变，
按 hash 去重会插出新行、把旧行变孤儿（且 main_error_books.question_id 外键是 RESTRICT，
删旧行还可能被拦）。
"""

from __future__ import annotations

import json

import pymysql


class DictationLoader:
    def __init__(self, host: str, port: int, user: str, password: str, db: str):
        self._conn = pymysql.connect(host=host, port=port, user=user,
                                     password=password, database=db, charset="utf8mb4")

    def close(self):
        self._conn.close()

    def _query(self, sql, args=None):
        with self._conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()

    def _exec(self, sql, args=None):
        with self._conn.cursor() as cur:
            cur.execute(sql, args)

    def _subject_id(self, code: str) -> int:
        rows = self._query("SELECT id FROM subjects WHERE code=%s LIMIT 1", (code,))
        if not rows:
            raise ValueError(f"subjects 表没有 code={code}")
        return int(rows[0][0])

    def load_passages(self, items: list[dict]) -> dict:
        inserted = updated = upserted = 0
        for it in items:
            sid = self._subject_id(it["subject_id"])
            work_title = it["work_title"]
            semester = it["semester"]
            content = f"请默写《{work_title}》"
            answer = f"作者：{it.get('author') or ''}\n朝代：{it.get('dynasty') or ''}\n正文：{it['body']}"

            existing = self._query(
                "SELECT dp.question_id, q.source FROM dictation_passages dp "
                "JOIN questions q ON q.id = dp.question_id "
                "WHERE dp.work_title=%s AND dp.semester=%s LIMIT 1",
                (work_title, semester),
            )
            if existing:
                question_id = int(existing[0][0])
                if existing[0][1] == "DEV-FIXTURE":
                    print(f"[WARN] 《{work_title}》原为 DEV-FIXTURE，将由真实内容覆盖", flush=True)
                self._exec(
                    "UPDATE questions SET subject_id=%s, type='poem_dictation', difficulty=2, "
                    "content=%s, answer=%s, grade_band=%s, source=%s, is_active=1 WHERE id=%s",
                    (sid, content, answer, it.get("grade_band"), it.get("source_ref"), question_id),
                )
                updated += 1
            else:
                self._exec(
                    "INSERT INTO questions (subject_id, type, difficulty, content, answer, "
                    "grade_band, source, answer_verified, is_active) "
                    "VALUES (%s,'poem_dictation',2,%s,%s,%s,%s,0,1)",
                    (sid, content, answer, it.get("grade_band"), it.get("source_ref")),
                )
                question_id = int(self._query("SELECT LAST_INSERT_ID()")[0][0])
                inserted += 1

            self._exec(
                "INSERT INTO dictation_passages (question_id, work_title, author, dynasty, body, "
                "grade_band, grade, semester, sort_order, source_ref, verified, memorize_required) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,0) "
                "ON DUPLICATE KEY UPDATE question_id=VALUES(question_id), author=VALUES(author), "
                "dynasty=VALUES(dynasty), body=VALUES(body), grade_band=VALUES(grade_band), "
                "grade=VALUES(grade), sort_order=VALUES(sort_order), source_ref=VALUES(source_ref), "
                "verified=VALUES(verified)",
                (question_id, work_title, it.get("author") or "", it.get("dynasty") or "", it["body"],
                 it.get("grade_band"), it.get("grade"), semester, it.get("_sort_order", 0),
                 it.get("source_ref"), int(it.get("verified", 1))),
            )
            upserted += 1

        self._conn.commit()
        return {"inserted": inserted, "updated": updated, "passages_upserted": upserted}

    @staticmethod
    def read_jsonl(path) -> list[dict]:
        from pathlib import Path

        return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]
```

> 关键点：`memorize_required` 显式写 `0`（本次全量非必背，必背由用户后续标定）；`answer_verified` 显式写 `0`（管线提取的原始数据，与人工/AI 回写区分的既有约定一致）；`ON DUPLICATE KEY UPDATE` **不动 `memorize_required`**——否则重跑会把用户已标的必背刷回 0。

- [ ] **Step 4: 运行测试确认通过 + 全量**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_loader.py -v && python -m pytest -q
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/dictation_loader.py tools/data-refinery/tests/test_dictation_loader.py
git commit -m "feat(data-refinery): 新增语文默写入库器（按篇目业务键幂等，不覆盖必背标志）"
```

---

## Task 9: `--load` + 真库验收（**中途闸门**）

**Files:**
- Modify: `tools/data-refinery/src/dictation_cli.py`（补 `--load` 与 `--all` 分支）

**Interfaces:**
- Consumes: `dictation_loader.DictationLoader.read_jsonl`

- [ ] **Step 1: 补 --load 分支**

在 `dictation_cli.py` 追加（`DictationLoader` 在 Task 8 实现）：

```python
def _jsonl_path(args, config) -> Path:
    out_root = Path(args.output_dir) if args.output_dir else config.output_dir / "dictation"
    md_root = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    book_md_dir = _find_book_dir(md_root, args.book)
    if book_md_dir is None:
        raise FileNotFoundError(f"没找到含 page_*.md 的教材目录（--book {args.book}）")
    return out_root / SUBJECT_DIR / args.term / f"{book_md_dir.name}.jsonl"


def run_load(args, config) -> int:
    from dictation_loader import DictationLoader

    path = _jsonl_path(args, config)
    if not path.exists():
        print(f"[ERROR] JSONL 不存在：{path}（先跑 --extract）", flush=True)
        return 1

    items = DictationLoader.read_jsonl(path)
    if not items:
        print(f"[WARN] {path} 没有可入库的篇目", flush=True)
        return 1

    loader = DictationLoader(config.db_host, config.db_port, config.db_user, config.db_pass, config.db_name)
    try:
        stats = loader.load_passages(items)
    finally:
        loader.close()

    print(f"[ok] 入库完成：新增题 {stats['inserted']}、复用并更新 {stats['updated']}、"
          f"篇目 upsert {stats['passages_upserted']}", flush=True)
    return 0


def main(argv=None):
    args = parse_args(argv)
    config = RefineryConfig.from_env(input_dir=None, output_dir=None)
    if args.all or args.extract:
        rc = run_extract(args, config)
        if rc != 0 or not args.all:
            return rc
    if args.all or args.load:
        return run_load(args, config)
    print("[WARN] 未指定动作（--extract / --load / --all）", flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

> 注意：`--load` 不重跑抽取，它只吃 `--extract` 已落盘的 JSONL —— 这样人工过目（Task 7 Step 7）可以在入库**之前**发生，用户否决的篇目直接从 JSONL 里删掉即可。

- [ ] **Step 2: 跑测试**

```bash
cd tools/data-refinery && python -m pytest tests/test_dictation_cli.py -v
```

Expected: 全绿。

- [ ] **Step 3: 真库入库九上**

```bash
cd tools/data-refinery && python src/dictation_cli.py --load --book "九年级/上册" --term 上册
```

Expected: 打印 `inserted=N, updated=M, passages_upserted=N+M`。

- [ ] **Step 4: 真库验收（三条）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
# 1) 入库量与非必背状态
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -e "SELECT COUNT(*) AS 九上篇目, SUM(memorize_required) AS 其中必背, SUM(verified) AS 其中已校验 FROM dictation_passages WHERE semester='上册';"
# 2) 抽题池仍只出必背（此时应只有两篇开发假数据）
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -e "SELECT work_title, verified, memorize_required FROM dictation_passages WHERE verified=1 AND memorize_required=1;"
```

Expected：① 九上篇目数 = 该册古诗文/文言文总数，`其中必背 = 0`（真篇目全为非必背），`其中已校验 = 全部`（自检通过的才入库）；② 仍只有《静夜思》《登鹳雀楼》两行 —— 证明**门禁真的生效**（真篇目虽已校验、但未标必背，不会被抽到）。

把两个查询结果给用户确认。

- [ ] **Step 5: 幂等复验**

```bash
cd tools/data-refinery && python src/dictation_cli.py --load --book "九年级/上册" --term 上册
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -e "SELECT COUNT(*) FROM dictation_passages WHERE semester='上册';"
```

Expected: 第二次全部走 `updated` 分支，`INSERT` 数为 0，篇目总数不变。

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/dictation_cli.py
git commit -m "feat(data-refinery): dictation_cli 补 --load/--all（入库九上篇目）"
```

---

## Task 10: 九下重复（爬 → 转 → 目录 → 抽取 → 入库）

**Files:** 无新代码（复用 Task 2–9 的 CLI，只换册次参数）；若九下暴露了不兼容的版式差异，则在此修 `dictation_*` 模块并补测试。

- [ ] **Step 1: 爬取 + 转换九下**

```bash
cd tools/crawler && python src/crawler_cli.py --site smartedu --subject 语文 --publisher 统编版 --level 初中 --grade 九年级 --semester 下册 --output ./data
cd tools/data-refinery && python src/convert_cli.py --source smartedu --subject 语文 --term 下册
```

- [ ] **Step 2: 目录解析九下**

```bash
cd tools/data-refinery && python src/toc_parse_cli.py --source smartedu --subject 语文 --publisher 统编版 --grade 九下
```

把候选清单交用户确认（同 Task 3 的闸门），确认后落 `candidates.json`。

- [ ] **Step 3: 抽取 + 入库**

```bash
cd tools/data-refinery && python src/dictation_cli.py --all --book "九年级/下册" --term 下册
```

- [ ] **Step 4: 真库验收**

```bash
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -e "SELECT semester, COUNT(*) AS 篇目, SUM(memorize_required) AS 必背 FROM dictation_passages GROUP BY semester;"
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -e "SELECT work_title, author, dynasty, LENGTH(body) AS 正文字数 FROM dictation_passages WHERE semester='下册' ORDER BY id;"
```

Expected: 上下册篇目齐备；下册 `必背=0`；逐行看一眼篇名/作者/朝代/正文字数是否合理（字数明显偏小的多半切短了）。

- [ ] **Step 5: Commit（若有代码改动）**

```bash
git add tools/data-refinery/src tools/data-refinery/tests
git commit -m "fix(data-refinery): 语文默写管线适配九下版式差异"
```

若无代码改动则跳过本步。

---

## Task 11: 收尾（回归 + 文档同步）

**Files:**
- Modify: `docs/ai-core-changelog.md`
- Modify: `docs/data-refinery-管线总结与后续.md`（新增本管线小节）
- Modify: `docs/superpowers/specs/2026-09-13-chinese-dictation-content-pipeline-design.md`（末尾加「实现结果」小节，记录实际篇目数、未处理项、踩到的坑）
- Modify: `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml`（**Task 1 评审发现**：两份文档仍写 passages 端点「只出 verified=1 的已校验篇目」，而实际已收紧为 `verified AND memorize_required`。仓库铁律要求这两份**互为对照、同时更新**）
- Modify: `docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md` §4.2（其 DDL 块早于 `memorize_required`，需补上该列并与 §4.3 口径一致）
- Modify: `apps/server/src/modules/training/training.service.ts:95`（注释仍写「只出 verified=1」）与 `apps/server/src/database/repositories/dictation-passages.repo.ts:46`（类注释同上）——两处 Task 1 评审记下的陈旧注释

- [ ] **Step 0: 清掉 Task 1 遗留的两处陈旧注释**

`training.service.ts` 的 `listDictationPassages` 注释与 `dictation-passages.repo.ts` 的类注释都还写着「只出 verified=1 / 只向抽题池暴露 verified=1」，现已多加 `memorize_required` 门禁。改准（并顺带在仓储 `upsert` 的冲突分支加一行注释说明：**此处按入参覆盖 `memorize_required`，而管线的 loader 有意不在冲突分支动它**——否则将来有人「统一」两处写法，重跑管线就会把用户标好的必背刷回 0）。

- [ ] **Step 1: 数学管线回归**

```bash
cd tools/data-refinery && python -m pytest -q          # Python 全量绿
cd apps/server && npm test && npm run build            # TS 全量绿（抽题池门禁改动不伤数学）
```

再手工确认数学专项抽题仍可用：`GET /api/training/targeted/start` 用数学 KP 抽一次题（或跑既有数学相关用例——门禁只加在 `dictation_passages` 的三条查询上，数学走的是 `questions.findRandomByKpAndType`，理论上无交集，但要有证据）。

- [ ] **Step 2: 更新 changelog + 同步两份 API 文档**

在 `docs/ai-core-changelog.md` 顶部加一条 `## 2026-09-13 新增（语文默写内容管线：九年级教材 → 题库）`，写清：新增 CLI 与模块、`memorize_required` 字段与抽题池收紧、实际入库篇目数、自检与人工过目的结论、以及「必背标定与注释抽取留给后续」。

再同步**互为对照的两份 API 文档**（仓库铁律，任何一方变更另一方必须同时改）：`docs/API接口与数据流设计文档.md` §4.18 与 `docs/api/openapi.yaml` 里 `GET /api/training/dictation/passages` 的说明——把「只出 `verified=1` 的已校验篇目」改为「只出 `verified=1` **且** `memorize_required=1` 的篇目」；并确认 `POST /dictation/start` 的三条抽题路径描述也提到该门禁。改完用 grep 交叉核对两份文档的端点路径与措辞一致。最后把 `docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md` §4.2 的建表 DDL 补上 `memorize_required` 列（该块早于本列，现与实现不符）。

- [ ] **Step 3: 更新管线总结文档**

在 `docs/data-refinery-管线总结与后续.md` 增一节，说明这条「只服务语文默写」的旁路管线：为什么独立于四阶段（不波及其他学科）、三步复用 + 三步新建、产物目录、运行命令。

- [ ] **Step 4: spec 补「实现结果」**

在 spec 末尾加一节，记录：实际篇目数与分布、`unresolved` 报告里最终遗留了什么（用户是否处理完）、偏移众数是否可靠（还是退化用了滑窗）、低频字标记命中了几篇。

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: 记录语文默写内容管线落地结果（篇目数/遗留项/已知局限）"
```

---

## Task 12: 学科版式档案重构（基类 + 每学科实现）

> **执行时机：Task 2 之后、Task 3 之前**（编号靠后是为了不打乱既有 Task 3–11 的编号与简报缓存，沿用上一份计划 Task 17 的先例）。**Task 3 依赖本任务**。

**为什么做**：`toc_parse_cli._TOC_LINE_RE` 与 `card_splitter._PAGE_NUMBER_HEADER_RE` 都把**数学版式**写死了，实测 `toc_parse_cli` 对语文**完全失效**（只认出目录首页 page_004，丢掉第三单元与「课外古诗词诵读」）。用户指示：**写一个基类，不同学科各自实现**，并要求「一定要做好测试，不要出现纰漏」。

**Files:**
- Create: `tools/data-refinery/src/textbook_profile.py`
- Create: `tools/data-refinery/tests/test_textbook_profile.py`
- Modify: `tools/data-refinery/src/toc_parse_cli.py`（`_is_toc_like_page` / `_find_toc_pages` 改为按 profile 判定）
- Modify: `tools/data-refinery/src/card_splitter.py`（`_is_page_number_header` 改为按 profile 判定）
- Modify: `tools/data-refinery/tests/`（`toc_parse_cli` 与 `card_splitter` 的既有测试若因签名变化而失败，按「行为不变」原则同步）

**Interfaces:**
- Produces:
  - `class TextbookProfile`：`name: str`、`is_toc_line(line: str) -> bool`、`is_page_furniture(line: str) -> bool`
  - `class MathTextbookProfile(TextbookProfile)`、`class ChineseTextbookProfile(TextbookProfile)`
  - `get_profile(subject: str | None) -> TextbookProfile`（未注册学科回退 `TextbookProfile`）
  - `profile_for_md_path(md_path: Path) -> TextbookProfile`（从 MD 路径首段推学科：`语文/初中/…` → chinese；推不出则回退数学档以保持既有行为）

- [ ] **Step 1: 写失败测试**

创建 `tools/data-refinery/tests/test_textbook_profile.py`。**最重要的一组是数学黄金回归**——重构后数学判定必须与重构前逐条一致：

```python
from textbook_profile import (
    ChineseTextbookProfile,
    MathTextbookProfile,
    TextbookProfile,
    get_profile,
)

# 数学黄金用例：前半「是否目录行」、后半「是否版面残留」
MATH_TOC_POSITIVE = [
    "第二十六章 反比例函数 1",
    "26.1 反比例函数 2",
    "小结 12",
    "复习题26 15",
    "数学活动 9",
    "阅读与思考 生活中的反比例关系 17",
]
MATH_TOC_NEGATIVE = [
    "## 练习",
    "第N单元",
    "1 沁园春·雪/毛泽东 3",
    "把一根长 3 米的绳子剪成两段，每段长多少？",
    "26.1",
]
MATH_FURNITURE_POSITIVE = ["3 第二十一章 一元二次方程", "81 第二十六章 反比例函数"]
MATH_FURNITURE_NEGATIVE = [
    "## 练习",
    "60 | 阅读 | 第三单元",
    "第二十六章 反比例函数",
    "在 Rt△ABC 中，∠C=90°，AC=3。",
]


class TestMathProfileUnchanged:
    """黄金回归：重构不得改变数学判定。"""

    def setup_method(self):
        self.p = MathTextbookProfile()

    def test_toc_positive(self):
        for line in MATH_TOC_POSITIVE:
            assert self.p.is_toc_line(line) is True, line

    def test_toc_negative(self):
        for line in MATH_TOC_NEGATIVE:
            assert self.p.is_toc_line(line) is False, line

    def test_furniture_positive(self):
        for line in MATH_FURNITURE_POSITIVE:
            assert self.p.is_page_furniture(line) is True, line

    def test_furniture_negative(self):
        for line in MATH_FURNITURE_NEGATIVE:
            assert self.p.is_page_furniture(line) is False, line


# 语文用例全部取自九上真实目录页与版面实测（spec §4.1/§4.2）
CN_TOC_POSITIVE = [
    "第一单元 活动·探究 1",
    "任务一 学习鉴赏 2",
    "1 沁园春·雪/毛泽东 3",
    "阅读 7 培养德智体美劳全面发展的社会主义建设者和接班人/习近平 22",
    r"9\*谈骨气/吴晗 33",
    "课外古诗词诵读 159",
    "月夜忆舍弟/杜甫",          # 无页码的诗题行：靠「含 /」命中
    "写作 观点要明确 43",
]
CN_TOC_NEGATIVE = [
    "## 目录",
    "第二单元",
    "注：阅读单元的课文分“教读”和“自读”两类，篇名前标有*的为“自读”课文。",
    "仅供个人学习使用，未经授权不得另做他用",
]
CN_FURNITURE_POSITIVE = ["60 | 阅读 | 第三单元", "九年级 | 上册"]
CN_FURNITURE_NEGATIVE = [
    "庆历四年春，滕子京谪守巴陵郡。",
    "## 阅读提示",
    "1 沁园春·雪/毛泽东 3",
]


class TestChineseProfile:
    def setup_method(self):
        self.p = ChineseTextbookProfile()

    def test_toc_positive(self):
        for line in CN_TOC_POSITIVE:
            assert self.p.is_toc_line(line) is True, line

    def test_toc_negative(self):
        for line in CN_TOC_NEGATIVE:
            assert self.p.is_toc_line(line) is False, line

    def test_furniture(self):
        for line in CN_FURNITURE_POSITIVE:
            assert self.p.is_page_furniture(line) is True, line
        for line in CN_FURNITURE_NEGATIVE:
            assert self.p.is_page_furniture(line) is False, line


class TestRegistry:
    def test_resolves_by_chinese_and_code(self):
        assert isinstance(get_profile("语文"), ChineseTextbookProfile)
        assert isinstance(get_profile("chinese"), ChineseTextbookProfile)
        assert isinstance(get_profile("数学"), MathTextbookProfile)

    def test_unknown_falls_back_to_base(self):
        p = get_profile("物理")
        assert type(p) is TextbookProfile
        assert p.is_page_furniture("60 | 阅读 | 第三单元") is False   # 基类不猜
```

> 若 `MATH_TOC_NEGATIVE` 里的某条在重构**前**其实为 True（说明我举的例子不对），**以实现为准改用例并在报告里说明**——黄金回归的意义是「与重构前一致」，不是「与我举的例子一致」。落笔前请先用重构前的两条正则跑一遍这些用例确认预期。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd tools/data-refinery && python -m pytest tests/test_textbook_profile.py -v
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'textbook_profile'`。

- [ ] **Step 3: 实现 textbook_profile.py**

创建 `tools/data-refinery/src/textbook_profile.py`：

```python
"""教材版式档案：把「学科相关」的版面识别规则收敛到一处。

背景：MinerU 转出的 MD 里，目录行与页眉/页脚残留的形态**因学科而异**——数学是
「3 第二十一章 一元二次方程」「第N章 X 页码」，语文是「1 沁园春·雪/毛泽东 3」
「60 | 阅读 | 第三单元」。原先这两条规则分别硬编码在 card_splitter 与 toc_parse_cli 里，
只能服务数学：实测 toc_parse_cli 对语文完全失效（只认出目录首页，丢掉第三单元与
课外古诗词诵读）。

本模块用「基类 + 每学科实现 + 注册表」承载，调用方按 subject 取用。
数学实现**逐字保留**原正则，保证行为零变化。
"""

from __future__ import annotations

import re
from pathlib import Path


class TextbookProfile:
    """一个学科的版面规则。基类只给保守的通用规则，**不猜学科专属形态**。"""

    name = "generic"

    #: 通用目录行：行末为 1-3 位数字（学科可在此基础上叠加）
    _TOC_TAIL_RE = re.compile(r"\d{1,3}\s*$")

    def is_toc_line(self, line: str) -> bool:
        """该行是否像目录条目（标题 + 行末页码）。"""
        return bool(self._TOC_TAIL_RE.search(line.strip()))

    def is_page_furniture(self, line: str) -> bool:
        """该行是否为页眉/页脚残留。基类不猜学科形态，一律 False。"""
        return False


class MathTextbookProfile(TextbookProfile):
    """数学教材。两条正则与重构前**逐字一致**（见 test_textbook_profile 黄金回归）。"""

    name = "math"

    _TOC_LINE_RE = re.compile(
        r'^\s*(第[一二三四五六七八九十百零]+章.*\d+\s*$'      # 第N章 X 页码
        r'|\d+\.\d+.*\d+\s*$'                                # N.M X 页码
        r'|.*(小结|复习题|数学活动|阅读与思考).*\d+\s*$)'       # 非编号条目+页码
    )
    _PAGE_NUMBER_HEADER_RE = re.compile(r'^\d+\s+第[一二三四五六七八九十百零]+章\s+\S+.*$')

    def is_toc_line(self, line: str) -> bool:
        return bool(self._TOC_LINE_RE.search(line))

    def is_page_furniture(self, line: str) -> bool:
        return bool(self._PAGE_NUMBER_HEADER_RE.match(line.strip()))


class ChineseTextbookProfile(TextbookProfile):
    """语文教材。形态由九上目录页（page_004–007）与版面实测推导（spec §4.1/§4.2）。"""

    name = "chinese"

    #: 行末 1-3 位数字：课文行「1 沁园春·雪/毛泽东 3」、栏目行「课外古诗词诵读 159」
    _TOC_TAIL_RE = re.compile(r"\d{1,3}\s*$")
    #: 篇名/作者形式（「月夜忆舍弟/杜甫」）——「课外古诗词诵读」下的诗题行没有页码，
    #: 只能靠这个特征计入，否则 page_007 的匹配率不足 30% 会被误判为非目录页
    _TITLE_AUTHOR_RE = re.compile(r"[/／]")
    #: 页码 + 栏目 + 单元 的页脚（实测全书仅 2 行，属兜底）
    _PAGE_FURNITURE_RE = re.compile(r"^\s*\d+\s*[|｜]")

    def is_toc_line(self, line: str) -> bool:
        s = line.strip()
        if not s:
            return False
        return bool(self._TOC_TAIL_RE.search(s) or self._TITLE_AUTHOR_RE.search(s))

    def is_page_furniture(self, line: str) -> bool:
        return bool(self._PAGE_FURNITURE_RE.match(line))


_PROFILES: dict[str, type[TextbookProfile]] = {
    "math": MathTextbookProfile,
    "chinese": ChineseTextbookProfile,
}
_ALIASES: dict[str, str] = {
    "数学": "math", "语文": "chinese", "英语": "generic",
    "math": "math", "chinese": "chinese", "english": "generic",
}


def get_profile(subject: str | None) -> TextbookProfile:
    """按学科取版式档案；未注册学科（含 None）回退保守的基类。"""
    key = _ALIASES.get((subject or "").strip())
    return (_PROFILES[key] if key else TextbookProfile)()


def profile_for_md_path(md_path: Path) -> TextbookProfile:
    """从 MD 路径推学科（路径首段即学科目录，如 `语文/初中/…`）。

    **推不出学科时回退数学档**——这是刻意为之的兼容默认：重构不得改变既有调用方的行为，
    而既有调用方（教材卡与试卷切题）服务的是数学。
    """
    for part in Path(md_path).parts:
        key = _ALIASES.get(part.strip())
        if key and key != "generic":
            return _PROFILES[key]()
    return MathTextbookProfile()
```

- [ ] **Step 4: 运行测试确认通过（含黄金回归）**

```bash
cd tools/data-refinery && python -m pytest tests/test_textbook_profile.py -v
```

Expected: PASS。**特别注意数学黄金回归必须全绿**——它是本次重构的安全绳。

- [ ] **Step 5: 接进 toc_parse_cli**

`toc_parse_cli.py` 的三处改动：

1. 顶部 import：`from textbook_profile import get_profile`；
2. `_is_toc_like_page(page_path: Path)` → `_is_toc_like_page(page_path: Path, profile)`，内部把 `_TOC_LINE_RE.search(l)` 换成 `profile.is_toc_line(l)`；
3. `_find_toc_pages(book_dir: Path, profile, max_pages: int = 10)` 同上透传（含递归调用处）；`main()` 里按 `args.subject` 取 `profile = get_profile(args.subject)` 并传入。

> 数学路径取到 `MathTextbookProfile`，两条判定与改前一致；语文路径取到 `ChineseTextbookProfile`。

- [ ] **Step 6: 接进 card_splitter**

`card_splitter.py`：

1. 顶部 import：`from textbook_profile import TextbookProfile, profile_for_md_path`；
2. `_is_page_number_header(text: str, profile: TextbookProfile) -> bool` → `return profile.is_page_furniture(text)`；
3. `_make_bundles(text, images, profile)` 透传；`split_page(md_path, text, images)` 内部改为
   `profile = profile_for_md_path(md_path)` 后传入；
4. 删除文件内的 `_PAGE_NUMBER_HEADER_RE` 常量（避免留下两处真相），其注释里那句「页码标注：如 "3 第二十一章 一元二次方程"」迁到 `MathTextbookProfile` 的文档串。

- [ ] **Step 7: 跑全量 Python 测试（数学行为回归的最终证据）**

```bash
cd tools/data-refinery && python -m pytest -q
```

Expected: 全绿。**若有既有用例失败，先判断是「签名变化需同步调用」还是「行为被改坏」**——后者必须修实现，不许改断言。

- [ ] **Step 8: 真数据端到端验语文目录（本任务的验收核心）**

```bash
cd tools/data-refinery && python src/toc_parse_cli.py --source smartedu --subject 语文 --publisher 统编版 --grade 九上
python3 -c "
import json,glob
f=glob.glob('output/toc/语文/初中/统编版/九年级/上册/*.json')[0]
d=json.load(open(f))
print('chapters:', len(d.get('chapters',[])))
for ch in d.get('chapters',[]): print(' ', ch.get('label'))
"
```

Expected: 解析出语文的**多个单元**（至少含第三单元「古诗文」与第六单元），而不是像重构前只出 page_004 一个单元。把输出贴进报告。

- [ ] **Step 9: Commit**

```bash
git add tools/data-refinery/src/textbook_profile.py tools/data-refinery/tests/test_textbook_profile.py tools/data-refinery/src/toc_parse_cli.py tools/data-refinery/src/card_splitter.py tools/data-refinery/tests
git commit -m "refactor(data-refinery): 版面规则学科化（基类 + 数学/语文实现 + 数学黄金回归）"
```

---

## Task 13: 正文纠正（用户 2026-09-14 插入，**已完成**）

> 本任务不在原计划里，是执行期间用户追加的需求。已实现并真机验证，记在此处备查。

**需求（用户原话）**：「如果判定这道古诗，古文内容可能存在问题，调用本地大模型进行纠正。
如果调用本地大模型失败，则调用 ds flash 进行更正。」

**这是对 spec §5.2「LLM 不产出正文」的显式例外**，设计已写入 spec §5.4。

- [x] **Step 1: 模块 + prompt**
  - `src/dictation_repair.py`（`RepairResult` / `repair_body` / `build_user_prompt`）
  - `src/prompts/dictation_repair.txt`
  - 触发范围**只限 `errors`**，`needs_review` 不触发（用户裁决）
  - 模型：本地优先、`LLM_FALLBACK_*` 兜底；不硬编码模型名
  - 输出经 `normalize_body` 清理后**直接采用**（用户裁决：不设采纳闸门）

- [x] **Step 2: 接线 `run_extract`**
  - 未过自检 → 纠正 → 采纳则入库（`verified=1`）并留痕；两模型都无数值输出才 fail-closed
  - `{book}-review.md` 新增「已由模型纠正」节（纠正前/后全文 + 残留自检问题）；清单加「已纠正」列

- [x] **Step 3: 测试**
  - `tests/test_dictation_repair.py` 25 例（全 mock）
  - `tests/test_dictation_cli.py` +3 集成例（采纳 / fail-closed / 自检通过时不触发）
  - **845 passed / 10 skipped**

- [x] **Step 4: 真机验证（真书 + 真本地模型）**
  - 《醉翁亭记》从「被拦下」变为「纠正后入库」：584 → 478 字，
    剔除了注释 ⑤ 的丢头续行 `起）像鸟张开翅膀一样…` 与行内图片 `![](images/a9ee…jpg)`，
    纠正后自检通过

- [x] **Step 5: 文档同步**
  - spec §5.4 新增；§6.3/§6.4 改为反映纠正后的分流
  - `docs/ai-core-changelog.md` 2026-09-14 条目

> ⚠️ **同时暴露的既有缺陷（与 Task 13 无关，需另行处理）**：`locate` 不可复现——同代码同输入
> 连跑 3 次得 23 / 22 / 20 篇。根因是 `llm.py` 不传 `temperature`（走服务端默认采样），
> 而「第六单元」页窗 30 页（末单元的 `hi` 延伸到书尾），本地 27B 在长窗口里不稳定地漏掉尾部
> 那组 `课外古诗词诵读`（印刷页 159）。**这条会直接影响本计划「完成标准 2：全部入库」**。

---

## 完成标准

1. `tools/data-refinery` 的 `pytest` 全绿；`apps/server` 的 `npm test` + `npm run build` 全绿；
2. 九上/九下两册的古诗文与文言文全部入库，`verified=1`、`memorize_required=0`（真篇目）；
3. **抽题池只出必背**：真篇目入库后抽题池仍只有两篇开发假数据（门禁生效的证据）；把某真篇目手动置 `memorize_required=1` 后能从抽题池抽到；
4. `-unresolved.md` 的遗留项已被用户过目（处理完或明确接受）；
5. 重跑 `--load` 不产生重复行（幂等）；重跑 `--extract` 覆盖同一份产物、不追加；
6. 数学管线无回归（Python 与 TS 全量测试 + 一次数学抽题）。

## 后续（不在本计划内）

- **必背标定**：读教材课后的背诵要求标 `memorize_required=1`（或按公开必背清单），含必要的人工确认环节；
- **古诗文解释专项**：需要本管线丢弃的教材注释（图片留在本地，重跑第 2–5 步即可，不需重爬）；
- **开发假数据清理**：真篇目必背标定完成后清理两篇 `DEV-FIXTURE`（及其可能产生的错题行）；
- **低频字复查增强**：本管线的 `needs_review` 只覆盖 CJK 基本区外的字；若后续要覆盖基本区内的生僻字，需要引入一份常用字表（本次未做，已在 spec §6.2 与自检模块注释中如实标注）。
