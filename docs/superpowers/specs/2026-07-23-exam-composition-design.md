# 智能组卷模块设计

> 日期：2026-07-23
> 对应文档：
> - [K12智学系统-产品需求文档.md](../K12智学系统-产品需求文档.md)（PRD §7.6）
> - [K12智学系统-架构设计文档.md](../K12智学系统-架构设计文档.md)（架构 §4.2.8 Assessment Service）
> - [K12智学系统-数据库设计文档.md](../K12智学系统-数据库设计文档.md)（DB §3.5 评测）
> - [K12智学系统-AI-Agent中枢设计文档.md](../K12智学系统-AI-Agent中枢设计文档.md)（§4.4 VariationCapability）

---

## 1. 定位与范围

### 1.1 定位

本文档定义 K12 智学系统智能组卷模块的完整设计，包括业务逻辑、数据库表、接口协议和 AI-Agent 参与方式。

### 1.2 核心决策

| 决策 | 结论 |
|------|------|
| 组卷主导方 | **Assessment Service**（确定性规则为主），AI-Agent 仅做题库不足时的补题兜底 |
| 知识点覆盖 | 算法确保覆盖率 ≥ 目标阈值，未覆盖知识点优先抽取 |
| 难度/题型配比 | 按 exam_type 预设配置（unit_test / midterm / final 各一套） |
| 去重窗口 | 固定 30 天，排除学生近期做过的题 |
| 薄弱的倾斜 | P1 实现，MVP 不包含 |
| AI 补题 | P1 实现，调用 VariationCapability.generate() |
| 组卷结果确定性 | 允许随机（每次结果可能不同），重考可遇不同题目 |

---

## 2. 触发场景

| 场景 | 触发条件 | 考试范围 | 预设表 key |
|------|----------|----------|-----------|
| 单元检测 | 单元最后一课完成 + 错题清零 | 当前单元的所有知识点 | `unit_test` |
| 期中考试 | 学期进度过半 | 前半学期所有单元 | `midterm` |
| 期末考试 | 全部单元学完 | 整学期所有单元 | `final` |

---

## 3. 数据库设计

### 3.1 现有表（直接复用）

| 表 | 关键字段 |
|----|---------|
| `assessments` | `type`, `scope_unit_ids`, `scope_semester_id`, `question_ids`, `time_limit_minutes`, `difficulty_distribution` |
| `homework_submissions` | `student_id`, `homework_id`, `created_at` |
| `assessment_submissions` | `student_id`, `assessment_id`, `created_at` |
| `answers` | `submission_type`, `submission_id`, `question_id`（JOIN submission → student_id 可知做过的题目） |
| `questions` | `subject_id`, `type`, `difficulty`, `grade_band`, `is_active` |
| `question_knowledge_points` | `question_id`, `knowledge_point_id`（M:N） |
| `knowledge_points` | `id`, `subject_id`, `name` |

### 3.2 新增表

```sql
-- 考试组卷预设配置
CREATE TABLE exam_presets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  exam_type VARCHAR(20) NOT NULL UNIQUE,  -- 'unit_test' / 'midterm' / 'final'
  total_questions SMALLINT NOT NULL,
  difficulty_ratio TEXT NOT NULL,          -- {"easy":4,"medium":8,"hard":3}
  type_ratio TEXT NOT NULL,               -- {"choice":8,"fill":4,"solve":3}
  coverage_target DECIMAL(3,2) NOT NULL DEFAULT 0.80,
  time_limit_minutes SMALLINT NOT NULL,
  dedup_window_days SMALLINT NOT NULL DEFAULT 30,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

-- 种子数据
INSERT INTO exam_presets (exam_type, total_questions, difficulty_ratio, type_ratio, coverage_target, time_limit_minutes) VALUES
('unit_test', 15, '{"easy":4,"medium":8,"hard":3}', '{"choice":8,"fill":4,"solve":3}', 0.80, 30),
('midterm',   25, '{"easy":6,"medium":12,"hard":7}', '{"choice":12,"fill":6,"solve":7}', 0.85, 60),
('final',     35, '{"easy":8,"medium":17,"hard":10}', '{"choice":15,"fill":10,"solve":10}', 0.90, 90);
```

---

## 4. 接口设计

### 4.1 Assessment Service 内部接口

```typescript
interface ComposeExamRequest {
  studentId: string;
  examType: 'unit_test' | 'midterm' | 'final';
  scope: {
    subjectId: string;
    unitIds: string[];
  };
}

interface ComposeExamResponse {
  examId: string;
  questions: ExamQuestion[];
  metadata: {
    totalQuestions: number;
    difficultyDistribution: Record<'easy' | 'medium' | 'hard', number>;
    typeDistribution: Record<'choice' | 'fill' | 'solve', number>;
    knowledgePointCoverage: number;       // 实际覆盖率 0-1
    coveredKnowledgePoints: string[];
    uncoveredKnowledgePoints: string[];
    timeLimitMinutes: number;
    aiGeneratedCount: number;             // P1，MVP=0
  };
}

interface ExamQuestion {
  questionId: string;
  type: 'choice' | 'fill_blank' | 'true_false' | 'short_answer' | 'proof';
  difficulty: 1 | 2 | 3;
  content: string;
  knowledgePointIds: string[];
  maxScore: number;
  source: 'question_bank' | 'ai_generated';
  order: number;
}
```

### 4.2 Content Service 查询接口

```typescript
interface QueryQuestionsRequest {
  subjectId: string;
  unitIds: string[];
  filters?: {
    types?: string[];
    difficulties?: number[];
    knowledgePointIds?: string[];
  };
  excludeQuestionIds?: string[];
  limit?: number;
}

interface QueryQuestionsResponse {
  questions: CandidateQuestion[];
  total: number;
}

interface CandidateQuestion {
  questionId: string;
  type: string;
  difficulty: 1 | 2 | 3;
  content: string;
  knowledgePointIds: string[];
  maxScore: number;
}
```

### 4.3 知识图谱服务接口

```typescript
interface GetKnowledgePointsByUnitsRequest {
  subjectId: string;
  unitIds: string[];
}

interface GetKnowledgePointsByUnitsResponse {
  knowledgePointIds: string[];  // 考试范围内应覆盖的全量知识点
}
```

### 4.4 学生答题历史查询（去重）

```typescript
// Assessment Service 内部方法
interface GetRecentAnsweredQuestionsRequest {
  studentId: string;
  subjectId: string;
  withinDays: number;
}

interface GetRecentAnsweredQuestionsResponse {
  questionIds: string[];  // 近期做过的题目 ID 集合
}
```

去重查询 SQL：
```sql
-- 近期做过的题目（作业 + 考试）
SELECT DISTINCT a.question_id
FROM answers a
JOIN homework_submissions hs 
  ON a.submission_type = 'homework' AND a.submission_id = hs.id
WHERE hs.student_id = :studentId 
  AND hs.created_at > DATE_SUB(NOW(), INTERVAL :withinDays DAY)
UNION
SELECT DISTINCT a.question_id
FROM answers a
JOIN assessment_submissions asub 
  ON a.submission_type = 'assessment' AND a.submission_id = asub.id
WHERE asub.student_id = :studentId 
  AND asub.created_at > DATE_SUB(NOW(), INTERVAL :withinDays DAY)
```

---

## 5. 核心算法流程

```
┌─────────────────────────────────────────────────┐
│             ExamComposer.compose()               │
├─────────────────────────────────────────────────┤
│                                                  │
│  1. 加载预设 (exam_presets WHERE exam_type)      │
│     │                                            │
│  2. 计算知识点全集                                │
│     │  (KG Service: scope.unitIds → kpIds[])     │
│     │                                            │
│  3. 查询近期做过的题 (去重，30天窗口)               │
│     │                                            │
│  4. 计算 type-diff 交叉配额                       │
│     │  如 total=15, diff={e:4,m:8,h:3},         │
│     │     type={c:8,f:4,s:3}                    │
│     │  → {c:{e:2,m:5,h:1}, f:{e:1,m:2,h:1},    │
│     │     s:{e:1,m:1,h:1}}                      │
│     │                                            │
│  5. 按配额逐组抽取                                │
│     │  a. 查询候选 (type + diff, 排除已知题)       │
│     │  b. 按知识点覆盖优先级排序（新知识点优先）      │
│     │  c. 取前 N 道，更新覆盖状态                  │
│     │                                            │
│  6. 覆盖校验 → 不足时补充                          │
│     │                                            │
│  7. 总量检查                                      │
│     │  不足→ MVP: 放宽约束重查                     │
│     │        P1:  调用 AI 补题                     │
│     │                                            │
│  8. 组装输出                                      │
│     │  随机打乱 + 题型分组排序                      │
│     ▼                                            │
│  ComposeExamResponse                             │
└─────────────────────────────────────────────────┘
```

### 知识点优先级排序算法

```typescript
// 知识点覆盖追踪器
class CoverageTracker {
  private covered = new Set<string>();
  
  constructor(private allKpIds: string[]) {}

  add(kpIds: string[]) {
    kpIds.forEach(id => this.covered.add(id));
  }

  isCovered(kpId: string): boolean {
    return this.covered.has(kpId);
  }

  // 计算某题能带来多少个"新"知识点
  noveltyScore(q: CandidateQuestion): number {
    return q.knowledgePointIds.filter(id => !this.isCovered(id)).length;
  }

  check(target: number): CoverageResult {
    const rate = this.covered.size / this.allKpIds.length;
    return {
      rate,
      isSufficient: rate >= target,
      covered: [...this.covered],
      uncovered: this.allKpIds.filter(id => !this.covered.has(id)),
    };
  }
}
```

### 配额计算示例

```typescript
// 输入
const preset = {
  total_questions: 15,
  difficulty_ratio: { easy: 4, medium: 8, hard: 3 },
  type_ratio: { choice: 8, fill: 4, solve: 3 }
};

// 计算：每种 type-diff 组合的题目数
// type_ratio 决定该种类型的总题数
// difficulty_ratio 决定该种难度的总题数
// 交叉分配 = type_count × (diff_ratio / total)
// 如：choice 共 8 题，其中 easy = floor(8 × 4/15) = floor(2.13) = 2

// 结果（取整后微调使总和 = total）：
const quotas = {
  choice: { easy: 2, medium: 4, hard: 2 },  // sum = 8
  fill:   { easy: 1, medium: 2, hard: 1 },  // sum = 4
  solve:  { easy: 1, medium: 2, hard: 0 },  // sum = 3
};
```

---

## 6. AI-Agent 参与方式（P1）

### 6.1 调用时机

仅当题库不足（已选题目数 < preset.total_questions 且无更多候选）时触发。

### 6.2 调用流程

```typescript
// P1 实现
async function aiGenerateSupplement(
  shortage: number,
  uncoveredKps: string[],
  request: ComposeExamRequest,
): Promise<ExamQuestion[]> {
  const results: ExamQuestion[] = [];
  
  for (const kpId of uncoveredKps.slice(0, shortage)) {
    // 找一道同知识点的题作为"原题"模板
    const original = await contentService.findAnyQuestionByKp(kpId);
    if (!original) continue;
    
    // 调用 AI-Agent 中枢 VariationCapability
    const variation = await aiAgent.variation.generate({
      originalQuestion: original,
      knowledgePoint: await kgService.getKp(kpId),
      count: 1,
    });
    
    results.push({
      ...variation.variations[0],
      questionId: `ai_gen_${generateId()}`,
      source: 'ai_generated',
    });
  }
  
  return results;
}
```

### 6.3 AI 不可用时的降级

AI 服务不可用时（额度耗尽 / 模型错误 / 网络超时），组卷逻辑不阻塞：
- 用放宽约束后的题库查询结果补充（MVP 行为）
- 试卷元数据记录 `uncoveredKnowledgePoints`，标记覆盖率不足
- 学生端提示"部分题目来自历史题库，覆盖率可能不足"

---

## 7. MVP vs P1 阶段划分

| 模块 | MVP | P1 |
|------|-----|----|
| 预设驱动组卷 | ✅ | — |
| 知识点覆盖优化 | ✅ | — |
| 难度/题型配比 | ✅ | — |
| 30天去重 | ✅ | — |
| 随机打乱 + 题型分组排序 | ✅ | — |
| 覆盖不足放宽约束 | ✅ | — |
| AI 补题（VariationCapability） | ❌ | ✅ |
| 薄弱点加权抽取 | ❌ | ✅ |
| 运营后台管理预设 | ❌ | ✅ |

---

## 8. 错误处理与边界情况

| 边界情况 | 处理策略 |
|----------|----------|
| 题库完全为空 | 组卷失败，返回错误码 `INSUFFICIENT_QUESTIONS`，提示"题库建设中，请稍后再试" |
| 去重后无可用题 | 缩短去重窗口（30→15→7天递降），仍不够则跳过去重 |
| 某 knowledge_point 完全无对应题目 | 设为 uncovered，允许部分跳过 |
| 预设配置不存在 | 使用默认配置（`total=15, diff=均衡, type=均衡, coverage=0.8`） |
| 配额计算总和与 total 不一致 | 取整微调，优先补 medium 难度题目 |

---

## 9. 验证要点

1. **与数据库设计对照**：exam_presets 表与 `assessments.difficulty_distribution` 字段的关系一致，不重复存储
2. **与 PRD §7.6 对照**：单元检测/期中/期末三种场景均覆盖
3. **与架构 §4.2.8 对照**：组卷由 Assessment Service 主导，AI 仅做补题兜底
4. **与 AI-Agent 中枢设计对照**：VariationCapability.generate() 接口匹配
