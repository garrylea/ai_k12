import { Counter, Histogram, Gauge, Registry } from 'prom-client';

const registry = new Registry();

export const metrics = {
  requestTotal: new Counter({
    name: 'ai_agent_request_total',
    help: 'Total AI agent requests',
    labelNames: ['scene', 'model', 'subject'],
    registers: [registry],
  }),

  requestDurationMs: new Histogram({
    name: 'ai_agent_request_duration_ms',
    help: 'AI call latency distribution',
    labelNames: ['scene', 'model'],
    buckets: [500, 1000, 2000, 3000, 5000, 10000, 15000, 30000],
    registers: [registry],
  }),

  tokenConsumption: new Counter({
    name: 'ai_agent_token_consumption',
    help: 'Total token consumption',
    labelNames: ['model', 'type'],
    registers: [registry],
  }),

  costTotal: new Counter({
    name: 'ai_agent_cost_total',
    help: 'Total cost by parent account',
    labelNames: ['parentId'],
    registers: [registry],
  }),

  errorTotal: new Counter({
    name: 'ai_agent_error_total',
    help: 'Total errors by code',
    labelNames: ['errorCode'],
    registers: [registry],
  }),

  fallbackTotal: new Counter({
    name: 'ai_agent_fallback_total',
    help: 'Total fallback triggers',
    labelNames: ['track'],
    registers: [registry],
  }),

  safetyBlockTotal: new Counter({
    name: 'ai_agent_safety_block_total',
    help: 'Total safety blocks',
    labelNames: ['classification'],
    registers: [registry],
  }),

  circuitBreakerState: new Gauge({
    name: 'ai_agent_circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
    labelNames: ['model'],
    registers: [registry],
  }),
};

export async function getMetrics(): Promise<string> {
  return registry.metrics();
}
