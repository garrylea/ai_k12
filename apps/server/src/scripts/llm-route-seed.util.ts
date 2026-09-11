/** YAML 路由规则（seed 用最小结构）。 */
export interface SeedRouteRule {
  subject: string;
  primary: string;
  fallback?: string | null;
}

export interface ResolvedSeedRoute {
  primary: string;
  fallback: string | null;
  /** 主模型未配置、由备用模型顶上 —— 调用方应打 warning。 */
  degraded: boolean;
  /** 主模型与备用模型都未配置 —— 调用方应跳过并打 warning。 */
  skipped: boolean;
}

/**
 * 解析一条 YAML 路由在「已成功 seed 的模型集合」下应落库的形态：
 * - 主模型已配置：直接用；备用未配置则置空（不再整条丢弃）
 * - 主模型未配置、备用已配置：降级 —— 备用顶上当主模型
 * - 两者都未配置：跳过
 */
export function resolveSeedRoute(rule: SeedRouteRule, seeded: Set<string>): ResolvedSeedRoute {
  const fallback = rule.fallback ?? null;
  if (seeded.has(rule.primary)) {
    if (fallback && !seeded.has(fallback)) {
      return { primary: rule.primary, fallback: null, degraded: false, skipped: false };
    }
    return { primary: rule.primary, fallback, degraded: false, skipped: false };
  }
  if (fallback && seeded.has(fallback)) {
    return { primary: fallback, fallback: null, degraded: true, skipped: false };
  }
  return { primary: rule.primary, fallback, degraded: false, skipped: true };
}
