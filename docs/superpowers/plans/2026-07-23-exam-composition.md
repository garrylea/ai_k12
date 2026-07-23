# 智能组卷模块 — 实现计划

> **For agentic workers:** Use superpowers:executing-plans 来逐个任务实现。步骤使用 checkbox (`- [ ]`) 语法跟踪。

**Goal:** 在 Assessment Service 中实现 MVP 组卷能力——预设驱动的知识点覆盖优化组卷算法，含难度/题型配比、30天去重和边界处理。

**Architecture:** `ExamComposer` 类作为 Assessment Service 内部模块，调用 Content Service（题库）、KG Service（知识点全集）和自身查询（去重），输出结构化试卷。P1 AI 补题预留接口但不实现。

**Tech Stack:** Node.js 20 + TypeScript + MySQL 9.7.1 + 现有 schema.sql

**关键参考文档:**
- Spec: `docs/superpowers/specs/2026-07-23-exam-composition-design.md`
- DB Schema: `tools/db/schema.sql`
- 架构: `docs/K12智学系统-架构设计文档.md` §4.2.8

---

### Task 1: 数据库 — 新增 exam_presets 表 + 种子数据

**Files:**
- Modify: `tools/db/schema.sql`

**说明:** `schema.sql` 由 `install_mysql.sh` 加载（详见 DB 设计文档 §3.12 Seed 约定）。新增表放在 `assessments` 表之后，种子数据用 `INSERT IGNORE`（幂等安全）。

- [ ] **Step 1: 在 schema.sql 的 assessments 表后添加 exam_presets 建表语句**

在 `assessments` 表的 `CREATE TABLE` 语句之后插入以下内容：

```sql
--
-- 考试组卷预设（引用数据，幂等 seed）
--
CREATE TABLE IF NOT EXISTS exam_presets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  exam_type VARCHAR(20) NOT NULL,
  total_questions SMALLINT NOT NULL,
  difficulty_ratio TEXT NOT NULL,        -- {"easy":4,"medium":8,"hard":3}
  type_ratio TEXT NOT NULL,              -- {"choice":8,"fill":4,"solve":3}
  coverage_target DECIMAL(3,2) NOT NULL DEFAULT 0.80,
  time_limit_minutes SMALLINT NOT NULL,
  dedup_window_days SMALLINT NOT NULL DEFAULT 30,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_exam_presets_type (exam_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER //
CREATE TRIGGER IF NOT EXISTS trg_exam_presets_updated_at
BEFORE UPDATE ON exam_presets
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(3);
END;
//
DELIMITER ;
```

- [ ] **Step 2: 在 schema.sql 末尾的 seed 区域添加种子数据**

在 schema.sql 已有的 seed 区域（`subjects` 的 `INSERT IGNORE` 之后）追加：

```sql
INSERT IGNORE INTO exam_presets (exam_type, total_questions, difficulty_ratio, type_ratio, coverage_target, time_limit_minutes) VALUES
('unit_test', 15, '{"easy":4,"medium":8,"hard":3}', '{"choice":8,"fill":4,"solve":3}', 0.80, 30),
('midterm',   25, '{"easy":6,"medium":12,"hard":7}', '{"choice":12,"fill":6,"solve":7}', 0.85, 60),
('final',     35, '{"easy":8,"medium":17,"hard":10}', '{"choice":15,"fill":10,"solve":10}', 0.90, 90);
```

- [ ] **Step 3: 提交**

```bash
git add tools/db/schema.sql
git commit -m "feat(db): add exam_presets table with seed data for unit_test/midterm/final"
```

---

### Task 2: 创建组卷类型定义文件

**Files:**
- Create: `apps/server/src/services/assessment/exam-composer.types.ts`

- [ ] **Step 1: 创建类型文件**

```typescript
// apps/server/src/services/assessment/exam-composer.types.ts

// ── 预设配置 ──
export interface ExamPreset {
  examType: 'unit_test' | 'midterm' | 'final';
  totalQuestions: number;
  difficultyRatio: Record<'easy' | 'medium' | 'hard', number>;
  typeRatio: Record<string, number>;
  coverageTarget: number;      // 0-1
  timeLimitMinutes: number;
  dedupWindowDays: number;
}

// ── 组卷请求 ──
export interface ComposeExamRequest {
  studentId: string;
  examType: 'unit_test' | 'midterm' | 'final';
  scope: {
    subjectId: string;
    unitIds: string[];
  };
}

// ── 组卷响应 ──
export interface ComposeExamResponse {
  examId: string;
  questions: ExamQuestion[];
  metadata: ExamMetadata;
}

export interface ExamQuestion {
  questionId: string;
  type: string;
  difficulty: 1 | 2 | 3;
  content: string;
  knowledgePointIds: string[];
  maxScore: number;
  source: 'question_bank' | 'ai_generated';
  order: number;
}

export interface ExamMetadata {
  totalQuestions: number;
  difficultyDistribution: Record<string, number>;
  typeDistribution: Record<string, number>;
  knowledgePointCoverage: number;
  coveredKnowledgePoints: string[];
  uncoveredKnowledgePoints: string[];
  timeLimitMinutes: number;
  aiGeneratedCount: number;
}

// ── Content Service 查询接口 ──
export interface QueryQuestionsRequest {
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

export interface CandidateQuestion {
  questionId: string;
  type: string;
  difficulty: 1 | 2 | 3;
  knowledgePointIds: string[];
  maxScore: number;
}

export interface QueryQuestionsResponse {
  questions: CandidateQuestion[];
  total: number;
}

// ── KG Service 接口 ──
export interface KPScopeRequest {
  subjectId: string;
  unitIds: string[];
}

export interface KPScopeResponse {
  knowledgePointIds: string[];
}

// ── 去重查询 ──
export interface RecentQuestionsRequest {
  studentId: string;
  subjectId: string;
  withinDays: number;
}

export interface RecentQuestionsResponse {
  questionIds: string[];
}

// ── 配额 ──
export type DifficultyLabel = 'easy' | 'medium' | 'hard';
export type QuotaGrid = Record<string, Record<DifficultyLabel, number>>;

// ── 覆盖率 ──
export interface CoverageResult {
  rate: number;
  isSufficient: boolean;
  covered: string[];
  uncovered: string[];
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/server/src/services/assessment/exam-composer.types.ts
git commit -m "feat(assessment): add exam composer type definitions"
```

---

### Task 3: 创建 CoverageTracker 类

**Files:**
- Create: `apps/server/src/services/assessment/coverage-tracker.ts`
- Test: `apps/server/src/services/assessment/__tests__/coverage-tracker.test.ts`

- [ ] **Step 1: 编写 CoverageTracker 的测试**

```typescript
// apps/server/src/services/assessment/__tests__/coverage-tracker.test.ts

import { describe, it, expect } from 'vitest';
import { CoverageTracker } from '../coverage-tracker';
import { CandidateQuestion } from '../exam-composer.types';

describe('CoverageTracker', () => {
  const allKps = ['kp_1', 'kp_2', 'kp_3', 'kp_4', 'kp_5'];

  it('should start with zero coverage', () => {
    const tracker = new CoverageTracker(allKps);
    const result = tracker.check(0.8);
    expect(result.rate).toBe(0);
    expect(result.isSufficient).toBe(false);
    expect(result.uncovered).toEqual(allKps);
  });

  it('should track newly covered knowledge points', () => {
    const tracker = new CoverageTracker(allKps);
    tracker.add(['kp_1', 'kp_2']);
    const result = tracker.check(0.4);
    expect(result.rate).toBe(0.4);
    expect(result.covered).toContain('kp_1');
    expect(result.isSufficient).toBe(true);
  });

  it('should compute noveltyScore correctly', () => {
    const tracker = new CoverageTracker(allKps);
    tracker.add(['kp_1']);

    const q: CandidateQuestion = {
      questionId: 'q1',
      type: 'choice',
      difficulty: 1,
      knowledgePointIds: ['kp_1', 'kp_2', 'kp_3'],
      maxScore: 5,
    };

    // kp_1 already covered, kp_2 and kp_3 are new → novelty=2
    expect(tracker.noveltyScore(q)).toBe(2);
  });

  it('should report uncovered after partial coverage', () => {
    const tracker = new CoverageTracker(allKps);
    tracker.add(['kp_1', 'kp_2']);
    const result = tracker.check(1.0);
    expect(result.isSufficient).toBe(false);
    expect(result.uncovered).toEqual(['kp_3', 'kp_4', 'kp_5']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd apps/server && npx vitest run src/services/assessment/__tests__/coverage-tracker.test.ts
```

Expected: FAIL — CoverageTracker 未定义

- [ ] **Step 3: 实现 CoverageTracker**

```typescript
// apps/server/src/services/assessment/coverage-tracker.ts

import { CandidateQuestion, CoverageResult } from './exam-composer.types';

export class CoverageTracker {
  private covered = new Set<string>();

  constructor(private allKpIds: string[]) {}

  add(kpIds: string[]): void {
    for (const id of kpIds) {
      this.covered.add(id);
    }
  }

  isCovered(kpId: string): boolean {
    return this.covered.has(kpId);
  }

  /** 某题能带来多少个"新"知识点（用于优先级排序） */
  noveltyScore(q: CandidateQuestion): number {
    return q.knowledgePointIds.filter(id => !this.isCovered(id)).length;
  }

  check(target: number): CoverageResult {
    const rate =
      this.allKpIds.length > 0
        ? this.covered.size / this.allKpIds.length
        : 1;

    return {
      rate,
      isSufficient: rate >= target,
      covered: [...this.covered],
      uncovered: this.allKpIds.filter(id => !this.covered.has(id)),
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd apps/server && npx vitest run src/services/assessment/__tests__/coverage-tracker.test.ts
```

Expected: 4 PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/assessment/coverage-tracker.ts \
        apps/server/src/services/assessment/__tests__/coverage-tracker.test.ts
git commit -m "feat(assessment): add CoverageTracker with novelty-based priority"
```

---

### Task 4: 创建配额计算器

**Files:**
- Create: `apps/server/src/services/assessment/quota-calculator.ts`
- Test: `apps/server/src/services/assessment/__tests__/quota-calculator.test.ts`

- [ ] **Step 1: 编写配额测试**

```typescript
// apps/server/src/services/assessment/__tests__/quota-calculator.test.ts

import { describe, it, expect } from 'vitest';
import { calculateQuotas } from '../quota-calculator';
import { ExamPreset } from '../exam-composer.types';

describe('calculateQuotas', () => {
  const preset: ExamPreset = {
    examType: 'unit_test',
    totalQuestions: 15,
    difficultyRatio: { easy: 4, medium: 8, hard: 3 },
    typeRatio: { choice: 8, fill: 4, solve: 3 },
    coverageTarget: 0.8,
    timeLimitMinutes: 30,
    dedupWindowDays: 30,
  };

  it('should produce correct total across all type-diff combos', () => {
    const quotas = calculateQuotas(preset);
    let total = 0;
    for (const typeQuotas of Object.values(quotas)) {
      for (const count of Object.values(typeQuotas)) {
        total += count;
      }
    }
    expect(total).toBe(preset.totalQuestions);
  });

  it('should allocate more questions to medium difficulty', () => {
    const quotas = calculateQuotas(preset);
    let mediumTotal = 0;
    for (const typeQuotas of Object.values(quotas)) {
      mediumTotal += typeQuotas.medium ?? 0;
    }
    expect(mediumTotal).toBeGreaterThan(5); // medium should have the most
  });

  it('should return all non-negative values', () => {
    const quotas = calculateQuotas(preset);
    for (const typeQuotas of Object.values(quotas)) {
      for (const count of Object.values(typeQuotas)) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd apps/server && npx vitest run src/services/assessment/__tests__/quota-calculator.test.ts
```

- [ ] **Step 3: 实现配额计算器**

```typescript
// apps/server/src/services/assessment/quota-calculator.ts

import { ExamPreset, DifficultyLabel, QuotaGrid } from './exam-composer.types';

/**
 * 根据预设的 difficulty_ratio 和 type_ratio 交叉计算每种 type-diff 组合的题目数。
 * 使用 floor 取整，然后按剩余数微调（优先补 medium 难度）。
 */
export function calculateQuotas(preset: ExamPreset): QuotaGrid {
  const diffs: DifficultyLabel[] = ['easy', 'medium', 'hard'];
  const types = Object.keys(preset.typeRatio);
  const total = preset.totalQuestions;

  const grid: QuotaGrid = {};
  let allocatedTotal = 0;

  // 首次分配：按比例取整
  for (const type of types) {
    grid[type] = { easy: 0, medium: 0, hard: 0 };
    const typeCount = preset.typeRatio[type];
    for (const diff of diffs) {
      const diffCount = preset.difficultyRatio[diff];
      const quota = Math.floor(typeCount * diffCount / total);
      grid[type][diff] = quota;
      allocatedTotal += quota;
    }
  }

  // 微调：补足差额，优先填 medium
  let remaining = total - allocatedTotal;
  const fillOrder = ['medium', 'easy', 'hard'] as DifficultyLabel[];
  let di = 0;

  while (remaining > 0) {
    for (const type of types) {
      if (remaining <= 0) break;
      const diff = fillOrder[di % fillOrder.length];
      grid[type][diff]++;
      remaining--;
    }
    di++;
  }

  return grid;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd apps/server && npx vitest run src/services/assessment/__tests__/quota-calculator.test.ts
```

Expected: 3 PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/assessment/quota-calculator.ts \
        apps/server/src/services/assessment/__tests__/quota-calculator.test.ts
git commit -m "feat(assessment): add quota calculator for type-difficulty distribution"
```

---

### Task 5: 创建 ExamComposer 核心类

**Files:**
- Create: `apps/server/src/services/assessment/exam-composer.ts`
- Test: `apps/server/src/services/assessment/__tests__/exam-composer.test.ts`

**依赖:** Content Service、KG Service、ExamPreset Repository（通过接口注入）

- [ ] **Step 1: 定义依赖接口**

在 `exam-composer.ts` 中先定义 ExamComposer 所需的依赖接口：

```typescript
// apps/server/src/services/assessment/exam-composer.ts

import {
  ComposeExamRequest,
  ComposeExamResponse,
  ExamQuestion,
  ExamPreset,
  CandidateQuestion,
  QuotaGrid,
} from './exam-composer.types';
import { CoverageTracker } from './coverage-tracker';
import { calculateQuotas } from './quota-calculator';

// ── 依赖接口（由外部实现注入）──
export interface ContentServiceQuery {
  queryQuestions(req: {
    subjectId: string;
    unitIds: string[];
    filters?: { types?: string[]; difficulties?: number[] };
    excludeQuestionIds?: string[];
    limit?: number;
  }): Promise<{ questions: CandidateQuestion[]; total: number }>;

  findAnyQuestionByKp(kpId: string): Promise<CandidateQuestion | null>;
  getQuestionsByIds(ids: string[]): Promise<CandidateQuestion[]>;
}

export interface KGServiceScope {
  getKnowledgePointsByUnits(subjectId: string, unitIds: string[]): Promise<string[]>;
}

export interface StudentHistoryQuery {
  getRecentQuestionIds(studentId: string, subjectId: string, withinDays: number): Promise<string[]>;
}

export interface ExamPresetRepo {
  findByType(examType: string): Promise<ExamPreset | null>;
}
```

- [ ] **Step 2: 编写 ExamComposer 单元测试（mock 所有依赖）**

```typescript
// apps/server/src/services/assessment/__tests__/exam-composer.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExamComposer } from '../exam-composer';
import {
  ContentServiceQuery,
  KGServiceScope,
  StudentHistoryQuery,
  ExamPresetRepo,
} from '../exam-composer';
import { ExamPreset, CandidateQuestion } from '../exam-composer.types';

// ── Mock 预设 ──
const mockPreset: ExamPreset = {
  examType: 'unit_test',
  totalQuestions: 3,
  difficultyRatio: { easy: 1, medium: 1, hard: 1 },
  typeRatio: { choice: 3, fill: 0, solve: 0 },
  coverageTarget: 0.6,
  timeLimitMinutes: 30,
  dedupWindowDays: 30,
};

// ── Mock 候选题目 ──
const mockQuestions: CandidateQuestion[] = [
  { questionId: 'q1', type: 'choice', difficulty: 1, knowledgePointIds: ['kp_1'], maxScore: 5 },
  { questionId: 'q2', type: 'choice', difficulty: 2, knowledgePointIds: ['kp_2'], maxScore: 5 },
  { questionId: 'q3', type: 'choice', difficulty: 3, knowledgePointIds: ['kp_3'], maxScore: 5 },
  { questionId: 'q4', type: 'choice', difficulty: 1, knowledgePointIds: ['kp_1'], maxScore: 5 },
  { questionId: 'q5', type: 'choice', difficulty: 2, knowledgePointIds: ['kp_2'], maxScore: 5 },
];

describe('ExamComposer', () => {
  let composer: ExamComposer;
  let mockContent: vi.Mocked<ContentServiceQuery>;
  let mockKG: vi.Mocked<KGServiceScope>;
  let mockHistory: vi.Mocked<StudentHistoryQuery>;
  let mockPresetRepo: vi.Mocked<ExamPresetRepo>;

  beforeEach(() => {
    mockContent = {
      queryQuestions: vi.fn(),
      findAnyQuestionByKp: vi.fn(),
      getQuestionsByIds: vi.fn(),
    };
    mockKG = {
      getKnowledgePointsByUnits: vi.fn(),
    };
    mockHistory = {
      getRecentQuestionIds: vi.fn(),
    };
    mockPresetRepo = {
      findByType: vi.fn(),
    };

    composer = new ExamComposer(mockContent, mockKG, mockHistory, mockPresetRepo);

    // 默认 mock 行为
    mockPresetRepo.findByType.mockResolvedValue(mockPreset);
    mockKG.getKnowledgePointsByUnits.mockResolvedValue(['kp_1', 'kp_2', 'kp_3']);
    mockHistory.getRecentQuestionIds.mockResolvedValue([]);
  });

  it('should compose exam with correct question count', async () => {
    mockContent.queryQuestions.mockResolvedValue({ questions: mockQuestions, total: 5 });
    mockContent.getQuestionsByIds.mockResolvedValue(mockQuestions.slice(0, 3));

    const result = await composer.compose({
      studentId: 'stu_1',
      examType: 'unit_test',
      scope: { subjectId: 'sub_1', unitIds: ['u1'] },
    });

    expect(result.questions.length).toBe(3);
    expect(result.metadata.aiGeneratedCount).toBe(0);
  });

  it('should exclude recent questions', async () => {
    mockHistory.getRecentQuestionIds.mockResolvedValue(['q1', 'q2']);
    mockContent.queryQuestions.mockResolvedValue({ questions: mockQuestions.slice(2), total: 3 });
    mockContent.getQuestionsByIds.mockResolvedValue(mockQuestions.slice(2, 5));

    const result = await composer.compose({
      studentId: 'stu_1',
      examType: 'unit_test',
      scope: { subjectId: 'sub_1', unitIds: ['u1'] },
    });

    // 确认 queryQuestions 调用时排除了近期做过的题目
    const queryCall = mockContent.queryQuestions.mock.calls[0][0];
    expect(queryCall.excludeQuestionIds).toContain('q1');
    expect(queryCall.excludeQuestionIds).toContain('q2');
  });

  it('should track knowledge point coverage', async () => {
    mockContent.queryQuestions.mockResolvedValue({ questions: mockQuestions, total: 5 });
    mockContent.getQuestionsByIds.mockResolvedValue([
      mockQuestions[0], // kp_1
      mockQuestions[1], // kp_2
      mockQuestions[2], // kp_3
    ]);

    const result = await composer.compose({
      studentId: 'stu_1',
      examType: 'unit_test',
      scope: { subjectId: 'sub_1', unitIds: ['u1'] },
    });

    // 3 个知识点，覆盖率 targets 0.6 → 至少 2 个知识点被覆盖
    expect(result.metadata.knowledgePointCoverage).toBeGreaterThanOrEqual(0.6);
  });

  it('should throw when preset not found', async () => {
    mockPresetRepo.findByType.mockResolvedValue(null);

    await expect(
      composer.compose({
        studentId: 'stu_1',
        examType: 'unit_test',
        scope: { subjectId: 'sub_1', unitIds: ['u1'] },
      }),
    ).rejects.toThrow('Preset not found');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd apps/server && npx vitest run src/services/assessment/__tests__/exam-composer.test.ts
```

- [ ] **Step 4: 实现 ExamComposer**

```typescript
// apps/server/src/services/assessment/exam-composer.ts (续)

const DEFAULT_PRESET: ExamPreset = {
  examType: 'unit_test',
  totalQuestions: 15,
  difficultyRatio: { easy: 5, medium: 5, hard: 5 },
  typeRatio: { choice: 5, fill: 5, solve: 5 },
  coverageTarget: 0.8,
  timeLimitMinutes: 30,
  dedupWindowDays: 30,
};

export class ExamComposer {
  constructor(
    private contentService: ContentServiceQuery,
    private kgService: KGServiceScope,
    private studentHistory: StudentHistoryQuery,
    private presetRepo: ExamPresetRepo,
  ) {}

  async compose(request: ComposeExamRequest): Promise<ComposeExamResponse> {
    // Step 1: 加载预设
    const preset = await this.presetRepo.findByType(request.examType);
    if (!preset) {
      // 使用默认预设兜底
      console.warn(`Preset not found for ${request.examType}, using default`);
    }
    const effectivePreset = preset ?? { ...DEFAULT_PRESET, examType: request.examType };

    // Step 2: 计算知识点全集
    const scopeKps = await this.kgService.getKnowledgePointsByUnits(
      request.scope.subjectId,
      request.scope.unitIds,
    );

    // Step 3: 查询近期做过的题（去重）
    const recentIds = await this.studentHistory.getRecentQuestionIds(
      request.studentId,
      request.scope.subjectId,
      effectivePreset.dedupWindowDays,
    );

    // Step 4: 计算配额
    const quotas = calculateQuotas(effectivePreset);

    // Step 5: 按配额逐组抽取
    const selectedIds = new Set<string>();
    const coverageTracker = new CoverageTracker(scopeKps);
    const allPicked: CandidateQuestion[] = [];

    for (const [type, diffQuotas] of Object.entries(quotas)) {
      for (const [diffStr, count] of Object.entries(diffQuotas)) {
        if (count <= 0) continue;
        const diff = Number(diffStr) as 1 | 2 | 3;

        const result = await this.contentService.queryQuestions({
          subjectId: request.scope.subjectId,
          unitIds: request.scope.unitIds,
          filters: { types: [type], difficulties: [diff] },
          excludeQuestionIds: [...recentIds, ...selectedIds],
          limit: count * 3,
        });

        // 按知识点覆盖优先级排序
        const candidates = result.questions.sort(
          (a, b) => coverageTracker.noveltyScore(b) - coverageTracker.noveltyScore(a),
        );

        const picked = candidates.slice(0, count);
        for (const q of picked) {
          selectedIds.add(q.questionId);
          coverageTracker.add(q.knowledgePointIds);
          allPicked.push(q);
        }
      }
    }

    // Step 6: 覆盖校验
    const coverage = coverageTracker.check(effectivePreset.coverageTarget);
    if (!coverage.isSufficient) {
      const supplement = await this.supplementCoverage(
        coverage.uncovered,
        request.scope.subjectId,
        request.scope.unitIds,
        [...recentIds, ...selectedIds],
      );
      for (const q of supplement) {
        if (!selectedIds.has(q.questionId)) {
          selectedIds.add(q.questionId);
          coverageTracker.add(q.knowledgePointIds);
          allPicked.push(q);
        }
      }
    }

    // Step 7: 总量检查 — 不足时放宽约束补充
    if (allPicked.length < effectivePreset.totalQuestions) {
      const shortage = effectivePreset.totalQuestions - allPicked.length;
      const relaxedResult = await this.contentService.queryQuestions({
        subjectId: request.scope.subjectId,
        unitIds: request.scope.unitIds,
        excludeQuestionIds: [...recentIds, ...selectedIds],
        limit: shortage,
      });
      for (const q of relaxedResult.questions) {
        selectedIds.add(q.questionId);
        coverageTracker.add(q.knowledgePointIds);
        allPicked.push(q);
      }
    }

    // Step 8: 组装输出
    const finalCoverage = coverageTracker.check(effectivePreset.coverageTarget);
    const shuffled = this.shuffle([...allPicked]);
    const ordered = this.sortByType(shuffled);
    const orderedQuestions: ExamQuestion[] = ordered.map((q, i) => ({
      ...q,
      source: 'question_bank' as const,
      order: i + 1,
    }));

    return {
      examId: `exam_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      questions: orderedQuestions,
      metadata: {
        totalQuestions: orderedQuestions.length,
        difficultyDistribution: this.countByDifficulty(orderedQuestions),
        typeDistribution: this.countByType(orderedQuestions),
        knowledgePointCoverage: finalCoverage.rate,
        coveredKnowledgePoints: finalCoverage.covered,
        uncoveredKnowledgePoints: finalCoverage.uncovered,
        timeLimitMinutes: effectivePreset.timeLimitMinutes,
        aiGeneratedCount: 0,
      },
    };
  }

  // ── Private helpers ──

  private async supplementCoverage(
    uncoveredKps: string[],
    subjectId: string,
    unitIds: string[],
    excludeIds: string[],
  ): Promise<CandidateQuestion[]> {
    if (uncoveredKps.length === 0) return [];

    const result = await this.contentService.queryQuestions({
      subjectId,
      unitIds,
      filters: { knowledgePointIds: uncoveredKps },
      excludeQuestionIds: excludeIds,
      limit: uncoveredKps.length,
    });

    return result.questions;
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 题型分组排序：选择题在前，填空其次，解答最后 */
  private sortByType(questions: CandidateQuestion[]): CandidateQuestion[] {
    const order: Record<string, number> = {
      choice: 0, fill_blank: 1, true_false: 1,
      short_answer: 2, proof: 2,
    };
    return [...questions].sort(
      (a, b) => (order[a.type] ?? 2) - (order[b.type] ?? 2),
    );
  }

  private countByDifficulty(qs: CandidateQuestion[]): Record<string, number> {
    const counts: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
    for (const q of qs) {
      const label = q.difficulty === 1 ? 'easy' : q.difficulty === 2 ? 'medium' : 'hard';
      counts[label]++;
    }
    return counts;
  }

  private countByType(qs: CandidateQuestion[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const q of qs) {
      counts[q.type] = (counts[q.type] ?? 0) + 1;
    }
    return counts;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd apps/server && npx vitest run src/services/assessment/__tests__/exam-composer.test.ts
```

Expected: 4 PASS

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/services/assessment/exam-composer.ts \
        apps/server/src/services/assessment/__tests__/exam-composer.test.ts
git commit -m "feat(assessment): add ExamComposer with coverage-driven selection"
```

---

### Task 6: 验证与集成检查

**Files:**
- 不创建新文件，只做验证。

- [ ] **Step 1: 运行全部 assessment 测试**

```bash
cd apps/server && npx vitest run src/services/assessment/
```

Expected: 所有测试通过（Task 3 的 4 个 + Task 4 的 3 个 + Task 5 的 4 个 = 11 tests）

- [ ] **Step 2: 对照 Spec 逐条检查**

| Spec 要求 | 实现位置 |
|-----------|---------|
| §3.2 新增 exam_presets 表 + 种子 | Task 1 |
| §4.1 ComposeExamRequest/Response | Task 2 (types.ts) |
| §4.2 Content Service 查询接口 | Task 2 (types.ts) + Task 5 (注入接口) |
| §4.3 KG Service 接口 | Task 2 (types.ts) + Task 5 (注入接口) |
| §4.4 去重查询 | Task 5 (studentHistory.getRecentQuestionIds) |
| §5 核心算法（配额/覆盖/组装） | Task 3 (CoverageTracker) + Task 4 (QuotaCalculator) + Task 5 (ExamComposer) |
| §6 P1 AI 补题 | 预留设计，Task 5 中 aiGeneratedCount 固定为 0 |
| §8 边界处理 | 预设缺失→使用默认值；题库不足→放宽约束 |

- [ ] **Step 3: 提交（如需修正）**

```bash
git add -A
git commit -m "chore(assessment): verification - all tests pass, spec coverage confirmed"
```

---

### 后续任务（不在本计划范围，标记为 P1）

- [ ] `ExamPresetRepo` 的 MySQL 实现（`findByType` 查询 `exam_presets` 表）
- [ ] `StudentHistoryQuery` 的 MySQL 实现（UNION 查询 answers + submissions）
- [ ] `ContentServiceQuery` 的 question query 实现（JOIN question_knowledge_points）
- [ ] `KGServiceScope` 的 `getKnowledgePointsByUnits` 实现
- [ ] Assessment Service 路由：`POST /api/assessment/compose`
- [ ] P1: `aiGenerateSupplement` 调用 VariationCapability
