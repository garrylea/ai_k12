import { routeConfig } from '../config.js';
import type { RouteRequest, RouteResult, ModelConfig, Scene, Subject } from '../types.js';
import type { ModelConfigRegistry } from './model-config-registry.js';

interface RouteRule {
  subject: string;
  difficulty?: number[];
  primary: string;
  fallback?: string | null;
}

export class ModelRouter {
  private models: Record<string, ModelConfig & { apiKey?: string }>;
  private routes: Record<string, RouteRule[]>;
  private defaultRule: { primary: string; fallback: string };
  private registry?: ModelConfigRegistry;

  constructor(registry?: ModelConfigRegistry) {
    this.registry = registry;
    if (registry) {
      const snap = registry.getSnapshot();
      this.models = snap.models;
      this.routes = snap.routes;
      this.defaultRule = snap.default;
    } else {
      // 无 registry：直接读 YAML（既有行为，兜底路径零变化）。
      // 注意：不再剥离 apiKey（ModelClient 后续直接用 request.model.apiKey）。
      this.models = routeConfig.models as Record<string, ModelConfig & { apiKey?: string }>;
      this.routes = routeConfig.routes as Record<string, RouteRule[]>;
      this.defaultRule = routeConfig.default;
    }
  }

  /** Look up a model config by id. Used for side tasks like title generation. */
  getModel(id: string): (ModelConfig & { apiKey?: string }) | undefined {
    return this.models[id];
  }

  route(request: RouteRequest): RouteResult {
    // registry 模式下每次 route 前刷新本地引用（reload 会整体替换快照对象）
    if (this.registry) {
      const snap = this.registry.getSnapshot();
      this.models = snap.models;
      this.routes = snap.routes;
      this.defaultRule = snap.default;
    }

    // Image tutoring is direct now: the tutoring route is multimodal
    // (qwen3.8-max) and receives images as image_url parts, so there is no
    // hasImage branch here - always use the scene/subject route.
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
