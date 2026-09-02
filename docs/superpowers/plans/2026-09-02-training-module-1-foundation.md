# 训练模块计划 1/3：基础层（DB 迁移 + 试卷归组管线 + JudgeCore + QuestionRunner）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为考试/专项/错题三大训练功能打地基：DB 表与迁移、试卷归组数据管线、共享判题核心 JudgeCoreService、共享答题组件 QuestionRunner，并完成入口选择页三轨改造。

**Architecture:** 分四块——① tools/db 新增 exam_papers/paper_questions/question_hints/exam_sessions/exam_answers 表（migration 文件，幂等）；② tools/data-refinery 的 db_loader 按爬虫命名规则解析试卷元数据，find-or-create 试卷并以 JSONL 行序写 paper_questions；③ apps/server 把 PracticeService.judge 的判题三路由+错题本逻辑抽成题中心 JudgeCoreService（/api/practice/judge 行为不变）；④ apps/web 从 AnswerModal/CleanupPhase 抽 QuestionRunner + ChoiceOptionList 共享答题组件，入口页改三轨。设计文档：`docs/superpowers/specs/2026-09-02-math-training-module-design.md`。

**Tech Stack:** MySQL 8（utf8mb4）、Python 3 + pymysql + pytest、NestJS + TypeScript ESM + Vitest、React 18 + Vite + Tailwind + react-markdown/KaTeX。

## Global Constraints

- 无 emoji 进 UI/组件/文案（图标一律线性 SVG）；style.md 单一色系；iPad 横屏 ≥1024px 主断点。
- TS 严格模式、2 空格缩进；Python PEP 8 snake_case；Conventional Commits（scope：`web`/`server`/`ai-core`/`data-refinery`/`db_loader`）。
- LLM 配置用 `.env` 的 `LLM_BASE_URL`/`LLM_AUTH_TOKEN`（refinery 专属），**不要用 `ANTHROPIC_*`**。
- 若测试断言与 config/types/设计文档的值冲突，测试错——改测试。
- db_loader 全量重载有业务数据守卫（QUESTIONS_BLOCKERS），不得绕过。
- 迁移 SQL 一律幂等（`CREATE TABLE IF NOT EXISTS` / `INSERT IGNORE`）。
- server 测试跑法：`cd apps/server && npm test`；refinery 测试跑法：`cd tools/data-refinery && pytest`；web 检查：`cd apps/web && npm run lint && npm run build`。
- 本计划不实现考试/专项/错题的任何 HTTP 端点与页面（计划 2/3 的范围）；但 DB 表与 question_hints 表本计划全部建好。

---

### Task 1: DB 迁移——训练模块五张新表

**Files:**
- Create: `tools/db/migrations/2026-09-02_add_training_tables.sql`
- Modify: `tools/data-refinery/src/db_loader.py:345`（QUESTIONS_BLOCKERS 加 exam_answers）

**Interfaces:**
- Consumes: 无（纯 SQL）。
- Produces: 表 `exam_papers`、`paper_questions`、`question_hints`、`exam_sessions`、`exam_answers`；后续所有任务依赖这些表名与列名。

- [ ] **Step 1: 写迁移 SQL 文件**

```sql
-- 2026-09-02_add_training_tables.sql
-- 训练模块（考试/专项/错题练习）基础表。设计：docs/superpowers/specs/2026-09-02-math-training-module-design.md
-- 幂等：CREATE TABLE IF NOT EXISTS / ALTER 前检查 information_schema。

-- 试卷（爬取试卷的归组实体；source_key = published JSONL 相对路径，幂等键）
CREATE TABLE IF NOT EXISTS exam_papers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  grade VARCHAR(20) DEFAULT NULL,
  grade_band VARCHAR(20) DEFAULT NULL,
  semester VARCHAR(20) DEFAULT NULL,
  year SMALLINT DEFAULT NULL,
  district VARCHAR(50) DEFAULT NULL,
  exam_type VARCHAR(30) DEFAULT NULL,
  source_key VARCHAR(200) NOT NULL,
  question_count SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ep_source_key (source_key),
  CONSTRAINT fk_ep_subject FOREIGN KEY (subject_id) REFERENCES subjects (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 试卷-题目关联（多对多：content_hash 去重后同一题可属多卷；question_no 按 JSONL 行序）
CREATE TABLE IF NOT EXISTS paper_questions (
  paper_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  question_no SMALLINT NOT NULL,
  group_id VARCHAR(50) DEFAULT NULL,
  group_order SMALLINT DEFAULT NULL,
  PRIMARY KEY (paper_id, question_id),
  KEY idx_pq_question (question_id),
  CONSTRAINT fk_pq_paper FOREIGN KEY (paper_id) REFERENCES exam_papers (id) ON DELETE CASCADE,
  CONSTRAINT fk_pq_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 题级提示缓存（镜像 cards.hints 语义；训练题无卡，按 question_id 缓存）
CREATE TABLE IF NOT EXISTS question_hints (
  question_id BIGINT NOT NULL,
  hint TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (question_id),
  CONSTRAINT fk_qh_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 考试会话（服务器权威计时：deadline_at；状态 in_progress | submitted）
CREATE TABLE IF NOT EXISTS exam_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  paper_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  duration_minutes SMALLINT NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deadline_at DATETIME(3) NOT NULL,
  submitted_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_es_student_status (student_id, status),
  CONSTRAINT fk_es_paper FOREIGN KEY (paper_id) REFERENCES exam_papers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 考试逐题作答（is_correct NULL = 在途/未判；method: exact|ai|unanswered|failed）
CREATE TABLE IF NOT EXISTS exam_answers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  question_order SMALLINT NOT NULL,
  answer_text TEXT,
  is_correct TINYINT(1) DEFAULT NULL,
  method VARCHAR(10) DEFAULT NULL,
  analysis TEXT,
  error_type VARCHAR(20) DEFAULT NULL,
  judged_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ea_session_q (session_id, question_id),
  CONSTRAINT fk_ea_session FOREIGN KEY (session_id) REFERENCES exam_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_ea_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

注意：本迁移无需 ALTER 已有表（paper_questions 用关联表而非 questions.paper_id 列——spec §6.1 已定）。

- [ ] **Step 2: 在本地库执行迁移并验证**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-02_add_training_tables.sql
mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW CREATE TABLE exam_papers\G SHOW CREATE TABLE paper_questions\G" | head -40
```

Expected: 两表创建成功，无 SQL 报错；重复执行迁移文件不报错（幂等）。

- [ ] **Step 3: db_loader 守卫纳入 exam_answers**

`tools/data-refinery/src/db_loader.py` 第 345 行改为：

```python
    QUESTIONS_BLOCKERS = ["answers", "aux_error_books", "main_error_books", "variation_questions", "exam_answers"]
```

同时在该文件 QUESTIONS_BLOCKERS 定义附近的守卫查询逻辑处确认（若 purge_business_data 里对每个 blocker 做 `DELETE FROM t`，需同步把 exam_sessions 纳入清除序：先 exam_answers 后 exam_sessions）。在 `purge_business_data`（约 369 行）的清除列表前部加：

```python
        # FK 安全序：exam_answers -> exam_sessions 先于 questions blockers
        for t in ["exam_sessions"]:
            with self._conn.cursor() as cur:
                cur.execute(f"DELETE FROM {t}")
            deleted[t] = self._conn.cursor().rowcount if False else deleted.get(t, 0)
```

（实现时以现有 purge_business_data 的实际代码模式为准——镜像 `error_redo_logs` 的清除写法，把 `exam_sessions` 插到 `error_redo_logs` 同一位置，`exam_answers` 走 QUESTIONS_BLOCKERS 既有路径。上面伪代码仅示意位置，实现必须复刻现有行的风格。）

- [ ] **Step 4: 跑 refinery 测试确认守卫不回归**

Run: `cd tools/data-refinery && pytest tests/test_db_loader.py tests/test_db_loader_cli.py -q`
Expected: 全部 PASS（现有守卫测试 + 新增行为共存）。

- [ ] **Step 5: Commit**

```bash
git add tools/db/migrations/2026-09-02_add_training_tables.sql tools/data-refinery/src/db_loader.py
git commit -m "feat(db_loader): 训练模块五表迁移 + exam_answers 纳入 purge 守卫"
```

---

### Task 2: paper_meta 纯函数——从路径/文件名解析试卷元数据

**Files:**
- Create: `tools/data-refinery/src/paper_meta.py`
- Test: `tools/data-refinery/tests/test_paper_meta.py`

**Interfaces:**
- Consumes: 爬虫命名规则（`tools/crawler/src/classifier.py` 的 `filename()`/`storage_dir()`）：文件名 `{subject}-{grade}({semester_cn})-{year_code}-{district}-{exam_type}-{file_type}.pdf`（如 `数学-初三(下)-202407-海淀-模拟二-试卷.pdf`，year_code 是 6 位 `YYYYMM`）；目录 `{base}/{subject}/{level}/{semester}/{year}/`（level=初中/高中/小学，semester=first/second，year=4 位）。
- Produces:

```python
@dataclass(frozen=True)
class PaperMeta:
    subject: str          # "数学"
    grade: str            # "初三"
    grade_band: str       # "junior"（derive：小学->primary 初->junior 高->senior）
    semester: str         # "first" | "second"
    year: int             # 2024
    district: str         # "海淀"
    exam_type: str        # "模拟二"
    file_type: str        # "试卷" | "答案"
    title: str            # "2024 海淀 初三 模拟二"

def parse_paper_meta(rel_path: str) -> PaperMeta | None:
    """从 published JSONL 的相对路径解析。rel_path 形如
    '数学/初中/second/2024/数学-初三(下)-202407-海淀-模拟二-试卷.jsonl'。
    解析失败返回 None（调用方跳过该文件并 WARN）。"""
```

- [ ] **Step 1: 写失败测试**

```python
# tests/test_paper_meta.py
import pytest
from src.paper_meta import parse_paper_meta


def test_parse_full_path():
    m = parse_paper_meta("数学/初中/second/2024/数学-初三(下)-202407-海淀-模拟二-试卷.jsonl")
    assert m is not None
    assert m.subject == "数学"
    assert m.grade == "初三"
    assert m.grade_band == "junior"
    assert m.semester == "second"
    assert m.year == 2024
    assert m.district == "海淀"
    assert m.exam_type == "模拟二"
    assert m.file_type == "试卷"
    assert m.title == "2024 海淀 初三 模拟二"


def test_parse_first_semester_primary():
    m = parse_paper_meta("数学/小学/first/2023/数学-小六(上)-202301-东城-期中-试卷.jsonl")
    assert m is not None
    assert m.grade_band == "primary"
    assert m.semester == "first"
    assert m.year == 2023


def test_parse_senior():
    m = parse_paper_meta("数学/高中/first/2025/数学-高一(上)-202509-西城-期末-答案.jsonl")
    assert m is not None
    assert m.grade_band == "senior"
    assert m.file_type == "答案"


def test_parse_invalid_returns_none():
    assert parse_paper_meta("random/file.jsonl") is None
    assert parse_paper_meta("") is None
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && pytest tests/test_paper_meta.py -q`
Expected: FAIL（`ModuleNotFoundError: src.paper_meta` 或 ImportError）。

- [ ] **Step 3: 实现 paper_meta.py**

```python
# src/paper_meta.py
"""从 published JSONL 相对路径解析试卷元数据（爬虫 classifier 命名规则的逆操作）。

路径形如：数学/初中/second/2024/数学-初三(下)-202407-海淀-模拟二-试卷.jsonl
db_loader_cli 据此 find-or-create exam_papers（source_key = 相对路径去 .jsonl）。
"""

import re
from dataclasses import dataclass

_LEVEL_TO_BAND = {"小学": "primary", "初中": "junior", "高中": "senior"}
_SEMESTER_CN = {"上": "first", "下": "second"}

# 文件名：subject-grade(学期)-YYYYMM-district-exam_type-file_type
_FILENAME_RE = re.compile(
    r"^(?P<subject>[^-]+)-(?P<grade>[^-()]+)\((?P<sem_cn>[上下])\)"
    r"-(?P<year_code>\d{6})-(?P<district>[^-]+)-(?P<exam_type>[^-]+)"
    r"-(?P<file_type>试卷|答案)\.jsonl$"
)


@dataclass(frozen=True)
class PaperMeta:
    subject: str
    grade: str
    grade_band: str
    semester: str
    year: int
    district: str
    exam_type: str
    file_type: str
    title: str


def parse_paper_meta(rel_path: str) -> PaperMeta | None:
    parts = rel_path.replace("\\", "/").split("/")
    if len(parts) < 5:
        return None
    level, semester, year_dir = parts[-4], parts[-3], parts[-2]
    if level not in _LEVEL_TO_BAND or semester not in ("first", "second") or not year_dir.isdigit():
        return None
    m = _FILENAME_RE.match(parts[-1])
    if not m:
        return None
    year = int(m.group("year_code")[:4])
    sem = _SEMESTER_CN[m.group("sem_cn")]
    if sem != semester or year != int(year_dir):
        return None  # 文件名与目录不一致，视为脏数据
    return PaperMeta(
        subject=m.group("subject"),
        grade=m.group("grade"),
        grade_band=_LEVEL_TO_BAND[level],
        semester=semester,
        year=year,
        district=m.group("district"),
        exam_type=m.group("exam_type"),
        file_type=m.group("file_type"),
        title=f"{year} {m.group('district')} {m.group('grade')} {m.group('exam_type')}",
    )
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd tools/data-refinery && pytest tests/test_paper_meta.py -q`
Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/paper_meta.py tools/data-refinery/tests/test_paper_meta.py
git commit -m "feat(data-refinery): paper_meta 试卷元数据路径解析纯函数"
```

---

### Task 3: db_loader 试卷归组——find-or-create exam_papers + 写 paper_questions

**Files:**
- Modify: `tools/data-refinery/src/db_loader.py`（新增 `_find_or_create_paper`、改造 `load_questions`）
- Modify: `tools/data-refinery/src/db_loader_cli.py:190-195`（q_files 循环传 paper 上下文）
- Test: `tools/data-refinery/tests/test_db_loader.py`（追加）

**Interfaces:**
- Consumes: Task 2 的 `parse_paper_meta`；Task 1 的表；现有 `self._exec`/`self._query` 辅助（pymysql）。
- Produces:

```python
class DbLoader:
    def _find_or_create_paper(self, meta: PaperMeta, subject_id: int, source_key: str) -> int:
        """按 source_key 唯一键 find-or-create exam_papers，返回 paper_id。"""

    def load_questions(self, questions: list[dict], paper: tuple[PaperMeta, int] | None = None) -> int:
        """paper 非 None 时：每题（含 content_hash 命中复用的已有题）按行序 1..n 写
        paper_questions（INSERT IGNORE，跨卷重复题两卷共存）；结束时刷新 question_count。
        paper 为 None 时行为与现状完全一致（无试卷上下文的调用方）。"""
```

- [ ] **Step 1: 写失败测试（追加到 test_db_loader.py，复用现有 fixture 模式——先看文件里已有的 mock conn 模式，下面按其既有风格写）**

```python
# tests/test_db_loader.py 追加（import 区补：from src.paper_meta import PaperMeta）

class _FakeCursor:
    def __init__(self, results=None):
        self.queries = []
        self.results = results or []
    def execute(self, sql, params=None):
        self.queries.append((sql, params))
    def fetchone(self):
        return self.results.pop(0) if self.results else None
    def fetchall(self):
        return []
    def __enter__(self): return self
    def __exit__(self, *a): return False


def test_find_or_create_paper_inserts_when_missing():
    from src.db_loader import DbLoader
    loader = DbLoader.__new__(DbLoader)  # 跳过 __init__ 的真实连接
    cur = _FakeCursor(results=[None, (99,)])  # SELECT 无 -> INSERT -> lastrowid 经由 _exec 返回
    # 按现有 DbLoader._query/_exec 的 mock 方式调整；关键是断言：
    loader._conn = None  # 以现有测试的手法替换
```

**注意**：先读 `tests/test_db_loader.py` 现有测试如何构造 DbLoader（是否有 fake connection fixture），新测试必须复用同一手法，上面是行为规格不是逐字模板。核心断言（写成真实可跑的）：

1. `_find_or_create_paper`：SELECT 无命中时执行 INSERT（参数含 source_key），有命中时只 SELECT 不 INSERT；
2. `load_questions(questions, paper=(meta, 1))`：① 新题 INSERT questions 后 INSERT IGNORE paper_questions，question_no 按行序 1..n；② content_hash 命中已有题（`SELECT id ... LIMIT 1` 返回 `(123,)`）时不 INSERT questions 但**仍** INSERT IGNORE paper_questions（question_id=123）；③ 结束时 UPDATE exam_papers SET question_count = n；
3. `load_questions(questions)`（paper=None）不产生任何 paper_questions/paper 相关 SQL（回归）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && pytest tests/test_db_loader.py -q -k paper`
Expected: FAIL（方法不存在）。

- [ ] **Step 3: 实现**

`db_loader.py` 顶部 import 区加 `from paper_meta import PaperMeta`（同目录模块，参照文件内其他同目录 import 的写法——注意该文件内现有 import 风格是否带 `src.` 前缀，保持一致）。

在 `load_questions` 前新增：

```python
    def _find_or_create_paper(self, meta: "PaperMeta", subject_id: int, source_key: str) -> int:
        row = self._query(
            "SELECT id FROM exam_papers WHERE source_key=%s LIMIT 1", (source_key,)
        )
        if row:
            return int(row[0])
        self._exec(
            "INSERT INTO exam_papers (subject_id, title, grade, grade_band, semester, "
            "year, district, exam_type, source_key) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (subject_id, meta.title, meta.grade, meta.grade_band, meta.semester,
             meta.year, meta.district, meta.exam_type, source_key),
        )
        return int(self._query("SELECT LAST_INSERT_ID()")[0])
```

（`self._query`/`self._exec` 的真实返回形态以文件内现有实现为准——若 `_exec` 返回 lastrowid 则直接用；`_find_or_create_unit` 就在附近，镜像它的写法。）

改造 `load_questions`（现 1063-1087 行）：

```python
    def load_questions(self, questions: list[dict], paper: tuple["PaperMeta", int] | None = None) -> int:
        count = 0
        linked = 0
        for i, q in enumerate(questions, 1):
            sid = self._subject_id_by_code(normalize_subject(q.get("subject_id")))
            opts = q.get("options")
            content = q.get("content") or ""
            chash = content_hash(content)
            # 去重：content_hash 命中已有题则复用（跨卷重复题两卷共享同一 question 行）
            row = self._query("SELECT id FROM questions WHERE content_hash=%s LIMIT 1", (chash,))
            if row:
                qid = int(row[0])
            else:
                self._exec(
                    "INSERT INTO questions (subject_id, group_id, group_order, type, difficulty, "
                    "content, options, answer, explanation, material_text, material_url, "
                    "grade_band, source, source_year, content_hash) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (sid, q.get("group_id"), q.get("group_order"), q.get("type"), q.get("difficulty"),
                     content,
                     json.dumps(opts, ensure_ascii=False) if opts is not None else None,
                     q.get("answer") or "", q.get("explanation"), q.get("material_text"),
                     q.get("material_url"), q.get("grade_band"), q.get("source"), q.get("source_year"),
                     chash),
                )
                qid = int(self._query("SELECT LAST_INSERT_ID()")[0])
                count += 1
            if paper is not None:
                self._exec(
                    "INSERT IGNORE INTO paper_questions "
                    "(paper_id, question_id, question_no, group_id, group_order) "
                    "VALUES (%s,%s,%s,%s,%s)",
                    (paper[1], qid, i, q.get("group_id"), q.get("group_order")),
                )
                linked += 1
        if paper is not None:
            self._exec(
                "UPDATE exam_papers SET question_count=%s WHERE id=%s", (linked, paper[1])
            )
        self._conn.commit()
        return count
```

（返回值语义保持「新插入题数」，与现有调用方打印一致；`SELECT LAST_INSERT_ID()` 若与现有 `_exec` 风格冲突，改用其返回值。）

`db_loader_cli.py` 190-195 行改为：

```python
        total_q = 0
        for p in q_files:
            qs = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
            rel = p.relative_to(published_dir).as_posix()
            meta = parse_paper_meta(rel)
            paper_ctx = None
            if meta is not None and meta.file_type == "试卷":
                source_key = rel[: -len(".jsonl")]
                # subject_id 由 loader 内部按 meta.subject 归一（normalize_subject）
                paper_id = loader.find_or_create_paper_from_meta(meta, source_key)
                paper_ctx = (meta, paper_id)
            elif meta is None:
                print(f"[WARN] {rel}: 无法解析试卷元数据，题目照常入库但不归组", flush=True)
            n = loader.load_questions(qs, paper=paper_ctx)
            total_q += n
            print(f"[ok] {rel} -> {n} questions"
                  + (f"（paper={paper_ctx[1]}）" if paper_ctx else ""), flush=True)
```

并在 DbLoader 加便捷方法（`db_loader.py`）：

```python
    def find_or_create_paper_from_meta(self, meta: "PaperMeta", source_key: str) -> int:
        sid = self._subject_id_by_code(normalize_subject(meta.subject))
        return self._find_or_create_paper(meta, sid, source_key)
```

`db_loader_cli.py` import 区加 `from paper_meta import parse_paper_meta`（与文件内现有同目录 import 风格一致）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd tools/data-refinery && pytest tests/test_db_loader.py tests/test_db_loader_cli.py -q`
Expected: 全部 PASS（含既有 load_questions 测试——paper=None 默认参数保证向后兼容）。

- [ ] **Step 5: 真实库增量回填（可选但推荐，本机有数据）**

```bash
cd tools/data-refinery && python src/db_loader_cli.py --load-cards <按 docs/data-refinery-使用手册.md 的既有参数>
```

验证：

```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT id, title, question_count FROM exam_papers; SELECT COUNT(*) FROM paper_questions;"
```

Expected: exam_papers 行数 = 已发布试卷数；paper_questions 计数与 questions 中来自试卷的题量相当（跨卷重复题表现为两卷引用同一 question_id）。

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/db_loader.py tools/data-refinery/src/db_loader_cli.py tools/data-refinery/tests/test_db_loader.py
git commit -m "feat(db_loader): 试卷归组——exam_papers find-or-create + paper_questions 行序关联"
```

---

### Task 4: JudgeCoreService——判题核心抽取（题中心变体）

**Files:**
- Create: `apps/server/src/modules/practice/judge-core.service.ts`
- Create: `apps/server/src/modules/practice/judge-core.service.test.ts`
- Modify: `apps/server/src/modules/practice/practice.service.ts`（judge 委托 JudgeCore）
- Modify: `apps/server/src/modules/practice/practice.module.ts`（providers 加 JudgeCoreService）
- Modify: `apps/server/src/database/repositories/main-error-books.repo.ts`（新增 2 方法）
- Modify: `apps/server/src/database/repositories/questions.repo.ts`（新增 findById）

**Interfaces:**
- Consumes: `PracticeService.judge` 现有三路由逻辑（`apps/server/src/modules/practice/practice.service.ts:142-293`）；`JudgmentCapability.judge`；`QuestionsRepository`；`MainErrorBooksRepository`。
- Produces:

```ts
// judge-core.service.ts
export interface JudgeCoreQuestionInput {
  studentId: number;
  subjectId: number;
  questionId: number;        // 题中心：必传（训练题必来自题库）
  studentAnswer: string;
  source: string;            // 'targeted' | 'error_practice' | 'exam' | 'practice'
  sourceRefId?: number | null; // 考试传 session_id；practice 沿用现结构不经过此变体
}

@Injectable()
export class JudgeCoreService {
  async judgeQuestion(input: JudgeCoreQuestionInput): Promise<JudgeOutput>;
}
// JudgeOutput 与 practice.service.ts 现有同名接口字段一致（questionId/isCorrect/method/analysis/errorType/errorBookId）
```

```ts
// main-error-books.repo.ts 新增（只按 question_id 匹配，训练题必来自题库）
async findUnclearedByStudentQuestionId(studentId: number, questionId: number): Promise<MainErrorBookRow | null>;
async clearUnclearedByStudentQuestionId(studentId: number, questionId: number): Promise<void>;
```

```ts
// questions.repo.ts 新增
async findById(id: number): Promise<QuestionRow | null>;
```

- [ ] **Step 1: repo 方法 + 失败测试**

`main-error-books.repo.ts` 追加（镜像 66-82 行 `findUnclearedByStudentQuestion` 的写法）：

```ts
  /** 题中心变体：只按 question_id 匹配（训练模块用，训练题必来自题库、question_id 恒非空）。 */
  async findUnclearedByStudentQuestionId(
    studentId: number,
    questionId: number,
  ): Promise<MainErrorBookRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM main_error_books
       WHERE student_id = ? AND is_cleared = 0 AND question_id = ?
       LIMIT 1`,
      [studentId, questionId],
    );
    return (rows[0] as MainErrorBookRow) ?? null;
  }

  /** 题中心变体清零：该学生此题所有未清行一次性 is_cleared=1（不限 source）。 */
  async clearUnclearedByStudentQuestionId(studentId: number, questionId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE main_error_books SET is_cleared = 1, cleared_at = NOW(3)
       WHERE student_id = ? AND is_cleared = 0 AND question_id = ?`,
      [studentId, questionId],
    );
  }
```

`questions.repo.ts` 追加：

```ts
  async findById(id: number): Promise<QuestionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE id = ? AND is_active = 1`,
      [id],
    );
    return (rows[0] as QuestionRow) ?? null;
  }
```

写失败测试 `judge-core.service.test.ts`（复用 practice.service.test.ts 的 mk 模式）：

```ts
import { describe, it, expect, vi } from 'vitest';
import { JudgeCoreService } from './judge-core.service';

const mk = (overrides: any = {}) => ({
  questionsRepo: {
    findById: vi.fn().mockResolvedValue(null),
    findByContentHash: vi.fn().mockResolvedValue(null),
    findOrCreate: vi.fn(),
    deleteById: vi.fn(),
  },
  mainErrorRepo: {
    create: vi.fn().mockResolvedValue(42),
    findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null),
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(undefined),
  },
  structuring: { structure: vi.fn() },
  judgment: { judge: vi.fn() },
  ...overrides,
});

const mkSvc = (deps: ReturnType<typeof mk>) =>
  new JudgeCoreService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any);

describe('JudgeCoreService.judgeQuestion', () => {
  it('choice 命中 -> exact 比对，答错入错题本（source 透传）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'B', source: 'targeted' });
    expect(r.isCorrect).toBe(false);
    expect(r.method).toBe('exact');
    expect(deps.mainErrorRepo.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'targeted', question_id: 10, source_ref_id: null }));
    expect(deps.judgment.judge).not.toHaveBeenCalled();
  });

  it('答对 -> clearUnclearedByStudentQuestionId（不限 source 清零）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'A', source: 'error_practice' });
    expect(r.isCorrect).toBe(true);
    expect(deps.mainErrorRepo.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(1, 10);
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('题目不存在 -> 400（训练题必来自题库）', async () => {
    const deps = mk();
    const svc = mkSvc(deps);
    await expect(svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 999, studentAnswer: 'x', source: 'targeted' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('AI 判定失败 -> 503，不入错题本', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, type: 'proof', answer: '', options: null }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
      judgment: { judge: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    const svc = mkSvc(deps);
    await expect(svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'x', source: 'exam' }))
      .rejects.toMatchObject({ status: 503 });
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 JudgeCoreService**

把 `practice.service.ts` 的 `judge()` 三路由主体（142-293 行：路由判定、错题本 find-or-create、清零）抽到新文件，`PracticeService.judge` 保留 card 定位/结构化未入库题/practice_results 持久化，判题与错题本部分委托 JudgeCore。**抽取方式**：JudgeCore 暴露两个方法——

```ts
// judge-core.service.ts 核心骨架（完整实现 = 把 practice.service.ts 151-270 行的
// 三路由 + 错题本逻辑搬进来，questionId 定位改 findById，错误本 repo 方法换
// *ByStudentQuestionId 变体，source/source_ref_id 从入参透传）
import { Injectable, Logger, HttpException } from '@nestjs/common';

const EXACT_ONLY_TYPES = new Set(['choice', 'true_false']);
// normalizeAnswer / compareAnswer 从 practice.service.ts 原样搬来并 export
// （practice.service 重新 import，保证单一实现）

@Injectable()
export class JudgeCoreService {
  private readonly logger = new Logger(JudgeCoreService.name);

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly structuring: QuestionStructuringCapability,
    private readonly judgment: JudgmentCapability,
  ) {}

  /** 题中心判题（训练模块专用入口）。 */
  async judgeQuestion(input: JudgeCoreQuestionInput): Promise<JudgeOutput> {
    const q = await this.questionsRepo.findById(input.questionId);
    if (!q) {
      throw new HttpException({ code: 4004, message: '题目不存在' }, 400);
    }
    // ……三路由（镜像 practice.service.judge 151-187 行，q 已知非空所以无「未命中」分支）……
    // 答错：findUnclearedByStudentQuestionId -> create({..., source: input.source, source_ref_id: input.sourceRefId ?? null, lesson_id: null, question_n: null})
    // 答对：clearUnclearedByStudentQuestionId（best-effort try/catch）
    // 注意：题中心变体不写 practice_results（card_id NOT NULL 且无卡上下文），判题结果由调用方（exam: exam_answers；training: 无需持久化）自行落库。
    return { questionId: q.id, isCorrect, method, analysis, errorType, errorBookId };
  }

  /** card 中心判题（PracticeService.judge 委托，保持既有行为逐字节不变）。 */
  async judgeForPractice(input: JudgeInput, q: QuestionRow | null): Promise<JudgeOutput> {
    // ……practice.service.ts 151-293 行原样迁移（q 可为 null -> AI + 结构化入库路径保留）……
  }
}
```

`PracticeService.judge` 改为：content_hash 定位 q 后调 `judgeCore.judgeForPractice(input, q)`，再自己做 practice_results upsert（274-290 行留在 PracticeService）。`practice.module.ts` providers 加 `JudgeCoreService`，`PracticeService` 构造函数注入。

**红线**：`/api/practice/judge` 对外行为不变——跑完 practice.service.test.ts 全部 40+ 用例必须原样绿（这是抽取正确性的验收标准；测试本身不改，若与实现冲突按「测试错」规则审视，但预期不需要）。

- [ ] **Step 4: 全量回归**

Run: `cd apps/server && npm test`
Expected: 全绿（既有 72+ 用例 + judge-core 新用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/practice/ apps/server/src/database/repositories/main-error-books.repo.ts apps/server/src/database/repositories/questions.repo.ts
git commit -m "refactor(server): 抽取 JudgeCoreService 判题核心（题中心变体 + practice 委托）"
```

---

### Task 5: ChoiceOptionList 选择题点选组件

**Files:**
- Create: `apps/web/src/components/business/answer/ChoiceOptionList.tsx`

**Interfaces:**
- Consumes: 无（纯展示组件）。
- Produces（Task 6 的 QuestionRunner 消费）:

```ts
interface ChoiceOption { label: string; text: string }
interface Props {
  options: ChoiceOption[];
  value: string;                 // 当前选中的 label（如 'A'），空串 = 未选
  onChange: (label: string) => void;
  disabled?: boolean;
}
export function ChoiceOptionList({ options, value, onChange, disabled }: Props): JSX.Element;
```

- [ ] **Step 1: 实现组件**

```tsx
// apps/web/src/components/business/answer/ChoiceOptionList.tsx
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';

interface ChoiceOption { label: string; text: string }

interface Props {
  options: ChoiceOption[];
  value: string;
  onChange: (label: string) => void;
  disabled?: boolean;
}

/** 选择题点选作答：线性边框选项卡，点选高亮 brand 色，提交字母 label。
 *  样式遵循 CleanupPhase 的答题卡规范（--learn-* 变量、无 emoji、圆角卡片）。 */
export function ChoiceOptionList({ options, value, onChange, disabled = false }: Props) {
  return (
    <div className="flex flex-col gap-3 p-4" role="radiogroup" aria-label="选项">
      {options.map((opt) => {
        const selected = value === opt.label;
        return (
          <button
            key={opt.label}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(opt.label)}
            className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-colors ${
              selected
                ? 'border-[var(--brand-500)] bg-[var(--brand-100)]'
                : 'border-[var(--learn-card-border)] hover:border-[var(--brand-500)]/40'
            } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <span
              className={`shrink-0 w-7 h-7 rounded-full border flex items-center justify-center text-sm font-bold ${
                selected
                  ? 'border-[var(--brand-500)] bg-[var(--brand-500)] text-white'
                  : 'border-[var(--bg-subtle)] text-[var(--text-secondary)]'
              }`}
            >
              {opt.label}
            </span>
            <span className="flex-1 text-[15px] leading-relaxed text-[var(--text-primary)] [&>p]:my-0">
              <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                {opt.text}
              </ReactMarkdown>
            </span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: lint + build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/business/answer/ChoiceOptionList.tsx
git commit -m "feat(web): ChoiceOptionList 选择题点选作答组件"
```

---

### Task 6: QuestionRunner 共享答题组件

**Files:**
- Create: `apps/web/src/components/business/answer/QuestionRunner.tsx`
- Create: `apps/web/src/components/business/answer/types.ts`

**Interfaces:**
- Consumes: `LatexEditor`、`PreviewDraftPanel`、`draft-store.clearDraft`（均 `apps/web/src/components/business/`）；Task 5 的 `ChoiceOptionList`；`JudgeResult`（`apps/web/src/services/api.ts:576`）。
- Produces（计划 2/3 的考试/专项/错题页消费）:

```ts
// types.ts
export interface RunnerQuestion {
  n: string;          // 展示题号（考试用 question_no，错题用 questionN）
  text: string;       // 题面（Markdown+LaTeX）
  type?: string;      // 'choice' | 'true_false' | 'fill_blank' | 'short_answer' | 'proof'
  options?: Array<{ label: string; text: string }>;
}
export interface RunnerAnswerRecord {
  isCorrect: boolean;
  method: string;
  analysis: string | null;
  errorType?: string | null;
  studentAnswer: string;
  failed?: boolean;
}
```

```tsx
// QuestionRunner.tsx props（与 spec §4 一致）
interface QuestionRunnerProps {
  questions: RunnerQuestion[];
  subjectId: number;
  draftKeyPrefix: string;              // 单题草稿键 = `${draftKeyPrefix}-${q.n}`
  variant: 'modal' | 'embedded';
  answerMode?: 'auto' | 'text';        // 默认 'auto'：type=choice/true_false 且有 options 时点选
  enableHint?: boolean;
  hints?: Record<string, string>;      // key = q.n，父层持有（session 缓存）
  onRequestHint?: (q: RunnerQuestion) => Promise<string>;
  showResultFeedback?: boolean;        // 默认 true；考试置 false（不渲染判题对错反馈）
  onSubmit: (q: RunnerQuestion, answer: string) => Promise<JudgeResult>;
  onFinish: (results: Record<string, RunnerAnswerRecord>) => void;
  headerExtra?: React.ReactNode;       // 考试倒计时等插槽
  title?: string;                      // 顶部标题（默认「第 {i+1}/{n} 题」）
}
```

- [ ] **Step 1: 实现 types.ts + QuestionRunner.tsx**

实现要点（对照 `CleanupPhase.tsx` 的 answering 态 172-228 行与 `AnswerModal.tsx` 的 hint/进度逻辑）：

1. **布局**：embedded 变体复刻 CleanupPhase 的卡片布局（`--learn-card-max-w` 容器、题面 ReactMarkdown+KaTeX 头部区、LatexEditor 左半 + PreviewDraftPanel 右半、底部上一题/提交按钮）；modal 变体外层加 `fixed inset-0 z-50` 遮罩（镜像 AnswerModal）。`variant` 只影响外壳，内部答题区完全一致。
2. **选择题**：`answerMode === 'auto'` 且 `q.type` 为 choice/true_false 且 `q.options?.length` 时，右半区（LatexEditor+PreviewDraftPanel）替换为 `ChoiceOptionList`，value=answer、onChange=setAnswer；true_false 无 options 时渲染 是/否 两个选项（label `对`/`错`）。其余走文本作答。
3. **草稿**：`PreviewDraftPanel questionId={`${draftKeyPrefix}-${q.n}`} enabled={subjectId === MATH_SUBJECT_ID}`（MATH_SUBJECT_ID=1，照抄 CleanupPhase.tsx:16 注释）；提交后 `clearDraft(`${draftKeyPrefix}-${q.n}`)`。
4. **fire-and-forget 判题**：镜像 CleanupPhase 84-169 行——submit 时记录 pendingRef，切下一题不等判题；末题进 judging 态（spinner 页复刻 CleanupPhase 231-241 行），`Promise.allSettled` 后 `onFinish(resultsRef.current)`。
5. **hint**：`enableHint && onRequestHint` 时头部右上渲染问号图标按钮（复刻 AnswerModal 的 hint 交互：点击展开题面下方提示抽屉，hints[q.n] 命中直显，loading/error 态）；无 onRequestHint 则不渲染。
6. **showResultFeedback=false**（考试）：onSubmit 的 resolve 结果仍记入 resultsRef（供 onFinish），但**不**在 UI 任何位置显示对错（judging 态文案改为「正在提交」而非「判题中」——考试不泄露判题进度语义，仅显示等待）。
7. **headerExtra**：渲染在标题行右侧（`flex justify-between`，headerExtra 在右）。

组件结构（伪骨架，实现时以 CleanupPhase 为蓝本逐段搬运）：

```tsx
export function QuestionRunner(props: QuestionRunnerProps) {
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState('');
  const [phase, setPhase] = useState<'answering' | 'judging'>('answering');
  const [hintState, setHintState] = useState<{ show: boolean; loading: boolean; error: boolean }>({ show: false, loading: false, error: false });
  const resultsRef = useRef<Record<string, RunnerAnswerRecord>>({});
  const pendingRef = useRef<Map<number, Promise<unknown>>>(new Map());
  // ……状态与 handlers 按 CleanupPhase/AnswerModal 对应逻辑实现……
}
```

8. **不做的事**（YAGNI，计划 2/3 各页自管）：庆祝页、bumpErrorLevels、讨论抽屉（DiscussDrawer 是主线卡上下文专属，训练不带）、AnswerResultList 渲染（onFinish 后父层负责）。

- [ ] **Step 2: lint + build**

Run: `cd apps/web && npm run lint && npm run build`
Expected: 无错误（组件未被页面引用也须通过 tsc）。

- [ ] **Step 3: 手动冒烟（可选）**

在任一现有页面临时挂载 `<QuestionRunner questions={[{n:'1', text:'计算 $1+1$', type:'choice', options:[{label:'A',text:'2'},{label:'B',text:'3'}]}]} .../>` 验证点选/草稿/提交流，验证后删掉临时代码。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/business/answer/
git commit -m "feat(web): QuestionRunner 共享答题组件（草稿/点选/提示/考试反馈抑制）"
```

---

### Task 7: 入口选择页三轨改造 + 训练学科选择页

**Files:**
- Modify: `apps/web/src/pages/auth/EntrySelectPage.tsx`（双卡改三卡）
- Create: `apps/web/src/pages/student/TrainingSubjectPage.tsx`
- Modify: `apps/web/src/routes/index.tsx`（注册 `/student/training`）

**Interfaces:**
- Consumes: 无。
- Produces: 路由 `/student/training`（学科选择页，数学可入、其余禁用）；入口页第三张卡「训练」。计划 2/3 的子路由（`/student/training/exam|targeted|errors`）挂它下面。

- [ ] **Step 1: EntrySelectPage 加第三张卡**

中部 `grid grid-cols-1 md:grid-cols-2 gap-8`（67 行）改 `md:grid-cols-3 gap-6`，在答疑卡后追加训练卡（复制答疑卡结构，改三处：aria-label「进入训练」、onClick `navigate('/student/training')`、图标与文案）：

```tsx
const DumbbellIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
       strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11" />
  </svg>
);
```

训练卡视觉：与另两卡一致的白卡 + 线性图标；图标底渐变用品牌橘红系（`linear-gradient(to top right, #FF6B35, #FFB25A)`——与学习卡同色系但更亮，保持 style.md 单一色系约束；**不用蓝紫**，蓝色已留给答疑）。卡内文案「训练」。

- [ ] **Step 2: TrainingSubjectPage 学科选择页**

复刻 `SubjectSelectPage.tsx` 的布局骨架（先读该文件，沿用其卡片网格、学段/主题容器写法），差异：

```tsx
// 核心差异逻辑
const SUBJECTS = [
  { id: 1, name: '数学', enabled: true, desc: '考试 / 专项练习 / 错题练习' },
  { id: 2, name: '语文', enabled: false, desc: '敬请期待' },
  { id: 3, name: '英语', enabled: false, desc: '敬请期待' },
];
// 点击 enabled 学科 -> navigate('/student/training/exam')（考试为训练默认落地页；
// 计划 2 实现子页后，可在训练内自建 tab 切换，本页只负责进学科）
```

页面容器挂 `data-theme="student-day"` + `student-theme-container`（镜像 EntrySelectPage 的容器写法），顶部 BackButton 回 `/student/entry`。禁用学科卡片 `opacity-50 cursor-not-allowed`、角标「敬请期待」。

- [ ] **Step 3: 注册路由**

`routes/index.tsx` 在 `/student/auxiliary/conversations` 块后加：

```tsx
  // 训练轨（全屏沉浸层，独立于 StudentLayout，物理隔离；三轨入口之一）
  {
    path: '/student/training',
    element: (
      <RequireRole role="student">
        <TrainingSubjectPage />
      </RequireRole>
    ),
  },
```

import 区加 `import TrainingSubjectPage from '@/pages/student/TrainingSubjectPage';`。

- [ ] **Step 4: lint + build + 手动走查**

Run: `cd apps/web && npm run lint && npm run build`
手动：登录学生账号 → 入口页见三卡 → 点训练 → 学科页数学可入、语文英语禁用 → BackButton 回入口。
Expected: 全部正常，无 emoji，iPad 宽度下三卡不挤压。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/auth/EntrySelectPage.tsx apps/web/src/pages/student/TrainingSubjectPage.tsx apps/web/src/routes/index.tsx
git commit -m "feat(web): 入口页三轨改造（学习/答疑/训练）+ 训练学科选择页"
```

---

## 自检记录（Self-Review）

1. **Spec 覆盖**：spec §6.1（Task 1-3）、§5（Task 4）、§4（Task 5-6）、§3 导航（Task 7）全覆盖；spec §6.2 KP 种子、§7 功能端点、§8 文档同步属计划 2/3，未混入。
2. **占位符扫描**：Task 1 Step 3 的 purge 伪代码已标注「以现有代码模式为准」并给出精确锚点（QUESTIONS_BLOCKERS 行号、error_redo_logs 位置）——这是对既有代码的适配指令而非缺失内容；其余任务代码完整。
3. **类型一致性**：JudgeOutput 字段与 practice.service.ts:59-66 一致；RunnerQuestion/RunnerAnswerRecord 与 QuestionRunner props、AnswerResultList 的 PracticeQuestion/AnswerRecord 结构对齐（n/text、isCorrect/method/analysis/studentAnswer/failed）；paper_meta 的 PaperMeta 字段与 Task 3 的 INSERT 列一一对应。

## 后续计划（不在本文件）

- 计划 2/3：KP 种子 LLM 生成 + backfill_question_kps + 专项练习全栈 + 错题练习全栈（training 模块）。
- 计划 3/3：考试全栈（exams 模块：papers/sessions/answers/submit/results + 前端考试页/倒计时/结果页）+ API 双文档同步 + PRD/style.md 三轨修订 + AnswerModal/CleanupPhase 收敛。
