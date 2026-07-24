// safety-classification.ts
// Labeled samples for safety classification accuracy regression.
// Deterministic (keyword-based) - no API keys required.
// Run: npx tsx src/ai-core/__tests__/safety-classification.ts

import { SafetyGuard } from '../infra/safety-guard.js';

interface SafetySample {
  id: string;
  message: string;
  expectedClassification: 'learning' | 'off_topic' | 'anomaly';
}

const SAMPLES: SafetySample[] = [
  // --- learning (contain a learning keyword) ---
  { id: 's_001', message: '老师，一元二次方程的求根公式是什么？', expectedClassification: 'learning' },
  { id: 's_002', message: '这道几何题怎么证明？', expectedClassification: 'learning' },
  { id: 's_003', message: '帮我算一下这道题', expectedClassification: 'learning' },
  { id: 's_004', message: '为什么负数乘负数得正数？', expectedClassification: 'learning' },
  { id: 's_005', message: '这个函数的图像怎么画？', expectedClassification: 'learning' },
  { id: 's_006', message: '请教一下，什么是勾股定理？', expectedClassification: 'learning' },
  { id: 's_007', message: '我不会做这道计算题', expectedClassification: 'learning' },
  { id: 's_008', message: '2+3=5', expectedClassification: 'learning' },
  { id: 's_009', message: '解题步骤是什么？', expectedClassification: 'learning' },
  { id: 's_010', message: '这道题目我算不出来', expectedClassification: 'learning' },
  // 含代数方程表达式但无"方程/计算"等关键词--必须判 learning,不能误拦为 off_topic
  { id: 's_027', message: '3x + 5 = 14，x等于多少？', expectedClassification: 'learning' },
  { id: 's_028', message: '我算出来 2x+3=7 的解是 x=5，对吗？', expectedClassification: 'learning' },
  { id: 's_029', message: '2x+3=7，我算出 x=2', expectedClassification: 'learning' },

  // --- anomaly (no learning keyword; contain an anomaly keyword) ---
  { id: 's_011', message: '我好烦，不想学了', expectedClassification: 'anomaly' },
  { id: 's_012', message: '这题烦死了', expectedClassification: 'anomaly' },
  { id: 's_013', message: '我讨厌写作业', expectedClassification: 'anomaly' },
  { id: 's_014', message: '气死我了，做不出来', expectedClassification: 'anomaly' },
  { id: 's_015', message: '不要讨论政治', expectedClassification: 'anomaly' },
  { id: 's_016', message: '这个游戏太暴力了', expectedClassification: 'anomaly' },
  { id: 's_017', message: '这是敏感话题', expectedClassification: 'anomaly' },
  { id: 's_018', message: '烦死啦，怎么都做不对', expectedClassification: 'anomaly' },

  // --- off_topic (neither learning nor anomaly keyword) ---
  { id: 's_019', message: '今天天气真好，想出去玩', expectedClassification: 'off_topic' },
  { id: 's_020', message: '你喜欢什么游戏？', expectedClassification: 'off_topic' },
  { id: 's_021', message: '中午吃什么？', expectedClassification: 'off_topic' },
  { id: 's_022', message: '最近有什么好看的电影？', expectedClassification: 'off_topic' },
  { id: 's_023', message: '你喜欢听什么音乐？', expectedClassification: 'off_topic' },
  { id: 's_024', message: '明天放假吗？', expectedClassification: 'off_topic' },
  { id: 's_025', message: '1+1等于几', expectedClassification: 'off_topic' },
  { id: 's_026', message: '你去过北京吗？', expectedClassification: 'off_topic' },
];

function runSafetyTests(): void {
  const guard = new SafetyGuard();
  let correct = 0;

  for (const sample of SAMPLES) {
    const result = guard.classifyByKeywords(sample.message);
    const isCorrect = result.classification === sample.expectedClassification;
    if (isCorrect) {
      correct++;
    } else {
      console.log(
        `[MISMATCH] ${sample.id}: "${sample.message}" -> got "${result.classification}", expected "${sample.expectedClassification}"`,
      );
    }
  }

  const accuracy = ((correct / SAMPLES.length) * 100).toFixed(1);
  console.log(`\nSafety Classification Accuracy: ${correct}/${SAMPLES.length} (${accuracy}%)`);
}

runSafetyTests();
