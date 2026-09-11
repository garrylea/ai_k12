import { describe, it, expect } from 'vitest';
import { ModelRouter } from './model-router.js';
import { ModelConfigRegistry } from './model-config-registry.js';

describe('ModelRouter + registry', () => {
  it('无参构造走 YAML（既有行为不变）', () => {
    const r = new ModelRouter().route({ scene: 'tutoring', subject: 'math', difficulty: 1 });
    expect(r.primary.modelId).toBe('qwen3.8-max');
  });

  it('传 registry 走快照且返回带 apiKey', () => {
    const reg = new ModelConfigRegistry(); // 无 deps -> YAML 快照
    const r = new ModelRouter(reg).route({ scene: 'tutoring', subject: 'math', difficulty: 1 });
    expect(r.primary.apiKey).toBeDefined();
    expect(r.primary.modelId).toBe('qwen3.8-max');
  });

  it('快照无匹配场景时走 default', () => {
    const reg = new ModelConfigRegistry();
    const r = new ModelRouter(reg).route({ scene: 'nonexistent' as any, subject: 'math' as any });
    expect(r.primary).toBeDefined();
  });
});
