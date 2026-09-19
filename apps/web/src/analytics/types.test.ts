import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneInfo } from './types';
import { newSessionUid } from './types';
import { sceneKey } from './sceneMap';

/**
 * 后端 `apps/server/src/modules/analytics/study-sessions.service.ts` 的 `UUID_RE` 的**本地副本**。
 *
 * 故意复制而不是 import：前端不依赖服务端代码。两处一旦漂移，后果是**会话静默全丢**——
 * `POST /api/study-sessions` 直接 1001，前端没有任何提示，家长端时长永远是空。
 */
const BACKEND_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('newSessionUid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('产出合法 UUID 形状（后端只认 8-4-4-4-12 十六进制）', () => {
    expect(newSessionUid()).toMatch(BACKEND_UUID_RE);
  });

  it('没有 crypto.randomUUID 时（非安全上下文）回退分支同样是合法 UUID', () => {
    // 复现 iPad 横屏经局域网地址打开的场景：crypto 在、randomUUID 不在。
    // 旧的「时间戳-随机数」回退在这里会返回 17f3ab12cd34-a1b2c3d4 → 1001 → 会话静默全丢。
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
        return bytes;
      },
    });
    expect(newSessionUid()).toMatch(BACKEND_UUID_RE);
  });

  it('连 crypto.getRandomValues 都没有时，Math.random 兜底也得是合法 UUID', () => {
    vi.stubGlobal('crypto', undefined);
    expect(newSessionUid()).toMatch(BACKEND_UUID_RE);
  });

  it('多次调用的值互不相同（不是常量）', () => {
    const uids = new Set(Array.from({ length: 50 }, () => newSessionUid()));
    expect(uids.size).toBe(50);
  });
});

describe('sceneKey', () => {
  it('非学习场景（家长端/管理端）返回 null —— 这正是「不许拿它开会话」的闸门', () => {
    const info: SceneInfo = { module: 'parent', scene: 'parent_dashboard', isStudyScene: false };
    expect(sceneKey(info)).toBeNull();
  });

  it('学习场景返回 module/scene 去重键', () => {
    const info: SceneInfo = { module: 'mainline', scene: 'course_detail', isStudyScene: true };
    expect(sceneKey(info)).toBe('mainline/course_detail');
  });
});
