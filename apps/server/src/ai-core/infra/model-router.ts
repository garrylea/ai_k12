import { routeConfig } from '../config.js';
import type { RouteRequest, RouteResult, ModelConfig, Scene, Subject } from '../types.js';

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

  /** Look up a model config by id (apiKey stripped; ModelClient re-attaches it
   * via the provider). Used for side tasks like title generation. */
  getModel(id: string): ModelConfig | undefined {
    return this.models[id];
  }

  route(request: RouteRequest): RouteResult {
    // Task 14a: image-aware routing for tutoring. When the request has an image,
    // override to qwen-vl-max (multimodal) for math. Other subjects still fall
    // through to the normal route table (multimodal support may differ).
    // TODO: generalize for non-math subjects when added.
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
