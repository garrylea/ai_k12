import { describe, it, expect } from 'vitest';
import { metrics, getMetrics } from './metrics.js';

describe('Metrics', () => {
  it('exposes all 8 metrics', () => {
    expect(metrics.requestTotal).toBeDefined();
    expect(metrics.requestDurationMs).toBeDefined();
    expect(metrics.tokenConsumption).toBeDefined();
    expect(metrics.costTotal).toBeDefined();
    expect(metrics.errorTotal).toBeDefined();
    expect(metrics.fallbackTotal).toBeDefined();
    expect(metrics.safetyBlockTotal).toBeDefined();
    expect(metrics.circuitBreakerState).toBeDefined();
  });

  it('getMetrics returns Prometheus text format with all registered metric names', async () => {
    metrics.requestTotal.inc({ scene: 'tutoring', model: 'qwen3.7-max', subject: 'math' });
    const text = await getMetrics();

    expect(text).toContain('ai_agent_request_total');
    expect(text).toContain('ai_agent_request_duration_ms');
    expect(text).toContain('ai_agent_token_consumption');
    expect(text).toContain('ai_agent_cost_total');
    expect(text).toContain('ai_agent_error_total');
    expect(text).toContain('ai_agent_fallback_total');
    expect(text).toContain('ai_agent_safety_block_total');
    expect(text).toContain('ai_agent_circuit_breaker_state');
  });

  it('records labeled increments in the metrics output', async () => {
    metrics.errorTotal.inc({ errorCode: 'RATE_LIMITED' });
    const text = await getMetrics();

    expect(text).toContain('errorCode="RATE_LIMITED"');
  });

  it('supports gauge set for circuit breaker state', async () => {
    metrics.circuitBreakerState.set({ model: 'kimi-latest' }, 2);
    const text = await getMetrics();

    expect(text).toContain('ai_agent_circuit_breaker_state');
    expect(text).toContain('model="kimi-latest"');
  });
});
