# 训练模块（考试 / 专项练习 / 错题练习）设计文档

日期：2026-09-02
状态：已与用户逐节确认

## 1. 背景与目标

数学学科新增三大训练能力，共用同一套答题与判题基础设施：

- **考试**：整卷作答、限时、逐题后台判题、交卷判分。
- **专项练习**：按知识点（专项）+ 题型 + 题量随机抽题，带提示/解析。
- **错题练习**：按时间范围 / 题型 / 专项筛选错题本重练，答对即清零。

现状关键结论（已核实）：

- 答题界面存在两套相似实现（`AnswerModal.tsx` 课堂练习带提示/讨论；`CleanupPhase.tsx` 错题清零不带），需抽共享组件。
- 判题链路现成：`PracticeService.judge`（`apps/server/src/modules/practice/practice.service.ts:142`）已实现「choice/true_false exact 比对 → fill_blank 归一化 → AI 判定」三路由 + 错题本 find-or-create + 答对清零，但为 card 中心（cardId/lessonId/questionN 必传）。
- `questions` 表有 type/difficulty/answer/explanation/source_year/content_hash，**无试卷归组**（无 paper_id）。
- `question_knowledge_points` / `knowledge_points` **均为空表**，题目无知识点标注；现有 `card_labeler.py` 仅标注教材卡片。
- `assessments` 表为试卷形状但 schema-only 且语义（单元检测/作业）不匹配，不复用。

## 2. 产品决策记录（用户确认）

| 决策点 | 结论 |
|---|---|
| 入口结构 | 入口选择页由双轨改**三轨**：【学习】【答疑】【训练】；训练 → 学科选择（数学）→ 考试/专项/错题 |
| 专项数据源 | 新增 LLM 题目知识点标注环节（管线目前只标题型+难度，无标注） |
| 错题入本 | 考试、专项练习答错的题**全部自动入错题本**（source 区分来源） |
| 考试时长 | 用户选时长（60/90/120 分钟档，系统给推荐值） |
| 判分方式 | 只算对错（X/Y 题 + 正确率），不算分数 |
| 做题顺序 | 考试整卷按原卷题号顺序，不按题型重排 |
| 清零联动 | 辅线错题练习答对即 `is_cleared=true`，主线门禁自动解锁 |
| 错题「按时间做」 | 指按时间范围**筛选**错题，非限时模式 |

## 3. 导航结构

```
登录 → 入口选择页【学习】【答疑】【训练】（原双轨改三轨）
         ├→ 学习 = 原主线（星图/课程详情/错题清零门禁，不动）
         ├→ 答疑 = 原辅线（自由探索，不动）
         └→ 训练 → /student/training 学科选择（数学可入，其余禁用态留扩展）
                    ├→ /student/training/exam        考试
                    ├→ /student/training/targeted    专项练习
                    └→ /student/training/errors      错题练习
```

- 训练路由与主线/辅线同级、全屏沉浸层（`.student-theme-container`，日夜主题生效）、RequireRole student、路由物理隔离。
- 现有 StudentLayout 内 `/student/exam` 等占位路由不动（P2 期中/期末语义），训练不走它们。
- **PRD 与 `apps/web/style.md` §2.6 入口选择页规范需同步修订**（双轨描述改三轨），随实施一并完成。
- 设计约束照旧：无 emoji、线性 SVG 图标、style.md 单一色系、iPad 横屏 ≥1024px 主断点、主线/辅线品牌色规范。

## 4. 共享答题组件（前端）

新目录 `apps/web/src/components/business/answer/`：

- **`QuestionRunner.tsx`** — 从 AnswerModal / CleanupPhase 提取共同核心（题面 ReactMarkdown+KaTeX 渲染、LatexEditor + PreviewDraftPanel 双栏、fire-and-forget 判题 + pending 进度追踪、judging 等待态）。

```ts
interface RunnerQuestion { n: string; text: string; type?: string; options?: Array<{label: string; text: string}> }
interface QuestionRunnerProps {
  questions: RunnerQuestion[];
  subjectId: number;
  draftKeyPrefix: string;                 // 'card-12' | 'exam-3' | 'err-88'（草稿键隔离）
  variant: 'modal' | 'embedded';
  answerMode: 'auto' | 'text';            // auto: choice/true_false 渲染点选
  enableHint?: boolean;                   // 考试关，专项/错题开
  onRequestHint?: (q: RunnerQuestion) => Promise<string>;
  onSubmit: (q: RunnerQuestion, answer: string) => Promise<JudgeResult>;
  onFinish: (results: Record<string, AnswerRecord>) => void;
  headerExtra?: ReactNode;                // 考试倒计时插槽
}
```

- **`ChoiceOptionList.tsx`** — 选择题点选作答（线性边框选项卡，点选高亮 brand 色，提交字母 label）。判题后端 `compareAnswer` 已支持 options/label 比对，后端无需改动。
- 复用方式：考试页 = QuestionRunner(embedded, answerMode:'auto', 无 hint) + 顶部倒计时；专项/错题页 = QuestionRunner(embedded, enableHint)；结果页复用 `AnswerResultList`。
- AnswerModal / CleanupPhase 后续改造为消费 QuestionRunner（**收尾任务**，新页面不依赖旧组件改造完成）。

## 5. 共享判题核心（后端）

- 把 `PracticeService.judge` 的「定位题目 → exact/AI 三路由 → 错题本 find-or-create / 答对清零」抽成 **`JudgeCoreService`**，practice / training / exams 三模块共用。
- 题中心变体入参：`{studentId, subjectId, questionId, studentAnswer, source, sourceRefId?}`——直接按 id 取题（不经 content_hash）。
- 错题本去重/清零用新增 repo 方法 `findUnclearedByStudentQuestionId` / `clearUnclearedByStudentQuestionId`（只按 question_id 匹配，训练题必来自题库）。
- `/api/practice/judge` 行为不变，回归测试保障。

## 6. 数据层

### 6.1 试卷归组

新建 `exam_papers` 表 + `questions.paper_id` 列（不复用 assessments，理由见 §1）：

```sql
CREATE TABLE exam_papers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,           -- 如 "2024 海淀 初三 模拟二"
  grade VARCHAR(20), grade_band VARCHAR(20), semester VARCHAR(20),
  year SMALLINT, district VARCHAR(50), exam_type VARCHAR(30),
  source_key VARCHAR(200) NOT NULL,      -- 幂等键：published JSONL 相对路径（去 .jsonl）
  question_count SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ep_source_key (source_key),
  CONSTRAINT fk_ep_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
);
ALTER TABLE questions ADD COLUMN paper_id BIGINT DEFAULT NULL,
  ADD KEY idx_q_paper (paper_id),
  ADD CONSTRAINT fk_q_paper FOREIGN KEY (paper_id) REFERENCES exam_papers(id) ON DELETE SET NULL;
```

**管线改动**（`tools/data-refinery/src/db_loader.py` + `db_loader_cli.py`）：

- 新增 `paper_meta.py` 纯函数：从目录路径 + 文件名确定性解析元数据（爬虫命名规则 `数学/初中/second/2024/数学-初三(下)-202507-海淀-模拟二-试卷`，复用 classifier 规则），pytest 覆盖。
- `db_loader_cli` 每份试卷文件先 find-or-create paper（source_key 唯一键幂等，同 edition 4 元组思路）；`load_questions(questions, paper_id)` INSERT 带 paper_id。
- **content_hash 命中已有题时补 UPDATE paper_id**——已入库题目无需清库，增量跑一遍 `--load-cards` 即完成归组回填 + question_count 刷新。
- full-reload 不删 exam_papers；`exam_answers` 加入 `db_loader.py` 的 `QUESTIONS_BLOCKERS`（FK RESTRICT 方向），纳入既有 purge 守卫体系。

### 6.2 知识点标注管线

1. **KP 种子**：人工整理初中数学两级知识点树约 100–150 个（数与式/方程与不等式/函数/三角形/四边形/圆/图形变换/统计与概率…），落 `tools/db/seeds/math_knowledge_points.sql`（INSERT IGNORE，subject_id/parent_kp_id/name/code/grade_band='junior'），install_mysql.sh 追加执行。
2. **标注脚本**：`tools/data-refinery/` 新增 `backfill_question_kps.py`——遍历 `question_knowledge_points` 无记录的题目，每批 ~10 题调本地 llama.cpp（`create_llm_client`，`LLM_BASE_URL`/`LLM_AUTH_TOKEN`，**勿用 ANTHROPIC_***），prompt 附 KP 白名单（id+name），每题输出 1–3 个 kp_id，白名单校验（非法丢弃/重试，复用 card_labeler 思路），`INSERT IGNORE` 写 `question_knowledge_points`（role='primary'）。
3. **幂等**：已有 qkp 行的题跳过，重跑安全；失败题打印清单可重跑。存量题一次回填，新题增量重跑。
4. **质量验收**：标注结果抽样人工校对后再开放专项筛选维度。

## 7. 功能设计

### 7.1 考试（`apps/server/src/modules/exams/`）

**数据**（会话落 DB，刷新/断线不丢进度）：

```sql
CREATE TABLE exam_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL, paper_id BIGINT NOT NULL, subject_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',   -- in_progress | submitted
  duration_minutes SMALLINT NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deadline_at DATETIME(3) NOT NULL,                    -- 服务器权威计时
  submitted_at DATETIME(3) DEFAULT NULL,
  created_at/updated_at,
  KEY idx_es_student_status (student_id, status),
  CONSTRAINT fk_es_paper FOREIGN KEY (paper_id) REFERENCES exam_papers(id)
);
CREATE TABLE exam_answers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NOT NULL, question_id BIGINT NOT NULL,
  question_order SMALLINT NOT NULL,
  answer_text TEXT, is_correct TINYINT(1) DEFAULT NULL,
  method VARCHAR(10), analysis TEXT, error_type VARCHAR(20),
  judged_at DATETIME(3) DEFAULT NULL,
  created_at/updated_at,
  UNIQUE KEY uniq_ea_session_q (session_id, question_id),
  CONSTRAINT fk_ea_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT
);
```

（不复用多态 `answers` 表：其 max_score NOT NULL / RESTRICT 语义与本场景不符。）

**端点与流程**：

| 端点 | 说明 |
|---|---|
| `GET /api/exams/papers?subjectId&year&district&examType&gradeBand` | 试卷列表（含 question_count） |
| `GET /api/exams/papers/:id` | 题目元数据（id/order/type/options，**不含 answer/explanation**）+ 推荐时长（客观题 ×1min + 主观题 ×3min，向上取整到 15 的倍数，clamp 30–180） |
| `POST /api/exams/sessions {paperId, durationMinutes}` | 创建会话；同卷已有 in_progress 则返回续考。题目顺序 = `ORDER BY group_order`（原卷顺序） |
| `GET /api/exams/sessions/:id` | 恢复：题目 + 已答状态（不回传判题对错）+ `remainingSeconds`（服务器算） |
| `POST /api/exams/sessions/:id/answers {questionId, answerText}` | 单题提交走 JudgeCore；答错入错题本（source='exam', source_ref_id=session_id）；upsert exam_answers；**超 deadline 拒收 409** |
| `POST /api/exams/sessions/:id/submit` | 收卷：未作答题按错计（method='unanswered'）并入错题本；在途判题同步补判（限 judgment per-scene 90s，超时按错计 method='failed'）；汇总对错 + 百分比；status=submitted |
| `GET /api/exams/sessions/:id/results` | 逐题对错 + analysis + questions.explanation |

**前端页面**：试卷列表（筛选 + 时长选择含推荐默认值）→ 考试进行页（QuestionRunner + 恒显大倒计时，倒计时归零即调 submit）→ 结果页（得分 + AnswerResultList）。

### 7.2 专项练习（`apps/server/src/modules/training/`）

- `GET /api/training/knowledge-points?subjectId&gradeBand` — KP 树（级联选择）。
- `POST /api/training/targeted/start {subjectId, kpId, type, count}` — 随机抽题（`JOIN question_knowledge_points WHERE kp_id=? AND type=? AND is_active=1 ORDER BY RAND() LIMIT ?`，repo 新增 `findRandomByKpAndType`）；返回题单（不含答案解析）；无会话表，前端持题单。
- `POST /api/training/judge {questionId, studentAnswer, subjectId, source}` — JudgeCore；source='targeted'|'error_practice'。
- `POST /api/training/hint {questionId}` — HintCapability + **`question_hints` 表**（`question_id BIGINT UNIQUE, hint TEXT`，镜像 cards.hints 题级缓存）。

### 7.3 错题练习（同 training 模块）

- `GET /api/training/error-book?subjectId&from&to&type&kpId` — 默认 `is_cleared=0`；JOIN questions 取题型/题面、LEFT JOIN qkp 取专项（未标注题该维度为空，渐进可用）。
- 作答流与专项一致（source='error_practice'）。
- **答对 → `clearUnclearedByStudentQuestionId`** → 主线门禁（CourseDetailPage 读 `GET /practice/uncleared-errors` 同表）自动解锁，零额外改动。
- 本次仍错的题收尾调既有 `POST /api/practice/bump-error-levels`，与错题清零 level 语义一致。

## 8. API 文档同步

- `docs/API接口与数据流设计文档.md` §4 新增「Training — /api/training」「Exams — /api/exams」两小节（阶段=MVP），§6 补考试数据流。
- `docs/api/openapi.yaml` 同步收录全部新端点。
- 变更后 grep 两文档端点路径清单核对无遗漏。

## 9. 测试策略

- **server（vitest，仿 `practice.service.test.ts` mock 模式）**：JudgeCore 三路由与题中心变体；exam 会话生命周期（建/续、deadline 拒答、submit 未答判错入错题本、在途补判、得分）；targeted 随机抽题；错题筛选；清零交互（答对后 uncleared 为空）。capability 注入 mock ModelClient。
- **python（pytest）**：`paper_meta.py` 解析；db_loader 归组 + paper_id 回填；`backfill_question_kps.py` mock LLM 的白名单校验/幂等/失败重试。
- **web**：`npm run lint` + 手动走查（主题 × 学段字号）。

## 10. 实施顺序（依赖驱动）

1. DB 迁移 + 数学 KP 种子 SQL。
2. 管线：paper_meta 解析 + db_loader 归组 + `--load-cards` 重跑回填 paper_id（解锁考试数据）。
3. JudgeCoreService 抽取（practice 回归绿）。
4. QuestionRunner + ChoiceOptionList（新页面先用；AnswerModal/CleanupPhase 收敛为收尾任务）。
5. **错题练习全栈**（最薄、无 KP 依赖，先落地）。
6. KP 标注回填 + **专项练习全栈**。
7. **考试全栈**（会话/倒计时/交卷/结果）。
8. 文档同步（API 双文档 + PRD/style.md 入口页三轨修订）+ 组件收敛 + 全链路手动回归。

## 11. 风险与边界

- 考试 submit 同步补判在多题在途时可能拖长请求——限补判超时（judgment 90s）并对超时按错处理。
- `RAND()` 抽题在题库万级以内无性能问题。
- KP 标注质量依赖本地 Qwen——prompt 附白名单 + 少样本，抽样人工校对后再开放。
- 训练侧新错题不会反向阻塞主线门禁（门禁查询只看 source='practice'），语义正确。
