// grading-accuracy.ts
// Fixed questions with human-annotated standard scores for grading regression.
// Requires API keys (LLM_BASE_URL / LLM_AUTH_TOKEN or per-provider keys) to run.
// Run: npx tsx src/ai-core/__tests__/grading-accuracy.ts

import { GradingCapability } from '../capabilities/grading.capability.js';

interface TestCase {
  questionId: string;
  questionContent: string;
  standardAnswer: string;
  maxScore: number;
  studentAnswer: string;
  expectedScore: number; // human-annotated
  tolerance: number; // acceptable deviation
}

const TEST_CASES: TestCase[] = [
  {
    questionId: 'proof_001',
    questionContent: '证明：三角形内角和为180°。',
    standardAnswer: '过顶点作平行线，利用同位角相等证明。',
    maxScore: 10,
    studentAnswer: '因为三角形三个角加起来是180度。',
    expectedScore: 2,
    tolerance: 2,
  },
  {
    questionId: 'proof_002',
    questionContent: '证明：对顶角相等。',
    standardAnswer: '利用平角为180°，等量减等量差相等。',
    maxScore: 10,
    studentAnswer: '过顶点作平行线，利用同位角相等证明。',
    expectedScore: 9,
    tolerance: 2,
  },
  {
    questionId: 'calc_001',
    questionContent: '解方程：2x + 3 = 7',
    standardAnswer: 'x = 2',
    maxScore: 5,
    studentAnswer: '2x = 7 - 3 = 4，x = 2',
    expectedScore: 5,
    tolerance: 1,
  },
  {
    questionId: 'calc_002',
    questionContent: '解方程：2x + 3 = 7',
    standardAnswer: 'x = 2',
    maxScore: 5,
    studentAnswer: 'x = 4',
    expectedScore: 1,
    tolerance: 2,
  },
  {
    questionId: 'calc_003',
    questionContent: '计算：12 × 15',
    standardAnswer: '180',
    maxScore: 5,
    studentAnswer: '180',
    expectedScore: 5,
    tolerance: 1,
  },
  {
    questionId: 'calc_004',
    questionContent: '计算：12 × 15',
    standardAnswer: '180',
    maxScore: 5,
    studentAnswer: '170',
    expectedScore: 1,
    tolerance: 2,
  },
];

async function runGradingTests(): Promise<void> {
  const capability = new GradingCapability();
  let totalDeviation = 0;
  let passed = 0;

  for (const tc of TEST_CASES) {
    try {
      const result = await capability.grade({
        questionId: tc.questionId,
        questionType: tc.questionId.startsWith('proof') ? 'proof' : 'calculation',
        subject: 'math',
        questionContent: tc.questionContent,
        standardAnswer: tc.standardAnswer,
        maxScore: tc.maxScore,
        studentAnswer: tc.studentAnswer,
      });

      const deviation = Math.abs(result.totalScore - tc.expectedScore);
      totalDeviation += deviation;
      if (deviation <= tc.tolerance) passed++;

      console.log(
        `[${tc.questionId}] Expected: ${tc.expectedScore}, Got: ${result.totalScore}, Deviation: ${deviation}`,
      );
    } catch (e) {
      console.error(`[${tc.questionId}] Error:`, e);
    }
  }

  console.log(`\nResults: ${passed}/${TEST_CASES.length} passed`);
  console.log(`Average deviation: ${(totalDeviation / TEST_CASES.length).toFixed(2)}`);
}

runGradingTests();
