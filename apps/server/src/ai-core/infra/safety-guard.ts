import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import type { SafetyCheckRequest, SafetyCheckResult, Message, Classification, AnomalyType, AlertLevel } from '../types.js';
import { safetyConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Shared learning-keyword set. Used by both classifyByKeywords and
// countConsecutiveOffTopic so a message classified as "learning" is also
// treated as a learning turn when counting consecutive off-topic messages
// (otherwise "我不会做" would inflate the off-topic count and prematurely
// escalate the alert level).
const LEARNING_PATTERNS = [
  /怎么[解算做]/, /什么是/, /为什么/, /方程/, /数学/, /题目/, /老师/,
  /帮我/, /请教/, /公式/, /计算/, /证明/, /几何/, /函数/, /不会/,
  /怎么做/, /解题/, /答案是什么/, /^[0-9+\-×÷=]+$/,
];

interface GentleBlockPhrases {
  off_topic: string[];
  emotional: string[];
  sensitive: string[];
}

export class SafetyGuard {
  private phrases: GentleBlockPhrases;

  constructor() {
    const phrasePath = resolve(__dirname, '../prompts/safety/gentle-block.yaml');
    this.phrases = yaml.load(readFileSync(phrasePath, 'utf-8')) as GentleBlockPhrases;
  }

  async check(request: SafetyCheckRequest): Promise<SafetyCheckResult> {
    const classification = this.classifyByKeywords(request.message);

    if (classification.classification === 'learning') {
      return {
        isLearningRelated: true,
        classification: 'learning',
        alertLevel: 'none',
        shouldBlock: false,
      };
    }

    if (classification.classification === 'off_topic') {
      const consecutiveCount = this.countConsecutiveOffTopic(request.dialogueHistory);
      let alertLevel: AlertLevel = 'info';
      if (consecutiveCount >= safetyConfig.safety.off_topic.criticalThreshold) {
        alertLevel = 'critical';
      } else if (consecutiveCount >= safetyConfig.safety.off_topic.escalateThreshold) {
        alertLevel = 'warning';
      }

      return {
        isLearningRelated: false,
        classification: 'off_topic',
        alertLevel,
        shouldBlock: true,
        blockResponse: this.pickGentleBlockMessage('off_topic'),
        alertPayload: alertLevel !== 'info' ? {
          studentId: request.studentId,
          level: alertLevel,
          type: 'off_topic',
          message: request.message,
          timestamp: new Date(),
        } : undefined,
      };
    }

    const anomalyType = this.detectAnomalyType(request.message);
    const isCritical = anomalyType === 'sensitive' || anomalyType === 'abusive';

    return {
      isLearningRelated: false,
      classification: 'anomaly',
      anomalyType,
      alertLevel: isCritical ? 'critical' : 'warning',
      shouldBlock: true,
      blockResponse: this.pickGentleBlockMessage(anomalyType),
      alertPayload: {
        studentId: request.studentId,
        level: isCritical ? 'critical' : 'warning',
        type: anomalyType,
        message: request.message,
        timestamp: new Date(),
      },
    };
  }

  classifyByKeywords(message: string): { classification: Classification; confidence: number } {
    if (LEARNING_PATTERNS.some(p => p.test(message))) {
      return { classification: 'learning', confidence: 0.9 };
    }

    const anomalyPatterns = [
      /烦死[了啦]/, /不想[学活]/, /讨厌/, /骂/, /气死/,
      /政治/, /暴力/, /敏感/,
    ];

    if (anomalyPatterns.some(p => p.test(message))) {
      return { classification: 'anomaly', confidence: 0.7 };
    }

    return { classification: 'off_topic', confidence: 0.6 };
  }

  detectAnomalyType(message: string): AnomalyType {
    if (/烦|累|不想[学活]|讨厌|难过|伤心|气/.test(message)) {
      return 'emotional';
    }
    if (/政治|暴力|色情|敏感/.test(message)) {
      return 'sensitive';
    }
    return 'emotional';
  }

  countConsecutiveOffTopic(history: Message[]): number {
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role !== 'user') continue;
      if (LEARNING_PATTERNS.some(p => p.test(msg.content))) break;
      count++;
    }
    return count;
  }

  pickGentleBlockMessage(type: 'off_topic' | 'emotional' | 'sensitive' | 'abusive'): string {
    // abusive has no dedicated phrases in gentle-block.yaml; fall back to sensitive.
    const lookupKey: 'off_topic' | 'emotional' | 'sensitive' =
      type === 'abusive' ? 'sensitive' : type;
    const messages = this.phrases[lookupKey];
    if (!messages || messages.length === 0) return '请专注于学习内容哦。';

    if (safetyConfig.safety.gentleBlock.randomPick) {
      const idx = Math.floor(Math.random() * messages.length);
      return messages[idx];
    }
    return messages[0];
  }
}
