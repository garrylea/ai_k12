/**
 * 数学薄弱点图谱的 wire 类型（API 文档 §4.5 / spec `2026-09-23-math-weakpoint-graph-design.md`）。
 *
 * 这些类型同时是**前后端契约的唯一真源**：`apps/web/src/services/api.ts` 里有镜像定义，
 * 改这里必须同步改那里（两处都是手写的，没有代码生成）。
 */

/**
 * 判定「强弱」所需的最小样本量（`correct_count + error_count`）。
 *
 * ⚠️ **唯一真源**：`confidence` 由后端算好下发，前端**不得重算**这个阈值
 * （重算就会出现两处漂移）。`5` 是拍出来的值，后续应按数据分布校准（spec §8 第 4 条）。
 */
export const MIN_SAMPLE_SIZE = 5;

/**
 * 「薄弱」阈值：`level <= 2`（即掌握度 < 60%）才算「待补 / 该补」。
 *
 * **两个用途刻意共用同一口径**（不拆成两个常量）：① 一级行汇总「N 个待补」；
 * ② 推荐的第 4 道闸门（`level > WEAK_LEVEL_MAX` 直接不算候选）。
 * 拆开会出现自相矛盾——一级行显示「0 个待补」，推荐条却把同一个点推成「最该补」。
 *
 * ⚠️ 前端 `apps/web/src/pages/student/training/weak-point-heat.ts` 有同名常量，
 * **改这里必须同步那里**（跨包无法共享，与 `CLIENT_IDLE_DETECTION_SECONDS` 同一处理方式）。
 *
 * spec 未定义此阈值，2026-09-23 定稿为 2。
 */
export const WEAK_LEVEL_MAX = 2;

/** 掌握度的可信度三态：`none` = 从未作答 / `insufficient` = 样本 < 5 / `ok` = 可下结论。 */
export type MasteryConfidence = 'none' | 'insufficient' | 'ok';

/** 图谱节点（一级 + 二级平铺，树形组装放前端）。 */
export interface KnowledgeGraphNode {
  id: number;
  name: string;
  /** null = 一级知识点 */
  parentId: number | null;
  /** null = 从未作答（**不是 0**——0 是「很弱」，语义相反） */
  masteryScore: number | null;
  level: number | null;
  correctCount: number | null;
  errorCount: number | null;
  /** ISO 字符串；未作答为 null */
  lastSeenAt: string | null;
  /** correct + error；未作答 = 0 */
  sampleSize: number;
  confidence: MasteryConfidence;
  /** 该 KP 对**该生**可抽的题数（已排除「不再展示」） */
  availableQuestionCount: number;
}

/** `GET /api/knowledge-graph/students/{studentId}/mastery` 的 data。 */
export interface KnowledgeGraphMastery {
  subjectId: number;
  nodes: KnowledgeGraphNode[];
  coverage: {
    /** 该学科 active 题里带 KP 标注的 */
    coveredQuestions: number;
    /** 该学科 active 题总数 */
    totalQuestions: number;
    /** 该生未标注知识点的未清零错题数（页脚用） */
    uncoveredUnclearedErrors: number;
  };
}

/** 够格的薄弱点候选（三道闸门全过才有资格进来）。 */
export interface WeakPointCandidate {
  knowledgePointId: number;
  name: string;
  parentId: number | null;
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  sampleSize: number;
  availableQuestionCount: number;
  lastSeenAt: string | null;
}

/** `GET /api/knowledge-graph/students/{studentId}/weak-points` 的 data。 */
export interface WeakPointRecommendation {
  subjectId: number;
  candidates: WeakPointCandidate[];
  /** = `candidates[0] ?? null` */
  recommendation: WeakPointCandidate | null;
  /** 无候选**不是错误**：端点仍返回 200，前端据此转引导态 */
  reason: 'ok' | 'no_qualified_candidate';
}
