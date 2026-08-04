import { routeConfig } from '../config.js';
import type { RouteRequest, RouteResult, ModelConfig, Scene, Subject, Message, ContentPart } from '../types.js';

interface RouteRule {
  subject: string;
  difficulty?: number[];
  primary: string;
  fallback?: string | null;
}

export class ModelRouter {
  private models: Record<string, ModelConfig>;
  private routes: Record<string, RouteRule[]>;
  private defaultRule: { primary: string; fallback: string };

  constructor() {
    // Strip apiKey from model configs for public use
    this.models = {};
    for (const [id, config] of Object.entries(routeConfig.models)) {
      const { apiKey, ...rest } = config as ModelConfig & { apiKey: string };
      this.models[id] = rest;
    }
    this.routes = routeConfig.routes as Record<string, RouteRule[]>;
    this.defaultRule = routeConfig.default;
  }

  /** Task 14a: detect if any message in the history has an image_url part. */
  hasImage(messages: Message[]): boolean {
    return messages.some(m => {
      if (typeof m.content === 'string') return false;
      return (m.content as ContentPart[]).some(p => p.type === 'image_url');
    });
  }

  route(request: RouteRequest): RouteResult {
    // Task 14a: image-aware routing for tutoring. When the request has an image,
    // override to qwen-vl-max (multimodal) for math. Other subjects still fall
    // through to the normal route table (multimodal support may differ).
    if (request.hasImage && request.scene === 'tutoring' && request.subject === 'math') {
      const reason = `scene=${request.scene} subject=${request.subject} hasImage=true -> qwen-vl-max`;
      return {
        primary: this.models['qwen-vl-max'],
        fallback: this.models['qwen3.7-max'],
        reason,
      };
    }

    const rule = this.matchRule(request.scene, request.subject, request.difficulty);
    const reason = `scene=${request.scene} subject=${request.subject} difficulty=${request.difficulty ?? 'any'}`;

    return {
      primary: this.models[rule.primary],
      fallback: rule.fallback ? this.models[rule.fallback] : undefined,
      reason,
    };
  }

  private matchRule(scene: Scene, subject: Subject, difficulty?: number): RouteRule {
    const sceneRules = this.routes[scene] ?? [];

    // 1. Exact match: scene + subject + difficulty
    if (difficulty !== undefined) {
      const exact = sceneRules.find(
        r => (r.subject === subject || r.subject === '*') && r.difficulty?.includes(difficulty)
      );
      if (exact) return exact;
    }

    // 2. Match scene + subject (ignore difficulty)
    const bySubject = sceneRules.find(r => r.subject === subject);
    if (bySubject) return bySubject;

    // 3. Wildcard subject match
    const wildcard = sceneRules.find(r => r.subject === '*');
    if (wildcard) return wildcard;

    // 4. Default
    return { subject: '*', primary: this.defaultRule.primary, fallback: this.defaultRule.fallback };
  }
}
