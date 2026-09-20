import { describe, it, expect, vi } from 'vitest';
import { SafetyAlertsService } from './safety-alerts.service.js';
import type { RecordSafetyAlertInput, SafetyAlertType } from './safety-alerts.service.js';

const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

const mkAlerts = (overrides: Partial<Record<string, any>> = {}) => ({
  existsRecent: vi.fn().mockResolvedValue(false),
  create: vi.fn().mockResolvedValue(1),
  ...overrides,
});

const mkStudents = (student: unknown = { id: 9, parentId: 5, name: '小明' }) => ({
  findById: vi.fn().mockResolvedValue(student),
});

/** 参数顺序与 SafetyAlertsService 构造函数一致（漏传会静默变 undefined，务必对齐）。 */
const mkSvc = (alerts = mkAlerts(), students = mkStudents()) =>
  new SafetyAlertsService(alerts as any, students as any);

/** `record` 是同步 fire-and-forget：把内部 async 链路跑完再断言。 */
const flush = () => new Promise((r) => setImmediate(r));

const input = (overrides: Partial<RecordSafetyAlertInput> = {}): RecordSafetyAlertInput => ({
  studentId: 9,
  dialogueId: 77,
  type: 'off_topic',
  level: 'warning',
  message: '检测到孩子在学习中发起了与学习无关的闲聊',
  context: '孩子消息片段',
  ...overrides,
});

describe('SafetyAlertsService.record —— 同步 fire-and-forget', () => {
  it('同步返回 void（调用方不需要 await，也不能等它）', () => {
    const svc = mkSvc();
    expect(svc.record(input())).toBeUndefined();
  });

  it('去重命中（窗口内已有同 student+type）→ 不写第二条，且不去解析 parentId', async () => {
    const alerts = mkAlerts({ existsRecent: vi.fn().mockResolvedValue(true) });
    const students = mkStudents();
    const svc = mkSvc(alerts, students);

    svc.record(input());
    await flush();

    expect(alerts.existsRecent).toHaveBeenCalledTimes(1);
    expect(alerts.create).not.toHaveBeenCalled();
    expect(students.findById).not.toHaveBeenCalled();
  });

  it('学生不存在 → 跳过并 warn，不写、不抛', async () => {
    const alerts = mkAlerts();
    const svc = mkSvc(alerts, mkStudents(null));

    expect(() => svc.record(input())).not.toThrow();
    await flush();

    expect(alerts.create).not.toHaveBeenCalled();
  });

  it('正常路径：parent_id 由 findById 解析、message_id 恒为 null、context 截断到 200 字', async () => {
    const alerts = mkAlerts();
    const students = mkStudents({ id: 9, parentId: 5, name: '小明' });
    const svc = mkSvc(alerts, students);

    const longContext = 'x'.repeat(500);
    svc.record(input({ context: longContext }));
    await flush();

    expect(students.findById).toHaveBeenCalledWith(9);
    expect(alerts.create).toHaveBeenCalledTimes(1);
    const row = alerts.create.mock.calls[0][0];
    // parent_id 是**服务层**解析出来的（调用方只知道 studentId）
    expect(row.parent_id).toBe(5);
    expect(row.student_id).toBe(9);
    expect(row.dialogue_id).toBe(77);
    expect(row.message_id).toBeNull();
    expect(row.type).toBe('off_topic');
    expect(row.level).toBe('warning');
    expect(row.context).toBe(longContext.slice(0, 200));
    expect(row.context).toHaveLength(200);
  });

  it('context 为 null / 空串 → 落库 null（不写空字符串）', async () => {
    const alerts = mkAlerts();
    const svc = mkSvc(alerts);

    svc.record(input({ context: null }));
    await flush();
    svc.record(input({ context: '' }));
    await flush();

    expect(alerts.create.mock.calls[0][0].context).toBeNull();
    expect(alerts.create.mock.calls[1][0].context).toBeNull();
  });

  it('create reject → 同步调用方不炸，异常被吞掉', async () => {
    const alerts = mkAlerts({ create: vi.fn().mockRejectedValue(new Error('db down')) });
    const svc = mkSvc(alerts);

    expect(() => svc.record(input())).not.toThrow();
    // 若 rejection 没被 catch，这里会以未捕获 rejection 的形式冒出来
    await flush();

    expect(alerts.create).toHaveBeenCalledTimes(1);
  });

  it('去重查询本身 reject（DB 不可用）也不炸调用方', async () => {
    const alerts = mkAlerts({ existsRecent: vi.fn().mockRejectedValue(new Error('db down')) });
    const svc = mkSvc(alerts);

    expect(() => svc.record(input())).not.toThrow();
    await flush();

    expect(alerts.create).not.toHaveBeenCalled();
  });

  it('findById reject 也不炸调用方', async () => {
    const students = { findById: vi.fn().mockRejectedValue(new Error('db down')) };
    const alerts = mkAlerts();
    const svc = mkSvc(alerts, students);

    expect(() => svc.record(input())).not.toThrow();
    await flush();

    expect(alerts.create).not.toHaveBeenCalled();
  });
});

describe('SafetyAlertsService.record —— 去重窗口', () => {
  it('since 由应用层算（30 分钟前），不是仓储里的 NOW()', async () => {
    const alerts = mkAlerts();
    const svc = mkSvc(alerts);

    const before = Date.now();
    svc.record(input({ studentId: 9, type: 'away' }));
    await flush();
    const after = Date.now();

    const [studentId, type, since] = alerts.existsRecent.mock.calls[0];
    expect(studentId).toBe(9);
    expect(type).toBe('away');
    expect(since).toBeInstanceOf(Date);
    expect(since.getTime()).toBeGreaterThanOrEqual(before - DEDUPE_WINDOW_MS);
    expect(since.getTime()).toBeLessThanOrEqual(after - DEDUPE_WINDOW_MS);
  });
});

describe('SafetyAlertsService.messageFor —— 面向家长文案的唯一真源（spec §3.4）', () => {
  it('闲聊 / 情绪 / 敏感 三条文案逐字一致', () => {
    const svc = mkSvc();
    expect(svc.messageFor('off_topic')).toBe('检测到孩子在学习中发起了与学习无关的闲聊');
    expect(svc.messageFor('emotional')).toBe('检测到孩子出现情绪发泄类输入');
    expect(svc.messageFor('sensitive')).toBe('检测到敏感内容输入，建议尽快关注');
  });

  it('away / idle 带分钟数插值', () => {
    const svc = mkSvc();
    expect(svc.messageFor('away', 5)).toBe('孩子离开了学习页面 5 分钟');
    expect(svc.messageFor('idle', 15)).toBe('孩子在学习页面 15 分钟无操作');
  });

  it('不传 minutes → 按 0 兜底，不出现 undefined', () => {
    const svc = mkSvc();
    expect(svc.messageFor('away')).toBe('孩子离开了学习页面 0 分钟');
    expect(svc.messageFor('idle')).toBe('孩子在学习页面 0 分钟无操作');
  });

  it('abusive（第 6 个类型）复用敏感文案，不是 undefined', () => {
    const svc = mkSvc();
    expect(svc.messageFor('abusive')).toBe('检测到敏感内容输入，建议尽快关注');
  });

  it('全部六个类型都返回非空 string（钉住不会有任何一个落到 undefined）', () => {
    const svc = mkSvc();
    const all: SafetyAlertType[] = ['off_topic', 'emotional', 'sensitive', 'abusive', 'away', 'idle'];
    for (const type of all) {
      const msg = svc.messageFor(type);
      expect(typeof msg, `${type} 应为 string`).toBe('string');
      expect(msg.length, `${type} 文案不应为空`).toBeGreaterThan(0);
    }
  });
});

describe('SafetyAlertsService.awayContext', () => {
  it('走神 context 与 message 同源', () => {
    const svc = mkSvc();
    expect(svc.awayContext('away', 5)).toBe('切走 5 分钟');
    expect(svc.awayContext('idle', 15)).toBe('无操作 15 分钟');
  });
});
