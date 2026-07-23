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

  route(request: RouteRequest): RouteResult {
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
