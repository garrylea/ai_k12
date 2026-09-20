import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import type { SafetyCheckRequest, SafetyCheckResult, Message, Classification, AnomalyType } from '../types.js';
import { contentToText } from '../types.js';
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
  // 含代数方程表达式的消息(如 3x+5=14、x=2、2x+3=7)视为学习相关,即使缺少
  // "方程/计算"等关键词--避免把"3x+5=14,x等于多少?"误判为 off_topic 而 block。
  // 用半角等号/变量项识别,不误伤"1+1等于几"(中文"等于",无半角=)这类 off_topic。
  /\d\s*[a-zA-Z]/, /[a-zA-Z]\s*[+\-*/=]/, /=\s*\d/,
  // 问候语(hello/你好/hi/在吗/老师好/早上好…)不算 off_topic -- 放行让模型自然
  // 回复问候(如"你好，有什么问题我可以帮你？"),而非被拦截回"专注学习"。
  // 锚定整条消息(允许末尾标点/空格),避免误伤"你好烦"等非问候句。
  /^(hello|hi|hey|嗨|哈喽|你好|你好呀|你好啊|在吗|在不在|老师好|早上好|上午好|中午好|下午好|晚上好)[~!！。.,， ]*$/i,
  // 请求解释/说明/描述 -- 学生要求 AI 用不同方式辅助理解
  /解释/, /讲讲/, /描述/, /说说/, /告诉我/, /说明/,
  // 请求简单/通俗/易懂 -- 学生要求降低难度（学习行为，非 off-topic）
  /通俗/, /简单/, /容易/, /易懂/, /大白话/, /生活/,
  // 请求重新讲解/换种方式 -- 学生追问
  /换.*方式/, /重新.*[讲说解]/, /再.*[讲说解].*[一遍下]/, /[没不].*[理解懂会明白]/,
  // 请求举例 -- 学生要求具体化
  /举例/, /例子/, /打个比/, /类比/,
  // 询问含义/意思 -- 学生要求澄清
  /什么意思/, /含义/, /概念/, /定义/,
  // 学习过程中的对话衔接词（与学习讨论强相关）
  /教[教我一下]/, /指点/, /提示/,
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

    // 2026-09-20：闲聊**不再硬阻断**（spec §3.1）。关键词分类器对语文/英语理解题误判率
    // 过高（实测 6/12，spec §2.1），拿它当门禁会把正常学习提问拒掉。改由模型自报标记
    // （spec §3.2）判定并写入预警 —— 这里只如实报告「与学习无关」，不拦、不报警。
    // 辅线豁免段随之删除：既然两条轨都不拦，就没有「豁免」这回事了。
    // 注：`countConsecutiveOffTopic` 与 `safetyConfig.safety.off_topic.*` 保留但不再被
    // 本方法调用（spec §9「预留未用」），删掉会与 spec §9 冲突。
    if (classification.classification === 'off_topic') {
      return {
        isLearningRelated: false,
        classification: 'off_topic',
        alertLevel: 'none',
        shouldBlock: false,
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
      // Task 14a: content may be string | ContentPart[]; coerce to text for regex test.
      const text = contentToText(msg.content);
      if (LEARNING_PATTERNS.some(p => p.test(text))) break;
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
