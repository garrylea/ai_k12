import { describe, it, expect } from 'vitest';
import { AIController } from './ai.controller.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';
import 'reflect-metadata';

describe('AIController — 手写转写端点守卫', () => {
  it('继承类级 @Roles(student)；路由为 POST api/ai/handwriting/transcribe', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AIController);
    expect(roles).toEqual(['student']);
    const path = Reflect.getMetadata('path', AIController.prototype.transcribeHandwriting);
    expect(path).toBe('handwriting/transcribe');
  });
});
